# conductor 0.1.0 · 模拟验收（2026-11-21）

> 口径：**模拟验收**，不是真实 DSH 宿主验收。使用确定性假服务 + 合成 `tools/result`，走完
> `preflight → await_author → write → segment → verify → digest → close`；证明状态机、收据归属、
> 服务回查、close gate 在一条真实形状的链路上成立。

## 场景

- 书：模拟验收书 ／ 第 13 章
- 必需能力：beat / fade / voice
- 起始 beat revision：10；fade revision：21；voice revision：30
- 作者拍板：一条 pending 决策，resume 前清除

## 结果

- run：`run-20261121133021-a43d76`，最终状态 **completed**
- 步骤：6 / 6 完成
- 收据：4 条
- 已核验产物：3 个
- 结论：**PASS（模拟）**

### 步骤

| 步骤 | 状态 | 证据 | 产物 |
|---|---|---|---|
| preflight | done | — | — |
| write | done | verified | 正文/第13章.md |
| segment | done | verified | s-101 |
| verify | done | verified | — |
| digest | done | verified | digest:ch13:v1 |
| close | done | verified | — |

### 收据

| seq | 工具 | agent | book | 结果 |
|---|---|---|---|---|
| 1 | beat_segment | acceptance-simulator | 模拟验收书 | ok |
| 2 | beat_verify | acceptance-simulator | 模拟验收书 | ok |
| 3 | voice_check | acceptance-simulator | 模拟验收书 | ok |
| 4 | memo_digest | acceptance-simulator | 模拟验收书 | ok |

### 产物引用

```json
[
  {
    "path": "正文/第13章.md",
    "chars": 23,
    "sha1": "sha1:f4cf53500dc02ef1b406574efe6d552acdead579",
    "kind": "chapter"
  },
  {
    "artifactId": "s-101",
    "kind": "beat",
    "revision": 11,
    "revisionId": "r-11",
    "hash": "abababababababababababababababababababababababababababababababab",
    "artifactKind": "segment"
  },
  {
    "artifactId": "digest:ch13:v1",
    "revision": 21,
    "hash": "sha256:feed",
    "cards": 2,
    "kind": "fade"
  }
]
```

## 边界

- 没有启动真实 DSH 宿主；宿主事件是合成的，但经过与宿主相同的 `{ exec, result }` 形状。
- 没有真实 beat/fade/voice 账本；服务是确定性的假实现，返回真实服务的字段形状。
- 因此这份报告只能说明“模拟链路通过”，不能替代真实一章验收。
