// Tests for the deterministic guards around Stage 4: dependency ordering,
// conflict detection, and the apply fallback. Each of these replaces something
// the pipeline previously trusted the model to get right with no verification.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type ApprovedFix,
  detectConflicts,
  orderFixes,
  reconcileApply,
} from "./pipeline.ts";

const fix = (
  signal_id: number,
  old_code: string,
  new_code: string,
  depends_on?: number[],
  file = "a.css",
): ApprovedFix => ({ signal_id, file, old_code, new_code, depends_on });

// ---------- orderFixes (item 12) ----------

Deno.test("orderFixes puts a dependency before the fix that depends on it", () => {
  const { ordered, cycles } = orderFixes([
    fix(20, "b", "B", [10]), // component fix, needs the token fix first
    fix(10, "a", "A"), // token fix
  ]);
  assertEquals(ordered.map((f) => f.signal_id), [10, 20]);
  assertEquals(cycles, []);
});

Deno.test("orderFixes resolves a multi-level chain", () => {
  const { ordered } = orderFixes([
    fix(30, "c", "C", [20]),
    fix(20, "b", "B", [10]),
    fix(10, "a", "A"),
  ]);
  assertEquals(ordered.map((f) => f.signal_id), [10, 20, 30]);
});

Deno.test("orderFixes is stable — independent fixes keep their input order", () => {
  // Stability matters: QA diffs the output, so the same proposals must always
  // produce the same edit sequence.
  const { ordered } = orderFixes([fix(3, "c", "C"), fix(1, "a", "A"), fix(2, "b", "B")]);
  assertEquals(ordered.map((f) => f.signal_id), [3, 1, 2]);
});

Deno.test("orderFixes keeps cycled fixes instead of dropping them, and names them", () => {
  const { ordered, cycles } = orderFixes([
    fix(10, "a", "A", [20]),
    fix(20, "b", "B", [10]),
    fix(5, "z", "Z"),
  ]);
  // the acyclic fix is ordered first; the cycle is preserved, not discarded
  assertEquals(ordered.map((f) => f.signal_id), [5, 10, 20]);
  assertEquals(cycles, [10, 20]);
});

Deno.test("orderFixes reports a depends_on pointing at a fix that isn't in the set", () => {
  // Common on a QA reapply round, where only some signals are re-sent.
  const { ordered, cycles, danglingDeps } = orderFixes([fix(20, "b", "B", [10])]);
  assertEquals(ordered.map((f) => f.signal_id), [20]);
  assertEquals(cycles, []); // a missing dep must not look like a cycle
  assertEquals(danglingDeps, [{ signal_id: 20, missing: 10 }]);
});

Deno.test("orderFixes ignores a self-dependency rather than deadlocking on it", () => {
  const { ordered, cycles } = orderFixes([fix(10, "a", "A", [10])]);
  assertEquals(ordered.map((f) => f.signal_id), [10]);
  assertEquals(cycles, []);
});

Deno.test("orderFixes moves all of a signal's fixes together across files", () => {
  const { ordered } = orderFixes([
    fix(20, "b", "B", [10], "x.css"),
    fix(10, "a", "A", undefined, "x.css"),
    fix(10, "a2", "A2", undefined, "y.css"),
  ]);
  assertEquals(ordered.map((f) => f.signal_id), [10, 10, 20]);
});

// ---------- detectConflicts (item 12) ----------

Deno.test("detectConflicts flags two fixes whose old_code regions overlap", () => {
  const files = new Map([["a.css", ".hero { color: red; background: blue; }"]]);
  const conflicts = detectConflicts([
    fix(1, "color: red; background: blue;", "color: green;"),
    fix(2, "background: blue;", "background: teal;"), // sits inside fix 1's region
  ], files);
  assertEquals(conflicts, [{ file: "a.css", winner: 1, loser: 2 }]);
});

Deno.test("detectConflicts leaves non-overlapping fixes in the same file alone", () => {
  const files = new Map([["a.css", ".a { color: red; }\n.b { color: blue; }"]]);
  const conflicts = detectConflicts([
    fix(1, "color: red;", "color: green;"),
    fix(2, "color: blue;", "color: teal;"),
  ], files);
  assertEquals(conflicts, []);
});

Deno.test("detectConflicts does not cross file boundaries", () => {
  const files = new Map([["a.css", ".x { color: red; }"], ["b.css", ".x { color: red; }"]]);
  const conflicts = detectConflicts([
    fix(1, "color: red;", "green", undefined, "a.css"),
    fix(2, "color: red;", "teal", undefined, "b.css"),
  ], files);
  assertEquals(conflicts, []);
});

// ---------- reconcileApply (item 11) ----------

const ORIGINAL = new Map([["a.css", ".hero { background: purple; }"]]);

Deno.test("reconcileApply credits the model when the edit really landed", () => {
  const model = new Map([["a.css", ".hero { background: #b91c1c; }"]]);
  const r = reconcileApply(ORIGINAL, model, [fix(9, "purple", "#b91c1c")]);
  assertEquals(r.reconciled[0].applied_by, "model");
  assertEquals(r.files.get("a.css"), ".hero { background: #b91c1c; }");
  assertEquals(r.falseClaims, []);
});

Deno.test("reconcileApply applies a fix the model silently dropped", () => {
  // Model returned the file untouched — previously this shipped as "edited".
  const model = new Map([["a.css", ".hero { background: purple; }"]]);
  const r = reconcileApply(ORIGINAL, model, [fix(9, "purple", "#b91c1c")]);
  assertEquals(r.reconciled[0].applied, true);
  assertEquals(r.reconciled[0].applied_by, "deterministic");
  assertEquals(r.files.get("a.css"), ".hero { background: #b91c1c; }");
});

Deno.test("reconcileApply flags a false applied=true self-report", () => {
  // The model claims success but its own output still contains old_code. This is
  // the failure the QA stage would otherwise catch late and expensively.
  const model = new Map([["a.css", ".hero { background: purple; /* tidied */ }"]]);
  const r = reconcileApply(ORIGINAL, model, [fix(9, "purple", "#b91c1c")], [
    { signal_id: 9, applied: true },
  ]);
  assertEquals(r.falseClaims, [9]);
  assertEquals(r.reconciled[0].applied_by, "deterministic"); // recovered anyway
});

Deno.test("reconcileApply does not flag an honestly-reported failure as a false claim", () => {
  const model = new Map([["a.css", ".hero { background: purple; }"]]);
  const r = reconcileApply(ORIGINAL, model, [fix(9, "purple", "#b91c1c")], [
    { signal_id: 9, applied: false },
  ]);
  assertEquals(r.falseClaims, []);
});

Deno.test("reconcileApply reports a fix that cannot be applied at all", () => {
  const model = new Map([["a.css", ".hero { background: purple; }"]]);
  const r = reconcileApply(ORIGINAL, model, [fix(9, "NOT IN THE FILE", "x")]);
  assertEquals(r.reconciled[0].applied, false);
  assertEquals(r.reconciled[0].applied_by, "none");
  assertEquals(r.reconciled[0].reason, "no_match");
  // and the file is left exactly as it was — never half-edited
  assertEquals(r.files.get("a.css"), ".hero { background: purple; }");
});

Deno.test("reconcileApply refuses an ambiguous match rather than guessing", () => {
  const original = new Map([["a.css", ".a { color: red; }\n.b { color: red; }"]]);
  const model = new Map(original);
  const r = reconcileApply(original, model, [fix(9, "color: red;", "color: green;")]);
  assertEquals(r.reconciled[0].applied, false);
  assertEquals(r.reconciled[0].reason, "multiple_matches");
});

Deno.test("reconcileApply handles a file the model failed to return", () => {
  const r = reconcileApply(ORIGINAL, new Map(), [fix(9, "purple", "#b91c1c", undefined, "gone.css")]);
  assertEquals(r.reconciled[0].applied_by, "none");
  assertEquals(r.reconciled[0].reason, "file_missing_from_output");
});

Deno.test("reconcileApply preserves unrelated model edits while fixing the missed one", () => {
  const original = new Map([
    ["a.css", ".hero { background: purple; }"],
    ["b.css", ".btn { color: gray; }"],
  ]);
  const model = new Map([
    ["a.css", ".hero { background: purple; }"], // fix dropped
    ["b.css", ".btn { color: #b91c1c; }"], // fix applied
  ]);
  const r = reconcileApply(original, model, [
    fix(9, "purple", "#b91c1c"),
    fix(12, "gray", "#b91c1c", undefined, "b.css"),
  ]);
  assertEquals(r.files.get("a.css"), ".hero { background: #b91c1c; }");
  assertEquals(r.files.get("b.css"), ".btn { color: #b91c1c; }");
  assert(r.reconciled.every((x) => x.applied));
});
