import { assert, assertEquals } from "jsr:@std/assert@1";
import { MECHANICAL_IDS, mechanicalSignals, overlayMechanical } from "./mechanical.ts";

function verdict(files: Record<string, string>, id: number) {
  const s = mechanicalSignals(new Map(Object.entries(files))).find((x) => x.id === id);
  if (!s) throw new Error(`no verdict for #${id}`);
  return s;
}

/** A minimal Hebrew page that trips every check we own. */
const BARE = `<!doctype html><html lang="he" dir="rtl"><head>
<title>מיץ</title>
<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
</head><body><h1>מיץ טרי 🍊</h1></body></html>`;

const BARE_CSS = `.card{margin-left:12px;animation:fade 1s}
@keyframes fade{from{opacity:0}to{opacity:1}}
body{font-family:Inter,sans-serif}`;

/** The same page after everything we can check has been done properly. */
const GOOD = `<!doctype html><html lang="he" dir="rtl"><head>
<title>מיץ טרי</title>
<meta name="description" content="דוכן מיצים טבעיים בשוק הכרמל, סחיטה במקום משעה שבע בבוקר.">
<meta property="og:title" content="מיץ טרי">
<meta property="og:description" content="דוכן מיצים טבעיים בשוק הכרמל.">
<meta property="og:image" content="https://juice.example/stand.jpg">
<meta property="og:url" content="https://juice.example">
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Heebo&display=swap">
<link rel="stylesheet" href="/css/styles.abc12345.css">
<link rel="canonical" href="https://juice.example/">
<script type="application/ld+json">{"@context":"https://schema.org"}</script>
</head><body>
<a class="skip-link" href="#main">דלג לתוכן העמוד</a>
<main id="main"><h1>מיץ טרי</h1><p>כוס בגודל 500 מ"ל במחיר ₪12</p></main>
<script>window.dataLayer=window.dataLayer||[];</script>
</body></html>`;

const GOOD_CSS = `.card{margin-inline-start:12px;animation:fade 1s;letter-spacing:.01em}
@keyframes fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){*{animation-duration:.01ms !important}}
body{font-family:Heebo,sans-serif}`;

Deno.test("a bare page trips every mechanical check", () => {
  const files = { "index.html": BARE, "css/styles.css": BARE_CSS };
  // #98 is deliberately not here: a page with no og:image at all is #31's
  // business, and counting the same absence twice would inflate every score.
  // #56 and #78 are absences of a FAULT, not of a feature: a page with no
  // focus rule and no prices has nothing wrong with either, so a bare page is
  // not expected to trip them.
  for (const id of [1, 27, 30, 31, 40, 41, 45, 61, 64, 94, 99, 109]) {
    assertEquals(verdict(files, id).present, true, `#${id} should be present`);
  }
});

Deno.test("a page that does the work trips none of them", () => {
  const files = { "index.html": GOOD, "css/styles.abc12345.css": GOOD_CSS };
  for (const id of MECHANICAL_IDS) {
    assertEquals(verdict(files, id).present, false, `#${id} should be absent`);
  }
});

Deno.test("the same bytes give the same answer every time", () => {
  const files = new Map(Object.entries({ "index.html": BARE, "css/s.css": BARE_CSS }));
  const a = JSON.stringify(mechanicalSignals(files));
  const b = JSON.stringify(mechanicalSignals(files));
  assertEquals(a, b);
});

Deno.test("#64 does not apply to a left-to-right site", () => {
  const ltr = `<!doctype html><html lang="en"><head><title>Juice</title></head><body>Fresh juice</body></html>`;
  const s = verdict({ "index.html": ltr, "s.css": ".a{margin-left:4px}" }, 64);
  assertEquals(s.applicable, false);
  assertEquals(s.present, false);
});

Deno.test("#45 does not apply when nothing animates", () => {
  const s = verdict({ "index.html": BARE, "s.css": ".a{color:red}" }, 45);
  assertEquals(s.applicable, false);
});

Deno.test("#40 does not apply when the site loads no web font", () => {
  const noWebFont = `<html lang="he" dir="rtl"><head><title>מיץ</title></head><body>מיץ</body></html>`;
  const s = verdict({ "index.html": noWebFont, "s.css": "body{font-family:system-ui}" }, 40);
  assertEquals(s.applicable, false);
});

Deno.test("#30 catches a description that just repeats the title", () => {
  const page = `<html lang="en"><head><title>Juice Bar</title>
    <meta name="description" content="Juice Bar"></head><body>x</body></html>`;
  assertEquals(verdict({ "index.html": page }, 30).present, true);
});

Deno.test("#31 fires on partial Open Graph, not only on none at all", () => {
  const page = `<html><head><title>t</title>
    <meta property="og:title" content="t">
    <meta property="og:description" content="d"></head><body>x</body></html>`;
  const s = verdict({ "index.html": page }, 31);
  assertEquals(s.present, true);
  assertEquals(s.evidence?.[0].snippet.includes("og:image"), true);
});

Deno.test("#98 stays out of it when there is no og:image at all — that is #31", () => {
  const page = `<html><head><title>t</title></head><body>x</body></html>`;
  const s = verdict({ "index.html": page }, 98);
  assertEquals(s.applicable, false);
  assertEquals(s.present, false);
});

Deno.test("#98 fires when every page shares one share image", () => {
  const page = (n: string) =>
    `<html><head><title>${n}</title><meta property="og:image" content="/logo.png"></head><body>x</body></html>`;
  assertEquals(verdict({ "a.html": page("a"), "b.html": page("b") }, 98).present, true);
});

Deno.test("#109 ignores emoji inside a script block", () => {
  const page = `<html><head><title>t</title></head><body>
    <p>מיץ טרי</p><script>const wave = "\u{1F44B}";</script></body></html>`;
  assertEquals(verdict({ "index.html": page }, 109).present, false);
});

Deno.test("#1 clears Inter once the typography is actually tuned", () => {
  const css = "body{font-family:Inter,sans-serif;letter-spacing:-0.011em}";
  assertEquals(verdict({ "index.html": BARE, "s.css": css }, 1).present, false);
});

Deno.test("mechanical verdicts overwrite the model's on the same id", () => {
  const modelSaid = [
    { id: 27, name: "old", present: true, applicable: true, weight: "high", confidence: 0.6 },
    { id: 50, name: "kept", present: true, applicable: true, weight: "low", confidence: 0.6 },
  ];
  const merged = overlayMechanical(modelSaid, mechanicalSignals(new Map([["index.html", GOOD]])));
  assertEquals(merged.find((s) => s.id === 27)?.present, false);
  assertEquals(merged.find((s) => s.id === 27)?.confidence, 1);
  // a signal we do not own is passed through untouched
  assertEquals(merged.find((s) => s.id === 50)?.name, "kept");
  // and the list stays in id order
  assertEquals(merged.map((s) => Number(s.id)), [...merged.map((s) => Number(s.id))].sort((a, b) => a - b));
});

// ---------- #2, the worn font list ----------
//
// Seven names and nothing else counts, so this is a lookup. It was a model
// question until an audit marked it present while explaining that the font was
// NOT on the list — the verdict and the reasoning disagreed in one field.

Deno.test("#2: a worn family in a font-family declaration is found", () => {
  const v = verdict({ "style.css": "body{font-family:'Poppins',sans-serif}" }, 2);
  assertEquals(v.present, true);
  assertEquals(v.confidence, 1);
});

Deno.test("#2: a worn family pulled in by a Google Fonts link counts", () => {
  const v = verdict({
    "index.html": `<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400">`,
  }, 2);
  assertEquals(v.present, true);
});

Deno.test("#2: Heebo and Amiri are not on the list", () => {
  const v = verdict({
    "index.html": `<link href="https://fonts.googleapis.com/css2?family=Amiri&family=Heebo:wght@400;700">`,
    "style.css": "body{font-family:'Heebo',system-ui,sans-serif}h1{font-family:'Amiri',serif}",
  }, 2);
  assertEquals(v.present, false);
});

Deno.test("#2: a name that merely contains a worn name is not a match", () => {
  assertEquals(verdict({ "style.css": "body{font-family:'Roboto Slab',serif}" }, 2).present, false);
  assertEquals(verdict({ "style.css": "body{font-family:Latopia,serif}" }, 2).present, false);
});

Deno.test("#2: the family is named in the explanation, both directions", () => {
  const hit = verdict({ "style.css": "body{font-family:Montserrat,sans-serif}" }, 2);
  assert(String(hit.explanation).includes("Montserrat"), String(hit.explanation));
  const miss = verdict({ "style.css": "body{font-family:Heebo,sans-serif}" }, 2);
  assert(String(miss.explanation).includes("Roboto"), "the clean verdict should still name the list");
});

// ---------- #56 focus outline ----------

const RTL_HEAD = `<!doctype html><html lang="he" dir="rtl"><head><title>דף</title>`;

Deno.test("#56 present: focus outline killed with nothing in its place", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שלום עולם וברוך הבא</p></body></html>`,
    "style.css": `.f input:focus{outline:none}`,
  }, 56);
  assertEquals(v.present, true);
  assertEquals(v.applicable, true);
});

Deno.test("#56 absent: a :focus-visible rule elsewhere draws the ring", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שלום עולם וברוך הבא</p></body></html>`,
    "style.css": `a:focus{outline:none}
a:focus-visible{outline:2px solid #333;outline-offset:2px}`,
  }, 56);
  assertEquals(v.present, false);
});

Deno.test("#56 absent: the same block restyles border and background", () => {
  // The written rule says "without a styled alternative". A model called this
  // present anyway; the border and the fill ARE the alternative.
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שלום עולם וברוך הבא</p></body></html>`,
    "style.css": `.field input:focus{outline:none;border-color:#0aa;background:#fff}`,
  }, 56);
  assertEquals(v.present, false);
});

Deno.test("#56 absent: no rule switches the outline off at all", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שלום עולם וברוך הבא</p></body></html>`,
    "style.css": `.card{color:#111}`,
  }, 56);
  assertEquals(v.present, false);
});

// ---------- #61 dataLayer ----------

Deno.test("#61 present: no dataLayer in any script", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><script src="app.js"></script></body></html>`,
    "app.js": `document.querySelector("#nav");`,
  }, 61);
  assertEquals(v.present, true);
});

Deno.test("#61 absent: an inline script initialises dataLayer", () => {
  const v = verdict({
    "index.html":
      `${RTL_HEAD}</head><body><script>window.dataLayer=window.dataLayer||[];</script></body></html>`,
  }, 61);
  assertEquals(v.present, false);
});

Deno.test("#61 absent: dataLayer lives in an external js file", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><script src="app.js"></script></body></html>`,
    "app.js": `window.dataLayer = [];`,
  }, 61);
  assertEquals(v.present, false);
});

// ---------- #78 number and currency direction ----------

Deno.test("#78 absent: symbol-first prices are the CORRECT Hebrew order", () => {
  // Two live runs reported this signal present and quoted ₪180 as the proof.
  // ₪180 is right. The whole point of moving the signal here is that it stops
  // being reported as wrong.
  const v = verdict({
    "index.html":
      `${RTL_HEAD}</head><body><p>מחיר השולחן הוא <span>₪180</span> וגם <span>₪260</span> לכיסא</p></body></html>`,
  }, 78);
  assertEquals(v.present, false);
  assertEquals(v.applicable, true);
});

Deno.test("#78 present: the symbol trails the number", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>מחיר השולחן הוא 180 ₪ בלבד</p></body></html>`,
  }, 78);
  assertEquals(v.present, true);
});

Deno.test("#78 present: a number fused to the Hebrew word after it", () => {
  // "₪ 24,900לפרטים" shipped in a real build.
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שולחן אלון מלא ₪ 24,900לפרטים</p></body></html>`,
  }, 78);
  assertEquals(v.present, true);
});

Deno.test("#78 absent: a one-letter Hebrew prefix on a year is正 legitimate", () => {
  // "ב2024" is how the language is written; flagging it would be a false alarm.
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>החברה הוקמה ב2024 והיא ממשיכה לצמוח</p></body></html>`,
  }, 78);
  assertEquals(v.present, false);
});

Deno.test("#78 not applicable: a left-to-right site", () => {
  const v = verdict({
    "index.html": `<!doctype html><html lang="en"><head><title>Shop</title></head>
<body><p>The price is 180 $ only</p></body></html>`,
  }, 78);
  assertEquals(v.applicable, false);
});

Deno.test("#78 absent: markup boundaries do not count as fused text", () => {
  // Tags become a space, so </span> followed by a word is not adjacency.
  const v = verdict({
    "index.html":
      `${RTL_HEAD}</head><body><p><span>1200</span></p><p>מוצרים במלאי כרגע</p></body></html>`,
  }, 78);
  assertEquals(v.present, false);
});

// ---------- #99 canonical ----------

Deno.test("#99 present: no canonical on any page", () => {
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>שלום עולם וברוך הבא</p></body></html>`,
  }, 99);
  assertEquals(v.present, true);
});

Deno.test("#99 absent: every page carries its own canonical", () => {
  const v = verdict({
    "index.html":
      `${RTL_HEAD}<link rel="canonical" href="https://x.co/"></head><body><p>שלום עולם</p></body></html>`,
    "about.html":
      `${RTL_HEAD}<link rel="canonical" href="https://x.co/about"></head><body><p>עלינו</p></body></html>`,
  }, 99);
  assertEquals(v.present, false);
});

Deno.test("#99 present: two pages share one canonical instead of self-referencing", () => {
  const v = verdict({
    "index.html":
      `${RTL_HEAD}<link rel="canonical" href="https://x.co/"></head><body><p>שלום עולם</p></body></html>`,
    "about.html":
      `${RTL_HEAD}<link rel="canonical" href="https://x.co/"></head><body><p>עלינו</p></body></html>`,
  }, 99);
  assertEquals(v.present, true);
});

Deno.test("#99 present: one page of three is missing the tag", () => {
  const page = (h: string) => `${RTL_HEAD}${h}</head><body><p>שלום עולם</p></body></html>`;
  const v = verdict({
    "index.html": page(`<link rel="canonical" href="https://x.co/">`),
    "about.html": page(`<link rel="canonical" href="https://x.co/about">`),
    "contact.html": page(""),
  }, 99);
  assertEquals(v.present, true);
  assertEquals(v.total_occurrences, 1);
});

Deno.test("#78 absent: a number and a symbol on different lines are not a pair", () => {
  // Matching across a line break paired the last number of one sentence with
  // the currency opening the next, and reported a fault that is not there.
  const v = verdict({
    "index.html": `${RTL_HEAD}</head><body><p>המשלוח מגיע תוך 3
₪45 דמי טיפול לכל הזמנה</p></body></html>`,
  }, 78);
  assertEquals(v.present, false);
});

// ---------- #28 / #29 headings ----------

Deno.test("#28 present: two h1 on one page", () => {
  const html = `<html><body><h1>מיץ טרי</h1><h2>טעמים</h2><h1>סניפים</h1></body></html>`;
  const s = verdict({ "index.html": html }, 28);
  assertEquals(s.present, true);
  assertEquals(s.total_occurrences, 2);
});

Deno.test("#28 absent: one h1, however many lower headings", () => {
  const html = `<html><body><h1>מיץ</h1><h2>א</h2><h2>ב</h2><h3>ג</h3></body></html>`;
  assertEquals(verdict({ "index.html": html }, 28).present, false);
});

Deno.test("#28 ignores an h1 inside a comment or a script", () => {
  const html = `<html><body><h1>מיץ</h1><!-- <h1>ישן</h1> --><script>var t="<h1>x</h1>"</script></body></html>`;
  assertEquals(verdict({ "index.html": html }, 28).present, false);
});

Deno.test("#29 present: h2 straight to h4", () => {
  const html = `<html><body><h1>א</h1><h2>ב</h2><h4>ג</h4></body></html>`;
  const s = verdict({ "index.html": html }, 29);
  assertEquals(s.present, true);
});

Deno.test("#29 present: h3 before the first h2", () => {
  const html = `<html><body><h1>א</h1><h3>ב</h3><h2>ג</h2></body></html>`;
  assertEquals(verdict({ "index.html": html }, 29).present, true);
});

Deno.test("#29 absent: climbing back up is not a skip", () => {
  const html = `<html><body><h1>א</h1><h2>ב</h2><h3>ג</h3><h2>ד</h2><h3>ה</h3></body></html>`;
  assertEquals(verdict({ "index.html": html }, 29).present, false);
});

// ---------- #97 duplicate description ----------

const withDesc = (d: string) =>
  `<html><head><title>t</title><meta name="description" content="${d}"></head><body></body></html>`;

Deno.test("#97 present: the same description on two pages", () => {
  const s = verdict({
    "index.html": withDesc("ברוכים הבאים לאתר שלנו"),
    "about.html": withDesc("ברוכים הבאים לאתר שלנו"),
  }, 97);
  assertEquals(s.present, true);
});

Deno.test("#97 absent: every page describes itself", () => {
  const s = verdict({
    "index.html": withDesc("דוכן מיצים בשוק הכרמל"),
    "about.html": withDesc("הסיפור של הדוכן משנת 1974"),
  }, 97);
  assertEquals(s.present, false);
});

Deno.test("#97 does not apply to a single-page site", () => {
  const s = verdict({ "index.html": withDesc("דוכן מיצים") }, 97);
  assertEquals(s.applicable, false);
  assertEquals(s.present, false);
});

Deno.test("#97 leaves a MISSING description to #30", () => {
  const bare = `<html><head><title>t</title></head><body></body></html>`;
  assertEquals(verdict({ "a.html": bare, "b.html": bare }, 97).present, false);
});

// ---------- #8 font-display ----------

Deno.test("#8 present: @font-face without font-display", () => {
  const css = `@font-face{font-family:Heebo;src:url(/f/heebo.woff2)}`;
  assertEquals(verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 8).present, true);
});

Deno.test("#8 absent: swap is set", () => {
  const css = `@font-face{font-family:Heebo;src:url(/f/heebo.woff2);font-display:swap}`;
  assertEquals(verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 8).present, false);
});

Deno.test("#8 present: a Google Fonts link with no display parameter", () => {
  const html = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400"></head><body></body></html>`;
  assertEquals(verdict({ "index.html": html }, 8).present, true);
});

Deno.test("#8 ignores a preconnect, which loads no font", () => {
  const html = `<html><head><link rel="preconnect" href="https://fonts.googleapis.com"></head><body></body></html>`;
  const s = verdict({ "index.html": html }, 8);
  assertEquals(s.applicable, false);
});

Deno.test("#8 does not apply to a site with no web font at all", () => {
  const s = verdict({ "index.html": "<html><body></body></html>", "s.css": "body{font-family:system-ui}" }, 8);
  assertEquals(s.applicable, false);
  assertEquals(s.present, false);
});

// ---------- #13 dark #000 ----------

Deno.test("#13 present: black body inside a dark media query", () => {
  const css = `body{background:#fff}
@media (prefers-color-scheme: dark){body{background-color:#000;color:#fff}}`;
  assertEquals(verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 13).present, true);
});

Deno.test("#13 present: black body on a .dark theme selector", () => {
  const css = `.dark body{background:#000000}`;
  assertEquals(verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 13).present, true);
});

Deno.test("#13 absent: dark mode uses a near-black, not #000", () => {
  const css = `@media (prefers-color-scheme: dark){body{background-color:#111827}}`;
  assertEquals(verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 13).present, false);
});

Deno.test("#13 ignores a black FOOTER on a light site", () => {
  const css = `body{background:#fff}footer{background:#000;color:#fff}`;
  const s = verdict({ "index.html": "<html><body></body></html>", "s.css": css }, 13);
  assertEquals(s.applicable, false);
  assertEquals(s.present, false);
});

// ---------- #35 / #36 images ----------

Deno.test("#35 present: an img with neither dimension", () => {
  const html = `<html><body><img src="/a.webp" alt="דוכן"></body></html>`;
  assertEquals(verdict({ "index.html": html }, 35).present, true);
});

Deno.test("#35 present: width without height still causes CLS", () => {
  const html = `<html><body><img src="/a.webp" width="400" alt="דוכן"></body></html>`;
  assertEquals(verdict({ "index.html": html }, 35).present, true);
});

Deno.test("#35 absent: both dimensions given", () => {
  const html = `<html><body><img src="/a.webp" width="400" height="300" alt="דוכן"></body></html>`;
  assertEquals(verdict({ "index.html": html }, 35).present, false);
});

Deno.test("#36 present: a PNG in a CSS background", () => {
  const s = verdict({ "index.html": "<html><body></body></html>", "s.css": ".hero{background:url('/img/hero.png')}" }, 36);
  assertEquals(s.present, true);
});

Deno.test("#36 absent: an og:image is not an image the page paints", () => {
  const html = `<html><head><meta property="og:image" content="https://x.example/card.jpg"></head>
<body><img src="/a.webp" width="1" height="1" alt="a"></body></html>`;
  assertEquals(verdict({ "index.html": html }, 36).present, false);
});

Deno.test("#36 reads every candidate in a srcset", () => {
  const html = `<html><body><img src="/a.webp" srcset="/a.webp 1x, /a@2x.png 2x" alt="a"></body></html>`;
  assertEquals(verdict({ "index.html": html }, 36).present, true);
});

// ---------- #55 clickable div ----------

Deno.test("#55 present: a div with onclick and nothing else", () => {
  const html = `<html><body><div onclick="buy()">קנה</div></body></html>`;
  assertEquals(verdict({ "index.html": html }, 55).present, true);
});

Deno.test("#55 present: role and tabindex but no key handler", () => {
  const html = `<html><body><div onclick="buy()" role="button" tabindex="0">קנה</div></body></html>`;
  assertEquals(verdict({ "index.html": html }, 55).present, true);
});

Deno.test("#55 absent: all three parts are there", () => {
  const html = `<html><body><div onclick="buy()" onkeydown="k(event)" role="button" tabindex="0">קנה</div></body></html>`;
  assertEquals(verdict({ "index.html": html }, 55).present, false);
});

Deno.test("#55 absent: a real button needs none of it", () => {
  const html = `<html><body><button onclick="buy()">קנה</button></body></html>`;
  assertEquals(verdict({ "index.html": html }, 55).present, false);
});
