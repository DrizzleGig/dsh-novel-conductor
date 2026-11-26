// lib/adapters/fanfic.js — only translates `novelFanfic` shapes.
//
// fanfic 的服务返回**公共信封**（{status, code, message, data, source}），
// beat/fade/voice 返回裸对象；差异只在本文件吸收，run-machine 只认这里的形状。
//
// 三条口径：
//   - `identity()` 是函数；没装服务 → {installed:false, reason:'no-service'}
//   - 缺项目 / 没导入原著 → ready:false + reason，不抛错、不阻塞其它能力
//   - 契约段只作「第十六行上下文」，永远不是 verify 的证据；verify 只认 fic_check 的 pass

import { compatibleWith, identityOf, safeCall, serviceFor } from './common.js'

export const FANFIC_MIN_VERSION = '0.4.0'

export function fanficService(ctx) {
  return serviceFor(ctx, 'novelFanfic')
}

function okEnvelope(result) {
  if (!result.ok) return { available: false, reason: result.code ?? 'service-error', message: result.error }
  const value = result.value
  if (!value || value.status !== 'ok') {
    return { available: false, reason: value?.code ?? 'not-ready', message: value?.message ?? null }
  }
  return { available: true, data: value.data, source: value.source }
}

export async function probeFanfic(ctx, { cwd, project } = {}) {
  const service = fanficService(ctx)
  if (!service) return { name: 'fanfic', installed: false, ready: false, reason: 'no-service' }
  const identity = await identityOf(service)
  const status = await safeCall(() => service.getStatus({ cwd, project }))
  const envelope = okEnvelope(status)
  const data = envelope.available ? envelope.data : null
  const ready = Boolean(data && data.imported && data.chapters > 0)
  return {
    name: 'fanfic',
    installed: true,
    ready,
    compatible: compatibleWith(identity, FANFIC_MIN_VERSION),
    minVersion: FANFIC_MIN_VERSION,
    reason: ready ? null : (envelope.reason ?? 'no-project'),
    project: data?.project ?? project ?? null,
    identity,
    revision: data?.revision ?? null,
    chapters: data?.chapters ?? 0,
    revisionDrift: data?.revisionDrift === true,
  }
}

/** 读一章的契约（分段）。返回 {available, markdown, sections, revision, reason}。 */
export async function fanficContract(ctx, { cwd, project, chapter } = {}) {
  const service = fanficService(ctx)
  if (!service) return { available: false, reason: 'no-service' }
  const result = await safeCall(() => service.getContract({ cwd, project, chapter }))
  const envelope = okEnvelope(result)
  if (!envelope.available) return { available: false, reason: envelope.reason, message: envelope.message }
  const data = envelope.data || {}
  return {
    available: true,
    chapter: data.chapter ?? chapter,
    markdown: data.markdown ?? '',
    chars: data.chars ?? 0,
    hash: data.hash ?? null,
    sections: data.sections ?? {},
    sectionOrder: Array.isArray(data.sectionOrder) ? data.sectionOrder : Object.keys(data.sections || {}),
    revision: data.revision ?? null,
  }
}

export async function fanficRevision(ctx, { cwd, project } = {}) {
  const service = fanficService(ctx)
  if (!service || typeof service.getRevision !== 'function') return null
  const result = await safeCall(() => service.getRevision({ cwd, project }))
  const envelope = okEnvelope(result)
  return envelope.available ? envelope.data : null
}
