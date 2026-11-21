// lib/session.js — bind an agent to the cwd/run it is actually using.
//
// `workingDirectory.ensure(agent)` returns the session's default workspace, but
// a tool call may pass an explicit `cwd`. The receipt bus must follow the run,
// not the session default. This in-process map is the bridge; after a host
// restart it is rebuilt by the next cue_run/cue_step/cue_status call.

const KEY = Symbol.for('dsh-novel-conductor.sessions')

function sessions() {
  let map = globalThis[KEY]
  if (!(map instanceof Map)) {
    map = new Map()
    globalThis[KEY] = map
  }
  return map
}

export function noteRun(agentId, cwd, runId) {
  if (!agentId || !cwd || !runId) return
  sessions().set(agentId, { cwd, runId })
}

export function activeRunOf(agentId) {
  return sessions().get(agentId) ?? null
}

export function clearRun(agentId) {
  if (agentId) sessions().delete(agentId)
}
