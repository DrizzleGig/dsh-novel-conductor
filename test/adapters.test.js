import test from 'node:test'
import assert from 'node:assert/strict'

import { beatArtifact, probeBeat } from '../lib/adapters/beat.js'
import { fadeArtifact, fadeBrief, probeFade } from '../lib/adapters/fade.js'
import { probeVoice, voiceBrief } from '../lib/adapters/voice.js'

function ctxFor(services) {
  return { get: (name) => services[name] ?? null }
}

test('beat：没有服务时 installed:false，不伪造 ready', async () => {
  const probe = await probeBeat(ctxFor({}), { cwd: 'D:\\book', book: '书', chapter: 1 })
  assert.equal(probe.installed, false)
  assert.equal(probe.ready, false)
  assert.equal(probe.reason, 'no-service')
})

test('beat：服务返回 null（没有账本）时 installed:true，ready:false', async () => {
  const beat = {
    identity: () => ({ plugin: 'dsh-novel-beat', service_version: 1, version: '0.9.1' }),
    getStatus: async () => null,
    getRevision: async () => null,
  }
  const probe = await probeBeat(ctxFor({ novelBeat: beat }), { cwd: 'D:\\book', book: '书', chapter: 1 })
  assert.equal(probe.installed, true)
  assert.equal(probe.ready, false)
  assert.equal(probe.reason, 'no-book')
})

test('beat：getArtifact 扁平字段原样返回；服务异常变成 found:false', async () => {
  const beat = {
    async getArtifact({ artifactId }) {
      if (artifactId === 'boom') throw new Error('x')
      return { found: true, artifactId, kind: 'segment', revision: 9, revisionId: 'r-1', hash: 'h' }
    },
  }
  const found = await beatArtifact(ctxFor({ novelBeat: beat }), { cwd: 'D:\\book', book: '书', artifactId: 's-1' })
  assert.equal(found.found, true)
  assert.equal(found.revision, 9)
  const broken = await beatArtifact(ctxFor({ novelBeat: beat }), { cwd: 'D:\\book', book: '书', artifactId: 'boom' })
  assert.equal(broken.found, false)
  assert.equal(broken.reason, 'service-error')
})

test('fade：没有 memory 时 ready:false；brief 返回 available:false 而不是抛错', async () => {
  const fade = {
    identity: () => ({ plugin: 'dsh-novel-fade', service_version: 1, version: '0.7.1' }),
    getStatus: async () => null,
    getBrief: async () => null,
  }
  const probe = await probeFade(ctxFor({ novelFade: fade }), { cwd: 'D:\\book', book: '书' })
  assert.equal(probe.installed, true)
  assert.equal(probe.ready, false)
  const brief = await fadeBrief(ctxFor({ novelFade: fade }), { cwd: 'D:\\book', book: '书', chapter: 1 })
  assert.equal(brief.available, false)
  assert.equal(brief.reason, 'no-book')
})

test('fade：getArtifact 嵌套 artifact 时仍能取到 hash', async () => {
  const fade = {
    async getArtifact() {
      return { found: true, artifactId: 'd-1', revision: 5, artifact: { hash: 'h1', cards: 3 } }
    },
  }
  const artifact = await fadeArtifact(ctxFor({ novelFade: fade }), { cwd: 'D:\\book', book: '书', artifactId: 'd-1', verify: true })
  assert.equal(artifact.found, true)
  assert.equal(artifact.artifact.hash, 'h1')
})

test('voice：identity() 是函数；无档案的 brief 是 ok:false', async () => {
  const voice = {
    identity: () => ({ plugin: 'dsh-novel-voice', service_version: 1, version: '0.2.0' }),
    getStatus: async () => ({ profiles: [], revision: 0 }),
    getBrief: async () => ({ ok: false, code: 'no-profile', message: '还没有档案' }),
  }
  const probe = await probeVoice(ctxFor({ novelVoice: voice }), { cwd: 'D:\\book', book: '书' })
  assert.equal(probe.installed, true)
  assert.equal(probe.ready, false)
  assert.equal(probe.reason, 'no-profile')
  const brief = await voiceBrief(ctxFor({ novelVoice: voice }), { cwd: 'D:\\book', book: '书', chapter: 1 })
  assert.equal(brief.available, false)
  assert.equal(brief.reason, 'no-profile')
})

test('voice：有档案时 ready:true，brief 带 revision/tokens', async () => {
  const voice = {
    identity: () => ({ plugin: 'dsh-novel-voice', service_version: 1, version: '0.2.0' }),
    getStatus: async () => ({ profiles: [{ id: 'p-1' }], revision: 7 }),
    getBrief: async () => ({ ok: true, markdown: '短句。', chars: 3, tokens: 2, revision: 7 }),
  }
  const probe = await probeVoice(ctxFor({ novelVoice: voice }), { cwd: 'D:\\book', book: '书' })
  assert.equal(probe.ready, true)
  assert.equal(probe.revision, 7)
  const brief = await voiceBrief(ctxFor({ novelVoice: voice }), { cwd: 'D:\\book', book: '书', chapter: 1 })
  assert.equal(brief.available, true)
  assert.equal(brief.tokens, 2)
})
