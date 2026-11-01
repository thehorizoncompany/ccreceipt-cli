import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICES, WHATIF, priceFor, costOfUsage, costParts } from "../src/pricing.js";

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);
const M = 1_000_000;

// One representative model id per price row, in the same order as PRICES.
const SAMPLES = [
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-mythos-5-1", "Mythos 5.x"],
  ["claude-fable-5", "Fable 5"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-opus-5", "Opus 5"],
  ["claude-opus-4-8", "Opus 4.x"],
  ["claude-opus-4-1", "Opus 4.0/4.1"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-sonnet-4-6", "Sonnet 4.x"],
  ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-haiku-4-5", "Haiku 4.5"],
  ["claude-3-5-haiku-20241022", "Haiku 3.5"],
];

test("every price row is reachable from a real model id", () => {
  assert.equal(SAMPLES.length, PRICES.length);
  for (const [model, label] of SAMPLES) assert.equal(priceFor(model)?.label, label, model);
});

test("dated and suffixed model ids match their family", () => {
  assert.equal(priceFor("claude-opus-5-5-20260915").label, "Opus 5.5");
  assert.equal(priceFor("claude-sonnet-5-5[1m]").label, "Sonnet 5.5");
});

test("every what-if model has a price", () => {
  for (const m of WHATIF) assert.ok(priceFor(m), m);
});

test("unknown models have no price and no cost", () => {
  assert.equal(priceFor("claude-nova-preview"), null);
  assert.equal(priceFor(null), null);
  assert.equal(costOfUsage({ input_tokens: M }, "claude-nova-preview"), null);
});

test("--pricing overrides win over the built-in table, by prefix", () => {
  const overrides = { "claude-opus-5-5": { in: 1, out: 2, cr: 0.1 } };
  assert.deepEqual(priceFor("claude-opus-5-5-20260915", overrides), { label: "claude-opus-5-5", in: 1, out: 2, cr: 0.1 });
  assert.equal(priceFor("claude-sonnet-5-5", overrides).label, "Sonnet 5.5");
  close(costOfUsage({ input_tokens: M, output_tokens: M }, "claude-opus-5-5", overrides), 3);
});

test("cost = input x in + output x out + cache reads x cr", () => {
  // Opus 5.5: in 4, out 20, cr 0.20
  close(costOfUsage({ input_tokens: M, output_tokens: M, cache_read_input_tokens: M }, "claude-opus-5-5"), 4 + 20 + 0.2);
});

test("5-minute cache writes cost 1.25x input, 1-hour writes 2x", () => {
  const w5 = { cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } };
  const w1 = { cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } };
  close(costOfUsage(w5, "claude-opus-5-5"), 5);
  close(costOfUsage(w1, "claude-opus-5-5"), 8);
});

test("cache writes without a 5m/1h breakdown are priced as 5-minute writes", () => {
  close(costOfUsage({ cache_creation_input_tokens: M }, "claude-opus-5-5"), 5);
});

test("fast mode doubles every part of the cost", () => {
  const u = { input_tokens: M, output_tokens: M, speed: "fast" };
  close(costOfUsage(u, "claude-opus-5-5"), 2 * (4 + 20));
  const p = costParts(u, "claude-opus-5-5");
  close(p.input, 8);
  close(p.output, 40);
});

test("costParts adds up to costOfUsage", () => {
  const u = {
    input_tokens: 1234,
    cache_creation_input_tokens: 5000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 3000 },
    cache_read_input_tokens: 90000,
    output_tokens: 777,
  };
  for (const [model] of SAMPLES) {
    const p = costParts(u, model);
    close(p.input + p.cacheWrite + p.cacheRead + p.output, costOfUsage(u, model), model);
  }
});
