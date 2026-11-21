// dsh-novel-conductor — 舞台监督（v0.1.0）
//
// 只读兄弟插件的服务，不写任何兄弟账本；自己的状态只写
// <workspace>/.dsh-novel-conductor/runs/<runId>/。
// 每一步的“完成”必须由宿主 tools/result 收据 + 服务回查证明。

import { toolDefinitions } from './lib/tools.js'
import { findActiveRun, normalizeCwd } from './lib/run-store.js'
import { flushPending, getRunStatus, statusView } from './lib/run-machine.js'
import { activeRunOf, clearRun } from './lib/session.js'
import { enqueueRaw } from './lib/receipt-bus.js'
import { readFileSync } from 'node:fs'

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

const TOOL_PREFIXES = ['beat_', 'memo_', 'voice_', 'fic_']

/** 会话键：DSH 里 agent.id 就是 session id，但两种形态都接受。 */
const sessionKeyOf = (agent) => {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id ? id : null
}

export const inject = ['tools', 'commands', 'workingDirectory', 'agents']

const SKILL = {
  name: 'novel-conductor',
  description: '舞台监督：一章先做什么、后做什么。它排 runbook、校验每一步的真实收据、在需要作者拍板时停下；不写正文、不改 beat/fade/voice 的账本。当作者要“按流程写一章”“把这一章走完”“看看现在卡在哪一步”时使用。',
  whenToUse: '要开始/继续/收尾一章、上一章写完要沉淀、作者拍板后要继续、或者要判断当前 run 卡在哪一步时。',
  source: 'runtime',
  content: [
    '# 舞台监督（dsh-novel-conductor）',
    '',
    '## 一句话',
    '',
    '谁上场、什么时候上，它排；戏怎么走，你定。它只排步骤、校验收据、在作者拍板时停下。',
    '',
    '## 一章的 runbook（不能跳步）',
    '',
    '- **前置**：作者先 `/cue on`（或点会话头「舞台监督」开关）。关着时 `cue_*` 不可见，也不调度任何兄弟插件；',
    '  开着时即使 beat / fade / voice / fanfic 自己的开关是关的，本会话也能调用它们的工具（不改它们的持久偏好）。',
    '',
    '1. `cue_run({action:"start", book, chapter, required_capabilities})`：装配上下文与能力矩阵。',
    '   - `required_capabilities` 只写这次任务**真的要用**的能力：原创长篇一般不写 `fanfic`——不写就完全不会去读同人项目。',
    '   - 写同人/改编时才写 `"fanfic"`；工作区里有两个以上同人项目时还要给 `fanfic_project`（目录名，如 `douluo`），否则会明确报歧义而不是猜一本。',
    '   - 如果返回 `state:"awaiting_author"`，说明 beat 还有待拍板决策。先请作者在 beat 里拍板，再 `cue_run({action:"resume"})`，不要直接写正文。',
    '2. `cue_step({stepId:"write", artifact:{path,chars,sha1}})`：正文先保存成文件，再提交。conductor 只认文件存在、字数、sha1。',
    '3. 调 `beat_segment`，再 `cue_step({stepId:"segment", artifact:{artifactId}})`。conductor 会从宿主收据里找 `beat_segment`，并用 `novelBeat.getArtifact` 回查；没有收据会记 `claimed`。',
    '4. 调 `beat_verify`（以及需要的 `voice_check`），再 `cue_step({stepId:"verify"})`。`beat_verify` 必须 `verified:true`；`ok:true` 不等于通过。',
    '   - 如果本 run 的 `required_capabilities` 里有 `fanfic`：必须再调一次 `fic_check({chapter, text, source:"canon"})`。conductor 只认 `pass:true`；`source` 不是 `canon` 或没有整数 `revision` 的收据会被判为不可信（夹具数据不算真书验收）。',
    '   - `fic_check` 的 `status:"completed"` 只表示执行成功，`pass` 才是内容结论；作者已忽略（waiver）的条目在服务端已应用，不要自己再过滤。',
    '5. 调 `memo_digest`，再 `cue_step({stepId:"digest"})`。conductor 会回读 fade 的 revision。',
    '6. `cue_step({stepId:"close"})`：所有必需步骤 done 且 verified 才能收尾。',
    '',
    '## 硬规矩',
    '',
    '- 每一步的完成必须有工具收据或文件证据；模型自述“我写完了”不算。',
    '- fanfic 只在同人/改编任务里出现：`required_capabilities` 不带它时，conductor 连同人项目都不读（矩阵里是 `reason:"not-required"`）。',
    '- `claimed` 不是 verified：close 会拒绝。不要把 claimed 说成完成。',
    '- `segment` 的收据必须和 `getArtifact` 回查一致；旧收据的 revision 可以小于当前账本 revision，不要求相等。',
    '- `beat_verify` 失败仍可能 `ok:true`，只看 `verified === true`（或结构化 `pass`）。',
    '- `fic_check` 只认 `pass === true` 且 `source === "canon"`；夹具（`source:"fixture"`）的通过不算数。',
    '- 一个会话同一时间只允许一个活动 run；不要绕开 `cue_run start` 直接写兄弟账本。',
    '- conductor 不写 beat/fade/voice 的任何账本，也不把它们的正文/简报抄进 run.json。',
    '',
    '## 查看与中止',
    '',
    '- `cue_status({view:"sheet"})` 看当前步骤/等待/预算/能力矩阵；`view:"steps"` 看完整步骤。',
    '- `/cue status`、`/cue abort [runId]` 是宿主命令，给作者用。',
  ].join('\n'),
}

export async function apply(ctx) {
  const workingDirectory = ctx.get('workingDirectory')
  const commands = ctx.get('commands')
  const skills = ctx.get('skills')
  const agentDirs = new Map()

  // ── 接管开关（v0.1.3）：开 = 本会话由舞台监督调度本系列四个插件 ──────────────
  // 语义：关着时 cue_* 不可见、不调度任何兄弟；开着时即使兄弟自己的开关关着，
  // 它们的工具也会对本会话可见（beat 的 L1 技能同样补上），但**不改兄弟的持久偏好**。
  const driving = new Set()
  const driveListeners = new Set()
  const isDriving = (sessionId) => typeof sessionId === 'string' && driving.has(sessionId)
  const emitDrive = (event) => {
    for (const listener of [...driveListeners]) {
      try {
        listener(event)
      } catch {
        // 订阅者自己的异常不能影响开关本身。
      }
    }
    // 跨插件广播：兄弟插件可能比 conductor 先加载，所以不走服务引用。
    try {
      ctx.emit?.('novel-conductor/drive', event)
    } catch {
      // 没有事件总线就只靠服务门（isDriving）。
    }
  }
  const setDriving = (agent, on) => {
    const sessionId = sessionKeyOf(agent)
    if (!sessionId) return null
    const was = driving.has(sessionId)
    if (on) driving.add(sessionId)
    else driving.delete(sessionId)
    if (was !== on) emitDrive({ sessionId, driving: on, agent: agent ?? null })
    return { sessionId, changed: was !== on, driving: on }
  }
  const onDriveChange = (listener) => {
    if (typeof listener !== 'function') return () => {}
    driveListeners.add(listener)
    return () => driveListeners.delete(listener)
  }

  for (const definition of toolDefinitions({ ctx })) {
    // 注：when 每个模型步骤只求值一次，所以步骤中途关掉开关不会立刻收回已获得的调用资格。
    // 已经在跑的步骤按 run-machine 的收尾规则处理；不额外加执行前闸门（会绕开单测的工具直调路径）。
    ctx.effect(() => ctx.tools.register(definition, {
      when: (context) => isDriving(sessionKeyOf(context?.agent)),
    }))
  }

  // 只读服务：给兄弟插件问「这个会话是不是被舞台监督接管了」。
  if (typeof ctx.provide === 'function') {
    ctx.effect(() => ctx.provide('novelConductor', {
      service_version: 1,
      readOnly: true,
      version: VERSION,
      identity() {
        return {
          plugin: 'dsh-novel-conductor',
          version: VERSION,
          service_version: 1,
          readOnly: true,
          capabilities: ['conductor.drive'],
        }
      },
      /** 这个会话是否由舞台监督调度（兄弟插件在工具门里 OR 它）。 */
      isDriving,
      /** 订阅接管状态：({ sessionId, driving, agent }) => void，返回取消订阅。 */
      onDriveChange,
    }))
  }

  if (skills?.register) {
    ctx.effect(() => skills.register(SKILL))
  }

  async function dirFor(agent) {
    if (!agent?.id) return null
    if (agentDirs.has(agent.id)) return agentDirs.get(agent.id)
    if (!workingDirectory?.ensure) return null
    try {
      const dir = await workingDirectory.ensure(agent)
      const cwd = normalizeCwd(dir)
      agentDirs.set(agent.id, cwd)
      return cwd
    } catch {
      return null
    }
  }

  const receiptQueues = new Map()

  function enqueue(key, fn) {
    const previous = receiptQueues.get(key) ?? Promise.resolve()
    const next = previous.then(fn, fn).catch(() => {})
    receiptQueues.set(key, next)
    next.finally(() => {
      if (receiptQueues.get(key) === next) receiptQueues.delete(key)
    })
    return next
  }

  async function onToolResult(exec, result) {
    const name = exec?.name
    if (typeof name !== 'string' || !TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    const agent = exec?.agent
    if (!agent?.id) return
    // 注：接管关着时兄弟插件的工具本来就不可见（装了 conductor 就是总开关），
    // 所以这里不再按开关过滤收据；收据只挂到「该会话有活动 run」上，见下面的 findActiveRun。

    // Capture synchronously; persistence is drained by cue_step as well, so an
    // async listener finishing late cannot turn a committed step into claimed.
    enqueueRaw(exec, result)

    const known = activeRunOf(agent.id)
    const cwd = known?.cwd ?? await dirFor(agent)
    if (!cwd) return
    let run
    try {
      run = await findActiveRun(cwd, agent.id)
    } catch {
      return
    }
    if (!run) return
    await enqueue(`${cwd}:${run.runId}`, () => flushPending(ctx, cwd, run.runId, agent.id))
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('tools/result', (exec, result) => onToolResult(exec, result)))
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = sessionKeyOf(agent)
      if (sessionId && driving.delete(sessionId)) emitDrive({ sessionId, driving: false, agent: null })
      agentDirs.delete(agent?.id)
      clearRun(agent?.id)
    }))
  }

  if (commands?.register) {
    ctx.effect(() => commands.register({
      name: 'cue',
      description: '舞台监督：/cue on、/cue off、/cue status、/cue abort [runId]',
      input: { hint: 'on | off | status | abort [runId]' },
      handler: async (invocation) => {
        const agent = invocation?.agent
        const raw = String(invocation?.rawInput ?? '').trim().replace(/^\/?cue\b/i, '').trim()
        const [action, runId] = raw.split(/\s+/).filter(Boolean)
        const verb = action ?? 'status'

        // 开关不需要工作区：先处理，免得没有 run 的会话切不了。
        if (verb === 'on' || verb === 'off') {
          const result = setDriving(agent, verb === 'on')
          if (!result) return { kind: 'error', text: '拿不到当前会话，无法切换舞台监督。' }
          if (verb === 'on') {
            return {
              kind: 'success',
              text: '舞台监督已开启：本会话可以调度 beat / fade / voice / fanfic。'
                + '它们自己的开关保持原样（不改持久偏好），但本会话里它们的工具与规则会补齐；'
                + '关闭舞台监督后立即收回。',
            }
          }
          return {
            kind: 'success',
            text: '舞台监督已关闭：不再调度任何本系列插件，cue_* 从本会话移除；'
              + '各插件自己的开关、账本和持久偏好都没有动。',
          }
        }

        const cwd = activeRunOf(agent?.id)?.cwd ?? await dirFor(agent)
        try {
          if (verb === 'status') {
            const driveLine = `舞台监督：${isDriving(sessionKeyOf(agent)) ? '开（本会话已接管）' : '关（/cue on 开启）'}`;
            if (!cwd) return { kind: 'success', text: `${driveLine}\n当前没有工作区，也没有活动 run。` };
            let run;
            try {
              run = await getRunStatus(cwd, { runId, agentId: agent.id });
            } catch {
              return { kind: 'success', text: `${driveLine}\n当前没有活动 run；/cue on 之后用 cue_run 开始一章。` };
            }
            const sheet = statusView(run, 'sheet');
            return {
              kind: 'success',
              text: [
                driveLine,
                `run ${sheet.runId} · ${sheet.state} · 当前 ${sheet.currentStep}`,
                sheet.pendingAuthor ? `等待作者：${sheet.pendingAuthor.reason}` : null,
                `步骤：${sheet.steps.map((step) => `${step.id}=${step.state}`).join(' / ')}`,
              ].filter(Boolean).join('\n'),
            }
          }
          if (!cwd) return { kind: 'error', text: '拿不到当前工作区，无法查看舞台监督。' }
          if (verb === 'abort') {
            const run = await getRunStatus(cwd, { runId, agentId: agent.id })
            const { abortRun } = await import('./lib/run-machine.js')
            await abortRun(cwd, { runId: run.runId, agentId: agent.id, reason: 'author abort' })
            return { kind: 'success', text: `已中止 run ${run.runId}。` }
          }
          return { kind: 'error', text: '用法：/cue on | /cue off | /cue status | /cue abort [runId]' }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    }))
  }

  if (ctx.get('agents')?.list) {
    for (const agent of ctx.get('agents').list()) {
      await dirFor(agent)
    }
  }
}
