// USD per million tokens. Anthropic first-party API list prices (checked 2026-10-30).
// in = uncached input, out = output, cr = cache read.
// Cache writes: 1.25x input for the 5-minute TTL, 2x input for the 1-hour TTL (Claude Code uses 1h).
// Fast mode (usage.speed === "fast") is billed at 2x on Opus 5.5 / Opus 5 / Opus 4.8.
export const PRICES = [
  { match: /^claude-fable-5-1/,  label: "Fable 5.1",   in: 10,   out: 50,   cr: 0.25 },
  { match: /^claude-mythos-5/,   label: "Mythos 5.x",  in: 10,   out: 50,   cr: 0.25 },
  { match: /^claude-fable-5/,    label: "Fable 5",     in: 10,   out: 50,   cr: 0.25 },
  { match: /^claude-opus-5-5/,   label: "Opus 5.5",    in: 4,    out: 20,   cr: 0.20 },
  { match: /^claude-opus-5/,     label: "Opus 5",      in: 5,    out: 25,   cr: 0.50 },
  { match: /^claude-opus-4-[5-8]/, label: "Opus 4.x",  in: 5,    out: 25,   cr: 0.50 },
  { match: /^claude-opus-4/,     label: "Opus 4.0/4.1", in: 15,  out: 75,   cr: 1.50 },
  { match: /^claude-sonnet-5-5/, label: "Sonnet 5.5",  in: 2,    out: 10,   cr: 0.20 },
  { match: /^claude-sonnet-5/,   label: "Sonnet 5",    in: 2,    out: 10,   cr: 0.20 },
  { match: /^claude-sonnet-4/,   label: "Sonnet 4.x",  in: 3,    out: 15,   cr: 0.30 },
  { match: /^claude-haiku-5-5/,  label: "Haiku 5.5",   in: 0.10, out: 0.50, cr: 0.01 },
  { match: /^claude-haiku-4-5/,  label: "Haiku 4.5",   in: 1,    out: 5,    cr: 0.10 },
  { match: /^claude-3-5-haiku/,  label: "Haiku 3.5",   in: 0.80, out: 4,    cr: 0.08 },
  // OpenAI models used by Codex (standard tier, prompts under 272K tokens; checked 2026-11-01).
  // cr = cached input. Codex usage reports cached tokens inside input_tokens.
  { match: /^gpt-6-astra/,       label: "GPT-6 Astra",   in: 10,   out: 50,   cr: 1 },
  { match: /^gpt-6\.1-sol/,      label: "GPT-6.1 Sol",   in: 2,    out: 10,   cr: 0.10 },
  { match: /^gpt-6-sol/,         label: "GPT-6 Sol",     in: 2,    out: 10,   cr: 0.20 },
  { match: /^gpt-6\.1-terra/,    label: "GPT-6.1 Terra", in: 1,    out: 5,    cr: 0.05 },
  { match: /^gpt-6-luna/,        label: "GPT-6 Luna",    in: 0.10, out: 0.50, cr: 0.01 },
  { match: /^gpt-5\.[23]-codex/,  label: "GPT-5.x Codex", in: 1.75, out: 14,   cr: 0.175 },
  { match: /^gpt-5\.1-codex-mini/, label: "GPT-5.1 Codex mini", in: 0.25, out: 2, cr: 0.025 },
  { match: /^gpt-5\.1-codex/,    label: "GPT-5.1 Codex", in: 1.25, out: 10,   cr: 0.125 },
];

// Models offered in the "same tokens, other model" table.
export const WHATIF = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"];
export const WHATIF_CODEX = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"];

// Codex (OpenAI) usage: input_tokens includes cached_input_tokens and cache_write_input_tokens.
// Returns USD split by part, or null if the model has no price.
export function codexCostParts(usage, model, overrides) {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  const input = usage.input_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const written = usage.cache_write_input_tokens || 0;
  const M = 1e6;
  return {
    input: Math.max(0, input - cached - written) * p.in / M,
    cacheWrite: written * p.in * 1.25 / M,
    cacheRead: cached * p.cr / M,
    output: (usage.output_tokens || 0) * p.out / M, // includes reasoning tokens
  };
}

export function priceFor(model, overrides) {
  if (!model) return null;
  if (overrides) for (const [k, v] of Object.entries(overrides)) if (model.startsWith(k)) return { label: k, ...v };
  const p = PRICES.find((p) => p.match.test(model));
  return p ? { label: p.label, in: p.in, out: p.out, cr: p.cr } : null;
}

// usage: the raw `usage` object of one API response. Returns USD, or null if the model is unknown.
export function costOfUsage(usage, model, overrides) {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  const fast = usage.speed === "fast" ? 2 : 1;
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens == null ? usage.cache_creation_input_tokens || 0 : 0);
  const w1 = cc.ephemeral_1h_input_tokens ?? 0;
  const M = 1e6;
  const cost =
    ((usage.input_tokens || 0) * p.in +
      w5 * p.in * 1.25 +
      w1 * p.in * 2 +
      (usage.cache_read_input_tokens || 0) * p.cr +
      (usage.output_tokens || 0) * p.out) *
    fast / M;
  return cost;
}

// Split of one call's cost by token category, same rules as costOfUsage.
export function costParts(usage, model, overrides) {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  const fast = usage.speed === "fast" ? 2 : 1;
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens == null ? usage.cache_creation_input_tokens || 0 : 0);
  const w1 = cc.ephemeral_1h_input_tokens ?? 0;
  const M = 1e6;
  return {
    input: (usage.input_tokens || 0) * p.in * fast / M,
    cacheWrite: (w5 * p.in * 1.25 + w1 * p.in * 2) * fast / M,
    cacheRead: (usage.cache_read_input_tokens || 0) * p.cr * fast / M,
    output: (usage.output_tokens || 0) * p.out * fast / M,
  };
}
