// OpenAI Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
// Produces the same receipt model as parseSession, so every output (terminal, HTML, JSON, SVG) works unchanged.
import { readdirSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readLines, estimateTokens, shortLabel, toolSummary, toolExt } from "./parse.js";
import { codexCostParts, priceFor, WHATIF_CODEX } from "./pricing.js";

const ZERO = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
// Text Codex injects into the user turn (environment, instructions, app context): not something the user typed.
const INJECTED_RE = /^\s*(<[a-zA-Z_][\w-]*[\s>]|#\s|The following is the Codex agent history|>>> RETAINED USER INSTRUCTIONS)/;
// Tags Codex leaves around pasted images and similar blocks, removed from labels.
const TAG_RE = /<\/?[a-zA-Z_][\w-]*(\s[^>]*)?>/g;
const IMAGE_TAG_RE = /<\/?image\b[^>]*>/g;

/** Every rollout file under a Codex sessions folder, newest first. */
export function codexSessionFiles(root) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(join(d, e.name));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Session id from the file name: rollout-2026-10-25T02-30-56-<uuid>.jsonl */
export const codexIdFromFile = (file) => (basename(file, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i) || [, basename(file, ".jsonl")])[1];

const textOf = (content) =>
  Array.isArray(content) ? content.filter((b) => b && b.type === "input_text" && typeof b.text === "string").map((b) => b.text) : typeof content === "string" ? [content] : [];

function args(item) {
  if (item.type === "function_call") {
    try {
      const a = JSON.parse(item.arguments || "{}");
      if (Array.isArray(a.command)) a.command = a.command.join(" "); // shell calls pass argv
      return a;
    } catch {
      return { command: String(item.arguments || "") };
    }
  }
  return typeof item.input === "string" ? { command: item.input.split("\n")[0] } : item.input || {};
}

/**
 * @param {string} file path to a rollout-*.jsonl
 * @param {{pricing?: object, light?: boolean}} opts
 */
export function parseCodexSession(file, opts = {}) {
  const s = {
    agent: "codex",
    file,
    id: codexIdFromFile(file),
    title: null,
    cwd: null,
    branch: null,
    version: null,
    start: null,
    end: null,
    officialCost: null, // Codex does not write a dollar total
    reportedTokens: null, // Codex's own running token total, to check the per-response sum against
    models: {},
    calls: [],
    tasks: [],
    toolCalls: [],
    agents: [],
    prs: [],
    unknownModels: new Set(),
    compactions: 0,
  };
  const seenResponse = new Set();
  const taskByTurn = new Map();
  const toolById = new Map();
  let open = [];
  let model = null;
  let task = null;
  let pendingPrompt = null;
  let usageRecords = 0;
  let prevTotal = 0;
  const fallbackCounts = []; // token_count events, used only when the file has no token_usage_record

  const newTask = (turnId, ts) => {
    task = {
      index: s.tasks.length + 1,
      prompt: "",
      short: "",
      start: ts,
      end: ts,
      cost: 0,
      calls: 0,
      sideCalls: 0,
      sideCost: 0,
      tokens: ZERO(),
      tools: {},
      toolCalls: 0,
      meta: false,
    };
    s.tasks.push(task);
    if (turnId) taskByTurn.set(turnId, task);
    if (pendingPrompt) {
      setPrompt(task, pendingPrompt);
      pendingPrompt = null;
    }
    return task;
  };
  const setPrompt = (t, text) => {
    t.prompt = text;
    t.short = shortLabel(text);
  };
  const addCall = (id, usage, turnId, ts) => {
    const tk = (turnId && taskByTurn.get(turnId)) || task || newTask(turnId, ts);
    const parts = model ? codexCostParts(usage, model, opts.pricing) : null;
    if (model && !parts) s.unknownModels.add(model);
    const p = parts || ZERO();
    const cost = p.input + p.cacheWrite + p.cacheRead + p.output;
    const input = usage.input_tokens || 0;
    const cached = usage.cached_input_tokens || 0;
    const written = usage.cache_write_input_tokens || 0;
    const call = {
      i: s.calls.length,
      id,
      ts,
      model,
      side: false,
      agent: null,
      task: tk.index,
      cost,
      parts: p,
      tokens: { input: Math.max(0, input - cached - written), cacheWrite: written, cacheWrite1h: 0, cacheRead: cached, output: usage.output_tokens || 0 },
      fast: false,
      text: "",
      tools: [],
    };
    s.calls.push(call);
    if (model) {
      const mm = (s.models[model] ||= { calls: 0, cost: 0, tokens: ZERO() });
      mm.calls++;
      mm.cost += cost;
      for (const k of Object.keys(mm.tokens)) mm.tokens[k] += call.tokens[k];
    }
    tk.cost += cost;
    tk.calls++;
    if (!tk.end || ts > tk.end) tk.end = ts;
    for (const k of Object.keys(tk.tokens)) tk.tokens[k] += call.tokens[k];
    // every response re-reads what is still in its context, at the cached-input price
    const price = priceFor(model, opts.pricing);
    for (const tc of open) {
      tc.reread++;
      if (price) tc.carry += (tc.resultTokens * price.cr) / 1e6;
    }
  };

  for (const d of readLines(file)) {
    const ts = d.timestamp || null;
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts;
      if (!s.end || ts > s.end) s.end = ts;
    }
    const p = d.payload && typeof d.payload === "object" ? d.payload : {};
    if (d.type === "session_meta") {
      if (p.id) s.id = p.id;
      s.cwd ||= p.cwd || null;
      s.version = p.cli_version || s.version;
      if (p.git && p.git.branch) s.branch = p.git.branch;
      continue;
    }
    if (d.type === "turn_context") {
      model = p.model || model;
      s.cwd ||= p.cwd || null;
      continue;
    }
    if (d.type === "compacted") {
      s.compactions++;
      open = [];
      continue;
    }
    if (d.type === "token_usage_record") {
      usageRecords++;
      if (p.thread_token_usage) s.reportedTokens = p.thread_token_usage;
      const id = p.response_id || `usage-${usageRecords}`;
      if (seenResponse.has(id)) continue;
      seenResponse.add(id);
      addCall(id, p.usage || {}, p.turn_id, ts);
      continue;
    }
    if (d.type === "event_msg") {
      if (p.type === "task_started") newTask(p.turn_id, ts);
      else if (p.type === "token_count" && p.info) fallbackCounts.push({ info: p.info, ts, model, task });
      continue;
    }
    if (d.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      const typed = textOf(p.content)
        .map((t) => t.replace(IMAGE_TAG_RE, " ").trim()) // a pasted image is the user's, not injected context
        .filter((t) => t && !INJECTED_RE.test(t))
        .map((t) => t.replace(TAG_RE, " ").trim())
        .filter(Boolean);
      if (!typed.length) continue;
      const text = typed.join("\n");
      if (task && !task.prompt) setPrompt(task, text);
      else if (!task) pendingPrompt = pendingPrompt || text;
      continue;
    }
    if (p.type === "message" && p.role === "assistant" && !opts.light) {
      const last = s.calls[s.calls.length - 1];
      const t = Array.isArray(p.content) ? p.content.map((b) => b && (b.text || "")).join("\n") : "";
      if (last && t && last.text.length < 400) last.text = (last.text + (last.text ? "\n" : "") + t).slice(0, 400);
      continue;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const tk = task || newTask(null, ts);
      const a = args(p);
      const price = priceFor(model, opts.pricing);
      const tc = {
        i: s.toolCalls.length,
        id: p.call_id || p.id,
        name: p.name || p.type,
        summary: opts.light ? "" : toolSummary(a),
        ext: toolExt(a),
        ts,
        task: tk.index,
        call: s.calls.length ? s.calls.length - 1 : null,
        side: false,
        agent: null,
        resultTokens: 0,
        reread: 0,
        isError: false,
        carry: 0, // = first send as uncached input + each later re-read as cached input
        writePrice: price ? price.in : 0,
        readPrice: price ? price.cr : 0,
      };
      s.toolCalls.push(tc);
      toolById.set(tc.id, tc);
      if (tc.call != null) s.calls[tc.call].tools.push(tc.i);
      tk.toolCalls++;
      tk.tools[tc.name] = (tk.tools[tc.name] || 0) + 1;
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const tc = toolById.get(p.call_id);
      if (!tc) continue;
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      tc.resultTokens = estimateTokens(out);
      open.push(tc);
    }
  }

  // Older Codex versions only write token_count events: one call per increase of the running total.
  if (!usageRecords) {
    for (const f of fallbackCounts) {
      const total = f.info.total_token_usage?.total_tokens ?? 0;
      if (total <= prevTotal || !f.info.last_token_usage) continue;
      prevTotal = total;
      model = f.model;
      task = f.task;
      addCall(`count-${s.calls.length}`, f.info.last_token_usage, null, f.ts);
      s.reportedTokens = f.info.total_token_usage;
    }
  }

  for (const tc of s.toolCalls) tc.carry += (tc.resultTokens * tc.writePrice) / 1e6;
  for (const t of s.tasks) if (!t.prompt) (t.short = "(no prompt text)"), (t.meta = t.cost === 0);

  s.cost = s.calls.reduce((a, c) => a + c.cost, 0);
  s.sideCost = 0;
  s.tokens = ZERO();
  s.parts = ZERO();
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
  }
  s.topToolCalls = [...s.toolCalls].sort((a, b) => b.carry - a.carry).slice(0, 15);
  s.durationMs = s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : 0;
  s.mainModel = Object.entries(s.models).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || null;
  s.whatIf = WHATIF_CODEX.map((m) => {
    const p = priceFor(m);
    let cost = 0;
    for (const c of s.calls) {
      if (!c.model) continue;
      cost += (c.tokens.input * p.in + c.tokens.cacheWrite * p.in * 1.25 + c.tokens.cacheRead * p.cr + c.tokens.output * p.out) / 1e6;
    }
    return { model: m, label: p.label, cost };
  });
  const first = s.tasks.find((t) => t.prompt);
  s.title = first ? first.short.slice(0, 80) : s.id;
  s.unknownModels = [...s.unknownModels];
  return s;
}

/** True when a .jsonl file is a Codex rollout rather than a Claude Code transcript. */
export function isCodexFile(file) {
  if (basename(file).startsWith("rollout-")) return true;
  for (const d of readLines(file)) return d.type === "session_meta" && !!d.payload;
  return false;
}
