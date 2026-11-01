#!/usr/bin/env node
// Writes an invented history of Claude Code and Codex sessions for screenshots and the README GIF.
// Every project, prompt, path and number here is made up: nothing comes from a real history.
// Run: node scripts/build-demo.mjs <folder>   then point HOME at <folder>, e.g.
//      HOME=<folder> node bin/ccreceipt.js
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSession } from "../src/parse.js";

const OUT = resolve(process.argv[2] || "demo-home");
const CLAUDE = join(OUT, ".claude", "projects");
const CODEX = join(OUT, ".codex", "sessions");

// a small seeded generator: the same folder every time
let seed = 20261101;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const uuid = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => int(0, 15).toString(16));

const PROJECTS = {
  "storefront-web": ["src/app/checkout/page.tsx", "src/components/Cart.tsx", "src/lib/search.ts", "src/app/products/[id]/page.tsx", "playwright/checkout.spec.ts"],
  "payments-api": ["src/routes/charges.ts", "src/webhooks/stripe.ts", "src/middleware/rateLimit.ts", "src/db/refunds.sql", "test/charges.test.ts"],
  "data-pipeline": ["dags/backfill_events.py", "sql/dedupe_orders.sql", "jobs/export_warehouse.py", "tests/test_dedupe.py"],
  "mobile-app": ["ios/App/Notifications.swift", "src/store/cart.ts", "src/screens/Checkout.tsx", "android/app/build.gradle"],
  infra: ["terraform/staging/main.tf", ".github/workflows/ci.yml", "helm/api/values.yaml"],
  "docs-site": ["scripts/openapi-to-md.ts", "content/api/charges.md", "astro.config.mjs"],
};

// title, project, model, day of October, prompts (with how heavy each task is: 1 light … 5 very heavy)
const SESSIONS = [
  ["Checkout redesign", "storefront-web", "claude-opus-5-5", 29, [["Redesign the checkout as a single step", 5], ["The address form loses focus on mobile, fix it", 2], ["Add Apple Pay to the payment step", 4], ["Write Playwright tests for the new checkout", 4], ["Polish the empty cart state", 1]]],
  ["Idempotency keys on charges", "payments-api", "claude-opus-5-5", 28, [["Charges can be created twice on a retry: add idempotency keys", 4], ["Store the keys with a 24 hour expiry", 2], ["Add tests for concurrent retries", 3]]],
  ["Backfill October events", "data-pipeline", "claude-sonnet-5-5", 27, [["Backfill the events table for October", 3], ["The backfill is too slow, batch it by day", 3], ["Check the row counts against the source", 1]]],
  ["Product search with filters", "storefront-web", "claude-opus-5-5", 26, [["Add faceted search to the product list", 4], ["Filters should sync with the URL", 2], ["Search is slow on 10k products, profile it", 5], ["Debounce the search input", 1]]],
  ["Stripe webhook retries", "payments-api", "claude-opus-5-5", 24, [["Webhooks fail silently when the DB is down, add retries", 3], ["Log every webhook with its event id", 1]]],
  ["Push notifications on iOS", "mobile-app", "claude-opus-5-5", 23, [["Set up push notifications on iOS", 4], ["Ask for permission after the first order, not at launch", 2], ["Deep link from a notification to the order screen", 3]]],
  ["Cut CI time in half", "infra", "claude-sonnet-5-5", 22, [["CI takes 18 minutes, find where the time goes", 2], ["Cache the dependencies and split the tests in 4 shards", 3]]],
  ["Migrate to the app router", "storefront-web", "claude-fable-5-1", 21, [["Plan the migration from pages to the app router", 3], ["Migrate the product pages first", 5], ["Move data fetching to server components", 4], ["Fix the hydration warnings", 2]]],
  ["Dedupe the orders table", "data-pipeline", "claude-opus-5-5", 20, [["Find the duplicate orders and explain why they happen", 3], ["Write the dedupe migration", 2]]],
  ["Rate limiting on login", "payments-api", "claude-sonnet-5-5", 17, [["Add rate limiting to the login route", 2], ["Return a Retry-After header", 1]]],
  ["Offline mode for the cart", "mobile-app", "claude-opus-5-5", 16, [["Keep the cart working offline", 4], ["Sync the cart when the network comes back", 3], ["Handle conflicts when the same cart changed on the web", 4]]],
  ["API reference from OpenAPI", "docs-site", "claude-sonnet-5-5", 14, [["Generate the API reference pages from openapi.yaml", 2], ["Add code samples in curl and TypeScript", 2]]],
  ["Terraform for staging", "infra", "claude-opus-5-5", 13, [["Write the Terraform for the staging cluster", 4], ["Plan fails on the IAM role, fix it", 2]]],
  ["Refund flow", "payments-api", "claude-opus-5-5", 10, [["Add partial refunds", 3], ["Email the customer when a refund goes through", 1], ["Refunds over $500 need a second approval", 2]]],
  ["Nightly export to the warehouse", "data-pipeline", "claude-sonnet-5-5", 8, [["Export the orders to the warehouse every night", 2], ["Alert on Slack when the export fails", 1]]],
  ["Hero section and pricing page", "storefront-web", "claude-opus-5-5", 6, [["Redo the hero section with the new brand colours", 2], ["Build the pricing page from the Figma frame", 3]]],
];

const TOOLS = ["Read", "Read", "Read", "Edit", "Edit", "Bash", "Grep", "Glob", "mcp__playwright__browser_snapshot", "WebFetch"];
const BASH = ["npm test", "npm run build", "git diff --stat", "npx tsc --noEmit", "pytest -q", "terraform plan", "npm run lint"];
const AUTO = ["<task-notification><summary>Tests passed: 214 of 214</summary></task-notification>", "<task-notification><summary>Build finished in 41s</summary></task-notification>"];

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function toolInput(name, project) {
  const file = `/home/dev/${project}/${pick(PROJECTS[project])}`;
  if (name === "Read" || name === "Edit") return { file_path: file };
  if (name === "Bash") return { command: pick(BASH) };
  if (name === "Grep") return { pattern: pick(["TODO", "useEffect", "retry", "idempotency", "SELECT"]) };
  if (name === "Glob") return { pattern: "src/**/*.ts" };
  if (name === "WebFetch") return { url: "https://docs.example.com/api" };
  return { url: "http://localhost:3000/checkout" };
}

function claudeSession([title, project, model, day, prompts], n) {
  const id = uuid();
  const cwd = `/home/dev/${project}`;
  let clock = Date.parse(`2026-10-${String(day).padStart(2, "0")}T${String(int(8, 15)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00.000Z`);
  const ts = (s) => new Date((clock += s * 1000)).toISOString();
  const base = () => ({ cwd, gitBranch: `feat/${title.toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 24)}`, version: "3.0.0", sessionId: id });
  const out = [];
  const subagents = [];
  let context = int(14000, 22000);
  let msg = 0;
  prompts.forEach(([prompt, weight], ti) => {
    out.push({ type: "user", ...base(), timestamp: ts(int(60, 900)), message: { role: "user", content: prompt } });
    const calls = Math.round(weight ** 2 * int(9, 16) + int(2, 8));
    for (let c = 0; c < calls; c++) {
      const last = c === calls - 1;
      const tool = last ? null : pick(TOOLS);
      const delta = tool ? int(400, tool.startsWith("mcp__") ? 9000 : 3500) : 0;
      const output = int(150, 1400);
      const usage = {
        input_tokens: int(3, 40),
        cache_creation_input_tokens: delta + output,
        cache_creation: { ephemeral_5m_input_tokens: delta + output, ephemeral_1h_input_tokens: 0 },
        cache_read_input_tokens: context,
        output_tokens: output,
      };
      const mid = `msg_${n}_${msg++}`;
      const content = tool ? [{ type: "tool_use", id: `toolu_${mid}`, name: tool, input: toolInput(tool, project) }] : [{ type: "text", text: "Done. Summary of the change follows." }];
      // a sub-agent for one heavy task per session
      if (tool && weight >= 4 && c === 2) {
        content[0] = { type: "tool_use", id: `toolu_${mid}`, name: "Agent", input: { description: "Explore the codebase", prompt: "Map the files involved" } };
        subagents.push({ toolUseId: `toolu_${mid}`, calls: int(12, 30) });
      }
      out.push({ type: "assistant", ...base(), timestamp: ts(int(8, 70)), message: { id: mid, role: "assistant", model, usage, content } });
      if (tool) out.push({ type: "user", ...base(), timestamp: ts(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${mid}`, content: "x".repeat(delta * 4) }] } });
      context += delta + output;
      // long sessions compact
      if (context > 160000) {
        out.push({ type: "user", ...base(), timestamp: ts(5), isCompactSummary: true, message: { role: "user", content: "Summary of the conversation so far" } });
        context = int(24000, 32000);
      }
    }
    if (ti === 1 && rand() < 0.5) out.push({ type: "user", ...base(), timestamp: ts(30), message: { role: "user", content: pick(AUTO) } });
  });
  out.push({ type: "custom-title", customTitle: title, sessionId: id });

  const dir = join(CLAUDE, `-home-dev-${project}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, jsonl(out));
  subagents.forEach((a, i) => {
    const sub = join(dir, id, "subagents");
    mkdirSync(sub, { recursive: true });
    const recs = [{ type: "user", isSidechain: true, cwd, timestamp: ts(1), message: { role: "user", content: "Map the files involved" } }];
    let ctx = 9000;
    for (let c = 0; c < a.calls; c++) {
      const delta = int(300, 2500);
      recs.push({ type: "assistant", isSidechain: true, cwd, timestamp: ts(6), message: { id: `msg_${n}_sub${i}_${c}`, role: "assistant", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: delta, cache_read_input_tokens: ctx, output_tokens: int(100, 600) }, content: [] } });
      ctx += delta;
    }
    writeFileSync(join(sub, `agent-${i}.jsonl`), jsonl(recs));
    writeFileSync(join(sub, `agent-${i}.meta.json`), JSON.stringify({ toolUseId: a.toolUseId, description: "Explore the codebase", agentType: "Explore" }) + "\n");
  });
  // Claude Code's own total, a little above ours as it is on real sessions (web search, retries)
  appendFileSync(file, JSON.stringify({ type: "cost-state", totalCostUSD: +(parseSession(file).cost * (1 + rand() * 0.02)).toFixed(2) }) + "\n");
}

function codexSession(project, day, prompts) {
  const id = uuid().replace(/^(.{14})4/, "$17");
  const cwd = `/home/dev/${project}`;
  let clock = Date.parse(`2026-10-${String(day).padStart(2, "0")}T14:00:00.000Z`);
  const ts = (s = 20) => new Date((clock += s * 1000)).toISOString();
  const cu = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: Math.round(output / 3), total_tokens: input + output });
  const recs = [{ timestamp: ts(0), type: "session_meta", payload: { id, cwd, cli_version: "0.99.0", model_provider: "openai" } }, { timestamp: ts(1), type: "turn_context", payload: { model: "gpt-6.1-sol", cwd } }];
  let thread = cu(0, 0, 0);
  let context = 12000;
  let r = 0;
  prompts.forEach((prompt, t) => {
    const turn = `turn-${t + 1}`;
    recs.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_started", turn_id: turn } });
    recs.push({ timestamp: ts(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
    for (let c = 0; c < int(20, 60); c++) {
      const delta = int(500, 3000);
      recs.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "shell", call_id: `call_${r}`, arguments: JSON.stringify({ command: ["cat", `${cwd}/${pick(PROJECTS[project])}`] }) } });
      recs.push({ timestamp: ts(1), type: "response_item", payload: { type: "function_call_output", call_id: `call_${r}`, output: "y".repeat(delta * 4) } });
      const u = cu(context + delta, context, int(200, 1500));
      thread = cu(thread.input_tokens + u.input_tokens, thread.cached_input_tokens + u.cached_input_tokens, thread.output_tokens + u.output_tokens);
      recs.push({ timestamp: ts(1), type: "token_usage_record", payload: { response_id: `resp_${r++}`, turn_id: turn, usage: u, thread_token_usage: thread } });
      context += delta;
    }
  });
  const dir = join(CODEX, "2026", "10", String(day).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-10-${String(day).padStart(2, "0")}T14-00-00-${id}.jsonl`), jsonl(recs));
}

rmSync(OUT, { recursive: true, force: true });
SESSIONS.forEach(claudeSession);
codexSession("mobile-app", 25, ["Why does the Android build fail on the CI runner?", "Upgrade Gradle and fix the deprecations"]);
codexSession("data-pipeline", 19, ["Rewrite the export job in Polars"]);
console.log(`demo history written to ${OUT}\nrun: HOME=${OUT} node bin/ccreceipt.js`);
