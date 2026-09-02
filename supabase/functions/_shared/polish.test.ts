import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { polishPage } from "./polish.ts";

const rtl = (html: string, images?: Array<{ src: string; alt?: string }>) =>
  polishPage(html, { rtl: true, images });

// ---------- the rule that matters most: a good page is not touched ----------

Deno.test("a page with nothing wrong comes back byte for byte", () => {
  const good = `<main><h1>מיץ</h1><h2>טעמים</h2><h3>אשכוליות</h3>
<img src="/a.webp" alt="דוכן"><img src="/b.webp" alt="כוס" loading="lazy">
<form><input type="text" dir="rtl"><input type="number"></form></main>`;
  const r = rtl(good);
  assertEquals(r.html, good);
  assertEquals(r.fixed, []);
});

// ---------- #29 heading order ----------

Deno.test("#29 a skipped level is pulled back to its parent", () => {
  const r = rtl(`<h1>א</h1><h2>ב</h2><h4>ג</h4>`);
  assert(r.fixed.includes(29));
  assert(r.html.includes("<h3>ג</h3>"), r.html);
});

Deno.test("#29 the closing tag is re-paired, never left mismatched", () => {
  const r = rtl(`<h1>א</h1><h2>ב</h2><h5 class="x">ג</h5>`);
  assert(r.html.includes('<h3 class="x">ג</h3>'), r.html);
  assertFalse(/<h3[^>]*>[^<]*<\/h5>/.test(r.html), "no <h3>…</h5>");
});

Deno.test("#29 climbing back up is legal and left alone", () => {
  const src = `<h1>א</h1><h2>ב</h2><h3>ג</h3><h2>ד</h2><h3>ה</h3>`;
  assertEquals(rtl(src).html, src);
});

Deno.test("#29 never demotes: an h2 after an h4 stays an h2", () => {
  const r = rtl(`<h1>א</h1><h4>ב</h4><h2>ג</h2>`);
  // The h4 is pulled up to h2; the following h2 is already legal.
  assert(r.html.includes("<h2>ב</h2>"));
  assert(r.html.includes("<h2>ג</h2>"));
});

Deno.test("#29 leaves h1 alone — which heading is the title is a decision", () => {
  const src = `<h2>לפני</h2><h1>הכותרת</h1>`;
  assertEquals(rtl(src).html, src);
});

// ---------- #33 alt ----------

Deno.test("#33 a missing alt is filled from the original page's own wording", () => {
  const r = rtl(`<img src="images/hero.jpg">`, [{ src: "images/hero.jpg", alt: "מעבדה מוסמכת" }]);
  assert(r.fixed.includes(33));
  assert(r.html.includes('alt="מעבדה מוסמכת"'));
});

Deno.test("#33 with nothing to go on, the filename beats an invented description", () => {
  const r = rtl(`<img src="/img/repair-bench.jpg">`);
  assert(r.html.includes('alt="repair bench"'), r.html);
});

Deno.test("#33 an alt the builder wrote is never overwritten", () => {
  const src = `<img src="/a.jpg" alt="שולחן עבודה בנגריה">`;
  assertEquals(rtl(src).html, src);
});

// ---------- #37 lazy ----------

Deno.test("#37 the first image stays eager, the rest are deferred", () => {
  const r = rtl(`<img src="/1.jpg" alt="a"><img src="/2.jpg" alt="b"><img src="/3.jpg" alt="c">`);
  assert(r.fixed.includes(37));
  const tags = r.html.match(/<img[^>]*>/g)!;
  assertFalse(tags[0].includes("loading="), "the hero must not be deferred");
  assert(tags[1].includes('loading="lazy"'));
  assert(tags[2].includes('loading="lazy"'));
});

Deno.test("#37 an explicit loading choice is respected", () => {
  const src = `<img src="/1.jpg" alt="a"><img src="/2.jpg" alt="b" loading="eager">`;
  assertEquals(rtl(src).html, src);
});

// ---------- #79 form direction ----------

Deno.test("#79 free-text fields on a Hebrew page get a direction", () => {
  const r = rtl(`<input type="text" name="a"><textarea name="b"></textarea>`);
  assert(r.fixed.includes(79));
  assertEquals((r.html.match(/dir="rtl"/g) ?? []).length, 2);
});

Deno.test("#79 a number or date field has no direction to get wrong", () => {
  const src = `<input type="number"><input type="date"><input type="color">`;
  assertEquals(rtl(src).html, src);
});

Deno.test("#79 does not apply to a left-to-right site", () => {
  const src = `<input type="text" name="a">`;
  assertEquals(polishPage(src, { rtl: false }).html, src);
});

// ---------- safety ----------

Deno.test("quotes in alt text cannot escape the attribute", () => {
  const r = rtl(`<img src="/a.jpg">`, [{ src: "/a.jpg", alt: 'say "hi" <b>' }]);
  assert(r.html.includes("&quot;"));
  assertFalse(r.html.includes('alt="say "hi""'));
});

Deno.test("every repair is reported, never silent", () => {
  const r = rtl(`<h1>א</h1><h3>ב</h3><img src="/a.jpg"><input type="text">`);
  assertEquals(r.fixed.length, r.notes.length);
  assert(r.notes.every((n) => n.length > 0));
});
