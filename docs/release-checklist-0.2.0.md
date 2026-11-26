# conductor 0.2.0 发布前检查清单（2026-11-26）

> 状态：**已发布 0.2.0**（npm / GitHub v0.2.0，2026-11-26）。本清单记录已跑过的门禁和发布后仍需注意的验收；不把单测当宿主验收。

## 1. 版本与范围

- 包：`dsh-novel-conductor`，`package.json` **0.2.0**（npm 最新仍是 0.1.4，未发布）。
- 新增：`book.json`/`books.json`、`bookId`、按 agent 技能、参数/路径门、每书锁、`cue_scope`/`cue_locks`/`cue_tools`/`cue_call`、runbook 视图、兄弟版本适配。
- 适配基线：beat 0.12.1、fade 0.8.2、voice 0.4.0、fanfic 0.4.3、DSH 0.2.2-rc.5。

## 2. 已跑门禁

```bash
cd D:/Novel-gate/dsh-novel-conductor
node --test          # 102/102 pass（2026-11-26）
npm run check        # exit 0
npm pack --dry-run   # 38 files / 70.5 kB / 230.1 kB unpacked
```

- `node --test`：102 tests / 102 pass / 0 fail。
- `npm run check`：index + 全部新增 lib + adapters 语法通过。
- `npm pack --dry-run`：包含 `lib/scope.js`、`scope-manager.js`、`locks.js`、`gateway.js`、`runbook.js`、README/CHANGELOG/contract。

## 3. 发布前仍需补

| 项 | 状态 | 说明 |
|---|---|---|
| Codex 只读代码审查 | 已回，10 条 P0 已修 | P1（旧 run 兼容、takeover 原子性）留下个补丁；见 CHANGELOG |
| 真实 DSH 宿主整章 | 未做 | 需要重启 DSH 加载 0.2.0 后，用真书跑 chapter_write |
| COMMON-WRITER 跨包 | 未落地 | conductor 只锁自己可见写入口；kit 面板/remote/独立插件仍可旁路 |
| PTC/`run_code` 嵌套 | 未验证 | 本版网关按 native 路径实现；PTC 下会拒绝 `PTC→SDK→cue_call` |
| 同 cwd 多书写正文 | 已硬拦 | kit 正文路径 P0 未修前，多书工作区不开放 `cue_run start`/`write`/`edit` |
| 锁自动回收 | 未做 | 只支持作者命令 `/cue locks break`；模型工具不能 break |
| 全局状态第三方插件 | 不保证 | `global/unknown` 默认拒绝写；串行不消除缓存串读 |

## 4. 安装与回滚

- 本地开发：profile 仍 `link:D:/Novel-gate/dsh-novel-conductor`；重启 DSH 后加载 0.2.0。
- npm 安装：`dsh plugin add dsh-novel-conductor`（发布后）。
- 回滚：把 profile 里的版本固定回 0.1.4 / 对应 tarball，重启 DSH；数据兼容——0.2.0 只新增 `book.json`/`books/`，旧 `runs/` 保留只读。
- 不要在没有备份的情况下删除 `.dsh-novel-conductor/books/` 或 `locks/`。

## 5. 发布说明必须如实写

- 102/102 是单测，不是真实宿主验收。
- 0.2.0 的多书隔离以「一书一工作区」为硬边界；同工作区多书只允许身份/只读，写正文被硬拦。
- 第三方插件只对「工具型」可零源码接入；未知状态默认拒绝，零配置不成立。
- 仍不保证 COMMON-WRITER 跨包、PTC 嵌套、全局状态插件隔离。
