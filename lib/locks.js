// lib/locks.js — cross-process per-book write lease. A file lock only decides
// who may write now; it is not a transaction log. Liveness is deliberately
// three-valued: alive / dead / unknown. Unknown never gets auto-taken.

import { open, readFile, unlink, mkdir, stat, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

import { conductorRoot, normalizeWorkspace } from './scope.js'

export const LOCK_PROTOCOL_VERSION = 1
export const DEFAULT_TTL_MS = 30_000

export class LockError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LockError'
    this.code = code
    this.extra = extra
  }
}

export function failLock(code, message, extra = {}) {
  throw new LockError(code, message, extra)
}

export function lockResource(resource = 'book-write') {
  const safe = String(resource).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return safe || 'book-write'
}

export function lockFile(cwd, resource = 'book-write') {
  return join(conductorRoot(normalizeWorkspace(cwd)), 'locks', `${lockResource(resource)}.lock`)
}

export function currentHostId() {
  return process.env.DSH_CONDUCTOR_HOST_ID || hostname() || 'unknown-host'
}

export function currentProcessStartTime() {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  return new Date(startedAt).toISOString()
}

/** PID existence only; a reused PID still reads as alive (conservative). */
export function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * alive   = same host and the recorded PID still exists (heartbeat age is only
 *           diagnostic; never used to steal).
 * dead    = same host and the recorded PID is gone.
 * unknown = remote host, corrupt record, missing identity, permission failure.
 */
export function classifyLock(record, { isProcessAlive = defaultIsProcessAlive, hostId = currentHostId() } = {}) {
  if (!record || record.protocolVersion !== LOCK_PROTOCOL_VERSION) return 'unknown'
  if (typeof record.hostId !== 'string' || record.hostId !== hostId) return 'unknown'
  if (!Number.isInteger(record.pid) || record.pid <= 0) return 'unknown'
  return isProcessAlive(record.pid) ? 'alive' : 'dead'
}

async function readLockRecord(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { corrupt: true, error: String(error?.message ?? error) }
  }
}

async function writeRecord(file, record) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, file)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

export async function readLock(cwd, resource = 'book-write', options = {}) {
  const file = lockFile(cwd, resource)
  const record = await readLockRecord(file)
  return { file, record, state: record ? (record.corrupt ? 'unknown' : classifyLock(record, options)) : 'free' }
}

/**
 * Acquire one resource lease. `takeover` is only for an author-confirmed
 * break of a dead lock; unknown locks are never taken automatically.
 */
export async function acquireLock({
  cwd,
  bookId,
  flowId,
  resource = 'book-write',
  ownerToken = randomUUID(),
  generation = 1,
  ttlMs = DEFAULT_TTL_MS,
  takeover = false,
  hostId = currentHostId(),
  isProcessAlive = defaultIsProcessAlive,
  now = Date.now(),
} = {}) {
  if (typeof bookId !== 'string' || !bookId) failLock('bad-book-id', 'acquireLock 需要 bookId')
  if (typeof flowId !== 'string' || !flowId) failLock('bad-flow-id', 'acquireLock 需要 flowId')
  const file = lockFile(cwd, resource)
  await mkdir(dirname(file), { recursive: true })

  const record = {
    protocolVersion: LOCK_PROTOCOL_VERSION,
    resourceId: lockResource(resource),
    workspaceKey: normalizeWorkspace(cwd),
    bookId,
    flowId,
    ownerToken,
    generation,
    hostId,
    pid: process.pid,
    processStartTime: currentProcessStartTime(),
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ttlMs,
    pendingTransactionIds: [],
  }

  const create = async () => {
    const handle = await open(file, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  }

  try {
    await create()
    return leaseFor(file, record)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readLockRecord(file)
    const state = existing?.corrupt ? 'unknown' : classifyLock(existing, { isProcessAlive, hostId })
    if (state === 'alive') {
      failLock('lock-busy', `这本书正在被另一个写流程占用（${existing?.flowId ?? 'unknown'}）`, { owner: existing })
    }
    if (state === 'unknown') {
      failLock('lock-unknown', '锁的持有者无法判定；拒绝自动接管', { owner: existing })
    }
    if (!takeover) {
      failLock('lock-dead', '锁的持有进程已经死亡；需要作者确认后 break', { owner: existing })
    }
    await unlink(file).catch(() => {})
    await create()
    return leaseFor(file, record)
  }
}

function leaseFor(file, record) {
  let released = false
  return {
    file,
    record,
    async touch() {
      const current = await readLockRecord(file)
      if (!current || current.ownerToken !== record.ownerToken || current.generation !== record.generation) {
        failLock('lock-lost', '锁已不属于当前持有者')
      }
      record.heartbeatAt = new Date().toISOString()
      await writeRecord(file, { ...current, heartbeatAt: record.heartbeatAt })
    },
    async release() {
      if (released) return
      released = true
      const current = await readLockRecord(file)
      if (!current) return
      if (current.ownerToken !== record.ownerToken || current.generation !== record.generation) {
        failLock('lock-lost', '锁已易主，不能释放别人的锁')
      }
      await unlink(file).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
    },
  }
}

export async function breakLock(cwd, resource = 'book-write', { force = false, isProcessAlive = defaultIsProcessAlive } = {}) {
  const file = lockFile(cwd, resource)
  const record = await readLockRecord(file)
  if (!record) return { broken: false, reason: 'free' }
  const state = record.corrupt ? 'unknown' : classifyLock(record, { isProcessAlive })
  if (state === 'alive' && !force) failLock('lock-busy', '锁仍活着；拒绝 break')
  if (state === 'unknown' && !force) failLock('lock-unknown', '锁状态未知；需要 force 才可 break')
  await unlink(file).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  return { broken: true, previous: record, state }
}

export async function lockStatus(cwd, resource = 'book-write', options = {}) {
  const file = lockFile(cwd, resource)
  let exists = true
  try {
    await stat(file)
  } catch {
    exists = false
  }
  if (!exists) return { resource: lockResource(resource), state: 'free', file }
  const record = await readLockRecord(file)
  if (!record) return { resource: lockResource(resource), state: 'free', file }
  return {
    resource: lockResource(resource),
    state: record.corrupt ? 'unknown' : classifyLock(record, options),
    owner: record,
    file,
  }
}
