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

import type { ClaudeUsage } from "./anthropic.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** USD per million tokens. Cache reads bill at ~0.1x input; writes at ~1.25x. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface StageUsageEntry {
  stage: string;
  model: string;
  effort?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  duration_ms: number;
  at: string;
}

/**
 * Cost of one call in USD. `input_tokens` is only the UNCACHED remainder — the
 * cached portion is billed separately and much cheaper — so all three input
 * buckets are priced independently rather than summed.
 */
export function costUsd(model: string, usage: ClaudeUsage): number {
  const rate = PRICING[model];
  if (!rate) return 0;
  const perM = (n: number, price: number) => ((n ?? 0) / 1_000_000) * price;
  return (
    perM(usage.input_tokens ?? 0, rate.input) +
    perM(usage.cache_read_input_tokens ?? 0, rate.input * CACHE_READ_MULTIPLIER) +
    perM(usage.cache_creation_input_tokens ?? 0, rate.input * CACHE_WRITE_MULTIPLIER) +
    perM(usage.output_tokens ?? 0, rate.output)
  );
}

export function buildEntry(
  stage: string,
  model: string,
  usage: ClaudeUsage,
  durationMs: number,
  effort?: string,
): StageUsageEntry {
  return {
    stage,
    model,
    effort,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: Number(costUsd(model, usage).toFixed(6)),
    duration_ms: durationMs,
    at: new Date().toISOString(),
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
 * Append one stage's usage to the scan and refresh the running total.
 *
 * Read-modify-write rather than a jsonb append in SQL: the pipeline stages run
 * strictly one at a time per scan (each is gated on the previous stage's
 * pipeline_status), so there is no concurrent writer to lose an entry to.
 * Failures here are swallowed — losing a metrics row must never fail a scan that
 * otherwise succeeded.
 */
export async function recordStageUsage(
  admin: SupabaseClient,
  scanId: string,
  entry: StageUsageEntry,
): Promise<void> {
  try {
    const { data } = await admin
      .from("scans")
      .select("stage_usage")
      .eq("id", scanId)
      .single();
    const entries: StageUsageEntry[] = [...((data?.stage_usage ?? []) as StageUsageEntry[]), entry];
    await admin
      .from("scans")
      .update({ stage_usage: entries, total_cost_usd: totalCost(entries) })
      .eq("id", scanId);
  } catch {
    // metrics are best-effort
  }
}
