import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { basename, join, dirname, extname } from "node:path";
import { costOfUsage, costParts, priceFor, WHATIF } from "./pricing.js";

const SYS_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CMD_RE = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const IMAGE_TOKENS = 1500;
const REPLY_KEEP = 400; // characters of each assistant reply kept for the HTML replay
const DELEGATED_RE = /^(Task|Background) \(from the session that started this one\)/;

export function estimateTokens(content) {
  // Rough: 1 token per 4 characters of text; a fixed 1500 for an image.
  if (content == null) return 0;
  if (typeof content === "string") return /^\[Image: source:/.test(content) ? IMAGE_TOKENS : Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) {
      if (!b) continue;
      if (b.type === "image") n += IMAGE_TOKENS;
      else if (typeof b.text === "string") n += estimateTokens(b.text);
      else n += Math.ceil(JSON.stringify(b).length / 4);
    }
    return n;
  }
  return Math.ceil(JSON.stringify(content).length / 4);
}

function promptText(content) {
  let t = "";
  if (typeof content === "string") t = content;
  else if (Array.isArray(content)) t = content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return t.replace(SYS_RE, "").replace(CMD_RE, "").trim();
}

// Short label of a prompt: pasted blocks become "[pasted text]", whitespace is collapsed.
// Claude Code wraps pasted text in <pasted_content id="…">; the closing tag is often missing.
const PASTED_CLOSED_RE = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g;
const PASTED_OPEN_RE = /<pasted_content\b[^>]*>[\s\S]*$/;
export function shortLabel(text) {
  return text.replace(PASTED_CLOSED_RE, "[pasted text]").replace(PASTED_OPEN_RE, "[pasted text]").replace(/\s+/g, " ").trim().slice(0, 160);
}

function toolSummary(input) {
  if (!input || typeof input !== "object") return "";
  const s = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? "";
  return String(s).replace(/\s+/g, " ").slice(0, 140);
}

// Extension of the file a tool call touched, kept by --redact instead of the full path.
function toolExt(input) {
  if (!input || typeof input !== "object") return "";
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return typeof p === "string" ? extname(p) : "";
}

// Yields one parsed record per line, reading the file 1 MB at a time: memory stays flat on huge transcripts.
// Synchronous on purpose (works the same under Node and Bun, keeps parseSession synchronous).
const CHUNK = 1 << 20;
function* readLines(file) {
  const fd = openSync(file, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  const decoder = new StringDecoder("utf8"); // never splits a multi-byte character across chunks
  let rest = "";
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined; // partial or corrupt line
    }
  };
  try {
    let n;
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const lines = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const d = parse(line);
        if (d !== undefined) yield d;
      }
    }
    rest += decoder.end();
    if (rest) {
      const d = parse(rest);
      if (d !== undefined) yield d;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse one Claude Code session (.jsonl, plus its <id>/subagents/*.jsonl) into a receipt model.
 * @param {string} file path to the .jsonl
 * @param {{pricing?: object, light?: boolean}} opts
 */
export function parseSession(file, opts = {}) {
  const s = {
    file,
    id: basename(file, ".jsonl"),
    title: null,
    cwd: null,
    branch: null,
    version: null,
    start: null,
    end: null,
    officialCost: null, // Claude Code's own total, when the file ends with a cost-state line
    models: {},
    calls: [], // one per API response (deduped by message id)
    tasks: [], // one per human prompt
    toolCalls: [], // one per tool_use block
    agents: [], // sub-agent transcripts found next to the session
    prs: [],
    unknownModels: new Set(),
    compactions: 0,
  };
  const seenMsg = new Set();
  const toolById = new Map();
  let task = null;
  let lastModel = null;
  let callsAtCostState = -1;

  const newTask = (text, ts, meta) => {
    task = {
      index: s.tasks.length + 1,
      prompt: text,
      short: shortLabel(text),
      start: ts,
      end: ts,
      cost: 0,
      calls: 0,
      sideCalls: 0,
      sideCost: 0,
      tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      tools: {},
      toolCalls: 0,
      meta: !!meta,
    };
    s.tasks.push(task);
    return task;
  };
  const taskAt = (ts) => {
    let best = s.tasks[0];
    for (const t of s.tasks) if (!t.meta && t.start && ts && t.start <= ts) best = t;
    return best;
  };

  // ctx: { side, agentId, open: [], fixedTask }
  function ingest(records, ctx) {
    for (const d of records) {
      const t = d.type;
      if (d.cwd && !s.cwd) s.cwd = d.cwd;
      if (d.gitBranch && !s.branch) s.branch = d.gitBranch;
      if (d.version) s.version = d.version;
      if (t === "custom-title" && d.customTitle) s.title = d.customTitle;
      if (t === "summary" && d.summary && !s.title) s.title = d.summary;
      if (t === "cost-state" && typeof d.totalCostUSD === "number") {
        s.officialCost = d.totalCostUSD;
        callsAtCostState = s.calls.length;
      }
      if (t === "pr-link" && d.prUrl && !s.prs.includes(d.prUrl)) s.prs.push(d.prUrl);
      if (d.timestamp && (t === "user" || t === "assistant")) {
        if (!s.start || d.timestamp < s.start) s.start = d.timestamp;
        if (!s.end || d.timestamp > s.end) s.end = d.timestamp;
      }
      const m = d.message;
      if (!m) continue;
      const side = ctx.side || !!d.isSidechain;
      const cur = ctx.fixedTask || (side ? taskAt(d.timestamp) : task);

      if (t === "user") {
        const c = m.content;
        if (d.isCompactSummary) {
          s.compactions++;
          ctx.open = []; // everything before the compaction leaves the context
          continue;
        }
        const results = Array.isArray(c) ? c.filter((b) => b && b.type === "tool_result") : [];
        if (results.length) {
          for (const r of results) {
            const tc = toolById.get(r.tool_use_id);
            if (!tc) continue;
            tc.resultTokens = estimateTokens(r.content);
            tc.isError = !!r.is_error;
            ctx.open.push(tc);
          }
          continue;
        }
        if (side) continue; // sub-agent prompts are not the user's tasks
        const text = promptText(c);
        if (!text || d.isMeta || /^\[Request interrupted/.test(text)) continue;
        const auto = text.match(/^<(task-notification|side-sessions-event|ci-monitor-event|artifact-[a-z-]+)>/);
        const t = newTask(text, d.timestamp, false);
        if (auto) {
          // a task notification carries a readable <summary>; other events fall back to their text without tags
          const summary = auto[1] === "task-notification" && text.match(/<summary>([\s\S]*?)<\/summary>/);
          const detail = summary ? summary[1] : text.replace(/<[^>]+>/g, " ");
          t.short = "[automatic: " + auto[1] + "] " + detail.replace(/\s+/g, " ").trim().slice(0, 120);
        }
        continue;
      }

      if (t !== "assistant") continue;
      const content = Array.isArray(m.content) ? m.content : [];
      const model = m.model && m.model !== "<synthetic>" ? m.model : null;
      if (model) lastModel = model;
      if (!task) newTask("(session start)", d.timestamp, true);
      const tk = ctx.fixedTask || (side ? taskAt(d.timestamp) : task);
      let call = null;
      if (m.id && !seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        const usage = m.usage || {};
        const cost = model ? costOfUsage(usage, model, opts.pricing) : 0;
        const parts = model ? costParts(usage, model, opts.pricing) : null;
        if (model && cost == null) s.unknownModels.add(model);
        const cc = usage.cache_creation || {};
        call = {
          i: s.calls.length,
          id: m.id,
          ts: d.timestamp,
          model,
          side,
          agent: ctx.agentId || null,
          task: tk.index,
          cost: cost || 0,
          parts: parts || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
          tokens: {
            input: usage.input_tokens || 0,
            cacheWrite: usage.cache_creation_input_tokens || 0,
            cacheWrite1h: cc.ephemeral_1h_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            output: usage.output_tokens || 0,
          },
          fast: usage.speed === "fast",
          text: "",
          tools: [],
        };
        s.calls.push(call);
        if (model) {
          const mm = (s.models[model] ||= { calls: 0, cost: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } });
          mm.calls++;
          mm.cost += call.cost;
          for (const k of Object.keys(mm.tokens)) mm.tokens[k] += call.tokens[k];
        }
        tk.cost += call.cost;
        tk.calls++;
        if (!tk.end || d.timestamp > tk.end) tk.end = d.timestamp;
        for (const k of Object.keys(tk.tokens)) tk.tokens[k] += call.tokens[k];
        if (side) {
          tk.sideCalls++;
          tk.sideCost += call.cost;
        }
        // every API call re-reads what is still open in its context
        const p = priceFor(model || lastModel, opts.pricing);
        for (const tc of ctx.open) {
          tc.reread++;
          if (p) tc.carry += (tc.resultTokens * p.cr) / 1e6;
        }
      }
      const owner = call || s.calls.find((c) => c.id === m.id);
      for (const b of content) {
        if (!b) continue;
        if (b.type === "text" && owner && !opts.light && owner.text.length < REPLY_KEEP) owner.text = (owner.text + (owner.text ? "\n" : "") + b.text).slice(0, REPLY_KEEP);
        if (b.type === "tool_use") {
          const p = priceFor(model || lastModel, opts.pricing);
          const tc = {
            i: s.toolCalls.length,
            id: b.id,
            name: b.name,
            summary: opts.light ? "" : toolSummary(b.input),
            ext: toolExt(b.input),
            ts: d.timestamp,
            task: tk.index,
            call: owner ? owner.i : null,
            side,
            agent: ctx.agentId || null,
            resultTokens: 0,
            reread: 0,
            isError: false,
            carry: 0, // = first write (1h cache) + each later re-read
            writePrice: p ? p.in * 2 : 0,
            readPrice: p ? p.cr : 0,
          };
          s.toolCalls.push(tc);
          toolById.set(b.id, tc);
          if (owner) owner.tools.push(tc.i);
          tk.toolCalls++;
          tk.tools[b.name] = (tk.tools[b.name] || 0) + 1;
        }
      }
    }
  }

  ingest(readLines(file), { side: false, agentId: null, open: [], fixedTask: null });
  const mainCalls = s.calls.length;

  // sub-agents: <session dir>/<id>/subagents/agent-*.jsonl (+ .meta.json with the Agent tool_use id)
  const subDir = join(dirname(file), s.id, "subagents");
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const agentId = basename(f, ".jsonl").replace(/^agent-/, "");
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(subDir, basename(f, ".jsonl") + ".meta.json"), "utf8"));
      } catch {
        /* no meta */
      }
      const parentTool = meta.toolUseId ? toolById.get(meta.toolUseId) : null;
      const fixedTask = parentTool ? s.tasks[parentTool.task - 1] : null;
      const before = s.calls.length;
      ingest(readLines(join(subDir, f)), { side: true, agentId, open: [], fixedTask });
      const calls = s.calls.slice(before);
      s.agents.push({
        id: agentId,
        description: meta.description || meta.agentType || agentId,
        type: meta.agentType || null,
        task: fixedTask ? fixedTask.index : calls[0]?.task ?? null,
        calls: calls.length,
        cost: calls.reduce((a, c) => a + c.cost, 0),
      });
    }
  }
  // Claude Code's own total is only comparable when nothing happened after it was written
  if (s.officialCost != null && callsAtCostState < mainCalls) s.officialCost = null;

  for (const tc of s.toolCalls) tc.carry += (tc.resultTokens * tc.writePrice) / 1e6;

  s.cost = s.calls.reduce((a, c) => a + c.cost, 0);
  s.sideCost = s.calls.filter((c) => c.side).reduce((a, c) => a + c.cost, 0);
  s.tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  s.parts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const c of s.calls)
    for (const k of Object.keys(s.tokens)) {
      s.tokens[k] += c.tokens[k];
      s.parts[k] += c.parts[k];
    }
  s.byTool = {};
  for (const tc of s.toolCalls) {
    const b = (s.byTool[tc.name] ||= { calls: 0, resultTokens: 0, carry: 0, errors: 0 });
    b.calls++;
    b.resultTokens += tc.resultTokens;
    b.carry += tc.carry;
    if (tc.isError) b.errors++;
  }
  s.topToolCalls = [...s.toolCalls].sort((a, b) => b.carry - a.carry).slice(0, 15);
  s.durationMs = s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : 0;
  s.mainModel = Object.entries(s.models).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || null;
  s.whatIf = WHATIF.map((model) => {
    const p = priceFor(model);
    let cost = 0;
    for (const c of s.calls) {
      if (!c.model) continue;
      cost +=
        (c.tokens.input * p.in +
          (c.tokens.cacheWrite - c.tokens.cacheWrite1h) * p.in * 1.25 +
          c.tokens.cacheWrite1h * p.in * 2 +
          c.tokens.cacheRead * p.cr +
          c.tokens.output * p.out) /
        1e6;
    }
    return { model, label: p.label, cost };
  });
  // A session started by another Claude Code session opens with the delegation brief; its title says more.
  const first = s.tasks.find((t) => !t.meta);
  if (s.title && first && DELEGATED_RE.test(first.prompt)) first.short = s.title;
  if (!s.title) {
    s.title = first ? first.short.slice(0, 80) : s.id;
  }
  s.unknownModels = [...s.unknownModels];
  return s;
}
