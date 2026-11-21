// 0.1.3 回归：会话头按钮每 10 秒读一次开关，绝不能走 /cue 命令。
//
// 现象（2026-11-21）：对话跑完、停在输入框，时间线里每隔 10 秒冒出一行
//   `cue · 故事总控：关（/cue on 开启）／当前没有活动 run…`
// 根因：host 半 remote.status() 用 commands.execute('/cue status') 读状态；
// DSH 的 commands.execute 每次都会把 command/run + command/done 写进会话日志
// （@deepseek-ai/dsh-commands src/index.ts:335「Both are direct log-only appends」），
// 客户端又在轮询，于是变成刷屏。实测：一个会话 24 分钟 146 次 /cue。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readDriving } from '../lib/cue-mode.js'

const ctxWith = (service) => ({
  get(key) {
    if (key === 'novelConductor') return service
    throw new Error(`unexpected service ${key}`)
  },
  // 任何命令执行都算回归：读状态不该碰到 commands。
  commands: {
    execute() {
      throw new Error('status 不能走 commands.execute（会往会话日志写一行）')
    },
  },
})

test('服务在：readDriving 只问 isDriving，返回布尔', () => {
  const seen = []
  const service = {
    isDriving(id) {
      seen.push(id)
      return id === 'session-on'
    },
  }
  assert.deepEqual(readDriving(ctxWith(service), 'session-on'), { ok: true, on: true })
  assert.deepEqual(readDriving(ctxWith(service), 'session-off'), { ok: true, on: false })
  assert.deepEqual(seen, ['session-on', 'session-off'])
})

test('服务不在：返回 ok:false，不抛、不碰命令', () => {
  const result = readDriving(ctxWith(undefined), 'session-x')
  assert.equal(result.ok, false)
  assert.match(result.reason, /服务未就绪|未就绪/)
})

test('sessionId 不合法：直接拒绝', () => {
  assert.equal(readDriving(ctxWith({ isDriving: () => true }), '').ok, false)
  assert.equal(readDriving(ctxWith({ isDriving: () => true }), null).ok, false)
  assert.equal(readDriving(ctxWith({ isDriving: () => true }), 42).ok, false)
})

test('服务自己抛异常：包成 ok:false，不把异常漏给按钮', () => {
  const service = {
    isDriving() {
      throw new Error('boom')
    },
  }
  const result = readDriving(ctxWith(service), 'session-x')
  assert.equal(result.ok, false)
  assert.match(result.reason, /boom/)
})

test('回归守卫：remote.status 不再执行命令，client 轮询带可见性判断', () => {
  const remote = readFileSync(new URL('../lib/remote.js', import.meta.url), 'utf8')
  const statusBody = remote.slice(remote.indexOf('async status('), remote.indexOf('async setMode('))
  assert.ok(statusBody.length > 0, '要能找到 status 方法')
  assert.ok(!statusBody.includes('runCommand'), 'status 里不许再执行 /cue 命令')
  assert.ok(!statusBody.includes('commands.execute'), 'status 里不许再调 commands.execute')
  assert.ok(remote.includes("from './cue-mode.js'"), 'status 要读 cue-mode 的只读路径')

  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('visibilitychange'), '轮询要在页面不可见时停下')
  assert.ok(client.includes('run(\'status\', true)'), '轮询仍走 remote.status')
})
