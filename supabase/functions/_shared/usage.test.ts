import { assertEquals } from "jsr:@std/assert@1";
import { buildEntry, cacheHitRate, costUsd, totalCost } from "./usage.ts";

Deno.test("costUsd prices cached input far below uncached input", () => {
  // 1M uncached input on opus-4-8 = $5.00
  assertEquals(costUsd("claude-opus-4-8", { input_tokens: 1_000_000 }), 5);
  // the same 1M served from cache is ~0.1x
  assertEquals(
    costUsd("claude-opus-4-8", { cache_read_input_tokens: 1_000_000 }),
    0.5,
  );
  // writing it costs 1.25x
  assertEquals(
    costUsd("claude-opus-4-8", { cache_creation_input_tokens: 1_000_000 }),
    6.25,
  );
  // output is 5x input
  assertEquals(costUsd("claude-opus-4-8", { output_tokens: 1_000_000 }), 25);
});

Deno.test("costUsd sums the buckets independently, not by adding input to cache", () => {
  // input_tokens is only the UNCACHED remainder — double-counting it against
  // the cached span would overstate a cache-heavy scan's cost several-fold.
  const cost = costUsd("claude-opus-4-8", {
    input_tokens: 100_000,
    cache_read_input_tokens: 900_000,
    output_tokens: 20_000,
  });
  assertEquals(Number(cost.toFixed(4)), 0.5 + 0.45 + 0.5);
});

Deno.test("costUsd returns 0 for an unknown model rather than throwing", () => {
  assertEquals(costUsd("some-future-model", { input_tokens: 1_000_000 }), 0);
});

Deno.test("cacheHitRate reports cached share of all billed input tokens", () => {
  const entries = [
    buildEntry("design", "claude-opus-4-8", {
      input_tokens: 1000,
      cache_read_input_tokens: 9000,
      output_tokens: 500,
    }, 1200, "high"),
    buildEntry("qa", "claude-opus-4-8", {
      input_tokens: 5000,
      cache_read_input_tokens: 5000,
      output_tokens: 300,
    }, 900, "high"),
  ];
  // 14000 cached out of 20000 billed input tokens
  assertEquals(cacheHitRate(entries), 0.7);
  assertEquals(cacheHitRate([]), 0); // no divide-by-zero on a fresh scan
});

Deno.test("buildEntry defaults every missing usage field to 0", () => {
  const e = buildEntry("apply", "claude-opus-4-8", {}, 42);
  assertEquals(e.input_tokens, 0);
  assertEquals(e.cache_read_input_tokens, 0);
  assertEquals(e.cost_usd, 0);
  assertEquals(e.duration_ms, 42);
  assertEquals(e.stage, "apply");
});

Deno.test("totalCost sums stage entries for the per-scan number", () => {
  const entries = [
    buildEntry("design", "claude-opus-4-8", { input_tokens: 1_000_000 }, 0),
    buildEntry("apply", "claude-opus-4-8", { output_tokens: 100_000 }, 0),
  ];
  assertEquals(totalCost(entries), 7.5); // $5.00 + $2.50
});

Deno.test("costUsd bills fast mode at its own rates, not standard", () => {
  // Opus 4.8 fast mode is $10/$50 per MTok — exactly 2x standard. Pricing a
  // fast-mode call at standard rates would under-report every detect run by
  // half, which is worse than not tracking cost at all.
  assertEquals(costUsd("claude-opus-4-8", { input_tokens: 1_000_000 }, "fast"), 10);
  assertEquals(costUsd("claude-opus-4-8", { output_tokens: 1_000_000 }, "fast"), 50);
  // cache multipliers stack on top of the FAST base, not the standard one
  assertEquals(
    costUsd("claude-opus-4-8", { cache_read_input_tokens: 1_000_000 }, "fast"),
    1,
  );
});

Deno.test("costUsd trusts what the API says it billed over what we requested", () => {
  // A request can fall back to standard speed; the cost must follow reality.
  assertEquals(
    costUsd("claude-opus-4-8", { input_tokens: 1_000_000, speed: "standard" }, "fast"),
    5,
  );
});

Deno.test("costUsd falls back to standard rates for a model with no fast tier", () => {
  // Better a correct standard price than a silent 0.
  assertEquals(costUsd("claude-sonnet-5", { input_tokens: 1_000_000 }, "fast"), 3);
});

Deno.test("buildEntry records the speed tier that was billed", () => {
  const e = buildEntry("detect", "claude-opus-4-8", { output_tokens: 1_000_000 }, 10, "medium", "fast");
  assertEquals(e.speed, "fast");
  assertEquals(e.cost_usd, 50);
});
