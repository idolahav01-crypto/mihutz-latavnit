import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  applyNavPlan,
  applySectionId,
  collectIds,
  NAV_SLOT,
  isWidgetSection,
  missingSectionFacts,
  fixAnchors,
  rootId,
  stripDeadControls,
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

Deno.test("applyNavPlan writes the nav from the plan, so no href can be wrong", () => {
  const header = `<header><a class="brand" href="#hero">ארסנל</a><nav>${NAV_SLOT}</nav></header>`;
  const plan = [
    { section_id: "היסטוריה", label: "היסטוריה" },
    { section_id: "שחקנים-בולטים", label: "הסגל" },
    { section_id: "אין-כזה", label: "חידון" }, // names a section that is not here
  ];
  const ids = new Set(["hero", "היסטוריה", "שחקנים-בולטים", "main"]);
  const { html, dropped, slotUsed } = applyNavPlan(header, plan, ids);
  assert(slotUsed);
  assertStringIncludes(html, `<a class="nav-link" href="#היסטוריה">היסטוריה</a>`);
  assertStringIncludes(html, `<a class="nav-link" href="#שחקנים-בולטים">הסגל</a>`);
  assertFalse(html.includes("אין-כזה"), "a section that is not on the page never gets a link");
  assertEquals(dropped, ["חידון"]);
});

Deno.test("applyNavPlan repoints the model's own links when it ignored the slot", () => {
  const header = `<header><nav><a href="#squad">הסגל</a><a href="#hist">היסטוריה</a></nav></header>`;
  const plan = [
    { section_id: "שחקנים-בולטים", label: "הסגל" },
    { section_id: "היסטוריה", label: "היסטוריה" },
  ];
  const { html, slotUsed } = applyNavPlan(header, plan, new Set(["שחקנים-בולטים", "היסטוריה"]));
  assertFalse(slotUsed);
  assertStringIncludes(html, `href="#שחקנים-בולטים">הסגל</a>`);
  assertStringIncludes(html, `href="#היסטוריה">היסטוריה</a>`);
});

Deno.test("applyNavPlan drops a duplicate section rather than linking it twice", () => {
  const header = `<header><nav>${NAV_SLOT}</nav></header>`;
  const plan = [
    { section_id: "היסטוריה", label: "היסטוריה" },
    { section_id: "היסטוריה", label: "העבר" },
  ];
  const { html, dropped } = applyNavPlan(header, plan, new Set(["היסטוריה"]));
  assertEquals((html.match(/nav-link/g) ?? []).length, 1);
  assertEquals(dropped, ["העבר"]);
});

Deno.test("fixAnchors remaps unknown targets and keeps valid ones", () => {
  const sections = [{ id: "squad", heading: "שחקנים" }, { id: "history", heading: "היסטוריה" }];
  const nav = `<a href="#squad">סגל</a><a href="#players">שחקנים</a><a href="#gone">אין</a><a href="#main">ראש</a>`;
  const out = fixAnchors(nav, sections).html;
  assertStringIncludes(out, `<a href="#squad">סגל</a>`); // valid id kept
  assertStringIncludes(out, `<a href="#squad">שחקנים</a>`); // unknown remapped by heading text
  assertStringIncludes(out, `<a href="#main">אין</a>`); // no match falls back to #main
  assertStringIncludes(out, `<a href="#main">ראש</a>`); // #main preserved
});

Deno.test("fixAnchors resolves a Hebrew nav label that is not the heading verbatim", () => {
  // The exact run that shipped three dead nav items: the labels carry the
  // definite article and name one word of a longer heading.
  const sections = [
    { id: "אצטדיון-האמירויות", heading: "אצטדיון האמירויות" },
    { id: "שחקנים-בולטים", heading: "שחקנים בולטים" },
    { id: "היסטוריה", heading: "היסטוריה" },
  ];
  const nav = `<a href="#stadium">האצטדיון</a><a href="#players">שחקנים</a><a href="#history">היסטוריה</a>`;
  const { html, fallbacks } = fixAnchors(nav, sections);
  assertStringIncludes(html, `href="#אצטדיון-האמירויות"`);
  assertStringIncludes(html, `href="#שחקנים-בולטים"`);
  assertStringIncludes(html, `href="#היסטוריה"`);
  assertEquals(fallbacks, []);
});

Deno.test("fixAnchors sees a single-quoted href too", () => {
  const out = fixAnchors(`<a href='#gone'>היסטוריה</a>`, [{ id: "history", heading: "היסטוריה" }]).html;
  assertStringIncludes(out, `href='#history'`);
});

Deno.test("fixAnchors trusts the shipped ids, not the plan", () => {
  // The planned id is "facts"; the builder shipped id="section-2". A link to
  // #facts must not survive just because the plan still names it.
  const shipped = new Set(["section-2", "main"]);
  const nav = `<a href="#facts">עובדות</a>`;
  const out = fixAnchors(nav, [{ id: "section-2", heading: "עובדות" }], shipped).html;
  assertStringIncludes(out, `href="#section-2"`);
});

Deno.test("fixAnchors resolves a label by a word only one section uses", () => {
  // "חידון" shares nothing with "טריוויית התותחנים" — but the word appears in
  // that section and in no other, which is enough to place the link.
  const sections = [
    { id: "trivia", heading: "טריוויית התותחנים", text: "חידון של שמונה שאלות" },
    { id: "history", heading: "היסטוריה", text: "המועדון נוסד ב-1886" },
  ];
  const { html, fallbacks } = fixAnchors(`<a href="#quiz">חידון</a>`, sections);
  assertStringIncludes(html, `href="#trivia"`);
  assertEquals(fallbacks, []);
});

Deno.test("fixAnchors will not guess from a word two sections share", () => {
  const sections = [
    { id: "a", heading: "כותרת א", text: "המועדון הזה" },
    { id: "b", heading: "כותרת ב", text: "המועדון ההוא" },
  ];
  const { html, fallbacks } = fixAnchors(`<a href="#x">מועדון</a>`, sections);
  assertStringIncludes(html, `href="#main"`);
  assertEquals(fallbacks, ["מועדון"]);
});

Deno.test("fixAnchors reports every link it could not resolve", () => {
  const { html, fallbacks } = fixAnchors(
    `<a href="#nowhere">חידון</a>`,
    [{ id: "history", heading: "היסטוריה" }],
  );
  assertStringIncludes(html, `href="#main"`);
  assertEquals(fallbacks, ["חידון"]);
});

Deno.test("fixAnchors resolves a placeholder href=\"#\" by its label", () => {
  const out = fixAnchors(`<a href="#">צור קשר</a>`, [{ id: "contact", heading: "צור קשר" }]).html;
  assertStringIncludes(out, `href="#contact"`);
  // Nothing to match: left as-is rather than sent somewhere arbitrary.
  assertStringIncludes(fixAnchors(`<a href="#">קרא עוד</a>`, []).html, `href="#"`);
});

Deno.test("stripDeadControls removes a button no script can drive", () => {
  const header = `<nav><a href="#x">בית</a><button type="button" class="a11y-btn">ניגודיות</button></nav>`;
  const { html, removed } = stripDeadControls(header, `const questions=[];document.createElement("button");`);
  assertFalse(html.includes("<button"), "the dead control is gone");
  assertStringIncludes(html, `<a href="#x">בית</a>`);
  assertEquals(removed, ["ניגודיות"]);
});

Deno.test("stripDeadControls keeps every button something could drive", () => {
  const script = `document.getElementById("qNext");document.querySelector(".ans-btn");`;
  const keep = `<button id="qNext">הבא</button><button class="ans-btn">א</button>` +
    `<button onclick="go()">לך</button><button type="submit">שלח</button>`;
  const { html, removed } = stripDeadControls(keep, script);
  assertEquals(removed, []);
  assertEquals((html.match(/<button/g) ?? []).length, 4);
});

Deno.test("stripDeadControls keeps everything when a script queries buttons by tag", () => {
  for (
    const script of [
      `document.querySelectorAll(".panel button").forEach(b => b.onclick = go);`,
      `box.addEventListener("click", e => { if (e.target.tagName === "BUTTON") go(); });`,
      `if (e.target instanceof HTMLButtonElement) go();`,
      `document.getElementsByTagName("button")[0].click();`,
    ]
  ) {
    assertEquals(stripDeadControls(`<button class="x">א</button>`, script).removed, [], script);
  }
});

Deno.test("applySectionId forces the ledger id over one the builder invented", () => {
  const { html, css } = applySectionId(
    `<section id="section-2" class="sec-facts">y</section>`,
    `#section-2{gap:1rem}.sec-facts h2{margin:0}`,
    "בקצרה",
  );
  assertStringIncludes(html, `id="בקצרה"`);
  assertFalse(html.includes("section-2"), "the invented id is gone from the markup");
  assertStringIncludes(css, `#בקצרה{gap:1rem}`); // its styling followed the rename
  assertStringIncludes(css, `.sec-facts h2{margin:0}`);
});

Deno.test("applySectionId ids a fragment whose root is not a <section>", () => {
  const { html } = applySectionId(`<div class="wrap"><h2>כותרת</h2></div>`, "", "hero");
  assertStringIncludes(html, `<div id="hero" class="wrap">`);
});

Deno.test("applySectionId leaves a fragment that already carries the right id", () => {
  const before = `<section id="hero">y</section>`;
  assertEquals(applySectionId(before, ".x{}", "hero").html, before);
});

Deno.test("collectIds and rootId read the ids the markup really has", () => {
  const frag = `<section id="a"><div id="b"></div></section>`;
  assertEquals(rootId(frag), "a");
  assertEquals([...collectIds(frag)].sort(), ["a", "b"]);
  assertEquals(rootId(`<section class="x">y</section>`), null);
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

Deno.test("isWidgetSection is the same test the build and the build plan both make", () => {
  // A widget section takes the deterministic path: carried verbatim, no model
  // call, no cost. If the plan counted it as billable, the recorded N would not
  // be the N that was paid for — which is the number the cost equation is
  // calibrated on.
  assert(isWidgetSection({ id: "s1", component_id: "cart", verbatim_html: "<div id=cart></div>" }));
  // Both halves are required: a component with nothing carried over is rebuilt
  // by the model like any other section.
  assertFalse(isWidgetSection({ id: "s2", component_id: "cart" }));
  assertFalse(isWidgetSection({ id: "s3", verbatim_html: "<div></div>" }));
  assertFalse(isWidgetSection({ id: "s4", heading: "About" }));
});
