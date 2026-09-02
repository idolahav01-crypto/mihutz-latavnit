import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { IMPROVEMENT_ONLY, NOT_COUNTED, OWNER_INPUT, applyCatalogueRules, fillUnevaluated, missingIds } from "./catalogue.ts";
import signals from "./signals.json" with { type: "json" };

const ALL = (signals as Array<{ id: number; weight: string }>);
const SIGNALS = ALL;
const WEIGHT_POINTS: Record<string, number> = { "very-high": 3, high: 3, medium: 2, low: 1 };

/** The same arithmetic detect/index.ts uses, so the test measures the real thing. */
function score(sigs: Array<Record<string, unknown>>) {
  let num = 0, den = 0;
  for (const s of sigs) {
    if (s.applicable === false) continue;
    const pts = WEIGHT_POINTS[String(s.weight)] ?? 2;
    den += pts;
    if (s.present === true) num += pts;
  }
  return den === 0 ? 0 : Math.round((100 * num) / den);
}

function entry(id: number, present: boolean) {
  return {
    id,
    name: `#${id}`,
    present,
    applicable: true,
    weight: ALL.find((s) => s.id === id)?.weight ?? "medium",
    confidence: 0.8,
  };
}

/** What the model actually did: answered the first N and dropped the tail. */
function droppedTail(keep: number) {
  return { signals: ALL.slice(0, keep).map((s) => entry(s.id, false)) };
}

Deno.test("missingIds names exactly the ids nobody returned", () => {
  const d = droppedTail(88);
  const missing = missingIds(d);
  assertEquals(missing.length, ALL.length - 88);
  assertEquals(missing.includes(ALL[88].id), true);
  assertEquals(missing.includes(ALL[0].id), false);
});

Deno.test("a complete detection has no gaps", () => {
  assertEquals(missingIds({ signals: ALL.map((s) => entry(s.id, false)) }).length, 0);
});

Deno.test("filling always produces the whole catalogue, once each", () => {
  const d = droppedTail(88);
  fillUnevaluated(d, missingIds(d));
  assertEquals(d.signals?.length, ALL.length);
  assertEquals(new Set(d.signals?.map((s) => Number(s.id))).size, ALL.length);
  assertEquals(missingIds(d).length, 0);
});

Deno.test("the filled entries are marked as never looked at", () => {
  const d = droppedTail(88);
  const gaps = missingIds(d);
  fillUnevaluated(d, gaps);
  for (const id of gaps) {
    const s = d.signals?.find((x) => Number(x.id) === id);
    assertEquals(s?.present, false);
    assertEquals(s?.confidence, 0, `#${id} must be flagged unevaluated`);
  }
  // and nothing the model did return was touched
  assertEquals(d.signals?.filter((s) => s.confidence === 0.8).length, 88);
});

Deno.test("the denominator no longer depends on how much the model returned", () => {
  // Two runs that agree on every signal they both evaluated, but stop in
  // different places — the exact shape of the two real scans (93 and 88).
  const a = droppedTail(93);
  const b = droppedTail(88);
  fillUnevaluated(a, missingIds(a));
  fillUnevaluated(b, missingIds(b));
  assertEquals(score(a.signals!), score(b.signals!));

  // Without the fill they are scored against different denominators, which is
  // the whole defect: the divisor depended on where the model happened to stop.
  const den = (sigs: Array<Record<string, unknown>>) =>
    sigs.reduce((n, s) => n + (WEIGHT_POINTS[String(s.weight)] ?? 2), 0);
  assertEquals(den(droppedTail(93).signals) === den(droppedTail(88).signals), false);
  assertEquals(den(a.signals!), den(b.signals!));
});

Deno.test("filling is idempotent — running it twice changes nothing", () => {
  const d = droppedTail(88);
  fillUnevaluated(d, missingIds(d));
  const once = JSON.stringify(d.signals);
  fillUnevaluated(d, missingIds(d));
  assertEquals(JSON.stringify(d.signals), once);
});

Deno.test("the result stays sorted by id", () => {
  const d = droppedTail(88);
  fillUnevaluated(d, missingIds(d));
  const ids = d.signals!.map((s) => Number(s.id));
  assertEquals(ids, [...ids].sort((x, y) => x - y));
});

// ---------- catalogue rules ----------

Deno.test("applyCatalogueRules: an uncountable signal cannot score against the site", () => {
  const detection = {
    signals: NOT_COUNTED.map((n) => ({ id: n.id, present: true, applicable: true, weight: "high" })),
  };
  applyCatalogueRules(detection);
  for (const s of detection.signals) {
    assertEquals(s.applicable, false, `#${s.id} must not be counted`);
    assertEquals((s as Record<string, unknown>).not_counted, true);
  }
});

Deno.test("applyCatalogueRules: an uncountable signal says why, in the report's language", () => {
  const detection = { signals: [{ id: 36, present: true, applicable: true, explanation: "" }] };
  applyCatalogueRules(detection);
  const s = detection.signals[0] as Record<string, unknown>;
  assert(String(s.explanation).length > 10, "a struck-out signal must explain itself");
});

Deno.test("applyCatalogueRules: owner-input signals are marked with what is missing", () => {
  const detection = { signals: OWNER_INPUT.map((o) => ({ id: o.id, present: true, applicable: true })) };
  applyCatalogueRules(detection);
  for (const s of detection.signals) {
    const needs = (s as Record<string, unknown>).needs_owner_input;
    assert(typeof needs === "string" && needs.length > 0, `#${s.id} must name what it needs`);
  }
});

Deno.test("applyCatalogueRules: fabricated-feeling content stays in the score", () => {
  // These need a fact from the owner AND are what a generator produces:
  // AI-generated faces, testimonials with nobody's name on them, a statistic
  // with no source. The mark says whose gap it is; it does not excuse it.
  for (const id of [24, 50, 54, 104, 105]) {
    const detection = { signals: [{ id, present: true, applicable: true }] };
    applyCatalogueRules(detection);
    assertEquals(detection.signals[0].applicable, true, `#${id} must still be scored`);
    assertEquals(
      (detection.signals[0] as Record<string, unknown>).improvement_only,
      undefined,
      `#${id} is a fingerprint, not a note`,
    );
  }
});

Deno.test("applyCatalogueRules: a compliance gap leaves the score but stays in the report", () => {
  // The score answers "how much does this read as AI output". A missing
  // accessibility statement is a real obligation and no evidence at all about
  // who wrote the page, so it moves to the waiting-on-you list.
  for (const id of [92, 93, 96, 62, 102, 25, 65, 91, 107, 31, 98]) {
    const detection = { signals: [{ id, present: true, applicable: true }] };
    applyCatalogueRules(detection);
    const s = detection.signals[0] as Record<string, unknown>;
    assertEquals(s.applicable, false, `#${id} must be out of the score`);
    assertEquals(s.improvement_only, true, `#${id} must be marked as a note`);
    assert(typeof s.improvement_reason === "string", `#${id} must say why`);
    assert(typeof s.needs_owner_input === "string", `#${id} must stay in the owner list`);
  }
});

Deno.test("a signal cannot be both struck out and merely a note", () => {
  const notCounted = new Set(NOT_COUNTED.map((n) => n.id));
  for (const n of IMPROVEMENT_ONLY) {
    assertFalse(notCounted.has(n.id), `#${n.id} is in both lists`);
  }
  assertEquals(IMPROVEMENT_ONLY.length, new Set(IMPROVEMENT_ONLY.map((n) => n.id)).size);
});

Deno.test("applyCatalogueRules: an ordinary signal is left exactly as it was", () => {
  const detection = { signals: [{ id: 1, present: true, applicable: true, explanation: "x" }] };
  applyCatalogueRules(detection);
  assertEquals(detection.signals[0], { id: 1, present: true, applicable: true, explanation: "x" });
});

Deno.test("catalogue lists: no id appears in both, and every id is real", () => {
  const notCounted = new Set(NOT_COUNTED.map((n) => n.id));
  const owner = new Set(OWNER_INPUT.map((o) => o.id));
  assertEquals(NOT_COUNTED.length, notCounted.size, "no duplicates in NOT_COUNTED");
  assertEquals(OWNER_INPUT.length, owner.size, "no duplicates in OWNER_INPUT");
  for (const id of owner) {
    assertFalse(notCounted.has(id), `#${id} cannot be both struck out and asked about`);
  }
  const real = new Set(SIGNALS.map((s) => s.id));
  for (const id of [...notCounted, ...owner]) assert(real.has(id), `#${id} is not in the catalogue`);
});
