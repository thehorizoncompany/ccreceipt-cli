// A grid of terminal cells for the dashboard (--tui): text with colours, drawn once per frame
// and written in a single burst. Wide characters (CJK, emoji) take two cells, so every row
// is exactly as wide as the terminal.

/** Columns taken by one code point: 0 (combining, zero-width), 1, or 2 (wide). */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/\p{M}/u.test(ch) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && /\p{Extended_Pictographic}/u.test(ch)) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** One line of plain text: control characters and line breaks become spaces. */
export const clean = (s) => String(s ?? "").normalize("NFC").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function textWidth(s) {
  let w = 0;
  for (const ch of clean(s)) w += charWidth(ch);
  return w;
}

/** Cuts `s` to at most `w` columns, ending with "…" when something was cut. */
export function fitWidth(s, w) {
  s = clean(s);
  if (w <= 0) return "";
  if (textWidth(s) <= w) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** The nearest xterm 256-colour index for a #rrggbb colour. */
export function to256(color) {
  const [r, g, b] = hex(color);
  const steps = [0, 95, 135, 175, 215, 255];
  const near = (v) => steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeErr = (steps[ri] - r) ** 2 + (steps[gi] - g) ** 2 + (steps[bi] - b) ** 2;
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const greyErr = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyErr < cubeErr ? 232 + grey : cube;
}

/** "truecolor", "256" or "none", from the environment. */
export function colorMode(env = process.env) {
  if (env.NO_COLOR) return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (/^(iTerm\.app|WezTerm|ghostty|vscode)$/.test(env.TERM_PROGRAM || "")) return "truecolor";
  if (env.WT_SESSION) return "truecolor"; // Windows Terminal
  return "256";
}

export class Canvas {
  constructor(width, height, bg = null) {
    this.w = width;
    this.h = height;
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " ", fg: null, bg, bold: false })));
  }

  /** Paints the background of a rectangle, keeping its characters. */
  fill(x, y, w, h, bg, ch = null) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const c = this.cells[j][i];
        c.bg = bg;
        if (ch != null) Object.assign(c, { ch, fg: null, bold: false });
      }
  }

  /**
   * Writes `text` at (x, y), clipped at `max` columns (default: to the right edge).
   * style: { fg, bg, bold }; a missing bg keeps the background already there.
   * Returns the column after the text.
   */
  put(x, y, text, style = {}, max = Infinity) {
    if (y < 0 || y >= this.h) return x;
    const end = Math.min(this.w, x + max);
    for (const ch of clean(text)) {
      const cw = charWidth(ch);
      if (cw === 0) continue;
      if (x + cw > end) break;
      if (x >= 0) {
        const cell = this.cells[y][x];
        cell.ch = ch;
        cell.fg = style.fg ?? null;
        cell.bold = !!style.bold;
        if (style.bg !== undefined) cell.bg = style.bg;
        if (cw === 2) {
          const next = this.cells[y][x + 1];
          next.ch = "";
          if (style.bg !== undefined) next.bg = style.bg;
        }
      }
      x += cw;
    }
    return x;
  }

  /** Writes `text` so that it ends at column `right` (exclusive). */
  putRight(right, y, text, style = {}) {
    return this.put(right - textWidth(text), y, text, style);
  }

  /** The rows as plain text, for tests. */
  toText() {
    return this.cells.map((row) => row.map((c) => c.ch).join(""));
  }

  /** The whole frame as escape sequences: each row positioned, colours only where they change. */
  toAnsi(mode = "truecolor") {
    const fgCode = (c) => (mode === "truecolor" ? `38;2;${hex(c).join(";")}` : `38;5;${to256(c)}`);
    const bgCode = (c) => (mode === "truecolor" ? `48;2;${hex(c).join(";")}` : `48;5;${to256(c)}`);
    let out = "";
    for (let y = 0; y < this.h; y++) {
      out += `\x1b[${y + 1};1H`;
      let prev = null;
      // the bottom-right cell is left alone: writing it can scroll some terminals
      const last = y === this.h - 1 ? this.w - 1 : this.w;
      for (let x = 0; x < last; x++) {
        const c = this.cells[y][x];
        if (c.ch === "") continue;
        const key = mode === "none" ? `${c.bold}` : `${c.fg}|${c.bg}|${c.bold}`;
        if (key !== prev) {
          const codes = ["0"];
          if (c.bold) codes.push("1");
          if (mode !== "none" && c.fg) codes.push(fgCode(c.fg));
          if (mode !== "none" && c.bg) codes.push(bgCode(c.bg));
          out += `\x1b[${codes.join(";")}m`;
          prev = key;
        }
        out += c.ch;
      }
      out += "\x1b[0m";
    }
    return out;
  }
}
