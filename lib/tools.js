// lib/tools.js — conductor's model-facing surface. The old three tools remain;
// cue_scope / cue_locks are the isolation controls, cue_tools / cue_call the
// generic plugin gateway. Every tool resolves the session's bound book first.

import { fail, normalizeCwd } from './run-store.js'
import { readBookIdentity } from './scope.js'
import { lockStatus } from './locks.js'
import { callTool, listTools, readProviderPolicies } from './gateway.js'
import {
  abortRun,
  assertBookName,
  assertChapter,
  getRunStatus,
  resumeRun,
  startRun,
  statusView,
  stepRun,
} from './run-machine.js'

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

function asToolError(error) {
  if (error?.code) return { ok: false, code: error.code, message: error.message, ...(error.extra ?? {}) }
  return { ok: false, code: 'conductor-error', message: String(error?.message ?? error) }
}

async function resolveCwd(args, exec, workingDirectory) {
  if (typeof args?.cwd === 'string' && args.cwd.trim()) return normalizeCwd(args.cwd)
  if (workingDirectory?.ensure && exec?.agent) {
    const dir = await workingDirectory.ensure(exec.agent)
    if (dir) return normalizeCwd(dir)
  }
  fail('bad-cwd', '拿不到工作区根目录；请传 cwd（绝对路径）')
}

export function toolDefinitions({ ctx, scope } = {}) {
  const workingDirectory = ctx?.get?.('workingDirectory') ?? null

  function bindingFor(exec, cwd) {
    const binding = scope?.get?.(exec?.agent) ?? null
    if (binding && cwd && normalizeCwd(cwd) !== normalizeCwd(binding.workspace)) {
      fail('cross-workspace', `当前会话绑定的是 ${binding.workspace}，不能操作 ${cwd}`)
    }
    return binding
  }

  async function executeRun(args = {}, exec = {}) {
    try {
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const agentId = exec?.agent?.id
      if (!agentId) fail('no-agent', '拿不到当前会话，无法启动 run')
      const binding = bindingFor(exec, cwd)
      const action = String(args.action ?? '').toLowerCase()
      if (action === 'start') {
        const identity = await readBookIdentity(cwd)
        if (identity.kind === 'multi') {
          fail('multi-book-write', '同工作区多书写正文尚未开放（kit 正文路径 P0 未修）；请一书一工作区')
        }
        if (binding && args.book && assertBookName(args.book) !== binding.book) {
          fail('cross-book', `当前会话绑定的是《${binding.book}》，不能启动《${args.book}》`)
        }
        const book = args.book ?? binding?.book
        const result = await startRun(ctx, {
          cwd,
          agentId,
          bookId: binding?.bookId ?? null,
          book: assertBookName(book),
          chapter: assertChapter(args.chapter),
          taskType: args.task_type ?? 'chapter_write',
          requiredCapabilities: args.required_capabilities,
          fanficProject: args.fanfic_project,
          runId: args.runId,
        })
        return result
      }
      if (action === 'resume') {
        const run = await getRunStatus(cwd, { runId: args.runId, bookId: binding?.bookId ?? null, agentId })
        return { ok: true, ...(await resumeRun(ctx, { cwd, runId: run.runId, bookId: binding?.bookId ?? null, agentId })) }
      }
      if (action === 'abort') {
        const run = await getRunStatus(cwd, { runId: args.runId, bookId: binding?.bookId ?? null, agentId })
        return await abortRun(cwd, { runId: run.runId, bookId: binding?.bookId ?? null, agentId, reason: args.reason })
      }
      if (action === 'status') {
        const run = await getRunStatus(cwd, { runId: args.runId, bookId: binding?.bookId ?? null, agentId })
        return { ok: true, run: statusView(run, args.view === 'steps' ? 'steps' : 'sheet') }
      }
      fail('bad-action', 'action 必须是 start / resume / abort / status')
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeStep(args = {}, exec = {}) {
    try {
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const agentId = exec?.agent?.id
      if (!agentId) fail('no-agent', '拿不到当前会话，无法提交步骤')
      const binding = bindingFor(exec, cwd)
      if (args.stepId === 'preflight') fail('preflight-auto', 'preflight 由 cue_run(start) 自动完成，不需要 cue_step')
      return await stepRun(ctx, {
        cwd,
        runId: String(args.runId ?? ''),
        bookId: binding?.bookId ?? null,
        agentId,
        stepId: String(args.stepId ?? ''),
        status: args.status ?? 'done',
        artifact: args.artifact ?? null,
        note: args.note ?? null,
        idempotencyKey: args.idempotencyKey ?? null,
      })
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeStatus(args = {}, exec = {}) {
    try {
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const agentId = exec?.agent?.id
      if (!agentId) fail('no-agent', '拿不到当前会话')
      const binding = bindingFor(exec, cwd)
      const run = await getRunStatus(cwd, { runId: args.runId, bookId: binding?.bookId ?? null, agentId })
      return { ok: true, ...statusView(run, args.view ?? 'sheet') }
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeScope(args = {}, exec = {}) {
    try {
      if (!scope) fail('no-scope', '当前宿主没有 scope 管理器')
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const agent = exec?.agent
      if (!agent?.id) fail('no-agent', '拿不到当前会话')
      const action = String(args.action ?? 'status').toLowerCase()
      if (action === 'init') {
        const binding = await scope.init(agent, cwd, { book: args.book, title: args.title })
        return { ok: true, action, cwd, binding }
      }
      if (action === 'add') {
        const identity = await scope.add(agent, cwd, { book: args.book, title: args.title })
        return { ok: true, action, cwd, identity }
      }
      if (action === 'bind') {
        const binding = await scope.select(agent, cwd, args.book)
        return { ok: true, action, cwd, binding }
      }
      if (action === 'status') {
        const identity = await readBookIdentity(cwd)
        return { ok: true, action, cwd, identity, binding: scope.get(agent) }
      }
      fail('bad-action', 'action 必须是 init / add / bind / status')
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeLocks(args = {}, exec = {}) {
    try {
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const binding = scope?.get?.(exec?.agent) ?? null
      if (binding && normalizeCwd(cwd) !== normalizeCwd(binding.workspace)) {
        fail('cross-workspace', `当前会话绑定的是 ${binding.workspace}，不能操作 ${cwd} 的锁`)
      }
      const action = String(args.action ?? 'status').toLowerCase()
      const resource = String(args.resource ?? 'book-write')
      if (action === 'status') {
        return { ok: true, action, bookId: binding?.bookId ?? null, ...(await lockStatus(cwd, resource)) }
      }
      // 模型不能强拆锁：break 只走作者输入的 /cue locks break。
      fail('author-only', 'break 只允许作者通过 /cue locks break 执行')
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeTools(args = {}, exec = {}) {
    try {
      if (!scope) fail('no-scope', '当前宿主没有 scope 管理器')
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const binding = bindingFor(exec, cwd)
      if (!binding) fail('no-binding', '当前会话还没有绑定书；先 cue_scope init/bind')
      const policies = await readProviderPolicies(cwd)
      const tools = await listTools({
        ctx,
        agent: exec?.agent,
        toolSet: exec?.toolSet,
        binding,
        policies,
        query: args.query,
        limit: args.limit,
      })
      return { ok: true, book: binding.book, bookId: binding.bookId, tools }
    } catch (error) {
      return asToolError(error)
    }
  }

  async function executeCall(args = {}, exec = {}) {
    try {
      if (!scope) fail('no-scope', '当前宿主没有 scope 管理器')
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const binding = bindingFor(exec, cwd)
      if (!binding) fail('no-binding', '当前会话还没有绑定书；先 cue_scope init/bind')
      const run = await getRunStatus(cwd, { bookId: binding.bookId, agentId: exec?.agent?.id })
      if (['completed', 'blocked', 'aborted'].includes(run.state)) {
        fail('no-active-run', 'cue_call 需要活动 run；先 cue_run({action:"start"})')
      }
      const policies = await readProviderPolicies(cwd)
      return await callTool({
        ctx,
        agent: exec?.agent,
        toolSet: exec?.toolSet,
        signal: exec?.signal,
        binding,
        run,
        tool: String(args.tool ?? ''),
        args: args.args ?? {},
        policies,
        purpose: args.purpose,
      })
    } catch (error) {
      return asToolError(error)
    }
  }

  const cwdParam = {
    type: 'string',
    description: '工作区根目录（绝对路径）。不传时用当前会话的工作区。',
  }

  return [
    {
      name: 'cue_run',
      description: '故事总控：开始 / 恢复 / 中止 / 查看一章的 runbook。start 会装配 beat/fade/voice 的只读上下文与能力矩阵，然后停在 write 之前（若 beat 还有待拍板决策，则停在 await_author）。它不写正文、不改兄弟账本；每一步的完成必须由宿主工具收据 + 服务回查来证明。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'resume', 'abort', 'status'] },
          cwd: cwdParam,
          book: { type: 'string', description: '书名（start 必填）' },
          chapter: { type: 'number', minimum: 1, maximum: 9999, description: '章号（start 必填）' },
          task_type: { type: 'string', enum: ['chapter_write'], description: '0.1 只支持 chapter_write' },
          fanfic_project: {
            type: 'string',
            description: 'start 时绑定的同人项目名（.dsh-novel-fanfic/<project>）；要求 fanfic 能力时必填，之后 fic_* 直调只接受该项目。',
          },
          required_capabilities: {
            type: 'array',
            items: { type: 'string', enum: ['beat', 'fade', 'voice', 'fanfic'] },
            description: '本 run 必需的能力。省略时：装了 beat 就要求 beat，否则 solo。完整一章建议传 beat/fade/voice。',
          },
          runId: { type: 'string', description: 'resume / abort / status 指定 run；不传则用当前活动 run' },
          reason: { type: 'string', description: 'abort 的原因' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output,
      execute: executeRun,
    },
    {
      name: 'cue_step',
      description: '提交当前 runbook 步骤的结果。只接受当前步骤；status 可为 done / skipped / failed / needs_author。write 只认正文文件存在 + 字数 + sha1；segment 只认 beat_segment 的 tools/result 收据并用 novelBeat.getArtifact 回查；verify 只认 beat_verify 的 verified:true 与 voice_check 的 pass:true；digest 只认 memo_digest 收据并用 novelFade 回读。没有收据的完成会记为 claimed，close 会拒绝。',
      parameters: {
        type: 'object',
        properties: {
          cwd: cwdParam,
          runId: { type: 'string' },
          stepId: {
            type: 'string',
            enum: ['preflight', 'write', 'segment', 'verify', 'digest', 'close'],
          },
          status: { type: 'string', enum: ['done', 'skipped', 'failed', 'needs_author'] },
          artifact: {
            type: 'object',
            description: '意图/引用，不作为证据本身。write: {path,chars,sha1}；segment: {artifactId,hash}；digest: {artifactId,revision}。',
            additionalProperties: true,
          },
          note: { type: 'string' },
          idempotencyKey: { type: 'string', description: '同一步骤重试时传同一个 key，重复提交只记一次' },
        },
        required: ['runId', 'stepId'],
        additionalProperties: false,
      },
      output,
      execute: executeStep,
    },
    {
      name: 'cue_status',
      description: '查看当前 run 的步骤、等待事项、真实收据、预算与能力矩阵。view=sheet 给一页总览；steps 给完整步骤；budget 给四段上下文预算；capabilities 给插件能力矩阵。',
      parameters: {
        type: 'object',
        properties: {
          cwd: cwdParam,
          runId: { type: 'string' },
          view: { type: 'string', enum: ['sheet', 'steps', 'budget', 'capabilities', 'runbook'] },
        },
        additionalProperties: false,
      },
      output,
      execute: executeStatus,
    },
    {
      name: 'cue_scope',
      description: '小说工作区身份：init 建 book.json、add 加第二本书、bind 绑定当前会话到某本书、status 查看身份与绑定。多书工作区未绑定前只开放控制工具，不开放创作工具。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['init', 'add', 'bind', 'status'] },
          cwd: cwdParam,
          book: { type: 'string', description: '书名（init/add/bind 必填）' },
          title: { type: 'string', description: '显示标题（可选）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output,
      execute: executeScope,
    },
    {
      name: 'cue_locks',
      description: '查看当前书的写锁。只读；break 只能由作者用 /cue locks break 执行，模型不能强拆。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status'] },
          cwd: cwdParam,
          resource: { type: 'string', description: '锁资源名，默认 book-write' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output,
      execute: executeLocks,
    },
    {
      name: 'cue_tools',
      description: '列出当前步骤可调用的工具（含第三方插件与 MCP），标出 effects / stateScope / 是否已绑定书。query 按名称/描述过滤；只返回摘要，不返回完整 schema。',
      parameters: {
        type: 'object',
        properties: {
          cwd: cwdParam,
          query: { type: 'string', description: '按工具名/描述过滤（可选）' },
          limit: { type: 'number', minimum: 1, maximum: 50, description: '最多返回多少条，默认 24' },
        },
        additionalProperties: false,
      },
      output,
      execute: executeTools,
    },
    {
      name: 'cue_call',
      description: '调用一个已注册工具（第三方插件/MCP/六包），不需要该工具为 conductor 做过适配。网关会注入 book/bookId/dir 等绑定参数、拒绝跨书、按 ProviderPolicy 决定是否允许；未声明状态的工具默认拒绝。需要先有活动 run。',
      parameters: {
        type: 'object',
        properties: {
          cwd: cwdParam,
          tool: { type: 'string', description: '工具名（cue_tools 返回的 name）' },
          args: { type: 'object', description: '工具参数；book/bookId/dir 等绑定参数可省略，由网关注入', additionalProperties: true },
          purpose: { type: 'string', description: '一句话说明为什么调用（写进收据，最多 200 字）' },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      output,
      execute: executeCall,
    },
  ]
}

export { asToolError, resolveCwd }
