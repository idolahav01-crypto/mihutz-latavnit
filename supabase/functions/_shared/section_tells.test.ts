import { assert, assertEquals } from "jsr:@std/assert@1";
import { sectionTells } from "./section_tells.ts";

/** The original was flagged for everything, so nothing is filtered by scope. */
const ALL = new Set([16, 19, 20, 42, 69, 110]);
const ids = (html: string, css = "", flagged = ALL) =>
  sectionTells(html, css, flagged).map((t) => t.signal).sort();

// ---------- the property that costs money: no false positives ----------

Deno.test("an ordinary well-built section trips nothing", () => {
  const html = `<section class="sec-about"><h2>הסיפור של הנגריה</h2>
    <p>מאז 1974 אנחנו בונים רהיטים ביד, בעפולה.</p>
    <img src="/img/bench.jpg" alt="שולחן עבודה"></section>`;
  const css = `.sec-about{padding-block:4rem}.sec-about h2{font-size:2.4rem}`;
  assertEquals(ids(html, css), []);
});

Deno.test("a two-item layout is not a card grid", () => {
  const html = `<div class="pair"><h3>א</h3><p>x</p></div><div class="pair"><h3>ב</h3><p>y</p></div>`;
  assertEquals(ids(html), []);
});

Deno.test("a long list of real entries is a list, not the template", () => {
  // Eight repeated rows is a price list. The signal names three or four.
  const rows = Array.from({ length: 8 }, (_, i) => `<div class="row"><h3>פריט ${i}</h3><p>₪${i}00</p></div>`).join("");
  assertEquals(ids(rows), []);
});

Deno.test("a shadow that is not the default shade is left alone", () => {
  assertEquals(ids("<div class=x></div>", ".x{box-shadow:0 18px 40px rgba(59,47,38,.22)}"), []);
});

Deno.test("one real statistic is not a stats bar", () => {
  assertEquals(ids("<p>מעל 500+ תיקונים בשנה</p>"), []);
});

Deno.test("a fade with no rise, or a rise with no fade, is not the tell", () => {
  assertEquals(ids("<div></div>", "@keyframes f{from{opacity:0}to{opacity:1}}"), []);
  assertEquals(ids("<div></div>", ".a{transform:translateY(-2px)}"), []);
});

// ---------- and it does catch what came back ----------

Deno.test("#69 an eyebrow by name is caught", () => {
  assert(ids(`<span class="eyebrow">השירותים שלנו</span><h2>מה אנחנו עושים</h2>`).includes(69));
  assert(ids(`<p class="section-label">אודות</p><h2>הסיפור</h2>`).includes(69));
});

Deno.test("#69 an eyebrow built without naming it is still caught", () => {
  const html = `<span class="lead-in">אודות</span><h2>הסיפור שלנו</h2>`;
  const css = `.lead-in{text-transform:uppercase;letter-spacing:.14em;font-size:.75rem}`;
  assert(ids(html, css).includes(69));
});

Deno.test("#16 the default shadow is caught however it is spaced", () => {
  assert(ids("<div class=c></div>", ".c{box-shadow:0 1px 2px rgba(0,0,0,0.1)}").includes(16));
  assert(ids("<div class=c></div>", ".c{box-shadow:0 4px 6px rgba(0, 0, 0, .1)}").includes(16));
});

Deno.test("#110 a row of round numbers is caught", () => {
  const html = `<div class="stats"><div><span>500+</span><p>לקוחות</p></div>
    <div><span>99%</span><p>שביעות רצון</p></div><div><span>24/7</span><p>זמינות</p></div></div>`;
  assert(ids(html).includes(110));
});

Deno.test("#42 fade-up on scroll is caught", () => {
  const css = `@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1}}
    .sec{animation:fadeUp .6s ease}`;
  assert(ids("<section class=sec></section>", css).includes(42));
});

Deno.test("#20 three identical cards is caught", () => {
  const html = `<div class="card"><h3>א</h3><p>x</p></div>
    <div class="card"><h3>ב</h3><p>y</p></div><div class="card"><h3>ג</h3><p>z</p></div>`;
  assert(ids(html).includes(20));
});

// ---------- scope: only what the original was flagged for ----------

Deno.test("a tell the original never had is the designer's choice, not a fault", () => {
  const html = `<span class="eyebrow">אודות</span><h2>הסיפור</h2>`;
  assertEquals(sectionTells(html, "", new Set([19, 20])), [], "69 was not on this site's list");
  assertEquals(sectionTells(html, "", new Set([69])).length, 1);
});

Deno.test("every tell names itself specifically enough to act on", () => {
  const html = `<span class="eyebrow">אודות</span><h2>הסיפור</h2>`;
  const [tell] = sectionTells(html, "", ALL);
  assert(tell.detail.length > 20, "a retry has to say what was wrong, not just scold");
});
