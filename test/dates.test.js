import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDateBound, inRange } from "../src/dates.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("a day is a local calendar day: since = its start, until = its end", () => {
  const since = parseDateBound("2026-10-20", "since");
  const until = parseDateBound("2026-10-20", "until");
  assert.equal(since, new Date(2026, 9, 20).getTime());
  assert.equal(until - since, 86_400_000 - 1);
});

test("Nd means N days before now", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  assert.equal(parseDateBound("7d", "since", now), now - 7 * 86_400_000);
  assert.equal(parseDateBound("0d", "until", now), now);
});

test("invalid values are refused", () => {
  for (const v of ["yesterday", "2026-13-01", "2026-02-30", "20261020", "", "-3d"]) assert.throws(() => parseDateBound(v, "since"), /Invalid --since/, v);
});

test("a session is in range by its start", () => {
  const s = { start: "2026-10-20T09:00:00.000Z" };
  assert.ok(inRange(s, null, null));
  assert.ok(inRange(s, Date.parse("2026-10-20T00:00:00.000Z"), Date.parse("2026-10-20T23:59:59.999Z")));
  assert.ok(!inRange(s, Date.parse("2026-10-21T00:00:00.000Z"), null));
  assert.ok(!inRange(s, null, Date.parse("2026-10-19T23:59:59.999Z")));
  assert.ok(!inRange({ start: null }, 0, null));
});

test("--all --since --until keeps only the sessions started in the range", () => {
  const r = run("--all", "--dir", DIR, "--since", "2026-10-20", "--until", "2026-10-20");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sessions \(since 2026-10-20 until 2026-10-20\) · \$26\.03 total/);
});

test("--list --since keeps later sessions and says so", () => {
  const r = run("--list", "--dir", DIR, "--since", "2026-10-19");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 sessions \(since 2026-10-19\), \$30\.03 in total/);
  assert.doesNotMatch(r.stdout, /eeeeeeee/);
});

test("--until alone, and a relative range that covers everything", () => {
  assert.match(run("--list", "--dir", DIR, "--until", "2026-10-18").stdout, /1 session \(until 2026-10-18\)/);
  assert.match(run("--list", "--dir", DIR, "--since", "100000d").stdout, /4 sessions/);
});

test("an invalid date exits with 1 and explains the format", () => {
  const r = run("--list", "--dir", DIR, "--since", "yesterday");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /YYYY-MM-DD or a number of days like 7d/);
});
