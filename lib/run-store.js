// lib/run-store.js — conductor's own durable state. No sibling ledger is read
// or written here: one directory per run, one atomic run.json, one append-only
// receipts.jsonl, one events.jsonl.

import { mkdir, readFile, writeFile, rename, unlink, readdir, appendFile, stat } from 'node:fs/promises'
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

export function runDir(cwd, runId) {
  assertRunId(runId)
  return join(runsDir(cwd), runId)
}

export function runFile(cwd, runId) {
  return join(runDir(cwd, runId), 'run.json')
}

export function receiptsFile(cwd, runId) {
  return join(runDir(cwd, runId), 'receipts.jsonl')
}

export function eventsFile(cwd, runId) {
  return join(runDir(cwd, runId), 'events.jsonl')
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
  try {
    await writeFile(tmp, body, 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Windows 上目标被短暂占用时 rename 可能失败；删除后重试一次。
      if (error?.code !== 'EPERM' && error?.code !== 'EEXIST' && error?.code !== 'EACCES') throw error
      await unlink(file).catch(() => {})
      await rename(tmp, file)
    }
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

export async function readRun(cwd, runId) {
  const file = runFile(cwd, runId)
  const run = await readJson(file, null)
  if (!run) fail('no-run', `找不到 run：${runId}`)
  return run
}

export async function writeRun(cwd, run) {
  assertRunId(run?.runId)
  const next = { ...run, updatedAt: nowIso() }
  await withLock(runFile(cwd, run.runId), () => writeJsonAtomic(runFile(cwd, run.runId), next))
  return next
}

export async function createRun(cwd, run) {
  assertRunId(run?.runId)
  const directory = runDir(cwd, run.runId)
  await mkdir(directory, { recursive: true })
  const next = { ...run, schemaVersion: SCHEMA_VERSION, createdAt: run.createdAt ?? nowIso(), updatedAt: nowIso() }
  await writeJsonAtomic(runFile(cwd, run.runId), next)
  await appendEvent(cwd, run.runId, { at: next.createdAt, kind: 'created', state: next.state, step: next.currentStep })
  return next
}

export async function listRuns(cwd) {
  let entries = []
  try {
    entries = await readdir(runsDir(cwd), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const run = await readJson(runFile(cwd, entry.name), null)
      if (run) runs.push(run)
    } catch {
      // 一个损坏的 run 不能挡住其他 run 的读取。
    }
  }
  return runs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

export async function findActiveRun(cwd, agentId) {
  const runs = await listRuns(cwd)
  return runs.find((run) => run.agentId === agentId && !['completed', 'blocked', 'aborted'].includes(run.state)) ?? null
}

export async function findLatestRun(cwd, agentId) {
  const runs = await listRuns(cwd)
  return runs.find((run) => !agentId || run.agentId === agentId) ?? null
}

export async function appendReceipt(cwd, runId, receipt) {
  const file = receiptsFile(cwd, runId)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(receipt)}\n`, 'utf8')
  return receipt
}

export async function readReceipts(cwd, runId) {
  let text
  try {
    text = await readFile(receiptsFile(cwd, runId), 'utf8')
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

export async function appendEvent(cwd, runId, event) {
  const file = eventsFile(cwd, runId)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8')
}

export async function runExists(cwd, runId) {
  try {
    await stat(runFile(cwd, runId))
    return true
  } catch {
    return false
  }
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
