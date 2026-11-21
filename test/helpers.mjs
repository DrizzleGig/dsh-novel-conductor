import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

export async function workspace(prefix = 'conductor-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export function fakeBeat({
  revision = 10,
  status = { book: '书', chapter: 1, pending: [], openDecisions: 0, chapterState: 'writing', revision },
  canon = { schemaVersion: 2, revision, canon: [{ entity: '人物', key: '名字', value: '林砚', chapter: 1 }], obligations: [], decisions: [] },
  artifacts = {},
} = {}) {
  return {
    identity() {
      return {
        plugin: 'dsh-novel-beat', version: '0.9.1', service_version: 1,
        capabilities: ['beat.status', 'beat.revision', 'beat.canon', 'beat.artifact'],
        dir: '.dsh-novel-beat', readOnly: true,
      }
    },
    async getStatus() { return status },
    async getRevision() { return { revision, updatedAt: '2026-11-21T00:00:00.000Z' } },
    async getCanon() { return canon },
    async getArtifact({ artifactId }) {
      return artifacts[artifactId] ?? { found: false, artifactId }
    },
  }
}

export function fakeFade({ revision = 20, brief = '记忆简报：林砚在雪夜回到旧宅。', status = null, artifacts = {} } = {}) {
  return {
    identity() {
      return {
        plugin: 'dsh-novel-fade', version: '0.7.1', service_version: 1,
        capabilities: ['fade.brief', 'fade.status', 'fade.revision', 'fade.artifact'],
        dir: '.dsh-novel-fade', readOnly: true,
      }
    },
    async getStatus() {
      return status ?? { book: '书', chapters: 3, cards: 12, revision }
    },
    async getRevision() { return { revision } },
    async getBrief() {
      return { markdown: brief, chars: [...brief].length, revision, generated_at: '2026-11-21T00:00:00.000Z' }
    },
    async getArtifact({ artifactId }) {
      return artifacts[artifactId] ?? { found: false, artifactId, reason: 'not-found' }
    },
  }
}

export function fakeVoice({ revision = 30, markdown = '风格简报：短句，少形容词。', profiles = [{ id: 'p-1' }] } = {}) {
  return {
    identity() {
      return {
        plugin: 'dsh-novel-voice', version: '0.2.0', service_version: 1,
        capabilities: ['voice.brief', 'voice.status', 'voice.revision'],
        dir: '.dsh-novel-voice', readOnly: true,
      }
    },
    async getStatus() { return { book: '书', profiles, revision } },
    async getRevision() { return { revision } },
    async getBrief() {
      return { ok: true, markdown, chars: [...markdown].length, tokens: 10, revision, generated_at: '2026-11-21T00:00:00.000Z' }
    },
  }
}

export async function createHost({ cwd, services = {}, agents = [] } = {}) {
  const registered = []
  const commands = []
  const skills = []
  const listeners = []
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => cwd }
      if (name === 'agents') return { list: () => agents }
      if (name === 'commands') return { register(command) { commands.push(command); return () => {} } }
      if (name === 'skills') return { register(skill) { skills.push(skill); return () => {} } }
      return services[name] ?? null
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, handler) {
      if (name === 'tools/result') listeners.push(handler)
      return () => {}
    },
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
        return () => {}
      },
    },
  }
  await apply(ctx)
  return {
    ctx,
    registered,
    commands,
    skills,
    services,
    async emit(exec, result) {
      for (const listener of listeners) await listener(exec, result)
    },
  }
}

export function exec(name, agentId, args, callId) {
  return { name, agent: { id: agentId }, arguments: args, callId }
}

export function result(value, isError = false) {
  return { isError, value }
}

export async function writeFile(cwd, rel, text) {
  const file = path.join(cwd, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
  return file
}
