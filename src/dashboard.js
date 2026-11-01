// The terminal dashboard (--tui) as one pure function: state in, a Canvas out.
// Colours and rules come from the visual direction: night blue background, bone text,
// gold for what to look at, red only for the primary action and for errors.
import { Canvas, fitWidth, textWidth } from "./canvas.js";
import { usd, dur } from "./format.js";

export const THEME = {
  bg: "#040b15",
  panel: "#06111d",
  bone: "#f3e6c9",
  text: "#c8d4d1",
  mute: "#8aa19e",
  gold: "#d4a556",
  gold2: "#f0c56c",
  red: "#a8463f",
  red2: "#d85a4d",
  ok: "#8fb996",
  line: "#284c4a",
  track: "#132a33",
  chip: "#0b1a26",
  ghost: "#14303a",
  cup: "#f3e6c9",
  cupShade: "#c8b48f",
  coffee: "#6b4128",
  steam: "#55706d",
};

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
export const VIEWS = ["overview", "tasks", "tools", "models", "all"];

// 3 × 5 pixel font, drawn with half blocks: 3 terminal rows per glyph.
const FONT = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  $: ["011", "110", "010", "011", "110"],
  ".": ["0", "0", "0", "0", "1"],
  ",": ["0", "0", "0", "1", "1"],
  C: ["111", "100", "100", "100", "111"],
  R: ["110", "101", "110", "101", "101"],
  E: ["111", "100", "110", "100", "111"],
  I: ["111", "010", "010", "010", "111"],
  P: ["110", "101", "110", "100", "100"],
  T: ["111", "010", "010", "010", "010"],
  " ": ["0", "0", "0", "0", "0"],
};

/** Width in columns of `text` in the pixel font. */
export function bigWidth(text) {
  return [...text].reduce((w, ch) => w + (FONT[ch] || FONT[" "])[0].length + 1, 0) - 1;
}

/** Draws `text` in the pixel font, 3 rows tall, from (x, y). Returns the width used. */
function bigText(c, x, y, text, color, bg) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] || FONT[" "];
    for (let col = 0; col < g[0].length; col++)
      for (let r = 0; r < 3; r++) {
        const top = g[r * 2]?.[col] === "1";
        const bottom = g[r * 2 + 1]?.[col] === "1";
        const glyph = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
        c.put(cx + col, y + r, glyph, { fg: color, bg });
      }
    cx += g[0].length + 1;
  }
  return cx - x - 1;
}

// The coffee cup of the pixel scene, 12 × 10 pixels, two frames of steam.
const CUP = [
  [" s   s      ", "  s   s     ", " s   s      ", "wwwwwwwww   ", "wbbbbbbbwhh ", "wwwwwwwwwh h", "wwwwwwwwwh h", "wwwwwwwwwhh ", " dwwwwwwd   ", "dddddddddddd"],
  ["  s   s     ", " s   s      ", "  s   s     ", "wwwwwwwww   ", "wbbbbbbbwhh ", "wwwwwwwwwh h", "wwwwwwwwwh h", "wwwwwwwwwhh ", " dwwwwwwd   ", "dddddddddddd"],
];
const CUP_COLORS = { w: THEME.cup, h: THEME.cup, b: THEME.coffee, d: THEME.cupShade, s: THEME.steam };

/** Draws the pixel cup (12 columns × 5 rows) with half blocks. */
function cup(c, x, y, frame, bg) {
  const px = CUP[frame % 2];
  for (let r = 0; r < 5; r++)
    for (let col = 0; col < 12; col++) {
      const top = CUP_COLORS[px[r * 2][col]];
      const bottom = CUP_COLORS[px[r * 2 + 1][col]];
      if (top && bottom) c.put(x + col, y + r, top === bottom ? "█" : "▀", { fg: top, bg: bottom });
      else if (top) c.put(x + col, y + r, "▀", { fg: top, bg });
      else if (bottom) c.put(x + col, y + r, "▄", { fg: bottom, bg });
    }
}

const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** A box with a gold label in its top border; the inside is painted with the panel colour. */
function box(c, x, y, w, h, label) {
  const L = { fg: THEME.line, bg: THEME.panel };
  c.fill(x, y, w, h, THEME.panel, " ");
  c.put(x, y, "┌" + "─".repeat(w - 2) + "┐", L);
  for (let j = 1; j < h - 1; j++) {
    c.put(x, y + j, "│", L);
    c.put(x + w - 1, y + j, "│", L);
  }
  c.put(x, y + h - 1, "└" + "─".repeat(w - 2) + "┘", L);
  if (label) c.put(x + 2, y, ` ${label} `, { fg: THEME.gold, bg: THEME.panel, bold: true }, w - 4);
}

/** A horizontal bar: gold fill on a dim track. */
function bar(c, x, y, w, ratio, color = THEME.gold) {
  const filled = Math.max(0, Math.min(w, Math.round(w * ratio)));
  c.put(x, y, "█".repeat(filled), { fg: color, bg: THEME.panel });
  c.put(x + filled, y, "█".repeat(w - filled), { fg: THEME.track, bg: THEME.panel });
}

function label(c, x, y, text, w) {
  c.put(x, y, text, { fg: THEME.gold, bg: THEME.panel, bold: true }, w);
}

function header(c, state, W) {
  c.fill(0, 0, W, 2, THEME.bg, " ");
  const brand = "CCRECEIPT" + (state.tick % 2 ? " " : "_");
  let x = c.put(1, 0, brand, { fg: THEME.gold, bg: THEME.bg, bold: true });
  x = c.put(x + 1, 0, `v${state.version} // LOCAL`, { fg: THEME.mute, bg: THEME.bg });

  const chips = [];
  if (state.redact) chips.push({ text: " REDACTED ", fg: THEME.bone, bg: THEME.red, bold: true });
  chips.push({ text: ` AGENT: ${state.agent.toUpperCase()} `, fg: THEME.gold, bg: THEME.chip });
  if (!state.loading) {
    chips.push({ text: ` ${state.rows.length} SESSION${state.rows.length === 1 ? "" : "S"} `, fg: THEME.bone, bg: THEME.chip });
    chips.push({ text: ` ${usd(state.total)} TOTAL `, fg: THEME.gold2, bg: THEME.chip, bold: true });
  }
  let right = W - 1;
  for (const chip of chips.reverse()) {
    const w = textWidth(chip.text);
    if (right - w < x + 2) break;
    c.put(right - w, 0, chip.text, chip);
    right -= w + 1;
  }

  // status message (report or card path) on the right of the breadcrumb row
  let msgX = W - 1;
  if (state.message) {
    const max = Math.min(W - 30, 90);
    const i = state.message.indexOf(": ");
    const head = i > 0 ? state.message.slice(0, i + 2) : "";
    let body = i > 0 ? state.message.slice(i + 2) : state.message;
    // a path is cut from the left: the file name is the part worth reading
    while (textWidth(head + body) > max && body.length > 1) body = body.slice(1);
    if (head + body !== state.message && i > 0) body = "…" + body.slice(1);
    const text = head + body;
    msgX = W - 1 - textWidth(text);
    c.put(msgX, 1, head, { fg: THEME.ok, bg: THEME.bg, bold: true });
    c.put(msgX + textWidth(head), 1, body, { fg: THEME.bone, bg: THEME.bg });
  }

  // breadcrumb
  const row = state.rows[state.selected];
  const parts = ["SESSIONS"];
  if (row) parts.push(row.project.toUpperCase(), row.title.toUpperCase());
  let bx = 1;
  parts.forEach((p, i) => {
    if (i) bx = c.put(bx, 1, " / ", { fg: THEME.line, bg: THEME.bg });
    const last = i === parts.length - 1;
    bx = c.put(bx, 1, fitWidth(p, Math.max(4, msgX - bx - 2)), { fg: last ? THEME.bone : THEME.mute, bg: THEME.bg, bold: last });
  });
}

function footer(c, state, W, H) {
  const y = H - 1;
  c.fill(0, y, W, 1, THEME.bg, " ");
  const keys = [
    ["↑↓", "SELECT"],
    ["TAB", "VIEW"],
    ["ENTER", "REPORT", true],
    ["S", "CARD"],
    ["R", "REDACT"],
    ["A", "AGENT"],
    ["Q", "QUIT"],
  ];
  const gap = W >= 100 ? 2 : 1; // every key fits in 80 columns
  let x = 1;
  for (const [k, text, primary] of keys) {
    const need = textWidth(k) + textWidth(text) + 3;
    if (x + need > W - 1) break;
    x = c.put(x, y, ` ${k} `, primary ? { fg: THEME.bone, bg: THEME.red, bold: true } : { fg: THEME.bone, bg: THEME.line, bold: true });
    x = c.put(x + 1, y, text, { fg: THEME.mute, bg: THEME.bg }) + gap;
  }
}

function sessionList(c, state, x, y, w, h) {
  box(c, x, y, w, h, "SESSION_LIST");
  const inner = w - 4;
  const costW = 8;
  // the date shrinks before the project names do: none when very narrow, MM-DD when narrow
  const dayW = inner < 40 ? 0 : inner < 56 ? 6 : 10;
  const longest = Math.max(7, ...state.rows.map((r) => textWidth(r.project)));
  const fixed = costW + 1 + (dayW ? dayW + 1 : 0) + 1;
  const projW = Math.max(6, Math.min(longest, 16, inner - fixed - 12)); // at least 12 columns of title
  const H = { fg: THEME.gold, bg: THEME.panel };
  c.put(x + 2, y + 1, "COST".padStart(costW) + " " + (dayW ? "ACTIVE".padEnd(dayW) + " " : "") + "PROJECT".padEnd(projW).slice(0, projW) + " " + "TITLE", H, inner);
  c.put(x + 1, y + 2, "─".repeat(w - 2), { fg: THEME.line, bg: THEME.panel });
  const visible = h - 5;
  const top = Math.max(0, Math.min(state.selected - Math.floor(visible / 2), state.rows.length - visible));
  for (let i = 0; i < visible; i++) {
    const r = state.rows[top + i];
    if (!r) break;
    const sel = top + i === state.selected;
    const yy = y + 3 + i;
    const st = sel ? { fg: THEME.bg, bg: THEME.gold, bold: true } : { fg: THEME.text, bg: THEME.panel };
    c.fill(x + 1, yy, w - 2, 1, st.bg, " ");
    c.put(x + 1, yy, sel ? "▶" : " ", st);
    let cx = c.put(x + 2, yy, usd(r.cost).padStart(costW), sel ? st : { fg: THEME.bone, bg: THEME.panel, bold: true });
    if (dayW) cx = c.put(cx + 1, yy, (dayW < 10 ? (r.last || "").slice(5) : r.last || "").padEnd(dayW), sel ? st : { fg: THEME.mute, bg: THEME.panel });
    c.put(cx + 1, yy, fitWidth(r.project, projW), sel ? st : { fg: THEME.text, bg: THEME.panel }, projW);
    cx += 1 + projW; // titles stay aligned whatever the project name's length
    if (r.codex) cx = c.put(cx + 1, yy, "[codex]", sel ? st : { fg: THEME.ok, bg: THEME.panel }) - 1;
    c.put(cx + 1, yy, fitWidth(r.title, x + w - 2 - (cx + 1)), st);
  }
  // count and position in the bottom border
  const info = ` ${state.selected + 1}/${state.rows.length} `;
  if (state.rows.length) c.put(x + w - 2 - textWidth(info), y + h - 1, info, { fg: THEME.mute, bg: THEME.panel });
}

function tabs(c, state, x, y, w) {
  const names = VIEWS.map((v) => ` ${v.toUpperCase()} `);
  // separators only when every tab fits with them
  const sep = names.reduce((n, t) => n + textWidth(t) + 1, 0) <= w - 4 ? 1 : 0;
  let tx = x + 2;
  VIEWS.forEach((v, i) => {
    if (tx + textWidth(names[i]) > x + w - 2) return;
    const active = v === state.view;
    tx = c.put(tx, y, names[i], active ? { fg: THEME.bg, bg: THEME.gold, bold: true } : { fg: THEME.mute, bg: THEME.panel });
    if (sep) tx = c.put(tx, y, "─", { fg: THEME.line, bg: THEME.panel });
  });
}

function overview(c, s, state, x, y, w, h) {
  const bg = THEME.panel;
  // the selected session's rank, large and faint, top right: the "01" of the reference layout
  const rank = String(state.selected + 1).padStart(2, "0");
  let rankW = w > 60 ? bigWidth(rank) : 0;
  c.put(x, y, s.title, { fg: THEME.bone, bg, bold: true }, w);
  const meta = [(s.start || "").slice(0, 16).replace("T", " "), dur(s.durationMs), `${s.calls.length} calls`, `${s.toolCalls.length} tool calls`, s.mainModel].filter(Boolean).join(" · ");
  c.put(x, y + 1, meta, { fg: THEME.mute, bg }, w);

  // the total, in the pixel font: amounts are the star
  const total = usd(s.cost);
  const bw = bigText(c, x, y + 3, total, THEME.bone, bg);
  const sx = x + bw + 4;
  const side = [];
  if (s.officialCost != null) side.push([s.agent === "codex" ? "CODEX TOTAL" : "CLAUDE CODE'S OWN TOTAL", usd(s.officialCost)]);
  const [ref, refPrefix] = s.agent === "codex" ? ["GPT-6.1 Sol", "gpt-6.1-sol"] : ["Sonnet 5.5", "claude-sonnet"];
  const cheaper = s.whatIf?.find((v) => v.label === ref);
  if (cheaper && s.mainModel && !s.mainModel.startsWith(refPrefix)) side.push([`SAME TOKENS ON ${ref.toUpperCase()}`, usd(cheaper.cost)]);
  side.push(["TASKS", String(s.tasks.filter((t) => !t.meta || t.cost > 0).length)]);
  if (s.unknownModels?.length) side[side.length - 1] = ["! UNKNOWN PRICE", s.unknownModels.join(", "), true];
  const sideW = Math.max(...side.slice(0, 3).map(([k, v]) => textWidth(k) + 2 + textWidth(v)));
  if (sx + sideW > x + w - rankW - 2) rankW = 0; // the amounts matter more than the rank
  if (rankW) bigText(c, x + w - rankW, y + 3, rank, THEME.ghost, bg);
  const sideEnd = x + w - (rankW ? rankW + 2 : 0);
  side.slice(0, 3).forEach(([k, v, warn], i) => {
    if (sx + 20 > sideEnd) return;
    const kx = c.put(sx, y + 3 + i, k, { fg: warn ? THEME.red2 : THEME.mute, bg, bold: !!warn }, sideEnd - sx);
    c.put(kx + 2, y + 3 + i, v, { fg: warn ? THEME.red2 : THEME.gold2, bg, bold: true }, sideEnd - kx - 2);
  });

  // where the money went
  let yy = y + 7;
  label(c, x, yy++, "COST_BREAKDOWN", w);
  const partsList = [
    ["CACHE READS", s.parts.cacheRead],
    ["CACHE WRITES", s.parts.cacheWrite],
    ["OUTPUT", s.parts.output],
    ["UNCACHED INPUT", s.parts.input],
  ];
  const nameW = 15;
  const barW = Math.max(6, w - nameW - 6 - 9);
  for (const [name, v] of partsList) {
    c.put(x, yy, name, { fg: THEME.text, bg }, nameW);
    bar(c, x + nameW, yy, barW, s.cost > 0 ? v / s.cost : 0);
    c.put(x + nameW + barW + 1, yy, `${pct(v, s.cost)}%`.padStart(4), { fg: THEME.gold, bg });
    c.putRight(x + w, yy, usd(v), { fg: THEME.bone, bg });
    yy++;
  }

  const rest = y + h - (yy + 1);
  if (rest < 3) return;
  const tasks = s.tasks.filter((t) => !t.meta || t.cost > 0).sort((a, b) => b.cost - a.cost);
  const logRows = rest >= 10 ? Math.min(s.topToolCalls.length, Math.floor((rest - 2) / 2)) : 0;
  const taskRows = rest - 1 - (logRows ? logRows + 2 : 0);
  yy++;
  label(c, x, yy++, "PRICIEST_TASKS", w);
  for (const t of tasks.slice(0, taskRows)) {
    const ix = c.put(x, yy, `#${t.index}`.padEnd(6), { fg: THEME.mute, bg });
    c.put(ix, yy, t.short, { fg: THEME.text, bg }, w - (ix - x) - 10);
    c.putRight(x + w, yy, usd(t.cost), { fg: THEME.bone, bg, bold: true });
    yy++;
  }
  if (!logRows) return;
  yy = y + h - logRows - 1;
  label(c, x, yy++, "TOOL_RESULTS", w);
  for (const t of s.topToolCalls.slice(0, logRows)) {
    const tag = `[${t.name.replace(/^mcp__/, "").slice(0, 10).toUpperCase().padEnd(10)}]`;
    let lx = c.put(x, yy, tag, { fg: t.isError ? THEME.red2 : THEME.ok, bg, bold: true });
    lx = c.put(lx + 1, yy, usd(t.carry).padStart(7), { fg: THEME.bone, bg });
    lx = c.put(lx + 1, yy, `${tok(t.resultTokens)} tok ×${t.reread}`.padEnd(16), { fg: THEME.mute, bg });
    c.put(lx + 1, yy, t.summary || "", { fg: THEME.text, bg }, x + w - lx - 1);
    yy++;
  }
}

/** A scrollable table: columns are [title, width, align]; the last column with width 0 takes the rest. */
function table(c, state, x, y, w, h, cols, rows, rowStyle = () => ({})) {
  const bg = THEME.panel;
  const fixed = cols.reduce((n, col) => n + col[1] + 1, 0);
  const widths = cols.map((col) => col[1] || Math.max(4, w - fixed));
  const cells = (vals, st) => {
    let cx = x;
    vals.forEach((v, i) => {
      const cw = widths[i];
      const text = fitWidth(String(v), cw);
      if (cols[i][2] === "right") c.putRight(cx + cw, st.y, text, st[i] || st.base);
      else c.put(cx, st.y, text, st[i] || st.base, cw);
      cx += cw + 1;
    });
  };
  cells(cols.map((col) => col[0]), { y, base: { fg: THEME.gold, bg, bold: true } });
  c.put(x, y + 1, "─".repeat(w), { fg: THEME.line, bg });
  const visible = h - 3;
  const top = Math.max(0, Math.min(state.scroll, rows.length - visible));
  rows.slice(top, top + visible).forEach((vals, i) => cells(vals, { y: y + 2 + i, base: { fg: THEME.text, bg }, ...rowStyle(vals, top + i) }));
  const info = rows.length > visible ? `${top + 1}–${Math.min(rows.length, top + visible)} of ${rows.length} · PGUP/PGDN` : `${rows.length} rows`;
  c.putRight(x + w, y + h - 1, info, { fg: THEME.mute, bg });
}

function tasksView(c, s, state, x, y, w, h) {
  const tasks = s.tasks.filter((t) => !t.meta || t.cost > 0).sort((a, b) => b.cost - a.cost);
  const rows = tasks.map((t) => [`#${t.index}`, t.short, t.calls + (t.sideCalls || 0), t.toolCalls, usd(t.cost)]);
  table(c, state, x, y, w, h, [["#", 6], ["TASK", 0], ["CALLS", 6, "right"], ["TOOLS", 6, "right"], ["COST", 9, "right"]], rows, () => ({ 4: { fg: THEME.bone, bg: THEME.panel, bold: true }, 0: { fg: THEME.mute, bg: THEME.panel } }));
}

function toolsView(c, s, state, x, y, w, h) {
  const tools = Object.entries(s.byTool).sort((a, b) => b[1].carry - a[1].carry);
  const rows = tools.map(([name, t]) => [name.replace(/^mcp__/, ""), t.calls, tok(t.resultTokens), usd(t.carry), t.errors || ""]);
  table(c, state, x, y, w, h, [["TOOL", 0], ["CALLS", 6, "right"], ["RESULTS", 8, "right"], ["CARRY", 9, "right"], ["ERR", 4, "right"]], rows, (vals) => ({
    3: { fg: THEME.bone, bg: THEME.panel, bold: true },
    4: { fg: THEME.red2, bg: THEME.panel, bold: true },
  }));
}

function modelsView(c, s, state, x, y, w, h) {
  const bg = THEME.panel;
  label(c, x, y, "SAME_TOKENS_ON", w);
  c.put(x, y + 1, "The token counts of this session, priced on other models.", { fg: THEME.mute, bg }, w);
  const rows = [{ label: `ACTUAL · ${s.mainModel || "?"}`, cost: s.cost, actual: true }, ...(s.whatIf || []).map((v) => ({ label: v.label, cost: v.cost }))];
  const max = Math.max(...rows.map((r) => r.cost), 0.000001);
  const nameW = Math.min(28, Math.max(14, ...rows.map((r) => textWidth(r.label))));
  const barW = Math.max(6, w - nameW - 12);
  rows.slice(0, h - 3).forEach((r, i) => {
    const yy = y + 3 + i;
    c.put(x, yy, r.label, { fg: r.actual ? THEME.gold : THEME.text, bg, bold: r.actual }, nameW);
    bar(c, x + nameW + 1, yy, barW, r.cost / max, r.actual ? THEME.gold2 : r.cost > s.cost ? THEME.red2 : THEME.gold);
    c.putRight(x + w, yy, usd(r.cost), { fg: THEME.bone, bg, bold: r.actual });
  });
}

/** Totals across the listed sessions, as --all prints them. */
function allView(c, state, x, y, w, h) {
  const bg = THEME.panel;
  const t = state.totals || { projects: [], tasks: [] };
  c.put(x, y, "All sessions", { fg: THEME.bone, bg, bold: true }, w);
  const meta = [`${state.rows.length} session${state.rows.length === 1 ? "" : "s"}`, `${t.projects.length} project${t.projects.length === 1 ? "" : "s"}`, state.range, `agent: ${state.agent}`].filter(Boolean).join(" · ");
  c.put(x, y + 1, meta, { fg: THEME.mute, bg }, w);
  const bw = bigText(c, x, y + 3, usd(state.total), THEME.bone, bg);
  const top = t.tasks[0];
  if (top && x + bw + 30 < x + w) {
    const kx = c.put(x + bw + 4, y + 3, "PRICIEST TASK", { fg: THEME.mute, bg });
    c.put(kx + 2, y + 3, usd(top.cost), { fg: THEME.gold2, bg, bold: true });
    c.put(x + bw + 4, y + 4, top.label, { fg: THEME.text, bg }, w - bw - 4);
    c.put(x + bw + 4, y + 5, top.project, { fg: THEME.mute, bg }, w - bw - 4);
  }
  let yy = y + 7;
  label(c, x, yy++, "BY_PROJECT", w);
  const projRows = Math.min(t.projects.length, Math.max(1, Math.floor((h - 9) / 3)));
  const nameW = Math.min(20, Math.max(8, ...t.projects.slice(0, projRows).map(([p]) => textWidth(p))));
  const barW = Math.max(6, w - nameW - 16);
  for (const [p, cost] of t.projects.slice(0, projRows)) {
    c.put(x, yy, p, { fg: THEME.text, bg }, nameW);
    bar(c, x + nameW + 1, yy, barW, state.total > 0 ? cost / state.total : 0);
    c.putRight(x + w, yy, usd(cost), { fg: THEME.bone, bg, bold: true });
    yy++;
  }
  if (t.projects.length > projRows) c.put(x, yy++, `… ${t.projects.length - projRows} more`, { fg: THEME.mute, bg });
  yy++;
  if (y + h - yy < 5) return;
  label(c, x, yy++, "PRICIEST_TASKS_EVER", w);
  const selectedId = state.rows[state.selected]?.id;
  const rows = t.tasks.map((k) => [usd(k.cost), k.project, k.label, k.id.slice(0, 8)]);
  table(c, state, x, yy, w, y + h - yy, [["COST", 8, "right"], ["PROJECT", Math.min(14, Math.max(7, Math.floor(w / 6)))], ["TASK", 0], ["SESSION", 8]], rows, (vals, i) =>
    t.tasks[i].id === selectedId ? { base: { fg: THEME.gold2, bg, bold: true } } : { 0: { fg: THEME.bone, bg, bold: true }, 3: { fg: THEME.mute, bg } },
  );
}

function detailPanel(c, state, x, y, w, h) {
  box(c, x, y, w, h, null);
  tabs(c, state, x, y, w);
  const ix = x + 2;
  const iy = y + 1;
  const iw = w - 4;
  const ih = h - 2;
  if (state.view === "all") return allView(c, state, ix, iy, iw, ih);
  const d = state.detail;
  if (!d) {
    c.put(ix, iy, state.rows.length ? "LOADING RECEIPT…" : "", { fg: THEME.mute, bg: THEME.panel });
    return;
  }
  if (d.error) {
    c.put(ix, iy, `Could not read this session: ${d.error}`, { fg: THEME.red2, bg: THEME.panel }, iw);
    return;
  }
  if (state.view === "tasks") tasksView(c, d, state, ix, iy, iw, ih);
  else if (state.view === "tools") toolsView(c, d, state, ix, iy, iw, ih);
  else if (state.view === "models") modelsView(c, d, state, ix, iy, iw, ih);
  else overview(c, d, state, ix, iy, iw, ih);
}

/** The opening view while sessions load, and the empty state: pixel title, steaming cup. */
function splash(c, state, W, H) {
  const title = "CCRECEIPT";
  const tw = bigWidth(title);
  const blockW = 12 + 3 + tw;
  const x0 = Math.max(1, Math.floor((W - blockW) / 2));
  const y0 = Math.max(2, Math.floor(H / 2) - 5);
  cup(c, x0, y0, state.tick, THEME.bg);
  bigText(c, x0 + 15, y0 + 1, title, THEME.bone, THEME.bg);
  const by = y0 + 7;
  const bw = Math.min(48, W - 4);
  const bx = Math.floor((W - bw) / 2);
  if (state.loading) {
    const { done, total } = state.loading;
    c.put(bx, by, "IMPORTING SESSIONS", { fg: THEME.gold, bg: THEME.bg, bold: true });
    c.putRight(bx + bw, by, `${done}/${total}`, { fg: THEME.bone, bg: THEME.bg });
    const filled = total ? Math.round((bw * done) / total) : 0;
    c.put(bx, by + 1, "█".repeat(filled), { fg: THEME.gold, bg: THEME.bg });
    c.put(bx + filled, by + 1, "█".repeat(bw - filled), { fg: THEME.track, bg: THEME.bg });
    c.put(bx, by + 2, state.root || "", { fg: THEME.mute, bg: THEME.bg }, bw);
  } else {
    c.put(bx, by, "NO SESSIONS YET", { fg: THEME.gold, bg: THEME.bg, bold: true });
    c.put(bx, by + 1, `Nothing under ${state.root || "the sessions directory"}.`, { fg: THEME.text, bg: THEME.bg }, bw);
    c.put(bx, by + 2, "Run a session, or press A to switch agent.", { fg: THEME.mute, bg: THEME.bg }, bw);
  }
}

/** The card dialog over the dashboard: redacted or full, the default on Enter. */
function askDialog(c, state, W, H) {
  const ask = state.ask;
  const w = Math.min(64, W - 4);
  const h = 10;
  const x = Math.floor((W - w) / 2);
  const y = Math.max(3, Math.floor((H - h) / 2));
  box(c, x, y, w, h, "SHARE_CARD");
  const bg = THEME.panel;
  c.put(x + 3, y + 2, ask.target === "all" ? "Card of every listed session (the ALL tab)." : "Card of the selected session.", { fg: THEME.bone, bg, bold: true }, w - 6);
  const choices = [
    [ask.redacted ? "ENTER R" : "R", "REDACTED", "no prompt, title, path or project name", ask.redacted],
    [ask.redacted ? "F" : "ENTER F", "FULL", "prompts, titles and names as they are", !ask.redacted],
    ["ESC", "CANCEL", "", false],
  ];
  choices.forEach(([k, name, hint, def], i) => {
    const yy = y + 4 + i;
    const kx = c.put(x + 3, yy, ` ${k} `, def ? { fg: THEME.bone, bg: THEME.red, bold: true } : { fg: THEME.bone, bg: THEME.line, bold: true });
    const nx = c.put(Math.max(kx + 1, x + 13), yy, name, { fg: def ? THEME.gold2 : THEME.text, bg, bold: true });
    c.put(Math.max(nx + 1, x + 23), yy, hint, { fg: THEME.mute, bg }, x + w - 3 - Math.max(nx + 1, x + 23));
  });
  c.put(x + 3, y + 8, "The image opens in a preview once written.", { fg: THEME.mute, bg }, w - 6);
}

/**
 * state: { version, agent, root, redact, loading: {done,total}|null, rows: [{cost,last,project,title,id,codex}],
 *          total, selected, detail: session|{error}|null, view, scroll, tick, message }
 */
export function renderDashboard(state, W, H) {
  const c = new Canvas(W, H, THEME.bg);
  if (W < MIN_COLS || H < MIN_ROWS) {
    const lines = ["TERMINAL TOO SMALL", `${MIN_COLS} × ${MIN_ROWS} minimum, now ${W} × ${H}`, "Q to quit"];
    lines.forEach((l, i) => c.put(Math.max(0, Math.floor((W - textWidth(l)) / 2)), Math.floor(H / 2) - 1 + i, fitWidth(l, W), { fg: i ? THEME.mute : THEME.gold, bg: THEME.bg, bold: !i }));
    return c;
  }
  header(c, state, W);
  c.put(0, 2, "─".repeat(W), { fg: THEME.line, bg: THEME.bg });
  if (state.loading || !state.rows.length) splash(c, state, W, H);
  else {
    const top = 3;
    const h = H - top - 1;
    const leftW = W < 100 ? 36 : Math.max(44, Math.min(70, Math.floor(W * 0.45)));
    sessionList(c, state, 0, top, leftW, h);
    detailPanel(c, state, leftW, top, W - leftW, h);
  }
  if (state.ask) askDialog(c, state, W, H);
  footer(c, state, W, H);
  return c;
}
