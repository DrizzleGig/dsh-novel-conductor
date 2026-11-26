// lib/scope-manager.js — session → book binding, derived from cwd + book
// identity. The binding is a cache: resume/compact can rebuild it. A multi-book
// workspace stays unbound until cue_scope(bind), so no default book is guessed.

import { readBookIdentity, bindingFromIdentity, initBook, bindBook, addBook, readSessionBinding, writeSessionBinding } from './scope.js'

export function createScopeManager(ctx) {
  const workingDirectory = ctx?.get?.('workingDirectory') ?? null
  const bindings = new Map()
  const dirs = new Map()
  const identities = new Map()

  async function cwdFor(agent) {
    if (!agent?.id) return null
    if (dirs.has(agent.id)) return dirs.get(agent.id)
    if (!workingDirectory?.ensure) return null
    try {
      const cwd = await workingDirectory.ensure(agent)
      if (cwd) dirs.set(agent.id, cwd)
      return cwd ?? null
    } catch {
      return null
    }
  }

  async function identityFor(cwd) {
    if (!cwd) return { kind: 'none' }
    if (identities.has(cwd)) return identities.get(cwd)
    const identity = await readBookIdentity(cwd)
    identities.set(cwd, identity)
    return identity
  }

  function bind(agent, cwd, identity) {
    const binding = bindingFromIdentity(cwd, identity)
    if (binding && agent?.id) bindings.set(agent.id, binding)
    return binding
  }

  async function ensure(agent) {
    if (!agent?.id) return null
    if (bindings.has(agent.id)) return bindings.get(agent.id)
    const cwd = await cwdFor(agent)
    if (!cwd) return null
    const identity = await identityFor(cwd)
    if (identity.kind === 'single') return bind(agent, cwd, identity)
    if (identity.kind === 'multi') {
      const saved = await readSessionBinding(cwd, agent.id).catch(() => null)
      const found = saved ? identity.books.find((item) => item.bookId === saved.bookId) : null
      if (found) return bind(agent, cwd, { kind: 'single', ...found })
    }
    return null
  }

  function get(agentOrId) {
    const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id
    return id ? bindings.get(id) ?? null : null
  }

  function clear(agentOrId) {
    const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id
    if (!id) return
    bindings.delete(id)
    dirs.delete(id)
  }

  function isNovelWorkspace(agent) {
    const cwd = dirs.get(agent?.id)
    if (!cwd) return false
    const identity = identities.get(cwd)
    return Boolean(identity && identity.kind !== 'none')
  }

  function invalidate(cwd) {
    if (cwd) identities.delete(cwd)
  }

  async function init(agent, cwd, { book, title } = {}) {
    const identity = await initBook(cwd, { book, title })
    invalidate(cwd)
    return bind(agent, cwd, identity)
  }

  async function select(agent, cwd, book) {
    const identity = await bindBook(cwd, book)
    invalidate(cwd)
    const binding = bindingFromIdentity(cwd, identity)
    if (!binding) throw new Error(`无法把《${book}》绑定为单书身份`)
    // 先持久化，成功后才更新内存；失败时保留旧绑定并让调用方看到错误。
    if (agent?.id) await writeSessionBinding(cwd, agent.id, binding)
    if (agent?.id) bindings.set(agent.id, binding)
    return binding
  }

  async function add(agent, cwd, { book, title } = {}) {
    const identity = await addBook(cwd, { book, title })
    invalidate(cwd)
    return identity
  }

  return {
    cwdFor,
    identityFor,
    ensure,
    bind,
    get,
    clear,
    isNovelWorkspace,
    invalidate,
    init,
    select,
    add,
  }
}
