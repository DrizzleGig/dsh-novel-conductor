// lib/run-machine.js — the six-step runbook and its evidence rules.
//
// It owns only conductor state: run.json, step windows, capability matrix and
// committed artifact references. It never writes a sibling ledger.

import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  BUDGET,
  CAPABILITIES,
  DEFAULT_TASK_TYPE,
  TERMINAL_STATES,
} from './consts.js'
import {
  appendEvent,
  appendReceipt,
  createRun,
  createRunId,
  fail,
  findActiveRun,
  findLatestRun,
  listRuns,
  runExists,
  nowIso,
  readReceipts,
  readRun,
  stepTemplate,
  writeRun,
} from './run-store.js'
import { findReceipts, isSuccess, matchesRun, normalizeReceipt } from './receipt.js'
import { clearRun, noteRun } from './session.js'
import { drainRaw, withReceiptLock } from './receipt-bus.js'
import { buildRunbook } from './runbook.js'
import { beatArtifact, beatCanon, beatStatus, probeBeat } from './adapters/beat.js'
import { fadeArtifact, fadeBrief, fadeStatus, probeFade } from './adapters/fade.js'
import { probeVoice, voiceBrief } from './adapters/voice.js'
import { fanficContract, probeFanfic } from './adapters/fanfic.js'

const CHAPTER_MAX = 9999
const BOOK_MAX = 80

export function assertBookName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > BOOK_MAX || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    fail('bad-book', 'book 必须是 1–80 个字符的书名，不能包含路径分隔符')
  }
  return name
}

export function assertChapter(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > CHAPTER_MAX) {
    fail('bad-chapter', `chapter 必须是 1–${CHAPTER_MAX} 的整数`)
  }
  return number
}

export function assertCwdInside(cwd, target) {
  const base = resolve(cwd)
  const file = isAbsolute(target) ? resolve(target) : resolve(base, target)
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('bad-path', '正文路径必须在工作区内')
  return file
}

function sha1(value) {
  return createHash('sha1').update(String(value), 'utf8').digest('hex')
}

function normalizeHash(value) {
  return typeof value === 'string' ? value.replace(/^sha(1|256):/i, '').trim().toLowerCase() : ''
}

function countChars(value) {
  return [...String(value)].length
}

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(Number(chars) / 2))
}

function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function summarizeCanon(canon, maxChars = BUDGET.beat) {
  if (!canon || typeof canon !== 'object') return { markdown: '', chars: 0 }
  const lines = []
  for (const entry of Array.isArray(canon.canon) ? canon.canon : []) {
    lines.push(`- ${entry.entity}/${entry.key}：${entry.value}`)
  }
  for (const entry of Array.isArray(canon.obligations) ? canon.obligations : []) {
    lines.push(`- 未兑现：${entry.text}${entry.dueChapter ? `（第 ${entry.dueChapter} 章）` : ''}`)
  }
  for (const entry of Array.isArray(canon.decisions) ? canon.decisions : []) {
    if (entry.choice) lines.push(`- 第 ${entry.chapter} 章「${entry.title}」：${entry.choice}`)
  }
  const markdown = clip(lines.join('\n'), maxChars)
  return { markdown, chars: countChars(markdown) }
}

export function planSteps(required) {
  const set = new Set(required)
  const steps = ['preflight', 'write']
  if (set.has('beat')) steps.push('segment')
  // verify 的检查项来自 required（beat_verify / voice_check / fic_check 的 pass），
  // 所以三者任一在 required 里都要有 verify 步骤。
  if (set.has('beat') || set.has('voice') || set.has('fanfic')) steps.push('verify')
  if (set.has('fade')) steps.push('digest')
  steps.push('close')
  return steps
}

export function defaultRequired(capabilityMatrix) {
  return capabilityMatrix?.beat?.installed ? ['beat'] : []
}

function normalizeRequired(value, matrix) {
  if (value === undefined || value === null) return defaultRequired(matrix)
  if (!Array.isArray(value)) fail('bad-capabilities', 'required_capabilities 必须是数组')
  const out = []
  for (const item of value) {
    if (!CAPABILITIES.includes(item)) fail('bad-capabilities', `未知能力：${String(item)}`)
    if (!out.includes(item)) out.push(item)
  }
  return out
}

export async function probeCapabilities(ctx, run) {
  // fanfic 是**分支能力**：只有同人/改编任务才该碰它。是否碰由调用方显式声明的
  // required_capabilities 决定——原创任务不写 fanfic，这里就连一次 getStatus 都不发，
  // 面板/run.json 里只留一个 reason:'not-required' 的占位，避免「原创也去读同人项目」。
  const wants = Array.isArray(run.requiredCapabilitiesInput) ? run.requiredCapabilitiesInput : []
  const wantFanfic = wants.includes('fanfic')
  const [beat, fade, voice, fanfic] = await Promise.all([
    probeBeat(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter }),
    probeFade(ctx, { cwd: run.cwd, book: run.book }),
    probeVoice(ctx, { cwd: run.cwd, book: run.book }),
    wantFanfic ? probeFanfic(ctx, { cwd: run.cwd, project: run.fanficProject }) : { skipped: true },
  ])
  const entry = (probe) => ({
    installed: probe.installed === true,
    on: null,
    observable: false,
    service: probe.identity?.service_version ?? null,
    version: probe.identity?.version ?? null,
    minVersion: probe.minVersion ?? null,
    compatible: probe.compatible ?? null,
    revision: probe.revision ?? null,
    ready: probe.ready === true,
    reason: probe.reason ?? null,
  })
  return {
    beat: entry(beat),
    fade: entry(fade),
    voice: entry(voice),
    fanfic: fanfic.skipped
      // 本次任务没要求 fanfic：不探测、不读项目，明确标「未要求」而不是「未安装」。
      ? { installed: false, on: null, observable: false, service: null, version: null, minVersion: null, compatible: null, revision: null, ready: false, reason: 'not-required', project: null, chapters: 0 }
      : { ...entry(fanfic), project: fanfic.project ?? null, chapters: fanfic.chapters ?? 0 },
  }
}

async function assembleContext(ctx, run) {
  const segments = {}
  const required = new Set(run.requiredCapabilities)

  if (run.capabilityMatrix?.beat?.installed) {
    const canon = await beatCanon(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter })
    const summary = summarizeCanon(canon, BUDGET.beat)
    segments.beat = {
      available: Boolean(summary.chars),
      markdown: summary.markdown,
      chars: summary.chars,
      tokens: estimateTokens(summary.chars),
      revision: run.capabilityMatrix.beat.revision,
      reason: summary.chars ? null : 'empty-canon',
    }
  }

  if (required.has('fade') && run.capabilityMatrix?.fade?.ready) {
    const brief = await fadeBrief(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter, budget: BUDGET.fade })
    if (brief.available) {
      const markdown = clip(brief.markdown ?? '', BUDGET.fade)
      segments.fade = {
        available: true,
        markdown,
        chars: countChars(markdown),
        tokens: brief.tokens ?? estimateTokens(countChars(markdown)),
        revision: brief.revision ?? run.capabilityMatrix.fade.revision,
        reason: null,
      }
    } else {
      segments.fade = { available: false, markdown: '', chars: 0, tokens: 0, revision: null, reason: brief.reason }
    }
  }

  if (required.has('voice') && run.capabilityMatrix?.voice?.ready) {
    const brief = await voiceBrief(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter, budget: BUDGET.voice })
    if (brief.available) {
      const markdown = clip(brief.markdown ?? '', BUDGET.voice)
      segments.voice = {
        available: true,
        markdown,
        chars: countChars(markdown),
        tokens: brief.tokens ?? estimateTokens(countChars(markdown)),
        revision: brief.revision ?? run.capabilityMatrix.voice.revision,
        reason: null,
      }
    } else {
      segments.voice = { available: false, markdown: '', chars: 0, tokens: 0, revision: null, reason: brief.reason }
    }
  }

  // 世界契约段（分支能力，只读）：同人/改编任务才需要；缺 fanfic 不阻塞其它步骤。
  if (required.has('fanfic') && run.capabilityMatrix?.fanfic?.ready) {
    const contract = await fanficContract(ctx, {
      cwd: run.cwd,
      project: run.fanficProject ?? run.capabilityMatrix.fanfic.project ?? undefined,
      chapter: `ch${String(run.chapter).padStart(3, '0')}`,
    })
    if (contract.available) {
      const markdown = clip(contract.markdown ?? '', BUDGET.fanfic)
      segments.fanfic = {
        available: true,
        markdown,
        chars: countChars(markdown),
        tokens: estimateTokens(countChars(markdown)),
        revision: contract.revision ?? run.capabilityMatrix.fanfic.revision,
        hash: contract.hash ?? null,
        sections: contract.sectionOrder ?? [],
        reason: null,
      }
    } else {
      segments.fanfic = { available: false, markdown: '', chars: 0, tokens: 0, revision: null, reason: contract.reason }
    }
  }

  const total = Object.values(segments).reduce((sum, segment) => sum + (segment.chars ?? 0), 0)
  return { segments, chars: total }
}

function stepStateFor(stepId) {
  return {
    write: 'writing',
    segment: 'segmenting',
    verify: 'verifying',
    digest: 'digesting',
    close: 'closing',
  }[stepId] ?? 'writing'
}

function markRunning(step, receiptSeq) {
  step.state = 'running'
  step.startedAt = nowIso()
  step.endedAt = null
  step.windowStart = Number(receiptSeq ?? 0)
  step.verified = null
  step.receipt = null
  step.note = null
  step.source = null
  return step
}

function nextStepOf(run, currentId) {
  const index = run.steps.findIndex((step) => step.id === currentId)
  return index >= 0 ? run.steps[index + 1] ?? null : null
}

function advance(run) {
  const current = run.steps.find((step) => step.id === run.currentStep)
  if (current) {
    current.state = 'done'
    current.endedAt = nowIso()
  }
  const next = nextStepOf(run, run.currentStep)
  if (!next) {
    run.state = 'completed'
    return
  }
  markRunning(next, run.receiptSeq)
  run.currentStep = next.id
  run.state = stepStateFor(next.id)
}

function upsertCommitted(run, item) {
  run.committedArtifacts = (run.committedArtifacts ?? []).filter((existing) => !(
    existing.kind === item.kind && existing.artifactId && item.artifactId && existing.artifactId === item.artifactId
  ))
  run.committedArtifacts.push(item)
}

function rewindTo(run, target) {
  const close = run.steps.find((step) => step.id === 'close')
  if (close) {
    close.state = 'pending'
    close.verified = null
    close.receipt = null
    close.note = null
  }
  markRunning(target, run.receiptSeq)
  run.currentStep = target.id
  run.state = stepStateFor(target.id)
}

function markFailed(run, step, code, message, extra = {}) {
  step.state = 'failed'
  step.endedAt = nowIso()
  step.note = message
  run.lastError = { code, message, at: nowIso(), ...extra }
}

function pendingFromBeat(status) {
  const decisions = Array.isArray(status?.pending) ? status.pending : []
  const open = Number(status?.openDecisions ?? 0)
  const pendingConfirm = Number(status?.stateDetail?.pendingConfirm ?? 0)
  if (decisions.length === 0 && open <= 0 && pendingConfirm <= 0) return null
  return {
    reason: 'beat-pending',
    stepId: 'write',
    chapterState: status?.chapterState ?? null,
    decisions: decisions.map((item) => ({ id: item.id, title: item.title, status: item.status })),
    at: nowIso(),
  }
}

function fingerprintOf({ stepId, status, artifact, note }) {
  return createHash('sha1').update(JSON.stringify({ stepId, status, artifact, note })).digest('hex')
}

export function createRunObject({ runId, agentId, cwd, bookId = null, book, chapter, taskType }) {
  const now = nowIso()
  return {
    schemaVersion: 1,
    runId,
    agentId,
    cwd,
    bookId,
    book,
    chapter,
    taskType,
    requiredCapabilities: [],
    capabilityMatrix: {},
    revisionsAtStart: {},
    state: 'preflighting',
    currentStep: 'preflight',
    steps: [],
    pendingAuthor: null,
    committedArtifacts: [],
    budget: { chars: 0, usedChars: 0, segments: {} },
    receiptSeq: 0,
    generation: 0,
    idempotency: {},
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

export async function preflightRun(ctx, run) {
  run.capabilityMatrix = await probeCapabilities(ctx, run)
  run.runbook = buildRunbook(run.capabilityMatrix, { taskType: run.taskType })
  run.requiredCapabilities = normalizeRequired(run.requiredCapabilitiesInput, run.capabilityMatrix)
  run.revisionsAtStart = Object.fromEntries(
    CAPABILITIES.map((name) => [name, run.capabilityMatrix[name]?.revision ?? null]),
  )

  const missing = run.requiredCapabilities.filter((name) => {
    const entry = run.capabilityMatrix[name]
    return !entry?.installed || !entry?.ready
  })

  run.steps = planSteps(run.requiredCapabilities).map((id) => stepTemplate(id, true))
  const preflight = run.steps.find((step) => step.id === 'preflight')
  preflight.state = 'done'
  preflight.startedAt = run.createdAt
  preflight.endedAt = nowIso()
  preflight.note = '能力矩阵与上下文已装配'

  if (missing.length > 0) {
    run.state = 'blocked'
    run.currentStep = 'preflight'
    run.blockedReason = {
      code: 'capability-missing',
      missing,
      matrix: run.capabilityMatrix,
      at: nowIso(),
    }
    return { blocked: true, missing, context: null }
  }

  const context = await assembleContext(ctx, run)
  run.budget = {
    chars: context.chars,
    usedChars: 0,
    segments: Object.fromEntries(
      Object.entries(context.segments).map(([name, segment]) => [name, {
        chars: segment.chars, tokens: segment.tokens, revision: segment.revision, available: segment.available,
      }]),
    ),
  }

  const write = run.steps.find((step) => step.id === 'write')
  markRunning(write, run.receiptSeq)
  run.currentStep = 'write'
  run.pendingAuthor = run.requiredCapabilities.includes('beat') && run.capabilityMatrix.beat.installed
    ? pendingFromBeat(await beatStatus(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter }))
    : null
  run.state = run.pendingAuthor ? 'awaiting_author' : 'writing'
  return { blocked: false, missing: [], context }
}

export async function startRun(ctx, { cwd, agentId, bookId = null, book, chapter, taskType = DEFAULT_TASK_TYPE, requiredCapabilities, fanficProject, runId } = {}) {
  if (taskType !== DEFAULT_TASK_TYPE) fail('bad-task-type', '0.1 只支持 chapter_write')
  if (runId && await runExists(cwd, String(runId), bookId)) fail('run-exists', `runId 已存在：${runId}`)
  const active = await findActiveRun(cwd, agentId, bookId)
  if (active) {
    return { ok: false, code: 'run-active', message: `已有进行中的 run：${active.runId}`, run: runSheet(active) }
  }
  const id = runId ? String(runId) : createRunId()
  const run = createRunObject({
    runId: id,
    agentId,
    cwd,
    bookId,
    book: assertBookName(book),
    chapter: assertChapter(chapter),
    taskType,
  })
  run.requiredCapabilitiesInput = requiredCapabilities
  // 同人项目目录名（.dsh-novel-fanfic/<项目>）：只在 required 里有 fanfic 时才用得上。
  if (fanficProject) run.fanficProject = String(fanficProject)
  noteRun(agentId, cwd, id)
  await createRun(cwd, run)
  const result = await preflightRun(ctx, run)
  await writeRun(cwd, run)
  await appendEvent(cwd, id, { kind: 'preflight', state: run.state, step: run.currentStep, blocked: result.blocked }, bookId)
  return {
    ok: true,
    run: runSheet(run),
    context: result.context ? {
      segments: result.context.segments,
      markdown: Object.values(result.context.segments)
        .filter((segment) => segment.available && segment.markdown)
        .map((segment) => segment.markdown)
        .join('\n\n'),
    } : null,
    blocked: result.blocked,
    missing: result.missing,
  }
}

export function runSheet(run) {
  const current = run.steps.find((step) => step.id === run.currentStep) ?? null
  return {
    runId: run.runId,
    bookId: run.bookId ?? null,
    book: run.book,
    chapter: run.chapter,
    taskType: run.taskType,
    state: run.state,
    currentStep: run.currentStep,
    pendingAuthor: run.pendingAuthor,
    blockedReason: run.blockedReason ?? null,
    steps: run.steps.map((step) => ({
      id: step.id,
      state: step.state,
      required: step.required,
      verified: step.verified ?? null,
      note: step.note ?? null,
    })),
    current: current ? current.id : null,
    next: nextStepOf(run, run.currentStep)?.id ?? null,
    capabilityMatrix: run.capabilityMatrix,
    revisionsAtStart: run.revisionsAtStart,
    budget: run.budget,
    committedArtifacts: run.committedArtifacts,
    runbook: run.runbook ?? null,
    lastError: run.lastError ?? null,
  }
}

export function statusView(run, view = 'sheet') {
  if (view === 'steps') return { runId: run.runId, currentStep: run.currentStep, state: run.state, steps: run.steps }
  if (view === 'budget') return { runId: run.runId, budget: run.budget, revisionsAtStart: run.revisionsAtStart }
  if (view === 'capabilities') return { runId: run.runId, capabilityMatrix: run.capabilityMatrix, revisionsAtStart: run.revisionsAtStart }
  if (view === 'runbook') return { runId: run.runId, runbook: run.runbook ?? null }
  return runSheet(run)
}

async function completeWrite(ctx, run, step, payload) {
  const artifact = payload.artifact ?? {}
  const rawPath = artifact.path
  if (typeof rawPath !== 'string' || !rawPath.trim()) fail('no-path', 'write 步骤必须给 artifact.path')
  const file = assertCwdInside(run.cwd, rawPath)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    fail('write-missing', `正文文件读不到：${relative(run.cwd, file)}`, { cause: error?.message })
  }
  const chars = countChars(text)
  if (Number.isFinite(artifact.chars) && Math.abs(artifact.chars - chars) > Math.max(20, Math.ceil(chars * 0.05))) {
    fail('write-size', `字数不符：声明 ${artifact.chars}，实际 ${chars}`)
  }
  const digest = sha1(text)
  if (typeof artifact.sha1 === 'string' && artifact.sha1.replace(/^sha1:/i, '').toLowerCase() !== digest) {
    fail('write-hash', '正文 sha1 与声明不符')
  }
  const receipt = { path: relative(run.cwd, file).replace(/\\/g, '/'), chars, sha1: `sha1:${digest}` }
  step.receipt = receipt
  step.source = { kind: 'file' }
  step.verified = true
  upsertCommitted(run, { ...receipt, kind: 'chapter' })
  return { ok: true, step: step.id, receipt }
}

async function completeSegment(ctx, run, step, payload) {
  const receipts = await readReceipts(run.cwd, run.runId, run.bookId ?? null)
  const candidates = findReceipts(receipts, step, ['beat_segment']).filter(isSuccess)
  const receipt = candidates.at(-1)
  if (!receipt) {
    step.state = 'done'
    step.endedAt = nowIso()
    step.source = { kind: 'claimed' }
    step.verified = false
    step.note = '本步骤窗口内没有 beat_segment 的成功收据；按 claimed 记录，close 会拒绝'
    return { ok: true, claimed: true, step: step.id }
  }

  const value = receipt.value ?? {}
  const ledgerId = value.segmentId ?? value.segment?.id ?? null
  const payloadId = payload.artifact?.artifactId ?? null
  if (ledgerId && payloadId && ledgerId !== payloadId) {
    markFailed(run, step, 'artifact-mismatch', `提交的 artifactId ${payloadId} 与收据 ${ledgerId} 不一致`)
    return { ok: false, code: 'artifact-mismatch', step: step.id }
  }
  const artifactId = ledgerId ?? payloadId
  if (!artifactId) {
    step.state = 'done'
    step.endedAt = nowIso()
    step.source = { kind: 'claimed' }
    step.verified = false
    step.note = 'beat_segment 收据里没有 artifactId；按 claimed 记录'
    return { ok: true, claimed: true, step: step.id }
  }

  const artifact = await beatArtifact(ctx, { cwd: run.cwd, book: run.book, artifactId })
  if (artifact?.segment?.status === 'reverted') {
    markFailed(run, step, 'artifact-reverted', `beat 产物 ${artifactId} 已被回退，不能当作当前段落`)
    return { ok: false, code: 'artifact-reverted', step: step.id, artifact }
  }
  if (!artifact?.found) {
    markFailed(run, step, 'artifact-missing', `beat 回查不到产物 ${artifactId}`)
    return { ok: false, code: 'artifact-missing', step: step.id, artifact }
  }

  const receiptHash = normalizeHash(value.segment?.hash ?? value.hash)
  const payloadHash = normalizeHash(payload.artifact?.hash)
  if (receiptHash && payloadHash && receiptHash !== payloadHash) {
    markFailed(run, step, 'hash-mismatch', `提交的 hash 与收据不一致`)
    return { ok: false, code: 'hash-mismatch', step: step.id }
  }
  const artifactHash = normalizeHash(artifact.hash)
  if (receiptHash && artifactHash && receiptHash !== artifactHash) {
    markFailed(run, step, 'artifact-hash', `产物 hash 不符：收据 ${receiptHash}，账本 ${artifactHash}`)
    return { ok: false, code: 'artifact-hash', step: step.id, artifact }
  }

  const record = {
    artifactId,
    kind: artifact.kind ?? 'segment',
    revision: artifact.revision ?? null,
    revisionId: artifact.revisionId ?? null,
    hash: artifact.hash ?? value.segment?.hash ?? null,
  }
  step.state = 'done'
  step.endedAt = nowIso()
  step.source = { kind: 'receipt', tool: 'beat_segment', callId: receipt.id }
  step.receipt = record
  step.verified = true
  upsertCommitted(run, { ...record, kind: 'beat', artifactKind: record.kind })
  return { ok: true, step: step.id, receipt: record }
}

function verifyBeat(run, receipts, step) {
  const receipt = findReceipts(receipts, step, ['beat_verify']).filter(isSuccess).at(-1)
  if (!receipt) return { name: 'beat', ok: false, code: 'missing-receipt', reason: '没有 beat_verify 的成功收据' }
  const value = receipt.value ?? {}
  if (value.verified === true && value.pass !== false) return { name: 'beat', ok: true, receiptId: receipt.id }
  if (value.pass === true && value.verified !== false) return { name: 'beat', ok: true, receiptId: receipt.id }
  return {
    name: 'beat',
    ok: false,
    code: 'verify-failed',
    reason: 'beat_verify 返回 verified:false',
    findings: Number.isInteger(value.failures) ? value.failures : null,
  }
}

function verifyVoice(run, receipts, step) {
  const receipt = findReceipts(receipts, step, ['voice_check']).filter(isSuccess).at(-1)
  if (!receipt) return { name: 'voice', ok: false, code: 'missing-receipt', reason: '没有 voice_check 的成功收据' }
  const value = receipt.value ?? {}
  if (value.status === 'failed') {
    return { name: 'voice', ok: false, code: 'tool-failed', reason: 'voice_check 执行失败', findings: Number.isInteger(value.findings) ? value.findings : null }
  }
  if (value.status === 'skipped') {
    return { name: 'voice', ok: false, code: 'skipped', reason: 'voice_check 被跳过，但 voice 是本 run 的必需能力' }
  }
  if (value.pass === false) {
    return {
      name: 'voice', ok: false, code: 'verify-failed',
      reason: 'voice_check 完成但存在 block', findings: Number.isInteger(value.findings) ? value.findings : null,
    }
  }
  if (value.pass !== true) {
    return { name: 'voice', ok: false, code: 'verify-failed', reason: 'voice_check 没有给出 pass:true' }
  }
  return { name: 'voice', ok: true, receiptId: receipt.id }
}

function verifyFanfic(run, receipts, step) {
  const receipt = findReceipts(receipts, step, ['fic_check']).filter(isSuccess).at(-1)
  if (!receipt) return { name: 'fanfic', ok: false, code: 'missing-receipt', reason: '没有 fic_check 的成功收据' }
  const value = receipt.value ?? {}
  if (value.status === 'failed') {
    return { name: 'fanfic', ok: false, code: 'tool-failed', reason: 'fic_check 执行失败' }
  }
  if (value.status === 'skipped') {
    return { name: 'fanfic', ok: false, code: 'skipped', reason: 'fic_check 被跳过，但 fanfic 是本 run 的必需能力' }
  }
  // 夹具数据不算真书验收：v0.1 的 fic_check 默认 source:'fixture'，
  // 不校验来源的话，夹具的 pass:true 会被当成真章通过。
  if (value.source !== 'canon') {
    return {
      name: 'fanfic',
      ok: false,
      code: 'fixture-source',
      reason: 'fic_check 不是跑在 canon 上（source!="canon"），夹具结果不能当验收',
    }
  }
  if (!Number.isInteger(value.revision)) {
    return { name: 'fanfic', ok: false, code: 'missing-revision', reason: 'fic_check 没有整数 revision，无法判断检查的是哪一版' }
  }
  // 与 voice 同一口径：执行成功（status:completed）≠ 检查通过（pass:true）。
  // fanfic 的 waiver 已在服务端应用，所以 pass 已经是「作者放过后」的结论。
  if (value.pass !== true) {
    return {
      name: 'fanfic',
      ok: false,
      code: 'verify-failed',
      reason: 'fic_check 完成但没有 pass:true（还有未处理的 blocker）',
      findings: Number.isInteger(value.summary?.blockers) ? value.summary.blockers : null,
    }
  }
  return { name: 'fanfic', ok: true, receiptId: receipt.id, revision: value.revision, waived: value.summary?.waived ?? 0 }
}

async function completeVerify(ctx, run, step) {
  const receipts = await readReceipts(run.cwd, run.runId, run.bookId ?? null)
  const checks = []
  if (run.requiredCapabilities.includes('beat')) checks.push(verifyBeat(run, receipts, step))
  if (run.requiredCapabilities.includes('voice')) checks.push(verifyVoice(run, receipts, step))
  if (run.requiredCapabilities.includes('fanfic')) checks.push(verifyFanfic(run, receipts, step))
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    markFailed(run, step, failed[0].code, failed[0].reason, { checks })
    return { ok: false, code: failed[0].code, step: step.id, checks }
  }
  step.state = 'done'
  step.endedAt = nowIso()
  step.source = { kind: 'checks', checks }
  step.receipt = { checks }
  step.verified = true
  return { ok: true, step: step.id, checks }
}

async function completeDigest(ctx, run, step, payload) {
  const receipts = await readReceipts(run.cwd, run.runId, run.bookId ?? null)
  const receipt = findReceipts(receipts, step, ['memo_digest']).filter(isSuccess).at(-1)
  if (!receipt) {
    markFailed(run, step, 'missing-receipt', '没有 memo_digest 的成功收据')
    return { ok: false, code: 'missing-receipt', step: step.id }
  }
  const value = receipt.value ?? {}
  const receiptBody = value.receipt
  if (!receiptBody || typeof receiptBody !== 'object' || !receiptBody.artifactId) {
    markFailed(run, step, 'digest-not-committed', 'memo_digest 只是预览：没有 receipt / artifactId，不能当成已写账本')
    return { ok: false, code: 'digest-not-committed', step: step.id }
  }
  const artifactId = payload.artifact?.artifactId ?? receiptBody.artifactId ?? null
  const revision = payload.artifact?.revision ?? receiptBody.revision ?? null
  if (!Number.isInteger(revision)) {
    markFailed(run, step, 'digest-no-revision', 'memo_digest 的 receipt 没有 revision')
    return { ok: false, code: 'digest-no-revision', step: step.id }
  }
  const status = await fadeStatus(ctx, { cwd: run.cwd, book: run.book })
  if (!status) {
    markFailed(run, step, 'fade-status', 'fade 回读不到本书的记忆状态')
    return { ok: false, code: 'fade-status', step: step.id }
  }
  if (Number.isInteger(revision) && Number.isInteger(status.revision) && status.revision < revision) {
    markFailed(run, step, 'revision-behind', `fade 回读 revision ${status.revision} 落后于收据 ${revision}`)
    return { ok: false, code: 'revision-behind', step: step.id }
  }
  let artifact = null
  if (artifactId) {
    artifact = await fadeArtifact(ctx, { cwd: run.cwd, book: run.book, artifactId, verify: true })
    if (!artifact?.found) {
      markFailed(run, step, 'artifact-missing', `fade 回查不到产物 ${artifactId}`)
      return { ok: false, code: 'artifact-missing', step: step.id, artifact }
    }
  }
  const record = {
    artifactId,
    revision: revision ?? status.revision ?? null,
    hash: artifact?.hash ?? artifact?.artifact?.hash ?? receiptBody.hash ?? null,
    cards: Number.isInteger(value.cards) ? value.cards : null,
  }
  step.state = 'done'
  step.endedAt = nowIso()
  step.source = { kind: 'receipt', tool: 'memo_digest', callId: receipt.id }
  step.receipt = record
  step.verified = true
  upsertCommitted(run, { ...record, kind: 'fade' })
  return { ok: true, step: step.id, receipt: record }
}

async function completeClose(ctx, run, step) {
  if (run.requiredCapabilities.includes('beat')) {
    const status = await beatStatus(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter })
    if (!status) {
      markFailed(run, step, 'beat-unavailable', 'close 前回读不到 beat 状态，不能确认产物仍在账本里')
      return { ok: false, code: 'beat-unavailable', step: step.id }
    }
    const committed = run.committedArtifacts.find((item) => item.kind === 'beat')
    const observable = status.lastSegment !== undefined
    const lastSegment = status.lastSegment?.id ?? null
    if (committed && observable && lastSegment !== committed.artifactId) {
      markFailed(
        run,
        step,
        'beat-reverted',
        `beat 账本的最后一段是 ${lastSegment ?? 'null'}，不是 run 里核验的 ${committed.artifactId}`,
      )
      const segment = run.steps.find((item) => item.id === 'segment')
      if (segment) rewindTo(run, segment)
      return { ok: false, code: 'beat-reverted', step: step.id }
    }
  }
  const unfinished = run.steps.filter((item) => item.id !== 'close' && item.state !== 'done')
  if (unfinished.length > 0) {
    markFailed(run, step, 'steps-unfinished', `还有未完成步骤：${unfinished.map((item) => item.id).join(', ')}`)
    rewindTo(run, unfinished[0])
    return { ok: false, code: 'steps-unfinished', step: step.id, unfinished: unfinished.map((item) => item.id) }
  }
  const unverified = run.steps.filter((item) => item.id !== 'close' && item.required && item.verified === false)
  if (unverified.length > 0) {
    markFailed(run, step, 'claimed-step', `有步骤只是 claimed，不是 verified：${unverified.map((item) => item.id).join(', ')}`)
    rewindTo(run, unverified[0])
    return { ok: false, code: 'claimed-step', step: step.id, claimed: unverified.map((item) => item.id) }
  }
  if (run.committedArtifacts.length === 0) {
    markFailed(run, step, 'no-artifacts', '没有可核验的产物，不能 close')
    return { ok: false, code: 'no-artifacts', step: step.id }
  }
  // 写步骤收据只证明“当时”的文件；写完后再改文件，verify/fic_check 仍可能通过，
  // close 必须回读最终文件 hash，否则 run 会把已漂移的正文标成 completed。
  for (const item of run.committedArtifacts) {
    if (item.kind !== 'chapter' || !item.path || !item.sha1) continue
    const file = assertCwdInside(run.cwd, item.path)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      markFailed(run, step, 'artifact-stale', `close 前读不到正文 ${item.path}`)
      const write = run.steps.find((entry) => entry.id === 'write')
      if (write) rewindTo(run, write)
      return { ok: false, code: 'artifact-stale', step: step.id, path: item.path }
    }
    const actual = `sha1:${sha1(text)}`
    if (actual !== String(item.sha1)) {
      markFailed(run, step, 'artifact-stale', `正文在 write 收据后被修改：${item.path}`)
      const write = run.steps.find((entry) => entry.id === 'write')
      if (write) rewindTo(run, write)
      return { ok: false, code: 'artifact-stale', step: step.id, path: item.path }
    }
  }
  step.state = 'done'
  step.endedAt = nowIso()
  step.source = { kind: 'gate' }
  step.verified = true
  run.state = 'completed'
  return { ok: true, step: step.id, committedArtifacts: run.committedArtifacts }
}

/** Persist raw tools/result events captured by the host listener. */
export async function flushPending(ctx, cwd, runId, agentId, bookId = null) {
  return withReceiptLock(runId, async () => {
    const run = await readRun(cwd, runId, bookId)
    if (run.agentId !== agentId) return run
    const step = run.steps.find((item) => item.id === run.currentStep)
    if (!step) return run
    const raws = drainRaw(agentId)
    if (raws.length === 0) return run

    const existing = await readReceipts(cwd, runId, run.bookId ?? null)
    let seq = Math.max(Number(run.receiptSeq ?? 0), ...existing.map((item) => Number(item.seq ?? 0)))
    let changed = false
    for (const raw of raws) {
      const receipt = normalizeReceipt(raw.exec, raw.result, { seq: seq + 1, at: raw.at })
      if (!matchesRun(run, step, receipt)) continue
      if (existing.some((item) => item.id === receipt.id)) continue
      seq += 1
      receipt.seq = seq
      await appendReceipt(cwd, runId, receipt, run.bookId ?? null)
      existing.push(receipt)
      changed = true
    }
    if (changed) {
      run.receiptSeq = seq
      await writeRun(cwd, run)
    }
    return run
  })
}

export async function stepRun(ctx, { cwd, runId, bookId = null, agentId, stepId, status = 'done', artifact = null, note = null, idempotencyKey = null } = {}) {
  let run = await readRun(cwd, runId, bookId)
  if (run.agentId !== agentId) fail('wrong-agent', '这个 run 不属于当前会话')
  noteRun(agentId, cwd, runId)
  if (TERMINAL_STATES.has(run.state)) fail('run-terminal', `run 已经结束：${run.state}`)
  run = await flushPending(ctx, cwd, runId, agentId, run.bookId ?? bookId)
  if (run.state === 'awaiting_author' && status !== 'needs_author') {
    fail('awaiting-author', 'run 正在等待作者；先 cue_run({action:"resume"})，再提交步骤')
  }
  const fingerprint = fingerprintOf({ stepId, status, artifact, note })
  const cached = idempotencyKey ? run.idempotency?.[idempotencyKey] : null
  if (cached && cached.stepId === stepId && Number(cached.generation ?? 0) === Number(run.generation ?? 0)) {
    if (cached.fingerprint && cached.fingerprint !== fingerprint) {
      fail('idempotency-conflict', '同一个 idempotencyKey 被用在不同参数上')
    }
    return { ...cached.result, idempotent: true, run: runSheet(run) }
  }
  if (run.currentStep !== stepId) {
    fail('wrong-step', `当前步骤是 ${run.currentStep}，不能提交 ${stepId}`)
  }
  const step = run.steps.find((item) => item.id === stepId)
  if (!step) fail('bad-step', `未知步骤：${stepId}`)

  let result
  if (status === 'failed') {
    markFailed(run, step, 'author-or-model-failed', note ?? '步骤被标记为失败')
    run.state = 'failed'
    result = { ok: false, code: 'step-failed', step: stepId, note }
  } else if (status === 'needs_author') {
    step.state = 'needs_author'
    step.note = note ?? '等待作者'
    run.state = 'awaiting_author'
    run.pendingAuthor = { reason: 'step-needs-author', stepId, note, at: nowIso() }
    result = { ok: true, waiting: true, step: stepId, pendingAuthor: run.pendingAuthor }
  } else if (status === 'skipped') {
    if (!step.optional) fail('cannot-skip', `${stepId} 是必需步骤，不能 skipped`)
    step.state = 'skipped'
    step.endedAt = nowIso()
    step.note = note ?? null
    advance(run)
    result = { ok: true, skipped: true, step: stepId }
  } else if (status === 'done') {
    try {
      if (stepId === 'write') result = await completeWrite(ctx, run, step, { artifact })
      else if (stepId === 'segment') result = await completeSegment(ctx, run, step, { artifact })
      else if (stepId === 'verify') result = await completeVerify(ctx, run, step)
      else if (stepId === 'digest') result = await completeDigest(ctx, run, step, { artifact })
      else if (stepId === 'close') result = await completeClose(ctx, run, step)
      else fail('bad-step', `步骤 ${stepId} 不能由 cue_step 完成`)
    } catch (error) {
      if (error?.name !== 'ConductorError') throw error
      markFailed(run, step, error.code ?? 'step-error', error.message)
      result = { ok: false, code: error.code ?? 'step-error', message: error.message, step: stepId }
    }

    if (result.ok !== false) advance(run)
  } else {
    fail('bad-status', `未知 status：${status}`)
  }

  if (idempotencyKey) {
    run.idempotency = { ...(run.idempotency ?? {}) }
    run.idempotency[idempotencyKey] = {
      at: nowIso(),
      stepId,
      fingerprint,
      generation: Number(run.generation ?? 0),
      result: { ok: result.ok !== false, step: stepId },
    }
    const keys = Object.keys(run.idempotency)
    if (keys.length > 20) delete run.idempotency[keys[0]]
  }
  await writeRun(cwd, run)
  if (TERMINAL_STATES.has(run.state)) clearRun(agentId)
  await appendEvent(cwd, run.runId, { kind: 'step', step: stepId, status, state: run.state, ok: result.ok !== false }, run.bookId ?? null)
  return { ...result, run: runSheet(run) }
}

async function beatReverted(ctx, run) {
  if (!run.requiredCapabilities.includes('beat')) return false
  const status = await beatStatus(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter })
  if (!status) return false
  const committed = run.committedArtifacts.find((artifact) => artifact.kind === 'beat')
  if (!committed) return false
  const last = status.lastSegment?.id ?? null
  return last !== committed.artifactId
}

export async function resumeRun(ctx, { cwd, runId, bookId = null, agentId } = {}) {
  const run = await readRun(cwd, runId, bookId)
  if (run.agentId !== agentId) fail('wrong-agent', '这个 run 不属于当前会话')
  noteRun(agentId, cwd, runId)
  if (TERMINAL_STATES.has(run.state)) fail('run-terminal', `run 已经结束：${run.state}`)

  if (run.state === 'awaiting_author' && run.pendingAuthor?.reason === 'beat-pending') {
    const status = await beatStatus(ctx, { cwd: run.cwd, book: run.book, chapter: run.chapter })
    const stillPending = pendingFromBeat(status)
    if (stillPending) {
      await writeRun(cwd, run)
      return { ok: true, waiting: true, run: runSheet(run) }
    }
    run.pendingAuthor = null
    run.generation = Number(run.generation ?? 0) + 1
    const write = run.steps.find((step) => step.id === 'write')
    if (write && write.state !== 'done') {
      markRunning(write, run.receiptSeq)
      run.currentStep = 'write'
      run.state = 'writing'
    }
    await writeRun(cwd, run)
    await appendEvent(cwd, runId, { kind: 'resume', state: run.state, step: run.currentStep }, run.bookId ?? null)
    return { ok: true, waiting: false, run: runSheet(run) }
  }

  if (run.state === 'awaiting_author') {
    const step = run.steps.find((item) => item.id === run.pendingAuthor?.stepId)
    if (step) {
      markRunning(step, run.receiptSeq)
      run.currentStep = step.id
      run.state = stepStateFor(step.id)
    }
    run.pendingAuthor = null
    run.generation = Number(run.generation ?? 0) + 1
    await writeRun(cwd, run)
    return { ok: true, waiting: false, run: runSheet(run) }
  }

  if (run.state === 'failed') {
    run.generation = Number(run.generation ?? 0) + 1
    const step = run.steps.find((item) => item.id === run.currentStep)
    if (step) {
      markRunning(step, run.receiptSeq)
      run.state = stepStateFor(step.id)
    }
    await writeRun(cwd, run)
    return { ok: true, waiting: false, run: runSheet(run) }
  }

  const reverted = await beatReverted(ctx, run)
  if (reverted) {
    run.generation = Number(run.generation ?? 0) + 1
    const segmentIndex = run.steps.findIndex((step) => step.id === 'segment')
    if (segmentIndex >= 0) {
      for (const step of run.steps.slice(segmentIndex)) {
        step.state = 'pending'
        step.verified = null
        step.receipt = null
        step.note = null
        step.windowStart = 0
        step.startedAt = null
        step.endedAt = null
      }
      run.committedArtifacts = run.committedArtifacts.filter((artifact) => artifact.kind !== 'beat' && artifact.kind !== 'fade')
      const segment = run.steps[segmentIndex]
      markRunning(segment, run.receiptSeq)
      run.currentStep = segment.id
      run.state = 'segmenting'
    }
  }
  await writeRun(cwd, run)
  return { ok: true, waiting: false, reverted, run: runSheet(run) }
}

export async function abortRun(cwd, { runId, bookId = null, agentId, reason } = {}) {
  const run = await readRun(cwd, runId, bookId)
  if (run.agentId !== agentId) fail('wrong-agent', '这个 run 不属于当前会话')
  if (TERMINAL_STATES.has(run.state)) return { ok: true, run: runSheet(run) }
  run.state = 'aborted'
  clearRun(agentId)
  run.abortedReason = reason ?? null
  run.abortedAt = nowIso()
  await writeRun(cwd, run)
  await appendEvent(cwd, runId, { kind: 'abort', reason: reason ?? null }, run.bookId ?? null)
  return { ok: true, run: runSheet(run) }
}

export async function getRunStatus(cwd, { runId, bookId = null, agentId } = {}) {
  if (runId) {
    const run = await readRun(cwd, runId, bookId)
    if (run.agentId !== agentId) fail('wrong-agent', '这个 run 不属于当前会话')
    noteRun(agentId, cwd, runId)
    return run
  }
  const active = await findActiveRun(cwd, agentId, bookId)
  if (active) { noteRun(agentId, cwd, active.runId); return active }
  const latest = await findLatestRun(cwd, agentId, bookId)
  if (!latest) fail('no-run', '还没有任何 run；先 cue_run start')
  noteRun(agentId, cwd, latest.runId)
  return latest
}

export { readReceipts, readRun, writeRun, listRuns, appendReceipt, normalizeReceipt, matchesRun }
