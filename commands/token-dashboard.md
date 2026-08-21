---
description: Open a local live dashboard for Codex context and token usage.
---

# Token Observatory

Open the local Codex Token Observatory.

1. Resolve the installed plugin directory and run its bundled `scripts/observer.mjs` with `--open`.
2. Tell the user the localhost URL and that the window is local-only.
3. If the app-server connection is unavailable, keep the dashboard open and explain that it has degraded to rollout-history mode.
4. Do not print prompt contents, credentials, or raw rollout lines.

The dashboard shows:

- current context input tokens and model context window;
- output tokens per second;
- current, daily, and lifetime cache tokens;
- today's usage and usage since the active reset window;
- usage grouped by model when the source records the model;
- a clear unavailable state for data Codex does not expose, including unused-model quota.
