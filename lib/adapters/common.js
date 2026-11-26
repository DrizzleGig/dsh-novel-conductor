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

function versionParts(value) {
  return String(value ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
}

/** Numeric SemVer comparison, prerelease ignored; enough for a compatibility hint. */
export function versionAtLeast(value, minimum) {
  const a = versionParts(value)
  const b = versionParts(minimum)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

export function compatibleWith(identity, minimum) {
  if (!identity?.version) return null
  return versionAtLeast(identity.version, minimum)
}
