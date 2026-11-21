// lib/receipt-bus.js — capture `tools/result` synchronously, persist later.
//
// The host does not guarantee that an async listener finishes before the model
// calls cue_step. Enqueueing the raw event happens in the listener's first
// synchronous tick; cue_step drains the queue before it reads receipts.

const QUEUE = Symbol.for('dsh-novel-conductor.receipt-queue')
const LOCKS = Symbol.for('dsh-novel-conductor.receipt-locks')

function queue() {
  let list = globalThis[QUEUE]
  if (!Array.isArray(list)) {
    list = []
    globalThis[QUEUE] = list
  }
  return list
}

export function enqueueRaw(exec, result) {
  queue().push({ exec, result, at: new Date().toISOString() })
}

export function drainRaw(agentId) {
  const list = queue()
  const out = []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]
    if (item?.exec?.agent?.id === agentId) {
      out.unshift(item)
      list.splice(index, 1)
    }
  }
  return out
}

export function pendingRaw(agentId) {
  return queue().filter((item) => item?.exec?.agent?.id === agentId).length
}

export async function withReceiptLock(runId, fn) {
  let locks = globalThis[LOCKS]
  if (!(locks instanceof Map)) {
    locks = new Map()
    globalThis[LOCKS] = locks
  }
  const key = String(runId)
  const previous = locks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolveCurrent) => { release = resolveCurrent })
  const tail = previous.then(() => current)
  locks.set(key, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}
