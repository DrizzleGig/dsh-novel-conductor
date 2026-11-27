# Changelog

## 0.2.1 — 2026-11-27 · kit 独立与 fanfic 项目绑定（本地版，未发布）

### 修复

- **不再管辖 kit**：`lib/effects.js` 与 `lib/gateway.js` 的 `MANAGED_PREFIXES` 移除 `novel_`/`kit_`；conductor 关闭或未绑定时不再拦截 kit 的 `novel_*` 工具。all-six 下 kit 可独立工作。
- **`cue_run` 补 `fanfic_project`**：schema 声明并传给 `startRun`，run 的 fanfic 项目可绑定；`fic_*` 直调在 run 未声明项目时允许显式 project，不再永久 `cross-project`。
- **runbook 工具名**：`fic_canon` 改 `fic_contract`；plan 阶段从 `novel_plan`（kit）改 `beat_plan`（五件），不再向五件流程推荐 kit 工具。
- **close 回读正文 hash**：`completeClose` 对每个 chapter artifact 重新读文件并比对 `sha1`；write 收据后改文件会以 `artifact-stale` 拒绝并回到 write 步骤，避免把漂移正文标 completed。
- 新增 gateway 管辖边界、`cue_run` schema、`cue_call` 拒 kit 与 artifact-stale 测试；`npm test` 105/105。

## 0.2.0 — 2026-11-26

> 已发布 npm **0.2.0** / GitHub **v0.2.0**（2026-11-26）。

### 新增：书身份、隔离与调度底座

- **书身份 `book.json` / `books.json`**：`cue_scope`（`/cue scope`）`init` / `add` / `bind` / `status`；`bookId` 形如 `bk-<uuid>`，不随书名/路径变化。
- **run 按书落盘**：`<workspace>/.dsh-novel-conductor/books/<bookId>/runs/<runId>/`；`run.json` 记录 `bookId`。旧 `runs/<runId>` 仍可读，新 run 不再写旧布局。
- **按 agent 注册技能**：`novel-conductor` 不再全局可见；只在 `/cue on` 后注册到当前 agent，`/cue off` 收回。
- **参数与路径门**：受管工具的 `book`/`bookId`/`dir` 必须与绑定一致；`write`/`edit` 的路径不能越出书工作区。
- **每书写锁**：`lib/locks.js` 跨进程锁文件，`alive/dead/unknown` 三态；写工具经 `tools/execute` 自动取锁；`cue_locks` 查看，break 只走作者命令 `/cue locks break`。
- **会话绑定**：单书工作区在 `agent/created` 自动绑定；多书工作区未 `cue_scope bind` 前不开放创作工具。

### 新增：第三方工具网关

- **`cue_tools`**：按 query 列出当前步骤可调用的工具（含 MCP `mcp__server__tool` 与第三方插件），标 `effects`/`stateScope`/`bound`。
- **`cue_call`**：调用任意已注册工具，不需要它为 conductor 做适配。网关注入 `book`/`bookId`/`dir`，拒绝跨书与保留工具（`cue_*`、`run_code`、`skill` 等），按 `ProviderPolicy` 决定是否允许，并写 gateway 收据。
- **`providers.json`**：第三方工具显式声明 `effects/stateScope/bindings/allowedRoots/retry`；未声明状态位置的工具默认拒绝，MCP 以 `external` 放行。
- **收据**：`kind:"gateway"`，含 `tool/callId/operationId/argsHash/resultHash/bookId/runId/effects/stateScope/bound`；不复制正文。

### 新增：runbook 视图

- `cue_status({view:"runbook"})` 返回阶段计划：preflight / context / plan / await_author / write / voice_pass / segment / verify / digest / close，每阶段列出可用的 calls、skills、budget 与缺失能力。

### 适配最新兄弟版本

- 能力矩阵新增 `version/minVersion/compatible`：beat ≥ 0.12.0、fade ≥ 0.8.0、voice ≥ 0.4.0、fanfic ≥ 0.4.0；低版本仍可探测，但明确标 `compatible:false`，不静默当成已验证。
- 适配 beat 0.12.1 的 `novelBeat` 只读服务（`getStatus/getRevision/getCanon/getArtifact/query`）、fade 0.8.2 的双库服务、voice 0.4.0 的 `getStatus/getBrief/getPersonaBrief`、fanfic 0.4.3 的公共信封服务。

### 测试

- `node --test` **102/102**（新增 scope/locks/book-run/gateway/isolation 测试）。
- `npm run check` 覆盖新增模块。

### Codex 审查 P0 修复（2026-11-26）

- **不能读 `agent.ctx.skills` / `agent.ctx.tools` 属性**：改用 `agent.ctx.get('tools'/'skills')`，修复点击「故事总控」开关时 `cannot get property 'skills' without inject`；guard/restrict 保留方法接收者，安装失败不标记。
- **路径门读真实参数**：`write`/`edit` 同时接受 `file_path` 与 `path`，并用 `assertPathInside` 做真实路径校验（含 junction）。
- **锁不能被模型强拆**：`cue_locks` 只保留 `status`；`break` 只走作者命令 `/cue locks break`。
- **写工具分类**：`isWriteTool` 覆盖 `write/edit`、`voice_import/learn/profile` 等，直调与网关共用写锁。
- **ProviderPolicy 真正生效**：未配置的 MCP 默认拒绝；`effects` 为空拒绝；`bindings`/`allowedRoots` 实际校验；`project` 与当前 run 的同人项目绑定。
- **收据归属**：保存 `bookId/root/project/chapter`，字符串章号 `ch002` 归一化为 2；跨项目/跨章收据不通过。
- **原子写**：`run-store` 替换失败时先备份旧文件，重试失败回滚，不再出现旧、新都没了。
- **绑定持久化**：`scope-manager.select` 先写 session 绑定成功后才更新内存；失败保留旧绑定并报错。

### 已知限制（0.2.0 不宣称已解决）

- **COMMON-WRITER 未跨包落地**：只锁 conductor 可见的写入口；kit 面板、remote、独立插件直写仍可能旁路。需要在各包最终提交点接同一协议。
- **PTC/`run_code` 嵌套**：`PTC → SDK → cue_call → tools.execute` 会丢 `parent`；当前网关按 native 路径实现，PTC 下未验证。
- **同 cwd 多书写正文**：kit 正文路径 P0（`chapter.js:894`）未修前，本版**硬拦**多书工作区的 `cue_run start`、`write`/`edit` 与受管工具；一书一工作区。
- **全局状态插件**：`global/unknown` 状态的第三方工具默认拒绝写；串行不能消除缓存串读。
- **自动回收锁**：0.2.0 只做作者命令 `/cue locks break`，不做自动接管。
- 真实 DSH 宿主整章验收仍未做；78→102 是单测，不是宿主验收。

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
