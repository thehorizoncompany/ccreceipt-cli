#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseSession } from "../src/parse.js";
import { renderHtml } from "../src/html.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const positional = argv.filter((a, i) => !a.startsWith("-") && !["--out", "--pricing", "--limit", "--dir"].includes(argv[i - 1]));

if (flag("--help") || flag("-h")) {
  console.log(`ccreceipt – the itemized receipt for a Claude Code session

Usage:
  ccreceipt                 receipt for the most recent session (opens an HTML report)
  ccreceipt <id-or-path>    receipt for that session (session id, prefix, or .jsonl path)
  ccreceipt --list          the last 20 sessions with their cost
  ccreceipt --all           totals across every session on this machine

Options:
  --out <file.html>   where to write the report (default: a temp file)
  --json              print the receipt as JSON instead of HTML
  --no-open           do not open the report in the browser
  --limit <n>         rows for --list / --all (default 20)
  --dir <path>        sessions directory (default ~/.claude/projects)
  --pricing <file>    JSON overrides: {"claude-opus-5-5": {"in":4,"out":20,"cr":0.2}} (USD per MTok)

Everything runs locally. No network, no telemetry.`);
  process.exit(0);
}

const root = opt("--dir") || join(homedir(), ".claude", "projects");
const pricing = opt("--pricing") ? JSON.parse(readFileSync(opt("--pricing"), "utf8")) : null;
const limit = +(opt("--limit") || 20);

function allSessionFiles() {
  const out = [];
  if (!existsSync(root)) return out;
  for (const p of readdirSync(root)) {
    const d = join(root, p);
    let st;
    try {
      st = statSync(d);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) out.push(join(d, f));
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function findSession(key) {
  if (existsSync(key) && key.endsWith(".jsonl")) return resolve(key);
  const files = allSessionFiles();
  const hit = files.find((f) => basename(f, ".jsonl").startsWith(key));
  if (!hit) {
    console.error(`No session matching "${key}" under ${root}`);
    process.exit(1);
  }
  return hit;
}

const usd = (n) => (n >= 100 ? "$" + n.toFixed(0) : n >= 1 ? "$" + n.toFixed(2) : n > 0 ? "$" + n.toFixed(2) : "$0");
const pad = (s, n) => String(s).padStart(n);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const dur = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
};
const projectName = (cwd) => (cwd ? cwd.split("/").filter(Boolean).slice(-1)[0] : "?");

if (flag("--list") || flag("--all")) {
  const files = allSessionFiles();
  const rows = [];
  let total = 0;
  const byProject = {};
  const tasks = [];
  for (const f of files) {
    let s;
    try {
      s = parseSession(f, { pricing, light: true });
    } catch {
      continue;
    }
    total += s.cost;
    byProject[projectName(s.cwd)] = (byProject[projectName(s.cwd)] || 0) + s.cost;
    rows.push(s);
    for (const t of s.tasks) if (!t.meta) tasks.push({ ...t, session: s });
  }
  if (flag("--list")) {
    console.log(`\n  ${pad("cost", 8)}  ${pad("dur", 5)}  ${"date".padEnd(10)}  ${"project".padEnd(18)}  title / id\n`);
    for (const s of rows.slice(0, limit))
      console.log(`  ${pad(usd(s.cost), 8)}  ${pad(dur(s.durationMs), 5)}  ${(s.start || "").slice(0, 10).padEnd(10)}  ${trunc(projectName(s.cwd), 18)}  ${trunc(s.title, 44)}  ${s.id.slice(0, 8)}`);
    console.log(`\n  ${rows.length} sessions, ${usd(total)} in total. Run: ccreceipt <id>\n`);
  } else {
    console.log(`\n  ${rows.length} sessions · ${usd(total)} total\n`);
    console.log("  By project");
    for (const [p, c] of Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log(`  ${pad(usd(c), 8)}  ${p}`);
    console.log("\n  Most expensive tasks ever");
    for (const t of tasks.sort((a, b) => b.cost - a.cost).slice(0, limit))
      console.log(`  ${pad(usd(t.cost), 8)}  ${trunc(projectName(t.session.cwd), 14)}  ${trunc(t.short, 70)}  ${t.session.id.slice(0, 8)}`);
    console.log();
  }
  process.exit(0);
}

const file = positional[0] ? findSession(positional[0]) : allSessionFiles()[0];
if (!file) {
  console.error(`No sessions found under ${root}`);
  process.exit(1);
}
const s = parseSession(file, { pricing });

if (flag("--json")) {
  const { calls, ...rest } = s;
  console.log(JSON.stringify({ ...rest, calls: calls.length }, null, 2));
  process.exit(0);
}

// terminal receipt
const realTasks = s.tasks.filter((t) => !t.meta || t.cost > 0);
const W = 62;
const line = (l, r = "") => console.log("  " + trunc(l, W - r.length - 1) + " " + r);
console.log();
console.log("  " + "─".repeat(W));
line("RECEIPT · " + s.title.toUpperCase());
line(`${(s.start || "").slice(0, 16).replace("T", " ")} · ${dur(s.durationMs)} · ${s.calls.length} calls · ${s.toolCalls.length} tool calls`);
console.log("  " + "─".repeat(W));
for (const t of realTasks.slice().sort((a, b) => b.cost - a.cost).slice(0, 12)) line(`#${t.index} ${t.short}`, pad(usd(t.cost), 8));
if (realTasks.length > 12) line(`… ${realTasks.length - 12} more tasks`);
console.log("  " + "─".repeat(W));
line("Re-reading context (cache reads)", pad(usd(s.parts.cacheRead), 8));
line("Writing context to cache", pad(usd(s.parts.cacheWrite), 8));
line("Model output", pad(usd(s.parts.output), 8));
line("Uncached input", pad(usd(s.parts.input), 8));
console.log("  " + "─".repeat(W));
line("TOTAL", pad(usd(s.cost), 8));
if (s.officialCost != null) line("(Claude Code's own total)", pad(usd(s.officialCost), 8));
console.log("  " + "─".repeat(W));
const top = s.topToolCalls[0];
if (top) line(`Priciest tool result: ${top.name.replace(/^mcp__/, "")} ${top.summary}`.trim(), pad(usd(top.carry), 8));
if (top) line(`  ${top.resultTokens} tokens, re-read ${top.reread}×`);
const cheaper = s.whatIf.find((w) => w.label === "Sonnet 5.5");
if (cheaper && s.mainModel && !s.mainModel.startsWith("claude-sonnet")) line(`Same tokens on Sonnet 5.5`, pad(usd(cheaper.cost), 8));
if (s.unknownModels.length) line(`! unknown price for ${s.unknownModels.join(", ")} (counted $0)`);
console.log();

const out = opt("--out") ? resolve(opt("--out")) : join(tmpdir(), "ccreceipt", `${s.id.slice(0, 8)}.html`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, renderHtml(s));
console.log(`  Report: ${out}\n`);
if (!flag("--no-open")) {
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    execFileSync(cmd, process.platform === "win32" ? ["/c", "start", "", out] : [out], { stdio: "ignore" });
  } catch {
    /* no browser: the path is printed */
  }
}
