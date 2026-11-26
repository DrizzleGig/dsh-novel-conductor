import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createHost, workspace } from './helpers.mjs'
import { startRun } from '../lib/run-machine.js'
import { readRun, listRuns, runFile } from '../lib/run-store.js'
import { initBook } from '../lib/scope.js'

test('run 存储：bookId 落到 books/<bookId>/runs，且不串到另一本书', async () => {
  const cwd = await workspace()
  const a = await initBook(cwd, { book: '书A' })
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, {
    cwd, agentId: 'agent-1', bookId: a.bookId, book: '书A', chapter: 1,
  })
  assert.equal(started.ok, true)
  assert.equal(started.run.bookId, a.bookId)

  const file = runFile(cwd, started.run.runId, a.bookId)
  assert.equal((await fs.stat(file)).isFile(), true)
  await assert.rejects(() => fs.stat(runFile(cwd, started.run.runId)), /ENOENT/)

  const read = await readRun(cwd, started.run.runId, a.bookId)
  assert.equal(read.bookId, a.bookId)
  const found = await readRun(cwd, started.run.runId)
  assert.equal(found.bookId, a.bookId)

  const own = await listRuns(cwd, a.bookId)
  assert.equal(own.length, 1)
  const other = await listRuns(cwd, 'bk-22222222-2222-2222-2222-222222222222')
  assert.equal(other.length, 0)
})

test('run 存储：bookId 不匹配时 readRun 拒绝', async () => {
  const cwd = await workspace()
  const a = await initBook(cwd, { book: '书A' })
  const host = await createHost({ cwd })
  const started = await startRun(host.ctx, {
    cwd, agentId: 'agent-1', bookId: a.bookId, book: '书A', chapter: 1,
  })
  await assert.rejects(
    () => readRun(cwd, started.run.runId, 'bk-22222222-2222-2222-2222-222222222222'),
    /不属于/,
  )
})
