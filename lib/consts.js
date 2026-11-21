// lib/consts.js — one place for names, steps and limits.

export const PLUGIN_NAME = 'dsh-novel-conductor'
export const VERSION = '0.1.0'
export const ROOT_DIR = '.dsh-novel-conductor'
export const SCHEMA_VERSION = 1

/** The six steps plus one pause. `await_author` is a state, never a step. */
export const STEP_IDS = Object.freeze([
  'preflight',
  'write',
  'segment',
  'verify',
  'digest',
  'close',
])

export const STEP_LABEL = Object.freeze({
  preflight: '装配上下文与能力矩阵',
  write: '写正文',
  segment: '登记段落并回查 beat 产物',
  verify: '校验正文与风格',
  digest: '把本章交给 fade 沉淀',
  close: '收尾并记录已核验产物',
})

/** Tool names whose resulting receipts prove a step actually happened. */
export const RECEIPT_TOOLS = Object.freeze({
  segment: Object.freeze(['beat_segment']),
  // fanfic 的 verify 只认 fic_check 的 pass（waiver 已在服务端应用）
  verify: Object.freeze(['beat_verify', 'voice_check', 'fic_check']),
  digest: Object.freeze(['memo_digest']),
})

/** Four-segment context budget (characters, not tokens). */
export const BUDGET = Object.freeze({
  beat: 800,
  fanfic: 800,
  fade: 1400,
  voice: 600,
})

export const RUN_STATES = Object.freeze([
  'preflighting',
  'awaiting_author',
  'writing',
  'segmenting',
  'verifying',
  'digesting',
  'closing',
  'completed',
  'failed',
  'blocked',
  'aborted',
])

// `failed` is recoverable through cue_run(resume); it is not terminal.
export const TERMINAL_STATES = Object.freeze(new Set(['completed', 'blocked', 'aborted']))

export const CAPABILITIES = Object.freeze(['beat', 'fanfic', 'fade', 'voice'])

export const DEFAULT_TASK_TYPE = 'chapter_write'
