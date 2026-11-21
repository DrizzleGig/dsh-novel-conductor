// lib/receipt.js — turn a host `tools/result` event into a small, durable
// receipt. The event payload has no cwd/runId/step, so scope is bound here:
// agent + book/chapter + the current step window. Anything outside the window
// is ignored rather than guessed into the run.

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { RECEIPT_TOOLS } from './consts.js'

const DROPPED_KEYS = new Set([
  'text', 'body', 'content', 'markdown', 'brief', 'chapterText', 'sourceText',
])

function clip(value, max = 400) {
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Keep receipts small and never copy prose from a sibling tool. */
export function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return clip(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 3) return '[depth]'

  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactValue(item, depth + 1))
    if (value.length > 20) items.push(`[+${value.length - 20} more]`)
    return items
  }

  if (typeof value === 'object') {
    const out = {}
    let count = 0
    for (const [key, item] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key)) {
        out[`${key}Omitted`] = true
        continue
      }
      if (count >= 40) {
        out.truncated = true
        break
      }
      out[key] = compactValue(item, depth + 1)
      count += 1
    }
    return out
  }

  return clip(String(value), 80)
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

export function receiptId(exec, value) {
  const direct = exec?.callId ?? exec?.id ?? exec?.toolCallId
  if (typeof direct === 'string' && direct.trim()) return direct
  const agentId = exec?.agent?.id ?? ''
  const name = exec?.name ?? ''
  const args = exec?.arguments ?? exec?.args ?? {}
  return `auto-${createHash('sha1').update(`${agentId}|${name}|${stable(args)}|${stable(value)}`).digest('hex').slice(0, 20)}`
}

export function projectValue(tool, value) {
  if (!value || typeof value !== 'object') return compactValue(value)
  if (tool === 'memo_digest') {
    return {
      ok: value.ok,
      receipt: compactValue(value.receipt),
      revision: value.revision,
      cards: Array.isArray(value.cards) ? value.cards.length : null,
    }
  }
  if (tool === 'beat_segment') {
    const segment = value.segment && typeof value.segment === 'object'
      ? { id: value.segment.id, hash: value.segment.hash, revisionId: value.segment.revisionId, chars: value.segment.chars }
      : null
    return { ok: value.ok, segmentId: value.segmentId, revision: value.revision, segment }
  }
  if (tool === 'beat_verify') {
    return {
      ok: value.ok,
      verified: value.verified,
      pass: value.pass,
      revision: value.revision,
      failures: Array.isArray(value.failures) ? value.failures.length : null,
      warnings: Array.isArray(value.warnings) ? value.warnings.length : null,
    }
  }
  if (tool === 'voice_check') {
    return {
      ok: value.ok,
      status: value.status,
      pass: value.pass,
      revision: value.revision,
      findings: Array.isArray(value.findings) ? value.findings.length : null,
      findingsPreview: Array.isArray(value.findings) ? value.findings.slice(0, 3).map((item) => compactValue(item)) : null,
    }
  }
  if (tool === 'fic_check') {
    // 只留判定需要的：来源（fixture 不算真书验收）、版本、结论、计数与前三条例证。
    return {
      ok: value.ok,
      status: value.status,
      pass: value.pass,
      source: value.source,
      revision: value.revision,
      summary: value.summary ? compactValue(value.summary) : null,
      findings: Array.isArray(value.findings) ? value.findings.length : null,
      findingsPreview: Array.isArray(value.findings) ? value.findings.slice(0, 3).map((item) => compactValue(item)) : null,
      waived: Array.isArray(value.waived) ? value.waived.length : null,
    }
  }
  return compactValue(value)
}

export function normalizeReceipt(exec, result, { seq, at } = {}) {
  const args = exec?.arguments ?? exec?.args ?? {}
  const value = result?.value ?? null
  const tool = typeof exec?.name === 'string' ? exec.name : ''
  return {
    seq: Number.isInteger(seq) ? seq : 0,
    id: receiptId(exec, value),
    tool,
    agentId: exec?.agent?.id ?? null,
    book: typeof args.book === 'string' ? args.book : null,
    dir: typeof args.dir === 'string' ? args.dir : (typeof args.cwd === 'string' ? args.cwd : null),
    chapter: Number.isInteger(args.chapter) ? args.chapter : null,
    isError: result?.isError === true,
    at: at ?? new Date().toISOString(),
    value: projectValue(tool, value),
  }
}

export function isSuccess(receipt) {
  if (!receipt || receipt.isError === true) return false
  return receipt.value?.ok !== false
}

/** Does this receipt belong to the step's open window and expected tools? */
export function matchesStep(receipt, step) {
  if (!receipt || !step) return false
  const expected = RECEIPT_TOOLS[step.id] ?? []
  if (!expected.includes(receipt.tool)) return false
  return Number(receipt.seq ?? 0) > Number(step.windowStart ?? 0)
}

/** Bind an event to a run without inventing cwd/agent facts. */
export function matchesRun(run, step, receipt) {
  if (!run || !receipt) return false
  if (receipt.agentId && run.agentId && receipt.agentId !== run.agentId) return false
  if (!receipt.agentId) return false
  if (run.book && receipt.book && receipt.book !== run.book) return false
  if (receipt.dir && run.cwd) {
    if (!isAbsolute(receipt.dir) || resolve(receipt.dir) !== resolve(run.cwd)) return false
  }
  if (Number.isInteger(run.chapter) && Number.isInteger(receipt.chapter) && receipt.chapter !== run.chapter) return false
  return matchesStep(receipt, step)
}

export function findReceipts(receipts, step, tools = null) {
  const expected = tools ?? RECEIPT_TOOLS[step?.id] ?? []
  return receipts.filter((receipt) => (
    expected.includes(receipt.tool)
    && Number(receipt.seq ?? 0) > Number(step?.windowStart ?? 0)
  ))
}

export function dedupeReceipts(receipts) {
  const seen = new Set()
  const out = []
  for (const receipt of receipts) {
    const key = receipt.id ?? `${receipt.seq}:${receipt.tool}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(receipt)
  }
  return out
}
