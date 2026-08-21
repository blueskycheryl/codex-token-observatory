#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const PI_HOME = process.env.PI_HOME || path.join(os.homedir(), ".pi", "agent");
const PORT = Number(process.env.CODEX_TOKEN_OBSERVER_PORT || process.env.PORT || 4399);
const HOST = process.env.CODEX_TOKEN_OBSERVER_HOST || "127.0.0.1";
const POLL_MS = 5000;
const HISTORY_POLL_MS = 1000;
const MAX_THREADS = 100;

const state = {
  generatedAt: null,
  activeProcess: "codex",
  selectedThreadByProcess: { codex: null, pi: null },
  connection: { status: "starting", transport: "app-server", error: null },
  threads: [],
  selectedThreadId: null,
  threadUsage: {},
  liveThreadIds: new Set(),
  accountUsage: null,
  rateLimits: null,
  rateLimitCredits: null,
  history: { files: new Map(), lastScanAt: null, error: null },
  piHistory: { files: new Map(), lastScanAt: null, error: null },
  throughput: { current: 0, average: 0, series: [], source: "idle" },
  lastUsageSample: null,
  server: { port: PORT, host: HOST, codexHome: CODEX_HOME, piHome: PI_HOME },
};

const pending = new Map();
let requestId = 0;
let appServer = null;
let appServerReady = null;
let lastListAt = 0;
let lastAccountAt = 0;
let lastHistoryAt = 0;

const zeroBreakdown = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

let piModelContexts = null;
function getPiModelContext(modelId) {
  if (!piModelContexts) {
    piModelContexts = new Map();
    const sources = [path.join(PI_HOME, "models.json"), path.join(PI_HOME, "models-store.json")];
    for (const file of sources) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const providers = data.providers ? Object.values(data.providers) : Object.values(data);
        for (const provider of providers) for (const model of provider?.models || []) {
          if (!model.contextWindow) continue;
          piModelContexts.set(model.id, number(model.contextWindow));
          if (model.provider) piModelContexts.set(`${model.provider}/${model.id}`, number(model.contextWindow));
        }
      } catch { /* optional local model registry */ }
    }
  }
  return piModelContexts.get(modelId) || piModelContexts.get(String(modelId || "").split("/").pop()) || null;
}

function addBreakdown(target, source, factor = 1) {
  for (const key of Object.keys(zeroBreakdown())) target[key] += number(source?.[key]) * factor;
  return target;
}

function normalizedBreakdown(source) {
  return addBreakdown(zeroBreakdown(), source);
}

function localDate(value = Date.now()) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isoMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || JSON.stringify(error);
}

function sendRpc(message) {
  if (!appServer || !appServer.stdin.writable) return false;
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
  return true;
}

function request(method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!sendRpc({ jsonrpc: "2.0", id, method, params })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("app-server is not connected"));
    }
  });
}

function handleRpc(message) {
  if (message?.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || `RPC error ${message.error.code}`));
    else entry.resolve(message.result);
    return;
  }

  if (message?.method === "thread/tokenUsage/updated") {
    const params = message.params || {};
    state.threadUsage[params.threadId] = params.tokenUsage;
    state.liveThreadIds.add(params.threadId);
    updateThroughput(params.tokenUsage?.last);
  } else if (message?.method === "account/rateLimits/updated") {
    state.rateLimits = message.params?.rateLimits || message.params || null;
  }
}

function recordThroughput(rate, source) {
  const bounded = Math.max(0, Math.min(100000, rate));
  state.throughput.current = state.throughput.current ? state.throughput.current * 0.65 + bounded * 0.35 : bounded;
  state.throughput.series.push(Math.round(state.throughput.current));
  if (state.throughput.series.length > 36) state.throughput.series.shift();
  const samples = state.throughput.series;
  state.throughput.average = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  state.throughput.source = source;
}

function updateThroughput(last) {
  if (!last) return;
  const now = Date.now();
  const output = number(last.outputTokens);
  const previous = state.lastUsageSample;
  if (previous && now > previous.at && output >= previous.output) {
    recordThroughput((output - previous.output) / ((now - previous.at) / 1000), "live");
  }
  state.lastUsageSample = { at: now, output };
}

function updateHistoryThroughput(entry) {
  const events = entry?.events || [];
  if (events.length < 2) return;
  const last = events.at(-1);
  const previous = events.at(-2);
  const elapsed = (last.at - previous.at) / 1000;
  if (elapsed <= 0 || Date.now() - last.at > 5000 || number(last.usage?.outputTokens) <= 0) return;
  state.lastUsageSample = { at: Date.now(), output: 0 };
  recordThroughput(number(last.usage.outputTokens) / elapsed, "history");
}

async function connectAppServer() {
  const codexBin = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
  const fallback = process.env.CODEX_BIN ? null : "codex";
  let command = fs.existsSync(codexBin) ? codexBin : fallback;
  if (!command) {
    state.connection = { status: "unavailable", transport: "app-server", error: "Codex CLI not found; set CODEX_BIN." };
    return;
  }

  appServerReady = new Promise((resolve) => {
    appServer = spawn(command, ["app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: appServer.stdout });
    lines.on("line", (line) => {
      try { handleRpc(JSON.parse(line)); } catch { /* app-server may write non-JSON diagnostics */ }
    });
    appServer.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text && state.connection.status !== "ready") state.connection.error = text.slice(-500);
    });
    appServer.on("error", (error) => {
      state.connection = { status: "error", transport: "app-server", error: errorMessage(error) };
      resolve(false);
    });
    appServer.on("exit", (code, signal) => {
      if (state.connection.status === "ready") state.connection = { status: "disconnected", transport: "app-server", error: `exited (${code ?? signal})` };
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("app-server exited"));
        pending.delete(id);
      }
      resolve(false);
    });

    request("initialize", {
      clientInfo: { name: "codex-token-observer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, 12000).then(() => {
      sendRpc({ jsonrpc: "2.0", method: "initialized", params: {} });
      state.connection = { status: "ready", transport: "app-server", error: null };
      resolve(true);
    }).catch((error) => {
      state.connection = { status: "error", transport: "app-server", error: errorMessage(error) };
      resolve(false);
    });
  });
  await appServerReady;
}

async function refreshThreads() {
  if (state.connection.status !== "ready") return;
  try {
    const result = await request("thread/list", {
      limit: MAX_THREADS,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    });
    state.threads = Array.isArray(result?.data) ? result.data : [];
    const codexSelected = state.selectedThreadByProcess.codex;
    if (!codexSelected || !state.threads.some((item) => item.id === codexSelected)) {
      state.selectedThreadByProcess.codex = state.threads[0]?.id || null;
    }
    if (state.activeProcess === "codex") state.selectedThreadId = state.selectedThreadByProcess.codex;
  } catch (error) {
    state.connection.error = errorMessage(error);
  }
}

async function refreshAccountUsage() {
  if (state.connection.status !== "ready") return;
  try {
    state.accountUsage = await request("account/usage/read", null, 12000);
    if (state.selectedThreadId) {
      const threadResult = await request("account/usage/read", { threadId: state.selectedThreadId }, 12000);
      if (threadResult?.threadUsage) state.threadUsage[state.selectedThreadId] = mergeThreadUsage(state.threadUsage[state.selectedThreadId], threadResult.threadUsage);
    }
  } catch (error) {
    state.connection.error = errorMessage(error);
  }
  try {
    const result = await request("account/rateLimits/read", null, 8000);
    state.rateLimits = result?.rateLimits || state.rateLimits;
    state.rateLimitCredits = result?.rateLimitResetCredits || null;
  } catch { /* usage may work while rate-limit endpoint is unavailable */ }
}

function mergeThreadUsage(previous, threadUsage) {
  if (!threadUsage?.groups?.length) return previous || null;
  const total = zeroBreakdown();
  const lastGroup = threadUsage.groups[threadUsage.groups.length - 1];
  for (const group of threadUsage.groups) addBreakdown(total, {
    inputTokens: group.inputTokens,
    cachedInputTokens: group.cachedInputTokens,
    outputTokens: group.outputTokens,
    totalTokens: group.totalTokens,
  });
  return {
    last: previous?.last || null,
    total: previous?.total || total,
    modelContextWindow: previous?.modelContextWindow || null,
    groups: threadUsage.groups,
  };
}

async function walkJsonl(root, output = []) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
  }
  return output;
}

function eventDelta(previous, current) {
  const result = zeroBreakdown();
  for (const key of Object.keys(result)) result[key] = Math.max(0, number(current?.[key]) - number(previous?.[key]));
  if (!previous) result.totalTokens = number(current?.totalTokens);
  else if (number(current?.totalTokens) < number(previous?.totalTokens)) result.totalTokens = number(current?.totalTokens);
  return result;
}

async function parseHistoryFile(file) {
  const events = [];
  let model = "未知模型";
  let contextWindow = null;
  let latest = null;
  let previous = null;
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch { return { events, model, contextWindow }; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row.payload || {};
    const payloadType = payload.type;
    if (payload.model || payload.model_slug) model = payload.model || payload.model_slug;
    if (payload.model_context_window) contextWindow = number(payload.model_context_window) || contextWindow;
    if (payloadType !== "token_count" || !payload.info) continue;
    const info = payload.info;
    const usage = info.total_token_usage || info.totalTokenUsage;
    const current = usage ? {
      inputTokens: usage.input_tokens ?? usage.inputTokens,
      cachedInputTokens: usage.cached_input_tokens ?? usage.cachedInputTokens,
      outputTokens: usage.output_tokens ?? usage.outputTokens,
      reasoningOutputTokens: usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
      totalTokens: usage.total_tokens ?? usage.totalTokens,
    } : null;
    if (!current) continue;
    const lastUsage = info.last_token_usage || info.lastTokenUsage;
    const timestamp = isoMs(row.timestamp);
    latest = { at: timestamp, last: normalizedBreakdown({
      inputTokens: lastUsage?.input_tokens ?? lastUsage?.inputTokens,
      cachedInputTokens: lastUsage?.cached_input_tokens ?? lastUsage?.cachedInputTokens,
      outputTokens: lastUsage?.output_tokens ?? lastUsage?.outputTokens,
      reasoningOutputTokens: lastUsage?.reasoning_output_tokens ?? lastUsage?.reasoningOutputTokens,
      totalTokens: lastUsage?.total_tokens ?? lastUsage?.totalTokens,
    }), total: normalizedBreakdown(current), contextWindow };
    const delta = eventDelta(previous, current);
    events.push({ at: timestamp, date: localDate(timestamp), model, contextWindow, usage: delta });
    previous = current;
  }
  return { events, model, contextWindow, latest };
}

async function refreshHistory() {
  if (Date.now() - lastHistoryAt < HISTORY_POLL_MS) return;
  lastHistoryAt = Date.now();
  const roots = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
  try {
    const files = (await Promise.all(roots.map((root) => walkJsonl(root)))).flat();
    const known = new Set(files);
    for (const file of files) {
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      const marker = `${stat.mtimeMs}:${stat.size}`;
      if (state.history.files.get(file)?.marker === marker) continue;
      const parsed = await parseHistoryFile(file);
      state.history.files.set(file, { marker, ...parsed });
    }
    for (const file of state.history.files.keys()) if (!known.has(file)) state.history.files.delete(file);
    state.history.lastScanAt = Date.now();
    state.history.error = null;
  } catch (error) {
    state.history.error = errorMessage(error);
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text || "").join(" ").trim();
}

async function parsePiHistoryFile(file) {
  const events = [];
  let session = { id: path.basename(file, ".jsonl"), cwd: null, timestamp: null };
  let model = "未知模型";
  let name = "未命名会话";
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch { return { session, events, model, name, latest: null }; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "session") {
      session = { id: row.id || session.id, cwd: row.cwd || null, timestamp: row.timestamp || null };
    } else if (row.type === "model_change") {
      model = row.modelId || row.model || model;
    }
    const userText = row.type === "message" && row.message?.role === "user" ? contentText(row.message.content) : "";
    if (userText && name === "未命名会话") name = userText.replace(/\s+/g, " ").slice(0, 72);
    const raw = row.usage || row.message?.usage;
    if (!raw) continue;
    const usage = normalizedBreakdown({
      inputTokens: raw.input ?? raw.inputTokens,
      cachedInputTokens: raw.cacheRead ?? raw.cachedInputTokens,
      cacheWriteInputTokens: raw.cacheWrite ?? raw.cacheWriteInputTokens,
      outputTokens: raw.output ?? raw.outputTokens,
      reasoningOutputTokens: raw.reasoning ?? raw.reasoningOutputTokens,
      totalTokens: raw.totalTokens ?? raw.total_tokens,
    });
    if (!usage.totalTokens && !usage.inputTokens && !usage.outputTokens) continue;
    const timestamp = isoMs(row.timestamp);
    events.push({ at: timestamp, date: localDate(timestamp), model: row.model || model, usage });
  }
  const total = zeroBreakdown();
  for (const event of events) addBreakdown(total, event.usage);
  return { session, events, model, name, latest: events.at(-1) ? { ...events.at(-1), total } : null };
}

async function refreshPiHistory() {
  if (Date.now() - lastHistoryAt < HISTORY_POLL_MS) return;
  const root = path.join(PI_HOME, "sessions");
  try {
    const files = await walkJsonl(root);
    const known = new Set(files);
    for (const file of files) {
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      const marker = `${stat.mtimeMs}:${stat.size}`;
      if (state.piHistory.files.get(file)?.marker === marker) continue;
      const parsed = await parsePiHistoryFile(file);
      state.piHistory.files.set(file, { marker, ...parsed });
    }
    for (const file of state.piHistory.files.keys()) if (!known.has(file)) state.piHistory.files.delete(file);
    state.piHistory.lastScanAt = Date.now();
    state.piHistory.error = null;
  } catch (error) {
    state.piHistory.error = errorMessage(error);
  }
}

function piHistoryEntries() {
  return [...state.piHistory.files.values()].filter((entry) => entry.events.length).sort((a, b) => isoMs(b.session.timestamp) - isoMs(a.session.timestamp));
}

function piHistoryTotals(entries = piHistoryEntries()) {
  const all = zeroBreakdown();
  const today = zeroBreakdown();
  const byModel = new Map();
  const events = [];
  for (const entry of entries) for (const event of entry.events) {
    addBreakdown(all, event.usage);
    if (event.date === localDate()) addBreakdown(today, event.usage);
    const current = byModel.get(event.model) || { ...zeroBreakdown(), model: event.model };
    addBreakdown(current, event.usage);
    byModel.set(event.model, current);
    events.push(event);
  }
  return { all, today, byModel, events };
}

function historyTotals() {
  const all = zeroBreakdown();
  const today = zeroBreakdown();
  const byModel = new Map();
  const events = [];
  for (const entry of state.history.files.values()) {
    for (const event of entry.events) {
      addBreakdown(all, event.usage);
      if (event.date === localDate()) addBreakdown(today, event.usage);
      const current = byModel.get(event.model) || { ...zeroBreakdown(), model: event.model };
      addBreakdown(current, event.usage);
      byModel.set(event.model, current);
      events.push(event);
    }
  }
  const resetStart = getResetWindowStart();
  const sinceReset = zeroBreakdown();
  for (const event of events) if (event.at >= resetStart) addBreakdown(sinceReset, event.usage);
  return { all, today, sinceReset, byModel, events };
}

function dailyUsageFromEvents(events) {
  const daily = new Map();
  for (const event of events || []) {
    const date = event.date || localDate(event.at);
    daily.set(date, (daily.get(date) || 0) + number(event.usage?.totalTokens));
  }
  return [...daily.entries()]
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildUsageTimeline(events, officialBuckets = [], officialSource = false) {
  const official = (officialBuckets || [])
    .filter((bucket) => bucket?.startDate)
    .map((bucket) => ({ date: String(bucket.startDate), tokens: number(bucket.tokens) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    source: officialSource && official.length ? "official" : "local",
    daily: officialSource && official.length ? official : dailyUsageFromEvents(events),
  };
}

function getPrimaryRate() {
  return state.rateLimits?.primary || state.rateLimits?.rateLimits?.primary || null;
}

function getResetWindowStart() {
  const primary = getPrimaryRate();
  const resetAt = number(primary?.resetsAt) * 1000;
  const duration = number(primary?.windowDurationMins) * 60 * 1000;
  if (resetAt > Date.now() && duration > 0) return resetAt - duration;
  return Date.now() - (duration || 5 * 60 * 60 * 1000);
}

function buildCodexViewState() {
  const history = historyTotals();
  const selected = state.selectedThreadId ? state.threadUsage[state.selectedThreadId] : null;
  const thread = state.threads.find((item) => item.id === state.selectedThreadId) || state.threads[0] || null;
  const historyEntry = findHistoryEntry(thread);
  const historyLatest = historyEntry?.latest || null;
  const isLive = Boolean(state.selectedThreadId && (state.liveThreadIds.has(state.selectedThreadId) || historyLatest));
  const last = selected?.last || historyLatest?.last || zeroBreakdown();
  const total = selected?.total || historyLatest?.total || zeroBreakdown();
  const contextWindow = number(selected?.modelContextWindow) || number(historyLatest?.contextWindow) || findHistoryContextWindow(thread);
  const models = new Map(history.byModel);
  const groups = selected?.groups || [];
  if (history.all.totalTokens === 0) for (const group of groups) {
    const model = group.model || "当前模型";
    const current = models.get(model) || { ...zeroBreakdown(), model };
    addBreakdown(current, { inputTokens: group.inputTokens, cachedInputTokens: group.cachedInputTokens, outputTokens: group.outputTokens, totalTokens: group.totalTokens });
    models.set(model, current);
  }
  const officialToday = sumOfficialToday();
  const officialLifetime = number(state.accountUsage?.summary?.lifetimeTokens);
  const todayTokens = officialToday || history.today.totalTokens;
  const lifetimeTokens = officialLifetime || history.all.totalTokens;
  const resetTokens = history.sinceReset.totalTokens;
  const cachedTokens = isLive ? last.cachedInputTokens : null;
  return {
    generatedAt: new Date().toISOString(),
    process: "codex",
    connection: state.connection,
    selectedThreadId: state.selectedThreadId,
    selectedThread: thread ? {
      id: thread.id,
      name: thread.name || thread.preview || "未命名线程",
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status?.type || "unknown",
      updatedAt: thread.updatedAt,
    } : null,
    threads: state.threads.slice(0, 25).map((item) => ({
      id: item.id,
      name: item.name || item.preview || "未命名线程",
      modelProvider: item.modelProvider,
      status: item.status?.type || "unknown",
      updatedAt: item.updatedAt,
    })),
    current: {
      model: groups.at(-1)?.model || findHistoryModel(thread) || "未知模型",
      contextUsed: isLive ? number(last.inputTokens) : null,
      contextWindow,
      contextPercent: isLive && contextWindow ? Math.min(100, (number(last.inputTokens) / contextWindow) * 100) : null,
      lastTurn: isLive ? normalizedBreakdown(last) : null,
      threadTotal: normalizedBreakdown(total),
      cacheHitPercent: isLive && last.inputTokens ? (last.cachedInputTokens / last.inputTokens) * 100 : null,
    },
    account: {
      todayTokens,
      sinceResetTokens: resetTokens,
      lifetimeTokens,
      todayCachedTokens: history.today.cachedInputTokens,
      lifetimeCachedTokens: history.all.cachedInputTokens,
      currentCachedTokens: cachedTokens,
      dailyBuckets: state.accountUsage?.dailyUsageBuckets || [],
      source: officialToday || officialLifetime ? "Codex account/usage" : "local rollout history",
      windowLabel: state.rateLimits ? "active rate-limit window" : "local history window",
    },
    resetWindow: {
      start: new Date(getResetWindowStart()).toISOString(),
      resetsAt: getPrimaryRate()?.resetsAt ? new Date(number(getPrimaryRate().resetsAt) * 1000).toISOString() : null,
      durationMinutes: number(getPrimaryRate()?.windowDurationMins) || null,
      usedPercent: number(getPrimaryRate()?.usedPercent) || null,
    },
    rateLimits: state.rateLimits,
    usageTimeline: buildUsageTimeline(history.events, state.accountUsage?.dailyUsageBuckets, true),
    models: [...models.values()].filter((item) => item.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens).map((item) => ({ ...item, sharePercent: lifetimeTokens ? (item.totalTokens / lifetimeTokens) * 100 : null })),
    throughput: state.throughput,
    history: { lastScanAt: state.history.lastScanAt, files: state.history.files.size, error: state.history.error },
    caveats: [
      "当前上下文使用量来自 Codex app-server 的 last.inputTokens；历史回溯来自本地 rollout JSONL。",
      "按模型的历史明细依赖 rollout 中的模型字段；无法识别的记录归入“未知模型”。",
      "未使用模型的配额不是 Codex 公开接口；面板不会把它估算成 0。",
    ],
  };
}

function buildPiViewState() {
  const entries = piHistoryEntries();
  const totals = piHistoryTotals(entries);
  const selectedEntry = entries.find((entry) => entry.session.id === state.selectedThreadId) || entries[0] || null;
  state.selectedThreadId = selectedEntry?.session.id || null;
  state.selectedThreadByProcess.pi = state.selectedThreadId;
  const latest = selectedEntry?.latest || null;
  const latestUsage = latest?.usage || zeroBreakdown();
  const contextWindow = getPiModelContext(latest?.model || selectedEntry?.model);
  const contextUsed = latest ? latestUsage.inputTokens + latestUsage.cachedInputTokens + latestUsage.cacheWriteInputTokens : null;
  const models = [...totals.byModel.values()].filter((item) => item.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item) => ({ ...item, sharePercent: totals.all.totalTokens ? (item.totalTokens / totals.all.totalTokens) * 100 : null }));
  const threads = entries.slice(0, MAX_THREADS).map((entry) => ({
    id: entry.session.id,
    name: entry.name || entry.session.cwd || "未命名会话",
    modelProvider: entry.model,
    status: "local",
    updatedAt: entry.events.at(-1)?.at || isoMs(entry.session.timestamp),
  }));
  const piReady = fs.existsSync(path.join(PI_HOME, "sessions"));
  return {
    generatedAt: new Date().toISOString(),
    process: "pi",
    connection: { status: piReady ? "ready" : "unavailable", transport: "local-session", error: state.piHistory.error },
    selectedThreadId: state.selectedThreadId,
    selectedThread: selectedEntry ? {
      id: selectedEntry.session.id,
      name: selectedEntry.name || selectedEntry.session.cwd || "未命名会话",
      cwd: selectedEntry.session.cwd,
      modelProvider: selectedEntry.model,
      status: "local",
      updatedAt: selectedEntry.events.at(-1)?.at || isoMs(selectedEntry.session.timestamp),
    } : null,
    threads,
    current: {
      model: latest?.model || selectedEntry?.model || "未知模型",
      contextUsed,
      contextWindow,
      contextPercent: contextUsed !== null && contextWindow ? Math.min(100, (contextUsed / contextWindow) * 100) : null,
      lastTurn: latest ? normalizedBreakdown(latestUsage) : null,
      threadTotal: selectedEntry ? normalizedBreakdown(selectedEntry.latest?.total) : zeroBreakdown(),
      cacheHitPercent: contextUsed ? (latestUsage.cachedInputTokens / contextUsed) * 100 : null,
    },
    account: {
      todayTokens: totals.today.totalTokens,
      sinceResetTokens: totals.all.totalTokens,
      lifetimeTokens: totals.all.totalTokens,
      todayCachedTokens: totals.today.cachedInputTokens,
      lifetimeCachedTokens: totals.all.cachedInputTokens,
      currentCachedTokens: latest ? latestUsage.cachedInputTokens : null,
      dailyBuckets: [],
      source: "pi local session usage",
      windowLabel: "all local pi sessions",
    },
    usageTimeline: buildUsageTimeline(totals.events),
    resetWindow: { start: null, resetsAt: null, durationMinutes: null, usedPercent: null },
    rateLimits: null,
    models,
    throughput: state.throughput,
    history: { lastScanAt: state.piHistory.lastScanAt, files: state.piHistory.files.size, error: state.piHistory.error },
    caveats: [
      "pi 数据来自 ~/.pi/agent/sessions 的本地 JSONL；不会上传会话内容。",
      "今日和累计使用量按 pi 会话中记录的模型调用 usage 汇总。",
      "pi 本地会话不提供 Codex rate-limit 重置窗口和实时 token/s 数据。",
    ],
  };
}

function buildViewState() {
  return state.activeProcess === "pi" ? buildPiViewState() : buildCodexViewState();
}

function findHistoryEntry(thread) {
  if (!thread) return null;
  const matching = [...state.history.files.entries()].find(([file]) => file.includes(thread.id));
  return matching?.[1] || null;
}

function findHistoryContextWindow(thread) {
  return number(findHistoryEntry(thread)?.contextWindow) || null;
}

function findHistoryModel(thread) {
  if (!thread) return null;
  const matching = [...state.history.files.entries()].find(([file]) => file.includes(thread.id));
  return matching?.[1]?.model || null;
}

function sumOfficialToday() {
  const today = localDate();
  return (state.accountUsage?.dailyUsageBuckets || []).filter((bucket) => String(bucket.startDate).slice(0, 10) === today).reduce((sum, bucket) => sum + number(bucket.tokens), 0);
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const root = path.join(PLUGIN_DIR, "web");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`) && target !== path.join(root, "index.html")) return json(res, { error: "forbidden" }, 403);
  fs.readFile(target, (error, content) => {
    if (error) return json(res, { error: "not found" }, 404);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": `${types[path.extname(target)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-cache" });
    res.end(content);
  });
}

function switchProcess(processName) {
  if (processName !== "codex" && processName !== "pi") return false;
  state.selectedThreadByProcess[state.activeProcess] = state.selectedThreadId;
  state.activeProcess = processName;
  if (processName === "codex") {
    state.selectedThreadId = state.selectedThreadByProcess.codex || state.threads[0]?.id || null;
  } else {
    const first = piHistoryEntries()[0]?.session.id || null;
    const selected = state.selectedThreadByProcess.pi;
    state.selectedThreadId = selected && piHistoryEntries().some((entry) => entry.session.id === selected) ? selected : first;
    state.selectedThreadByProcess.pi = state.selectedThreadId;
  }
  return true;
}

function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (url.pathname === "/api/state") return json(res, buildViewState());
    if (url.pathname === "/api/process") {
      const processName = url.searchParams.get("process");
      switchProcess(processName);
      return json(res, { ok: true, process: state.activeProcess });
    }
    if (url.pathname === "/api/select") {
      const threadId = url.searchParams.get("threadId");
      const valid = state.activeProcess === "codex"
        ? state.threads.some((item) => item.id === threadId)
        : piHistoryEntries().some((entry) => entry.session.id === threadId);
      if (threadId && valid) {
        state.selectedThreadId = threadId;
        state.selectedThreadByProcess[state.activeProcess] = threadId;
      }
      return json(res, { ok: true, selectedThreadId: state.selectedThreadId });
    }
    if (url.pathname === "/api/health") return json(res, { ok: true, connection: state.connection, pid: process.pid });
    return serveStatic(res, url.pathname);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Codex Token Observatory: http://${HOST}:${PORT}`);
    if (process.argv.includes("--open") && process.platform === "darwin") spawn("open", [`http://${HOST}:${PORT}`], { detached: true, stdio: "ignore" }).unref();
  });
  return server;
}

function resetThroughputIfIdle() {
  if (!state.lastUsageSample || Date.now() - state.lastUsageSample.at <= 2500) return;
  state.throughput.current = 0;
  state.throughput.average = 0;
  state.throughput.source = "idle";
  if (state.throughput.series.at(-1) !== 0) {
    state.throughput.series.push(0);
    if (state.throughput.series.length > 36) state.throughput.series.shift();
  }
}

async function refresh() {
  await refreshHistory();
  await refreshPiHistory();
  resetThroughputIfIdle();
  if (state.activeProcess === "codex" && state.selectedThreadId && !state.liveThreadIds.has(state.selectedThreadId)) {
    updateHistoryThroughput(findHistoryEntry(state.threads.find((item) => item.id === state.selectedThreadId)));
  } else if (state.activeProcess === "pi" && state.selectedThreadId) {
    updateHistoryThroughput(piHistoryEntries().find((entry) => entry.session.id === state.selectedThreadId));
  }
  if (Date.now() - lastListAt >= POLL_MS) { lastListAt = Date.now(); await refreshThreads(); }
  if (Date.now() - lastAccountAt >= POLL_MS) { lastAccountAt = Date.now(); await refreshAccountUsage(); }
  state.generatedAt = new Date().toISOString();
}

const server = startHttpServer();
await connectAppServer();
await refresh();
const timer = setInterval(() => refresh().catch((error) => { state.connection.error = errorMessage(error); }), 1000);

function shutdown() {
  clearInterval(timer);
  server.close();
  if (appServer && !appServer.killed) appServer.kill();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
