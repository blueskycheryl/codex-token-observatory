#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";

const args = process.argv.slice(2);
const threadIndex = args.indexOf("--thread-id");
const threadId = threadIndex >= 0 ? args[threadIndex + 1] : null;
if (threadIndex >= 0 && !threadId) {
  console.error("用法：node scripts/account-usage.mjs [--thread-id THREAD_ID]");
  process.exit(2);
}

const configuredBin = process.env.CODEX_BIN;
const defaultBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexBin = configuredBin || (fs.existsSync(defaultBin) ? defaultBin : "codex");
const params = threadId ? { threadId } : undefined;

const child = spawn(codexBin, ["app-server", "--stdio"], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: child.stdout });
let settled = false;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(code, value, error = false) {
  if (settled) return;
  settled = true;
  if (error) console.error(value);
  else console.log(JSON.stringify(value, null, 2));
  rl.close();
  child.kill();
  process.exitCode = code;
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id === 1) {
    if (message.error) return finish(1, message.error, true);
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const request = { jsonrpc: "2.0", id: 2, method: "account/usage/read" };
    if (params) request.params = params;
    send(request);
    return;
  }

  if (message.id === 2) {
    if (message.error) return finish(1, message.error, true);
    finish(0, message.result);
  }
});

child.on("error", (error) => finish(1, error.message, true));
child.on("exit", (code) => {
  if (!settled) finish(code || 1, `codex app-server 已退出，退出码：${code}`, true);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: {
      name: "codex-token-observatory-cli",
      title: "Codex Token Observatory CLI",
      version: "0.1.0",
    },
  },
});
