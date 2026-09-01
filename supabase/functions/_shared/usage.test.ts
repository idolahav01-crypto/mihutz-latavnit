import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertModelPriced,
  buildEntry,
  cacheHitRate,
  type CostBreakdown,
  costUsd,
  meteredClaude,
  modelFamily,
  recordStageUsage,
  rollupCostBreakdown,
  type StageUsageEntry,
  totalCost,
} from "./usage.ts";

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

/** A cost-only stage entry — the only fields rollupCostBreakdown reads. */
function stage(name: string, cost: number): StageUsageEntry {
  return {
    stage: name,
    model: "claude-opus-4-8",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: cost,
    duration_ms: 0,
    at: "2026-08-25T00:00:00.000Z",
  };
}

Deno.test("rollupCostBreakdown maps each stage to its C and reconciles the total", () => {
  const entries = [
    stage("detect_part1", 0.20),
    stage("detect_part2", 0.15),
    stage("detect_part3", 0.15), // scan = 0.50
    stage("rebuild_design", 0.07),
    stage("rebuild_shell", 0.22),
    stage("rebuild_section_1", 0.18),
    stage("rebuild_section_2", 0.20), // sections = 0.38 over 2 calls
    stage("detect_after_part1", 0.25),
    stage("detect_after_part2", 0.25), // scan_after = 0.50
  ];
  const b = rollupCostBreakdown(entries);

  assertEquals(b.scan_usd, 0.5);
  assertEquals(b.scan_after_usd, 0.5);
  assertEquals(b.design_usd, 0.07);
  assertEquals(b.shell_usd, 0.22);
  assertEquals(b.sections_usd, 0.38);
  assertEquals(b.section_count, 2);
  assertEquals(b.per_section_usd, 0.19);
  assertEquals(b.other_usd, 0);
  // The rollup total must match the independent per-entry sum.
  assertEquals(b.total_usd, totalCost(entries));
});

Deno.test("rollupCostBreakdown keeps other-pipeline stages out of the C buckets but in the total", () => {
  const entries = [
    stage("detect_part1", 0.40),
    stage("transform_css_1", 0.30), // belongs to no rebuild C
    stage("qa", 0.10),
  ];
  const b = rollupCostBreakdown(entries);

  assertEquals(b.scan_usd, 0.4);
  assertEquals(b.design_usd, 0);
  assertEquals(b.sections_usd, 0);
  assertEquals(b.section_count, 0);
  assertEquals(b.per_section_usd, null); // no section call was billed
  assertEquals(b.other_usd, 0.4);
  assertEquals(b.total_usd, 0.8);
});

Deno.test("rollupCostBreakdown tests detect_after before the detect prefix", () => {
  // A naive startsWith('detect') check would bucket the after-scan as a before-scan.
  const b = rollupCostBreakdown([stage("detect_after_gap1", 0.33)]);
  assertEquals(b.scan_usd, 0);
  assertEquals(b.scan_after_usd, 0.33);
});

/* ===================================================================
   The write path. Everything above tests the arithmetic; this tests the
   part that actually puts the money on the row — which had no coverage at
   all, and was quietly destructive.
   =================================================================== */

/** Captures console.error so a test can assert it complained, and stay quiet. */
function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  return fn().then(
    (result) => { console.error = original; return { result, logged }; },
    (e) => { console.error = original; throw e; },
  );
}

interface FakeScan {
  /** What the SELECT returns; null means the read failed. */
  stored: StageUsageEntry[] | null;
  readError?: string;
  writeError?: string;
  /** Errors on the first read only, to exercise the retry. */
  transient?: boolean;
}

/** Just the surface recordStageUsage uses, without pulling in the real client. */
type AdminClient = Parameters<typeof recordStageUsage>[0];

function fakeAdmin(state: FakeScan) {
  const writes: Record<string, unknown>[] = [];
  let reads = 0;
  const admin = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                single() {
                  reads++;
                  const failing = state.stored === null ||
                    (state.readError !== undefined && !(state.transient && reads > 1));
                  return Promise.resolve(
                    failing
                      ? { data: null, error: { message: state.readError ?? "no row" } }
                      : { data: { stage_usage: state.stored }, error: null },
                  );
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          writes.push(payload);
          return {
            eq() {
              return Promise.resolve({
                error: state.writeError ? { message: state.writeError } : null,
              });
            },
          };
        },
      };
    },
  } as unknown as AdminClient;
  return { admin, writes, reads: () => reads };
}

const priorHistory: StageUsageEntry[] = [
  buildEntry("detect_part1", "claude-sonnet-5", { input_tokens: 100_000, output_tokens: 6000 }, 40_000, "medium"),
  buildEntry("rebuild_design", "claude-opus-4-8", { input_tokens: 6000, output_tokens: 1000 }, 20_000, "medium"),
  buildEntry("rebuild_shell", "claude-opus-4-8", { input_tokens: 8000, output_tokens: 4000 }, 60_000, "high"),
];
const nextEntry = () =>
  buildEntry("rebuild_section_1", "claude-opus-4-8", { input_tokens: 9000, output_tokens: 2500 }, 55_000, "high");

Deno.test("recordStageUsage appends to the history and rewrites all three columns together", async () => {
  const { admin, writes } = fakeAdmin({ stored: priorHistory });
  await recordStageUsage(admin, "scan-1", nextEntry());

  assertEquals(writes.length, 1);
  const wrote = writes[0];
  assertEquals((wrote.stage_usage as StageUsageEntry[]).length, 4);
  // total and breakdown are derived from the same array in the same write, so
  // they can never disagree with it.
  assertEquals(wrote.total_cost_usd, totalCost([...priorHistory, nextEntry()]));
  assertEquals(
    (wrote.cost_breakdown as CostBreakdown).total_usd,
    rollupCostBreakdown([...priorHistory, nextEntry()]).total_usd,
  );
});

Deno.test("REGRESSION: a failed read must not overwrite the history with a single entry", async () => {
  // The old code ignored the read's error, so `data` came back null, the array
  // collapsed to [entry], and the UPDATE deleted every cost line the scan had.
  // A blip in PostgREST cost us the whole site's measurement, silently.
  const { admin, writes, reads } = fakeAdmin({ stored: priorHistory, readError: "connection reset" });
  const { logged } = await captureErrors(() => recordStageUsage(admin, "scan-1", nextEntry()));

  assertEquals(writes.length, 0); // nothing written at all — the row is untouched
  assertEquals(reads(), 2); // tried twice before giving up
  assert(logged.some((l) => l.includes("SKIPPING write")));
  assert(logged.some((l) => l.includes("scan-1") && l.includes("rebuild_section_1")));
});

Deno.test("recordStageUsage retries a transient read and then appends normally", async () => {
  const { admin, writes, reads } = fakeAdmin({
    stored: priorHistory,
    readError: "timeout",
    transient: true,
  });
  await captureErrors(() => recordStageUsage(admin, "scan-1", nextEntry()));

  assertEquals(reads(), 2);
  assertEquals(writes.length, 1);
  assertEquals((writes[0].stage_usage as StageUsageEntry[]).length, 4);
});

Deno.test("recordStageUsage reports a failed write instead of swallowing it", async () => {
  const { admin, writes } = fakeAdmin({ stored: priorHistory, writeError: "deadlock detected" });
  const { logged } = await captureErrors(() => recordStageUsage(admin, "scan-1", nextEntry()));

  assertEquals(writes.length, 1); // it tried
  assert(logged.some((l) => l.includes("write failed") && l.includes("deadlock detected")));
});

Deno.test("recordStageUsage never throws into the pipeline, whatever the client does", async () => {
  const exploding = {
    from() { throw new Error("client is gone"); },
  } as unknown as AdminClient;
  const { logged } = await captureErrors(() => recordStageUsage(exploding, "scan-1", nextEntry()));
  assert(logged.some((l) => l.includes("client is gone")));
});

Deno.test("recordStageUsage starts a fresh scan's history from empty", async () => {
  const { admin, writes } = fakeAdmin({ stored: [] });
  await recordStageUsage(admin, "scan-new", nextEntry());
  assertEquals((writes[0].stage_usage as StageUsageEntry[]).length, 1);
});

/* ===== metering is structural, not remembered ===== */

function claudeServer(handler: () => Response) {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, handler);
  const { port } = server.addr as Deno.NetAddr;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { ac.abort(); await server.finished; },
  };
}

const CALL = {
  apiKey: "sk-test",
  model: "claude-opus-4-8",
  effort: "high" as const,
  maxTokens: 1500,
  system: "S",
  userContent: "U",
  stream: false,
};

Deno.test("meteredClaude records the call, its cost, and the model that charged it", async () => {
  const srv = claudeServer(() =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: '{"ok":true}' }],
        usage: { input_tokens: 20_000, output_tokens: 5000 },
      }),
      { headers: { "content-type": "application/json" } },
    ));
  const { admin, writes } = fakeAdmin({ stored: [] });

  const res = await meteredClaude(
    { admin, scanId: "scan-1", stage: "rebuild_shell" },
    { ...CALL, baseUrl: srv.baseUrl },
  );
  await srv.close();

  assertEquals(res.json, { ok: true });
  const entry = (writes[0].stage_usage as StageUsageEntry[])[0];
  assertEquals(entry.stage, "rebuild_shell");
  assertEquals(entry.model, "claude-opus-4-8");
  // 20k input at $5/MTok + 5k output at $25/MTok
  assertEquals(entry.cost_usd, 0.225);
  assertEquals((writes[0].cost_breakdown as CostBreakdown).models.shell, "opus");
  assertEquals((writes[0].cost_breakdown as CostBreakdown).model_ids.shell, ["claude-opus-4-8"]);
});

Deno.test("meteredClaude records a billed failure as partial and still rethrows", async () => {
  const srv = claudeServer(() =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "this will not parse" }],
        usage: { input_tokens: 20_000, output_tokens: 5000 },
      }),
      { headers: { "content-type": "application/json" } },
    ));
  const { admin, writes } = fakeAdmin({ stored: [] });

  let caught: unknown = null;
  try {
    await meteredClaude(
      { admin, scanId: "scan-1", stage: "rebuild_section_3" },
      { ...CALL, baseUrl: srv.baseUrl },
    );
  } catch (e) {
    caught = e;
  }
  await srv.close();

  // The caller sees exactly the error it saw before — the client's retry logic
  // is untouched.
  assertEquals((caught as Error).message, "model_returned_malformed_json");
  // ...and the money it cost is on the row.
  const entry = (writes[0].stage_usage as StageUsageEntry[])[0];
  assertEquals(entry.partial, true);
  assertEquals(entry.error, "model_returned_malformed_json");
  assertEquals(entry.cost_usd, 0.225);
});

Deno.test("meteredClaude writes nothing when the request was never billed", async () => {
  const srv = claudeServer(() => new Response("overloaded", { status: 529 }));
  const { admin, writes } = fakeAdmin({ stored: [] });

  let threw = false;
  try {
    await meteredClaude(
      { admin, scanId: "scan-1", stage: "rebuild_shell" },
      { ...CALL, baseUrl: srv.baseUrl },
    );
  } catch { threw = true; }
  await srv.close();

  assert(threw);
  assertEquals(writes.length, 0); // a 529 costs nothing and must not look like a call
});

/* ===== the guard against a silent $0 ===== */

Deno.test("assertModelPriced fails loudly for a model the rate table cannot price", () => {
  assertModelPriced("claude-opus-4-8"); // the models the stages actually use
  assertModelPriced("claude-sonnet-5");
  assertThrows(
    () => assertModelPriced("claude-opus-5"),
    Error,
    "unpriced_model_claude-opus-5",
  );
});

Deno.test("an unpriced model is flagged on the entry rather than passing as free", () => {
  const original = console.error;
  console.error = () => {};
  const entry = buildEntry("rebuild_shell", "claude-opus-5", { input_tokens: 1_000_000 }, 100, "high");
  console.error = original;
  assertEquals(entry.cost_usd, 0);
  assertEquals(entry.unpriced, true); // findable in SQL
  assertEquals(buildEntry("rebuild_shell", "claude-opus-4-8", {}, 1).unpriced, undefined);
});

/* ===== what the rollup now has to carry ===== */

Deno.test("rollupCostBreakdown names the model behind every C", () => {
  const b = rollupCostBreakdown([
    buildEntry("detect_part1", "claude-sonnet-5", { input_tokens: 100_000 }, 1),
    buildEntry("detect_after_part1", "claude-sonnet-5", { input_tokens: 100_000 }, 1),
    buildEntry("rebuild_design", "claude-opus-4-8", { input_tokens: 6000 }, 1),
    buildEntry("rebuild_shell", "claude-opus-4-8", { input_tokens: 8000 }, 1),
    buildEntry("rebuild_section_1", "claude-opus-4-8", { input_tokens: 9000 }, 1),
    buildEntry("features_plan", "claude-opus-4-8", { input_tokens: 3000 }, 1),
  ]);
  // The headline: which model ran which part of the run.
  assertEquals(b.models.scan, "sonnet");
  assertEquals(b.models.scan_after, "sonnet");
  assertEquals(b.models.design, "opus");
  assertEquals(b.models.shell, "opus");
  assertEquals(b.models.sections, "opus");
  assertEquals(b.models.other, "opus");
  // The exact versions stay too — they are what the rates are keyed on.
  assertEquals(b.model_ids.scan, ["claude-sonnet-5"]);
  assertEquals(b.model_ids.sections, ["claude-opus-4-8"]);
});

Deno.test("a C that made no call reports no model rather than a stale one", () => {
  const b = rollupCostBreakdown([
    buildEntry("detect_part1", "claude-sonnet-5", { input_tokens: 100_000 }, 1),
  ]);
  assertEquals(b.models.scan, "sonnet");
  assertEquals(b.models.design, "");
  assertEquals(b.models.sections, "");
  assertEquals(b.model_ids.shell, []);
});

Deno.test("modelFamily reduces a version to the name the pipeline is reasoned in", () => {
  assertEquals(modelFamily("claude-opus-4-8"), "opus");
  assertEquals(modelFamily("claude-sonnet-5"), "sonnet");
  assertEquals(modelFamily("claude-haiku-4-5"), "haiku");
  assertEquals(modelFamily("claude-opus-5"), "opus");
  // Anything that is not a claude id is passed through whole rather than cut.
  assertEquals(modelFamily("gpt-9"), "gpt-9");
  assertEquals(modelFamily(""), "");
});

Deno.test("two versions of one family read as that family; two families read as both", () => {
  const original = console.error; // claude-opus-5 has no rate yet; that warning is another test's subject
  console.error = () => {};
  const sameFamily = rollupCostBreakdown([
    buildEntry("rebuild_section_1", "claude-opus-4-8", { input_tokens: 9000 }, 1),
    buildEntry("rebuild_section_2", "claude-opus-5", { input_tokens: 9000 }, 1),
  ]);
  console.error = original;
  assertEquals(sameFamily.models.sections, "opus");
  assertEquals(sameFamily.model_ids.sections, ["claude-opus-4-8", "claude-opus-5"]);

  const mixed = rollupCostBreakdown([
    buildEntry("rebuild_section_1", "claude-opus-4-8", { input_tokens: 9000 }, 1),
    buildEntry("rebuild_section_2", "claude-sonnet-5", { input_tokens: 9000 }, 1),
  ]);
  // Picking one would hide a model change that invalidates the calibration.
  assertEquals(mixed.models.sections, "opus+sonnet");
});

Deno.test("a failed section call costs money but does not inflate N", () => {
  const failed = buildEntry("rebuild_section_2", "claude-opus-4-8", { input_tokens: 9000, output_tokens: 1000 }, 1, "high");
  failed.partial = true;
  failed.error = "stage_timeout_after_135s";
  const b = rollupCostBreakdown([
    buildEntry("rebuild_section_1", "claude-opus-4-8", { input_tokens: 9000, output_tokens: 4000 }, 1, "high"),
    failed,
    buildEntry("rebuild_section_2", "claude-opus-4-8", { input_tokens: 9000, output_tokens: 4000 }, 1, "high"),
  ]);
  assertEquals(b.section_count, 2); // two sections were built, not three
  assertEquals(b.failed_calls, 1);
  assertEquals(b.failed_usd, failed.cost_usd);
  // The waste is inside sections_usd and the total — it was really spent.
  assertEquals(b.sections_usd, Number((0.145 * 2 + failed.cost_usd).toFixed(6)));
  assertEquals(b.per_section_usd, 0.145);
});

Deno.test("design re-proposals are counted on their own, not folded into C_design", () => {
  const b = rollupCostBreakdown([
    buildEntry("rebuild_design", "claude-opus-4-8", { input_tokens: 6000, output_tokens: 1000 }, 1),
    buildEntry("rebuild_design_reproposal_2", "claude-opus-4-8", { input_tokens: 6000, output_tokens: 1000 }, 1),
    buildEntry("rebuild_design_reproposal_3", "claude-opus-4-8", { input_tokens: 6000, output_tokens: 1000 }, 1),
  ]);
  // C_design stays a per-call constant the equation can use...
  assertEquals(b.design_usd, 0.055);
  // ...and the uncapped per-run driver stays countable instead of hiding in `other`.
  assertEquals(b.design_reproposal_count, 2);
  assertEquals(b.design_reproposal_usd, 0.11);
  assertEquals(b.other_usd, 0);
  assertEquals(b.total_usd, 0.165);
});
