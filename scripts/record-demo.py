#!/usr/bin/env python3
"""Records docs/demo.gif: the terminal dashboard browsing the invented history of scripts/build-demo.mjs.

Dev tooling, not shipped in the npm package. Needs Python 3 with Pillow, ffmpeg, Node, and a Unix pty
(macOS or Linux). Nothing from your own history is read: HOME points at the demo folder.

Run: python3 scripts/record-demo.py [out.gif]
"""
import os, pty, sys, time, fcntl, termios, struct, select, re, subprocess, tempfile, shutil
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "demo.gif"))
COLS, ROWS = 108, 30
FONT_SIZE = 15
BG, BAR, MUTE, BONE, SAGE = "#040b15", "#0b1a26", "#8aa19e", "#f3e6c9", "#8fb996"

# what the viewer sees: (seconds to wait before, keys)
SCRIPT = [
    (2.4, "j"), (0.6, "j"), (0.6, "j"), (1.6, "\t"), (2.0, "\t"), (2.0, "\t"), (2.2, "\t"),
    (2.8, "s"), (1.8, "\r"), (2.6, "r"), (2.6, "q"),
]


def record(home):
    """Runs the CLI in a pseudo-terminal, sends SCRIPT, returns [(time, bytes)]."""
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "LC_ALL")}
    env.update(HOME=home, TMPDIR="/tmp", TERM="xterm-256color", COLORTERM="truecolor", NO_UPDATE_NOTIFIER="1")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execvpe("node", ["node", "bin/ccreceipt.js", "--no-open"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    start = time.time()
    chunks = []

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.02)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                chunks.append((time.time() - start, data))

    for wait, keys in SCRIPT:
        pump(wait)
        os.write(fd, keys.encode())
    pump(1.0)
    os.waitpid(pid, 0)
    return chunks


SGR = re.compile(rb"\x1b\[([0-9;?]*)([A-Za-z])")


def frames_from(chunks):
    """Replays the escape sequences on a grid; one snapshot per drawn frame: [(time, grid)]."""
    blank = (" ", None, None, False)
    grid = [[blank] * COLS for _ in range(ROWS)]
    x = y = 0
    fg = bg = None
    bold = False
    frames = []
    data = b"".join(c for _, c in chunks)
    # time of each byte offset, to date the frames
    marks, offset = [], 0
    for t, c in chunks:
        offset += len(c)
        marks.append((offset, t))
    i = 0
    text = data
    while i < len(text):
        if text[i] == 0x1B:
            m = SGR.match(text, i)
            if m:
                params, cmd = m.group(1).decode(), m.group(2).decode()
                i = m.end()
                if cmd == "H":
                    parts = [int(p) if p else 1 for p in params.split(";")] if params else [1, 1]
                    y, x = parts[0] - 1, (parts[1] if len(parts) > 1 else 1) - 1
                elif cmd == "J":
                    grid = [[blank] * COLS for _ in range(ROWS)]
                elif cmd == "m":
                    p = [int(v) for v in params.split(";") if v != ""] or [0]
                    k = 0
                    while k < len(p):
                        if p[k] == 0:
                            fg = bg = None
                            bold = False
                        elif p[k] == 1:
                            bold = True
                        elif p[k] in (38, 48) and k + 4 < len(p) and p[k + 1] == 2:
                            col = "#%02x%02x%02x" % (p[k + 2], p[k + 3], p[k + 4])
                            if p[k] == 38:
                                fg = col
                            else:
                                bg = col
                            k += 4
                        k += 1
                elif cmd == "l" and params == "?2026":
                    t = next((t for o, t in marks if o >= i), marks[-1][1])
                    frames.append((t, [row[:] for row in grid]))
                continue
            i += 1
            continue
        # one UTF-8 character
        n = 1 if text[i] < 0x80 else 2 if text[i] < 0xE0 else 3 if text[i] < 0xF0 else 4
        ch = text[i:i + n].decode("utf-8", "replace")
        i += n
        if 0 <= y < ROWS and 0 <= x < COLS:
            grid[y][x] = (ch, fg, bg, bold)
        x += 1
    return frames


class Painter:
    def __init__(self):
        menlo = "/System/Library/Fonts/Menlo.ttc"
        path = menlo if os.path.exists(menlo) else "DejaVuSansMono.ttf"
        self.font = ImageFont.truetype(path, FONT_SIZE, index=0)
        self.bold = ImageFont.truetype(path, FONT_SIZE, index=1) if path == menlo else ImageFont.truetype("DejaVuSansMono-Bold.ttf", FONT_SIZE)
        self.cw = round(self.font.getlength("M"))
        self.ch = round(FONT_SIZE * 1.3)
        self.pad, self.bar = 18, 30
        self.w = COLS * self.cw + 2 * self.pad
        self.h = ROWS * self.ch + 2 * self.pad + self.bar

    def window(self):
        img = Image.new("RGB", (self.w, self.h), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, self.w, self.bar], fill=BAR)
        for k, col in enumerate(("#ff5f57", "#febc2e", "#28c840")):
            cx = 18 + k * 20
            d.ellipse([cx - 6, self.bar // 2 - 6, cx + 6, self.bar // 2 + 6], fill=col)
        title = "ccreceipt — demo data"
        d.text(((self.w - self.font.getlength(title)) / 2, (self.bar - FONT_SIZE) / 2 - 1), title, font=self.font, fill=MUTE)
        return img, d

    def cell(self, d, cx, cy, ch, fg, bg, bold):
        x0, y0 = self.pad + cx * self.cw, self.bar + self.pad + cy * self.ch
        x1, y1 = x0 + self.cw, y0 + self.ch
        if bg:
            d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=bg)
        if ch in (" ", ""):
            return
        fg = fg or BONE
        mid_y, mid_x = y0 + self.ch // 2, x0 + self.cw // 2
        # blocks and box drawing are drawn, not typed: no gaps between cells
        if ch == "█":
            d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=fg)
        elif ch == "▀":
            d.rectangle([x0, y0, x1 - 1, mid_y - 1], fill=fg)
        elif ch == "▄":
            d.rectangle([x0, mid_y, x1 - 1, y1 - 1], fill=fg)
        elif ch in "─┌┐└┘│":
            if ch in "─┌└":
                d.line([mid_x if ch != "─" else x0, mid_y, x1, mid_y], fill=fg)
            if ch in "─┐┘":
                d.line([x0, mid_y, mid_x if ch != "─" else x1, mid_y], fill=fg)
            if ch in "│┌┐":
                d.line([mid_x, mid_y if ch != "│" else y0, mid_x, y1], fill=fg)
            if ch in "│└┘":
                d.line([mid_x, y0, mid_x, mid_y if ch != "│" else y1], fill=fg)
        else:
            d.text((x0, y0 + (self.ch - FONT_SIZE) / 2 - 1), ch, font=self.bold if bold else self.font, fill=fg)

    def grid(self, grid):
        img, d = self.window()
        for cy, row in enumerate(grid):
            for cx, (ch, fg, bg, bold) in enumerate(row):
                self.cell(d, cx, cy, ch, fg, bg, bold)
        return img

    def prompt(self, typed, cursor):
        """A shell prompt typing the command, before the dashboard opens."""
        img, d = self.window()
        parts = [("~/projects ", SAGE), ("$ ", MUTE), (typed, BONE)]
        cx = 0
        for text, col in parts:
            for ch in text:
                self.cell(d, cx, 0, ch, col, None, col == BONE)
                cx += 1
        if cursor:
            self.cell(d, cx, 0, "█", BONE, None, False)
        return img


def main():
    for tool in ("node", "ffmpeg"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is needed")
    work = tempfile.mkdtemp(prefix="ccreceipt-demo-")
    home = os.path.join(work, "home")
    subprocess.run(["node", os.path.join(ROOT, "scripts", "build-demo.mjs"), home], check=True, stdout=subprocess.DEVNULL)
    frames = frames_from(record(home))
    painter = Painter()

    # (image, seconds): the typed command, then every drawn frame for as long as it stayed on screen
    shots = []
    command = "npx ccreceipt-cli"
    shots.append((painter.prompt("", True), 0.6))
    for k in range(1, len(command) + 1):
        shots.append((painter.prompt(command[:k], True), 0.06))
    shots.append((painter.prompt(command, False), 0.5))
    last = None
    for n, (t, grid) in enumerate(frames):
        nxt = frames[n + 1][0] if n + 1 < len(frames) else t + 1.5
        loading = any("IMPORTING SESSIONS" in "".join(c[0] for c in row) for row in grid)
        dur = max(nxt - t, 0.9 if loading else 0.0)  # let the opening view be seen
        key = tuple(tuple(r) for r in grid)
        if key == last:
            img, prev = shots[-1]
            shots[-1] = (img, prev + dur)
            continue
        last = key
        shots.append((painter.grid(grid), dur))
    shots = [(img, d) for img, d in shots if d >= 0.02]

    listing = os.path.join(work, "frames.txt")
    with open(listing, "w") as f:
        for n, (img, dur) in enumerate(shots):
            path = os.path.join(work, f"f{n:04d}.png")
            img.save(path)
            f.write(f"file '{path}'\nduration {dur:.3f}\n")
        f.write(f"file '{path}'\n")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listing,
         "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none",
         "-loop", "0", OUT],
        check=True,
    )
    shutil.rmtree(work)
    print(f"{OUT}: {len(shots)} frames, {sum(d for _, d in shots):.1f} s, {os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
