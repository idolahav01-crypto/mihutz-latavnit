import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { buildLedger, scopeCss, visibleTextLength } from "./ledger.ts";

// A page with the shapes the rebuild kept losing: a hero <header>, a repeated
// stat group, a repeated card group, an interactive widget whose script depends
// on ids, and a real footer.
const PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><title>מועדון · Demo FC</title>
<meta property="og:site_name" content="Demo FC"></head>
<body>
<header>
  <h1>מועדון</h1>
  <div class="motto">סיסמה כלשהי</div>
</header>
<div class="stats-bar">
  <div class="stat"><div class="num">1886</div><div class="label">שנת ייסוד</div></div>
  <div class="stat"><div class="num">14</div><div class="label">אליפויות</div></div>
  <div class="stat"><div class="num">60000</div><div class="label">מקומות</div></div>
</div>
<section id="squad">
  <h2>שחקנים</h2>
  <p class="section-sub">הסגל הבכיר</p>
  <div class="grid">
    <div class="player"><div class="name">שחקן א</div><div class="body">תיאור א</div></div>
    <div class="player"><div class="name">שחקן ב</div><div class="body">תיאור ב</div></div>
    <div class="player"><div class="name">שחקן ג</div><div class="body">תיאור ג</div></div>
    <div class="player"><div class="name">שחקן ד</div><div class="body">תיאור ד</div></div>
  </div>
</section>
<section>
  <h2>על המועדון</h2>
  <p>פסקה ראשונה על המועדון.</p>
  <p>פסקה שנייה על המועדון.</p>
</section>
<section class="quiz-sec">
  <h2>חידון</h2>
  <div class="quiz-box">
    <span id="qCounter"></span>
    <div id="qBody"><div id="qText"></div><div id="qAnswers"></div></div>
  </div>
</section>
<footer><p>כל הזכויות שמורות</p><a href="#squad">סגל</a></footer>
<script>
  const c = document.getElementById('qCounter');
  const b = document.querySelector('#qBody');
  document.getElementById('qText').textContent = 'x';
</script>
</body></html>`;

Deno.test("meta and dir are read deterministically from the source", () => {
  const l = buildLedger(PAGE);
  assertEquals(l.dir, "rtl");
  assertEquals(l.meta.language, "he");
  assertEquals(l.meta.name, "מועדון · Demo FC");
});

Deno.test("every content block becomes a section; footer is excluded", () => {
  const l = buildLedger(PAGE);
  // hero, stats, squad, about, quiz — five content sections; footer dropped.
  assertEquals(l.sections.map((s) => s.id), [
    "מועדון",
    "section-2",
    "squad",
    "על-המועדון",
    "חידון",
  ]);
});

Deno.test("the hero header is kept as the first section, typed hero", () => {
  const l = buildLedger(PAGE);
  assertEquals(l.sections[0].type, "hero");
  assertEquals(l.sections[0].heading, "מועדון");
});

Deno.test("repeated groups are captured in full — no sampling, no loss", () => {
  const l = buildLedger(PAGE);
  const stats = l.sections.find((s) => s.heading === "" && s.items.length === 3) ?? l.sections[1];
  assertEquals(stats.items.length, 3); // all three stats
  assertEquals(stats.items[0].value, "1886");
  assertEquals(stats.items[2].text, "מקומות");

  const squad = l.sections.find((s) => s.id === "squad")!;
  assertEquals(squad.items.length, 4); // all four players, not one
  assertEquals(squad.items[0].title, "שחקן א");
  assertEquals(squad.items[3].title, "שחקן ד");
  assertEquals(squad.items[3].text, "תיאור ד");
  assertEquals(squad.subheading, "הסגל הבכיר");
});

Deno.test("a text section with no repeated group keeps its full body copy", () => {
  const l = buildLedger(PAGE);
  const about = l.sections.find((s) => s.heading === "על המועדון")!;
  assertEquals(about.items.length, 0);
  assert(about.body!.includes("פסקה ראשונה"));
  assert(about.body!.includes("פסקה שנייה"));
});

Deno.test("a widget section is detected and carried verbatim so its script survives", () => {
  const l = buildLedger(PAGE);
  const quiz = l.sections.find((s) => s.heading === "חידון")!;
  assertEquals(quiz.type, "interactive");
  assert(["qCounter", "qBody", "qText"].includes(quiz.component_id!));
  // Every id the script touches must be present in the carried-over markup.
  for (const id of ["qCounter", "qBody", "qText", "qAnswers"]) {
    assert(quiz.verbatim_html!.includes(`id="${id}"`), `verbatim_html missing #${id}`);
  }
  // Verbatim is scoped to the widget container, not the whole section: the
  // heading is left out so the rebuild can redesign it.
  assert(quiz.verbatim_html!.includes("quiz-box"));
  assert(!quiz.verbatim_html!.includes("חידון"), "verbatim should exclude the section heading");
});

Deno.test("scopeCss confines every rule to the wrapper without leaking", () => {
  const scoped = scopeCss(
    ":root{--red:#f00}\nbody{margin:0}\n.card,.tag{color:red}\n" +
      "@media (max-width:800px){.card{color:blue}}\n" +
      "@keyframes spin{from{transform:none}}",
    "#w",
  );
  assert(scoped.includes("#w{--red:#f00}"), "root vars attach to the wrapper");
  assert(scoped.includes("#w{margin:0}"), "body maps to the wrapper");
  assert(scoped.includes("#w .card, #w .tag{color:red}"), "class selectors are prefixed");
  assert(scoped.includes("@media (max-width:800px){#w .card{color:blue}}"), "media rules recurse");
  assert(scoped.includes("@keyframes spin{"), "keyframes stay global");
  // Nothing escapes the wrapper: no bare selector survives.
  assert(!/(^|\n)\.card\{/.test(scoped), "no unscoped .card rule leaks");
});

Deno.test("components list every script-referenced id that resolves, with its script", () => {
  const l = buildLedger(PAGE);
  const ids = l.components.map((c) => c.container_id).sort();
  // qAnswers exists in markup but the script never names it, so it is not a
  // tracked component — only the three ids the script actually touches are.
  assertEquals(ids, ["qBody", "qCounter", "qText"]);
  for (const c of l.components) assertEquals(c.script_index, 0);
});

Deno.test("dir falls back to Hebrew detection when the html tag omits it", () => {
  const noDir = PAGE.replace('<html lang="he" dir="rtl">', "<html>");
  const l = buildLedger(noDir);
  assertEquals(l.dir, "rtl");
});

Deno.test("emoji are stripped from every extracted text field", () => {
  const withEmoji = PAGE.replace("<h2>שחקנים</h2>", "<h2>🔥 שחקנים ⚽</h2>");
  const l = buildLedger(withEmoji);
  const squad = l.sections.find((s) => s.id === "squad")!;
  assertEquals(squad.heading, "שחקנים");
  assert(!/\p{Extended_Pictographic}/u.test(JSON.stringify(l.sections)));
});

Deno.test("visibleTextLength counts rendered text, ignoring tags", () => {
  // textContent concatenates element text with no separator, so the coverage
  // metric measures "שלוםעולם" (8) — what matters is that it is stable and
  // tag-free, and the same rule applies to original and rebuilt alike.
  const len = visibleTextLength("<div><h2>שלום</h2><p>עולם</p></div>");
  assertEquals(len, "שלוםעולם".length);
});

// ---------- footer facts ----------
//
// A business footer is the one place Israeli law reaches into: company number,
// address, terms, cancellation and accessibility all live there, and three of
// the 110 signals check for them. The footer's MARKUP is replaced, so its
// CONTENT has to survive as facts or a compliant site comes back non-compliant.

const BUSINESS_FOOTER = `<!doctype html><html lang="he" dir="rtl"><body>
  <main><h1>דפוס פיקסל</h1><p>הדפסה וגימור.</p></main>
  <footer>
    <div><h4>יצירת קשר</h4>
      <p>הדפוס 12, אזור תעשייה<br>ראשון לציון<br>
        <a href="tel:037654321">03-765-4321</a><br>
        <a href="mailto:info@pixelprint.co.il">info@pixelprint.co.il</a></p>
      <p>ח"פ 514785236</p>
      <p>ימים א-ה 08:00-17:00</p>
    </div>
    <div class="footer-bottom">
      <span>© 2026 דפוס פיקסל. כל הזכויות שמורות.</span>
      <a href="/terms.html">תקנון ותנאי שימוש</a>
      <a href="/privacy.html">מדיניות פרטיות</a>
      <span>מדיניות ביטול עסקה</span>
    </div>
  </footer></body></html>`;

Deno.test("ledger: a business footer's mandatory details all survive", () => {
  const facts = buildLedger(BUSINESS_FOOTER).facts.join("\n");
  for (
    const needed of [
      "הדפוס 12",           // street address
      "ראשון לציון",         // city, on its own <br> line and with no digits
      "514785236",          // company number
      "08:00-17:00",        // opening hours
      "037654321",          // tel: value
      "info@pixelprint.co.il",
      "מדיניות ביטול עסקה", // required, and written as plain text not a link
    ]
  ) {
    assert(facts.includes(needed), `footer fact lost: ${needed}`);
  }
});

Deno.test("ledger: legal pages keep the href the site already uses", () => {
  const facts = buildLedger(BUSINESS_FOOTER).facts;
  assert(facts.some((f) => f.includes("תקנון") && f.includes("/terms.html")));
  assert(facts.some((f) => f.includes("מדיניות פרטיות") && f.includes("/privacy.html")));
});

Deno.test("ledger: an address split across <br> is not glued into one word", () => {
  const facts = buildLedger(BUSINESS_FOOTER).facts;
  assert(facts.some((f) => f === "ראשון לציון"), "the city must stand as its own fact");
  assertFalse(
    facts.some((f) => /אזור תעשייהראשון/.test(f)),
    "reading textContent alone glues the lines together",
  );
});

Deno.test("ledger: a page with no footer yields no invented facts", () => {
  const facts = buildLedger(`<html><body><main><h1>כותרת</h1><p>טקסט.</p></main></body></html>`).facts;
  assertEquals(facts, []);
});

// ---------- sections nested inside wrappers ----------
//
// Every fixture above lays its sections out as direct children of <body>, which
// is what the ledger used to assume and what almost no real site does. On a
// measured run a whole commercial site collapsed to three sections, two areas
// of it vanished, and the rebuild came back as boxes of text.

const WRAPPED = `<!doctype html><html lang="he" dir="rtl"><head><title>iCell</title></head><body>
<div class="page-wrapper">
  <header class="site-head"><a class="logo" href="/"><img src="/img/logo.png" alt="iCell"></a>
    <nav><a href="#pricing">מחירון</a></nav></header>
  <main>
    <section id="hero"><h1>תיקון סלולר תוך שעה</h1><p>מעבדה מוסמכת</p>
      <img src="/img/hero.jpg" alt="מעבדה"></section>
    <section id="services"><h2>שירותים</h2>
      <div class="grid">
        <div class="card"><img src="/img/screen.jpg" alt="מסך"><h3>החלפת מסך</h3><p>תוך שעה</p></div>
        <div class="card"><img src="/img/batt.jpg" alt="סוללה"><h3>סוללה</h3><p>אחריות שנה</p></div>
      </div></section>
    <section id="pricing"><h2>מחירון תיקונים</h2><p>מסך 349 שקל</p></section>
    <div class="cta-band"><h2>מבצע החודש</h2><p>הנחה</p></div>
  </main>
  <footer><p>ח.פ. 515123456</p></footer>
</div></body></html>`;

Deno.test("a page wrapped in a div and a main still yields all its sections", () => {
  const l = buildLedger(WRAPPED);
  assertEquals(l.sections.length, 4, "one wrapper used to swallow the whole page");
  assertEquals(l.sections.map((s) => s.id), ["hero", "services", "pricing", "מבצע-החודש"]);
});

Deno.test("a section a nav points at is not lost inside a wrapper", () => {
  // The measured run logged: nav entries dropped (no such section): מחירון
  // תיקונים, סניפים. The section existed; the ledger simply never saw it.
  const l = buildLedger(WRAPPED);
  assert(l.sections.some((s) => s.heading === "מחירון תיקונים"));
});

Deno.test("a declared <section> is never split open by the descent", () => {
  const l = buildLedger(WRAPPED);
  const services = l.sections.find((s) => s.id === "services")!;
  assertEquals(services.heading, "שירותים");
  assertEquals(services.items.length, 2, "its cards stay its items, not new sections");
});

Deno.test("chrome stays chrome however deeply it is wrapped", () => {
  const l = buildLedger(WRAPPED);
  assertFalse(l.sections.some((s) => (s.heading ?? "").includes("ח.פ")), "footer is the shell's");
  assertFalse(l.sections.some((s) => s.id === "site-head"));
});

Deno.test("a flat page is unchanged by the descent", () => {
  // The old shape must keep working exactly as before.
  const flat = buildLedger(PAGE);
  assert(flat.sections.length >= 2);
  assertEquals(flat.sections[0].type, "hero");
});

// ---------- images ----------

Deno.test("a section carries the photographs it shows", () => {
  const l = buildLedger(WRAPPED);
  const hero = l.sections.find((s) => s.id === "hero")!;
  assertEquals(hero.images?.map((i) => i.src), ["/img/hero.jpg"]);
  assertEquals(hero.images?.[0].alt, "מעבדה");

  const services = l.sections.find((s) => s.id === "services")!;
  assertEquals(services.images?.map((i) => i.src), ["/img/screen.jpg", "/img/batt.jpg"]);
});

Deno.test("a section with no images says nothing rather than an empty array", () => {
  const l = buildLedger(WRAPPED);
  assertEquals(l.sections.find((s) => s.id === "pricing")!.images, undefined);
});

Deno.test("the logo survives the header being discarded as chrome", () => {
  const l = buildLedger(WRAPPED);
  assertEquals(l.meta.logo?.src, "/img/logo.png");
  assertEquals(l.meta.logo?.alt, "iCell");
});

Deno.test("a background-image and a <picture> source are images too", () => {
  const l = buildLedger(`<html><body><main>
    <section id="a"><h2>א</h2><div style="background-image:url('/img/bg.jpg')">x</div></section>
    <section id="b"><h2>ב</h2><picture><source srcset="/img/w.webp 1x, /img/w2.webp 2x">
      <img src="/img/fallback.jpg" alt="נפילה"></picture></section>
  </main></body></html>`);
  assertEquals(l.sections.find((s) => s.id === "a")!.images?.[0].src, "/img/bg.jpg");
  const b = l.sections.find((s) => s.id === "b")!.images!.map((i) => i.src);
  assert(b.includes("/img/w.webp") && b.includes("/img/fallback.jpg"));
});

Deno.test("a data: URI is not carried into the spec", () => {
  const l = buildLedger(`<html><body><main><section id="a"><h2>א</h2>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"><img src="/img/real.jpg" alt="אמיתי">
  </section></main></body></html>`);
  assertEquals(l.sections[0].images?.map((i) => i.src), ["/img/real.jpg"]);
});

Deno.test("the same image twice in one section is carried once", () => {
  const l = buildLedger(`<html><body><main><section id="a"><h2>א</h2>
    <img src="/img/x.jpg" alt="x"><img src="/img/x.jpg" alt="x">
  </section></main></body></html>`);
  assertEquals(l.sections[0].images?.length, 1);
});
