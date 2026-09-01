// Per-stage token / cost accounting (spec §7).
//
// Every stage already receives `usage` from the Messages API — including
// cache_read_input_tokens, which is the only way to tell whether the prompt
// caching in anthropic.ts is actually paying off. Until now that object was
// returned to the client and then dropped. This module turns it into a durable,
// appended-to record on the scans row so we can answer the three questions the
// spec asks: what does a scan cost, what fraction of input tokens came from
// cache, and what fraction of scans pass QA on the first round.
//
// Cost is computed here rather than in SQL so the rates live next to the model
// constant they belong to.

import {
  callClaude,
  ClaudeCallError,
  type ClaudeCallOptions,
  type ClaudeResult,
  type ClaudeUsage,
  hasBilledTokens,
} from "./anthropic.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** USD per million tokens. Cache reads bill at ~0.1x input; writes at ~1.25x. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Fast mode is billed at its own rates — exactly 2x standard on Opus 4.8
 * ($10/$50 per MTok vs $5/$25) — and the cache multipliers stack on top of
 * THESE numbers, not the standard ones. detect runs in fast mode to fit the
 * edge-function wall clock, so pricing it at standard rates would under-report
 * every scan by half and make the whole cost metric misleading.
 */
export const FAST_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 10, output: 50 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface StageUsageEntry {
  stage: string;
  model: string;
  effort?: string;
  /** "fast" when the call was billed at fast-mode rates. */
  speed?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  duration_ms: number;
  at: string;
  /**
   * The call was billed but never delivered a usable answer (timed out
   * mid-stream, or came back malformed). Its cost is real and counts toward the
   * total; it is flagged so the waste factor can be measured instead of guessed,
   * and so a failed section call does not inflate `section_count`.
   */
  partial?: boolean;
  /** Why the call failed. Only set alongside `partial`. */
  error?: string;
  /**
   * No published rate for this model, so `cost_usd` is 0 and UNDERSTATES the
   * real spend. Findable in SQL, because a silent zero is worse than a loud one.
   */
  unpriced?: boolean;
}

/**
 * Cost of one call in USD. `input_tokens` is only the UNCACHED remainder — the
 * cached portion is billed separately and much cheaper — so all three input
 * buckets are priced independently rather than summed.
 */
export function costUsd(model: string, usage: ClaudeUsage, speed?: string): number {
  const isFast = (usage.speed ?? speed) === "fast";
  // Fall back to standard rates if a model has no published fast tier, rather
  // than silently pricing at 0.
  const rate = (isFast ? FAST_PRICING[model] : undefined) ?? PRICING[model];
  if (!rate) return 0;
  const perM = (n: number, price: number) => ((n ?? 0) / 1_000_000) * price;
  return (
    perM(usage.input_tokens ?? 0, rate.input) +
    perM(usage.cache_read_input_tokens ?? 0, rate.input * CACHE_READ_MULTIPLIER) +
    perM(usage.cache_creation_input_tokens ?? 0, rate.input * CACHE_WRITE_MULTIPLIER) +
    perM(usage.output_tokens ?? 0, rate.output)
  );
}

/** True when this model has a published rate and can be costed. */
export function isModelPriced(model: string): boolean {
  return !!PRICING[model];
}

/**
 * Fail at module load — before a single paid call — when a stage is wired to a
 * model this table cannot price. `costUsd` deliberately returns 0 rather than
 * throwing mid-pipeline (a metrics gap must never destroy a build the customer
 * already paid for), but a 0 that nobody notices is how a whole calibration run
 * ends up recording no money at all. This is where it gets noticed instead.
 */
export function assertModelPriced(model: string): void {
  if (!isModelPriced(model)) {
    throw new Error(
      `unpriced_model_${model}: add it to PRICING in _shared/usage.ts before running this stage`,
    );
  }
}

export function buildEntry(
  stage: string,
  model: string,
  usage: ClaudeUsage,
  durationMs: number,
  effort?: string,
  speed?: string,
): StageUsageEntry {
  // Prefer what the API says it actually billed over what we asked for — a
  // request can fall back to standard speed, and the cost must follow reality.
  const billedSpeed = usage.speed ?? speed;
  const priced = isModelPriced(model);
  if (!priced) {
    console.error(
      `[usage] no rate for model "${model}" (stage ${stage}) — recording cost_usd 0, which understates real spend`,
    );
  }
  return {
    stage,
    model,
    effort,
    speed: billedSpeed,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: Number(costUsd(model, usage, billedSpeed).toFixed(6)),
    duration_ms: durationMs,
    at: new Date().toISOString(),
    ...(priced ? {} : { unpriced: true }),
  };
}

/**
 * Share of billed input tokens that were served from cache, 0-1. This is the
 * headline number for whether the fixed system prompts are cached correctly —
 * if it stays at 0 across repeated scans, something is changing the prefix bytes
 * between calls (see the caching notes in anthropic.ts).
 */
export function cacheHitRate(entries: StageUsageEntry[]): number {
  let cached = 0;
  let total = 0;
  for (const e of entries) {
    cached += e.cache_read_input_tokens;
    total += e.input_tokens + e.cache_read_input_tokens + e.cache_creation_input_tokens;
  }
  return total === 0 ? 0 : cached / total;
}

export function totalCost(entries: StageUsageEntry[]): number {
  return Number(entries.reduce((sum, e) => sum + e.cost_usd, 0).toFixed(4));
}

/**
 * The actual cost of each C-category for one site, rolled up from stage_usage.
 *
 * The pricing model reasons in C-categories (scan, design, shell, sections,
 * after-scan), but stage_usage records one entry PER CALL — three detect parts,
 * a rebuild_design, a rebuild_shell, one rebuild_section_N per section. This maps
 * each entry to its category by stage name and sums the real cost, so the price
 * of every C for this specific site is one object rather than a hand-sum. It is
 * what a future estimate calibrates against: measured, not guessed.
 *
 * `section_count` counts only the sections that cost a model call — a widget
 * section is built deterministically and records no usage, so it never appears
 * here, which is exactly the N the build-cost formula multiplies.
 */
/**
 * The model family behind a model id: "claude-opus-4-8" -> "opus". This is how
 * the pipeline is actually reasoned and talked about — the scan runs on Sonnet,
 * the build on Opus — so it is the headline the rollup carries, with the exact
 * version kept alongside it in `model_ids` (the version is what sets the price,
 * so it cannot be dropped either).
 */
export function modelFamily(model: string): string {
  const m = (model ?? "").trim();
  if (!m) return "";
  if (!m.startsWith("claude-")) return m;
  return m.slice("claude-".length).split("-")[0] || m;
}

/**
 * Which model each C was actually built with. The per-call `model` field has
 * always been on stage_usage, but the rollup — the thing the cost model reads —
 * did not carry it, so a row's $2.04 could not be attributed to the model that
 * charged it. Every measured constant is only valid for a given model, so a
 * model change that is not visible here silently invalidates the calibration.
 *
 * One readable name per C ("sonnet", "opus"), empty when that C made no call.
 * A category that genuinely spanned two families reads "opus+sonnet" rather
 * than picking one and lying about the other.
 */
export interface CostBreakdownModels {
  scan: string;
  scan_after: string;
  design: string;
  shell: string;
  sections: string;
  other: string;
}

/** The exact versions behind each C — what the rates are keyed on. */
export interface CostBreakdownModelIds {
  scan: string[];
  scan_after: string[];
  design: string[];
  shell: string[];
  sections: string[];
  other: string[];
}

export interface CostBreakdown {
  scan_usd: number;
  scan_after_usd: number;
  /** The ONE design call the build-cost equation models. */
  design_usd: number;
  /**
   * Extra design directions the user asked for. Kept out of design_usd so the
   * equation's C_design stays a per-call constant, and out of other_usd so it
   * is not mixed with unrelated pipelines: it is an uncapped, per-run driver
   * that the equation does not model at all, and it has to stay countable.
   */
  design_reproposal_usd: number;
  design_reproposal_count: number;
  shell_usd: number;
  sections_usd: number;
  section_count: number;
  /**
   * The clean per-section constant the equation multiplies by N: the cost of the
   * section calls that actually BUILT a section, over how many they built.
   * Failed calls are excluded from both halves — they belong to the waste
   * factor, and mixing them in here would inflate C_section and deflate the
   * waste at the same time. Null when no section call was billed.
   */
  per_section_usd: number | null;
  /** Any stage that maps to no C-category (other pipelines: transform, qa, features). */
  other_usd: number;
  /** Calls that were billed but produced nothing usable (timeout / malformed). */
  failed_calls: number;
  /** Cost of those calls. Included in every bucket above and in total_usd. */
  failed_usd: number;
  /** The model family behind each C: "sonnet", "opus", "haiku". */
  models: CostBreakdownModels;
  /** The exact model versions behind each C. */
  model_ids: CostBreakdownModelIds;
  /** Sum of every entry — reconciles with total_cost_usd / totalCost(). */
  total_usd: number;
}

export function rollupCostBreakdown(entries: StageUsageEntry[]): CostBreakdown {
  let scan = 0, scanAfter = 0, design = 0, shell = 0, sections = 0, sectionCount = 0, other = 0;
  let designReproposal = 0, reproposals = 0;
  let sectionsClean = 0;
  let failedCalls = 0, failedUsd = 0;
  const models: Record<keyof CostBreakdownModelIds, Set<string>> = {
    scan: new Set(), scan_after: new Set(), design: new Set(),
    shell: new Set(), sections: new Set(), other: new Set(),
  };
  for (const e of entries) {
    const s = e.stage ?? "";
    const c = e.cost_usd ?? 0;
    const m = e.model ?? "";
    const seen = (k: keyof CostBreakdownModelIds) => { if (m) models[k].add(m); };
    if (e.partial) {
      failedCalls += 1;
      failedUsd += c;
    }
    // Order matters: "detect_after" must be tested before the "detect" prefix.
    if (s.startsWith("detect_after")) { scanAfter += c; seen("scan_after"); }
    else if (s.startsWith("detect")) { scan += c; seen("scan"); }
    else if (s.startsWith("rebuild_design_reproposal")) { designReproposal += c; reproposals += 1; seen("design"); }
    else if (s === "rebuild_design") { design += c; seen("design"); }
    else if (s === "rebuild_shell") { shell += c; seen("shell"); }
    else if (s.startsWith("rebuild_section")) {
      sections += c;
      seen("sections");
      // A call that timed out or came back malformed cost money but built no
      // section. Counting it would inflate N and drag per_section_usd down —
      // the two numbers the build-cost equation is calibrated from.
      if (!e.partial) {
        sectionCount += 1;
        sectionsClean += c;
      }
    } else { other += c; seen("other"); }
  }
  const r = (n: number) => Number(n.toFixed(6));
  const list = (k: keyof CostBreakdownModelIds) => [...models[k]].sort();
  // Two versions of the same family collapse to one name; two families do not.
  const family = (k: keyof CostBreakdownModelIds) =>
    [...new Set(list(k).map(modelFamily))].sort().join("+");
  return {
    scan_usd: r(scan),
    scan_after_usd: r(scanAfter),
    design_usd: r(design),
    design_reproposal_usd: r(designReproposal),
    design_reproposal_count: reproposals,
    shell_usd: r(shell),
    sections_usd: r(sections),
    section_count: sectionCount,
    per_section_usd: sectionCount ? r(sectionsClean / sectionCount) : null,
    other_usd: r(other),
    failed_calls: failedCalls,
    failed_usd: r(failedUsd),
    models: {
      scan: family("scan"),
      scan_after: family("scan_after"),
      design: family("design"),
      shell: family("shell"),
      sections: family("sections"),
      other: family("other"),
    },
    model_ids: {
      scan: list("scan"),
      scan_after: list("scan_after"),
      design: list("design"),
      shell: list("shell"),
      sections: list("sections"),
      other: list("other"),
    },
    total_usd: r(scan + scanAfter + design + designReproposal + shell + sections + other),
  };
}

/**
 * Append one stage's usage to the scan and refresh the running total.
 *
 * Read-modify-write rather than a jsonb append in SQL: the pipeline stages run
 * strictly one at a time per scan (each is gated on the previous stage's
 * pipeline_status), so there is no concurrent writer to lose an entry to.
 *
 * The read is CHECKED, and a failed read aborts the write. Ignoring the read's
 * error was not a missing metric — it was a destructive one: `data` comes back
 * null, the array collapses to `[entry]`, and the UPDATE overwrites every cost
 * line the scan had recorded, taking total_cost_usd and cost_breakdown down
 * with it. Losing one call's metrics is a scratch; losing a whole site's is the
 * dataset. So: read once, retry once, and if the row still cannot be read,
 * write nothing and say so.
 *
 * Failures never propagate — losing a metrics row must not fail a scan that
 * otherwise succeeded — but they are no longer silent.
 */
export async function recordStageUsage(
  admin: SupabaseClient,
  scanId: string,
  entry: StageUsageEntry,
): Promise<void> {
  try {
    let prior: StageUsageEntry[] | null = null;
    for (let attempt = 1; attempt <= 2 && prior === null; attempt++) {
      const { data, error } = await admin
        .from("scans")
        .select("stage_usage")
        .eq("id", scanId)
        .single();
      if (error || !data) {
        console.error(
          `[usage] read of stage_usage failed for scan ${scanId} (attempt ${attempt}/2, stage ${entry.stage}): ${error?.message ?? "no row"}`,
        );
        continue;
      }
      prior = (data.stage_usage ?? []) as StageUsageEntry[];
    }
    if (prior === null) {
      // Refusing to write is the whole point: an append we cannot base on the
      // existing array is a deletion of it.
      console.error(
        `[usage] SKIPPING write for scan ${scanId} stage ${entry.stage} ($${entry.cost_usd}) — history could not be read and must not be overwritten`,
      );
      return;
    }

    const entries: StageUsageEntry[] = [...prior, entry];
    const { error: writeError } = await admin
      .from("scans")
      .update({
        stage_usage: entries,
        total_cost_usd: totalCost(entries),
        // Derived from the same entries in the same write, so the per-C rollup
        // can never drift from stage_usage or total_cost_usd.
        cost_breakdown: rollupCostBreakdown(entries),
      })
      .eq("id", scanId);
    if (writeError) {
      console.error(
        `[usage] write failed for scan ${scanId} stage ${entry.stage} ($${entry.cost_usd}): ${writeError.message}`,
      );
    }
  } catch (e) {
    console.error(
      `[usage] unexpected failure recording ${entry.stage} for scan ${scanId}: ${(e as Error)?.message ?? e}`,
    );
  }
}

/**
 * `callClaude` + the usage write, as one call that cannot be half-done.
 *
 * Every stage used to pair a bare `callClaude` with a `recordStageUsage` on the
 * line after it, which meant two things: a new stage could forget the second
 * line, and — far worse — a call that THREW skipped it entirely. Timeouts and
 * malformed replies are billed, and the client retries both, so the calls that
 * cost the most were exactly the ones recorded as $0.00. Routing every stage
 * through here makes the metering structural instead of remembered: a call that
 * fails after being billed still lands as a `partial` entry carrying its real
 * cost, and the error goes on to the caller untouched.
 */
export async function meteredClaude(
  ctx: {
    admin: SupabaseClient;
    scanId: string;
    /** The stage name the rollup maps to a C-category. */
    stage: string;
    /** Start of the wider stage, when the duration should cover more than the call. */
    startedAt?: number;
  },
  opts: ClaudeCallOptions,
): Promise<ClaudeResult> {
  const startedAt = ctx.startedAt ?? Date.now();
  try {
    const res = await callClaude(opts);
    await recordStageUsage(
      ctx.admin,
      ctx.scanId,
      buildEntry(ctx.stage, opts.model, res.usage, Date.now() - startedAt, opts.effort, opts.speed),
    );
    return res;
  } catch (e) {
    const usage = e instanceof ClaudeCallError ? e.usage : undefined;
    if (hasBilledTokens(usage)) {
      const entry = buildEntry(
        ctx.stage, opts.model, usage!, Date.now() - startedAt, opts.effort, opts.speed,
      );
      entry.partial = true;
      entry.error = String((e as Error)?.message ?? e).slice(0, 200);
      await recordStageUsage(ctx.admin, ctx.scanId, entry);
    }
    throw e;
  }
}
