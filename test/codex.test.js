import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexSession, isCodexFile, codexSessionFiles, codexIdFromFile } from "../src/codex.js";

const close = (a, e, m) => assert.ok(Math.abs(a - e) < 1e-9, `${m ?? ""} expected ${e}, got ${a}`);
const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const ROOT = fileURLToPath(new URL("./fixtures/codex", import.meta.url));
const FILE = join(ROOT, "2026", "10", "22", "rollout-2026-10-22T10-00-00-01a2c0de-0000-7000-8000-000000000007.jsonl");
const CLAUDE = fileURLToPath(new URL("./fixtures/projects/-home-demo-acme-api/aaaaaaaa-0000-4000-8000-000000000001.jsonl", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

// GPT-6 Astra: in 10, cached 1, out 50 per MTok. input_tokens includes the cached ones.
const R1 = (20000 * 10 + 80000 * 1 + 1000 * 50) / 1e6;
const R2 = (0 * 10 + 50000 * 1 + 500 * 50) / 1e6;

test("finds rollout files in the dated folder tree and reads their id", () => {
  assert.deepEqual(codexSessionFiles(ROOT), [FILE]);
  assert.equal(codexIdFromFile(FILE), "01a2c0de-0000-7000-8000-000000000007");
  assert.ok(isCodexFile(FILE));
  assert.ok(!isCodexFile(CLAUDE));
});

test("one call per response id; cached input at the cached price", () => {
  const s = parseCodexSession(FILE);
  assert.equal(s.agent, "codex");
  assert.equal(s.calls.length, 3);
  close(s.calls[0].cost, R1);
  close(s.cost, R1 + R2);
  close(s.parts.cacheRead, 0.13);
  close(s.parts.input, 0.2);
  close(s.parts.output, 0.075);
});

test("token totals match the running total Codex writes", () => {
  const s = parseCodexSession(FILE);
  const r = s.reportedTokens;
  assert.equal(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite, r.input_tokens);
  assert.equal(s.tokens.cacheRead, r.cached_input_tokens);
  assert.equal(s.tokens.output, r.output_tokens);
});

test("tasks are turns, labelled with what the user typed", () => {
  const s = parseCodexSession(FILE);
  const tasks = s.tasks.filter((t) => !t.meta);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].short, "Fix the login bug SENTINEL_CODEX_PROMPT");
  assert.equal(s.title, "Fix the login bug SENTINEL_CODEX_PROMPT");
  assert.equal(s.tasks.length, 2); // the review turn has no typed prompt and no priced call
});

test("unknown models are reported and counted at $0", () => {
  const s = parseCodexSession(FILE);
  assert.deepEqual(s.unknownModels, ["codex-auto-review"]);
  assert.equal(s.calls[2].cost, 0);
});

test("carrying cost: sent once as input, re-read at the cached price until a compaction", () => {
  const s = parseCodexSession(FILE);
  const tc = s.toolCalls[0];
  assert.equal(tc.name, "shell");
  assert.equal(tc.resultTokens, 2000);
  assert.equal(tc.reread, 2);
  close(tc.carry, (2000 * 10 + 2 * 2000 * 1) / 1e6);
  assert.match(tc.summary, /^cat \/home\/demo\/acme-api\/src\/login\.js/);
  assert.equal(s.compactions, 1);
});

test("same tokens on other OpenAI models", () => {
  const s = parseCodexSession(FILE);
  const sol = s.whatIf.find((w) => w.label === "GPT-6.1 Sol");
  close(sol.cost, (20000 * 2 + 130000 * 0.1 + 1500 * 10 + 10000 * 2 + 100 * 10) / 1e6);
});

test("older rollouts with only token_count events: one call per increase of the running total", () => {
  const ev = (total, last, ts) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });
  const u = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, total_tokens: i + o });
  const lines = [
    JSON.stringify({ timestamp: "2026-10-22T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
    ev(u(1000, 0, 10), u(1000, 0, 10), "2026-10-22T10:00:01.000Z"),
    ev(u(1000, 0, 10), u(1000, 0, 10), "2026-10-22T10:00:02.000Z"), // repeated: no new call
    ev(u(3000, 1000, 30), u(2000, 1000, 20), "2026-10-22T10:00:03.000Z"),
  ];
  const f = join(mkdtempSync(join(tmpdir(), "ccreceipt-codex-")), "rollout-2026-10-22T10-00-00-01a2c0de-0000-7000-8000-000000000008.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  const s = parseCodexSession(f);
  assert.equal(s.calls.length, 2);
  close(s.cost, (1000 * 2 + 10 * 10) / 1e6 + (1000 * 2 + 1000 * 0.1 + 20 * 10) / 1e6);
});

test("CLI: --agent codex --list and a receipt", () => {
  const list = run("--agent", "codex", "--dir", ROOT, "--list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /1 session, \$0\.41 in total/);
  const out = join(mkdtempSync(join(tmpdir(), "ccreceipt-codex-")), "r.html");
  const r = run("01a2c0de", "--agent", "codex", "--dir", ROOT, "--no-open", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TOTAL\s+\$0\.41/);
  assert.match(r.stdout, /Same tokens on GPT-6\.1 Sol/);
  assert.match(readFileSync(out, "utf8"), /Receipt · Codex session/);
});

test("CLI: a Codex file given by path is recognised without --agent", () => {
  const r = run(FILE, "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).agent, "codex");
});

test("CLI: --redact covers Codex sessions", () => {
  const r = run("01a2c0de", "--agent", "codex", "--dir", ROOT, "--json", "--redact");
  for (const p of ["SENTINEL_CODEX", "/home/demo", "acme-api", "login.js"]) assert.ok(!r.stdout.includes(p), p);
});

test("CLI: an unknown --agent exits with 1", () => {
  const r = run("--agent", "cursor", "--list");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /use claude, codex or all/);
});
