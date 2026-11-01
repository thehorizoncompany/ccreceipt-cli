#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSession } from "../src/parse.js";
import { renderHtml } from "../src/html.js";
import { redactSession, projectLabeler } from "../src/redact.js";
import { projectName } from "../src/project.js";
import { parseDateBound, inRange, fmtDay } from "../src/dates.js";
import { usd, pad, trunc, dur } from "../src/format.js";
import { receiptRows, receiptText, receiptSvg } from "../src/receipt.js";
import { parseCodexSession, codexSessionFiles, codexIdFromFile, isCodexFile } from "../src/codex.js";

// Everything runs inside main() and returns instead of calling process.exit(0):
// under Node, stdout to a pipe is asynchronous and process.exit() would cut the output.
function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const positional = argv.filter((a, i) => !a.startsWith("-") && !["--out", "--pricing", "--limit", "--dir", "--since", "--until", "--svg", "--agent"].includes(argv[i - 1]));

  if (flag("--version") || flag("-v")) {
    // readFileSync rather than a JSON import: import attributes are not stable on Node 18.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    console.log(pkg.version);
    return;
  }

  if (flag("--help") || flag("-h")) {
    console.log(`ccreceipt – the itemized receipt for a Claude Code or Codex session

Usage:
  ccreceipt                 receipt for the most recent session (opens an HTML report)
  ccreceipt <id-or-path>    receipt for that session (session id, prefix, or .jsonl path)
  ccreceipt --list          the 20 most recently active sessions with their cost
  ccreceipt --all           totals across every session on this machine

Options:
  --out <file.html>   where to write the report (default: a temp file)
  --json              print the receipt as JSON instead of HTML
  --no-open           do not open the report in the browser
  --limit <n>         rows for --list / --all (default 20)
  --agent <name>      claude (default), codex, or all: whose sessions --list, --all and the latest receipt read.
                      A session id is also looked up in Codex sessions when it is not a Claude Code one.
  --dir <path>        sessions directory (default ~/.claude/projects, or ~/.codex/sessions with --agent codex)
  --pricing <file>    JSON overrides: {"claude-opus-5-5": {"in":4,"out":20,"cr":0.2}} (USD per MTok)
  --redact            hide prompts, replies, titles, paths, project and branch names (to share a receipt)
  --since <date>      with --list / --all: sessions started on or after this day (YYYY-MM-DD, or 7d for the last 7 days)
  --until <date>      with --list / --all: sessions started on or before this day (YYYY-MM-DD, or 30d)
  --svg <file.svg>    write the receipt as an image to share (redacted unless --no-redact), instead of the HTML report
  -v, --version       print the version
  -h, --help          print this help

Everything runs locally. No network, no telemetry.`);
    return;
  }

  const agent = opt("--agent") || "claude";
  if (!["claude", "codex", "all"].includes(agent)) {
    console.error(`Invalid --agent "${agent}": use claude, codex or all`);
    process.exit(1);
  }
  const claudeRoot = (agent !== "codex" && opt("--dir")) || join(homedir(), ".claude", "projects");
  const codexRoot = (agent === "codex" && opt("--dir")) || join(homedir(), ".codex", "sessions");
  const root = agent === "codex" ? codexRoot : claudeRoot;
  const pricing = opt("--pricing") ? JSON.parse(readFileSync(opt("--pricing"), "utf8")) : null;
  const limit = +(opt("--limit") || 20);
  const redact = flag("--redact");
  let since = null;
  let until = null;
  try {
    if (opt("--since")) since = parseDateBound(opt("--since"), "since");
    if (opt("--until")) until = parseDateBound(opt("--until"), "until");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const range = since != null || until != null ? ` (${[since != null && "since " + fmtDay(since), until != null && "until " + fmtDay(until)].filter(Boolean).join(" ")})` : "";
  const label = projectLabeler();

  function claudeSessionFiles() {
    const out = [];
    if (!existsSync(claudeRoot)) return out;
    for (const p of readdirSync(claudeRoot)) {
      const d = join(claudeRoot, p);
      let st;
      try {
        st = statSync(d);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) out.push(join(d, f));
    }
    return out;
  }

  function allSessionFiles() {
    const files = agent === "claude" ? claudeSessionFiles() : agent === "codex" ? codexSessionFiles(codexRoot) : [...claudeSessionFiles(), ...codexSessionFiles(codexRoot)];
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  }

  const idOf = (f) => (basename(f).startsWith("rollout-") ? codexIdFromFile(f) : basename(f, ".jsonl"));
  const parseAny = (f, o) => (isCodexFile(f) ? parseCodexSession(f, o) : parseSession(f, o));

  function findSession(key) {
    if (existsSync(key) && key.endsWith(".jsonl")) return resolve(key);
    let hit = allSessionFiles().find((f) => idOf(f).startsWith(key));
    // a Codex session id given without --agent: look in the Codex sessions too
    if (!hit && agent === "claude" && !opt("--dir")) hit = codexSessionFiles(codexRoot).find((f) => idOf(f).startsWith(key));
    if (!hit) {
      console.error(`No session matching "${key}" under ${root}`);
      process.exit(1);
    }
    return hit;
  }


  if (flag("--list") || flag("--all")) {
    const files = allSessionFiles();
    const rows = [];
    let total = 0;
    const byProject = {};
    const tasks = [];
    for (const f of files) {
      let s;
      try {
        s = parseAny(f, { pricing, light: true });
      } catch {
        continue;
      }
      if (!inRange(s, since, until)) continue;
      if (redact) redactSession(s, label(projectName(s.cwd)));
      total += s.cost;
      byProject[projectName(s.cwd)] = (byProject[projectName(s.cwd)] || 0) + s.cost;
      rows.push(s);
      for (const t of s.tasks) if (!t.meta) tasks.push({ ...t, session: s });
    }
    if (flag("--list")) {
      // most recently active first: the date shown is the last API call, and rows are sorted by it
      const lastActive = (s) => s.end || s.start || "";
      rows.sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
      console.log(`\n  ${pad("cost", 8)}  ${pad("dur", 5)}  ${"last active".padEnd(11)}  ${"project".padEnd(18)}  title / id\n`);
      for (const s of rows.slice(0, limit))
        console.log(`  ${pad(usd(s.cost), 8)}  ${pad(dur(s.durationMs), 5)}  ${lastActive(s).slice(0, 10).padEnd(11)}  ${trunc(projectName(s.cwd), 18)}  ${trunc((agent === "all" && s.agent === "codex" ? "[codex] " : "") + s.title, 44)}  ${s.id.slice(0, 8)}`);
      console.log(`\n  ${rows.length} session${rows.length === 1 ? "" : "s"}${range}, ${usd(total)} in total. Run: ccreceipt <id>\n`);
    } else {
      console.log(`\n  ${rows.length} session${rows.length === 1 ? "" : "s"}${range} · ${usd(total)} total\n`);
      console.log("  By project");
      for (const [p, c] of Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log(`  ${pad(usd(c), 8)}  ${p}`);
      console.log("\n  Most expensive tasks ever");
      for (const t of tasks.sort((a, b) => b.cost - a.cost).slice(0, limit))
        console.log(`  ${pad(usd(t.cost), 8)}  ${trunc(projectName(t.session.cwd), 14)}  ${trunc(`#${t.index} ${t.short}`, 70)}  ${t.session.id.slice(0, 8)}`);
      console.log();
    }
    return;
  }

  const file = positional[0] ? findSession(positional[0]) : allSessionFiles()[0];
  if (!file) {
    console.error(`No sessions found under ${root}`);
    process.exit(1);
  }
  const s = parseAny(file, { pricing });
  if (redact) redactSession(s, label(projectName(s.cwd)));

  if (flag("--json")) {
    const { calls, ...rest } = s;
    console.log(JSON.stringify({ ...rest, calls: calls.length }, null, 2));
    return;
  }

  // terminal receipt
  console.log();
  for (const l of receiptText(receiptRows(s))) console.log(l);
  console.log();

  if (opt("--svg")) {
    // the image is meant to be posted: redacted unless --no-redact, whatever the terminal shows
    const img = !redact && !flag("--no-redact") ? redactSession(structuredClone(s), label(projectName(s.cwd))) : s;
    const svgOut = resolve(opt("--svg"));
    mkdirSync(join(svgOut, ".."), { recursive: true });
    writeFileSync(svgOut, receiptSvg(receiptRows(img)));
    console.log(`  Image: ${svgOut}${img.redacted ? " (redacted; --no-redact to keep prompt texts)" : ""}\n`);
    return;
  }

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
}

main();
