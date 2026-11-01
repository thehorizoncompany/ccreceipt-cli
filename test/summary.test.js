import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../src/summary.js";
import { allReceiptRows, receiptText } from "../src/receipt.js";
import { parseSession } from "../src/parse.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const FILES = readdirSync(DIR).flatMap((p) => readdirSync(join(DIR, p)).filter((f) => f.endsWith(".jsonl")).map((f) => join(DIR, p, f)));
const SESSIONS = FILES.map((f) => parseSession(f, { light: true }));

test("summarize gives the totals --all prints", () => {
  const sum = summarize(SESSIONS);
  assert.equal(sum.count, 4);
  assert.equal(sum.total.toFixed(2), "30.03");
  assert.deepEqual(sum.projects.map(([p]) => p), ["acme-api"], "the worktree session counts under its repository");
  assert.equal(sum.tasks.length, 8);
  assert.deepEqual(sum.tasks[0], { cost: 26, project: "acme-api", label: "Cost checks", index: 1, id: SESSIONS.find((s) => s.title === "Cost checks").id });
});

test("redacted, projects are numbered by spend and prompts hidden", () => {
  const two = [...SESSIONS, { ...SESSIONS[0], cwd: "/home/demo/bigger", cost: 100, tasks: [] }];
  const sum = summarize(two, { redact: true });
  assert.deepEqual(sum.projects.map(([p]) => p), ["project-1", "project-2"]);
  assert.equal(sum.projects[0][1], 100);
  const labels = sum.tasks.map((t) => t.label).join("\n");
  assert.doesNotMatch(labels, /SENTINEL|Cost checks|pasted/);
  assert.match(labels, /\(prompt redacted\)/);
  assert.match(labels, /\[automatic: task-notification\]/);
  // a shared labeler keeps the labels of the screen
  const seen = summarize(two, { redact: true, label: (n) => `L:${n}` });
  assert.deepEqual(seen.projects.map(([p]) => p).sort(), ["L:acme-api", "L:bigger"]);
});

test("the all-sessions receipt: counts, projects, priciest tasks, total", () => {
  const text = receiptText(allReceiptRows(summarize(SESSIONS), { range: "since 2026-10-01" })).join("\n");
  assert.match(text, /RECEIPT · ALL SESSIONS/);
  assert.match(text, /4 sessions · 1 project · since 2026-10-01/);
  assert.match(text, /acme-api +\$30\.03/);
  assert.match(text, /#1 Cost checks · acme-api +\$26\.00/);
  assert.match(text, /TOTAL +\$30\.03/);
  assert.match(text, /Average per session +\$7\.51/);
});

test("--all --svg writes the all-sessions card, redacted unless --no-redact", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ccreceipt-allcard-")), "all.svg");
  const r = spawnSync(process.execPath, [BIN, "--all", "--dir", DIR, "--svg", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Most expensive tasks ever/, "the totals are still printed");
  assert.match(r.stdout, /Image: .*all\.svg \(redacted/);
  const svg = readFileSync(out, "utf8");
  assert.match(svg, /RECEIPT · ALL SESSIONS/);
  assert.match(svg, /\$30\.03/);
  assert.match(svg, /project-1/);
  assert.doesNotMatch(svg, /acme-api|SENTINEL|Cost checks/);
  spawnSync(process.execPath, [BIN, "--all", "--dir", DIR, "--svg", out, "--no-redact"], { encoding: "utf8" });
  assert.match(readFileSync(out, "utf8"), /acme-api/);
});
