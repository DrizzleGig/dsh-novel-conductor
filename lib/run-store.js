// lib/run-store.js — conductor's own durable state. No sibling ledger is read
// or written here: one directory per run, one atomic run.json, one append-only
// receipts.jsonl, one events.jsonl.

import { mkdir, readFile, writeFile, rename, unlink, readdir, appendFile, stat, copyFile } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { ROOT_DIR, SCHEMA_VERSION, STEP_IDS } from './consts.js'

const locks = new Map()

export class ConductorError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ConductorError'
    this.code = code
    this.extra = extra
  }
}

export function fail(code, message, extra = {}) {
  throw new ConductorError(code, message, extra)
}

export function nowIso() {
  return new Date().toISOString()
}

export function normalizeCwd(value) {
  if (typeof value !== 'string' || !value.trim()) fail('bad-cwd', 'cwd 必须是工作区根目录的绝对路径')
  if (!isAbsolute(value)) fail('bad-cwd', 'cwd 必须是绝对路径；相对路径会被进程工作目录解释，容易读错书')
  return resolve(value)
}

export function rootDir(cwd) {
  return join(normalizeCwd(cwd), ROOT_DIR)
}

export function runsDir(cwd) {
  return join(rootDir(cwd), 'runs')
}

export function bookRunsDir(cwd, bookId) {
  if (typeof bookId !== 'string' || !/^bk-[0-9a-f-]{8,}$/i.test(bookId)) {
    fail('bad-book-id', `bookId 不合法：${String(bookId)}`)
  }
  return join(rootDir(cwd), 'books', bookId, 'runs')
}

export function runDir(cwd, runId, bookId = null) {
  assertRunId(runId)
  return bookId ? join(bookRunsDir(cwd, bookId), runId) : join(runsDir(cwd), runId)
}

export function runFile(cwd, runId, bookId = null) {
  return join(runDir(cwd, runId, bookId), 'run.json')
}

export function receiptsFile(cwd, runId, bookId = null) {
  return join(runDir(cwd, runId, bookId), 'receipts.jsonl')
}

export function eventsFile(cwd, runId, bookId = null) {
  return join(runDir(cwd, runId, bookId), 'events.jsonl')
}

export function assertRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$/.test(value) || value.includes('..')) {
    fail('bad-run-id', `runId 不合法：${String(value)}`)
  }
  return value
}

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `run-${stamp}-${randomBytes(3).toString('hex')}`
}

async function withLock(key, fn) {
  const lockKey = resolve(key)
  const previous = locks.get(lockKey) ?? Promise.resolve()
  let release
  const current = new Promise((resolveCurrent) => { release = resolveCurrent })
  const tail = previous.then(() => current)
  locks.set(lockKey, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(lockKey) === tail) locks.delete(lockKey)
  }
}

export async function readJson(file, fallback = null) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch {
    fail('run-corrupt', `JSON 解析失败：${file}`)
  }
}

export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`
  const body = `${JSON.stringify(data, null, 2)}\n`
  const backup = `${file}.bak`
  try {
    await writeFile(tmp, body, 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Windows 上目标被短暂占用时 rename 可能失败。先备份旧文件，再删旧、重试；
      // 重试失败则把备份放回去，保证旧状态或新文件至少有一个留下来。
      if (error?.code !== 'EPERM' && error?.code !== 'EEXIST' && error?.code !== 'EACCES') throw error
      let backedUp = false
      try {
        await copyFile(file, backup)
        backedUp = true
      } catch {
        // 旧文件本来就不存在；没有旧状态可保。
      }
      if (!backedUp) {
        // 不能确认旧文件已备份时不要删旧文件；保留旧状态，放弃这次替换。
        throw error
      }
      await unlink(file).catch(() => {})
      try {
        await rename(tmp, file)
      } catch (renameError) {
        // 先把备份放回原路径；rename 失败时再用 copy 兜底。
        await rename(backup, file).catch(async () => {
          await copyFile(backup, file).catch(() => {})
        })
        throw renameError
      }
      await unlink(backup).catch(() => {})
    }
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function listBookIds(cwd) {
  try {
    const entries = await readdir(join(rootDir(cwd), 'books'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function runCandidates(cwd, runId) {
  assertRunId(runId)
  const files = [runFile(cwd, runId)]
  for (const bookId of await listBookIds(cwd)) {
    if (!/^bk-[0-9a-f-]{8,}$/i.test(bookId)) continue
    files.push(runFile(cwd, runId, bookId))
  }
  return files
}

async function existingRunFile(cwd, runId, bookId = null) {
  if (bookId) {
    const file = runFile(cwd, runId, bookId)
    try {
      await stat(file)
      return file
    } catch {
      return null
    }
  }
  for (const file of await runCandidates(cwd, runId)) {
    try {
      await stat(file)
      return file
    } catch {
      // try next
    }
  }
  return null
}

export async function readRun(cwd, runId, bookId = null) {
  if (bookId) {
    const own = await readJson(runFile(cwd, runId, bookId), null)
    if (own) {
      if (own.bookId && own.bookId !== bookId) fail('cross-book-run', `run ${runId} 不属于 ${bookId}`)
      return own
    }
    const other = await existingRunFile(cwd, runId)
    if (other) {
      const found = await readJson(other, null)
      if (found) fail('cross-book-run', `run ${runId} 不属于 ${bookId}`)
    }
    fail('no-run', `找不到 run：${runId}`)
  }
  const file = await existingRunFile(cwd, runId)
  const run = file ? await readJson(file, null) : null
  if (!run) fail('no-run', `找不到 run：${runId}`)
  return run
}

export async function writeRun(cwd, run) {
  assertRunId(run?.runId)
  const next = { ...run, updatedAt: nowIso() }
  const file = runFile(cwd, run.runId, run.bookId ?? null)
  await withLock(file, () => writeJsonAtomic(file, next))
  return next
}

export async function createRun(cwd, run) {
  assertRunId(run?.runId)
  const directory = runDir(cwd, run.runId, run.bookId ?? null)
  await mkdir(directory, { recursive: true })
  const next = { ...run, schemaVersion: SCHEMA_VERSION, createdAt: run.createdAt ?? nowIso(), updatedAt: nowIso() }
  await writeJsonAtomic(runFile(cwd, run.runId, run.bookId ?? null), next)
  await appendEvent(cwd, run.runId, { at: next.createdAt, kind: 'created', state: next.state, step: next.currentStep }, run.bookId ?? null)
  return next
}

async function listRunsIn(cwd, bookId = null) {
  let entries = []
  const directory = bookId ? bookRunsDir(cwd, bookId) : runsDir(cwd)
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const run = await readJson(runFile(cwd, entry.name, bookId), null)
      if (run) runs.push(run)
    } catch {
      // 一个损坏的 run 不能挡住其他 run 的读取。
    }
  }
  return runs
}

export async function listRuns(cwd, bookId = null) {
  if (bookId) {
    return (await listRunsIn(cwd, bookId)).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }
  const all = await listRunsIn(cwd, null)
  for (const id of await listBookIds(cwd)) {
    if (!/^bk-[0-9a-f-]{8,}$/i.test(id)) continue
    all.push(...await listRunsIn(cwd, id))
  }
  const seen = new Set()
  return all
    .filter((run) => {
      if (!run?.runId || seen.has(run.runId)) return false
      seen.add(run.runId)
      return true
    })
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

export async function findActiveRun(cwd, agentId, bookId = null) {
  const runs = await listRuns(cwd, bookId)
  return runs.find((run) => run.agentId === agentId && !['completed', 'blocked', 'aborted'].includes(run.state)) ?? null
}

export async function findLatestRun(cwd, agentId, bookId = null) {
  const runs = await listRuns(cwd, bookId)
  return runs.find((run) => (!agentId || run.agentId === agentId) && (!bookId || run.bookId === bookId)) ?? null
}

export async function appendReceipt(cwd, runId, receipt, bookId = null) {
  const file = receiptsFile(cwd, runId, bookId)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(receipt)}\n`, 'utf8')
  return receipt
}

export async function readReceipts(cwd, runId, bookId = null) {
  let text
  try {
    text = await readFile(receiptsFile(cwd, runId, bookId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 崩溃可能留下半行；已写入的整行仍然有效。
    }
  }
  return out.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
}

export async function appendEvent(cwd, runId, event, bookId = null) {
  const file = eventsFile(cwd, runId, bookId)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8')
}

export async function runExists(cwd, runId, bookId = null) {
  const file = await existingRunFile(cwd, runId, bookId)
  return Boolean(file)
}

export function stepTemplate(id, required = true) {
  return {
    id,
    required,
    state: 'pending',
    windowStart: 0,
    startedAt: null,
    endedAt: null,
    source: null,
    receipt: null,
    note: null,
  }
}

export { STEP_IDS }
