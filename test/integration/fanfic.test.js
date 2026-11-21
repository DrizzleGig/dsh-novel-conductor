// 真 adapter + 真 fanfic 服务（不 mock）：probe / contract 走真实 .dsh-novel-fanfic 项目，
// verify 只认 fic_check 收据里的 pass:true。fanfic 仓与 conductor 仓是同胞目录，
// 这里跨仓相对导入，和 beat 的集成测试同一做法。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createService } from '../../../dsh-novel-fanfic/lib/service.mjs'
import { ingestFile } from '../../../dsh-novel-fanfic/lib/ingest.mjs'
import { loadProject, chapterBody, saveCanon } from '../../../dsh-novel-fanfic/lib/canon-store.mjs'
import { applyProposals, confirmEntries } from '../../../dsh-novel-fanfic/lib/proposals.mjs'
import { probeFanfic, fanficContract } from '../../lib/adapters/fanfic.js'
import { startRun, stepRun, probeCapabilities } from '../../lib/run-machine.js'
import { createHost, exec, result, writeFile } from '../helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const fixtureDir = path.join(repoRoot, 'dsh-novel-fanfic', 'fixtures', 'fixture-a')
const AGENT = 'agent-fic'

/** 建一个真实的同人项目：导入夹具原文 → 灌提案 → 全部确认。 */
async function fanficProject() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-fanfic-'))
  await ingestFile({ root: cwd, project: 'fic', file: path.join(fixtureDir, 'source.md') })
  const loaded = await loadProject(cwd, 'fic')
  const texts = new Map()
  for (const ch of loaded.index.chapters) texts.set(ch.id, await chapterBody(cwd, 'fic', ch.id))
  const files = (await fs.readdir(path.join(fixtureDir, 'proposals'))).filter((f) => f.endsWith('.json')).sort()
  const list = []
  for (const file of files) list.push(...JSON.parse(await fs.readFile(path.join(fixtureDir, 'proposals', file), 'utf8')))
  applyProposals(loaded.canon, list, texts)
  const ids = []
  for (const bucket of ['characters', 'facts', 'worldRules', 'secrets', 'addresses']) {
    for (const row of loaded.canon[bucket] || []) if (row.status === 'pending') ids.push(row.id)
  }
  confirmEntries(loaded.canon, ids)
  await saveCanon(cwd, 'fic', loaded.canon)
  return cwd
}

function ctxWith(services) {
  return { get: (name) => services[name] ?? null, logger: { warn() {} } }
}

test('fanfic：没装服务时 installed:false，不伪造 ready（不写 not-adapted）', async () => {
  const probe = await probeFanfic(ctxWith({}), { cwd: 'D:\\book' })
  assert.equal(probe.installed, false)
  assert.equal(probe.ready, false)
  assert.equal(probe.reason, 'no-service')
})

test('fanfic：真服务 + 真项目 → installed/ready，contract 返回分段', async () => {
  const cwd = await fanficProject()
  const service = createService({ version: '0.2.0', subscribe: () => () => {} })
  const ctx = ctxWith({ novelFanfic: service })
  const probe = await probeFanfic(ctx, { cwd, project: 'fic' })
  assert.equal(probe.installed, true)
  assert.equal(probe.ready, true)
  assert.equal(probe.project, 'fic')
  assert.ok(Number.isInteger(probe.revision))
  assert.equal(probe.identity.plugin, 'dsh-novel-fanfic')

  const contract = await fanficContract(ctx, { cwd, project: 'fic', chapter: 'ch002' })
  assert.equal(contract.available, true)
  assert.ok(contract.sections && Object.keys(contract.sections).length >= 9)
  assert.ok(contract.markdown.startsWith('# 场景契约 ch002'))
  assert.ok(Number.isInteger(contract.revision))
})

test('fanfic：缺项目时 ready:false + reason，不抛错（分支能力可降级）', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-empty-'))
  const service = createService({ version: '0.2.0', subscribe: () => () => {} })
  const probe = await probeFanfic(ctxWith({ novelFanfic: service }), { cwd, project: 'nope' })
  assert.equal(probe.installed, true)
  assert.equal(probe.ready, false)
  assert.equal(probe.reason, 'NO_PROJECT')
})

test('能力矩阵里 fanfic 是真实探测结果，不再是写死的 not-adapted', async () => {
  const cwd = await fanficProject()
  const service = createService({ version: '0.2.0', subscribe: () => () => {} })
  const ctx = ctxWith({ novelFanfic: service })
  const matrix = await probeCapabilities(ctx, { cwd, book: '雾港', chapter: 2 })
  assert.equal(matrix.fanfic.installed, true)
  assert.equal(matrix.fanfic.ready, true)
  if (matrix.fanfic.reason) assert.notEqual(matrix.fanfic.reason, 'not-adapted')
  assert.equal(matrix.beat.installed, false, '没有 beat 服务时 beat 仍是 not installed')
})

test('verify：fic_check 的 pass:true 才算过；pass:false 判 verify-failed', async () => {
  const cwd = await fanficProject()
  const service = createService({ version: '0.2.0', subscribe: () => () => {} })
  const host = await createHost({ cwd, services: { novelFanfic: service } })
  const started = await startRun(host.ctx, {
    cwd, agentId: AGENT, book: '雾港', chapter: 2, requiredCapabilities: ['fanfic'],
  })
  assert.equal(started.ok, true, JSON.stringify(started))
  const runId = started.run.runId
  assert.equal(started.run.capabilityMatrix.fanfic.ready, true)
  // 世界契约段真的进了上下文（≤800 字）
  assert.ok(started.context && started.context.segments && started.context.segments.fanfic, '上下文里应有 fanfic 段')
  assert.equal(started.context.segments.fanfic.available, true)
  assert.ok(started.context.segments.fanfic.chars <= 800)
  await writeFile(cwd, '正文/ch002.md', '沈砚没应声。')
  const write = await stepRun(host.ctx, {
    cwd, runId, agentId: AGENT, stepId: 'write', status: 'done',
    artifact: { path: '正文/ch002.md', chars: 7 },
    note: 'write 只认文件',
  })
  assert.equal(write.ok, true, JSON.stringify(write))

  // 造一条 fic_check 收据：pass:false（还有 blocker）
  await host.emit(
    exec('fic_check', AGENT, { chapter: 'ch002', source: 'canon' }, 'call-fic-1'),
    result({ ok: true, text: 'blocker 1', status: 'completed', pass: false, source: 'canon', revision: 3, summary: { blockers: 1, waived: 0 } }),
  )
  const failed = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify', status: 'done' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'verify-failed')

  // 夹具数据不算真书验收：source:'fixture' 的 pass:true 也必须被拒
  await host.emit(
    exec('fic_check', AGENT, { chapter: 'ch002', source: 'fixture' }, 'call-fic-fixture'),
    result({ ok: true, text: 'pass', status: 'completed', pass: true, source: 'fixture', revision: 3, summary: { blockers: 0 } }),
  )
  const fixturePass = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify', status: 'done' })
  assert.equal(fixturePass.ok, false)
  assert.equal(fixturePass.code, 'fixture-source')

  // 再补一条 canon + pass:true（waiver 在服务端已应用）：verify 通过
  await host.emit(
    exec('fic_check', AGENT, { chapter: 'ch002', source: 'canon' }, 'call-fic-2'),
    result({ ok: true, text: 'pass', status: 'completed', pass: true, source: 'canon', revision: 3, summary: { blockers: 0, waived: 1 } }),
  )
  const passed = await stepRun(host.ctx, { cwd, runId, agentId: AGENT, stepId: 'verify', status: 'done' })
  assert.equal(passed.ok, true, JSON.stringify(passed))
})
