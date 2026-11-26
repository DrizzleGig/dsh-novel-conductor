// lib/runbook.js — the phase plan the model reads. It is data, not a second
// state machine: the executor still walks `run.steps`; this plan explains what
// should be called, when, and which skill to load.

export const RUNBOOK_VERSION = 'chapter-write/v2'

const CAPABILITY_CALLS = {
  'beat.segment': ['beat_segment'],
  'beat.verify': ['beat_verify'],
  'voice.check': ['voice_check'],
  'voice.brief': ['voice_brief'],
  'fade.brief': ['memo_brief'],
  'fade.digest': ['memo_digest'],
  'fic.check': ['fic_check'],
  'fic.canon': ['fic_contract'],
}

export const DEFAULT_PHASES = Object.freeze([
  { id: 'preflight', calls: ['cue_status'], skills: [], budget: null, gate: null },
  {
    id: 'context',
    prefer: ['fade.brief', 'voice.brief', 'fic.canon'],
    calls: ['memo_brief', 'voice_brief', 'fic_canon'],
    skills: ['novel-fade', 'novel-voice'],
    budget: { memo: 1400, voice: 600, fanfic: 800 },
    gate: null,
  },
  { id: 'plan', prefer: ['kit.plan'], calls: ['novel_plan'], skills: ['novel-kit'], budget: null, gate: null },
  { id: 'await_author', when: 'beat.pending', calls: [], skills: ['novel-beat'], budget: null, gate: 'author' },
  { id: 'write', calls: ['write'], skills: ['novel-voice'], budget: null, gate: null },
  { id: 'voice_pass', prefer: ['voice.check'], calls: ['voice_check'], skills: [], budget: null, gate: null },
  { id: 'segment', requires: ['beat.segment'], calls: ['beat_segment'], skills: ['novel-beat'], budget: null, gate: null },
  {
    id: 'verify',
    requires: ['beat.verify'],
    prefer: ['voice.check', 'fic.check'],
    calls: ['beat_verify', 'voice_check', 'fic_check'],
    skills: [],
    budget: null,
    gate: null,
  },
  { id: 'digest', requires: ['fade.digest'], calls: ['memo_digest'], skills: ['novel-fade'], budget: null, gate: null },
  { id: 'close', calls: ['cue_step'], skills: [], budget: null, gate: null },
])

function capabilityEntry(matrix, name) {
  const family = name.startsWith('fic.') ? 'fanfic' : name.split('.')[0]
  return matrix?.[family] ?? null
}

export function buildRunbook(matrix, { taskType = 'chapter_write' } = {}) {
  const phases = DEFAULT_PHASES.map((phase) => {
    const required = Array.isArray(phase.requires) ? phase.requires : []
    const preferred = Array.isArray(phase.prefer) ? phase.prefer : []
    const missing = required.filter((name) => {
      const entry = capabilityEntry(matrix, name)
      return !entry?.installed || !entry?.ready
    })
    const skipped = preferred.filter((name) => {
      const entry = capabilityEntry(matrix, name)
      return !entry?.installed || !entry?.ready
    })
    return {
      id: phase.id,
      status: missing.length ? 'blocked' : 'ready',
      required,
      missing,
      skipped,
      calls: (phase.calls ?? []).filter((tool) => {
        // Drop capability-backed calls that are not available, keep core calls.
        const capability = Object.keys(CAPABILITY_CALLS).find((key) => CAPABILITY_CALLS[key].includes(tool))
        if (!capability) return true
        const entry = capabilityEntry(matrix, capability)
        return Boolean(entry?.installed && entry.ready)
      }),
      skills: phase.skills ?? [],
      budget: phase.budget ?? null,
      gate: phase.gate ?? null,
      when: phase.when ?? null,
    }
  })
  return {
    version: RUNBOOK_VERSION,
    taskType,
    phases,
    notes: [
      '数量不设上限；没有岔路的章节允许零决策。',
      '阶段顺序由 conductor 解析，模型不能改。',
      '技能只列本阶段需要的，不超过 3 个。',
    ],
  }
}
