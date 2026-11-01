# ccreceipt

**The itemized receipt for your Claude Code sessions.** What each task cost, which tool result you paid for 587 times, and what the same tokens would cost on another model. Local, zero dependencies, nothing leaves your machine.

```
npx ccreceipt   # or: bunx ccreceipt
```

```
  ──────────────────────────────────────────────────────────────
  RECEIPT · MERGE THE PRS INTO V1.01
  2026-10-23 00:51 · 89h50 · 3846 calls · 4753 tool calls
  ──────────────────────────────────────────────────────────────
  #161 also redo the visuals in English …                 $76.80
  #8 ok, before archiving I want …                        $60.89
  #84 for maplibre it's because we had talked about …     $25.24
  #79 do this: <pasted_content> 24 The cache …            $16.59
  … 211 more tasks
  ──────────────────────────────────────────────────────────────
  Re-reading context (cache reads)                          $322
  Writing context to cache                                  $142
  Model output                                            $69.63
  Uncached input                                           $0.09
  ──────────────────────────────────────────────────────────────
  TOTAL                                                     $534
  (Claude Code's own total)                                 $536
  ──────────────────────────────────────────────────────────────
  Priciest tool result: visualize__read_me                 $0.73
    5445 tokens, re-read 587×
  Same tokens on Sonnet 5.5                                 $404
```

It then opens a single-file HTML report with the per-task receipt, the most expensive tool results, a per-tool table, the "same tokens, other model" table, and a scrubber to replay the session call by call with the running total.

## Why

`ccusage` tells you what you spent per day. `claude-replay` shows you what happened. Neither tells you **where** the money went inside a session: which prompt, which tool call, which 40 KB file you `cat`-ed in minute 3 and then paid to re-read on every one of the next 500 API calls. The receipt does.

Three numbers you cannot get elsewhere:

- **Cost per task.** Every prompt you typed, with everything it triggered (tool calls, sub-agents) priced and attributed to it.
- **Carrying cost of a tool result.** A result costs its tokens once to write to the cache, then its tokens × cache-read price on every later API call in the same context. Big *and* early is the expensive kind.
- **Same tokens, other model.** The identical token counts re-priced on Haiku 5.5, Sonnet 5.5, Opus 5.5, Opus 5 and Fable 5.1, so you can size the gap before switching.

## Usage

```
ccreceipt                 receipt for the most recent session (opens the HTML report)
ccreceipt <id-or-path>    a specific session: id, id prefix, or path to the .jsonl
ccreceipt --list          the last 20 sessions with their cost
ccreceipt --all           totals across every session on this machine, and your most expensive tasks ever

--out <file.html>   where to write the report (default: a temp file)
--json              the receipt as JSON
--no-open           do not open the browser
--limit <n>         rows for --list / --all
--dir <path>        sessions directory (default ~/.claude/projects)
--pricing <file>    JSON price overrides, USD per million tokens:
                    {"claude-opus-5-5": {"in": 4, "out": 20, "cr": 0.2}}
```

Requires Node 18+. Reads `~/.claude/projects/*/<session>.jsonl` and the `<session>/subagents/` transcripts next to it. No network, no telemetry, no account.

## How the numbers are computed

- One API call = one assistant message id. Claude Code writes a message's content blocks as several lines that repeat the same `usage`; they are counted once.
- Cost = `input × in + cache writes × (1.25 × in for 5-minute entries, 2 × in for 1-hour entries) + cache reads × cr + output × out`, at Anthropic list prices (see `src/pricing.js`, checked 2026-10-30). Fast mode (`usage.speed: "fast"`) is billed at 2×.
- A task is everything between one of your prompts and the next. Sub-agent transcripts are attributed to the task that launched them (via the Agent tool call id in `agent-*.meta.json`).
- Tool result sizes are estimated at 4 characters per token (1,500 tokens per image). The carrying cost is an estimate built on that; the per-call totals are not estimates, they are the API's own `usage` figures.
- A compaction (`isCompactSummary`) empties the context: results before it stop being re-read.

**Accuracy.** Compared with the `cost-state` total Claude Code itself writes at the end of a session, on 41 sessions from one machine: 30 are within 2 %, the rest are 5 to 17 % *under*. The missing part is output Claude Code bills but does not write to disk: the Haiku model behind web search, and interrupted or retried responses. If you are on a Max/Pro plan, the dollars are what the same session would cost on the API, not what you paid.

## What it is not

Not a daily dashboard (use [ccusage](https://github.com/ccusage/ccusage)). Not a shareable video-like replay (use [claude-replay](https://github.com/es617/claude-replay)). Not a proxy (nothing to install in your shell, nothing to intercept). It reads files that are already on your disk and prints a receipt.

## Roadmap

The free CLI stays free and gets the file formats of other agents (Codex, Cursor) if people ask. A paid Mac app on top of it, **ccreceipt Pro**, is in pre-order: live meter in the menu bar while a session runs, diff two sessions, one receipt across all sessions with per-project budgets and alerts, export for expense reports. Details and pre-order on the product page.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

Forks and derived works must keep the `LICENSE` and `NOTICE` files. The name "ccreceipt" and its logo are trademarks and are not covered by the license: if you publish a fork, give it another name. See `TRADEMARKS.md`.
