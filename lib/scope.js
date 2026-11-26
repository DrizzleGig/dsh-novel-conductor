// lib/scope.js — one novel = one workspace identity. This module owns the
// `book.json` / `books.json` format, session→book binding and the path/argument
// checks used by the isolation gates. It never writes sibling ledgers.

import { mkdir, readFile, writeFile, rename, unlink, stat, realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute, dirname, basename, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { ROOT_DIR } from './consts.js'

export const BOOK_SCHEMA_VERSION = 1
export const BOOK_ID_RE = /^bk-[0-9a-f-]{8,}$/i

export class ScopeError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ScopeError'
    this.code = code
    this.extra = extra
  }
}

export function failScope(code, message, extra = {}) {
  throw new ScopeError(code, message, extra)
}

export function normalizeWorkspace(value) {
  if (typeof value !== 'string' || !value.trim()) failScope('bad-cwd', '工作区必须是绝对路径')
  if (!isAbsolute(value)) failScope('bad-cwd', '工作区必须是绝对路径；相对路径会被进程工作目录解释')
  return resolve(value)
}

export function conductorRoot(cwd) {
  return join(normalizeWorkspace(cwd), ROOT_DIR)
}

export function bookFilePath(cwd) {
  return join(conductorRoot(cwd), 'book.json')
}

export function booksFilePath(cwd) {
  return join(conductorRoot(cwd), 'books.json')
}

export function booksDir(cwd) {
  return join(conductorRoot(cwd), 'books')
}

export function bookDir(cwd, bookId) {
  assertBookId(bookId)
  return join(booksDir(cwd), bookId)
}

export function sessionBindingPath(cwd, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) failScope('bad-session', 'sessionId 不能为空')
  return join(conductorRoot(cwd), 'sessions', `${safeSegment(sessionId)}.json`)
}

export function assertBookId(value) {
  if (typeof value !== 'string' || !BOOK_ID_RE.test(value)) {
    failScope('bad-book-id', `bookId 不合法：${String(value)}`)
  }
  return value
}

export function assertBookName(value) {
  if (typeof value !== 'string' || !value.trim()) failScope('bad-book', 'book 不能为空')
  const name = value.trim()
  if (/[\\/:*?"<>|\n\r\t]/.test(name) || name === '.' || name === '..') {
    failScope('bad-book', `book 含非法字符：${value}`)
  }
  return name
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) failScope('scope-corrupt', `JSON 解析失败：${file}`)
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    // Windows 上目标被短暂占用时 rename 可能失败。先留 .bak，再删旧文件，
    // 新文件就位失败时至少还能从 .bak 恢复。
    if (error?.code !== 'EPERM' && error?.code !== 'EEXIST' && error?.code !== 'EACCES') {
      await unlink(tmp).catch(() => {})
      throw error
    }
    const backup = `${file}.bak`
    try {
      await writeFile(backup, await readFile(file), 'utf8')
    } catch {
      // 文件本来就不存在；不需要备份。
    }
    await unlink(file).catch(() => {})
    try {
      await rename(tmp, file)
    } catch (renameError) {
      await unlink(tmp).catch(() => {})
      throw renameError
    }
  }
}

function normalizeIdentity(raw) {
  if (!raw || raw.schemaVersion !== BOOK_SCHEMA_VERSION) failScope('scope-corrupt', 'book.json 版本或结构不兼容')
  const bookId = assertBookId(raw.bookId)
  const book = assertBookName(raw.book)
  return {
    kind: 'single',
    bookId,
    book,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : book,
    createdAt: raw.createdAt ?? null,
    schemaVersion: BOOK_SCHEMA_VERSION,
  }
}

/**
 * Read the workspace identity without guessing across books.
 * - book.json       → { kind:'single', bookId, book, title }
 * - books.json only → { kind:'multi', books:[{bookId,book,title}] } (1 entry → single)
 * - neither         → { kind:'none' }
 */
export async function readBookIdentity(cwd) {
  const root = normalizeWorkspace(cwd)
  // books.json wins when present: it is the explicit multi-book table and is
  // also written when a single book is migrated to a multi-book workspace.
  const table = await readJson(booksFilePath(root), null)
  if (table) {
    if (table.schemaVersion !== BOOK_SCHEMA_VERSION || !Array.isArray(table.books)) {
      failScope('scope-corrupt', 'books.json 版本或结构不兼容')
    }
    const books = table.books.map((entry) => ({
      bookId: assertBookId(entry.bookId),
      book: assertBookName(entry.book),
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : entry.book,
    }))
    if (books.length === 0) return { kind: 'none' }
    if (books.length === 1) return { kind: 'single', ...books[0], schemaVersion: BOOK_SCHEMA_VERSION }
    return { kind: 'multi', books, schemaVersion: BOOK_SCHEMA_VERSION }
  }

  const single = await readJson(bookFilePath(root), null)
  if (single) return normalizeIdentity(single)
  return { kind: 'none' }
}

export async function initBook(cwd, { book, title } = {}) {
  const root = normalizeWorkspace(cwd)
  const existing = await readBookIdentity(root)
  if (existing.kind === 'single') {
    if (existing.book !== assertBookName(book)) {
      failScope('book-exists', `这个工作区已经是《${existing.book}》，不能再用 book.json 初始化成《${book}》`)
    }
    return existing
  }
  if (existing.kind === 'multi') failScope('multi-book', '这个工作区是多书工作区；请用 cue_scope bind 指定书')

  const name = assertBookName(book)
  const identity = {
    schemaVersion: BOOK_SCHEMA_VERSION,
    bookId: `bk-${randomUUID()}`,
    book: name,
    title: typeof title === 'string' && title.trim() ? title.trim() : name,
    createdAt: new Date().toISOString(),
  }
  await writeJsonAtomic(bookFilePath(root), identity)
  return normalizeIdentity(identity)
}

export async function bindBook(cwd, book) {
  const root = normalizeWorkspace(cwd)
  const identity = await readBookIdentity(root)
  if (identity.kind === 'none') failScope('no-book', '这个工作区还没有 book.json；先 cue_scope init')
  if (identity.kind === 'single') {
    if (book != null && assertBookName(book) !== identity.book) {
      failScope('cross-book', `当前工作区是《${identity.book}》，不能绑定《${book}》`)
    }
    return identity
  }
  const name = assertBookName(book)
  const found = identity.books.find((entry) => entry.book === name)
  if (!found) failScope('no-book', `books.json 里没有《${name}》`)
  return { kind: 'single', ...found, schemaVersion: BOOK_SCHEMA_VERSION }
}

export async function addBook(cwd, { book, title } = {}) {
  const root = normalizeWorkspace(cwd)
  const identity = await readBookIdentity(root)
  if (identity.kind === 'single') {
    if (identity.book === assertBookName(book)) return identity
    // 迁移成多书表：保留原 book.json，另写 books.json。
    const table = {
      schemaVersion: BOOK_SCHEMA_VERSION,
      books: [
        { bookId: identity.bookId, book: identity.book, title: identity.title },
        { bookId: `bk-${randomUUID()}`, book: assertBookName(book), title: title?.trim() || book },
      ],
    }
    await writeJsonAtomic(booksFilePath(root), table)
    return { kind: 'multi', books: table.books, schemaVersion: BOOK_SCHEMA_VERSION }
  }
  if (identity.kind === 'multi') {
    const name = assertBookName(book)
    const found = identity.books.find((entry) => entry.book === name)
    if (found) return identity
    identity.books.push({ bookId: `bk-${randomUUID()}`, book: name, title: title?.trim() || name })
    await writeJsonAtomic(booksFilePath(root), { schemaVersion: BOOK_SCHEMA_VERSION, books: identity.books })
    return identity
  }
  return initBook(root, { book, title })
}

export async function readSessionBinding(cwd, sessionId) {
  const raw = await readJson(sessionBindingPath(cwd, sessionId), null)
  if (!raw) return null
  try {
    return { bookId: assertBookId(raw.bookId), book: assertBookName(raw.book), boundAt: raw.boundAt ?? null }
  } catch {
    return null
  }
}

export async function writeSessionBinding(cwd, sessionId, binding) {
  await writeJsonAtomic(sessionBindingPath(cwd, sessionId), {
    schemaVersion: BOOK_SCHEMA_VERSION,
    bookId: assertBookId(binding.bookId),
    book: assertBookName(binding.book),
    boundAt: binding.boundAt ?? new Date().toISOString(),
  })
}

/** Case-insensitive on Windows; resolved, no trailing separator. */
export function canonicalPath(value) {
  const resolved = resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isPathInside(root, target) {
  const rel = relative(canonicalPath(root), canonicalPath(target))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve a possibly non-existent path without following a symlink/junction
 * outside the root. Existing ancestors are realpath'd; missing tails are kept.
 */
export async function canonicalTarget(value) {
  const absolute = resolve(String(value))
  let cursor = absolute
  const tail = []
  for (;;) {
    try {
      const real = await realpath(cursor)
      return resolve(real, ...tail.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) return absolute
      tail.push(basename(cursor))
      cursor = parent
    }
  }
}

export async function assertPathInside(root, target, { label = '路径' } = {}) {
  const realRoot = await canonicalTarget(root)
  const realTarget = await canonicalTarget(target)
  if (!isPathInside(realRoot, realTarget)) {
    failScope('path-outside-book', `${label}越出当前书工作区：${target}`)
  }
  return realTarget
}

/** Book/workspace arguments a managed tool must not use to cross books. */
export function checkBookArgs(args, binding) {
  if (!args || typeof args !== 'object' || !binding) return null
  const bookId = args.bookId ?? args.book_id
  if (typeof bookId === 'string' && bookId && bookId !== binding.bookId) {
    return { code: 'cross-book-argument', message: `bookId 与当前绑定不一致：${bookId}` }
  }
  const book = args.book
  if (typeof book === 'string' && book && book !== binding.book) {
    return { code: 'cross-book-argument', message: `book 与当前绑定不一致：${book}` }
  }
  for (const key of ['dir', 'cwd', 'workspace', 'root']) {
    const value = args[key]
    if (typeof value === 'string' && value && canonicalPath(value) !== canonicalPath(binding.workspace)) {
      return { code: 'cross-book-argument', message: `${key} 与当前工作区不一致：${value}` }
    }
  }
  return null
}

export function bindingFromIdentity(cwd, identity) {
  if (!identity || identity.kind !== 'single') return null
  return {
    workspace: normalizeWorkspace(cwd),
    bookId: identity.bookId,
    book: identity.book,
    title: identity.title ?? identity.book,
  }
}
