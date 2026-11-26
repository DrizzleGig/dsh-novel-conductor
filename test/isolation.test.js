import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { initBook, readBookIdentity } from '../lib/scope.js'

async function workspace(prefix = 'conductor-isolation-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function makeHost(cwd, { agentId = 'agent-1' } = {}) {
  const tools = []
  const commands = []
  const globalSkills = []
  const agentSkills = []
  const guards = []
  const events = new Map()
  const services = new Map()
  const agentTools = {
    guard(fn) { guards.push(fn); return () => {} },
    restrict() { return () => {} },
  }
  const agent = {
    id: agentId,
    ctx: {
      get skills() { throw new Error("cannot get property 'skills' without inject") },
      get tools() { throw new Error("cannot get property 'tools' without inject") },
      get(name) {
        if (name === 'skills') return { register: (skill) => { agentSkills.push(skill); return () => {} } }
        if (name === 'tools') return agentTools
        return undefined
      },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      on(name, cb) {
        if (!events.has(name)) events.set(name, [])
        events.get(name).push(cb)
        return () => {}
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => cwd }
      if (name === 'commands') return { register: (command) => { commands.push(command); return () => {} } }
      if (name === 'skills') return { register: (skill) => { globalSkills.push(skill); return () => {} } }
      if (name === 'agents') return { list: () => [agent] }
      return services.get(name) ?? null
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on(name, cb) {
      if (!events.has(name)) events.set(name, [])
      events.get(name).push(cb)
      return () => {}
    },
    emit() {},
    provide(key, value) { services.set(key, value) },
    tools: {
      register(definition, options) { tools.push({ definition, options }); return () => {} },
    },
  }
  return { ctx, tools, commands, globalSkills, agentSkills, guards, events, agent }
}

const toolOf = (host, name) => host.tools.find((entry) => entry.definition.name === name).definition

test('isolation：cue_scope init 建书，run 落到 books/<bookId>/runs', async () => {
  const cwd = await workspace()
  const host = makeHost(cwd)
  await apply(host.ctx)
  const scopeTool = toolOf(host, 'cue_scope')
  const who = { agent: host.agent }
  const init = await scopeTool.execute({ action: 'init', book: '书' }, who)
  assert.equal(init.ok, true)
  assert.match(init.binding.bookId, /^bk-/)
  const identity = await readBookIdentity(cwd)
  assert.equal(identity.book, '书')

  const runTool = toolOf(host, 'cue_run')
  const started = await runTool.execute({ action: 'start', book: '书', chapter: 1 }, who)
  assert.equal(started.ok, true)
  assert.equal(started.run.bookId, init.binding.bookId)
  const file = path.join(cwd, '.dsh-novel-conductor', 'books', init.binding.bookId, 'runs', started.run.runId, 'run.json')
  assert.equal((await fs.stat(file)).isFile(), true)
})

test('isolation：按 agent 注册 skill；普通会话没有 novel-conductor', async () => {
  const cwd = await workspace()
  await initBook(cwd, { book: '书' })
  const host = makeHost(cwd)
  await apply(host.ctx)
  await host.events.get('agent/created')?.[0]?.({ agent: host.agent })
  assert.equal(host.agentSkills.length, 0, '未 /cue on 时不在 agent 作用域注册技能')
  await host.commands[0].handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(host.agentSkills.length, 1)
  assert.equal(host.agentSkills[0].name, 'novel-conductor')
  assert.equal(host.globalSkills.length, 0)
})

test('isolation：guard 拒绝跨书参数；pre-execute 拒绝越界路径', async () => {
  const cwd = await workspace()
  await initBook(cwd, { book: '书' })
  const host = makeHost(cwd)
  await apply(host.ctx)
  await host.commands[0].handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(host.guards.length, 1)
  const denial = host.guards[0]({ name: 'beat_segment', arguments: { book: '另一本' } })
  assert.equal(denial.info.code, 'cross-book-argument')

  const pre = host.events.get('tools/pre-execute')?.[0]
  assert.equal(typeof pre, 'function')
  const denied = await pre({ name: 'write', arguments: { path: path.join(cwd, '..', '别处.md') } }, async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  const deniedFile = await pre({ name: 'edit', arguments: { file_path: path.join(cwd, '..', '别处.md') } }, async () => ({ kind: 'allow' }))
  assert.equal(deniedFile.kind, 'deny')
  const allowed = await pre({ name: 'write', arguments: { file_path: path.join(cwd, '正文', '第1章.md') } }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
})

test('isolation：模型不能通过 cue_locks 强拆锁', async () => {
  const cwd = await workspace()
  const host = makeHost(cwd)
  await apply(host.ctx)
  const locks = toolOf(host, 'cue_locks')
  const broken = await locks.execute({ action: 'break' }, { agent: host.agent })
  assert.equal(broken.ok, false)
  assert.equal(broken.code, 'author-only')
})

test('isolation：同 cwd 多书写正文被拒绝', async () => {
  const cwd = await workspace()
  const a = await initBook(cwd, { book: '书A' })
  const { addBook } = await import('../lib/scope.js')
  await addBook(cwd, { book: '书B' })
  const host = makeHost(cwd)
  await apply(host.ctx)
  const runTool = toolOf(host, 'cue_run')
  const started = await runTool.execute({ action: 'start', book: '书A', chapter: 1 }, { agent: host.agent })
  assert.equal(started.ok, false)
  assert.equal(started.code, 'multi-book-write')
  assert.equal(a.book, '书A')
})

test('isolation：cue_locks 在无锁时返回 free', async () => {
  const cwd = await workspace()
  const host = makeHost(cwd)
  await apply(host.ctx)
  const locks = toolOf(host, 'cue_locks')
  const status = await locks.execute({ action: 'status' }, { agent: host.agent })
  assert.equal(status.ok, true)
  assert.equal(status.state, 'free')
})
