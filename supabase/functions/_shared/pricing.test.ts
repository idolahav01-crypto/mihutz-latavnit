import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { MAX_TOKENS, PACKAGES, PriceError, priceCents } from "./pricing.ts";

Deno.test("a package quantity is charged the package's price, not the base rate", () => {
  // The trap this exists to close: 50 tokens at the base rate is $50, on a
  // page that sells 50 for $42.
  assertEquals(priceCents(50), 4200);
  assertEquals(priceCents(20), 1800);
  assertEquals(priceCents(100), 8000);
});

Deno.test("a quantity of the customer's own is charged the base rate", () => {
  assertEquals(priceCents(1), 100);
  assertEquals(priceCents(15), 1500);
  assertEquals(priceCents(37), 3700);
});

Deno.test("prices come out as whole cents", () => {
  for (let n = 1; n <= 200; n++) {
    const c = priceCents(n);
    assertEquals(c, Math.round(c), `${n} tokens priced at a fraction of a cent`);
  }
});

Deno.test("a quantity that is not a whole positive number is refused", () => {
  for (const bad of [0, -5, 1.5, NaN, Infinity, "10", null, undefined, {}]) {
    assertThrows(() => priceCents(bad as unknown), PriceError, undefined,
      `priceCents accepted ${String(bad)}`);
  }
});

Deno.test("an absurd quantity is refused rather than charged", () => {
  // An extra zero is a charge somebody has to undo by hand.
  assertEquals(priceCents(MAX_TOKENS), MAX_TOKENS * 100);
  assertThrows(() => priceCents(MAX_TOKENS + 1), PriceError);
});

Deno.test("REGRESSION: the store page and the server price the same packages", async () => {
  // pricing.ts is a copy of PACKAGES in js/store.js — there is no build step
  // between a static page and Deno. This test is what makes the duplication
  // safe: change one side only, and the suite says so here rather than a
  // customer discovering it at a checkout that quotes a different number.
  const src = await Deno.readTextFile(
    new URL("../../../js/store.js", import.meta.url),
  );
  const block = src.match(/var PACKAGES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("could not find PACKAGES in js/store.js");

  const onPage = [...block[1].matchAll(/tokens:\s*(\d+)\s*,\s*usd:\s*(\d+)/g)]
    .map((m) => ({ tokens: Number(m[1]), usd: Number(m[2]) }));

  assertEquals(onPage, PACKAGES);
});
