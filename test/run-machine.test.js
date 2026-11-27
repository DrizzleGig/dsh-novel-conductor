import test from 'node:test'
import assert from 'node:assert/strict'

import { createHost, exec, fakeBeat, fakeFade, fakeVoice, result, workspace, writeFile } from './helpers.mjs'
import { planSteps, resumeRun, runSheet, startRun, statusView, stepRun } from '../lib/run-machine.js'
import { readRun } from '../lib/run-store.js'
import { enqueueRaw } from '../lib/receipt-bus.js'

const AGENT = 'agent-1'
const BOOK = '书'
const CHAPTER = 1

async function startBeatRun({ pending = [], artifacts = {}, revision = 10 } = {}) {
  const cwd = await workspace()
  const status = { book: BOOK, chapter: CHAPTER, pending, openDecisions: pending.length, chapterState: pending.length ? 'open' : 'writing', revision }
  const beat = fakeBeat({ revision, status, artifacts })
  const host = await createHost({ cwd, services: { novelBeat: beat } })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['beat'] })
  return { cwd, host, beat, status, started }
}

test('runbook：能力决定步骤，solo 不伪造三件套', () => {
  assert.deepEqual(planSteps([]), ['preflight', 'write', 'close'])
  assert.deepEqual(planSteps(['beat']), ['preflight', 'write', 'segment', 'verify', 'close'])
  assert.deepEqual(planSteps(['voice']), ['preflight', 'write', 'verify', 'close'])
  assert.deepEqual(planSteps(['beat', 'fade', 'voice']), ['preflight', 'write', 'segment', 'verify', 'digest', 'close'])
})

test('solo：零插件也能完成 preflight → write → close', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER })
  assert.equal(started.ok, true)
  assert.equal(started.run.state, 'writing')
  assert.deepEqual(started.run.steps.map((step) => step.id), ['preflight', 'write', 'close'])

  await writeFile(cwd, '正文/第1章.md', '他推开门，雪落在肩上。')
  const write = await stepRun(host.ctx, {
    cwd, runId: started.run.runId, agentId: AGENT, stepId: 'write',
    artifact: { path: '正文/第1章.md' },
  })
  assert.equal(write.ok, true)
  assert.equal(write.run.currentStep, 'close')

  const close = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, true)
  assert.equal(close.run.state, 'completed')
})

test('close 回读正文 hash：write 收据后改文件必须拒绝', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER })
  await writeFile(cwd, '正文/第1章.md', '原稿')
  const write = await stepRun(host.ctx, {
    cwd, runId: started.run.runId, agentId: AGENT, stepId: 'write',
    artifact: { path: '正文/第1章.md' },
  })
  assert.equal(write.ok, true)
  await writeFile(cwd, '正文/第1章.md', '原稿被改过')
  const close = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, false)
  assert.equal(close.code, 'artifact-stale')
})

test('assist：beat 有待拍板时停在 await_author，拍板后 resume 才写', async () => {
  const { cwd, host, status, started } = await startBeatRun({
    pending: [{ id: 'b-1', title: '是否救人', status: 'asked' }],
  })
  assert.equal(started.run.state, 'awaiting_author')
  assert.equal(started.run.pendingAuthor.reason, 'beat-pending')

  const still = await resumeRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT })
  assert.equal(still.waiting, true)

  status.pending = []
  status.openDecisions = 0
  const resumed = await resumeRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT })
  assert.equal(resumed.waiting, false)
  assert.equal(resumed.run.currentStep, 'write')
  assert.equal(resumed.run.state, 'writing')
})

test('beat 闭环：write → beat_segment 收据 → getArtifact 回查 → beat_verify → close', async () => {
  const hash = 'a'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId

  await writeFile(cwd, '正文/第1章.md', '他推开门，雪落在肩上。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })

  await host.emit(
    exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'call-seg-1'),
    result({ ok: true, segmentId: 's-1', segment: { id: 's-1', hash } }),
  )
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, true)
  assert.equal(segment.run.steps.find((step) => step.id === 'segment').verified, true)

  await host.emit(
    exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'call-verify-1'),
    result({ ok: true, verified: true, pass: true, revision: 12 }),
  )
  const verify = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(verify.ok, true)

  const close = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, true)
  assert.equal(close.run.state, 'completed')
  assert.ok(close.run.committedArtifacts.some((item) => item.kind === 'beat' && item.artifactId === 's-1'))
})

test('claimed：没有收据的 segment 不能 close', async () => {
  const { cwd, host, started } = await startBeatRun()
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })

  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment' })
  assert.equal(segment.claimed, true)
  assert.equal(segment.run.steps.find((step) => step.id === 'segment').verified, false)

  await host.emit(
    exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'call-verify-2'),
    result({ ok: true, verified: true, pass: true }),
  )
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  const close = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, false)
  assert.equal(close.code, 'claimed-step')
  assert.equal(close.run.currentStep, 'segment')
})

test('beat_verify：ok:true 但 verified:false 不能通过；重试后可以', async () => {
  const hash = 'b'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })

  await host.emit(exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'v1'), result({ ok: true, verified: false, pass: false }))
  const failed = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'verify-failed')
  assert.equal(failed.run.currentStep, 'verify')

  await host.emit(exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'v2'), result({ ok: true, verified: true, pass: true }))
  const retried = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(retried.ok, true)
})

test('revision：旧产物 revision 小于当前账本 revision 仍可核验', async () => {
  const hash = 'c'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    revision: 99,
    artifacts: { 's-old': { found: true, kind: 'segment', revision: 3, revisionId: 'r-3', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg-old'), result({ segmentId: 's-old', segment: { id: 's-old', hash } }))
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-old' } })
  assert.equal(segment.ok, true)
  assert.equal(segment.receipt.revision, 3)
})

test('scope：别的 agent / 别的 book 的收据不能进当前 run', async () => {
  const { cwd, host, started } = await startBeatRun()
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })

  await host.emit(exec('beat_segment', 'other-agent', { book: BOOK, chapter: CHAPTER }, 'x1'), result({ segmentId: 's-x', segment: { id: 's-x' } }))
  await host.emit(exec('beat_segment', AGENT, { book: '另一本书', chapter: CHAPTER }, 'x2'), result({ segmentId: 's-y', segment: { id: 's-y' } }))
  await host.emit(exec('beat_segment', AGENT, { dir: 'D:\\另一个工作区', book: BOOK, chapter: CHAPTER }, 'x3'), result({ segmentId: 's-z', segment: { id: 's-z' } }))
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment' })
  assert.equal(segment.claimed, true)
})

test('run-active：同一 agent 同一时间只允许一个活动 run', async () => {
  const { cwd, host, started } = await startBeatRun()
  const second = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: 2, requiredCapabilities: ['beat'] })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'run-active')
  assert.equal(second.run.runId, started.run.runId)
})

test('缺能力：必需 beat 不存在时 preflight blocked，而不是 solo', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['beat'] })
  assert.equal(started.ok, true)
  assert.equal(started.blocked, true)
  assert.equal(started.run.state, 'blocked')
  assert.equal(started.run.capabilityMatrix.beat.installed, false)
})

test('voice：pass:false 是内容结果，不是工具执行失败', async () => {
  const cwd = await workspace()
  const voice = fakeVoice({})
  const host = await createHost({ cwd, services: { novelVoice: voice } })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['voice'] })
  assert.equal(started.run.state, 'writing')
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '短句。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('voice_check', AGENT, { book: BOOK, chapter: CHAPTER }, 'vc1'), result({ status: 'completed', pass: false, findings: [{ detector: 'x' }] }))
  const verify = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(verify.ok, false)
  assert.equal(verify.code, 'verify-failed')
  assert.match(verify.checks[0].reason, /block/)
})

test('fade：memo_digest 收据 + revision 回读后 digest 才能完成', async () => {
  const cwd = await workspace()
  const fade = fakeFade({ revision: 21, artifacts: { 'd-1': { found: true, artifactId: 'd-1', revision: 21, hash: 'h1' } } })
  const host = await createHost({ cwd, services: { novelFade: fade } })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['fade'] })
  assert.equal(started.run.state, 'writing')
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('memo_digest', AGENT, { book: BOOK, chapter: CHAPTER }, 'd1'), result({ ok: true, receipt: { artifactId: 'd-1', revision: 21, hash: 'h1' }, cards: [{}, {}] }))
  const digest = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'digest', artifact: { artifactId: 'd-1' } })
  assert.equal(digest.ok, true)
  assert.equal(digest.run.currentStep, 'close')
})

test('revert/resume：beat 回退后 resume 回到 segment，不重复提交', async () => {
  const hash = 'd'.repeat(64)
  const { cwd, host, beat, status, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal((await readRun(cwd, runId)).currentStep, 'verify')

  status.lastSegment = null
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.reverted, true)
  assert.equal(resumed.run.currentStep, 'segment')
  assert.equal(resumed.run.steps.find((step) => step.id === 'verify').state, 'pending')
})

test('status：sheet / steps / budget / capabilities 四种视图', async () => {
  const { cwd, host, started } = await startBeatRun()
  const run = await readRun(cwd, started.run.runId)
  assert.equal(statusView(run, 'sheet').runId, run.runId)
  assert.equal(statusView(run, 'steps').steps.length, run.steps.length)
  assert.ok(statusView(run, 'budget').budget)
  assert.ok(statusView(run, 'capabilities').capabilityMatrix.beat)
})


test('segment：提交的 artifactId / hash 与收据不一致时拒绝', async () => {
  const hash = 'f'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))

  const wrongId = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-2' } })
  assert.equal(wrongId.ok, false)
  assert.equal(wrongId.code, 'artifact-mismatch')

  const wrongHash = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1', hash: '0'.repeat(64) } })
  assert.equal(wrongHash.ok, false)
  assert.equal(wrongHash.code, 'hash-mismatch')
})

test('beat_verify：verified 与 pass 互相矛盾时不能通过', async () => {
  const hash = '1'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })

  await host.emit(exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'v-bad'), result({ ok: true, verified: true, pass: false }))
  const verify = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(verify.ok, false)
  assert.equal(verify.code, 'verify-failed')
})

test('digest：receipt 里只留卡片数，不复制卡片正文', async () => {
  const cwd = await workspace()
  const fade = fakeFade({ revision: 21, artifacts: { 'd-1': { found: true, artifactId: 'd-1', revision: 21, hash: 'h1' } } })
  const host = await createHost({ cwd, services: { novelFade: fade } })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['fade'] })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('memo_digest', AGENT, { book: BOOK, chapter: CHAPTER }, 'd1'), result({
    ok: true,
    receipt: { artifactId: 'd-1', revision: 21, hash: 'h1' },
    cards: [{ gist: '一段正文', quote: '很长的原文'.repeat(50) }, { gist: '第二张' }],
  }))
  const digest = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'digest', artifact: { artifactId: 'd-1' } })
  assert.equal(digest.ok, true)
  const saved = await readRun(cwd, runId)
  assert.equal(saved.steps.find((step) => step.id === 'digest').receipt.cards, 2)
})


test('write：文件不存在时失败；resume 回到 write 可重试', async () => {
  const { cwd, host, started } = await startBeatRun()
  const runId = started.run.runId
  const failed = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/没有.md' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'write-missing')
  assert.equal(failed.run.currentStep, 'write')

  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  const { resumeRun } = await import('../lib/run-machine.js')
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.run.currentStep, 'write')
  const write = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  assert.equal(write.ok, true)
})

test('step：必需步骤不能 skipped；已完成的步骤不能重复提交', async () => {
  const { cwd, host, started } = await startBeatRun()
  const runId = started.run.runId
  await assert.rejects(
    () => stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', status: 'skipped' }),
    /不能 skipped/,
  )

  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await assert.rejects(
    () => stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } }),
    /当前步骤是/,
  )
})

test('resume：awaiting_author 的 step-needs-author 也回到原步骤', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER })
  const runId = started.run.runId
  const waiting = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', status: 'needs_author', note: '等作者给标题' })
  assert.equal(waiting.waiting, true)
  const { resumeRun } = await import('../lib/run-machine.js')
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.waiting, false)
  assert.equal(resumed.run.currentStep, 'write')
})


test('cwd：工具传显式 cwd 时，收据总线按 run 的 cwd 找活动 run', async () => {
  const sessionCwd = await workspace()
  const runCwd = await workspace()
  const hash = '2'.repeat(64)
  const beat = fakeBeat({ artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } } })
  const host = await createHost({ cwd: sessionCwd, services: { novelBeat: beat } })
  const started = await startRun(host.ctx, { cwd: runCwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['beat'] })
  const runId = started.run.runId
  await writeFile(runCwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd: runCwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg-cwd'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  const segment = await stepRun(host.ctx, { cwd: runCwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, true)
  assert.equal(segment.run.steps.find((step) => step.id === 'segment').verified, true)
})

test('窗口：回退后 verify 不能拿回退前的旧 beat_verify 收据', async () => {
  const hash = '3'.repeat(64)
  const { cwd, host, status, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg-1'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })

  // verify 步骤窗口内先来一条成功收据，但作者回退了。
  await host.emit(exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'old-verify'), result({ verified: true, pass: true }))
  status.lastSegment = null
  const { resumeRun } = await import('../lib/run-machine.js')
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.reverted, true)

  // 新的 segment 收据；verify 步骤窗口里没有新的 beat_verify。
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg-2'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  const verify = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(verify.ok, false)
  assert.equal(verify.code, 'missing-receipt')
})


test('close：beat 在 verify 后回退，close 必须拒绝并退回 segment', async () => {
  const hash = '4'.repeat(64)
  const { cwd, host, status, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: CHAPTER }, 'seg'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  await host.emit(exec('beat_verify', AGENT, { book: BOOK, chapter: CHAPTER }, 'verify'), result({ verified: true, pass: true }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })

  status.lastSegment = null
  const close = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, false)
  assert.equal(close.code, 'beat-reverted')
  assert.equal(close.run.currentStep, 'segment')
})

test('digest：memo_digest 预览（没有 receipt）不能当成已写账本', async () => {
  const cwd = await workspace()
  const fade = fakeFade({ revision: 21 })
  const host = await createHost({ cwd, services: { novelFade: fade } })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER, requiredCapabilities: ['fade'] })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('memo_digest', AGENT, { book: BOOK, chapter: CHAPTER }, 'preview'), result({ ok: true, stage: 'extract', stats: { paragraphs: 3 } }))
  const digest = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'digest', artifact: { artifactId: 'd-1' } })
  assert.equal(digest.ok, false)
  assert.equal(digest.code, 'digest-not-committed')
  assert.equal(digest.run.currentStep, 'digest')
})


test('race：宿主事件先入队、cue_step 后提交也能读到收据', async () => {
  const hash = '5'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })

  // 模拟监听器只完成了同步入队、还没落盘；stepRun 必须先 drain 再读收据。
  enqueueRaw(
    exec('beat_segment', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'race-seg'),
    result({ segmentId: 's-1', segment: { id: 's-1', hash } }),
  )
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, true)
  assert.equal(segment.run.steps.find((step) => step.id === 'segment').verified, true)
})

test('awaiting_author：暂停时直接 cue_step(done) 被拒绝', async () => {
  const { cwd, host, started } = await startBeatRun({
    pending: [{ id: 'b-1', title: '是否救人', status: 'asked' }],
  })
  await assert.rejects(
    () => stepRun(host.ctx, {
      cwd, runId: started.run.runId, agentId: AGENT, stepId: 'write',
      artifact: { path: '正文/第1章.md' },
    }),
    /等待作者/,
  )
})

test('failed：显式 failed 后可以 resume 重试', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, { cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER })
  const runId = started.run.runId
  const failed = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', status: 'failed', note: '换文件' })
  assert.equal(failed.run.state, 'failed')
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.waiting, false)
  assert.equal(resumed.run.currentStep, 'write')
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  const write = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  assert.equal(write.ok, true)
})

test('idempotency：回退后同一 key 不返回旧成功', async () => {
  const hash1 = '6'.repeat(64)
  const hash2 = '7'.repeat(64)
  const { cwd, host, status, started } = await startBeatRun({
    artifacts: {
      's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash: hash1 },
      's-2': { found: true, kind: 'segment', revision: 12, revisionId: 'r-2', hash: hash2 },
    },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'seg-1'), result({ segmentId: 's-1', segment: { id: 's-1', hash: hash1 } }))
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' }, idempotencyKey: 'seg-key' })

  status.lastSegment = null
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.reverted, true)
  await host.emit(exec('beat_segment', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'seg-2'), result({ segmentId: 's-2', segment: { id: 's-2', hash: hash2 } }))
  const again = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-2' }, idempotencyKey: 'seg-key' })
  assert.equal(again.ok, true)
  const saved = await readRun(cwd, runId)
  assert.equal(saved.steps.find((step) => step.id === 'segment').receipt.artifactId, 's-2')
})

test('artifact：getArtifact 返回 reverted 时拒绝', async () => {
  const hash = '8'.repeat(64)
  const { cwd, host, started } = await startBeatRun({
    artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash, segment: { status: 'reverted' } } },
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'seg-rev'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, false)
  assert.equal(segment.code, 'artifact-reverted')
})
