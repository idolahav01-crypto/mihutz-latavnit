// The catalogue is fixed at 110 signals, and every finished scan must account
// for all of them.
//
// This is not pedantry about completeness — it is what makes two scores
// comparable. computeScore divides by the signals it is handed, so a signal the
// model never returned leaves the denominator instead of counting as a pass,
// and the score moves for a reason that has nothing to do with the site.
// Measured: two scans of one unchanged project returned 93 and 88 signals and
// scored 53 and 44. On a fixed denominator the same two runs are 49 and 42.

import signals from "./signals.json" with { type: "json" };

interface DetectionLike {
  signals?: Array<Record<string, unknown>>;
}

/**
 * Signals the model was asked about and simply never returned.
 *
 * Measured on two consecutive scans of one unchanged site: the model returned
 * 93 signals on the first and 88 on the second, and every id it dropped came
 * from the tail of its assigned list. This was not truncation — the pass used
 * 3,246 of its 32,000 output tokens and 45 of its 150 seconds. It just stopped
 * early.
 *
 * The damage is in the scoring, not the reporting. computeScore divides by the
 * signals it was handed, so a dropped signal leaves the denominator instead of
 * counting as a pass, and the score moves for a reason that has nothing to do
 * with the site. Two runs over identical bytes scored 53 and 44; on a fixed
 * denominator the same two runs are 49 and 42.
 */
export function missingIds(detection: DetectionLike): number[] {
  const have = new Set((detection.signals ?? []).map((s) => Number(s.id)));
  return (signals as Array<{ id: number }>).map((s) => s.id).filter((id) => !have.has(id));
}

/**
 * Record an unevaluated signal as an explicit pass rather than a hole. Absent
 * is the honest default — we have no evidence it is present, and evidence is
 * what present=true costs — but confidence 0 marks it as never looked at, so a
 * scan that skipped half the catalogue cannot masquerade as a clean one.
 */
export function fillUnevaluated(detection: DetectionLike, ids: number[]): void {
  const catalogue = new Map(
    (signals as Array<{ id: number; name: string; weight: string }>).map((s) => [s.id, s]),
  );
  const added = ids.map((id) => ({
    id,
    name: catalogue.get(id)?.name ?? `#${id}`,
    present: false,
    applicable: true,
    weight: catalogue.get(id)?.weight ?? "medium",
    confidence: 0,
    total_occurrences: 0,
    explanation: "לא הוערך בסריקה זו — הסימן נספר כתקין כדי שהציון יישאר בר-השוואה.",
    evidence: [],
  }));
  detection.signals = [...(detection.signals ?? []), ...added]
    .sort((a, b) => Number(a.id) - Number(b.id));
}

