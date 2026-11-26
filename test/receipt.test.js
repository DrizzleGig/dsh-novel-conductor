import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compactValue,
  dedupeReceipts,
  findReceipts,
  isSuccess,
  matchesRun,
  matchesStep,
  normalizeReceipt,
} from '../lib/receipt.js'

const exec = {
  name: 'beat_segment',
  agent: { id: 'a1' },
  arguments: { book: '书', chapter: 1 },
  callId: 'call-1',
}
const result = { isError: false, value: { ok: true, segmentId: 's-1', segment: { id: 's-1', hash: 'h1' }, text: '不该被抄进收据' } }

test('receipt：从 (exec,result) 取值，callId 作为 id，正文被丢弃', () => {
  const receipt = normalizeReceipt(exec, result, { seq: 3 })
  assert.equal(receipt.seq, 3)
  assert.equal(receipt.id, 'call-1')
  assert.equal(receipt.tool, 'beat_segment')
  assert.equal(receipt.agentId, 'a1')
  assert.equal(receipt.book, '书')
  assert.equal(receipt.chapter, 1)
  assert.equal(receipt.value.segmentId, 's-1')
  assert.equal(receipt.value.text, undefined)
})

test('receipt：isError 不生成成功收据', () => {
  const receipt = normalizeReceipt(exec, { isError: true, value: { ok: false, message: 'x' } }, { seq: 1 })
  assert.equal(isSuccess(receipt), false)
})

test('receipt：没有 callId 时生成稳定 id', () => {
  const a = normalizeReceipt({ ...exec, callId: undefined }, result, { seq: 1 })
  const b = normalizeReceipt({ ...exec, callId: undefined }, result, { seq: 2 })
  assert.equal(a.id, b.id)
  assert.match(a.id, /^auto-/)
})

test('receipt：只匹配本步骤窗口与预期工具', () => {
  const step = { id: 'segment', windowStart: 2 }
  const receipt = normalizeReceipt(exec, result, { seq: 3 })
  assert.equal(matchesStep(receipt, step), true)
  assert.equal(matchesStep({ ...receipt, seq: 2 }, step), false)
  assert.equal(matchesStep({ ...receipt, tool: 'beat_verify' }, step), false)
})

test('receipt：scope 绑定 agent / book / chapter', () => {
  const run = { agentId: 'a1', book: '书', chapter: 1 }
  const step = { id: 'segment', windowStart: 0 }
  const receipt = normalizeReceipt(exec, result, { seq: 1 })
  assert.equal(matchesRun(run, step, receipt), true)
  assert.equal(matchesRun({ ...run, agentId: 'a2' }, step, receipt), false)
  assert.equal(matchesRun({ ...run, book: '另一本' }, step, receipt), false)
  assert.equal(matchesRun({ ...run, chapter: 2 }, step, receipt), false)
})

test('receipt：findReceipts 只留窗口内且工具匹配的收据', () => {
  const step = { id: 'verify', windowStart: 4 }
  const receipts = [
    normalizeReceipt({ ...exec, name: 'beat_verify' }, result, { seq: 4 }),
    normalizeReceipt({ ...exec, name: 'beat_verify' }, result, { seq: 5 }),
    normalizeReceipt({ ...exec, name: 'voice_check' }, result, { seq: 6 }),
    normalizeReceipt({ ...exec, name: 'beat_segment' }, result, { seq: 7 }),
  ]
  assert.deepEqual(findReceipts(receipts, step, ['beat_verify']).map((item) => item.seq), [5])
})

test('receipt：fanfic 收据缺 project 或跨项目不通过', () => {
  const run = {
    agentId: 'a1', book: '书', chapter: 1, cwd: 'D:\\book',
    requiredCapabilities: ['fanfic'], fanficProject: 'p1',
  }
  const step = { id: 'verify', windowStart: 0 }
  const missing = normalizeReceipt({
    name: 'fic_check', agent: { id: 'a1' }, arguments: { chapter: 1, source: 'canon' },
  }, result, { seq: 2 })
  assert.equal(matchesRun(run, step, missing), false)
  const other = normalizeReceipt({
    name: 'fic_check', agent: { id: 'a1' }, arguments: { project: 'p2', chapter: 1, source: 'canon' },
  }, result, { seq: 3 })
  assert.equal(matchesRun(run, step, other), false)
  const ok = normalizeReceipt({
    name: 'fic_check', agent: { id: 'a1' }, arguments: { project: 'p1', chapter: 1, source: 'canon' },
  }, result, { seq: 4 })
  assert.equal(matchesRun(run, step, ok), true)
})

test('receipt：dedupe 按 id 只留第一次', () => {
  const a = { id: 'x', seq: 1 }
  const b = { id: 'x', seq: 2 }
  const c = { id: 'y', seq: 3 }
  assert.deepEqual(dedupeReceipts([a, b, c]).map((item) => item.seq), [1, 3])
})

test('compactValue：限制深度、数组与长字符串', () => {
  const compact = compactValue({ body: '正文', list: Array.from({ length: 25 }, (_, index) => index), deep: { a: { b: { c: { d: 1 } } } }, text: 'x'.repeat(1000) })
  assert.equal(compact.body, undefined)
  assert.equal(compact.bodyOmitted, true)
  assert.equal(compact.text, undefined)
  assert.equal(compact.textOmitted, true)
  assert.equal(compact.list.length, 21)
  assert.equal(compact.list.at(-1), '[+5 more]')
  assert.equal(compact.deep.a.b, '[depth]')
})
