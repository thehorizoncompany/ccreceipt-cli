import { PRICES } from "./pricing.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => (n >= 100 ? "$" + n.toFixed(0) : n >= 1 ? "$" + n.toFixed(2) : n >= 0.01 ? "$" + n.toFixed(2) : n > 0 ? "<$0.01" : "$0");
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n));
const dur = (ms) => {
  if (!ms) return "–";
  const m = Math.round(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") : m + " min";
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function renderHtml(s) {
  const realTasks = s.tasks.filter((t) => !t.meta || t.cost > 0);
  const maxTask = Math.max(...realTasks.map((t) => t.cost), 0.000001);
  const carryTools = Object.values(s.byTool).reduce((a, b) => a + b.carry, 0);
  const rereadRest = Math.max(0, s.parts.cacheRead + s.parts.cacheWrite - carryTools);
  const toolRows = Object.entries(s.byTool).sort((a, b) => b[1].carry - a[1].carry);
  const steps = s.calls.map((c) => ({
    i: c.i,
    ts: c.ts,
    task: c.task,
    cost: c.cost,
    side: c.side,
    text: (c.text || "").slice(0, 400),
    tools: c.tools.map((i) => {
      const t = s.toolCalls[i];
      return { name: t.name, summary: t.summary, tokens: t.resultTokens, reread: t.reread, carry: t.carry };
    }),
  }));
  const data = JSON.stringify({ steps, tasks: realTasks.map((t) => ({ index: t.index, short: t.short, cost: t.cost })) }).replace(/<\/script/gi, "<\\/script");
  const modelLabel = (m) => PRICES.find((p) => p.match.test(m || ""))?.label || m || "unknown model";
  const started = s.start ? new Date(s.start) : null;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt · ${esc(s.title)}</title>
<style>
:root{--bg:#0b0d12;--panel:#12151d;--line:#1f2430;--fg:#e6e8ef;--mute:#8b91a3;--acc:#ffd166;--acc2:#06d6a0;--bad:#ef476f;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:0 0 6px;font-weight:600}
.total{font:700 64px/1 var(--mono);color:var(--acc);margin:4px 0 8px;letter-spacing:-.02em}
.sub{color:var(--mute)}.sub b{color:var(--fg);font-weight:600}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:20px}
h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin:0 0 14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
h2 .hint{font-weight:400;text-transform:none;letter-spacing:0;font-size:12px}
.row{display:grid;grid-template-columns:36px 1fr 90px;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}.n{color:var(--mute);font-family:var(--mono);font-size:12px}
.p{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.p small{display:block;color:var(--mute);font-size:12px}
.bar{height:4px;background:var(--line);border-radius:2px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc)}
.c{font-family:var(--mono);text-align:right;font-weight:600}
.stack{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:8px 0 10px}.stack i{display:block;height:100%}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--mute)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em;border-top:0}
td.c,th.c{text-align:right;font-family:var(--mono)}td.m{font-family:var(--mono);font-size:12px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.tag{display:inline-block;background:#1b2130;color:var(--fg);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:12px;margin-right:6px}
.bad{color:var(--bad)}.good{color:var(--acc2)}
.replay{display:grid;grid-template-columns:1fr;gap:12px}
input[type=range]{width:100%;accent-color:var(--acc)}
.meter{display:flex;justify-content:space-between;font-family:var(--mono);font-size:13px;color:var(--mute)}.meter b{color:var(--acc);font-size:22px}
.step{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-height:120px;font-size:14px}
.step .t{white-space:pre-wrap;color:var(--fg)}.step .tool{margin-top:8px;color:var(--mute);font-family:var(--mono);font-size:12px}
.btn{background:#1b2130;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.btn.on{border-color:var(--acc);color:var(--acc)}
footer{color:var(--mute);font-size:12px;margin-top:28px;line-height:1.6}
@media (max-width:600px){.total{font-size:44px}.row{grid-template-columns:28px 1fr 74px}}
</style></head><body><main>
<h1>Receipt · Claude Code session</h1>
<div class="total">${usd(s.cost)}</div>
<div class="sub"><b>${esc(s.title)}</b><br>
${started ? started.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""} · ${dur(s.durationMs)} · ${modelLabel(s.mainModel)} · ${s.calls.length} API calls · ${s.toolCalls.length} tool calls · ${realTasks.length} task${realTasks.length > 1 ? "s" : ""}${s.officialCost != null ? ` · Claude Code's own total: ${usd(s.officialCost)}` : ""}${s.compactions ? ` · ${s.compactions} compaction${s.compactions > 1 ? "s" : ""}` : ""}<br>
<span style="font-family:var(--mono);font-size:12px">${esc(s.cwd || "")}${s.branch ? " · " + esc(s.branch) : ""}</span></div>

<section><h2>What the money bought <span class="hint">by token type</span></h2>
<div class="stack">
<i style="width:${pct(s.parts.cacheRead, s.cost)}%;background:#4361ee" title="cache reads"></i>
<i style="width:${pct(s.parts.cacheWrite, s.cost)}%;background:#7209b7" title="cache writes"></i>
<i style="width:${pct(s.parts.output, s.cost)}%;background:var(--acc)" title="output"></i>
<i style="width:${pct(s.parts.input, s.cost)}%;background:var(--acc2)" title="uncached input"></i></div>
<div class="legend">
<span><i style="background:#4361ee"></i>Re-reading context (cache reads) ${usd(s.parts.cacheRead)} · ${pct(s.parts.cacheRead, s.cost)}% · ${tok(s.tokens.cacheRead)} tokens</span>
<span><i style="background:#7209b7"></i>Writing context to cache ${usd(s.parts.cacheWrite)} · ${pct(s.parts.cacheWrite, s.cost)}%</span>
<span><i style="background:var(--acc)"></i>The model's own output ${usd(s.parts.output)} · ${pct(s.parts.output, s.cost)}% · ${tok(s.tokens.output)} tokens</span>
<span><i style="background:var(--acc2)"></i>Uncached input ${usd(s.parts.input)}</span></div>
<p class="sub" style="margin:12px 0 0">Of the ${usd(s.parts.cacheRead + s.parts.cacheWrite)} spent on context, about <b>${usd(carryTools)}</b> (${pct(carryTools, s.parts.cacheRead + s.parts.cacheWrite)}%) was carrying tool results around, and <b>${usd(rereadRest)}</b> was the system prompt, your prompts and the model's own earlier answers.</p>
</section>

<section><h2>Per task <span class="hint"><button class="btn on" id="byOrder">in order</button> <button class="btn" id="byCost">by cost</button></span></h2>
<div id="tasks">
${realTasks
  .map(
    (t) => `<div class="row" data-cost="${t.cost}" data-i="${t.index}"><div class="n">#${t.index}</div><div class="p" title="${esc(t.prompt.slice(0, 1000))}">${esc(t.short) || "<i>(no prompt text)</i>"}<small>${t.calls} calls · ${t.toolCalls} tool calls${t.sideCalls ? ` · ${t.sideCalls} by sub-agents (${usd(t.sideCost)})` : ""} · ${dur(Date.parse(t.end) - Date.parse(t.start))}</small><div class="bar"><i style="width:${pct(t.cost, maxTask)}%"></i></div></div><div class="c">${usd(t.cost)}</div></div>`
  )
  .join("\n")}
</div></section>

<section><h2>The most expensive tool results <span class="hint">what each result cost to keep in context</span></h2>
<table><thead><tr><th>Tool</th><th>Call</th><th class="c">Result</th><th class="c">Re-read</th><th class="c">Cost</th></tr></thead><tbody>
${s.topToolCalls
  .map(
    (t) => `<tr><td><span class="tag">${esc(t.name.replace(/^mcp__/, ""))}</span>${t.isError ? '<span class="bad">error</span>' : ""}</td><td class="m" title="${esc(t.summary)}">${esc(t.summary) || "–"}</td><td class="c">${tok(t.resultTokens)} tok</td><td class="c">${t.reread}×</td><td class="c">${usd(t.carry)}</td></tr>`
  )
  .join("\n")}
</tbody></table>
<p class="sub" style="margin:12px 0 0;font-size:13px">Cost = tokens × cache-write price once, plus tokens × cache-read price for every later API call in the same context. Token counts are estimated from the result's size (about 4 characters per token). A result that is big <i>and</i> early is the expensive kind.</p>
</section>

<section><h2>By tool</h2>
<table><thead><tr><th>Tool</th><th class="c">Calls</th><th class="c">Errors</th><th class="c">Tokens injected</th><th class="c">Carrying cost</th><th class="c">Share</th></tr></thead><tbody>
${toolRows
  .map(
    ([name, b]) => `<tr><td><span class="tag">${esc(name.replace(/^mcp__/, ""))}</span></td><td class="c">${b.calls}</td><td class="c ${b.errors ? "bad" : ""}">${b.errors || ""}</td><td class="c">${tok(b.resultTokens)}</td><td class="c">${usd(b.carry)}</td><td class="c">${pct(b.carry, carryTools)}%</td></tr>`
  )
  .join("\n")}
</tbody></table></section>

<section><h2>Same tokens, other model <span class="hint">list prices, identical token counts</span></h2>
<table><thead><tr><th>Model</th><th class="c">This session would cost</th><th class="c">vs actual</th></tr></thead><tbody>
${s.whatIf
  .map((w) => {
    const d = w.cost - s.cost;
    const cur = modelLabel(s.mainModel) === w.label;
    return `<tr><td>${esc(w.label)}${cur ? ' <span class="tag">current</span>' : ""}</td><td class="c">${usd(w.cost)}</td><td class="c ${d < -0.005 ? "good" : d > 0.005 ? "bad" : ""}">${Math.abs(d) < 0.005 ? "–" : (d > 0 ? "+" : "−") + usd(Math.abs(d))}</td></tr>`;
  })
  .join("\n")}
</tbody></table>
<p class="sub" style="margin:12px 0 0;font-size:13px">A price-only estimate: another model would also think, read and write differently. Use it to size the gap, not to pick a model.</p>
</section>

<section><h2>Replay <span class="hint">drag to scrub through the ${s.calls.length} API calls</span></h2>
<div class="replay">
<input type="range" id="scrub" min="0" max="${Math.max(0, s.calls.length - 1)}" value="0">
<div class="meter"><span>call <span id="ci">1</span> / ${s.calls.length} · task <span id="ct">1</span> · <span id="cts"></span></span><span>spent so far <b id="cc">$0</b></span></div>
<div class="step" id="step"></div>
</div></section>

<footer>Generated by <b>ccreceipt</b> from <span style="font-family:var(--mono)">${esc(s.file)}</span>. Everything ran locally; nothing left your machine.${s.unknownModels.length ? ` <span class="bad">Unknown model price for: ${esc(s.unknownModels.join(", "))} (counted as $0; pass --pricing).</span>` : ""}
${s.officialCost != null ? ` Claude Code's own total for this session is ${usd(s.officialCost)}; differences come from list prices vs. your plan and from duplicate stream chunks.` : ""}</footer>
</main>
<script id="d" type="application/json">${data}</script>
<script>
const D=JSON.parse(document.getElementById('d').textContent);
const usd=n=>n>=100?'$'+n.toFixed(0):n>=1?'$'+n.toFixed(2):n>=0.01?'$'+n.toFixed(2):n>0?'<$0.01':'$0';
const esc=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const cum=[];let a=0;for(const st of D.steps){a+=st.cost;cum.push(a)}
const scrub=document.getElementById('scrub'),step=document.getElementById('step');
function show(i){const st=D.steps[i];if(!st)return;document.getElementById('ci').textContent=i+1;document.getElementById('ct').textContent=st.task;document.getElementById('cts').textContent=st.ts?new Date(st.ts).toLocaleTimeString():'';document.getElementById('cc').textContent=usd(cum[i]);
const task=D.tasks.find(t=>t.index===st.task);
let h='<div style="color:var(--mute);font-size:12px;margin-bottom:6px">'+(st.side?'sub-agent · ':'')+'task #'+st.task+(task?' · '+esc(task.short.slice(0,90)):'')+' · this call '+usd(st.cost)+'</div>';
if(st.text)h+='<div class="t">'+esc(st.text)+'</div>';
for(const t of st.tools)h+='<div class="tool">▸ '+esc(t.name.replace(/^mcp__/,''))+' '+esc(t.summary)+(t.tokens?' → '+t.tokens+' tok, re-read '+t.reread+'×, '+usd(t.carry):'')+'</div>';
if(!st.text&&!st.tools.length)h+='<div class="t" style="color:var(--mute)">(thinking)</div>';
step.innerHTML=h}
scrub.addEventListener('input',()=>show(+scrub.value));show(0);
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'){scrub.value=Math.min(+scrub.max,+scrub.value+1);show(+scrub.value)}if(e.key==='ArrowLeft'){scrub.value=Math.max(0,+scrub.value-1);show(+scrub.value)}});
const box=document.getElementById('tasks');const rows=[...box.children];
document.getElementById('byCost').onclick=e=>{rows.slice().sort((x,y)=>+y.dataset.cost-+x.dataset.cost).forEach(r=>box.appendChild(r));e.target.classList.add('on');document.getElementById('byOrder').classList.remove('on')};
document.getElementById('byOrder').onclick=e=>{rows.slice().sort((x,y)=>+x.dataset.i-+y.dataset.i).forEach(r=>box.appendChild(r));e.target.classList.add('on');document.getElementById('byCost').classList.remove('on')};
</script></body></html>`;
}
