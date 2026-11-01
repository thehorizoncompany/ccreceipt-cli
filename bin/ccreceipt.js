#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSession } from "../src/parse.js";
import { renderHtml } from "../src/html.js";
import { redactSession, projectLabeler } from "../src/redact.js";
import { projectName } from "../src/project.js";
import { parseDateBound, inRange, fmtDay } from "../src/dates.js";
import { usd, pad, trunc, dur } from "../src/format.js";
import { receiptRows, receiptText, receiptSvg } from "../src/receipt.js";
import { parseCodexSession, codexSessionFiles, codexIdFromFile, isCodexFile } from "../src/codex.js";
import { updateCheckEnabled, updateCacheFile, updateNotice } from "../src/update.js";
import { runTui } from "../src/tui.js";

// readFileSync rather than a JSON import: import attributes are not stable on Node 18.
function packageVersion() {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
}

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
    console.log(packageVersion());
    return;
  }

  if (flag("--help") || flag("-h")) {
    console.log(`ccreceipt – the itemized receipt for a Claude Code or Codex session

Usage:
  ccreceipt                 receipt for the most recent session (opens an HTML report)
  ccreceipt <id-or-path>    receipt for that session (session id, prefix, or .jsonl path)
  ccreceipt --list          the 20 most recently active sessions with their cost
  ccreceipt --all           totals across every session on this machine
  ccreceipt --tui           interactive dashboard: browse every session and its receipt (--all: open on the totals)

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
  --no-update-check   do not check npm for a newer version (also NO_UPDATE_NOTIFIER=1)
  -v, --version       print the version
  -h, --help          print this help

Everything runs locally, no telemetry. The only network request is a daily check
for a newer version on npm, which sends nothing but the package name.`);
    return;
  }

  const agent = opt("--agent") || "claude";
  if (!["claude", "codex", "all"].includes(agent)) {
    console.error(`Invalid --agent "${agent}": use claude, codex or all`);
    process.exit(1);
  }
  // --dir applies to the agent given on the command line
  const claudeRootFor = (a) => (a !== "codex" && opt("--dir")) || join(homedir(), ".claude", "projects");
  const codexRootFor = (a) => (a === "codex" && opt("--dir")) || join(homedir(), ".codex", "sessions");
  const claudeRoot = claudeRootFor(agent);
  const codexRoot = codexRootFor(agent);
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

  function claudeSessionFiles(dir = claudeRoot) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const p of readdirSync(dir)) {
      const d = join(dir, p);
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

  function allSessionFiles(a = agent) {
    const claude = () => claudeSessionFiles(claudeRootFor(a));
    const codex = () => codexSessionFiles(codexRootFor(a));
    const files = a === "claude" ? claude() : a === "codex" ? codex() : [...claude(), ...codex()];
    return files.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
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

  function writeReport(s) {
    const out = opt("--out") ? resolve(opt("--out")) : join(tmpdir(), "ccreceipt", `${s.id.slice(0, 8)}.html`);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, renderHtml(s));
    if (!flag("--no-open")) {
      try {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        execFileSync(cmd, process.platform === "win32" ? ["/c", "start", "", out] : [out], { stdio: "ignore" });
      } catch {
        /* no browser: the path is printed */
      }
    }
    return out;
  }

  /** The shareable receipt image: redacted unless --no-redact. */
  function writeCard(s, { redacted = false } = {}) {
    const img = !redacted && !flag("--no-redact") ? redactSession(structuredClone(s), label(projectName(s.cwd))) : s;
    const out = opt("--svg") ? resolve(opt("--svg")) : join(tmpdir(), "ccreceipt", `${s.id.slice(0, 8)}.svg`);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, receiptSvg(receiptRows(img)));
    return { path: out, redacted: !!img.redacted };
  }

  /** Opens an image without waiting: Quick Look on macOS (Preview cannot open SVG), the default app elsewhere. */
  function previewImage(file) {
    if (flag("--no-open")) return;
    const [cmd, args] = process.platform === "darwin" ? ["qlmanage", ["-p", file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      /* no viewer: the path is shown */
    }
  }

  if (flag("--tui")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("--tui needs an interactive terminal. Use --list or --all to print instead.");
      process.exit(1);
    }
    return runTui({
      version: packageVersion(),
      agent,
      redact,
      since,
      until,
      view: flag("--all") ? "all" : "overview",
      listFiles: (a) => allSessionFiles(a),
      rootOf: (a) => (a === "codex" ? codexRootFor(a) : a === "all" ? `${claudeRootFor(a)} + ${codexRootFor(a)}` : claudeRootFor(a)),
      parseLight: (f) => parseAny(f, { pricing, light: true }),
      parseFull: (f) => parseAny(f, { pricing }),
      openReport: writeReport,
      writeCard: (s, o) => {
        const card = writeCard(s, o);
        previewImage(card.path);
        return card;
      },
    });
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
    const card = writeCard(s, { redacted: redact });
    console.log(`  Image: ${card.path}${card.redacted ? " (redacted; --no-redact to keep prompt texts)" : ""}\n`);
    return;
  }

  // the path is printed before the browser opens, as before
  const out = opt("--out") ? resolve(opt("--out")) : join(tmpdir(), "ccreceipt", `${s.id.slice(0, 8)}.html`);
  console.log(`  Report: ${out}\n`);
  writeReport(s);
}

// One line on stderr after the output when npm has a newer version (see src/update.js).
function notifyUpdate() {
  const argv = process.argv.slice(2);
  if (["--help", "-h", "--version", "-v"].some((f) => argv.includes(f))) return;
  if (!updateCheckEnabled({ argv, env: process.env, isTTY: !!process.stdout.isTTY })) return;
  try {
    const line = updateNotice({ current: packageVersion(), file: updateCacheFile(), scriptPath: fileURLToPath(import.meta.url) });
    // a plain write: Bun colors console.error output red
    if (line) process.stderr.write(`  ${line}\n\n`);
  } catch {
    /* never fail a command over the version check */
  }
}

// main() returns a promise only for --tui; the notice waits for the dashboard to close.
Promise.resolve(main()).then(notifyUpdate);
