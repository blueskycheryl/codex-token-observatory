# Codex / pi Token Observatory

## 源码启动说明

这是一个本地优先的 Codex / pi Token Observatory。服务只监听 `127.0.0.1`，不会上传 prompt、会话或 token 数据。

## 环境要求

- Node.js 18+
- Codex 模式：本机安装并登录 Codex，且 `codex` 命令可用
- pi 模式：本机存在 `~/.pi/agent/sessions`
- pi 不是必需依赖；没有 pi 不影响 Codex 模式

项目不需要执行 `npm install`，只使用 Node.js 内置模块。

## macOS / Linux 启动

在项目根目录执行：

```bash
node scripts/observer.mjs --open
```

启动后访问：

```text
http://127.0.0.1:4399
```

macOS 会自动打开浏览器；Linux 可手动打开上面的地址。

## 后台启动

```bash
nohup node scripts/observer.mjs --open \
  >/tmp/codex-token-observer.log 2>&1 &
```

查看日志：

```bash
tail -f /tmp/codex-token-observer.log
```

停止服务：

```bash
pkill -f 'codex-token-observer/scripts/observer.mjs'
```

## Windows 启动

在项目根目录打开 PowerShell：

```powershell
node scripts\observer.mjs
```

然后访问：

```text
http://127.0.0.1:4399
```

也可以双击：

```text
packaging/windows/start-observer.cmd
```

### Windows 后台启动

在项目根目录打开 PowerShell：

```powershell
Start-Process -FilePath node `
  -ArgumentList "scripts\\observer.mjs" `
  -WorkingDirectory (Get-Location) `
  -WindowStyle Hidden

Start-Process "http://127.0.0.1:4399"
```

如果需要记录日志：

```powershell
Start-Process -FilePath node `
  -ArgumentList "scripts\\observer.mjs" `
  -WorkingDirectory (Get-Location) `
  -RedirectStandardOutput "observer.log" `
  -RedirectStandardError "observer-error.log" `
  -WindowStyle Hidden
```

## 自定义路径和端口

```bash
CODEX_HOME=/path/to/.codex \
PI_HOME=/path/to/.pi/agent \
CODEX_BIN=/path/to/codex \
CODEX_TOKEN_OBSERVER_PORT=4400 \
node scripts/observer.mjs --open
```

## 验证服务

```bash
curl http://127.0.0.1:4399/api/health
curl http://127.0.0.1:4399/api/state
```

正常情况下，`/api/state` 会返回当前进程、线程、上下文、今日使用量和模型分布。

## 官方协议参考

Codex App Server 官方文档：

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Rate limits (ChatGPT)](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
- [Token usage (ChatGPT)](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)

文档中正式列出了：

- `account/rateLimits/read`
- `account/rateLimits/updated`
- `account/usage/read`
- `thread/tokenUsage/updated`

`thread/tokenUsage/updated` 的详细字段可能随 Codex 版本变化。可以用本机 Codex 生成与当前版本匹配的 schema：

```bash
codex app-server generate-json-schema --out ./schemas
codex app-server generate-ts --out ./schemas
```

然后搜索：

```bash
rg -n "ThreadTokenUsageUpdatedNotification|thread/tokenUsage/updated" schemas
```

这些是 app-server 的 JSON-RPC 协议，不是建议直接调用的稳定 REST API。

### 命令行查询账号 usage

项目提供了一个 CLI 脚本，会自动完成 `initialize`，再发送 `account/usage/read`：

```bash
node scripts/account-usage.mjs
```

查询指定线程的官方 usage：

```bash
node scripts/account-usage.mjs --thread-id THREAD_ID
```

如果 Codex 不在默认路径：

```bash
CODEX_BIN=/path/to/codex node scripts/account-usage.mjs
```

脚本通过本机 `codex app-server --stdio` 工作，认证由 Codex 管理，不需要手动复制登录 token。

## 页面数据来源说明

页面本身只请求本机接口：

```text
浏览器 → http://127.0.0.1:4399/api/state → observer.mjs
```

页面不会直接访问 Codex、pi 或模型服务。`observer.mjs` 根据当前进程，从下面的数据源汇总状态。

### 1. Codex 数据源

| 页面内容 | 数据来源 | 说明 |
| --- | --- | --- |
| 当前线程、线程列表 | Codex app-server `thread/list` | 当前 Codex app-server 能看到的线程 |
| 当前上下文、当前 turn、当前缓存 | app-server `thread/tokenUsage/updated` | 有实时通知时使用；否则使用本地 rollout 记录 |
| 实时 `OUTPUT VELOCITY` | app-server token usage 通知 | 标记为 `LIVE`；只在收到实时事件时计算 |
| 最近观测速度 | 本地 rollout JSONL 最近两次 `token_count` | 标记为 `RECENT`，不是实时速度 |
| 今日/累计使用 | `account/usage/read` | 官方接口可用时优先使用 |
| 今日/累计使用 fallback | 本地 rollout JSONL | 官方 usage 接口失败时使用 |
| 剩余额度、使用百分比、重置时间 | `account/rateLimits/read` / 更新通知 | 需要 Codex 账号登录和网络访问 ChatGPT 接口 |
| 按模型分布 | 本地 rollout JSONL 的模型字段 | 对本地历史记录聚合 |
| 使用趋势柱状图 | 官方 `dailyUsageBuckets`，失败时本地 JSONL | 支持按月、按周聚合，以及自定义日期区间的每日明细 |
| 上下文容量 | app-server 或 rollout 中的模型 context window | 无法确认时显示不可用 |

Codex 的额度数据虽然由本地 Dashboard 展示，但来源是 Codex app-server 请求的官方账号接口，不是本地 JSONL。网络或登录失效时，历史 token 仍可能正常，但额度和重置时间会不可用。

### “累计使用”的时间范围

- Codex 官方数据：`summary.lifetimeTokens`，含义是账号可用历史范围内的累计 token，不是月度统计；官方接口没有把它定义为“本月使用量”。
- Codex fallback：当前本机 rollout JSONL 能扫描到的全部历史，不一定覆盖账号创建以来的所有会话。
- pi 数据：当前本机 `~/.pi/agent/sessions` 中所有可读取会话的累计值，也不等同于账号级累计。
- “重置以来”：按当前额度窗口的 `resetsAt` 统计本地 rollout 记录，不是官方 lifetime 值。

### 2. pi 数据源

默认读取：

```text
~/.pi/agent/sessions/**/*.jsonl
```

具体字段：

| 页面内容 | 数据来源 | 计算方式 |
| --- | --- | --- |
| 今日/累计使用 | pi 会话中的模型调用 `usage` | 汇总 `totalTokens` |
| 输入上下文 | `input`、`cacheRead`、`cacheWrite` | `input + cacheRead + cacheWrite` |
| 输出 token | `output` | 汇总或最近一次调用 |
| 缓存 | `cacheRead`、`cacheWrite` | 按会话和日期聚合 |
| 按模型分布 | 会话记录的 `model` / `model_change` | 按模型汇总 |
| 上下文容量 | `~/.pi/agent/models.json`、`models-store.json` | 读取对应模型的 `contextWindow` |
| 最近观测速度 | 最近两次会话 usage 记录 | 只标记为 `RECENT` |

pi 的本地会话 JSONL 没有 Codex rate-limit 数据，因此 pi 模式不显示 Codex 剩余额度和重置窗口。

### 3. 本地数据与远程数据清单

#### 完全来自本地

- Dashboard 页面、轮询和数据聚合逻辑。
- Codex rollout JSONL：
  - `~/.codex/sessions/**/*.jsonl`
  - `~/.codex/archived_sessions/**/*.jsonl`
- pi 会话 JSONL：`~/.pi/agent/sessions/**/*.jsonl`。
- pi 模型配置：`~/.pi/agent/models.json`、`models-store.json`。
- Codex 本地历史中的模型分布、缓存、今日使用 fallback、累计使用 fallback。
- pi 的今日使用、累计使用、上下文使用量、模型分布和缓存。
- 本机 `codex app-server` 进程、线程列表和本地线程状态。

#### 需要 Codex app-server 访问官方接口

以下请求由本机 app-server 发起，但数据最终来自 Codex / ChatGPT 官方服务：

- `account/usage/read`：官方今日使用、累计使用和账号 usage summary。
- `account/rateLimits/read`：剩余额度、已使用百分比、重置时间和窗口长度。
- `account/usage/read { threadId }`：官方线程 usage / billing 数据。

因此，“Dashboard 在本机运行”不等于“所有数据都离线”。额度和官方账号 usage 依赖网络、登录状态和官方接口可用性。

#### 两者的优先级

```text
官方 Codex usage 可用  →  优先使用官方数据
官方接口失败          →  使用本地 rollout 历史 fallback
本地 JSONL 也没有      →  显示不可用
```

页面打开、刷新、切换线程只请求本机 Dashboard API，不会发起新的模型对话，也不会因为访问页面而消耗 token。

## 常见问题

### 页面显示 `{"error":"not found"}`

确认访问的是根地址：

```text
http://127.0.0.1:4399/
```

不要把 `/api/state` 当作页面地址。

### 页面能打开但没有额度

检查：

```bash
curl http://127.0.0.1:4399/api/state
```

如果 `connection.error` 包含 `token usage profile fetch timed out`，说明 Codex 官方额度接口超时；这不是页面启动失败。

### 端口被占用

```bash
lsof -nP -iTCP:4399 -sTCP:LISTEN
```

换端口启动：

```bash
CODEX_TOKEN_OBSERVER_PORT=4400 node scripts/observer.mjs --open
```

### Codex CLI 找不到

```bash
command -v codex
```

找不到时，设置：

```bash
CODEX_BIN=/path/to/codex node scripts/observer.mjs --open
```
