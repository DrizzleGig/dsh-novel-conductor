// 模拟验收：用确定性的假服务 + 合成 tools/result 走完 conductor 的完整 runbook。
// 它不是宿主验收；它证明状态机、收据、回查和 close gate 在一条真实形状的链路里能走通。

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost, exec, fakeBeat, fakeFade, fakeVoice, result, writeFile } from '../test/helpers.mjs'
import { resumeRun, startRun, stepRun } from '../lib/run-machine.js'
import { readReceipts, readRun } from '../lib/run-store.js'

const BOOK = '模拟验收书'
const CHAPTER = 13
const AGENT = 'acceptance-simulator'
const HASH = 'ab'.repeat(32)

const root = path.dirname(fileURLToPath(import.meta.url))
const reportFile = path.join(root, '..', 'docs', 'acceptance-simulated-2026-11-21.md')
const cwd = await fs.mkdtemp(path.join(process.env.TEMP ?? '.', 'conductor-acceptance-'))

const status = {
  book: BOOK, chapter: CHAPTER, pending: [{ id: 'b-1', title: '是否救下旧友', status: 'asked' }],
  openDecisions: 1, chapterState: 'open', revision: 10,
}
const beat = fakeBeat({
  revision: 10,
  status,
  artifacts: { 's-101': { found: true, kind: 'segment', revision: 11, revisionId: 'r-11', hash: HASH, segment: { status: 'committed' } } },
})
const fade = fakeFade({ revision: 21, status: { book: BOOK, chapters: 13, cards: 2, revision: 21 }, artifacts: { 'digest:ch13:v1': { found: true, artifactId: 'digest:ch13:v1', revision: 21, hash: 'sha256:feed' } } })
const voice = fakeVoice({ revision: 30 })
const host = await createHost({ cwd, services: { novelBeat: beat, novelFade: fade, novelVoice: voice } })

const started = await startRun(host.ctx, {
  cwd, agentId: AGENT, book: BOOK, chapter: CHAPTER,
  requiredCapabilities: ['beat', 'fade', 'voice'],
})
if (started.run.state !== 'awaiting_author') throw new Error(`expected awaiting_author, got ${started.run.state}`)

// 作者在 beat 里拍板
status.pending = []
status.openDecisions = 0
status.chapterState = 'writing'
const resumed = await resumeRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT })
if (resumed.waiting) throw new Error('author is still pending')

// write
await writeFile(cwd, '正文/第13章.md', '他推开门，雪落在肩上。旧友站在灯下，没有说话。')
const write = await stepRun(host.ctx, {
  cwd, runId: started.run.runId, agentId: AGENT, stepId: 'write',
  artifact: { path: '正文/第13章.md' },
})
if (!write.ok) throw new Error(`write failed: ${write.code}`)

// segment
await host.emit(
  exec('beat_segment', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'acc-seg'),
  result({ ok: true, segmentId: 's-101', segment: { id: 's-101', hash: HASH } }),
)
status.lastSegment = { id: 's-101' }
const segment = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-101' } })
if (!segment.ok) throw new Error(`segment failed: ${segment.code}`)

// verify
await host.emit(
  exec('beat_verify', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'acc-verify'),
  result({ ok: true, verified: true, pass: true, revision: 12 }),
)
await host.emit(
  exec('voice_check', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'acc-voice'),
  result({ status: 'completed', pass: true, revision: 30, findings: [] }),
)
const verify = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'verify' })
if (!verify.ok) throw new Error(`verify failed: ${verify.code}`)

// digest
await host.emit(
  exec('memo_digest', AGENT, { dir: cwd, book: BOOK, chapter: CHAPTER }, 'acc-digest'),
  result({
    ok: true,
    receipt: { kind: 'digest', artifactId: 'digest:ch13:v1', revision: 21, hash: 'sha256:feed' },
    cards: [{ gist: '旧友重逢' }, { gist: '雪夜' }],
  }),
)
const digest = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'digest', artifact: { artifactId: 'digest:ch13:v1' } })
if (!digest.ok) throw new Error(`digest failed: ${digest.code}`)

// close
const close = await stepRun(host.ctx, { cwd, runId: started.run.runId, agentId: AGENT, stepId: 'close' })
if (!close.ok) throw new Error(`close failed: ${close.code}`)

const run = await readRun(cwd, started.run.runId)
const receipts = await readReceipts(cwd, started.run.runId)
const stepRows = run.steps.map((step) => `| ${step.id} | ${step.state} | ${step.verified === true ? 'verified' : step.verified === false ? 'claimed' : '—'} | ${step.receipt?.artifactId ?? step.receipt?.path ?? '—'} |`)
const receiptRows = receipts.map((receipt) => `| ${receipt.seq} | ${receipt.tool} | ${receipt.agentId} | ${receipt.book ?? '—'} | ${receipt.isError ? 'error' : 'ok'} |`)

const markdown = `# conductor 0.1.0 · 模拟验收（2026-11-21）

> 口径：**模拟验收**，不是真实 DSH 宿主验收。使用确定性假服务 + 合成 \`tools/result\`，走完
> \`preflight → await_author → write → segment → verify → digest → close\`；证明状态机、收据归属、
> 服务回查、close gate 在一条真实形状的链路上成立。

## 场景

- 书：${BOOK} ／ 第 ${CHAPTER} 章
- 必需能力：beat / fade / voice
- 起始 beat revision：10；fade revision：21；voice revision：30
- 作者拍板：一条 pending 决策，resume 前清除

## 结果

- run：\`${run.runId}\`，最终状态 **${run.state}**
- 步骤：${run.steps.length} / ${run.steps.length} 完成
- 收据：${receipts.length} 条
- 已核验产物：${run.committedArtifacts.length} 个
- 结论：**PASS（模拟）**

### 步骤

| 步骤 | 状态 | 证据 | 产物 |
|---|---|---|---|
${stepRows.join('\n')}

### 收据

| seq | 工具 | agent | book | 结果 |
|---|---|---|---|---|
${receiptRows.join('\n')}

### 产物引用

\`\`\`json
${JSON.stringify(run.committedArtifacts, null, 2)}
\`\`\`

## 边界

- 没有启动真实 DSH 宿主；宿主事件是合成的，但经过与宿主相同的 \`{ exec, result }\` 形状。
- 没有真实 beat/fade/voice 账本；服务是确定性的假实现，返回真实服务的字段形状。
- 因此这份报告只能说明“模拟链路通过”，不能替代真实一章验收。
`

await fs.mkdir(path.dirname(reportFile), { recursive: true })
await fs.writeFile(reportFile, markdown, 'utf8')
console.log(`PASS simulated acceptance: ${run.state}, ${receipts.length} receipts, ${run.committedArtifacts.length} artifacts`)
console.log(`report: ${reportFile}`)
