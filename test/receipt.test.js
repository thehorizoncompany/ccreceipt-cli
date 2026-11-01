import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSession } from "../src/parse.js";
import { receiptRows, receiptText, receiptSvg, WIDTH } from "../src/receipt.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const RULES = join(DIR, "-home-demo-acme-api", "aaaaaaaa-0000-4000-8000-000000000001.jsonl");
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "ccreceipt-svg-"));

test("every terminal row is the same width", () => {
  const lines = receiptText(receiptRows(parseSession(RULES)));
  for (const l of lines) assert.equal([...l].length, WIDTH + 2, JSON.stringify(l));
});

test("the SVG is 1200 px wide, with one text row per receipt row", () => {
  const rows = receiptRows(parseSession(RULES));
  const svg = receiptSvg(rows);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="\d+"/);
  const textRows = rows.filter((r) => !r.rule).length;
  assert.ok((svg.match(/<text /g) || []).length >= textRows);
  assert.match(svg, /npx ccreceipt-cli/);
});

test("the SVG escapes XML special characters", () => {
  const s = parseSession(RULES);
  s.title = `<script>alert("x") & co</script>`;
  const svg = receiptSvg(receiptRows(s));
  assert.ok(!svg.includes("<script>"));
  assert.match(svg, /&lt;SCRIPT&gt;ALERT\(&quot;X&quot;\) &amp; CO/);
});

test("--svg writes a redacted image by default and no HTML report", () => {
  const dir = tmp();
  const out = join(dir, "receipt.svg");
  const r = run("aaaaaaaa", "--dir", DIR, "--svg", out, "--out", join(dir, "report.html"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Image: .*receipt\.svg \(redacted/);
  assert.ok(!existsSync(join(dir, "report.html")));
  const svg = readFileSync(out, "utf8");
  for (const p of ["SENTINEL_", "/home/demo", "acme-api", "Health endpoint"]) assert.ok(!svg.includes(p), p);
  assert.match(svg, /SESSION AAAAAAAA/);
  assert.match(svg, /\(prompt redacted\)/);
  // the terminal receipt next to it is not redacted
  assert.match(r.stdout, /SENTINEL_TITLE/);
});

test("--svg --no-redact keeps the prompt texts", () => {
  const out = join(tmp(), "receipt.svg");
  const r = run("aaaaaaaa", "--dir", DIR, "--svg", out, "--no-redact");
  assert.equal(r.status, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  assert.match(svg, /HEALTH ENDPOINT SENTINEL_TITLE/);
  assert.match(svg, /Add a health endpoint/);
});

test("--svg with --redact redacts both the terminal and the image", () => {
  const out = join(tmp(), "receipt.svg");
  const r = run("aaaaaaaa", "--dir", DIR, "--svg", out, "--redact");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("SENTINEL_"));
  assert.ok(!readFileSync(out, "utf8").includes("SENTINEL_"));
});
