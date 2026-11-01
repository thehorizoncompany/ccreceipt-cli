import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseSession, estimateTokens } from "../src/parse.js";

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);
const fixture = (id) => fileURLToPath(new URL(`./fixtures/projects/-home-demo-acme-api/${id}.jsonl`, import.meta.url));
const RULES = fixture("aaaaaaaa-0000-4000-8000-000000000001");
const COSTS = fixture("bbbbbbbb-0000-4000-8000-000000000002");

// Expected costs of the RULES fixture, computed by hand (Opus 5.5: in 4, out 20, cr 0.2; 1-hour writes 8; Sonnet 5.5: in 2, out 10)
const A1 = (1000 * 4 + 2000 * 8 + 100 * 20) / 1e6;
const A2 = (10 * 4 + 500 * 8 + 3000 * 0.2 + 50 * 20) / 1e6;
const A3 = (5 * 4 + 100 * 8 + 4000 * 0.2 + 30 * 20) / 1e6;
const A4 = (20 * 4 + 1000 * 0.2 + 10 * 20) / 1e6;
const A5 = (5 * 4 + 500 * 0.2 + 5 * 20) / 1e6;
const S1 = (100 * 2 + 200 * 10) / 1e6;

test("estimateTokens: 4 characters per token, 1500 per image", () => {
  assert.equal(estimateTokens("x".repeat(4000)), 1000);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("[Image: source: /tmp/a.png]"), 1500);
  assert.equal(estimateTokens([{ type: "image", source: {} }, { type: "text", text: "x".repeat(400) }]), 1600);
  assert.equal(estimateTokens(null), 0);
});

test("an API response split over several lines is counted once", () => {
  const s = parseSession(RULES);
  assert.equal(s.calls.filter((c) => c.id === "msg_a1").length, 1);
  close(s.calls.find((c) => c.id === "msg_a1").cost, A1);
});

test("session totals: main calls plus sub-agent calls", () => {
  const s = parseSession(RULES);
  assert.equal(s.calls.length, 6);
  close(s.cost, A1 + A2 + A3 + A4 + A5 + S1);
  close(s.sideCost, S1);
  assert.equal(s.tokens.cacheWrite, 2600);
  assert.equal(s.mainModel, "claude-opus-5-5");
});

test("one task per prompt; reminders, meta lines and interruptions are not tasks", () => {
  const s = parseSession(RULES);
  const tasks = s.tasks.filter((t) => !t.meta);
  assert.equal(tasks.length, 3);
  assert.match(tasks[0].prompt, /SENTINEL_PROMPT_ONE/);
  assert.match(tasks[1].prompt, /SENTINEL_PROMPT_TWO/);
  close(tasks[0].cost, A1 + A2);
  assert.equal(tasks[0].calls, 2);
});

test("automatic prompts are labelled as such", () => {
  const s = parseSession(RULES);
  const auto = s.tasks.filter((t) => !t.meta)[2];
  assert.equal(auto.short, "[automatic: task-notification] Build finished");
  close(auto.cost, A5);
});

test("sub-agent calls go to the task that launched the agent, via toolUseId", () => {
  const s = parseSession(RULES);
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].task, 2);
  assert.equal(s.agents[0].description, "Explore tests");
  close(s.agents[0].cost, S1);
  const side = s.calls.filter((c) => c.side);
  assert.equal(side.length, 1);
  assert.equal(side[0].task, 2);
  const t2 = s.tasks.find((t) => t.index === 2);
  close(t2.cost, A3 + A4 + S1);
  close(t2.sideCost, S1);
});

test("carrying cost: written once at 2x input, then re-read on every later call until a compaction", () => {
  const s = parseSession(RULES);
  const read = s.toolCalls.find((t) => t.id === "toolu_read1");
  assert.equal(read.resultTokens, 1000);
  assert.equal(read.reread, 2); // msg_a2 and msg_a3; msg_a4 comes after the compaction
  close(read.carry, (1000 * 8 + 2 * 1000 * 0.2) / 1e6);
  assert.equal(s.compactions, 1);
  const agent = s.toolCalls.find((t) => t.id === "toolu_agent1");
  assert.equal(agent.reread, 0);
});

test("a cost-state written before the last calls is not used as Claude Code's total", () => {
  assert.equal(parseSession(RULES).officialCost, null);
});

test("a cost-state at the end of the session is kept", () => {
  assert.equal(parseSession(COSTS).officialCost, 26);
});

test("session metadata: custom title, cwd, branch, time range", () => {
  const s = parseSession(RULES);
  assert.equal(s.title, "Health endpoint SENTINEL_TITLE");
  assert.equal(s.cwd, "/home/demo/acme-api");
  assert.equal(s.branch, "feature/receipts");
  assert.ok(s.durationMs > 0);
});

test("cache write durations, legacy usage and fast mode in one session", () => {
  const s = parseSession(COSTS);
  close(s.cost, 5 + 8 + 5 + 8);
  close(s.parts.cacheWrite, 18);
  close(s.parts.input, 8);
  assert.equal(s.calls.find((c) => c.id === "msg_b4").fast, true);
});

test("unknown models are reported and counted at $0", () => {
  const s = parseSession(COSTS);
  assert.deepEqual(s.unknownModels, ["claude-nova-preview"]);
  assert.equal(s.calls.find((c) => c.id === "msg_b5").cost, 0);
});

test("same tokens, other model: every call re-priced with the target model", () => {
  const s = parseSession(RULES);
  const opus = s.whatIf.find((w) => w.model === "claude-opus-5-5");
  close(opus.cost, A1 + A2 + A3 + A4 + A5 + (100 * 4 + 200 * 20) / 1e6);
  const haiku = s.whatIf.find((w) => w.model === "claude-haiku-5-5");
  assert.ok(haiku.cost < opus.cost);
});

test("--pricing overrides reach every call", () => {
  const s = parseSession(COSTS, { pricing: { "claude-nova-preview": { in: 1, out: 1, cr: 0.1 } } });
  assert.deepEqual(s.unknownModels, []);
  close(s.cost, 26 + 1);
});

test("light mode keeps the numbers and drops texts", () => {
  const full = parseSession(RULES);
  const light = parseSession(RULES, { light: true });
  close(light.cost, full.cost);
  assert.ok(light.calls.every((c) => c.text === ""));
  assert.ok(light.toolCalls.every((t) => t.summary === ""));
});

const WORKTREE = fixture("../-home-demo-acme-api--claude-worktrees-brave-turing-1a2b3c/cccccccc-0000-4000-8000-000000000003");

test("pasted text becomes [pasted text] in task labels, with or without a closing tag", () => {
  const tasks = parseSession(WORKTREE).tasks.filter((t) => !t.meta);
  assert.equal(tasks[1].short, "Apply this config: [pasted text] then restart");
  assert.equal(tasks[2].short, "Same for staging [pasted text]");
  for (const t of tasks) assert.ok(!t.short.includes("pasted_content"), t.short);
});

test("the full prompt keeps the pasted text", () => {
  const tasks = parseSession(WORKTREE).tasks.filter((t) => !t.meta);
  assert.match(tasks[1].prompt, /port=8080/);
  assert.match(tasks[2].prompt, /host=staging/);
});

test("shortLabel leaves prompts without pasted text unchanged, apart from whitespace", async () => {
  const { shortLabel } = await import("../src/parse.js");
  assert.equal(shortLabel("Fix   the\nbuild"), "Fix the build");
  assert.equal(shortLabel("a <b>tag</b> stays"), "a <b>tag</b> stays");
  assert.equal(shortLabel("x".repeat(300)).length, 160);
});

test("a delegated session's first task is labelled with the session title", () => {
  const s = parseSession(fixture("eeeeeeee-0000-4000-8000-000000000005"));
  const first = s.tasks.find((t) => !t.meta);
  assert.equal(s.title, "Rate limiting on login");
  assert.equal(first.short, "Rate limiting on login");
  assert.match(first.prompt, /^Task \(from the session that started this one\)/);
});

test("a delegated session without a title keeps the brief as its label", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "ccreceipt-delegated-")), "ffffffff-0000-4000-8000-000000000006.jsonl");
  writeFileSync(f, JSON.stringify({ type: "user", timestamp: "2026-10-18T08:00:00.000Z", message: { role: "user", content: "Task (from the session that started this one):\nDo X" } }) + "\n");
  const s = parseSession(f);
  assert.match(s.tasks[0].short, /^Task \(from the session/);
});
