# dsh-novel-conductor（故事总控）

> 谁上场、什么时候上，它排；戏怎么走，你定。

`dsh-novel-conductor` 是 DSH 小说插件系列的可选编排层，也是**书身份与工具网关**。它不写正文、不改 beat / fade / voice 的任何账本，只做六件事：

- **隔**：用 `book.json`/`bookId` 把不同小说、不同工作区隔开，按 agent 注册技能与工具；
- **排**：一章的 runbook 顺序（preflight → write → segment → verify → digest → close）；
- **控**：能力矩阵、前置条件、作者等待、失败与恢复；
- **锁**：每书写锁，`alive/dead/unknown` 三态，写工具自动取锁；
- **调**：`cue_tools` 发现、`cue_call` 调用第三方插件/MCP，不需要对方适配；
- **记**：每一步的真实收据与已核验产物引用。

没有 conductor，beat / fade / voice 仍可独立使用；装了 conductor，也不会让它们变成子模块。

## 本版本（v0.2.1，2026-11-27）

- **书身份隔离**：`cue_scope` / `/cue scope` 的 `init`、`add`、`bind`、`status`；`book.json` + `bookId`，run 落到 `books/<bookId>/runs/`。
- **按 agent 注册**：`novel-conductor` 技能只在 `/cue on` 后进入当前会话；普通工作区会话看不到。
- **参数/路径门**：受管工具的 `book`/`bookId`/`dir` 必须与绑定一致；`write`/`edit` 不能越出书工作区。
- **每书写锁**：`cue_locks` 查看；写工具自动取锁；锁分 `alive/dead/unknown`，不自动抢。
- **第三方工具网关**：`cue_tools` 发现、`cue_call` 调用（含 MCP 与未适配插件）；`providers.json` 声明 `effects/stateScope`，未声明默认拒绝。
- **runbook 视图**：`cue_status({view:"runbook"})` 列出阶段、调用、技能与预算。
- **兄弟版本适配**：beat ≥0.12.0 / fade ≥0.8.0 / voice ≥0.4.0 / fanfic ≥0.4.0；矩阵新增 `version/minVersion/compatible`。
- 测试 **102/102**；`npm run check` 覆盖新增模块。
- **发布前状态**：真实 DSH 宿主整章验收、COMMON-WRITER 跨包落地、PTC 嵌套仍未完成；见 CHANGELOG「已知限制」。

### v0.1.4（2026-11-21）

- **修：会话头按钮每 10 秒往对话里写一行「cue」**。`status` 只读 `novelConductor.isDriving(sessionId)`（`lib/cue-mode.js`），页面不可见时暂停轮询。
- 点按钮切开关仍走 `/cue on|off`：一次点击一行，是审计不是噪音。
- 测试 73 → **78**。

### v0.1.3（2026-11-21）

- **改名「故事总控」**：插件行、SKILL、命令文案与会话头按钮统一用这个名字；npm 包名仍是 `dsh-novel-conductor`。
- **它是本系列的总开关**：装了它以后——关着时 beat / fade / voice / fanfic **全部不工作**（哪怕它们自己的开关开着）；开着时四个都可用（哪怕它们自己的开关关着）。没装它时，四个插件照旧各按自己的开关。
- **会话头「故事总控」按钮**：点一下开/关，和 `/cue on|off` 是同一份实现。
- `/cue status` 第一行报开关状态，没有工作区、没有 run 也能答。


## 状态（0.2.1，发布版）

- 发布：npm **0.2.1**（registry 为准）；0.2.0 为上一版。
- 7 个工具：`cue_run` / `cue_step` / `cue_status` / `cue_scope` / `cue_locks` / `cue_tools` / `cue_call`。
- 6 步 + 1 个等待态：`preflight → [await_author] → write → segment → verify → digest → close`。
- 两种形态：`assist`（有基线插件）与 `solo`（一个都没有）。
- run 按书落盘：`books/<bookId>/runs/<runId>/`；旧 `runs/<runId>` 仍可读。
- 收据以宿主 `tools/result(exec, result)` 为准，再通过 `novelBeat.getArtifact` / `novelFade.getArtifact` / `novelFade.getStatus` 回查。
- `node --test` **102/102**；含 beat 0.9.1 夹具服务、scope/lock/gateway/isolation 测试。
- **模拟验收**：2026-11-21 PASS（6/6 步、4 条收据、3 个产物），见 [模拟验收报告](docs/acceptance-simulated-2026-11-21.md)。这是确定性假服务 + 合成 `tools/result`，不是真实 DSH 宿主验收。
- **fanfic（只在同人任务里用）**：`required_capabilities` 不写 `fanfic` 时，conductor 连一次探测都不做；写了才读世界契约，`verify` 只认 `fic_check` 的 `pass:true`（`source:'canon'`、整数 `revision`）。
- **未做**：右栏面板、真实 DSH 宿主整章验收、COMMON-WRITER 跨包落地、PTC 嵌套、同 cwd 多书写正文（已硬拦）、锁自动回收。

### Codex 只读复审（2026-11-21）

桌面端 Codex 对 0.1.0 做了只读代码复审，指出 **4 条 blocker + 4 条 should-fix**；本版已全部处理并补了对应测试：

| 问题 | 处理 |
|---|---|
| `tools/result` 异步监听与 `cue_step` 竞态 | 监听器**同步入队** raw 事件，`cue_step` 先用 `flushPending` 落盘再读收据 |
| 跨工作区同名书同章收据可串账 | 收据记录 `dir/cwd`，`matchesRun` 要求与 run 的 cwd 一致 |
| `beat` 已回退产物仍可适配 | `getArtifact.segment.status === 'reverted'` 拒绝；`close` 再回读 `lastSegment` |
| `memo_digest` 预览被当成已落账 | 必须有 `receipt.artifactId + revision`，否则 `digest-not-committed` |
| `awaiting_author` 可直接绕过 | 暂停态拒绝 `cue_step(done)`，必须先 `cue_run({action:"resume"})` |
| 显式 `failed` 后无法恢复 | `failed` 不再算终态；`resume` 重置当前步骤 |
| 回退后幂等缓存返回旧成功 | 缓存绑定 `stepId + fingerprint + generation`，resume/revert 递增 generation |
| `/cue` 查默认目录而非 run 目录 | 命令优先 `activeRunOf(agent)` 的 cwd |

## 安装 / 启用

包本身是 DSH host 插件，没有客户端 UI。已发布 npm `dsh-novel-conductor@0.1.0`；本地开发也可以继续用 `link:` 指向本仓库：

```json
"dsh-novel-conductor": "link:D:/Novel-gate/dsh-novel-conductor"
```

并把 `dsh-novel-conductor` 加进 `dsh.profile.bundles`，重启 DSH 或刷新宿主后生效。安装 npm 版本：

```bash
dsh plugin add dsh-novel-conductor
```

装好后，`cue_*` 工具与 `/cue` 命令即可用；单书工作区先 `/cue scope init <书名>`，写章前 `/cue on`。多书工作区用 `/cue scope bind <书名>` 选当前书。

> 如果之前用 `link:` 安装过，重装时 pnpm 可能报 `ERR_PNPM_EPERM ... rename ...dsh-novel-conductor`：`node_modules` 里残留的 junction 挡住了原子替换。见 [安装故障排查](docs/install-troubleshooting.md)。

## 一章怎么走

```text
0. /cue scope init <书名>（单书）；多书用 /cue scope bind <书名>；/cue on
1. cue_run({action:"start", book, chapter, required_capabilities:["beat","fade","voice"]})
      ├─ 若 state=awaiting_author：先去 beat 拍板，再 cue_run({action:"resume"})
      └─ 若 blocked：看 capabilityMatrix，缺什么补什么
2. 把正文保存成文件 → cue_step({stepId:"write", artifact:{path, chars, sha1}})
3. 调 beat_segment → cue_step({stepId:"segment", artifact:{artifactId}})
4. 调 beat_verify / voice_check → cue_step({stepId:"verify"})
5. 调 memo_digest → cue_step({stepId:"digest", artifact:{artifactId}})
6. cue_step({stepId:"close"})
7. 外部插件/MCP：cue_tools → cue_call({tool,args})
```

`cue_status({view:"sheet"})` 随时看当前步骤、等待事项、预算与能力矩阵；`view:"runbook"` 看阶段/调用/技能。`cue_tools({query})` 发现当前可用工具，`cue_call({tool,args})` 调用未适配的第三方插件/MCP（需要先有活动 run）。

## 证据规则（0.1 的红线，0.2 继续）

1. **工具调用成功 ≠ 任务完成**。每一步必须由本 run、本 agent、本步骤窗口内的 `tools/result` 收据证明；没有收据的 `segment` 记为 `claimed`，`close` 会拒绝。
2. **`beat_verify` 失败仍可能 `ok:true`**。通过条件只能是 `verified === true`（或结构化 `pass:true`），并且两者不能互相矛盾。
3. **旧收据的 revision 可以小于当前账本 revision**。按 `artifactId` 回查，接受 `<=`，不做等值比较。
4. **收据必须绑定 agent / book / chapter / 步骤窗口**。事件里没有 cwd，conductor 用自己 run 的 cwd 和 agent 绑定；别的 agent、别的书、窗口外的收据一律丢弃。
5. **一个会话同一时间只允许一个活动 run**。避免同一 agent 的两个 run 串账；要换章先 `close` 或 `abort`。
6. **不写兄弟账本**。`run.json` 只存状态、步骤、收据引用与产物引用，不复制正文/简报/卡片。
7. **跨书拒收**。`run.bookId` 与当前会话绑定不一致时，`cue_step`/`cue_call` 拒绝；收据记录 `bookId`，旧 `runs/<runId>` 仍可读但不能当成新书 run。

## 数据布局

```text
<workspace>/.dsh-novel-conductor/
  book.json                    # { schemaVersion, bookId, book, title, createdAt }
  books.json                   # 多书工作区：{ schemaVersion, books:[...] }
  providers.json               # 可选：第三方工具 ProviderPolicy
  books/<bookId>/runs/<runId>/
    run.json                   # 状态机、能力矩阵、runbook、步骤、收据引用
    receipts.jsonl             # 宿主 tools/result + gateway 收据（正文/卡片正文被丢弃）
    events.jsonl               # conductor 自己的状态迁移
  locks/<resource>.lock        # 跨进程写锁
  sessions/<sessionId>.json    # 可选：多书绑定缓存
```

`run.json` 示例：

```jsonc
{
  "schemaVersion": 1, "runId": "run-…", "bookId": "bk-…", "book": "…", "chapter": 13,
  "state": "verifying", "currentStep": "verify",
  "capabilityMatrix": { "beat": { "installed": true, "on": null, "service": 1, "version": "0.12.1",
                                  "minVersion": "0.12.0", "compatible": true, "revision": 42, "ready": true } },
  "steps": [{ "id": "segment", "state": "done", "verified": true,
              "source": { "kind": "receipt", "tool": "beat_segment", "callId": "…" },
              "receipt": { "artifactId": "s-0013", "revision": 43, "hash": "sha256:…" } }],
  "committedArtifacts": [{ "kind": "beat", "artifactId": "s-0013", "revision": 43 }],
  "budget": { "chars": 1379, "segments": { "beat": 320, "fade": 804, "voice": 255 } }
}
```

## 能力矩阵与降级

| 状态 | 含义 | conductor 行为 |
|---|---|---|
| `installed:false` | 没有该服务 | 必需能力 → preflight `blocked`；非必需 → 不排该步 |
| `installed:true, ready:false` | 有服务但没书/没档案 | 必需能力 → `blocked`，reason 写明 no-book / no-profile |
| `installed:true, ready:true` | 可读 | 进入步骤 |
| `compatible:false` | 版本低于 minVersion | 仍可探测/显示，但不宣称已验证；升级兄弟包 |
| `on:null` | 0.1 无法从服务观测会话开关 | 如实显示 null，不猜；模型调不到工具时该步会停在缺收据 |

`solo` 形态只排 `preflight → write → close`，不伪造 beat/fade/voice 步骤。

## 开发

```bash
cd D:/Novel-gate/dsh-novel-conductor
node --test          # 102 个测试
npm run check        # node --check
```

测试分四层：

- `test/run-machine.test.js`：状态机、收据、close gate、resume/revert；
- `test/receipt.test.js` / `run-store.test.js` / `adapters.test.js`：纯函数与存储；
- `test/scope.test.js` / `locks.test.js` / `book-run.test.js` / `gateway.test.js` / `isolation.test.js`：书身份、锁、网关与作用域门；
- `test/integration/beat-receipt.test.js`：真实 `novelBeat` 0.9.1 只读服务 + 临时账本 + 合成 `tools/result`。

**验收口径**：模拟验收已通过（[报告](docs/acceptance-simulated-2026-11-21.md)）。真实 DSH 宿主里跑完整一章（需要作者会话、真实 beat/fade/voice 数据）仍未做；本版只到「真实服务 + 合成宿主事件」这一层，不把它宣传成宿主验收通过。

## 设计依据

- [0.2.x 隔离与调度方案](../docs/方案-conductor-0.2.x-隔离与调度-2026-11-26.md)：书身份、锁、网关、runbook 与验收矩阵。
- [适配契约（现实版）](docs/contract.md)：conductor 实际消费的 beat/fade/voice 形状与判定表。
- [发布前检查清单 0.2.0](docs/release-checklist-0.2.0.md)：已跑门禁与仍未完成的验收。
- `小说插件系列-conductor-v0.1-开工方案-2026-11-21.md`（Novel-gate 工作区 `docs/`）：本轮范围、切片与 gate。
- `小说插件系列-conductor-v0.1-开发方案.md`（Novel-gate 工作区 `docs/`）：conductor v1.1 的原始设计。
- `小说插件系列-五插件协作契约-v1.1.md`（Novel-gate 工作区 `docs/`）：理想契约，文档冻结、不建包。

## 共同作者

v0.1.0 共同作者：[MiyueWinter](https://github.com/MiyueWinter) —— 文案、测试、设计与开发。

## 喜欢它？

如果「故事总控」帮你在长篇写作里把一章的步骤排顺、每一步都有据可查，欢迎在 [GitHub](https://github.com/DrizzleGig/dsh-novel-conductor) 点亮 ⭐，也欢迎 [Issue](https://github.com/DrizzleGig/dsh-novel-conductor/issues) 或 PR。

## 许可证

MIT License，见 [LICENSE](LICENSE)。

