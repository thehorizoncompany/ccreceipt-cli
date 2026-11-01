import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// process.execPath is node under `node --test` and bun under `bun test`: the CLI is checked with the runtime running the tests.
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("--version and -v print the package version", () => {
  for (const flag of ["--version", "-v"]) {
    const r = run(flag);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), PKG.version);
  }
});

test("--help lists every flag", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\nUsage:\n  ccreceipt  /); // layout: no extra indentation
  assert.match(r.stdout, /\nOptions:\n  --out /);
  for (const f of ["--list", "--all", "--out", "--json", "--no-open", "--limit", "--dir", "--pricing", "--redact", "--since", "--until", "--version", "--help"]) assert.ok(r.stdout.includes(f), f);
});

test("--list shows every session with its cost", () => {
  const r = run("--list", "--dir", DIR);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 sessions, \$30\.03 in total/);
  assert.match(r.stdout, /bbbbbbbb/);
  assert.match(r.stdout, /aaaaaaaa/);
});

test("--list: most recently active first, dated by last activity", () => {
  const r = run("--list", "--dir", DIR);
  assert.match(r.stdout, /last active/);
  const rows = r.stdout.split("\n").filter((l) => /\b[0-9a-f]{8}\s*$/.test(l));
  assert.deepEqual(rows.map((l) => l.trim().slice(-8)), ["cccccccc", "bbbbbbbb", "aaaaaaaa", "eeeeeeee"]);
  // cccccccc started first (Oct 19) but was active last (Oct 21)
  assert.match(rows[0], /2026-10-21/);
  const dates = rows.map((l) => l.match(/\d{4}-\d{2}-\d{2}/)[0]);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("--all shows totals by project and the priciest tasks", () => {
  const r = run("--all", "--dir", DIR);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 sessions · \$30\.03 total/);
  assert.match(r.stdout, /\$30\.03  acme-api/); // the worktree session is counted under acme-api
  assert.doesNotMatch(r.stdout, /brave-turing/);
});

test("--json prints the receipt model", () => {
  const r = run("aaaaaaaa", "--dir", DIR, "--json");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(s.calls, 6);
  assert.ok(Math.abs(s.cost - 0.03276) < 1e-9, String(s.cost));
});

test("a session can be given by path", () => {
  const r = run(join(DIR, "-home-demo-acme-api", "bbbbbbbb-0000-4000-8000-000000000002.jsonl"), "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).officialCost, 26);
});

test("the terminal receipt and the HTML report", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ccreceipt-test-")), "report.html");
  const r = run("bbbbbbbb", "--dir", DIR, "--no-open", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECEIPT · COST CHECKS/);
  assert.match(r.stdout, /TOTAL\s+\$26\.00/);
  assert.match(r.stdout, /unknown price for claude-nova-preview/);
  assert.ok(existsSync(out));
  const html = readFileSync(out, "utf8");
  assert.match(html, /<title>Receipt · Cost checks<\/title>/);
  assert.match(html, /Unknown model price for: claude-nova-preview/);
});

test("an unknown session id exits with 1", () => {
  const r = run("ffffffff", "--dir", DIR);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No session matching "ffffffff"/);
});

test("--json through a pipe is complete for a large session (no cut at 64 KB)", () => {
  // ~2,000 tasks with long prompts: the JSON is far above the 64 KB pipe buffer
  const dir = mkdtempSync(join(tmpdir(), "ccreceipt-big-"));
  const project = join(dir, "-home-demo-big");
  mkdirSync(project);
  const lines = [];
  let t = Date.parse("2026-10-20T09:00:00.000Z");
  for (let i = 0; i < 2000; i++) {
    const ts = () => new Date((t += 1000)).toISOString();
    lines.push(JSON.stringify({ type: "user", cwd: "/home/demo/big", timestamp: ts(), message: { role: "user", content: `prompt ${i} ` + "y".repeat(300) } }));
    lines.push(JSON.stringify({ type: "assistant", cwd: "/home/demo/big", timestamp: ts(), message: { id: `msg_${i}`, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 10 }, content: [] } }));
  }
  writeFileSync(join(project, "dddddddd-0000-4000-8000-000000000004.jsonl"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [BIN, "dddddddd", "--dir", dir, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 200 * 1024, `only ${r.stdout.length} bytes`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.tasks.length, 2000);
});
