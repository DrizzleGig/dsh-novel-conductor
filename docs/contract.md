# conductor 0.2.0 适配契约（现实版）

> 这份文档记录 conductor 实际消费的兄弟插件形状，以 2026-11-26 的代码为准（conductor 0.2.0；beat 0.12.1 / fade 0.8.2 / voice 0.4.0 / fanfic 0.4.3）。
> 它不是理想契约；理想契约见 [五插件协作契约 v1.1](../../docs/小说插件系列-五插件协作契约-v1.1.md)。

## 1. 服务发现

| key | 来源 | 必需方法 |
|---|---|---|
| `novelBeat` | `ctx.get('novelBeat')` | `identity()` / `getStatus` / `getRevision` / `getCanon` / `getArtifact` |
| `novelFade` | `ctx.get('novelFade')` | `identity()` / `getStatus` / `getRevision` / `getBrief` / `getArtifact` |
| `novelVoice` | `ctx.get('novelVoice')` | `identity()` / `getStatus` / `getRevision` / `getBrief`（0.4 起另有 `getPersonaBrief`） |
| `novelFanfic` | `ctx.get('novelFanfic')` | `identity()` / `getStatus` / `getContract` / `getRevision`（公共信封） |

`ctx.get` 拿不到就是 `installed:false`；拿到了但 `getStatus` 返回 null，是 `installed:true, ready:false`，reason 写 `no-book` / `no-profile`。不把「没有服务」和「有服务但没账本」混成一种。0.2 起矩阵另记 `version / minVersion / compatible`：低于 minVersion 仍可探测，但明确标 `compatible:false`，不宣称已验证。

## 2. 形状差异（conductor 必须吸收）

### beat

- `getStatus({cwd, book, chapter})`：没有账本返回 `null`；未传 book 时会按文件 mtime 选一本——conductor 必须显式传 book。
- `getRevision`：返回 `{revision, updatedAt, latestRevisionId}` 或 `null`。
- `getCanon`：返回 `{schemaVersion, revision, canon[], obligations[], decisions[]}`；conductor 把它压成 ≤800 字。
- `getArtifact`：**扁平** `{found, artifactId, revision, kind, revisionId, hash, at, segment?}`；`revision` 是**当前账本版本**，不是产物版本。旧产物 revision 可以小于当前 revision。
- 事件 `onDidCommit` payload：`{kind, tool, book, chapter, ids, revision, commitId, at}`，**没有 cwd / agentId / 步骤窗口**。

### fade

- 只接受**绝对** `cwd`；相对路径抛 `bad-dir`。
- 缺 memory 时 `getStatus` / `getRevision` / `getBrief` 返回 `null`。
- `getBrief` 返回 `{markdown, chars, revision, generated_at, ...}`，`budget` 已由入参控制。
- `getArtifact` 未 verify 时返回 `{found, artifactId, ...}`；`verify:true` 时把产物嵌在 `artifact` 字段里。
- 事件 `onDidChange` payload：`{kind, book, revision, at}`，**没有 cwd**。

### voice

- `identity()` 是**函数**，返回 `{plugin, version, service_version, capabilities, dir, readOnly}`。
- `cwd` 优先、兼容 `dir`；`serviceRoot` 只检查非空字符串，**不检查绝对路径**——conductor 必须传绝对 cwd。
- `getBrief` 成功时返回 `{markdown, chars, tokensEstimate, revision, generated_at, ...}`；无档案返回 `{ok:false, code:'no-profile'}`。
- `voice_check` 是**工具**，不是服务方法：结果带 `status:'completed'|'skipped'|'failed'`、`pass`、`revision`、`findings[]`。`pass:false` 是内容命中 block，不是工具执行失败。
- 事件 `onDidChange` payload：`{book, revision, at, kind}`，**没有 cwd**。

## 3. 宿主收据

```text
ctx.on('tools/result', (exec, result) => …)
  exec.name / exec.agent.id / exec.arguments / exec.callId?
  result.isError / result.value
```

- 只收 `beat_` / `memo_` / `voice_` / `fic_` 前缀。
- 按 `exec.agent.id` + run.book + run.chapter + `dir/cwd` + 当前步骤窗口绑定；事件本身没有 cwd，工具参数里的 `dir/cwd` 用来和 run 的 cwd 对账。
- `callId` 缺失时用 `agent|tool|args|value` 的 sha1 生成稳定 id；重复 id 只记一次。
- 收据投影只保留判定需要的字段：`memo_digest` 只留卡片数，正文/卡片正文不落盘。

## 4. 判定表

| 步骤 | 通过条件 |
|---|---|
| `preflight` | 必需能力 `installed && ready`；否则 `blocked` |
| `write` | 文件存在、字数差 ≤ max(20, 5%)、声明 sha1 一致 |
| `segment` | 本步骤窗口有 `beat_segment` 成功收据；收据 segmentId 与提交 artifactId 一致；`novelBeat.getArtifact` 找到且 hash 一致；revision 不要求相等 |
| `verify` | `beat_verify.verified === true` 且 `pass` 不为 false；`voice_check.pass === true` 且 `status` 不为 failed/skipped；两者矛盾时拒绝 |
| `digest` | 本步骤窗口有 `memo_digest` 成功收据；fade revision 不落后于收据；有 artifactId 时 `getArtifact` 找到 |
| `close` | 所有非 close 步骤 done；没有 required 步骤 `verified:false`；committedArtifacts 非空；beat required 时回读 `lastSegment`，回退则退回 segment |

## 5. 已知缺口（0.1 不做）

- `on`（会话开关）不可从服务观测：`capabilityMatrix.on = null`，不猜。
- 事件没有 cwd/agentId/步骤窗口：conductor 只能按自己 run 的 agent/book/chapter + 步骤窗口绑定；同一 agent 同时只允许一个活动 run。
- fanfic（0.1.2 起已适配，只读，**分支能力**）：只有本次 `required_capabilities` 显式写了 `fanfic` 才探测；
  不写就一次都不调 fanfic 服务，矩阵里是 `reason:'not-required'`（原创长篇的默认路径）。探测存在时 `installed:true`，按 `getStatus().data.imported/chapters` 判 `ready`；
  缺项目 → `ready:false, reason:'NO_PROJECT'`，不阻塞其它能力。`required_capabilities` 里带 `fanfic` 时：
  上下文多一段 ≤800 字的世界契约，`verify` 只认 `fic_check` 收据里的 `pass:true` + `source:'canon'` + 整数 `revision`（夹具结果不算验收）。
- 真实 DSH 宿主的一章验收尚未跑：当前集成测试用真实 beat 服务 + 合成 `tools/result`。
- `failed` 不是终态：`cue_run({action:"resume"})` 会重置当前步骤，可以重试；`completed/blocked/aborted` 才是终态。

---

## 6. 0.2.0 书身份、锁与网关

### 6.1 书身份

```jsonc
// <workspace>/.dsh-novel-conductor/book.json
{ "schemaVersion": 1, "bookId": "bk-<uuid>", "book": "斗罗", "title": "斗罗大陆", "createdAt": "..." }

// 多书工作区
{ "schemaVersion": 1, "books": [{ "bookId": "bk-...", "book": "书A", "title": "书A" }, ...] }
```

- 单书工作区 `agent/created` 自动绑定；多书工作区未 `cue_scope bind` 前不开放创作工具。
- run 目录：`books/<bookId>/runs/<runId>/`；旧 `runs/<runId>` 只读兼容。
- 受管工具参数里的 `book/bookId/dir` 必须与绑定一致；`write`/`edit` 路径必须在书工作区内。

### 6.2 锁

```jsonc
// <workspace>/.dsh-novel-conductor/locks/<resource>.lock
{
  "protocolVersion": 1, "resourceId": "book-write",
  "workspaceKey": "D:\\Novels\\douluo", "bookId": "bk-...",
  "flowId": "run-...", "ownerToken": "...", "generation": 1,
  "hostId": "...", "pid": 12345, "processStartTime": "...",
  "heartbeatAt": "...", "ttlMs": 30000, "pendingTransactionIds": []
}
```

- `alive` = 同机 + PID 存在；`dead` = 同机 + PID 不存在；`unknown` = 异机/坏记录/权限不足。
- `unknown` 拒绝自动接管；`dead` 也需要作者命令 `/cue locks break`。
- 0.2.0 不自动回收、不强杀；`break` 是作者的人工仲裁（模型工具 `cue_locks` 只能 status）。

### 6.3 ProviderPolicy / 网关

```jsonc
// <workspace>/.dsh-novel-conductor/providers.json
{
  "schemaVersion": 1,
  "providers": {
    "my_writer_tool": {
      "effects": ["write"],
      "stateScope": "book",
      "bindings": [{ "pointer": "/book", "source": "book", "semantics": "value", "onConflict": "reject" }],
      "allowedRoots": ["正文"],
      "retry": "never"
    }
  }
}
```

- `effects`: `read|write|external|destructive`；`stateScope`: `stateless|book|global|unknown`。
- 未配置的第三方工具默认 `policy-required` 拒绝；MCP 默认 `effects:["external"], stateScope:"unknown"`。
- `cue_call` 只调一个工具；拒绝 `cue_*`、`run_code`、`skill`、`subagent` 等保留名。
- gateway 收据：

```jsonc
{
  "kind": "gateway", "tool": "my_writer_tool", "callId": "cue:run-...:...",
  "operationId": "sha256:...", "purpose": "...", "bookId": "bk-...", "runId": "run-...",
  "argsHash": "sha256:...", "resultHash": "sha256:...", "isError": false,
  "effects": ["write"], "stateScope": "book", "bound": true, "source": "config", "at": "..."
}
```

### 6.4 0.2.0 仍不保证

- COMMON-WRITER 未跨包落地：只锁 conductor 可见写入口，旁路仍可能。
- PTC/`run_code` 下的嵌套网关未验证；native 路径已实现。
- 同 cwd 多书正文：0.2.0 硬拦多书工作区的 `cue_run start` 与 `write`/`edit`；kit P0 修复前只允许一书一工作区。
- `global/unknown` 状态插件不保证隔离；串行不消除缓存串读。
