# Codex / pi Token Observatory

一个本地优先的 Codex 与 pi token 监控插件。页面支持切换两个进程：Codex 通过 app-server 与本地 rollout JSONL 获取数据，pi 读取 `~/.pi/agent/sessions` 中的本地会话 JSONL，并在浏览器窗口展示：

- 当前上下文输入 token / context window；
- 输出 token 每秒速度；
- 当前、今日和累计缓存 token；
- 当日使用 token；
- 当前限流窗口重置以来使用 token；
- 可识别模型的 token 分布；
- 不可由 Codex 或 pi 可靠获得的数据，会显示为不可用而不是猜测；数据不上传。

## 运行

```bash
node plugins/codex-token-observer/scripts/observer.mjs --open
```

然后访问终端输出的 `http://127.0.0.1:4399`。页面右上角的“自动刷新”开关可以暂停/恢复数据轮询；线程下拉框不会在轮询时重建。也可以执行：

```bash
CODEX_TOKEN_OBSERVER_PORT=4400 node plugins/codex-token-observer/scripts/observer.mjs
```

如果使用非默认 Codex 数据目录：

```bash
CODEX_HOME=/path/to/codex-home node plugins/codex-token-observer/scripts/observer.mjs
```

## 设计取舍

Codex 插件 manifest 是技能、命令、MCP 和 hooks 的扩展包，不提供直接改写原生 TUI 的公开 UI API。因此本插件把独立窗口作为稳定边界：监控服务只绑定 loopback，页面不需要登录，数据不离开本机。

Codex 优先级如下：

1. app-server `thread/tokenUsage/updated`：当前线程真实 usage、上下文容量和实时速度；
2. app-server `account/usage/read`：官方当日/累计账号使用；
3. 本地 rollout JSONL：按模型和缓存趋势的补充聚合。

pi 使用本地 `~/.pi/agent/sessions/**/*.jsonl` 的模型调用 usage，pi 不提供 Codex rate-limit 重置窗口，因此对应额度信息显示为不可用。

## 安装为本地插件

在 Codex 插件目录中安装 `plugins/codex-token-observer`，或从 Codex 的本地插件安装入口选择本目录。安装后使用 `/token-dashboard`，或直接运行上面的 Node 命令。

## 验证

```bash
node --check plugins/codex-token-observer/scripts/observer.mjs
node --check plugins/codex-token-observer/web/app.js
```
