// 接管开关的模拟验收（不起 DSH 宿主）。
//
// 语义（2026-11-21 作者定稿）：
//   装了 conductor：它就是总开关——关着时四个插件全都不工作（哪怕它们自己的开关开着）；
//                  开着时四个插件可用（哪怕它们自己的开关关着）；
//   beat / fade / voice / fanfic 自己的开关优先级更低，只在「没装 conductor」时生效。
//
// 五个插件按桌面 profile 的加载顺序挂载（兄弟在前、conductor 最后），
// 覆盖「conductor 晚于兄弟加载」这个最容易出问题的顺序。

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

const gatesOf = (host, prefix) => host.tools
  .filter(({ definition }) => definition.name.startsWith(prefix))
  .map(({ definition, when }) => ({ name: definition.name, when }))

const isVisible = (entry, agent) => (typeof entry.when === 'function' ? entry.when({ agent }) === true : true)
const visibleCount = (entries, agent) => entries.filter((entry) => isVisible(entry, agent)).length

const config = (host) => ({
  root: host.dir,
  project: 'fixture-a',
  fixture: 'dsh-novel-fanfic/fixtures/fixture-a',
  stateDir: host.stateDir,
})

async function mountSeries(host) {
  await applyFade(host.ctx, config(host))
  await applyVoice(host.ctx, config(host))
  await applyFanfic(host.ctx, config(host))
  await applyBeat(host.ctx, config(host))
  await applyConductor(host.ctx, config(host))
}

const command = (host, name) => host.commands.find((item) => item.name === name)
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

test('装了 conductor：关着时四个插件全都不工作；开着时全都可用；再关回到全不可用且不写盘', async () => {
  const host = makeHost()
  await mountSeries(host)

  const cue = gatesOf(host, 'cue_')
  const beat = gatesOf(host, 'beat_')
  const memo = gatesOf(host, 'memo_')
  const voice = gatesOf(host, 'voice_')
  const fic = gatesOf(host, 'fic_')
  assert.ok(cue.length > 0 && beat.length > 0 && memo.length > 0 && voice.length > 0 && fic.length > 0)

  const before = snapshot(host.dir)

  // 1) 全关：十个工具都不可见，也没有 beat 的 L1 技能。
  assert.equal(visibleCount(cue, host.agent), 0)
  assert.equal(visibleCount(beat, host.agent), 0)
  assert.equal(visibleCount(memo, host.agent), 0)
  assert.equal(visibleCount(voice, host.agent), 0)
  assert.equal(visibleCount(fic, host.agent), 0)
  assert.equal(host.skills.filter((skill) => skill.name === 'novel-beat').length, 0)

  // 2) /cue on：五个插件全部可用（兄弟自己的开关都还关着）。
  const on = await command(host, 'cue').handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(on.kind, 'success')
  await wait()
  assert.equal(visibleCount(cue, host.agent), cue.length)
  assert.equal(visibleCount(beat, host.agent), beat.length)
  assert.equal(visibleCount(memo, host.agent), memo.length)
  assert.equal(visibleCount(voice, host.agent), voice.length)
  assert.equal(visibleCount(fic, host.agent), fic.length)
  assert.equal(host.skills.filter((skill) => skill.name === 'novel-beat').length, 1, 'beat 的 L1 技能要一起补上')

  // 3) /cue off：全部收回，书架目录字节不变。
  const off = await command(host, 'cue').handler({ agent: host.agent, rawInput: '/cue off' })
  assert.equal(off.kind, 'success')
  await wait()
  assert.equal(visibleCount(cue, host.agent), 0)
  assert.equal(visibleCount(beat, host.agent), 0)
  assert.equal(visibleCount(memo, host.agent), 0)
  assert.equal(visibleCount(voice, host.agent), 0)
  assert.equal(visibleCount(fic, host.agent), 0)
  assert.equal(host.skills.filter((skill) => skill.name === 'novel-beat').length, 0)
  assert.deepEqual(snapshot(host.dir), before)
})

test('装了 conductor：兄弟自己的开关优先级更低——/fic on 了也不生效；没装 conductor 时才按自己的开关', async () => {
  // A. 装了 conductor、关着：/fic on 之后 fic_* 仍然不可见（总开关说话）。
  const host = makeHost()
  await applyFanfic(host.ctx, config(host))
  await applyConductor(host.ctx, config(host))
  const fic = gatesOf(host, 'fic_')
  const cue = gatesOf(host, 'cue_')

  const ficOn = await command(host, 'fic').handler({ agent: host.agent, rawInput: 'on' })
  assert.equal(ficOn.kind, 'success')
  assert.equal(visibleCount(fic, host.agent), 0, 'conductor 关着时，fanfic 自己的 /fic on 不生效')

  await command(host, 'cue').handler({ agent: host.agent, rawInput: '/cue on' })
  assert.equal(visibleCount(cue, host.agent), cue.length)
  assert.equal(visibleCount(fic, host.agent), fic.length, 'conductor 开着时 fanfic 可用')

  await command(host, 'cue').handler({ agent: host.agent, rawInput: '/cue off' })
  assert.equal(visibleCount(fic, host.agent), 0, '再关掉 conductor，fic_* 又不可见（/fic on 的状态不覆盖它）')

  // B. 没装 conductor：/fic on 照旧生效（独立模式不变）。
  const solo = makeHost()
  await applyFanfic(solo.ctx, config(solo))
  const soloFic = gatesOf(solo, 'fic_')
  assert.equal(visibleCount(soloFic, solo.agent), 0)
  const soloOn = await command(solo, 'fic').handler({ agent: solo.agent, rawInput: 'on' })
  assert.equal(soloOn.kind, 'success')
  assert.equal(visibleCount(soloFic, solo.agent), soloFic.length, '没装 conductor 时 /fic on 就是开着')
})
