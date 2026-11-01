import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
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
  for (const f of ["--list", "--all", "--out", "--json", "--no-open", "--limit", "--dir", "--pricing", "--redact", "--version", "--help"]) assert.ok(r.stdout.includes(f), f);
});

test("--list shows every session with its cost", () => {
  const r = run("--list", "--dir", DIR);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sessions, \$26\.03 in total/);
  assert.match(r.stdout, /bbbbbbbb/);
  assert.match(r.stdout, /aaaaaaaa/);
});

test("--all shows totals by project and the priciest tasks", () => {
  const r = run("--all", "--dir", DIR);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sessions · \$26\.03 total/);
  assert.match(r.stdout, /acme-api/);
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
