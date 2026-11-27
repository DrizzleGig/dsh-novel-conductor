// lib/gateway.js — call any registered tool (including MCP and third-party
// plugins) without adapting it. The gateway never invents a tool: it reads the
// live schema, rejects reserved names, binds book arguments, applies a
// ProviderPolicy and records a receipt. Unknown state/effects are denied.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { appendReceipt } from './run-store.js'
import { canonicalTarget, checkBookArgs, conductorRoot, isPathInside } from './scope.js'
import { acquireLock } from './locks.js'

export const GATEWAY_SCHEMA_VERSION = 1
export const RESERVED = new Set(['run_code', 'skill', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'wait_agent', 'list_agents'])
// 与 lib/effects.js 保持同一口径：conductor 只管五件，kit 的 novel_* 是独立产品。
export const MANAGED_PREFIXES = ['beat_', 'memo_', 'voice_', 'fic_']

export class GatewayError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.extra = extra
  }
}

export function failGateway(code, message, extra = {}) {
  throw new GatewayError(code, message, extra)
}

export function isManagedTool(name) {
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function builtinPolicy(name) {
  if (isManagedTool(name)) {
    return {
      effects: ['read', 'write'],
      stateScope: 'book',
      retry: 'never',
      bindings: [],
      allowedRoots: [],
      source: 'builtin',
    }
  }
  if (name.startsWith('mcp__')) {
    // 未配置的 MCP 也可能是删除/发送类工具：默认拒绝，必须显式声明。
    return { effects: ['external'], stateScope: 'unknown', retry: 'never', bindings: [], allowedRoots: [], source: 'unknown' }
  }
  return { effects: [], stateScope: 'unknown', retry: 'never', bindings: [], allowedRoots: [], source: 'unknown' }
}

export async function readProviderPolicies(cwd) {
  const file = join(conductorRoot(cwd), 'providers.json')
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (!raw || raw.schemaVersion !== GATEWAY_SCHEMA_VERSION || typeof raw.providers !== 'object') {
      failGateway('policy-corrupt', `providers.json 版本或结构不兼容：${file}`)
    }
    return raw.providers
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    if (error instanceof SyntaxError) failGateway('policy-corrupt', `providers.json 解析失败：${file}`)
    throw error
  }
}

export function policyFor(name, policies = {}) {
  const configured = policies?.[name]
  const base = builtinPolicy(name)
  if (!configured) return base
  return {
    effects: Array.isArray(configured.effects) ? configured.effects : base.effects,
    stateScope: configured.stateScope ?? base.stateScope,
    retry: configured.retry ?? base.retry,
    bindings: Array.isArray(configured.bindings) ? configured.bindings : base.bindings,
    allowedRoots: Array.isArray(configured.allowedRoots) ? configured.allowedRoots : base.allowedRoots,
    source: 'config',
  }
}

export function hashJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function pickText(content) {
  if (!Array.isArray(content)) return null
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  return text || null
}

function pointerGet(object, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined
  let cursor = object
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function pointerSet(object, pointer, value) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return
  const parts = pointer.slice(1).split('/').map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cursor = object
  for (const key of parts.slice(0, -1)) {
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[parts.at(-1)] = value
}

function prepareArgs(tool, schema, args, binding, run, policy = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {}
  const properties = schema?.parameters?.properties ?? {}
  const bind = (key, value) => {
    if (value == null) return
    if (input[key] == null || input[key] === '') input[key] = value
  }
  if (binding) {
    if ('book' in properties) bind('book', binding.book)
    if ('bookId' in properties) bind('bookId', binding.bookId)
    if ('book_id' in properties) bind('book_id', binding.bookId)
    if ('dir' in properties) bind('dir', binding.workspace)
    if ('cwd' in properties) bind('cwd', binding.workspace)
    if ('root' in properties) bind('root', binding.workspace)
    if ('workspace' in properties) bind('workspace', binding.workspace)
  }
  if (binding) {
    const bad = checkBookArgs(input, binding)
    if (bad) failGateway(bad.code, bad.message)
  }
  const knownProject = run?.fanficProject ?? run?.capabilityMatrix?.fanfic?.project ?? null
  if ('project' in properties && binding) {
    if (knownProject) bind('project', knownProject)
    else if (tool.startsWith('fic_')) failGateway('unbound-project', `工具 ${tool} 需要 project，但当前 run 没有同人项目`)
  }
  if (typeof input.project === 'string' && input.project) {
    if (!knownProject || input.project !== knownProject) {
      failGateway('cross-project', `project 与当前 run 的同人项目不一致：${input.project}`)
    }
  }
  for (const rule of policy.bindings ?? []) {
    if (!rule || typeof rule.pointer !== 'string') failGateway('policy-invalid', 'ProviderPolicy.bindings 缺少 pointer')
    const sourceValue = {
      bookId: binding?.bookId,
      book: binding?.book,
      workspace: binding?.workspace,
      chapter: run?.chapter,
    }[rule.source]
    if (sourceValue === undefined) failGateway('policy-invalid', `未知 binding.source：${String(rule.source)}`)
    if (!['value', 'read-path', 'write-path'].includes(rule.semantics)) {
      failGateway('policy-invalid', `未知 binding.semantics：${String(rule.semantics)}`)
    }
    const current = pointerGet(input, rule.pointer)
    if (current != null && String(current) !== String(sourceValue)) {
      failGateway('binding-conflict', `${rule.pointer} 与绑定不一致：${String(current)}`)
    }
    if (current == null && rule.semantics === 'value') pointerSet(input, rule.pointer, sourceValue)
  }
  return input
}

function pathArgs(input) {
  const out = []
  for (const key of ['path', 'file_path', 'dir', 'root', 'workspace']) {
    if (typeof input?.[key] === 'string' && input[key]) out.push({ key, value: input[key] })
  }
  return out
}

async function assertAllowedRoots(input, policy, binding) {
  if (!binding) return
  const roots = (policy.allowedRoots ?? []).map((root) => (isAbsolute(root) ? root : join(binding.workspace, root)))
  const realRoots = roots.length
    ? await Promise.all(roots.map((root) => canonicalTarget(root)))
    : [await canonicalTarget(binding.workspace)]
  for (const { key, value } of pathArgs(input)) {
    const abs = isAbsolute(value) ? value : join(binding.workspace, value)
    const real = await canonicalTarget(abs)
    if (!realRoots.some((root) => isPathInside(root, real))) {
      failGateway('path-not-allowed', `${key} 不在 ProviderPolicy.allowedRoots 内：${value}`)
    }
  }
}

/**
 * Call one registered tool through the host executor. `agent` and `toolSet` are
 * the scope/admission the caller already has; the gateway does not widen them.
 */
export async function callTool({
  ctx, agent, toolSet, signal, binding, run, tool, args, policies = {}, purpose = null,
} = {}) {
  if (typeof tool !== 'string' || !tool) failGateway('bad-tool', 'tool 必须是非空字符串')
  if (tool.startsWith('cue_') || RESERVED.has(tool)) {
    failGateway('reserved-tool', `不能通过网关调用保留工具：${tool}`)
  }
  const tools = ctx?.tools
  if (!tools?.schemas || !tools?.execute) failGateway('no-tools-service', '宿主没有 tools.schemas/execute')
  const schemas = tools.schemas(agent, toolSet)
  const schema = schemas.find((entry) => entry.name === tool)
  if (!schema) failGateway('unknown-tool', `当前步骤看不到工具：${tool}`)

  const policy = policyFor(tool, policies)
  if (!Array.isArray(policy.effects) || policy.effects.length === 0) {
    failGateway('policy-required', `工具 ${tool} 没有声明 effects；先在 providers.json 加 ProviderPolicy`)
  }
  if (policy.stateScope === 'unknown' && policy.source === 'unknown') {
    failGateway('policy-required', `工具 ${tool} 未声明状态位置；先在 providers.json 加 ProviderPolicy`)
  }
  if (policy.stateScope === 'global' && policy.effects.includes('write')) {
    failGateway('global-state-write', `工具 ${tool} 是全局状态，不能进入按书隔离写流程`)
  }

  const finalArgs = prepareArgs(tool, schema, args, binding, run, policy)
  await assertAllowedRoots(finalArgs, policy, binding)
  const callId = `cue:${run?.runId ?? 'adhoc'}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`
  const operationId = hashJson({ tool, args: finalArgs, bookId: binding?.bookId ?? null, runId: run?.runId ?? null })

  let lease = null
  if (binding && policy.effects.includes('write') && !isManagedTool(tool)) {
    lease = await acquireLock({
      cwd: binding.workspace,
      bookId: binding.bookId,
      flowId: run?.runId ?? `gateway-${agent?.id ?? 'anon'}`,
      resource: 'book-write',
    })
  }

  try {
    const batch = await tools.execute({
      calls: [{ type: 'tool-call', id: callId, name: tool, arguments: JSON.stringify(finalArgs) }],
      signal: signal ?? new AbortController().signal,
      agent,
      toolSet,
    })
    const settled = batch?.results?.[0]?.result
    if (!settled) failGateway('empty-result', `工具 ${tool} 没有返回结果`)
    const receipt = {
      kind: 'gateway',
      tool,
      callId,
      operationId,
      purpose: typeof purpose === 'string' ? purpose.slice(0, 200) : null,
      bookId: binding?.bookId ?? null,
      runId: run?.runId ?? null,
      argsHash: hashJson(finalArgs),
      resultHash: hashJson({ isError: settled.isError === true, content: settled.content ?? null }),
      isError: settled.isError === true,
      effects: policy.effects,
      stateScope: policy.stateScope,
      bound: Boolean(binding),
      source: policy.source,
      at: new Date().toISOString(),
    }
    if (run?.runId) {
      await appendReceipt(run.cwd ?? binding?.workspace, run.runId, receipt, run.bookId ?? null)
    }
    return {
      ok: settled.isError !== true,
      tool,
      callId,
      operationId,
      receipt,
      value: settled.value ?? null,
      text: pickText(settled.content),
      error: settled.error ?? null,
    }
  } finally {
    if (lease) await lease.release().catch(() => {})
  }
}

export async function listTools({ ctx, agent, toolSet, binding, policies = {}, query = '', limit = 24 } = {}) {
  const tools = ctx?.tools
  if (!tools?.schemas) failGateway('no-tools-service', '宿主没有 tools.schemas')
  const schemas = tools.schemas(agent, toolSet)
  const needle = String(query ?? '').trim().toLowerCase()
  const rows = []
  for (const schema of schemas) {
    if (schema.name.startsWith('cue_') || RESERVED.has(schema.name)) continue
    if (needle) {
      const hay = `${schema.name} ${schema.description ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) continue
    }
    const policy = policyFor(schema.name, policies)
    rows.push({
      name: schema.name,
      description: String(schema.description ?? '').slice(0, 220),
      effects: policy.effects,
      stateScope: policy.stateScope,
      bound: Boolean(binding),
      source: policy.source,
      params: Object.keys(schema.parameters?.properties ?? {}).slice(0, 12),
    })
    if (rows.length >= Math.max(1, Math.min(50, Number(limit) || 24))) break
  }
  return rows
}
