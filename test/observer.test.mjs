import assert from "node:assert/strict";
import { mkdtemp, appendFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readJsonlLines,
  updateCodexHistoryEntry,
  updatePiHistoryEntry,
} from "../scripts/observer.mjs";

function codexRow(total, last, timestamp) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached || 0,
          output_tokens: total.output,
          reasoning_output_tokens: 0,
          total_tokens: total.total,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached || 0,
          output_tokens: last.output,
          reasoning_output_tokens: 0,
          total_tokens: last.total,
        },
      },
    },
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Codex history is parsed incrementally and waits for a complete final line", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "rollout.jsonl");
  const first = codexRow({ input: 10, output: 2, total: 12 }, { input: 10, output: 2, total: 12 }, "2026-08-25T10:00:00.000Z");
  const second = codexRow({ input: 15, output: 4, total: 19 }, { input: 5, output: 2, total: 7 }, "2026-08-25T10:01:00.000Z");
  const third = codexRow({ input: 20, output: 5, total: 25 }, { input: 5, output: 1, total: 6 }, "2026-08-25T10:02:00.000Z");
  const metadata = [
    JSON.stringify({ timestamp: "2026-08-25T09:59:00.000Z", type: "turn_context", payload: { model: "gpt-test" } }),
    JSON.stringify({ timestamp: "2026-08-25T09:59:01.000Z", type: "event_msg", payload: { type: "task_started", model_context_window: 128000 } }),
  ];
  const splitAt = third.length - 12;
  await writeFile(file, `${metadata.join("\n")}\n${first}\n${second}\n${third.slice(0, splitAt)}`);

  let entry = await updateCodexHistoryEntry(file);
  assert.equal(entry.model, "gpt-test");
  assert.equal(entry.contextWindow, 128000);
  assert.equal(entry.totals.inputTokens, 15);
  assert.equal(entry.totals.outputTokens, 4);
  assert.equal(entry.totals.totalTokens, 19);
  assert.equal(entry.recentEvents.length, 2);
  assert.ok(entry.offset < entry.size);

  await appendFile(file, `${third.slice(splitAt)}\n`);
  entry = await updateCodexHistoryEntry(file, entry, await stat(file));
  assert.equal(entry.totals.inputTokens, 20);
  assert.equal(entry.totals.outputTokens, 5);
  assert.equal(entry.totals.totalTokens, 25);
  assert.equal(entry.recentEvents.length, 3);
  assert.equal(entry.offset, entry.size);

  const unchanged = await updateCodexHistoryEntry(file, entry, await stat(file));
  assert.equal(unchanged.totals.totalTokens, 25);
  assert.equal(unchanged.recentEvents.length, 3);
});

test("Codex history resets its aggregates after truncation or replacement", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "rollout.jsonl");
  await writeFile(file, `${codexRow({ input: 50, output: 5, total: 55 }, { input: 50, output: 5, total: 55 }, "2026-08-25T10:00:00.000Z")}\n`);
  let entry = await updateCodexHistoryEntry(file);
  assert.equal(entry.totals.totalTokens, 55);

  await writeFile(file, `${codexRow({ input: 3, output: 1, total: 4 }, { input: 3, output: 1, total: 4 }, "2026-08-25T11:00:00.000Z")}\n`);
  entry = await updateCodexHistoryEntry(file, entry, await stat(file));
  assert.equal(entry.totals.totalTokens, 4);
  assert.equal(entry.recentEvents.length, 1);
});

test("streaming reader skips an oversized line and continues at the next newline", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "oversized.jsonl");
  await writeFile(file, `${"x".repeat(128)}\nok\n`);
  const snapshot = await stat(file);
  const lines = [];
  const result = await readJsonlLines(file, 0, snapshot.size - 1, (line) => lines.push(line.toString("utf8")), 32);
  assert.deepEqual(lines, ["ok"]);
  assert.equal(result.skippedLines, 1);
  assert.equal(result.offset, snapshot.size);
});

test("pi history appends usage without reparsing previous calls", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "pi.jsonl");
  const session = JSON.stringify({ type: "session", id: "pi-1", cwd: "/tmp/project", timestamp: "2026-08-25T10:00:00.000Z" });
  const model = JSON.stringify({ type: "model_change", modelId: "pi-model" });
  const usage = (input, output, timestamp) => JSON.stringify({ type: "message", timestamp, message: { role: "assistant", usage: { input, output, totalTokens: input + output } } });
  await writeFile(file, `${session}\n${model}\n${usage(10, 2, "2026-08-25T10:01:00.000Z")}\n`);

  let entry = await updatePiHistoryEntry(file);
  assert.equal(entry.session.id, "pi-1");
  assert.equal(entry.model, "pi-model");
  assert.equal(entry.totals.totalTokens, 12);

  await appendFile(file, `${usage(5, 1, "2026-08-25T10:02:00.000Z")}\n`);
  entry = await updatePiHistoryEntry(file, entry, await stat(file));
  assert.equal(entry.totals.totalTokens, 18);
  assert.equal(entry.recentEvents.length, 2);
});
