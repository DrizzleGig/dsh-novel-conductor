// lib/adapters/beat.js — only translates `novelBeat` shapes. It never writes
// the beat ledger and never treats a missing book as "no plugin".

import { identityOf, safeCall, serviceFor } from './common.js'

export function beatService(ctx) {
  return serviceFor(ctx, 'novelBeat')
}

export async function probeBeat(ctx, { cwd, book, chapter } = {}) {
  const service = beatService(ctx)
  if (!service) return { name: 'beat', installed: false, ready: false, reason: 'no-service' }
  const identity = await identityOf(service)
  const status = await safeCall(() => service.getStatus({ cwd, book, chapter }))
  const revision = await safeCall(() => service.getRevision({ cwd, book }))
  const ready = status.ok && status.value !== null && typeof status.value === 'object'
  return {
    name: 'beat',
    installed: true,
    ready,
    reason: ready ? null : (status.code ?? 'no-book'),
    identity,
    status: status.ok ? status.value : null,
    revision: revision.ok ? (revision.value?.revision ?? null) : null,
    error: status.ok ? null : status.error,
  }
}

export async function beatStatus(ctx, { cwd, book, chapter } = {}) {
  const service = beatService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getStatus({ cwd, book, chapter }))
  return result.ok ? result.value : null
}

export async function beatCanon(ctx, { cwd, book, chapter } = {}) {
  const service = beatService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getCanon({ cwd, book, chapter }))
  return result.ok ? result.value : null
}

export async function beatArtifact(ctx, { cwd, book, artifactId } = {}) {
  const service = beatService(ctx)
  if (!service) return { found: false, reason: 'no-service' }
  const result = await safeCall(() => service.getArtifact({ cwd, book, artifactId }))
  if (!result.ok) return { found: false, reason: result.code ?? 'service-error', message: result.error }
  return result.value ?? { found: false, reason: 'no-artifact' }
}

export async function beatRevision(ctx, { cwd, book } = {}) {
  const service = beatService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getRevision({ cwd, book }))
  return result.ok ? result.value : null
}
