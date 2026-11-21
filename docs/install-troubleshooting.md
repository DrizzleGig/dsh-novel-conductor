# 安装故障排查：node_modules 里残留的 junction

## 症状

从插件市场/“添加插件”安装 `dsh-novel-conductor` 时直接失败，插件管理页显示异常；`plugin_manager` 返回：

```text
[ERR_PNPM_EPERM] [importPackage .../node_modules/dsh-novel-conductor]
EPERM: operation not permitted, rename
'.../node_modules/dsh-novel-conductor_tmp_...'
-> '.../node_modules/dsh-novel-conductor'
```

## 原因

之前用 `link:D:/Novel-gate/dsh-novel-conductor` 本地安装时，profile 的 `node_modules/dsh-novel-conductor` 是一个 **junction**。卸载只移除了 `package.json` 的依赖和 `dsh.profile.bundles` 里的条目，**没有删除这个 junction**；重新安装时 pnpm 无法原子地把新包 rename 到这个位置，于是 EPERM。

这跟插件代码无关；`ctx.novelConductor` 的报错是旧失败模块留下的内存错误，不是 0.1.1 的代码。

## 修复

1. 确认 profile 的 `node_modules/dsh-novel-conductor` 是 junction：

   ```powershell
   Get-Item "C:\Users\liyicheng\.dsh\profiles\desktop\node_modules\dsh-novel-conductor" |
     Select-Object Name, LinkType, Target
   ```

2. 把残留 junction 移走（只删链接，不动源码）：

   ```powershell
   cmd /c rmdir "C:\Users\liyicheng\.dsh\profiles\desktop\node_modules\dsh-novel-conductor"
   ```

   如果提示被占用，完全退出 DSH（包括托盘）后再做。

3. 重新从插件市场/`plugin_manager install_bundle` 安装。成功时输出 `+ dsh-novel-conductor 0.1.1`，并出现 `include:novel-conductor`、`fiberPhase=active`。

4. 验证：

   ```text
   cue_status
   → { ok:false, code:'no-run', message:'还没有任何 run；先 cue_run start' }
   ```

   `no-run` 是业务错误，说明插件已经加载；如果报 `cannot set property ...` 或加载失败，才是另一个问题。

## 本次实测

- 安装版本：`dsh-novel-conductor@0.1.1`（npm，非 link）。
- `plugin_manager` 条目：`include:novel-conductor`，`enabled:true`，`fiberPhase:active`。
- 真实宿主 solo 冒烟：`cue_run(start)` → `write` → `close`，run 状态 `completed`，1 个 chapter artifact。
