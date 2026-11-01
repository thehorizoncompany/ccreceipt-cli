import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSession } from "../src/parse.js";
import { redactSession, projectLabeler } from "../src/redact.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const RULES = join(DIR, "-home-demo-acme-api", "aaaaaaaa-0000-4000-8000-000000000001.jsonl");
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

// Everything personal the fixture contains. None of it may survive --redact.
const PRIVATE = ["SENTINEL_", "/home/demo", "acme-api", "feature/receipts", "Explore tests", "Find the test setup", "Looking at the router", "Build finished"];
const assertClean = (text, where) => {
  for (const p of PRIVATE) assert.ok(!text.includes(p), `${where} still contains "${p}"`);
};

test("the fixture really contains the private strings (guards the other tests)", () => {
  const raw = readFileSync(RULES, "utf8");
  for (const p of ["SENTINEL_PROMPT_ONE", "SENTINEL_TITLE", "SENTINEL_FILE", "/home/demo", "feature/receipts"]) assert.ok(raw.includes(p), p);
  const out = join(mkdtempSync(join(tmpdir(), "ccreceipt-redact-")), "plain.html");
  const r = run("aaaaaaaa", "--dir", DIR, "--no-open", "--out", out);
  assert.match(readFileSync(out, "utf8") + r.stdout, /SENTINEL_/);
});

test("--redact: terminal receipt and HTML report contain nothing personal", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ccreceipt-redact-")), "report.html");
  const r = run("aaaaaaaa", "--dir", DIR, "--no-open", "--redact", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  const receipt = r.stdout.split("Report:")[0];
  assertClean(receipt, "terminal receipt");
  assert.match(receipt, /RECEIPT · SESSION AAAAAAAA/);
  assert.match(receipt, /#1 \(prompt redacted\)/);
  assert.match(receipt, /Read \*\.js/);
  const html = readFileSync(out, "utf8");
  assertClean(html, "HTML report");
  assert.match(html, /redacted/);
});

test("--redact: JSON output contains nothing personal", () => {
  const r = run("aaaaaaaa", "--dir", DIR, "--json", "--redact");
  assert.equal(r.status, 0, r.stderr);
  assertClean(r.stdout, "JSON");
});

test("--redact: --list and --all hide titles and project names", () => {
  for (const mode of ["--list", "--all"]) {
    const r = run(mode, "--dir", DIR, "--redact");
    assert.equal(r.status, 0, r.stderr);
    assertClean(r.stdout, mode);
    assert.match(r.stdout, /project-1/);
  }
});

test("--redact changes no number", () => {
  const plain = JSON.parse(run("aaaaaaaa", "--dir", DIR, "--json").stdout);
  const red = JSON.parse(run("aaaaaaaa", "--dir", DIR, "--json", "--redact").stdout);
  for (const k of ["cost", "sideCost", "durationMs", "calls", "compactions"]) assert.deepEqual(red[k], plain[k], k);
  for (const k of ["tokens", "parts", "byTool", "whatIf", "models"]) assert.deepEqual(red[k], plain[k], k);
  assert.deepEqual(red.tasks.map((t) => t.cost), plain.tasks.map((t) => t.cost));
  assert.deepEqual(red.toolCalls.map((t) => [t.carry, t.reread, t.resultTokens]), plain.toolCalls.map((t) => [t.carry, t.reread, t.resultTokens]));
});

test("redactSession keeps tool names, file extensions, agent types and automatic-prompt tags", () => {
  const s = redactSession(parseSession(RULES), "project-1");
  assert.equal(s.title, "Session aaaaaaaa");
  assert.equal(s.cwd, "project-1");
  assert.equal(s.branch, null);
  const read = s.toolCalls.find((t) => t.id === "toolu_read1");
  assert.equal(read.name, "Read");
  assert.equal(read.summary, "*.js");
  assert.equal(s.toolCalls.find((t) => t.id === "toolu_agent1").summary, "");
  assert.equal(s.agents[0].description, "Explore");
  assert.equal(s.tasks.filter((t) => !t.meta)[2].short, "[automatic: task-notification]");
  assert.ok(s.calls.every((c) => c.text === ""));
});

test("projectLabeler gives stable neutral names in order of appearance", () => {
  const label = projectLabeler();
  assert.equal(label("/a/client-x"), "project-1");
  assert.equal(label("/b/client-y"), "project-2");
  assert.equal(label("/a/client-x"), "project-1");
});
