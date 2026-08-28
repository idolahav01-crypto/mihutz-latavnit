// Did the audit actually look, or did it just come back empty?
//
// A scan that returns almost nothing has two possible causes and they demand
// opposite responses: the site really is clean, or the model failed to read it.
// Told apart wrongly, the second is the expensive one — the user is shown a
// clean bill of health for a site full of tells, and every later number is
// measured against a baseline that was never real.
//
// The tell-them-apart used to be impossible. It is possible now, and cheaply,
// because 23 signals are decided by text search: those answers arrive whatever
// the model does. If the deterministic checks found faults and the model
// returned almost none, the model is the outlier, not the site.

import { MECHANICAL_IDS } from "./mechanical.ts";

/** Below this many present signals, a site is either genuinely clean or the
 *  scan under-read it. Either way the number needs corroborating. */
const SPARSE_PRESENT = 12;

/** A model that returns fewer than this share of the faults the text searches
 *  found on the very same bytes has not read the site. */
const MODEL_CREDIBILITY = 0.5;

export interface SanityVerdict {
  /** True when the low count is corroborated and can be shown as-is. */
  trustworthy: boolean;
  /** Why, in one machine-readable word, for logs and for the client. */
  reason: "ok" | "sparse_but_corroborated" | "model_under_read";
  mechanical_present: number;
  model_present: number;
  total_present: number;
}

/**
 * Weigh what the model reported against what a text search can prove.
 *
 * Deliberately one-directional: this can only refuse to certify a suspiciously
 * clean result. It never raises a score, never marks a signal present, and
 * never touches the detection — a wrong verdict here costs a re-hunt, not a
 * fabricated finding.
 */
export function checkDetectionSanity(
  signals: Array<Record<string, unknown>>,
): SanityVerdict {
  const mech = new Set(MECHANICAL_IDS);
  let mechanicalPresent = 0;
  let modelPresent = 0;

  for (const s of signals) {
    if (s.present !== true) continue;
    if (s.applicable === false) continue;
    if (mech.has(Number(s.id))) mechanicalPresent += 1;
    else modelPresent += 1;
  }
  const total = mechanicalPresent + modelPresent;

  // Plenty found: nothing to doubt.
  if (total >= SPARSE_PRESENT) {
    return { trustworthy: true, reason: "ok", mechanical_present: mechanicalPresent, model_present: modelPresent, total_present: total };
  }

  // Sparse, and the text searches agree it is sparse — a genuinely clean site.
  // Note the guard: with no mechanical findings there is nothing to compare
  // against, so silence is not evidence of failure and the result stands.
  if (mechanicalPresent === 0 || modelPresent >= mechanicalPresent * MODEL_CREDIBILITY) {
    return {
      trustworthy: true,
      reason: "sparse_but_corroborated",
      mechanical_present: mechanicalPresent,
      model_present: modelPresent,
      total_present: total,
    };
  }

  // Sparse, but a text search found faults the model did not. The model is the
  // outlier here, and a "clean" verdict would be a fabrication.
  return {
    trustworthy: false,
    reason: "model_under_read",
    mechanical_present: mechanicalPresent,
    model_present: modelPresent,
    total_present: total,
  };
}
