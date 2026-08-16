import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  ensureSectionId,
  missingSectionFacts,
  fixAnchors,
  renderContentSection,
  renderWidgetSection,
  sectionCoverage,
  stripSkipLinks,
  widgetWrapId,
} from "./rebuild_assembly.ts";
import type { LedgerSection } from "./ledger.ts";

const widget: LedgerSection = {
  id: "trivia",
  type: "interactive",
  heading: "טריוויה",
  subheading: "8 שאלות",
  items: [],
  component_id: "qBody",
  verbatim_html: `<div class="quiz-box"><span id="qCounter"></span><div id="qBody"></div></div>`,
  text: "טריוויה 8 שאלות שאלה 1",
};

const cards: LedgerSection = {
  id: "squad",
  type: "content",
  heading: "שחקנים",
  subheading: "הסגל",
  items: [
    { title: "שחקן א", text: "תיאור א" },
    { title: "שחקן ב", text: "תיאור ב" },
    { value: "14", title: "שחקן ג", text: "תיאור ג" },
  ],
  text: "שחקנים הסגל שחקן א תיאור א שחקן ב תיאור ב שחקן ג תיאור ג",
};

Deno.test("widget section keeps the container ids and scopes its original CSS", () => {
  const style = `:root{--red:#f00}.quiz-box{color:var(--red)}.ans-btn.correct{color:green}`;
  const { html, css } = renderWidgetSection(widget, style, widgetWrapId(7));
  // Script DOM preserved.
  assertStringIncludes(html, `id="qCounter"`);
  assertStringIncludes(html, `id="qBody"`);
  // Heading redesigned outside the verbatim container.
  assertStringIncludes(html, "<h2>טריוויה</h2>");
  // Original styles scoped under the private wrapper, nothing global leaks.
  assertStringIncludes(css, "#rb-widget-7 .quiz-box");
  assertStringIncludes(css, "#rb-widget-7 .ans-btn.correct");
  assert(!/(^|\n)\.quiz-box\{/.test(css), "no unscoped widget rule leaks into the page");
});

Deno.test("content floor renderer emits every item — nothing dropped", () => {
  const { html } = renderContentSection(cards);
  for (const t of ["שחקן א", "שחקן ב", "שחקן ג", "תיאור א", "תיאור ב", "תיאור ג", "14"]) {
    assertStringIncludes(html, t);
  }
  assertEquals((html.match(/rb-card/g) ?? []).length, 3);
  assertStringIncludes(html, `id="squad"`);
});

Deno.test("content floor renders prose when a section has no items", () => {
  const prose: LedgerSection = {
    id: "about",
    type: "content",
    heading: "אודות",
    items: [],
    body: "פסקה ראשונה\n\nפסקה שנייה",
    text: "אודות פסקה ראשונה פסקה שנייה",
  };
  const { html } = renderContentSection(prose);
  assertStringIncludes(html, "<p>פסקה ראשונה</p>");
  assertStringIncludes(html, "<p>פסקה שנייה</p>");
});

Deno.test("sectionCoverage flags a build that dropped most of the content", () => {
  const full = `<section><div class="container"><h2>שחקנים</h2><p>הסגל שחקן א תיאור א שחקן ב תיאור ב שחקן ג תיאור ג</p></div></section>`;
  const gutted = `<section><h2>שחקנים</h2></section>`;
  assert(sectionCoverage(full, cards) >= 0.85, "a faithful build clears the bar");
  assert(sectionCoverage(gutted, cards) < 0.5, "a gutted build is caught");
});

Deno.test("escaping guards item text with angle brackets", () => {
  const evil: LedgerSection = {
    id: "x",
    type: "content",
    heading: "כותרת",
    items: [{ title: "a<script>", text: "b & c" }],
    text: "כותרת a b c",
  };
  const { html } = renderContentSection(evil);
  assert(!html.includes("<script>"));
  assertStringIncludes(html, "a&lt;script&gt;");
  assertStringIncludes(html, "b &amp; c");
});

Deno.test("stripSkipLinks removes a duplicate skip link", () => {
  const h = `<a class="skip-link" href="#main">דלג</a><header>x</header>`;
  assertEquals(stripSkipLinks(h), "<header>x</header>");
});

Deno.test("fixAnchors remaps unknown targets and keeps valid ones", () => {
  const sections = [{ id: "squad", heading: "שחקנים" }, { id: "history", heading: "היסטוריה" }];
  const nav = `<a href="#squad">סגל</a><a href="#players">שחקנים</a><a href="#gone">אין</a><a href="#main">ראש</a>`;
  const out = fixAnchors(nav, sections);
  assertStringIncludes(out, `<a href="#squad">סגל</a>`); // valid id kept
  assertStringIncludes(out, `<a href="#squad">שחקנים</a>`); // unknown remapped by heading text
  assertStringIncludes(out, `<a href="#main">אין</a>`); // no match falls back to #main
  assertStringIncludes(out, `<a href="#main">ראש</a>`); // #main preserved
});

Deno.test("ensureSectionId adds the id only when the model omitted it", () => {
  assertStringIncludes(ensureSectionId("<section class='x'>y</section>", "hero"), `id="hero"`);
  assertEquals(ensureSectionId(`<section id="kept">y</section>`, "hero"), `<section id="kept">y</section>`);
});

Deno.test("missingSectionFacts: a rewrite that drops the address and hours is caught", () => {
  const section = {
    id: "contact",
    text: "רחוב הנגרים 12, יפו העתיקה. א׳-ה׳ 10:00-19:00, ו׳ 09:00-14:00. טלפון 03-700-1987.",
  };
  const built = `<section><p>בואו לבקר אותנו בסטודיו ביפו העתיקה. טלפון 03-700-1987.</p></section>`;
  const missing = missingSectionFacts(built, section);
  assert(missing.includes("12"), "the street number must be reported missing");
  assert(missing.includes("19:00") || missing.includes("19"), "the closing hour must be reported missing");
});

Deno.test("missingSectionFacts: a faithful rewrite reports nothing", () => {
  const section = { id: "contact", text: "רחוב הנגרים 12. שעות 10:00-19:00." };
  const built = `<section><p>מצאו אותנו ברחוב הנגרים 12, פתוח 10:00-19:00.</p></section>`;
  assertEquals(missingSectionFacts(built, section), []);
});

Deno.test("missingSectionFacts: a section with no numbers cannot fail", () => {
  assertEquals(missingSectionFacts("<section><p>אחר</p></section>", { id: "a", text: "טקסט בלבד" }), []);
});

Deno.test("renderContentSection: a section with both copy and cards keeps both", () => {
  const out = renderContentSection({
    id: "s",
    heading: "כותרת",
    body: "רחוב הנגרים 12, יפו העתיקה.\n\nפתוח 10:00-19:00.",
    items: [{ title: "כרטיס", text: "טקסט" }],
  }).html;
  assertStringIncludes(out, "הנגרים 12");
  assertStringIncludes(out, "10:00-19:00");
  assertStringIncludes(out, "כרטיס");
});
