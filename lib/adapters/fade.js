// lib/adapters/fade.js — only translates `novelFade` shapes. fade rejects a
// relative cwd with `bad-dir`; a missing memory returns null; `getArtifact`
// nests the verified artifact under `artifact`.

import { identityOf, safeCall, serviceFor } from './common.js'

export function fadeService(ctx) {
  return serviceFor(ctx, 'novelFade')
}

export async function probeFade(ctx, { cwd, book } = {}) {
  const service = fadeService(ctx)
  if (!service) return { name: 'fade', installed: false, ready: false, reason: 'no-service' }
  const identity = await identityOf(service)
  const status = await safeCall(() => service.getStatus({ cwd, book }))
  const ready = status.ok && status.value !== null
  return {
    name: 'fade',
    installed: true,
    ready,
    reason: ready ? null : (status.code ?? 'no-book'),
    identity,
    status: status.ok ? status.value : null,
    revision: status.ok ? (status.value?.revision ?? null) : null,
    error: status.ok ? null : status.error,
  }
}

export async function fadeBrief(ctx, { cwd, book, chapter, budget } = {}) {
  const service = fadeService(ctx)
  if (!service) return { available: false, reason: 'no-service' }
  const result = await safeCall(() => service.getBrief({ cwd, book, chapter, budget }))
  if (!result.ok) return { available: false, reason: result.code ?? 'service-error', message: result.error }
  if (!result.value) return { available: false, reason: 'no-book' }
  return { available: true, ...result.value }
}

export async function fadeStatus(ctx, { cwd, book } = {}) {
  const service = fadeService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getStatus({ cwd, book }))
  return result.ok ? result.value : null
}

export async function fadeArtifact(ctx, { cwd, book, artifactId, verify = true } = {}) {
  const service = fadeService(ctx)
  if (!service) return { found: false, reason: 'no-service' }
  const result = await safeCall(() => service.getArtifact({ cwd, book, artifactId, verify }))
  if (!result.ok) return { found: false, reason: result.code ?? 'service-error', message: result.error }
  return result.value ?? { found: false, reason: 'no-artifact' }
}
