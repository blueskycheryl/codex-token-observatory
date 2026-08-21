# Codex Token Observatory 设计说明

## 优化后的需求定义

“不同模型使用的 token”按模型聚合；“重置以来”定义为当前 Codex rate-limit 主窗口起点至今，而不是凭本地启动时间猜测。所有数据都带来源和降级路径：实时数据优先 app-server，历史数据使用本地 rollout JSONL，无法获得的数据显示不可用。

## 架构

```text
Codex app-server ── JSON-RPC / notifications ──┐
                                               ├─ observer.mjs ── localhost HTTP ── dashboard
$CODEX_HOME/sessions + archived_sessions ─────┘
```

- `thread/tokenUsage/updated`：当前线程的 `last`、`total`、context window、实时输出速率。
- `account/usage/read`：官方当日、累计和线程 billing usage。
- rollout JSONL：按时间做累计 token 差分，得到重置窗口和按模型历史。
- 只监听 `127.0.0.1`，不读取或上传 prompt 内容。

## 界面设计

采用“夜间观测台”方向：深墨绿底、荧光绿作为主信号、青色表示缓存、琥珀色表示窗口/速度。首屏按“当前上下文 → 输出速度 → 缓存 → 账户窗口 → 模型分布 → 当前线程”组织，先看实时风险，再看累计消耗。

## 自评与边界

- 真实度：当前 token 不依赖字符数或 tokenizer 估算；使用 Codex 原生字段。
- 降级：app-server 不可用时仍可查看 rollout 历史，页面明确标记来源。
- 防误导：未使用模型的配额不是公开可靠字段，不显示伪造的 0。
- 成本：历史文件按 `mtime + size` 增量重扫，app-server 请求按 5 秒节流，前端仅 1 秒刷新 localhost JSON。
- 兼容：Node.js 20+、无 npm 依赖；`CODEX_HOME` 和 `CODEX_BIN` 可覆盖。
- 已知限制：旧 rollout 可能缺少模型字段，归入“未知模型”；账户接口的 lifetime/daily 数据不一定包含每个模型明细，因此模型表以本地历史为准。

## 验收标准

1. `node --check` 通过。
2. `GET /api/health` 返回 app-server 状态。
3. `GET /api/state` 至少返回 connection、current、account、resetWindow、models、throughput。
4. 断开 app-server 后服务不崩溃，历史仍可加载。
5. dashboard 只使用 loopback，不暴露 token/prompt 内容。
