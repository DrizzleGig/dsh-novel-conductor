import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { callTool, isManagedTool, isKitNamespace, listTools, policyFor } from '../lib/gateway.js'
import { isWriteTool } from '../lib/effects.js'
import { initBook } from '../lib/scope.js'
import { readReceipts } from '../lib/run-store.js'

async function workspace(prefix = 'conductor-gateway-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function fakeCtx(calls) {
  return {
    tools: {
      schemas: () => [
        {
          name: 'beat_segment',
          description: 'register a segment',
          parameters: { type: 'object', properties: { book: { type: 'string' }, chapter: { type: 'number' }, text: { type: 'string' } } },
        },
        {
          name: 'third_party_writer',
          description: 'third party writer',
          parameters: { type: 'object', properties: { book: { type: 'string' }, text: { type: 'string' }, file_path: { type: 'string' } } },
        },
        {
          name: 'mcp__notes__search',
          description: 'search notes',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      execute: async (input) => {
        calls.push(input)
        return {
          results: [{
            callId: input.calls[0].id,
            result: { isError: false, value: { ok: true, tool: input.calls[0].name }, content: [{ type: 'text', text: 'done' }] },
          }],
          additionalContexts: [],
          concluded: false,
        }
      },
    },
  }
}

function runFor(cwd, bookId) {
  return { runId: 'run-20261126-gateway', bookId, cwd, book: '书', generation: 1 }
}

test('gateway：六包工具按 builtin 策略调用，并注入 book', async () => {
  const cwd = await workspace()
  const book = await initBook(cwd, { book: '书' })
  const calls = []
  const ctx = fakeCtx(calls)
  const binding = { workspace: cwd, bookId: book.bookId, book: '书' }
  const result = await callTool({
    ctx, agent: { id: 'a1' }, toolSet: null, signal: new AbortController().signal,
    binding, run: runFor(cwd, book.bookId), tool: 'beat_segment', args: { chapter: 1, text: '一段' },
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].calls[0].arguments)
  assert.equal(sent.book, '书')
  assert.equal(sent.chapter, 1)
  const receipts = await readReceipts(cwd, result.receipt.runId, book.bookId)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].kind, 'gateway')
  assert.equal(receipts[0].bound, true)
})

test('gateway：未声明状态的第三方工具默认拒绝；MCP 以 external 放行', async () => {
  const cwd = await workspace()
  const book = await initBook(cwd, { book: '书' })
  const calls = []
  const ctx = fakeCtx(calls)
  const binding = { workspace: cwd, bookId: book.bookId, book: '书' }
  await assert.rejects(
    () => callTool({ ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'third_party_writer', args: { text: 'x' } }),
    /没有声明 effects|未声明状态位置/,
  )
  assert.equal(calls.length, 0)
  const ok = await callTool({
    ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'mcp__notes__search', args: { query: 'x' },
    policies: {
      'mcp__notes__search': { effects: ['external'], stateScope: 'unknown', retry: 'never', bindings: [], allowedRoots: [] },
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.receipt.stateScope, 'unknown')
  assert.deepEqual(ok.receipt.effects, ['external'])
})

test('gateway：跨书参数被拒绝，保留工具名被拒绝', async () => {
  const cwd = await workspace()
  const book = await initBook(cwd, { book: '书' })
  const ctx = fakeCtx([])
  const binding = { workspace: cwd, bookId: book.bookId, book: '书' }
  await assert.rejects(
    () => callTool({ ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'beat_segment', args: { book: '另一本' } }),
    /book 与当前绑定不一致/,
  )
  await assert.rejects(
    () => callTool({ ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'cue_run', args: {} }),
    /保留工具/,
  )
})

test('gateway：未配置 MCP 默认拒绝；allowedRoots 生效；写工具分类覆盖 write/voice_import', async () => {
  const cwd = await workspace()
  const book = await initBook(cwd, { book: '书' })
  const ctx = fakeCtx([])
  const binding = { workspace: cwd, bookId: book.bookId, book: '书' }
  await assert.rejects(
    () => callTool({ ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'mcp__notes__search', args: { query: 'x' } }),
    /未声明状态位置/,
  )
  const policies = {
    third_party_writer: { effects: ['write'], stateScope: 'book', bindings: [], allowedRoots: ['正文'], retry: 'never' },
  }
  await assert.rejects(
    () => callTool({
      ctx, agent: { id: 'a1' }, binding, run: runFor(cwd, book.bookId), tool: 'third_party_writer',
      args: { text: 'x', file_path: '../别处.md' }, policies,
    }),
    /不在 ProviderPolicy|path-not-allowed/,
  )
  assert.equal(isWriteTool('write'), true)
  assert.equal(isWriteTool('voice_import'), true)
  assert.equal(isWriteTool('voice_profile'), true)
  assert.equal(isWriteTool('memo_brief'), false)
})

test('gateway：listTools 过滤并标记策略', async () => {
  const list = await listTools({ ctx: fakeCtx([]), agent: { id: 'a1' }, policies: {} })
  assert.deepEqual(list.map((row) => row.name).sort(), ['beat_segment', 'mcp__notes__search', 'third_party_writer'])
  assert.equal(list.find((row) => row.name === 'beat_segment').stateScope, 'book')
  assert.equal(policyFor('beat_segment').effects.includes('write'), true)
  assert.equal(isManagedTool('beat_segment'), true)
  assert.equal(isManagedTool('mcp__x__y'), false)
  // kit 是独立产品：conductor 的总控开关/scope 守卫不得接管 novel_*。
  assert.equal(isManagedTool('novel_query'), false)
  assert.equal(isManagedTool('novel_chapter_start'), false)
  assert.equal(isManagedTool('kit_status'), false)
  assert.equal(isManagedTool('fic_state'), true)
  assert.equal(isKitNamespace('novel_query'), true)
  assert.equal(isKitNamespace('kit_status'), true)
  assert.equal(isKitNamespace('fic_state'), false)
})

test('gateway：即使 ProviderPolicy 允许，也不路由 kit 的 novel_*/kit_*', async () => {
  await assert.rejects(
    () => callTool({
      ctx: fakeCtx([]), agent: { id: 'a1' }, tool: 'novel_query',
      args: {}, policies: { novel_query: { effects: ['read'], stateScope: 'global', source: 'explicit' } },
    }),
    /kit 工具不归 conductor 管辖/,
  )
})
