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


// ============================================================
// What the catalogue itself decides, before any model sees a site
// ============================================================

/**
 * Signals this product does not score a site on.
 *
 * Two reasons, both about honesty rather than difficulty.
 *
 * Images: the scan bundle filters binary files out, so no image ever reaches
 * the audit. Reporting on a file format we never opened, or on responsive
 * sizes we never measured, is a finding with no evidence behind it.
 *
 * Infrastructure: a CDN, a build pipeline and a CMS are not properties of the
 * page, they are properties of how the owner runs their site. Counting them
 * means telling a small business their hand-written page is defective for being
 * a hand-written page, and there is no fix we could ever apply or they could
 * reasonably supply.
 *
 * Marked applicable:false rather than deleted, so the catalogue stays 110 and
 * every score keeps the same denominator.
 */
export const NOT_COUNTED: ReadonlyArray<{ id: number; because: string }> = [
  { id: 36, because: "תמונות אינן נכללות בסריקה, ולכן הפורמט שלהן מעולם לא נבדק" },
  { id: 100, because: "תמונות אינן נכללות בסריקה, ולכן הגדלים שלהן מעולם לא נבדקו" },
  { id: 41, because: "תלוי בשירות אחסון, לא בקוד של האתר" },
  { id: 101, because: "תלוי במערכת בנייה, לא בקוד של האתר" },
  { id: 106, because: "דורש מערכת ניהול תוכן — החלטה עסקית, לא פגם באתר" },
];

/**
 * Signals no automated rebuild can clear, because clearing them needs a fact
 * only the site's owner holds.
 *
 * The catalogue's own `auto_fixable` field does not answer this question. It
 * marks a standard hero template and a four-card grid as unfixable — both are
 * design choices our own builder makes and can simply not make — while marking
 * the Israeli regulatory items as merely "partial", and a real rebuild cleared
 * three of those. It was written for the patch-in-place path, not for a rebuild.
 *
 * This list answers one question instead: is a real-world fact missing? A
 * company number, a physical address, a photograph, a customer's name, the
 * source behind a statistic, an analytics account. The iron rule is that we
 * never invent those, so these stay lit until the owner supplies them — which
 * makes them a to-do list for the owner, not a failure of ours.
 */
export const OWNER_INPUT: ReadonlyArray<{ id: number; needs: string }> = [
  { id: 24, needs: "business_details" },
  { id: 92, needs: "business_details" },
  { id: 93, needs: "legal_documents" },
  { id: 96, needs: "legal_documents" },
  { id: 31, needs: "real_images" },
  { id: 98, needs: "real_images" },
  { id: 104, needs: "real_images" },
  { id: 50, needs: "real_numbers" },
  { id: 54, needs: "real_numbers" },
  { id: 105, needs: "real_numbers" },
  { id: 62, needs: "analytics_account" },
  { id: 102, needs: "analytics_account" },
  { id: 25, needs: "more_content" },
  { id: 65, needs: "more_content" },
  { id: 91, needs: "more_content" },
  { id: 107, needs: "more_content" },
];

/**
 * Stamp the catalogue's own decisions onto a finished detection.
 *
 * Deterministic and applied after every pass, so a model that returns a signal
 * as present cannot put an uncountable one back into the score, and so the
 * owner-input marks survive into storage for the dashboard to read.
 */
export function applyCatalogueRules(detection: DetectionLike): void {
  const notCounted = new Map(NOT_COUNTED.map((n) => [n.id, n.because]));
  const ownerInput = new Map(OWNER_INPUT.map((o) => [o.id, o.needs]));

  for (const s of detection.signals ?? []) {
    const id = Number(s.id);
    const because = notCounted.get(id);
    if (because !== undefined) {
      s.applicable = false;
      s.not_counted = true;
      s.explanation = because;
      continue;
    }
    const needs = ownerInput.get(id);
    if (needs !== undefined) s.needs_owner_input = needs;
  }
}
