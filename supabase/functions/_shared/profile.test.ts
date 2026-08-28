import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  assetInventory,
  detectLanguage,
  fontChoices,
  HEBREW_SAFE_FONTS,
  isAiDefaultColour,
  normHex,
} from "./profile.ts";

const m = (o: Record<string, string>) => new Map(Object.entries(o));

// ---------- colour ----------

Deno.test("normHex accepts the shapes a stylesheet actually uses", () => {
  assertEquals(normHex("#ABC"), "#aabbcc");
  assertEquals(normHex("#6366F1"), "#6366f1");
  assertEquals(normHex(" #6366f1 "), "#6366f1");
  assertEquals(normHex("6366f1"), "#6366f1");
  assertEquals(normHex("rebeccapurple"), null);
  assertEquals(normHex(""), null);
  assertEquals(normHex(undefined), null);
});

Deno.test("isAiDefaultColour: the tool defaults the catalogue names", () => {
  assert(isAiDefaultColour("#6366f1"), "tailwind indigo, signal #11");
  assert(isAiDefaultColour("#8b5cf6"), "tailwind violet");
  assert(isAiDefaultColour("#3b82f6"), "tailwind blue");
  assert(isAiDefaultColour("#D4A853"), "the dark+gold cliche, signal #67");
  assert(isAiDefaultColour("#55ffee"), "neon: saturation >90%, lightness >60%, signal #14");
  assert(isAiDefaultColour("#000000"));
  assert(isAiDefaultColour("#ffffff"));
});

Deno.test("isAiDefaultColour: a real brand colour is not a default", () => {
  assertFalse(isAiDefaultColour("#e2001a"), "Bank Hapoalim red, the catalogue's own example");
  assertFalse(isAiDefaultColour("#1b4b8f"), "a deep navy nobody's generator picked");
  assertFalse(isAiDefaultColour("#2f6f4e"), "a muted green");
  assertFalse(isAiDefaultColour("#7a3b2e"), "a brick brown");
  // The neon test implements signal #14 exactly: saturation >90% AND lightness
  // >60%. A saturated mid-tone cyan misses on lightness and is NOT a default —
  // widening the rule here would quietly overrule the catalogue.
  assertFalse(isAiDefaultColour("#00ffe1"), "lightness is 50%, below the rule's floor");
});

// ---------- fonts ----------

Deno.test("fontChoices: a Hebrew site is offered only Hebrew-capable fonts", () => {
  const rtl = fontChoices(true);
  assertEquals(rtl.length, HEBREW_SAFE_FONTS.length);
  assert(rtl.includes("Heebo"));
  assert(rtl.includes("Frank Ruhl Libre"));
  assertFalse(rtl.includes("Playfair Display"), "the font signal #74 keeps catching");
  assertFalse(rtl.includes("Fraunces"));
});

Deno.test("fontChoices: neither list offers Inter, which is signal #1", () => {
  assertFalse(fontChoices(true).includes("Inter"));
  assertFalse(fontChoices(false).includes("Inter"));
});

// ---------- assets ----------

Deno.test("assetInventory: a site with nothing but a logo says so", () => {
  const inv = assetInventory(m({
    "index.html": `<html><body><img src="/img/logo.svg" alt="logo"><h1>עורך דין</h1></body></html>`,
  }));
  assertEquals(inv.verdict, "logo_only");
  assertEquals(inv.photos, 0);
  assertEquals(inv.chrome, 1);
});

Deno.test("assetInventory: a text-only site has nothing to lay out", () => {
  assertEquals(assetInventory(m({ "index.html": "<html><body><h1>שלום</h1></body></html>" })).verdict, "none");
});

Deno.test("assetInventory: real photographs count, in markup and in CSS", () => {
  const inv = assetInventory(m({
    "index.html": `<img src="/p/1.jpg"><img src="/p/2.jpg"><img src="/p/3.webp"><img src="/icon.svg">`,
    "s.css": `.hero{background:url("/p/hero.jpg")}.b{background:url('/p/b.png')}`,
  }));
  assertEquals(inv.photos, 3);
  assertEquals(inv.css_images, 2);
  assertEquals(inv.chrome, 1);
  assertEquals(inv.verdict, "some");
});

Deno.test("assetInventory: a data: URI is not an asset the site owns", () => {
  const inv = assetInventory(m({ "index.html": `<img src="data:image/png;base64,iVBOR">` }));
  assertEquals(inv.photos, 0);
});

Deno.test("assetInventory: a photo referenced twice is one photo", () => {
  const inv = assetInventory(m({
    "a.html": `<img src="/p/1.jpg">`,
    "b.html": `<img src="/p/1.jpg">`,
  }));
  assertEquals(inv.photos, 1);
});

// ---------- language ----------

Deno.test("detectLanguage: Hebrew is read as supported and RTL", () => {
  const l = detectLanguage(m({ "index.html": "<html><body><h1>דוכן מיצים בשוק הכרמל</h1><p>סחיטה במקום</p></body></html>" }));
  assertEquals(l.code, "he");
  assertEquals(l.rtl, true);
  assertEquals(l.supported, true);
});

Deno.test("detectLanguage: Russian is read, and flagged as untested", () => {
  const l = detectLanguage(m({ "index.html": "<html><body><h1>Свежий сок на рынке</h1><p>Отжимаем при вас</p></body></html>" }));
  assertEquals(l.code, "ru");
  assertEquals(l.supported, false);
  assertEquals(l.rtl, false);
});

Deno.test("detectLanguage: Arabic is RTL and untested", () => {
  const l = detectLanguage(m({ "index.html": "<html><body><h1>عصير طازج في السوق</h1></body></html>" }));
  assertEquals(l.code, "ar");
  assertEquals(l.rtl, true);
  assertEquals(l.supported, false);
});

Deno.test("detectLanguage: markup and scripts are not the site's copy", () => {
  // The Latin in tags, classes and JS must not outvote the Hebrew a reader sees.
  const l = detectLanguage(m({
    "index.html": `<html class="page-wrapper container"><head><style>.hero{background:red}</style>
<script>const applicationBootstrap = "initialiseEverythingNow";</script></head>
<body><h1>מכון כושר בתל אביב</h1><p>אימונים אישיים בהתאמה מלאה</p></body></html>`,
  }));
  assertEquals(l.code, "he");
});

Deno.test("detectLanguage: an empty bundle claims nothing", () => {
  const l = detectLanguage(m({ "index.html": "<html><body></body></html>" }));
  assertEquals(l.code, "unknown");
  assertEquals(l.supported, true, "we never warn about a language we could not read");
});
