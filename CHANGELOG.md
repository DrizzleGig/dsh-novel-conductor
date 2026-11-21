# Changelog

## 0.1.4 — 2026-11-21

### 修复：会话头按钮每 10 秒往对话里写一行「cue」

- **现象**：对话结束、停在输入框之后，时间线里仍每 10 秒冒出一行
  `cue · 故事总控：关（/cue on 开启）／当前没有活动 run；/cue on 之后用 cue_run 开始一章。`
  开着会话越久越多；`dsh-novel-fanfic v0.2.1 开发` 等会话各累计 100+ 行。
- **根因**：Host 半 `remote.status()` 用 `ctx.commands.execute('/cue status')` 读开关。DSH 的
  `commands.execute()` 每次都会把 `command/run` + `command/done` **追加进会话日志**
  （`@deepseek-ai/dsh-commands` `src/index.ts:335`：「Both are direct log-only appends」），
  而客户端在轮询，于是变成刷屏。实测单个会话 24 分钟 146 次 `/cue`，间隔中位数 10 000 ms。
- **修复**：`status` 改为只读 `novelConductor.isDriving(sessionId)`（新增 `lib/cue-mode.js`），
  不再执行命令；`setMode` 仍走 `/cue on|off`——一次点击一行，是审计不是噪音。
  客户端轮询在页面不可见时暂停，回到前台立刻补一次。
- **测试**：新增 `test/cue-mode.test.mjs`（只读路径、服务缺失、非法 id、服务异常、源码守卫）；
  `node --test` **78/78**。

## 0.1.3 — 2026-11-21

### 新增：接管开关（conductor 是总开关）+ 会话头按钮

- **`/cue on|off|status`**：会话级开关，默认关。装了 conductor 时它就是总开关——关着时 beat / fade / voice / fanfic **全部不工作**（哪怕它们自己的开关开着）；开着时四个插件可用（哪怕它们自己的开关关着）。没装 conductor 时四个插件各按自己的开关，和以前一样。
- **会话头「故事总控」按钮**：`conversation.session.header.utilities`，点一下切 on/off；走 `cueMode` typert remote，Host 侧委托给同一条 `/cue` 命令（一份实现）。`/cue status` 不再要求工作区。
- **只读服务 `novelConductor`**：`identity()` / `isDriving(sessionId)` / `onDriveChange(cb)`；开关时广播 `novel-conductor/drive`，兄弟插件按它重算生效状态（含 fade/voice 的 deny restrict、beat 的 L1 技能 / L2 提示 / L3 guard）。
- 新增 `test/drive-switch.test.mjs`（总开关语义 + 不写盘）与 `test/client-module.test.mjs`（模块结构 + 两端契约对齐）；**73/73**。

## 0.1.1 — 2026-11-21（docs-only）

- 修正 README 的安装说明：0.1.0 已发布 npm / GitHub，不再写「尚未发布」。
- 代码与 0.1.0 相同；59/59 测试与模拟验收不变。

## 0.1.0 — 2026-11-21

首个可运行内核：只做「真实 beat 收据闭环」，不接面板、不做复杂调度。

### 新增

- **3 工具**：`cue_run`（start/resume/abort/status）、`cue_step`（只接受当前步骤）、`cue_status`（sheet/steps/budget/capabilities）。
- **6 步 + 1 等待态**：`preflight → [await_author] → write → segment → verify → digest → close`；`await_author` 是暂停态，不是步骤。
- **两种形态**：`assist` 与 `solo`；缺必需能力时 preflight 直接 `blocked`，不伪装 solo。
- **run.json**：schema v1，原子写；`receipts.jsonl` 存宿主收据投影；`events.jsonl` 存状态迁移。
- **收据总线**：监听 `tools/result(exec, result)`，按 agent / book / chapter / 步骤窗口绑定；`callId` 去重；正文与卡片正文不落盘。
- **回查**：`segment` 用 `novelBeat.getArtifact` 比对 hash；`digest` 用 `novelFade.getStatus` / `getArtifact` 回读；`beat_verify` 只认 `verified === true` / `pass === true`，且两者互相矛盾时拒绝。
- **恢复**：`beat_revert` 后 `resume` 回到 `segment`；kill 后从持久化检查点恢复，不重放已完成步骤。
- **幂等**：`cue_step` 的 `idempotencyKey` 重复提交只记一次。
- **命令**：`/cue status`、`/cue abort [runId]`；模型侧 skill `novel-conductor`。

### 复审修正（Codex 只读复审后）

- **收据竞态**：`tools/result` 监听器同步把 raw 事件放入进程内队列；`cue_step` 先 `flushPending` 落盘再读收据，避免异步监听未完成就记 `claimed`。
- **跨工作区串账**：收据记录 `dir/cwd`，与 run 的 cwd 不一致直接丢弃。
- **回退产物**：`novelBeat.getArtifact` 返回 `segment.status: 'reverted'` 时拒绝；`close` 再回读 `lastSegment`，作者回退后不能直接收尾。
- **digest 预览**：`memo_digest` 没有 `receipt.artifactId + revision` 时视为预览，不能标记 verified。
- **await_author**：暂停态拒绝 `cue_step(done)`，必须先 `cue_run({action:"resume"})`。
- **failed 可恢复**：`failed` 不再列为终态，`resume` 可重试当前步骤。
- **幂等缓存**：绑定 `stepId + 参数指纹 + generation`；resume/revert 递增 generation，旧 key 不会返回旧成功。
- **`/cue` 目录**：命令优先使用活动 run 的 cwd，而不是会话默认目录。

### 未做

- 右栏面板、`strict`、`replay`、跨账本冲突裁决、fanfic 步骤、多书并行、统一设置中心。
- 真实 DSH 宿主的一章验收（当前集成测试用真实 beat 服务 + 合成 `tools/result`）。

### 测试

- `node --test`：**59/59**。
- `npm run check`：通过。
- **模拟验收（2026-11-21）**：确定性假服务 + 合成 `tools/result`，6/6 步、4 条收据、3 个产物，`completed`；见 `docs/acceptance-simulated-2026-11-21.md`。明确不是真实 DSH 宿主验收。

### 修复

- 移除未 `provide` 的 `ctx.novelConductor` 赋值（插件管理页报 `cannot set property "novelConductor" without provide`）。
- README 补「共同作者」「喜欢它？」「许可证」段；共同作者 MiyueWinter 仍保留在 `package.json` contributors。
