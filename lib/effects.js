// lib/effects.js — one classification for "may this tool mutate the book?".
// A tool name alone is never trusted for authorization; this is only the lock
// scope. ProviderPolicy still decides whether a third-party tool may run.

const READ_ONLY = new Set([
  'beat_list', 'beat_next', 'beat_gate',
  'memo_brief', 'memo_recall', 'memo_state', 'memo_check', 'memo_source', 'memo_companions',
  'voice_brief', 'voice_check',
  'fic_state', 'fic_lookup', 'fic_contract', 'fic_check', 'fic_analyze',
])

// conductor 只管理五件自己的工具。kit 是独立产品（novel_*），不得由总控开关
// 或 scope 守卫接管；否则 all-six 时关着总控会连 kit 一起拦掉。
const MANAGED_PREFIXES = ['beat_', 'memo_', 'voice_', 'fic_']

export function isManagedTool(name) {
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Conservative write classification. Unknown managed tools are treated as
 * writes so a lock is taken; unmanaged tools are handled by ProviderPolicy.
 */
export function isWriteTool(name) {
  if (typeof name !== 'string' || !name) return false
  if (name === 'write' || name === 'edit') return true
  if (!isManagedTool(name)) return false
  if (READ_ONLY.has(name)) return false
  return true
}
