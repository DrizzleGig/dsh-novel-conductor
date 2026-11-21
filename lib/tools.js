// lib/tools.js — exactly three tools. The model remembers fewer tools, so the
// runbook is more likely to be walked to the end.

import { fail, normalizeCwd } from './run-store.js'
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

export function toolDefinitions({ ctx } = {}) {
  const workingDirectory = ctx?.get?.('workingDirectory') ?? null

  async function executeRun(args = {}, exec = {}) {
    try {
      const cwd = await resolveCwd(args, exec, workingDirectory)
      const agentId = exec?.agent?.id
      if (!agentId) fail('no-agent', '拿不到当前会话，无法启动 run')
      const action = String(args.action ?? '').toLowerCase()
      if (action === 'start') {
        const result = await startRun(ctx, {
          cwd,
          agentId,
          book: assertBookName(args.book),
          chapter: assertChapter(args.chapter),
          taskType: args.task_type ?? 'chapter_write',
          requiredCapabilities: args.required_capabilities,
          // fanfic 是分支能力：同人/改编任务要指名项目目录（.dsh-novel-fanfic/<项目>），
          // 不填就只在工作区恰好一个同人项目时自动选中，多于一个会报歧义、不猜。
          fanficProject: args.fanfic_project,
          runId: args.runId,
        })
        return result
      }
      if (action === 'resume') {
        const run = await getRunStatus(cwd, { runId: args.runId, agentId })
        return { ok: true, ...(await resumeRun(ctx, { cwd, runId: run.runId, agentId })) }
      }
      if (action === 'abort') {
        const run = await getRunStatus(cwd, { runId: args.runId, agentId })
        return await abortRun(cwd, { runId: run.runId, agentId, reason: args.reason })
      }
      if (action === 'status') {
        const run = await getRunStatus(cwd, { runId: args.runId, agentId })
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
      if (args.stepId === 'preflight') fail('preflight-auto', 'preflight 由 cue_run(start) 自动完成，不需要 cue_step')
      return await stepRun(ctx, {
        cwd,
        runId: String(args.runId ?? ''),
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
      const run = await getRunStatus(cwd, { runId: args.runId, agentId })
      return { ok: true, ...statusView(run, args.view ?? 'sheet') }
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
      description: '舞台监督：开始 / 恢复 / 中止 / 查看一章的 runbook。start 会装配 beat/fade/voice 的只读上下文与能力矩阵，然后停在 write 之前（若 beat 还有待拍板决策，则停在 await_author）。它不写正文、不改兄弟账本；每一步的完成必须由宿主工具收据 + 服务回查来证明。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'resume', 'abort', 'status'] },
          cwd: cwdParam,
          book: { type: 'string', description: '书名（start 必填）' },
          chapter: { type: 'number', minimum: 1, maximum: 9999, description: '章号（start 必填）' },
          task_type: { type: 'string', enum: ['chapter_write'], description: '0.1 只支持 chapter_write' },
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
          view: { type: 'string', enum: ['sheet', 'steps', 'budget', 'capabilities'] },
        },
        additionalProperties: false,
      },
      output,
      execute: executeStatus,
    },
  ]
}

export { asToolError, resolveCwd }
