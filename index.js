// dsh-novel-conductor — 故事总控（v0.2.1）
//
// 只读兄弟插件的服务，不写任何兄弟账本；自己的状态只写
// <workspace>/.dsh-novel-conductor/runs/<runId>/。
// 每一步的“完成”必须由宿主 tools/result 收据 + 服务回查证明。

import { toolDefinitions } from './lib/tools.js'
import { findActiveRun, normalizeCwd } from './lib/run-store.js'
import { flushPending, getRunStatus, statusView } from './lib/run-machine.js'
import { activeRunOf, clearRun } from './lib/session.js'
import { enqueueRaw } from './lib/receipt-bus.js'
import { createScopeManager } from './lib/scope-manager.js'
import { acquireLock, LockError, lockStatus } from './lib/locks.js'
import { assertPathInside, checkBookArgs } from './lib/scope.js'
import { isManagedTool, isWriteTool } from './lib/effects.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
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
  description: '故事总控：一章先做什么、后做什么。它排 runbook、校验每一步的真实收据、在需要作者拍板时停下；同时负责书身份隔离、每书写锁和第三方工具/插件网关。它不写正文、不改 beat/fade/voice 的账本。当作者要“按流程写一章”“把这一章走完”“看看现在卡在哪一步”“调用外部写作插件”时使用。',
  whenToUse: '要开始/继续/收尾一章、上一章写完要沉淀、作者拍板后要继续、或者要判断当前 run 卡在哪一步时。',
  source: 'runtime',
  content: [
    '# 故事总控（dsh-novel-conductor）',
    '',
    '## 一句话',
    '',
    '谁上场、什么时候上，它排；戏怎么走，你定。它只排步骤、校验收据、在作者拍板时停下。',
    '',
    '## 隔离与绑定（先看）',
    '',
    '- 一个工作区通常一本书：首次 `/cue scope init <书名>` 或 `cue_scope({action:"init", book})`。',
    '- 多书工作区：`/cue scope bind <书名>`（或 `cue_scope bind`）后，本会话才绑定到其中一本；未绑定时不要写正文。',
    '- 当前会话只看得见、写得进绑定的书；传另一本的 `book`/`dir` 会被拒绝。',
    '- 写工具会取每书锁；锁被占用时不要绕开，先 `cue_locks({action:"status"})` 查看。',
    '',
    '## 一章的 runbook（不能跳步）',
    '',
    '- **前置**：作者先 `/cue on`（或点会话头「故事总控」开关）。关着时 `cue_*` 不可见，也不调度任何兄弟插件；',
    '  开着时即使 beat / fade / voice / fanfic 自己的开关是关的，本会话也能调用它们的工具（不改它们的持久偏好）。',
    '',
    '1. `cue_run({action:"start", book, chapter, required_capabilities})`：装配上下文与能力矩阵。',
    '   - `required_capabilities` 只写这次任务**真的要用**的能力：原创长篇一般不写 `fanfic`——不写就完全不会去读同人项目。',
    '   - 写同人/改编时才写 `"fanfic"`；工作区里有两个以上同人项目时还要给 `fanfic_project`（目录名，如 `douluo`），否则会明确报歧义而不是猜一本。',
    '   - 如果返回 `state:"awaiting_author"`，说明 beat 还有待拍板决策。先请作者在 beat 里拍板，再 `cue_run({action:"resume"})`，不要直接写正文。',
    '   - 看当前可用插件/工具：`cue_tools({query})`；调未适配工具：`cue_call({tool,args})`。网关会注入 `book`/`bookId`/`dir` 并落收据；未声明状态的第三方工具默认拒绝。',
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
    '- `cue_status({view:"sheet"})` 看当前步骤/等待/预算/能力矩阵；`view:"steps"` 看完整步骤；`view:"runbook"` 看阶段与技能计划。',
    '- `cue_locks({action:"status"})` 看写锁；`/cue status`、`/cue abort [runId]` 是宿主命令，给作者用。',
  ].join('\n'),
}

export async function apply(ctx) {
  const workingDirectory = ctx.get('workingDirectory')
  const commands = ctx.get('commands')
  const skills = ctx.get('skills')
  const agents = ctx.get('agents')
  const scope = createScopeManager(ctx)
  const agentDirs = new Map()
  const skillDisposers = new Map()
  const gatedAgents = new Set()
  const restrictedAgents = new Set()
  const MULTI_BOOK_DENY = ['session_search', 'session_trace', 'session_event_search', 'session_event_read', 'session_event_trace', 'list_agents']

  const registerSkillFor = (agent) => {
    const scoped = agent?.ctx
    // 不要读 scoped.skills：真实 Cordis 会抛 “cannot get property 'skills'
    // without inject”。只能用 get() 取服务。
    const target = scoped?.get?.('skills') ?? null
    if (target?.register) {
      const dispose = target.register(SKILL)
      return typeof dispose === 'function' ? dispose : () => {}
    }
    if (!scoped && skills?.register) return skills.register(SKILL)
    return () => {}
  }

  const lockFailure = (message) => ({
    isError: true,
    error: { name: 'ConductorLockError', code: 'lock-denied', message },
    content: [{ type: 'text', text: message }],
  })

  async function restrictMultiBook(agent) {
    if (!agent?.id || restrictedAgents.has(agent.id)) return
    const cwd = await scope.cwdFor(agent)
    if (!cwd) return
    const identity = await scope.identityFor(cwd)
    if (identity.kind !== 'multi') return
    const tools = agent.ctx?.get?.('tools') ?? null
    if (typeof tools?.restrict !== 'function') return
    tools.restrict({ deny: MULTI_BOOK_DENY })
    restrictedAgents.add(agent.id)
  }

  function installAgentGates(agent) {
    if (!agent?.ctx || gatedAgents.has(agent.id)) return
    const tools = agent.ctx.get?.('tools') ?? null
    try {
      if (typeof tools?.guard === 'function') {
        tools.guard((exec) => {
          const binding = scope.get(agent)
          if (!binding) {
            return isManagedTool(exec.name)
              ? { reason: '当前会话还没有绑定书；先 /cue scope bind <book>', info: { name: 'ConductorScopeError', code: 'unbound-book' } }
              : undefined
          }
          if (!isManagedTool(exec.name)) return undefined
          const bad = checkBookArgs(exec.arguments, binding)
          if (bad) return { reason: bad.message, info: { name: 'ConductorScopeError', code: bad.code } }
          const project = exec.arguments?.project
          if (exec.name.startsWith('fic_') && (project == null || project === '')) {
            return { reason: '同人工具直调必须显式传 project；或改用 cue_call 由网关注入', info: { name: 'ConductorScopeError', code: 'unbound-project' } }
          }
          if (typeof project === 'string' && project) {
            const run = activeRunOf(agent.id)
            const known = run?.fanficProject ?? run?.capabilityMatrix?.fanfic?.project ?? null
            // run 尚未声明 fanfic 项目时，允许作者/模型显式指定一次；只有与已声明项目
            // 不一致才拒绝。否则 cue_run schema 缺 fanfic_project 的旧 run 会永久死锁。
            if (known && project !== known) {
              return { reason: `project 与当前 run 的同人项目不一致：${project}`, info: { name: 'ConductorScopeError', code: 'cross-project' } }
            }
          }
          return undefined
        })
      }
      if (typeof agent.ctx.on !== 'function') return
      agent.ctx.on('tools/pre-execute', async (exec, next) => {
        if (!isDriving(agent.id)) return next()
        try {
          const binding = scope.get(agent)
          if (!binding) {
            if (['write', 'edit'].includes(exec.name)) {
              const cwd = await scope.cwdFor(agent)
              const identity = cwd ? await scope.identityFor(cwd) : { kind: 'none' }
              if (identity.kind === 'multi') {
                return { kind: 'deny', reason: '多书工作区尚未绑定书；先 /cue scope bind <book>', info: { name: 'ConductorScopeError', code: 'unbound-book' } }
              }
            }
            return next()
          }
          if (['write', 'edit'].includes(exec.name)) {
            const currentCwd = await scope.cwdFor(agent)
            const identity = currentCwd ? await scope.identityFor(currentCwd) : { kind: 'none' }
            if (identity.kind === 'multi') {
              return { kind: 'deny', reason: '同工作区多书写正文尚未开放；请一书一工作区', info: { name: 'ConductorScopeError', code: 'multi-book-write' } }
            }
            const target = exec.arguments?.file_path ?? exec.arguments?.path
            if (typeof target === 'string' && target) {
              const abs = isAbsolute(target) ? target : join(binding.workspace, target)
              await assertPathInside(binding.workspace, abs)
            }
          }
        } catch (error) {
          return {
            kind: 'deny',
            reason: error?.code === 'path-outside-book' ? error.message : `路径校验失败：${String(error?.message ?? error)}`,
            info: { name: 'ConductorScopeError', code: error?.code === 'path-outside-book' ? 'path-outside-book' : 'path-check-failed' },
          }
        }
        return next()
      })
      agent.ctx.on('tools/execute', async (exec, next) => {
        if (!isDriving(agent.id)) return next()
        const binding = scope.get(agent)
        if (!binding) return next()
        if (!isWriteTool(exec.name)) return next()
        const run = activeRunOf(agent.id)
        const flowId = run?.runId ?? `adhoc-${agent.id}`
        let lease
        try {
          lease = await acquireLock({
            cwd: binding.workspace,
            bookId: binding.bookId,
            flowId,
            ownerToken: randomUUID(),
            generation: Number(run?.generation ?? 1),
            resource: 'book-write',
          })
        } catch (error) {
          if (error instanceof LockError) return lockFailure(error.message)
          throw error
        }
        try {
          return await next()
        } finally {
          await lease.release().catch(() => {})
        }
      })
      gatedAgents.add(agent.id)
    } catch {
      // 安装失败不标记，下一次 /cue on 或 scope 绑定重试；工具门仍由 when 控制。
    }
  }

  // ── 接管开关（v0.1.3）：开 = 本会话由故事总控调度本系列四个插件 ──────────────
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
  const setDriving = async (agent, on) => {
    const sessionId = sessionKeyOf(agent)
    if (!sessionId) return null
    const was = driving.has(sessionId)
    if (on) {
      driving.add(sessionId)
      await scope.ensure(agent).catch(() => null)
      installAgentGates(agent)
      await restrictMultiBook(agent).catch(() => null)
      if (!skillDisposers.has(sessionId)) skillDisposers.set(sessionId, registerSkillFor(agent))
    } else {
      driving.delete(sessionId)
      const dispose = skillDisposers.get(sessionId)
      skillDisposers.delete(sessionId)
      try { dispose?.() } catch { /* 技能已随 agent 释放 */ }
    }
    if (was !== on) emitDrive({ sessionId, driving: on, agent: agent ?? null })
    return { sessionId, changed: was !== on, driving: on }
  }
  const onDriveChange = (listener) => {
    if (typeof listener !== 'function') return () => {}
    driveListeners.add(listener)
    return () => driveListeners.delete(listener)
  }

  // 插件被停用/卸载时把接管广播成「关」：兄弟插件按独立开关恢复工具、restrict、技能与 guard。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const sessionId of [...driving]) {
        driving.delete(sessionId)
        emitDrive({ sessionId, driving: false, agent: null })
      }
    })
  }

  const CONTROL_TOOLS = new Set(['cue_scope', 'cue_status', 'cue_locks'])
  for (const definition of toolDefinitions({ ctx, scope })) {
    // when 每个模型步骤只求值一次；真实调用一定带 toolCallId，用它把「步骤中途关掉开关后
    // 尚未开始执行」的调用拦下来（已经开始的按 run-machine 的收尾规则处理）。
    const guarded = {
      ...definition,
      async execute(args = {}, exec = {}) {
        const callId = exec?.toolCallId ?? exec?.callId
        if (callId && !CONTROL_TOOLS.has(definition.name) && !isDriving(sessionKeyOf(exec?.agent))) {
          return {
            ok: false,
            code: 'conductor-off',
            message: '故事总控没开（/cue on）；本会话不调度任何兄弟插件。',
          }
        }
        return definition.execute(args, exec)
      },
    }
    ctx.effect(() => ctx.tools.register(guarded, {
      when: (context) => isDriving(sessionKeyOf(context?.agent)),
    }))
  }

  // 只读服务：给兄弟插件问「这个会话是不是被故事总控接管了」。
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
      /** 这个会话是否由故事总控调度（兄弟插件在工具门里 OR 它）。 */
      isDriving,
      /** 订阅接管状态：({ sessionId, driving, agent }) => void，返回取消订阅。 */
      onDriveChange,
    }))
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/created', async ({ agent } = {}) => {
      try {
        await scope.ensure(agent)
        installAgentGates(agent)
        await restrictMultiBook(agent).catch(() => null)
      } catch {
        // 绑定失败不阻塞会话创建；工具门仍然按 scope.get 拒绝创作工具。
      }
    }))
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
    const binding = scope.get(agent)
    const cwd = known?.cwd ?? await scope.cwdFor(agent) ?? await dirFor(agent)
    if (!cwd) return
    let run
    try {
      run = await findActiveRun(cwd, agent.id, binding?.bookId ?? null)
    } catch {
      return
    }
    if (!run) return
    await enqueue(`${cwd}:${run.runId}`, () => flushPending(ctx, cwd, run.runId, agent.id, run.bookId ?? null))
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('tools/result', (exec, result) => onToolResult(exec, result)))
    ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = sessionKeyOf(agent)
      if (sessionId && driving.delete(sessionId)) emitDrive({ sessionId, driving: false, agent: null })
      scope.clear(agent)
      gatedAgents.delete(agent?.id)
      restrictedAgents.delete(agent?.id)
      agentDirs.delete(agent?.id)
      clearRun(agent?.id)
    }))
  }

  if (commands?.register) {
    ctx.effect(() => commands.register({
      name: 'cue',
      description: '故事总控：/cue on、/cue off、/cue scope [init|add|bind|status] [book]、/cue locks [status|break] [resource]、/cue status、/cue abort [runId]',
      input: { hint: 'on | off | scope [init|add|bind|status] [book] | locks [status|break] [resource] | status | abort [runId]' },
      handler: async (invocation) => {
        const agent = invocation?.agent
        const raw = String(invocation?.rawInput ?? '').trim().replace(/^\/?cue\b/i, '').trim()
        const [action, runId] = raw.split(/\s+/).filter(Boolean)
        const verb = action ?? 'status'

        if (verb === 'locks') {
          const rest = raw.split(/\s+/).filter(Boolean).slice(1)
          const sub = String(rest[0] ?? 'status').toLowerCase()
          const resource = rest[1] && !rest[1].startsWith('--') ? rest[1] : 'book-write'
          const binding = scope.get(agent)
          const cwd = activeRunOf(agent?.id)?.cwd ?? await scope.cwdFor(agent) ?? await dirFor(agent)
          if (!cwd) return { kind: 'error', text: '拿不到当前工作区，无法查看写锁。' }
          if (binding && normalizeCwd(cwd) !== normalizeCwd(binding.workspace)) {
            return { kind: 'error', text: `当前会话绑定的是 ${binding.workspace}，不能操作 ${cwd} 的锁。` }
          }
          try {
            if (sub === 'status') {
              const status = await lockStatus(cwd, resource)
              return { kind: 'success', text: `锁 ${status.resource}：${status.state}${status.owner ? ` · ${status.owner.flowId}` : ''}` }
            }
            if (sub === 'break') {
              const { breakLock } = await import('./lib/locks.js')
              const result = await breakLock(cwd, resource, { force: rest.includes('--force') })
              return { kind: 'success', text: result.broken ? `已清理锁 ${resource}（原状态 ${result.state}）。` : `锁 ${resource} 本来就不存在。` }
            }
            return { kind: 'error', text: '用法：/cue locks [status|break] [resource] [--force]' }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        }

        if (verb === 'scope') {
          const rest = raw.split(/\s+/).filter(Boolean).slice(1)
          const sub = String(rest[0] ?? 'status').toLowerCase()
          const book = rest[1]
          const cwd = await scope.cwdFor(agent) ?? await dirFor(agent)
          if (!cwd) return { kind: 'error', text: '拿不到当前工作区，无法处理书身份。' }
          try {
            if (sub === 'init') {
              const binding = await scope.init(agent, cwd, { book })
              installAgentGates(agent)
              return { kind: 'success', text: `已初始化《${binding.book}》（${binding.bookId}）。` }
            }
            if (sub === 'add') {
              const identity = await scope.add(agent, cwd, { book })
              return { kind: 'success', text: `已加入《${book}》；当前工作区共 ${identity.kind === 'multi' ? identity.books.length : 1} 本。` }
            }
            if (sub === 'bind') {
              const binding = await scope.select(agent, cwd, book)
              installAgentGates(agent)
              await restrictMultiBook(agent).catch(() => null)
              return { kind: 'success', text: `本会话已绑定《${binding.book}》（${binding.bookId}）。` }
            }
            if (sub === 'status') {
              const identity = await scope.identityFor(cwd)
              const binding = scope.get(agent)
              return {
                kind: 'success',
                text: [
                  `工作区：${cwd}`,
                  `身份：${identity.kind}${identity.kind === 'multi' ? `（${identity.books.map((item) => item.book).join(' / ')}）` : ''}`,
                  `本会话：${binding ? `《${binding.book}》 ${binding.bookId}` : '未绑定'}`,
                ].join('\n'),
              }
            }
            return { kind: 'error', text: '用法：/cue scope init|add|bind|status [book]' }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        }

        // 开关不需要工作区：先处理，免得没有 run 的会话切不了。
        if (verb === 'on' || verb === 'off') {
          const result = await setDriving(agent, verb === 'on')
          if (!result) return { kind: 'error', text: '拿不到当前会话，无法切换故事总控。' }
          const binding = scope.get(agent)
          if (verb === 'on') {
            return {
              kind: 'success',
              text: `故事总控已开启${binding ? `：本会话绑定《${binding.book}》` : '（当前工作区尚未绑定书，多书工作区请先 /cue scope bind <book>）'}。`
                + '本会话可以调度 beat / fade / voice / fanfic；它们自己的开关保持原样（不改持久偏好）。',
            }
          }
          return {
            kind: 'success',
            text: '故事总控已关闭：不再调度任何本系列插件，cue_* 从本会话移除；'
              + '各插件自己的开关、账本和持久偏好都没有动。',
          }
        }

        const binding = scope.get(agent)
        const cwd = activeRunOf(agent?.id)?.cwd ?? await scope.cwdFor(agent) ?? await dirFor(agent)
        try {
          if (verb === 'status') {
            const driveLine = `故事总控：${isDriving(sessionKeyOf(agent)) ? '开（本会话已接管）' : '关（/cue on 开启）'}${binding ? ` · 《${binding.book}》` : ''}`;
            if (!cwd) return { kind: 'success', text: `${driveLine}\n当前没有工作区，也没有活动 run。` };
            let run;
            try {
              run = await getRunStatus(cwd, { runId, bookId: binding?.bookId ?? null, agentId: agent.id });
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
          if (!cwd) return { kind: 'error', text: '拿不到当前工作区，无法查看故事总控。' }
          if (verb === 'abort') {
            const run = await getRunStatus(cwd, { runId, bookId: binding?.bookId ?? null, agentId: agent.id })
            const { abortRun } = await import('./lib/run-machine.js')
            await abortRun(cwd, { runId: run.runId, bookId: binding?.bookId ?? null, agentId: agent.id, reason: 'author abort' })
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
      await scope.ensure(agent).catch(() => null)
      installAgentGates(agent)
      await restrictMultiBook(agent).catch(() => null)
    }
  }
}
