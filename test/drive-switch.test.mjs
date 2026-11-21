// 接管开关的模拟验收（不起 DSH 宿主）：
//   conductor 关着 → cue_* 不可见、兄弟四个也不可见；
//   /cue on       → cue_* 可见，且兄弟四个即使自己的开关关着，本会话也可用（beat 的 L1 技能补上）；
//   /cue off      → 全部回落到原状态，兄弟的持久文件一个字节都没变。
//
// 五个插件按桌面 profile 的加载顺序挂载（兄弟在前、conductor 最后），
// 正好覆盖「conductor 晚于兄弟加载」这个最容易出问题的顺序。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { apply as applyFade } from '../../dsh-novel-fade/index.js'
import { apply as applyVoice } from '../../dsh-novel-voice/index.js'
import { apply as applyFanfic } from '../../dsh-novel-fanfic/index.js'
import { apply as applyBeat } from 'file:///D:/插件/plugins/novel-beat/index.js'
import { apply as applyConductor } from '../index.js'

const noop = () => {}

function makeHost() {
  const tools = []
  const skills = []
  const commands = []
  const services = new Map()
  const listeners = new Map()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cue-drive-'))
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'cue-drive-state-'))

  const skillsApi = {
    register(skill) {
      skills.push(skill)
      return () => {
        const index = skills.indexOf(skill)
        if (index >= 0) skills.splice(index, 1)
      }
    },
  }
  const workingDirectory = {
    ensure: async () => dir,
    get: () => dir,
  }

  const ctx = {
    tools: {
      register(definition, options) {
        tools.push({ definition, when: options?.when })
        return noop
      },
      restrict() {
        return noop
      },
    },
    commands: {
      register(command) {
        commands.push(command)
        return noop
      },
      list: () => commands,
    },
    provide(key, api) {
      services.set(key, api)
    },
    get(key) {
      if (key === 'skills') return skillsApi
      if (key === 'commands') return ctx.commands
      if (key === 'workingDirectory') return workingDirectory
      if (key === 'agents') return { list: () => [] }
      return services.get(key)
    },
    effect(fn) {
      const result = fn()
      return typeof result === 'function' ? result : noop
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return noop
    },
    emit(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  }

  const agent = {
    id: 'session-drive',
    session: { id: 'session-drive' },
    ctx: {
      get: (key) => (key === 'skills' ? skillsApi : undefined),
      effect: (fn) => {
        const result = fn()
        return typeof result === 'function' ? result : noop
      },
      tools: { restrict: () => noop },
    },
  }

  return { ctx, tools, skills, commands, services, dir, stateDir, agent }
}

function snapshot(dir) {
  const out = {}
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = statSync(full)
    out[name] = stat.isFile() ? `${stat.size}:${readFileSync(full, 'utf8')}` : 'dir'
  }
  return out
}

const gateOf = (host, prefix) => host.tools
  .filter(({ definition }) => definition.name.startsWith(prefix))
  .map(({ definition, when }) => ({ name: definition.name, when }))

const isVisible = (entry, agent) => (typeof entry.when === 'function' ? entry.when({ agent }) === true : true)
const visibleCount = (entries, agent) => entries.filter((entry) => isVisible(entry, agent)).length

test('接管开关：关 → 兄弟不动；开 → 兄弟在关着开关时也可用；再关 → 回到原状且不写盘', async () => {
  const host = makeHost()
  const config = { root: host.dir, project: 'fixture-a', fixture: 'dsh-novel-fanfic/fixtures/fixture-a', stateDir: host.stateDir }

  // 桌面 profile 的加载顺序：fade → voice → fanfic → beat → conductor。
  await applyFade(host.ctx, config)
  await applyVoice(host.ctx, config)
  await applyFanfic(host.ctx, config)
  await applyBeat(host.ctx, config)
  await applyConductor(host.ctx, config)

  const cue = gateOf(host, 'cue_')
  const beat = gateOf(host, 'beat_')
  const memo = gateOf(host, 'memo_')
  const voice = gateOf(host, 'voice_')
  const fic = gateOf(host, 'fic_')
  assert.ok(cue.length > 0 && beat.length > 0 && memo.length > 0 && voice.length > 0 && fic.length > 0, '五个插件的工具都要抓到')

  const before = snapshot(host.dir)

  // 1) 默认关：五个插件一个都不可见。
  assert.equal(visibleCount(cue, host.agent), 0, 'conductor 关着时 cue_* 不应可见')
  assert.equal(visibleCount(beat, host.agent), 0, 'beat 自己的开关关着')
  assert.equal(visibleCount(fic, host.agent), 0, 'fanfic 默认关')
  assert.equal(host.skills.filter((skill) => skill.name === 'novel-beat').length, 0, 'beat 的 L1 技能不该在')

  // 2) /cue on：conductor 自己可见，兄弟四个即使自己的开关关着也要可见。
  const command = host.commands.find((item) => item.name === 'cue')
  assert.ok(command, '要注册 /cue 命令')

  const on = await command.handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(on.kind, 'success')
  await new Promise((resolve) => setTimeout(resolve, 60)) // 等 beat 的 refreshAgent 落定

  assert.equal(visibleCount(cue, host.agent), cue.length, 'conductor 开着时 cue_* 全部可见')
  assert.equal(visibleCount(beat, host.agent), beat.length, 'conductor 开着时 beat_* 可见（beat 自己没开）')
  assert.equal(visibleCount(memo, host.agent), memo.length, 'memo_* 可见')
  assert.equal(visibleCount(voice, host.agent), voice.length, 'voice_* 可见')
  assert.equal(visibleCount(fic, host.agent), fic.length, 'fic_* 可见')
  assert.equal(
    host.skills.filter((skill) => skill.name === 'novel-beat').length,
    1,
    'conductor 接管时 beat 的 L1 技能要补上（否则模型看得到工具、看不到硬规则）',
  )

  // 3) /cue off：全部回落到原状态，持久文件不变。
  const off = await command.handler({ agent: host.agent, rawInput: '/cue off' })
  assert.equal(off.kind, 'success')
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(visibleCount(cue, host.agent), 0, '关掉后 cue_* 不可见')
  assert.equal(visibleCount(beat, host.agent), 0, '关掉后 beat_* 不可见')
  assert.equal(visibleCount(memo, host.agent), 0)
  assert.equal(visibleCount(voice, host.agent), 0)
  assert.equal(visibleCount(fic, host.agent), 0)
  assert.equal(host.skills.filter((skill) => skill.name === 'novel-beat').length, 0, '关掉后 beat 技能撤下')

  assert.deepEqual(snapshot(host.dir), before, '接管只改内存：书架目录不能有任何新文件')
})

test('/cue status 会报开关状态，且不影响开关', async () => {
  const host = makeHost()
  await applyConductor(host.ctx, {})
  const command = host.commands.find((item) => item.name === 'cue')
  const on = await command.handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(on.kind, 'success')

  const start = await command.handler({ agent: host.agent, rawInput: '/cue status' })
  assert.equal(start.kind, 'success')
  assert.match(start.text, /舞台监督：开/)

  const off = await command.handler({ agent: host.agent, rawInput: '/cue off' })
  assert.equal(off.kind, 'success')
  const after = await command.handler({ agent: host.agent, rawInput: '/cue status' })
  assert.equal(after.kind, 'success')
  assert.match(after.text, /舞台监督：关/)
})
