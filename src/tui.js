// The interactive dashboard (--tui): terminal setup, keys, loading, and the loop that redraws
// src/dashboard.js. The terminal is restored on every way out: Q, Ctrl+C, an error, or exit.
import { renderDashboard, VIEWS } from "./dashboard.js";
import { colorMode } from "./canvas.js";
import { redactSession, projectLabeler, redactedTaskLabel } from "./redact.js";
import { projectName } from "./project.js";
import { inRange, fmtDay } from "./dates.js";

const KEYS = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[H": "home",
  "\x1b[1~": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1b[4~": "end",
  "\x1bOF": "end",
  "\x1b[Z": "backtab",
  "\t": "tab",
  "\r": "enter",
  "\n": "enter",
  "\x03": "quit",
  "\x1b": "quit",
  q: "quit",
  Q: "quit",
  k: "up",
  j: "down",
  g: "home",
  G: "end",
  r: "redact",
  R: "redact",
  a: "agent",
  A: "agent",
  s: "card",
  S: "card",
};

/** Splits what the terminal sent into key names; unknown input is dropped. */
export function parseKeys(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b" && i + 1 < data.length) {
      // longest escape sequence first: CSI (ESC [ ... final byte) or SS3 (ESC O x)
      const m = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z])/.exec(data.slice(i));
      if (m) {
        if (KEYS[m[0]]) out.push(KEYS[m[0]]);
        i += m[0].length;
        continue;
      }
    }
    const ch = data[i];
    if (KEYS[ch]) out.push(KEYS[ch]);
    i++;
  }
  return out;
}

const AGENTS = ["claude", "codex", "all"];
const PRINTING = ["--json", "--svg", "--out", "--list", "--all"];

/**
 * Whether a run opens the dashboard: always with --tui; otherwise only for a bare `ccreceipt`
 * (no session, no printing flag, no --no-tui) in an interactive terminal, so scripts and pipes
 * keep the printed receipt.
 * The terminal checks are read last and lazily (pass getters): under Bun, touching
 * process.stdin can cut a large output piped to stdout when the process exits.
 */
export function opensDashboard(o) {
  if (o.argv.includes("--tui")) return true;
  if (o.argv.includes("--no-tui") || o.positional.length) return false;
  if (PRINTING.some((f) => o.argv.includes(f))) return false;
  return !!(o.stdoutTTY && o.stdinTTY);
}

/**
 * opts: { version, agent, redact, since, until, listFiles(agent) -> files, rootOf(agent) -> path,
 *         parseLight(file), parseFull(file), openReport(session) -> path,
 *         writeCard(session, { redacted }) -> { path, redacted },
 *         input = process.stdin, output = process.stdout, env = process.env }
 * Resolves when the user quits.
 */
export function runTui(opts) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const mode = colorMode(opts.env || process.env);
  const label = projectLabeler();

  const state = {
    version: opts.version,
    agent: opts.agent,
    root: opts.rootOf(opts.agent),
    redact: !!opts.redact,
    loading: { done: 0, total: 0 },
    sessions: [],
    rows: [],
    total: 0,
    selected: 0,
    detail: null,
    view: VIEWS.includes(opts.view) ? opts.view : "overview",
    scroll: 0,
    totals: null,
    range: [opts.since != null && "since " + fmtDay(opts.since), opts.until != null && "until " + fmtDay(opts.until)].filter(Boolean).join(" "),
    tick: 0,
    message: null,
  };
  const details = new Map(); // file -> full session or { error }
  let loadId = 0;
  let detailTimer = null;
  let messageTimer = null;
  let closed = false;

  return new Promise((resolve, reject) => {
    const draw = () => {
      if (closed) return;
      const frame = renderDashboard(state, output.columns || 80, output.rows || 24);
      // synchronized output (ignored by terminals that do not know it) avoids tearing
      output.write("\x1b[?2026h" + frame.toAnsi(mode) + "\x1b[?2026l");
    };

    const rowsFor = () => {
      state.rows = state.sessions.map((s) => {
        const project = projectName(s.cwd);
        return {
          cost: s.cost,
          last: (s.end || s.start || "").slice(0, 10),
          project: state.redact ? label(project) : project,
          title: state.redact ? `Session ${s.id.slice(0, 8)}` : s.title,
          id: s.id,
          codex: state.agent === "all" && s.agent === "codex",
        };
      });
      state.total = state.sessions.reduce((n, s) => n + s.cost, 0);
      // what --all prints: spend by project and the most expensive tasks ever
      const byProject = new Map();
      const tasks = [];
      state.sessions.forEach((s, i) => {
        const project = state.rows[i].project;
        byProject.set(project, (byProject.get(project) || 0) + s.cost);
        for (const t of s.tasks)
          if (!t.meta) tasks.push({ cost: t.cost, project, label: `#${t.index} ${state.redact ? redactedTaskLabel(t) : t.short}`, id: s.id });
      });
      state.totals = {
        projects: [...byProject].sort((a, b) => b[1] - a[1]),
        tasks: tasks.sort((a, b) => b.cost - a.cost).slice(0, 500),
      };
    };

    const showDetail = () => {
      const s = state.sessions[state.selected];
      clearTimeout(detailTimer);
      if (!s) {
        state.detail = null;
        return;
      }
      const known = details.get(s.file);
      if (known) {
        state.detail = known.error || !state.redact ? known : redactSession(structuredClone(known), label(projectName(known.cwd)));
        return;
      }
      state.detail = null;
      // wait for the selection to settle before parsing a whole session
      detailTimer = setTimeout(() => {
        try {
          details.set(s.file, opts.parseFull(s.file));
        } catch (e) {
          details.set(s.file, { error: e.message });
        }
        if (state.sessions[state.selected] === s) showDetail();
        draw();
      }, 60);
    };

    const select = (i) => {
      const n = state.sessions.length;
      if (!n) return;
      const next = Math.max(0, Math.min(n - 1, i));
      if (next !== state.selected) {
        state.selected = next;
        if (state.view !== "all") state.scroll = 0;
      }
      showDetail();
    };

    const say = (text) => {
      state.message = text;
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => {
        state.message = null;
        draw();
      }, 6000);
    };

    async function load() {
      const id = ++loadId;
      state.root = opts.rootOf(state.agent);
      state.sessions = [];
      state.rows = [];
      state.selected = 0;
      state.detail = null;
      const files = opts.listFiles(state.agent);
      state.loading = { done: 0, total: files.length };
      draw();
      const found = [];
      let lastDraw = Date.now();
      for (let i = 0; i < files.length; i++) {
        try {
          const s = opts.parseLight(files[i]);
          if (inRange(s, opts.since ?? null, opts.until ?? null)) found.push(s);
        } catch {
          /* unreadable session: skipped, as in --list */
        }
        state.loading.done = i + 1;
        if (Date.now() - lastDraw > 40 || i % 8 === 7) {
          draw();
          lastDraw = Date.now();
          // let keys (Q, A) through while a large history loads
          await new Promise((r) => setImmediate(r));
          if (closed || id !== loadId) return;
        }
      }
      const lastActive = (s) => s.end || s.start || "";
      state.sessions = found.sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
      state.loading = null;
      rowsFor();
      showDetail();
      draw();
    }

    const pageSize = () => Math.max(1, (output.rows || 24) - 9);
    const viewRows = () => {
      if (state.view === "all") return state.totals?.tasks.length || 0;
      const d = state.detail;
      if (!d || d.error) return 0;
      if (state.view === "tasks") return d.tasks.filter((t) => !t.meta || t.cost > 0).length;
      if (state.view === "tools") return Object.keys(d.byTool).length;
      return 0;
    };
    const scrollBy = (n) => {
      state.scroll = Math.max(0, Math.min(Math.max(0, viewRows() - pageSize()), state.scroll + n));
    };

    function onKey(key) {
      switch (key) {
        case "quit":
          return close();
        case "up":
          select(state.selected - 1);
          break;
        case "down":
          select(state.selected + 1);
          break;
        case "home":
          select(0);
          break;
        case "end":
          select(state.sessions.length - 1);
          break;
        case "pageup":
          if (state.view !== "overview" && state.view !== "models") scrollBy(-pageSize());
          else select(state.selected - pageSize());
          break;
        case "pagedown":
          if (state.view !== "overview" && state.view !== "models") scrollBy(pageSize());
          else select(state.selected + pageSize());
          break;
        case "tab":
        case "right":
          state.view = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
          state.scroll = 0;
          break;
        case "backtab":
        case "left":
          state.view = VIEWS[(VIEWS.indexOf(state.view) + VIEWS.length - 1) % VIEWS.length];
          state.scroll = 0;
          break;
        case "redact":
          state.redact = !state.redact;
          if (!state.loading) rowsFor();
          showDetail();
          say(state.redact ? "Redacted: prompts, titles, paths and names hidden" : "Redaction off");
          break;
        case "agent":
          state.agent = AGENTS[(AGENTS.indexOf(state.agent) + 1) % AGENTS.length];
          load().catch(fail);
          return;
        case "enter":
        case "card": {
          const s = state.sessions[state.selected];
          if (!s || state.loading) break;
          try {
            let full = details.get(s.file);
            if (!full) details.set(s.file, (full = opts.parseFull(s.file)));
            if (full.error) throw new Error(full.error);
            const shown = state.redact ? redactSession(structuredClone(full), label(projectName(full.cwd))) : full;
            if (key === "enter") say(`Report: ${opts.openReport(shown)}`);
            else {
              const card = opts.writeCard(shown, { redacted: state.redact });
              say(`Card: ${card.path}${card.redacted ? " (redacted)" : ""}`);
            }
          } catch (e) {
            say(`Could not write the ${key === "enter" ? "report" : "card"}: ${e.message}`);
          }
          break;
        }
      }
      draw();
    }

    const onData = (data) => {
      for (const key of parseKeys(String(data))) {
        if (closed) return;
        onKey(key);
      }
    };
    const onResize = () => {
      output.write("\x1b[2J");
      draw();
    };
    const restore = () => output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    const onExit = () => restore();

    function close(err) {
      if (closed) return;
      closed = true;
      clearTimeout(detailTimer);
      clearTimeout(messageTimer);
      clearInterval(blink);
      input.off("data", onData);
      output.off("resize", onResize);
      process.off("exit", onExit);
      try {
        input.setRawMode?.(false);
      } catch {
        /* already restored */
      }
      input.pause();
      restore();
      if (err) reject(err);
      else resolve();
    }
    function fail(err) {
      close(err);
    }

    // alternate screen, hidden cursor, raw keys
    output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    process.on("exit", onExit);
    input.setRawMode?.(true);
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.resume();
    output.on("resize", onResize);
    // the blinking cursor of the title, and the steam of the cup while it shows
    const blink = setInterval(() => {
      state.tick++;
      draw();
    }, 600);

    load().catch(fail);
  });
}
