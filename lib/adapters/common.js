// lib/adapters/common.js — one honest way to ask a sibling service.

export function serviceFor(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : null
  } catch {
    return null
  }
}

export async function identityOf(service) {
  if (!service || typeof service.identity !== 'function') return null
  try {
    return await service.identity()
  } catch {
    return null
  }
}

export async function safeCall(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), code: error?.code ?? null }
  }
}

export function errorOf(result) {
  return result?.ok === false ? (result.code ?? 'service-error') : null
}
