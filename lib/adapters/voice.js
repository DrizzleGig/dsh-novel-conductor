// lib/adapters/voice.js — only translates `novelVoice` shapes. `identity()` is
// a function; a missing profile is `{ok:false, code:'no-profile'}`, not a
// thrown error. `voice_check` is a tool, not a service method.

import { identityOf, safeCall, serviceFor } from './common.js'

export function voiceService(ctx) {
  return serviceFor(ctx, 'novelVoice')
}

export async function probeVoice(ctx, { cwd, book } = {}) {
  const service = voiceService(ctx)
  if (!service) return { name: 'voice', installed: false, ready: false, reason: 'no-service' }
  const identity = await identityOf(service)
  const status = await safeCall(() => service.getStatus({ cwd, book }))
  const value = status.ok ? status.value : null
  const profiles = Array.isArray(value?.profiles) ? value.profiles.length : 0
  const ready = Boolean(value && (profiles > 0 || value.profile))
  return {
    name: 'voice',
    installed: true,
    ready,
    reason: ready ? null : 'no-profile',
    identity,
    status: value,
    revision: value?.revision ?? null,
    error: status.ok ? null : status.error,
  }
}

export async function voiceBrief(ctx, { cwd, book, chapter, budget } = {}) {
  const service = voiceService(ctx)
  if (!service) return { available: false, reason: 'no-service' }
  const result = await safeCall(() => service.getBrief({ cwd, book, chapter, budget }))
  if (!result.ok) return { available: false, reason: result.code ?? 'service-error', message: result.error }
  if (!result.value || result.value.ok === false) {
    return { available: false, reason: result.value?.code ?? 'no-profile', message: result.value?.message ?? null }
  }
  return { available: true, ...result.value }
}

export async function voiceStatus(ctx, { cwd, book } = {}) {
  const service = voiceService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getStatus({ cwd, book }))
  return result.ok ? result.value : null
}

export async function voiceRevision(ctx, { cwd, book } = {}) {
  const service = voiceService(ctx)
  if (!service) return null
  const result = await safeCall(() => service.getRevision({ cwd, book }))
  return result.ok ? result.value : null
}
