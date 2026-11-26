import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  addBook,
  assertPathInside,
  bindBook,
  checkBookArgs,
  initBook,
  isPathInside,
  readBookIdentity,
} from '../lib/scope.js'

async function workspace(prefix = 'conductor-scope-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

test('scope：init → 单书身份稳定，bookId 不随书名变', async () => {
  const cwd = await workspace()
  const first = await initBook(cwd, { book: '斗罗', title: '斗罗大陆' })
  assert.match(first.bookId, /^bk-/)
  assert.equal(first.book, '斗罗')
  const again = await readBookIdentity(cwd)
  assert.equal(again.kind, 'single')
  assert.equal(again.bookId, first.bookId)
})

test('scope：单书迁移多书后 bind 各自 bookId，不猜第一本', async () => {
  const cwd = await workspace()
  const a = await initBook(cwd, { book: '书A' })
  const multi = await addBook(cwd, { book: '书B' })
  assert.equal(multi.kind, 'multi')
  assert.equal(multi.books.length, 2)
  const identity = await readBookIdentity(cwd)
  assert.equal(identity.kind, 'multi')
  const bindingA = await bindBook(cwd, '书A')
  const bindingB = await bindBook(cwd, '书B')
  assert.equal(bindingA.bookId, a.bookId)
  assert.notEqual(bindingA.bookId, bindingB.bookId)
  await assert.rejects(() => bindBook(cwd, '书C'), /books\.json 里没有/)
})

test('scope：单书工作区不能 bind 另一本书', async () => {
  const cwd = await workspace()
  await initBook(cwd, { book: '书A' })
  await assert.rejects(() => bindBook(cwd, '书B'), /不能绑定/)
})

test('scope：路径围栏拒绝 ../ 与绝对越界，允许书内不存在的新文件', async () => {
  const cwd = await workspace()
  const inside = path.join(cwd, '正文', '第1章.md')
  await assertPathInside(cwd, inside)
  assert.equal(isPathInside(cwd, inside), true)
  await assert.rejects(() => assertPathInside(cwd, path.join(cwd, '..', '别处.md')), /越出当前书工作区/)
  assert.equal(isPathInside(cwd, path.join(cwd, '..', '别处.md')), false)
})

test('scope：跨书参数按 book/bookId/dir 拒绝', async () => {
  const binding = { workspace: path.resolve('D:/Novels/a'), bookId: 'bk-a', book: '书A' }
  assert.equal(checkBookArgs({ book: '书A' }, binding), null)
  assert.equal(checkBookArgs({ book: '书B' }, binding)?.code, 'cross-book-argument')
  assert.equal(checkBookArgs({ bookId: 'bk-b' }, binding)?.code, 'cross-book-argument')
  assert.equal(checkBookArgs({ dir: 'D:/Novels/b' }, binding)?.code, 'cross-book-argument')
})
