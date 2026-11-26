import test from 'node:test'
import assert from 'node:assert/strict'

import { createHost, exec, fakeBeat, result, workspace, writeFile } from './helpers.mjs'

const AGENT = 'agent-1'

test('插件：注册 7 个 cue_* 工具（run/step/status/scope/locks/tools/call）与 /cue 命令', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd, services: { novelBeat: fakeBeat() } })
  assert.deepEqual(
    host.registered.map(({ definition }) => definition.name).sort(),
    ['cue_call', 'cue_locks', 'cue_run', 'cue_scope', 'cue_status', 'cue_step', 'cue_tools'],
  )
  assert.equal(host.commands.length, 1)
  assert.equal(host.commands[0].name, 'cue')
})

test('工具：cue_run(start) → cue_status → cue_step(write) → close（solo）', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }

  const started = await tool('cue_run').execute({ action: 'start', book: '书', chapter: 1 }, who)
  assert.equal(started.ok, true)
  assert.equal(started.run.state, 'writing')
  const runId = started.run.runId

  const status = await tool('cue_status').execute({ runId, view: 'steps' }, who)
  assert.equal(status.ok, true)
  assert.equal(status.runId, runId)
  assert.equal(status.steps.length, 3)

  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  const write = await tool('cue_step').execute({ runId, stepId: 'write', artifact: { path: '正文/第1章.md' } }, who)
  assert.equal(write.ok, true)

  const close = await tool('cue_step').execute({ runId, stepId: 'close' }, who)
  assert.equal(close.ok, true)
  assert.equal(close.run.state, 'completed')
})

test('工具：cue_step(preflight) 被拒绝；错误参数返回结构化错误', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }

  const bad = await tool('cue_run').execute({ action: 'start', chapter: 1 }, who)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad-book')

  const started = await tool('cue_run').execute({ action: 'start', book: '书', chapter: 1 }, who)
  const preflight = await tool('cue_step').execute({ runId: started.run.runId, stepId: 'preflight' }, who)
  assert.equal(preflight.ok, false)
  assert.equal(preflight.code, 'preflight-auto')
})

test('工具：idempotencyKey 重复提交只记一次', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }
  const started = await tool('cue_run').execute({ action: 'start', book: '书', chapter: 1 }, who)
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  const first = await tool('cue_step').execute({
    runId: started.run.runId, stepId: 'write', artifact: { path: '正文/第1章.md' }, idempotencyKey: 'w1',
  }, who)
  assert.equal(first.ok, true)
  const second = await tool('cue_step').execute({
    runId: started.run.runId, stepId: 'write', artifact: { path: '正文/第1章.md' }, idempotencyKey: 'w1',
  }, who)
  assert.equal(second.idempotent, true)
  assert.equal(second.run.currentStep, 'close')
})

test('工具：cue_run(abort) 结束 run；/cue status 能读', async () => {
  const cwd = await workspace()
  const host = await createHost({ cwd, services: { novelBeat: fakeBeat() } })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }
  const started = await tool('cue_run').execute({ action: 'start', book: '书', chapter: 1 }, who)
  const aborted = await tool('cue_run').execute({ action: 'abort', runId: started.run.runId, reason: '换章' }, who)
  assert.equal(aborted.ok, true)
  assert.equal(aborted.run.state, 'aborted')

  const reply = await host.commands[0].handler({ agent: { id: AGENT }, rawInput: 'status' })
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /aborted/)
})

test('工具：收据经宿主 tools/result 进入 run，segment 能回查', async () => {
  const cwd = await workspace()
  const hash = 'e'.repeat(64)
  const beat = fakeBeat({ artifacts: { 's-1': { found: true, kind: 'segment', revision: 11, revisionId: 'r-1', hash } } })
  const host = await createHost({ cwd, services: { novelBeat: beat } })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }
  const started = await tool('cue_run').execute({
    action: 'start', book: '书', chapter: 1, required_capabilities: ['beat'],
  }, who)
  const runId = started.run.runId
  await writeFile(cwd, '正文/第1章.md', '他推开门。')
  await tool('cue_step').execute({ runId, stepId: 'write', artifact: { path: '正文/第1章.md' } }, who)

  await host.emit(
    exec('beat_segment', AGENT, { book: '书', chapter: 1 }, 'call-seg'),
    result({ ok: true, segmentId: 's-1', segment: { id: 's-1', hash } }),
  )
  const segment = await tool('cue_step').execute({ runId, stepId: 'segment', artifact: { artifactId: 's-1' } }, who)
  assert.equal(segment.ok, true)
  assert.equal(segment.run.steps.find((step) => step.id === 'segment').verified, true)
})


test('命令：显式 cwd 启动后，/cue status 查的是 run 所在目录', async () => {
  const sessionCwd = await workspace()
  const runCwd = await workspace()
  const host = await createHost({ cwd: sessionCwd, services: { novelBeat: fakeBeat() } })
  const tool = (name) => host.registered.find(({ definition }) => definition.name === name).definition
  const who = { agent: { id: AGENT } }
  const started = await tool('cue_run').execute({ action: 'start', cwd: runCwd, book: '书', chapter: 1 }, who)
  assert.equal(started.ok, true)

  const reply = await host.commands[0].handler({ agent: { id: AGENT }, rawInput: 'status' })
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, new RegExp(started.run.runId))
})
