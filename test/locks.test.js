import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireLock, breakLock, classifyLock, lockStatus, readLock } from '../lib/locks.js'

async function workspace(prefix = 'conductor-lock-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

const base = {
  bookId: 'bk-11111111-1111-1111-1111-111111111111',
  flowId: 'flow-a',
  hostId: 'host-test',
}

test('locks：首次获取成功，第二个写者 busy；释放后可再取', async () => {
  const cwd = await workspace()
  const one = await acquireLock({ cwd, ...base, isProcessAlive: () => true })
  assert.equal(one.record.bookId, base.bookId)
  await assert.rejects(
    () => acquireLock({ cwd, ...base, flowId: 'flow-b', isProcessAlive: () => true }),
    /正在被另一个写流程占用/,
  )
  await one.release()
  const two = await acquireLock({ cwd, ...base, flowId: 'flow-c', isProcessAlive: () => true })
  await two.release()
})

test('locks：死锁不自动接管；takeover 才可接管', async () => {
  const cwd = await workspace()
  const one = await acquireLock({ cwd, ...base, isProcessAlive: () => false })
  // 模拟另一个进程留下死锁：把 pid 改成一个不存在的值
  const file = one.file
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.pid = 999999
  await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  await assert.rejects(
    () => acquireLock({ cwd, ...base, flowId: 'flow-b', isProcessAlive: () => false }),
    /已经死亡/,
  )
  const taken = await acquireLock({ cwd, ...base, flowId: 'flow-b', isProcessAlive: () => false, takeover: true })
  await taken.release()
})

test('locks：异机/坏记录判 unknown，拒绝自动接管；force break 可清', async () => {
  const cwd = await workspace()
  const one = await acquireLock({ cwd, ...base, isProcessAlive: () => true })
  const raw = JSON.parse(await fs.readFile(one.file, 'utf8'))
  raw.hostId = 'other-host'
  await fs.writeFile(one.file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  assert.equal(classifyLock(raw, { hostId: 'host-test', isProcessAlive: () => true }), 'unknown')
  await assert.rejects(
    () => acquireLock({ cwd, ...base, flowId: 'flow-b', hostId: 'host-test', isProcessAlive: () => true }),
    /无法判定/,
  )
  const broken = await breakLock(cwd, 'book-write', { force: true })
  assert.equal(broken.broken, true)
  const status = await lockStatus(cwd)
  assert.equal(status.state, 'free')
})

test('locks：release 校验 ownerToken，不能释放别人的锁', async () => {
  const cwd = await workspace()
  const one = await acquireLock({ cwd, ...base, isProcessAlive: () => true })
  await breakLock(cwd, 'book-write', { force: true })
  const other = await acquireLock({ cwd, ...base, flowId: 'flow-b', ownerToken: 'other', isProcessAlive: () => true })
  await assert.rejects(() => one.release(), /锁已易主/)
  await other.release()
})

test('locks：readLock 对自由/占用状态可读', async () => {
  const cwd = await workspace()
  const free = await readLock(cwd)
  assert.equal(free.state, 'free')
  const one = await acquireLock({ cwd, ...base, isProcessAlive: () => true })
  const held = await readLock(cwd, 'book-write', { hostId: 'host-test', isProcessAlive: () => true })
  assert.equal(held.state, 'alive')
  await one.release()
})
