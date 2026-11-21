// 开关状态的「只读」读取路径。
//
// 为什么单独一层：DSH 的 commands.execute() 是「人用命令」，它会把
// command/run + command/done **写进会话日志**（@deepseek-ai/dsh-commands
// src/index.ts:335 明说这两个是 log appends）。拿它做后台轮询，会让每个开着
// 的对话每 10 秒多一行「cue · 故事总控…」，对话结束也停不下来（0.1.3 的 bug）。
//
// 所以：读状态只走 novelConductor 只读服务的 isDriving(sessionId)；
// 写状态（作者点按钮 / 敲 /cue on）才走命令，一次点击一行，是审计不是噪音。

/**
 * @param {object} ctx Cordis 上下文（remote 的 this.ctx）
 * @param {string} sessionId 会话 id
 * @returns {{ok: true, on: boolean} | {ok: false, reason: string}}
 */
export function readDriving(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'sessionId 必须是非空字符串' }
  }
  let service = null
  try {
    service = ctx?.get?.('novelConductor') ?? null
  } catch (error) {
    return { ok: false, reason: `读取故事总控服务失败：${error?.message ?? error}` }
  }
  if (!service || typeof service.isDriving !== 'function') {
    return { ok: false, reason: '故事总控服务未就绪，请重载后端' }
  }
  try {
    return { ok: true, on: service.isDriving(sessionId) === true }
  } catch (error) {
    return { ok: false, reason: `读取开关失败：${error?.message ?? error}` }
  }
}
