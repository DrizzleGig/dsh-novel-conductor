import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  appendReceipt,
  assertRunId,
  createRun,
  createRunId,
  findActiveRun,
  listRuns,
  normalizeCwd,
  readJson,
  readReceipts,
  readRun,
  runFile,
  writeRun,
} from '../lib/run-store.js'
import { workspace } from './helpers.mjs'

function sampleRun(cwd) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    runId: createRunId(),
    agentId: 'a1',
    cwd,
    book: '书',
    chapter: 1,
    taskType: 'chapter_write',
    requiredCapabilities: [],
    steps: [],
    state: 'writing',
    currentStep: 'write',
    committedArtifacts: [],
    receiptSeq: 0,
    createdAt: now,
    updatedAt: now,
  }
}

test('cwd：必须是绝对路径，不能是相对路径', () => {
  assert.equal(normalizeCwd('D:\\Novel-gate'), path.resolve('D:\\Novel-gate'))
  assert.throws(() => normalizeCwd('relative/path'), /绝对路径/)
  assert.throws(() => normalizeCwd(''), /绝对路径/)
})

test('runId：拒绝路径穿越与非法字符', () => {
  assert.equal(assertRunId('run-20261121-abc'), 'run-20261121-abc')
  assert.throws(() => assertRunId('../evil'), /不合法/)
  assert.throws(() => assertRunId('run/evil'), /不合法/)
})

test('run：create → read → write 原子落盘，不留下 tmp', async () => {
  const cwd = await workspace()
  const run = sampleRun(cwd)
  await createRun(cwd, run)
  const loaded = await readRun(cwd, run.runId)
  assert.equal(loaded.runId, run.runId)

  loaded.state = 'completed'
  await writeRun(cwd, loaded)
  const again = await readRun(cwd, run.runId)
  assert.equal(again.state, 'completed')

  const file = runFile(cwd, run.runId)
  const dir = path.dirname(file)
  const names = await fs.readdir(dir)
  assert.ok(names.includes('run.json'))
  assert.equal(names.some((name) => name.includes('.tmp-')), false)
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), { fallback: true }), { fallback: true })
})

test('run：listRuns 按 updatedAt 倒序，findActiveRun 跳过终态', async () => {
  const cwd = await workspace()
  const first = sampleRun(cwd)
  first.state = 'completed'
  first.updatedAt = '2026-11-21T00:00:00.000Z'
  const second = sampleRun(cwd)
  second.updatedAt = '2026-11-21T01:00:00.000Z'
  await createRun(cwd, first)
  await createRun(cwd, second)

  const runs = await listRuns(cwd)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].runId, second.runId)
  const active = await findActiveRun(cwd, 'a1')
  assert.equal(active.runId, second.runId)
})

test('receipts：append 后按 seq 排序，坏行被跳过', async () => {
  const cwd = await workspace()
  const run = sampleRun(cwd)
  await createRun(cwd, run)
  await appendReceipt(cwd, run.runId, { seq: 2, id: 'b', tool: 'beat_verify' })
  await appendReceipt(cwd, run.runId, { seq: 1, id: 'a', tool: 'beat_segment' })
  const file = path.join(path.dirname(runFile(cwd, run.runId)), 'receipts.jsonl')
  await fs.appendFile(file, '{"broken":\n', 'utf8')
  const receipts = await readReceipts(cwd, run.runId)
  assert.deepEqual(receipts.map((item) => item.id), ['a', 'b'])
})
