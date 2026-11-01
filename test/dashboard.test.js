import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, charWidth, textWidth, fitWidth, to256, colorMode } from "../src/canvas.js";
import { renderDashboard, VIEWS } from "../src/dashboard.js";
import { runTui, parseKeys, opensDashboard } from "../src/tui.js";
import { parseSession } from "../src/parse.js";
import { redactSession } from "../src/redact.js";

const BIN = fileURLToPath(new URL("../bin/ccreceipt.js", import.meta.url));
const DIR = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const FILES = readdirSync(DIR).flatMap((p) => readdirSync(join(DIR, p)).filter((f) => f.endsWith(".jsonl")).map((f) => join(DIR, p, f)));
const SESSIONS = FILES.map((f) => parseSession(f, { light: true })).sort((a, b) => (b.end || "").localeCompare(a.end || ""));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function state(over = {}) {
  const selected = over.selected ?? 0;
  return {
    version: "9.9.9",
    agent: "claude",
    root: "/home/demo/.claude/projects",
    redact: false,
    loading: null,
    rows: SESSIONS.map((s) => ({ cost: s.cost, last: (s.end || "").slice(0, 10), project: s.cwd.split("/").pop(), title: s.title, id: s.id, codex: false })),
    total: SESSIONS.reduce((n, s) => n + s.cost, 0),
    selected,
    detail: parseSession(SESSIONS[selected].file),
    view: "overview",
    scroll: 0,
    tick: 0,
    message: null,
    ...over,
  };
}
const screen = (st, w = 120, h = 34) => renderDashboard(st, w, h).toText();
const indexOf = (title) => SESSIONS.findIndex((s) => s.title.startsWith(title));

test("character widths: wide characters take two cells, combining marks none", () => {
  assert.equal(charWidth("a"), 1);
  assert.equal(charWidth("é"), 1);
  assert.equal(charWidth("日"), 2);
  assert.equal(charWidth("🎉"), 2);
  assert.equal(charWidth("́"), 0);
  assert.equal(textWidth("日本 ok"), 7);
  assert.equal(fitWidth("abcdef", 4), "abc…");
  assert.equal(textWidth(fitWidth("日本語のタイトル", 7)), 7);
  assert.equal(fitWidth("line\nbreak", 20), "line break");
});

test("the canvas clips text and keeps every row as wide as the terminal", () => {
  const c = new Canvas(10, 2);
  c.put(7, 0, "abcdef");
  c.put(0, 1, "日本語日本語");
  assert.deepEqual(c.toText().map(textWidth), [10, 10]);
  assert.equal(c.toText()[0], "       abc");
  assert.equal(c.toText()[1], "日本語日本");
});

test("colours: truecolor, 256 colours or none, from the environment", () => {
  assert.equal(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
  assert.equal(colorMode({ COLORTERM: "truecolor" }), "truecolor");
  assert.equal(colorMode({ TERM_PROGRAM: "iTerm.app" }), "truecolor");
  assert.equal(colorMode({ TERM: "xterm-256color" }), "256");
  assert.equal(to256("#000000"), 16);
  assert.equal(to256("#ffffff"), 231);
  const c = new Canvas(4, 1);
  c.put(0, 0, "ab", { fg: "#d4a556", bg: "#040b15", bold: true });
  assert.match(c.toAnsi("truecolor"), /38;2;212;165;86;48;2;4;11;21m/);
  assert.match(c.toAnsi("256"), /38;5;\d+;48;5;\d+m/);
  assert.doesNotMatch(c.toAnsi("none"), /38;|48;/);
});

test("the overview shows the list, the total, the breakdown and the priciest tasks", () => {
  const i = indexOf("Health endpoint");
  const rows = screen(state({ selected: i }));
  assert.ok(rows.every((r) => textWidth(r) === 120), "every row is exactly the terminal width");
  const text = rows.join("\n");
  for (const s of ["CCRECEIPT", "v9.9.9", "4 SESSIONS", "SESSION_LIST", "OVERVIEW", "TASKS", "TOOLS", "MODELS", "COST_BREAKDOWN", "PRICIEST_TASKS", "Health endpoint", "ENTER", "REPORT", "CARD"]) assert.ok(text.includes(s), s);
  assert.match(text, /▶ +\$0\.03/, "the selected row is marked");
  assert.match(text, /▀|▄|█/, "the total is drawn in the pixel font");
});

test("every key of the footer fits in 80 columns", () => {
  const footer = screen(state(), 80, 24).at(-1);
  for (const k of ["SELECT", "VIEW", "ENTER", "REPORT", "S", "CARD", "REDACT", "AGENT", "QUIT"]) assert.ok(footer.includes(k), k);
});

test("the tasks, tools and models tabs", () => {
  const i = indexOf("Health endpoint");
  const tasks = screen(state({ selected: i, view: "tasks" })).join("\n");
  assert.match(tasks, /CALLS +TOOLS +COST/);
  assert.match(tasks, /#1 +Add a health endpoint/);
  const tools = screen(state({ selected: i, view: "tools" })).join("\n");
  assert.match(tools, /Read +1 +1\.0k/);
  const models = screen(state({ selected: indexOf("Cost checks"), view: "models" })).join("\n");
  assert.match(models, /SAME_TOKENS_ON/);
  assert.match(models, /Sonnet 5\.5 .*\$13\.00/);
  assert.match(models, /Fable 5\.1 .*\$65\.00/);
});

test("an unknown model price is flagged in red text on the overview", () => {
  const text = screen(state({ selected: indexOf("Cost checks") })).join("\n");
  assert.match(text, /! UNKNOWN PRICE +claude-nova-preview/);
});

test("wide characters in titles keep every row at the terminal width", () => {
  const st = state();
  st.rows[0].title = "日本語のタイトル 🎉 avec des accents éàü";
  st.detail = { ...st.detail, title: "日本語のタイトル 🎉".repeat(10) };
  for (const view of VIEWS) assert.ok(screen({ ...st, view }, 100, 30).every((r) => textWidth(r) === 100), view);
});

test("loading, empty and too-small states", () => {
  const loading = screen(state({ loading: { done: 2, total: 4 }, rows: [], detail: null })).join("\n");
  assert.match(loading, /IMPORTING SESSIONS +2\/4/);
  const empty = screen(state({ rows: [], detail: null })).join("\n");
  assert.match(empty, /NO SESSIONS YET/);
  const small = screen(state(), 70, 20).join("\n");
  assert.match(small, /TERMINAL TOO SMALL/);
  assert.match(small, /80 × 24 minimum, now 70 × 20/);
});

test("key parsing: arrows, vi keys, tab, page keys, quit", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[Bjk\t\x1b[Z\x1b[5~\x1b[6~\r"), ["up", "down", "down", "up", "tab", "backtab", "pageup", "pagedown", "enter"]);
  assert.deepEqual(parseKeys("\x1bOA\x1b[H\x1b[F"), ["up", "home", "end"]);
  assert.deepEqual(parseKeys("q"), ["quit"]);
  assert.deepEqual(parseKeys("\x1b"), ["quit"]);
  assert.deepEqual(parseKeys("\x03"), ["quit"]);
  assert.deepEqual(parseKeys("x\x1b[99~z"), []);
});

/** A fake terminal: input takes keys, output records frames. */
function fakeTerminal(cols = 120, rows = 34) {
  const input = new PassThrough();
  input.setRawMode = (on) => (input.raw = on);
  input.isTTY = true;
  const output = new EventEmitter();
  Object.assign(output, { columns: cols, rows, isTTY: true, writes: [], write: (s) => output.writes.push(s) });
  const last = () => strip(output.writes.filter((w) => w.includes("\x1b[1;1H")).at(-1) || "");
  return { input, output, last };
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function startTui(over = {}) {
  const term = fakeTerminal();
  const reports = [];
  const cards = [];
  const listed = [];
  const exitListeners = process.listenerCount("exit");
  const done = runTui({
    version: "9.9.9",
    agent: "claude",
    redact: false,
    listFiles: (a) => (listed.push(a), a === "claude" ? FILES : []),
    rootOf: (a) => `/sessions/${a}`,
    parseLight: (f) => parseSession(f, { light: true }),
    parseFull: (f) => parseSession(f),
    openReport: (s) => (reports.push(s), "/tmp/report.html"),
    writeCard: (s, o) => (cards.push({ s, o }), { path: "/tmp/card.svg", redacted: true }),
    writeAllCard: (sum, o) => (cards.push({ sum, o }), { path: "/tmp/all.svg", redacted: o.redacted }),
    input: term.input,
    output: term.output,
    env: { COLORTERM: "truecolor" },
    ...over,
  });
  await settle();
  const key = async (k) => {
    term.input.write(k);
    await settle();
  };
  return { ...term, done, key, reports, cards, listed, exitListeners };
}

test("the dashboard opens on the alternate screen and Q restores the terminal", async () => {
  const t = await startTui();
  assert.ok(t.output.writes[0].startsWith("\x1b[?1049h\x1b[?25l"), "alternate screen, hidden cursor");
  assert.equal(t.input.raw, true);
  assert.match(t.last(), /SESSION_LIST/);
  assert.match(t.last(), /4 SESSIONS/);
  await t.key("q");
  await t.done;
  assert.equal(t.input.raw, false);
  assert.ok(t.output.writes.at(-1).endsWith("\x1b[?25h\x1b[?1049l"), "cursor shown, main screen back");
  assert.equal(process.listenerCount("exit"), t.exitListeners, "no listener left behind");
});

test("keys move the selection, switch tabs and open the report", async () => {
  const t = await startTui();
  await t.key("\x1b[B");
  assert.match(t.last(), /2\/4/);
  await t.key("\t");
  assert.match(t.last(), /CALLS +TOOLS +COST/);
  await t.key("\x1b[Z");
  assert.match(t.last(), /COST_BREAKDOWN/);
  await t.key("\r");
  assert.equal(t.reports.length, 1);
  assert.equal(t.reports[0].id, SESSIONS[1].id);
  assert.match(t.last(), /Report: \/tmp\/report\.html/);
  await t.key("\x03");
  await t.done;
});

test("S writes the receipt card of the selected session and shows its path", async () => {
  const t = await startTui();
  await t.key("j");
  await t.key("s");
  assert.equal(t.cards.length, 1);
  assert.equal(t.cards[0].s.id, SESSIONS[1].id);
  assert.deepEqual(t.cards[0].o, { redacted: false });
  assert.match(t.last(), /Card: \/tmp\/card\.svg \(redacted\)/);
  await t.key("r");
  await t.key("S");
  assert.equal(t.cards[1].s.redacted, true, "with R on, the card gets the redacted session");
  assert.deepEqual(t.cards[1].o, { redacted: true });
  await t.key("q");
  await t.done;
});

test("S on the ALL tab writes the card of every session, redacted by default", async () => {
  const t = await startTui({ view: "all" });
  await t.key("s");
  assert.equal(t.cards.length, 1);
  const { sum, o } = t.cards[0];
  assert.equal(o.redacted, true);
  assert.equal(sum.count, 4);
  assert.equal(sum.total.toFixed(2), "30.03");
  assert.deepEqual(sum.projects.map(([p]) => p), ["project-1"]);
  assert.doesNotMatch(JSON.stringify(sum), /SENTINEL|acme-api|Cost checks/);
  assert.match(t.last(), /Card: \/tmp\/all\.svg \(redacted\)/);
  // on another tab, S is the selected session's card again
  await t.key("\t");
  await t.key("s");
  assert.ok(t.cards[1].s, "the session card");
  await t.key("q");
  await t.done;

  const raw = await startTui({ view: "all", cardRedacted: false });
  await raw.key("s");
  assert.equal(raw.cards[0].o.redacted, false, "--no-redact keeps names");
  assert.deepEqual(raw.cards[0].sum.projects.map(([p]) => p), ["acme-api"]);
  await raw.key("q");
  await raw.done;
});

test("R hides prompts, titles, paths and project names in every tab and in the report", async () => {
  const t = await startTui({ redact: true });
  const i = indexOf("Health endpoint");
  for (let n = 0; n < i; n++) await t.key("j");
  const seen = [];
  for (const _ of VIEWS) {
    seen.push(t.last());
    await t.key("\t");
  }
  await t.key("\r");
  const all = seen.join("\n");
  assert.match(all, /REDACTED/);
  assert.doesNotMatch(all, /SENTINEL|acme-api|brave-turing|\/home\/demo/);
  assert.match(all, /Session aaaaaaaa/);
  assert.equal(t.reports[0].redacted, true);
  await t.key("r");
  assert.match(t.last(), /Health endpoint SENTINEL_TITLE/);
  await t.key("q");
  await t.done;
});

test("the ALL tab shows what --all prints, and --tui --all opens on it", async () => {
  const t = await startTui({ view: "all" });
  const all = spawnSync(process.execPath, [BIN, "--all", "--dir", DIR], { encoding: "utf8" }).stdout;
  const total = /· (\$[\d.]+) total/.exec(all)[1];
  const text = t.last();
  assert.match(text, /All sessions/);
  assert.match(text, /4 sessions · 1 project/);
  assert.match(text, new RegExp(`${total.replace("$", "\\$")} TOTAL`));
  assert.match(text, /BY_PROJECT/);
  assert.match(text, /acme-api .*\$30\.03/);
  assert.match(text, /PRICIEST_TASKS_EVER/);
  assert.match(text, /\$26\.00 acme-api +#1 Cost checks +bbbbbbbb/);
  assert.match(text, /8 rows/);
  await t.key("r");
  assert.doesNotMatch(t.last(), /SENTINEL|acme-api|Cost checks/);
  assert.match(t.last(), /#1 \(prompt redacted\)/);
  assert.match(t.last(), /#3 \[automatic: task-notification\]/);
  await t.key("q");
  await t.done;
});

test("every tab, ALL included, is visible at 80 columns", () => {
  const top = screen(state({ view: "all" }), 80, 24)[3];
  for (const v of VIEWS) assert.ok(top.includes(v.toUpperCase()), v);
});

test("A cycles the agent and reloads; an empty agent shows the empty state", async () => {
  const t = await startTui();
  await t.key("a");
  assert.deepEqual(t.listed, ["claude", "codex"]);
  assert.match(t.last(), /AGENT: CODEX/);
  assert.match(t.last(), /NO SESSIONS YET/);
  assert.match(t.last(), /\/sessions\/codex/);
  await t.key("q");
  await t.done;
});

test("a resize redraws at the new size", async () => {
  const t = await startTui();
  t.output.columns = 70;
  t.output.rows = 20;
  t.output.emit("resize");
  await settle();
  assert.match(t.last(), /TERMINAL TOO SMALL/);
  await t.key("q");
  await t.done;
});

test("ccreceipt, --list and --all open the dashboard only in a terminal; printing flags, ids and --no-tui print", () => {
  const tty = { stdinTTY: true, stdoutTTY: true };
  const open = (argv, positional = [], term = tty) => opensDashboard({ argv, positional, ...term });
  assert.equal(open([]), true);
  assert.equal(open(["--agent", "codex", "--since", "7d", "--redact", "--no-open"]), true);
  assert.equal(open([], [], { stdinTTY: true, stdoutTTY: false }), false, "piped output");
  assert.equal(open([], [], { stdinTTY: false, stdoutTTY: true }), false, "piped input");
  assert.equal(open(["3f2a"], ["3f2a"]), false);
  for (const f of ["--json", "--svg", "--out", "--no-tui"]) assert.equal(open([f]), false, f);
  assert.equal(open(["--all"]), true, "--all opens the dashboard on ALL");
  assert.equal(open(["--list", "--since", "7d"]), true);
  assert.equal(open(["--all"], [], { stdinTTY: true, stdoutTTY: false }), false, "--all piped prints");
  assert.equal(open(["--list", "--no-tui"]), false);
  assert.equal(open(["--all", "--svg", "all.svg"]), false, "--all --svg prints and writes the card");
  assert.equal(open(["--tui", "--all"]), true);
  assert.equal(open(["--tui"], [], { stdinTTY: false, stdoutTTY: false }), true, "--tui decides, then fails without a terminal");
});

test("without a terminal, a bare ccreceipt still prints the most recent receipt", () => {
  const r = spawnSync(process.execPath, [BIN, "--dir", DIR, "--no-open"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RECEIPT ·/);
  assert.match(r.stdout, /Report: /);
});

test("--tui without a terminal exits with an error", () => {
  const r = spawnSync(process.execPath, [BIN, "--tui", "--dir", DIR], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--tui needs an interactive terminal/);
  assert.equal(r.stdout, "");
});

test("redactSession output renders without the original strings", () => {
  const i = indexOf("Health endpoint");
  const detail = redactSession(parseSession(SESSIONS[i].file), "project-1");
  const rows = SESSIONS.map((s, n) => ({ cost: s.cost, last: "", project: `project-${n}`, title: `Session ${s.id.slice(0, 8)}`, id: s.id, codex: false }));
  for (const view of VIEWS) assert.doesNotMatch(screen(state({ selected: i, detail, view, rows, redact: true })).join("\n"), /SENTINEL|acme-api|\/home\/demo/);
});
