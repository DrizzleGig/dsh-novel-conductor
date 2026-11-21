import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createReadOnlyService } from '../../../../插件/novel-beat-090/lib/service.js'
import { createHost, exec, result, writeFile } from '../helpers.mjs'
import { startRun, stepRun } from '../../lib/run-machine.js'
import { readReceipts } from '../../lib/run-store.js'

const AGENT = 'agent-1'
const BOOK = '服务契约书'
const AT = '2026-11-19T08:00:00.000Z'

async function beatFixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-real-beat-'))
  const segmentText = '段落 1：他推开门，雪落在肩上。'
  const hash = createHash('sha256').update(segmentText).digest('hex')
  const data = {
    schemaVersion: 2,
    revision: 17,
    book: BOOK,
    meta: { title: BOOK, genre: '', logline: '' },
    createdAt: AT,
    updatedAt: AT,
    chapters: { 1: { decisionIds: ['b-1'] } },
    decisions: [{
      id: 'b-1', chapter: 1, title: '是否救人', status: 'committed',
      chosen: { label: '救人' }, segmentId: 's-1', requestId: 'q-1',
      askedAt: AT, answeredAt: AT, createdAt: AT,
    }],
    canon: [
      { entity: '人物', key: '名字', value: '林砚', chapter: 1 },
    ],
    obligations: [],
    audit: [],
    segments: [{
      id: 's-1', chapter: 1, status: 'committed', decisionIds: ['b-1'],
      file: '正文/第1章.md', offsetStart: 0, offsetEnd: segmentText.length,
      chars: segmentText.length, hash, revisionId: 'r-1', createdAt: AT,
    }],
    revisions: [{
      id: 'r-1', kind: 'segment', segmentId: 's-1', chapter: 1, hash, createdAt: AT,
    }],
    requests: [{
      id: 'q-1', decisionId: 'b-1', chapter: 1, askedAt: AT, answeredAt: AT,
      origin: 'author', options: [], answer: { selected: ['救人'], custom: null },
    }],
    tasks: [],
    forks: [],
  }
  const dir = path.join(cwd, '.dsh-novel-beat', BOOK)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'book.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { cwd, hash, segmentText, data }
}

function service() {
  return createReadOnlyService({
    version: '0.9.1',
    gateFromBook: () => ({ chapters: {} }),
  })
}

test('真实 beat 服务：preflight 读到 revision/canon，segment 用 getArtifact 回查', async () => {
  const { cwd, hash, segmentText } = await beatFixture()
  const host = await createHost({ cwd, services: { novelBeat: service() } })
  const started = await startRun(host.ctx, {
    cwd, agentId: AGENT, book: BOOK, chapter: 1, requiredCapabilities: ['beat'],
  })
  assert.equal(started.ok, true)
  assert.equal(started.run.state, 'writing')
  assert.equal(started.run.capabilityMatrix.beat.installed, true)
  assert.equal(started.run.capabilityMatrix.beat.version, '0.9.1')
  assert.equal(started.run.capabilityMatrix.beat.revision, 17)
  assert.match(started.context.markdown, /林砚/)

  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', segmentText)
  const write = await stepRun(host.ctx, {
    cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' },
  })
  assert.equal(write.ok, true)

  await host.emit(
    exec('beat_segment', AGENT, { book: BOOK, chapter: 1 }, 'real-seg'),
    result({ ok: true, segmentId: 's-1', segment: { id: 's-1', hash } }),
  )
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, true)
  assert.equal(segment.receipt.artifactId, 's-1')
  assert.equal(segment.receipt.revision, 17)

  await host.emit(
    exec('beat_verify', AGENT, { book: BOOK, chapter: 1 }, 'real-verify'),
    result({ ok: true, verified: true, pass: true, revision: 17 }),
  )
  const verify = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify' })
  assert.equal(verify.ok, true)

  const close = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'close' })
  assert.equal(close.ok, true)
  assert.equal(close.run.state, 'completed')

  const receipts = await readReceipts(cwd, runId)
  assert.deepEqual(receipts.map((item) => item.tool).sort(), ['beat_segment', 'beat_verify'])
})

test('真实 beat 服务：回退后 resume 重新回到 segment，旧收据仍可回查', async () => {
  const { cwd, hash, segmentText } = await beatFixture()
  const host = await createHost({ cwd, services: { novelBeat: service() } })
  const started = await startRun(host.ctx, {
    cwd, agentId: AGENT, book: BOOK, chapter: 1, requiredCapabilities: ['beat'],
  })
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', segmentText)
  await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'write', artifact: { path: '正文/第1章.md' } })
  await host.emit(exec('beat_segment', AGENT, { book: BOOK, chapter: 1 }, 'seg-15'), result({ segmentId: 's-1', segment: { id: 's-1', hash } }))
  const segment = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'segment', artifact: { artifactId: 's-1' } })
  assert.equal(segment.ok, true)

  // 直接改账本模拟作者在面板回退：段落已经不在当前账本里，但旧收据还在。
  const file = path.join(cwd, '.dsh-novel-beat', BOOK, 'book.json')
  const data = JSON.parse(await fs.readFile(file, 'utf8'))
  data.segments[0].status = 'reverted'
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

  const { resumeRun } = await import('../../lib/run-machine.js')
  const resumed = await resumeRun(host.ctx, { cwd, runId, agentId: AGENT })
  assert.equal(resumed.reverted, true)
  assert.equal(resumed.run.currentStep, 'segment')
})
