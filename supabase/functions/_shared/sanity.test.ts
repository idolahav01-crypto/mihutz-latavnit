import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { checkDetectionSanity } from "./sanity.ts";
import { MECHANICAL_IDS } from "./mechanical.ts";

const MECH = MECHANICAL_IDS;
const MODEL_IDS = [5, 10, 12, 19, 20, 22, 23, 24, 25, 26, 32, 33, 34, 42, 43, 44];

/** n present signals from the given pool. */
function present(pool: number[], n: number) {
  return pool.slice(0, n).map((id) => ({ id, present: true, applicable: true }));
}
function absent(pool: number[], n: number) {
  return pool.slice(0, n).map((id) => ({ id, present: false, applicable: true }));
}

Deno.test("a normal audit is trusted without argument", () => {
  const v = checkDetectionSanity([...present(MECH, 8), ...present(MODEL_IDS, 14)]);
  assertEquals(v.reason, "ok");
  assert(v.trustworthy);
});

Deno.test("a genuinely clean site is trusted: both halves agree it is quiet", () => {
  const v = checkDetectionSanity([...present(MECH, 2), ...present(MODEL_IDS, 3), ...absent(MODEL_IDS, 10)]);
  assertEquals(v.reason, "sparse_but_corroborated");
  assert(v.trustworthy);
});

Deno.test("the model returning nothing while text search found plenty is NOT clean", () => {
  // Eight faults a text search can prove, and the model found one.
  const v = checkDetectionSanity([...present(MECH, 8), ...present(MODEL_IDS, 1)]);
  assertEquals(v.reason, "model_under_read");
  assertFalse(v.trustworthy);
  assertEquals(v.mechanical_present, 8);
  assertEquals(v.model_present, 1);
});

Deno.test("a total model failure is caught", () => {
  const v = checkDetectionSanity(present(MECH, 6));
  assertFalse(v.trustworthy);
  assertEquals(v.model_present, 0);
});

Deno.test("silence from the text searches is not evidence against the model", () => {
  // Nothing mechanical fired, so there is nothing to contradict. A quiet
  // result stands rather than being called a failure on no grounds.
  const v = checkDetectionSanity(present(MODEL_IDS, 2));
  assert(v.trustworthy);
  assertEquals(v.reason, "sparse_but_corroborated");
});

Deno.test("signals struck out by the catalogue do not count as findings", () => {
  const struck = [{ id: 36, present: true, applicable: false }, { id: 41, present: true, applicable: false }];
  const v = checkDetectionSanity([...struck, ...present(MODEL_IDS, 1)]);
  assertEquals(v.mechanical_present, 0, "not counted: the catalogue does not score these");
  assert(v.trustworthy);
});

Deno.test("the verdict never invents or removes a signal", () => {
  const signals = [...present(MECH, 8), ...present(MODEL_IDS, 1)];
  const before = JSON.stringify(signals);
  checkDetectionSanity(signals);
  assertEquals(JSON.stringify(signals), before, "read-only by design");
});
