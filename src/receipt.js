// The receipt as a list of rows, rendered by the terminal (receiptText) and as an image (receiptSvg).
import { usd, pad, trunc, dur } from "./format.js";

export const WIDTH = 62; // characters per row

/**
 * @param {object} s a parsed session
 * @returns {Array<{rule: true} | {left: string, right: string, total?: boolean, bar?: number}>}
 *   bar: a share from 0 to 1, drawn as a bar in the image only
 */
export function receiptRows(s) {
  const rows = [];
  const rule = () => rows.push({ rule: true });
  const line = (left, right = "", extra = {}) => rows.push({ left, right, ...extra });
  const realTasks = s.tasks.filter((t) => !t.meta || t.cost > 0);
  rule();
  line("RECEIPT · " + s.title.toUpperCase());
  line(`${(s.start || "").slice(0, 16).replace("T", " ")} · ${dur(s.durationMs)} · ${s.calls.length} calls · ${s.toolCalls.length} tool calls`);
  rule();
  for (const t of realTasks.slice().sort((a, b) => b.cost - a.cost).slice(0, 12)) line(`#${t.index} ${t.short}`, pad(usd(t.cost), 8));
  if (realTasks.length > 12) line(`… ${realTasks.length - 12} more tasks`);
  rule();
  const share = (v) => ({ bar: s.cost > 0 ? v / s.cost : 0 });
  line("Re-reading context (cache reads)", pad(usd(s.parts.cacheRead), 8), share(s.parts.cacheRead));
  line("Writing context to cache", pad(usd(s.parts.cacheWrite), 8), share(s.parts.cacheWrite));
  line("Model output", pad(usd(s.parts.output), 8), share(s.parts.output));
  line("Uncached input", pad(usd(s.parts.input), 8), share(s.parts.input));
  rule();
  line("TOTAL", pad(usd(s.cost), 8), { total: true });
  if (s.officialCost != null) line("(Claude Code's own total)", pad(usd(s.officialCost), 8));
  rule();
  const top = s.topToolCalls[0];
  if (top) line(`Priciest tool result: ${top.name.replace(/^mcp__/, "")} ${top.summary}`.trim(), pad(usd(top.carry), 8));
  if (top) line(`  ${top.resultTokens} tokens, re-read ${top.reread}×`);
  // a cheaper model of the same vendor, for scale
  const [ref, refPrefix] = s.agent === "codex" ? ["GPT-6.1 Sol", "gpt-6.1-sol"] : ["Sonnet 5.5", "claude-sonnet"];
  const cheaper = s.whatIf.find((w) => w.label === ref);
  if (cheaper && s.mainModel && !s.mainModel.startsWith(refPrefix)) line(`Same tokens on ${ref}`, pad(usd(cheaper.cost), 8));
  if (s.unknownModels.length) line(`! unknown price for ${s.unknownModels.join(", ")} (counted $0)`);
  return rows;
}

/**
 * The all-sessions receipt, from summarize(): spend by project, priciest tasks ever, total.
 * @param {ReturnType<import("./summary.js").summarize>} sum
 * @param {{ range?: string }} [opts] e.g. "since 2026-10-01"
 */
export function allReceiptRows(sum, { range = "" } = {}) {
  const rows = [];
  const rule = () => rows.push({ rule: true });
  const line = (left, right = "", extra = {}) => rows.push({ left, right, ...extra });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  rule();
  line("RECEIPT · ALL SESSIONS");
  line([plural(sum.count, "session"), plural(sum.projects.length, "project"), range].filter(Boolean).join(" · "));
  rule();
  line("By project");
  for (const [p, c] of sum.projects.slice(0, 6)) line(`  ${p}`, pad(usd(c), 8), { bar: sum.total > 0 ? c / sum.total : 0 });
  if (sum.projects.length > 6) line(`  … ${plural(sum.projects.length - 6, "more project")}`);
  rule();
  line("Priciest tasks");
  for (const t of sum.tasks.slice(0, 8)) line(`  #${t.index} ${t.label} · ${t.project}`, pad(usd(t.cost), 8));
  rule();
  line("TOTAL", pad(usd(sum.total), 8), { total: true });
  if (sum.count > 1) line("Average per session", pad(usd(sum.total / sum.count), 8));
  return rows;
}

const fit = (row) => trunc(row.left, WIDTH - row.right.length - 1) + " " + row.right;

/** The receipt as printed in the terminal, one string per line, with its two-space margin. */
export function receiptText(rows) {
  return rows.map((r) => "  " + (r.rule ? "─".repeat(WIDTH) : fit(r)));
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/**
 * The receipt as a standalone SVG image, 1200 px wide, in the product's colours.
 * Text is monospaced and laid out on the same 62-column grid as the terminal.
 */
export function receiptSvg(rows, { footer = "npx ccreceipt-cli" } = {}) {
  const W = 1200;
  const font = 24;
  const charW = font * 0.6; // monospace advance
  const lh = Math.round(font * 1.5);
  const textW = WIDTH * charW;
  const x0 = Math.round((W - textW) / 2);
  const x1 = Math.round(x0 + textW);
  const top = 96;
  const H = top + rows.length * lh + 120;
  const C = { bg: "#040b15", panel: "#06111d", line: "#284c4a", text: "#f3e6c9", mute: "#8aa19e", gold: "#d4a556", track: "#132a33" };
  // consecutive bar rows share a start column, after their longest label
  const barFrom = rows.map(() => 0);
  for (let i = 0; i < rows.length; ) {
    if (rows[i].bar == null) {
      i++;
      continue;
    }
    let j = i;
    let longest = 0;
    while (j < rows.length && rows[j].bar != null) longest = Math.max(longest, trunc(rows[j++].left, WIDTH - 9).trimEnd().length);
    for (let k = i; k < j; k++) barFrom[k] = Math.max(longest + 2, 24);
    i = j;
  }
  const out = [];
  let y = top;
  rows.forEach((r, ri) => {
    if (r.rule) {
      out.push(`<line x1="${x0}" y1="${y - lh / 2 + 4}" x2="${x1}" y2="${y - lh / 2 + 4}" stroke="${C.line}" stroke-width="2"/>`);
    } else {
      // leading spaces as no-break spaces: SVG viewers collapse ordinary ones
      const left = trunc(r.left, WIDTH - r.right.length - 1).trimEnd().replace(/^ +/, (m) => "\u00a0".repeat(m.length));
      if (r.bar != null) {
        // the dashboard's bar: gold share on a dim track, between the label and the amount
        const from = barFrom[ri];
        const to = WIDTH - 10;
        if (to - from >= 6) {
          const bx = x0 + from * charW;
          const bw = (to - from) * charW;
          const bh = Math.round(font * 0.6);
          const by = y - Math.round(font * 0.66);
          const fill = Math.round(bw * Math.max(0, Math.min(1, r.bar)));
          out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${C.track}"/>`);
          if (fill > 0) out.push(`<rect x="${bx}" y="${by}" width="${fill}" height="${bh}" fill="${C.gold}"/>`);
        }
      }
      const weight = r.total ? ' font-weight="700"' : "";
      out.push(`<text x="${x0}" y="${y}" fill="${r.total ? C.gold : C.text}"${weight}>${xml(left)}</text>`);
      if (r.right) out.push(`<text x="${x1}" y="${y}" fill="${C.gold}" text-anchor="end"${weight}>${xml(r.right.trim())}</text>`);
    }
    y += lh;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="${x0 - 40}" y="40" width="${textW + 80}" height="${H - 80}" fill="${C.panel}" stroke="${C.line}" stroke-width="2"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${font}">
${out.join("\n")}
<text x="${x0}" y="${H - 66}" fill="${C.mute}" font-size="${Math.round(font * 0.75)}">ccreceipt</text>
<text x="${x1}" y="${H - 66}" fill="${C.mute}" font-size="${Math.round(font * 0.75)}" text-anchor="end">${xml(footer)}</text>
</g>
</svg>
`;
}
