import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession } from "../src/parse.js";

const CHUNK = 1 << 20; // must match the reader's chunk size
const file = (name, text) => {
  const f = join(mkdtempSync(join(tmpdir(), "ccreceipt-stream-")), name);
  writeFileSync(f, text);
  return f;
};
const prompt = (content, ts) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } });
const reply = (id, ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 0 }, content: [] } });

test("a multi-byte character split across two read chunks is decoded intact", () => {
  const head = '{"type":"user","timestamp":"2026-10-20T09:00:00.000Z","message":{"role":"user","content":"';
  const k = CHUNK - 1 - Buffer.byteLength(head); // "é" (2 bytes) starts on the last byte of the first chunk
  const line = head + "a".repeat(k) + 'étail"}}';
  const f = file("split.jsonl", line + "\n" + reply("m1", "2026-10-20T09:00:01.000Z") + "\n");
  const s = parseSession(f);
  const p = s.tasks.find((t) => !t.meta).prompt;
  assert.ok(p.endsWith("aétail"), p.slice(-10));
  assert.ok(!p.includes("�"));
  assert.equal(s.calls.length, 1);
});

test("the last line is read even without a final newline", () => {
  const f = file("no-newline.jsonl", prompt("hello", "2026-10-20T09:00:00.000Z") + "\n" + reply("m1", "2026-10-20T09:00:01.000Z"));
  assert.equal(parseSession(f).calls.length, 1);
});

test("corrupt and partial lines are skipped, the rest is counted", () => {
  const lines = [prompt("one", "2026-10-20T09:00:00.000Z"), "{not json", reply("m1", "2026-10-20T09:00:01.000Z"), "", '{"type":"assist'];
  const s = parseSession(file("corrupt.jsonl", lines.join("\n")));
  assert.equal(s.calls.length, 1);
  assert.ok(Math.abs(s.cost - 0.004) < 1e-12);
});

test("lines far larger than a chunk are read whole", () => {
  const big = "x".repeat(3 * CHUNK);
  const f = file("big-line.jsonl", prompt(big, "2026-10-20T09:00:00.000Z") + "\n" + reply("m1", "2026-10-20T09:00:01.000Z") + "\n");
  const s = parseSession(f);
  assert.equal(s.tasks.find((t) => !t.meta).prompt.length, big.length);
  assert.equal(s.calls.length, 1);
});
