// Web 半的最小冒烟：确认 client.js 能挂上、注册的是会话头开关，且 apply 不抛。
// 真机渲染在 DSH 里点；这里只保证模块结构对（拼错 slot 名或漏 export 会当场挂）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
}

function fakeReact() {
  return React
}

test('client.js 注册会话头「故事总控」按钮并挂上 cueMode remote', async () => {
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
      },
    },
  }

  await import('../client.js')
  assert.ok(loaded, 'client.js 要调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-novel-conductor')

  const module = loaded.factory(fakeReact)
  assert.deepEqual(module.inject, ['slots', 'remote'])

  const registered = []
  const mounted = []
  const ctx = {
    remote: {
      async $mount(contract) {
        mounted.push(contract)
        return () => {}
      },
    },
    get: (key) => (key === 'remote.cueMode'
      ? { status: async () => ({ on: true }), setMode: async () => ({ on: false }) }
      : undefined),
    slots: {
      inject(name, fn) {
        fn()
      },
      register(meta, component) {
        registered.push({ meta, component })
      },
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }

  await module.apply(ctx)

  assert.equal(mounted.length, 1, '要 mount 一份 typert remote')
  assert.equal(mounted[0].package, 'dsh-novel-conductor')
  assert.equal(mounted[0].descriptors.length, 2, 'status + setMode')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.name, 'conversation.session.header.utilities')
  assert.equal(registered[0].meta.id, 'dsh-novel-conductor-mode')
  assert.equal(typeof registered[0].meta.inject, 'function')
  assert.equal(typeof registered[0].component, 'function')
})

test('host 半的 remote 契约与 client 半对齐', async () => {
  const { DESCRIPTORS, TYPERT_REMOTE } = await import('../lib/remote-contract.js')
  assert.equal(TYPERT_REMOTE.package, 'dsh-novel-conductor')
  assert.deepEqual(DESCRIPTORS.map((item) => item.method), ['status', 'setMode'])
  for (const descriptor of DESCRIPTORS) {
    assert.equal(descriptor.service, 'cueMode')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.ok(descriptor.parameters.some((item) => item.name === 'sessionId'))
  }
})
