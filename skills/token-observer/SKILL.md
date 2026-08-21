---
name: token-observer
description: Open the local Codex Token Observatory to inspect real-time context window usage, token throughput, cache tokens, daily usage, reset-window usage, lifetime usage, and model breakdown. Use when the user asks about Codex token usage, context limits, cache usage, tokens per second, or a usage dashboard.
---

# Codex Token Observatory

Use the bundled local dashboard when the user asks to see or inspect Codex token usage.

## Start

From the plugin directory, run:

```bash
node scripts/observer.mjs --open
```

The dashboard listens on `http://127.0.0.1:4399`. Set `CODEX_TOKEN_OBSERVER_PORT` to use another port.

If the plugin is installed outside the current repository, resolve the plugin directory first and run the script by absolute path:

```bash
node <plugin-dir>/scripts/observer.mjs --open
```

For a non-GUI environment, omit `--open` and navigate to the printed localhost URL.

## Data contract

- Current context, current turn, cache hit rate, and output velocity use Codex app-server `thread/tokenUsage/updated` data when available.
- Account daily/lifetime usage uses `account/usage/read` when available.
- Reset-window usage and model history are derived from local rollout JSONL files under `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`.
- Unknown model names are grouped as `未知模型`; never infer a model from the prompt text.
- Codex does not expose unused model quota as a reliable token count. Keep that value unavailable rather than displaying a misleading zero.

## Privacy and troubleshooting

The server binds to loopback only and never sends prompts or token data over the network. If app-server is unavailable, the dashboard remains useful with local rollout history and shows the degraded source in the UI. Set `CODEX_HOME` when monitoring a non-default Codex profile.
