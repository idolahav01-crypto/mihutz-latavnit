import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  logicalCssOutsideWidgets,
  logicalProperties,
  REPAIRABLE,
  selfCheck,
  stripVisibleEmoji,
} from "./selfcheck.ts";
import { mechanicalSignals } from "./mechanical.ts";

const PAGE = "index.html";

function page(body: string, css = ""): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>אתר</title><style>${css}</style></head><body>${body}</body></html>`;
}

function present(html: string): number[] {
  return mechanicalSignals(new Map([[PAGE, html]]))
    .filter((s) => s.present === true && s.applicable !== false)
    .map((s) => Number(s.id));
}

// ---------- #109 emoji ----------

Deno.test("stripVisibleEmoji: an emoji in a heading goes", () => {
  const { html, removed } = stripVisibleEmoji("<h2>🎯 טריוויה</h2>");
  assertEquals(removed, 1);
  assertFalse(/🎯/u.test(html));
  assert(html.includes("טריוויה"), "the heading text must survive");
});

Deno.test("stripVisibleEmoji: script and style bodies are left alone", () => {
  const src = `<script>const flag = "🇮🇱";</script><style>.a::after{content:"⚡"}</style><p>נקי</p>`;
  const { html, removed } = stripVisibleEmoji(src);
  assertEquals(removed, 0);
  assertEquals(html, src);
});

Deno.test("stripVisibleEmoji: a page with none is returned untouched", () => {
  const src = "<h1>כותרת</h1><p>טקסט רגיל.</p>";
  assertEquals(stripVisibleEmoji(src).html, src);
});

Deno.test("stripVisibleEmoji: Hebrew, punctuation and arrows survive", () => {
  const src = "<p>מחיר: 199 ₪ — עד 24/7 (א-ה)</p>";
  const { html, removed } = stripVisibleEmoji(src);
  assertEquals(removed, 0);
  assertEquals(html, src);
});

// ---------- #64 physical properties ----------

Deno.test("logicalCssOutsideWidgets: the physical properties the detector looks for", () => {
  const out = logicalCssOutsideWidgets(
    ".a{margin-left:8px;padding-right:4px;border-left:1px solid red;float:left;text-align:right;left:0}",
  );
  for (const gone of ["margin-left:", "padding-right:", "border-left:", "float: left", "text-align: right"]) {
    assertFalse(out.includes(gone), `${gone} should have been rewritten`);
  }
  assert(out.includes("margin-inline-start:"));
  assert(out.includes("padding-inline-end:"));
  assert(out.includes("border-inline-start:"));
  assert(out.includes("float: inline-start"));
  assert(out.includes("text-align: end"));
  assert(out.includes("inset-inline-start:"));
});

Deno.test("logicalCssOutsideWidgets: a carried widget's own CSS is never flipped", () => {
  const css = ".hero{margin-left:8px}\n#rb-widget-3 .quiz-next{margin-left:12px;float:left}";
  const out = logicalCssOutsideWidgets(css);
  assert(out.includes("#rb-widget-3 .quiz-next{margin-left:12px;float:left}"), out);
  assert(out.includes(".hero{margin-inline-start:8px}"), out);
});

Deno.test("logicalCssOutsideWidgets: a media query's contents are still rewritten", () => {
  const out = logicalCssOutsideWidgets("@media (max-width:600px){.a{padding-left:4px}}");
  assert(out.includes("padding-inline-start:"), out);
  assert(out.startsWith("@media (max-width:600px){"), out);
});

Deno.test("logicalCssOutsideWidgets: 'auto' is left alone, as the detector leaves it", () => {
  const css = ".a{left:auto;right:auto}";
  assertEquals(logicalCssOutsideWidgets(css), css);
});

Deno.test("logicalProperties: inline style attributes too", () => {
  const { html } = logicalProperties(`<div style="margin-left:8px">x</div>`);
  assert(html.includes('style="margin-inline-start:8px"'), html);
});

Deno.test("logicalProperties: a value that merely mentions left is not a property", () => {
  const css = ".a{background-position:left top;transition:left .2s}";
  const { html } = logicalProperties(page("<p>x</p>", css));
  assert(html.includes("background-position:left top"), "a keyword value must not be rewritten");
});

// ---------- the loop ----------

Deno.test("selfCheck: repairs are proven by re-running the real detector", () => {
  const before = page(`<h2>⚡ עונה</h2><p>טקסט.</p>`, ".a{margin-left:8px;float:left}");
  assert(present(before).includes(109), "the fixture must actually trip #109");
  assert(present(before).includes(64), "the fixture must actually trip #64");

  const r = selfCheck(PAGE, before);
  assertEquals(r.repaired.slice().sort((a, b) => a - b), [64, 109]);
  assertEquals(r.unrepaired, []);
  assertFalse(r.stillPresent.includes(109));
  assertFalse(r.stillPresent.includes(64));
});

Deno.test("selfCheck: a clean page reports nothing repaired and is not rewritten", () => {
  const clean = page("<h1>כותרת</h1><p>טקסט.</p>", ".a{margin-inline-start:8px}");
  const r = selfCheck(PAGE, clean);
  assertEquals(r.repaired, []);
  assertEquals(r.unrepaired, []);
  assertEquals(r.html, clean);
});

Deno.test("selfCheck: repairing one signal does not light another", () => {
  const before = page(`<h2>🎯 שאלון</h2>`, ".a{margin-left:8px}");
  const r = selfCheck(PAGE, before);
  const introduced = r.stillPresent.filter((id) => !present(before).includes(id));
  assertEquals(introduced, [], `self-check introduced ${introduced.join(", ")}`);
});

Deno.test("selfCheck: it only claims the signals it can actually repair", () => {
  // A signal outside REPAIRABLE is reported as still present, never as fixed.
  const before = page("<h1>כותרת</h1>", ".a{margin-left:8px}");
  const r = selfCheck(PAGE, before);
  for (const id of r.repaired) assert((REPAIRABLE as readonly number[]).includes(id));
});

Deno.test("selfCheck: an LTR page is not touched for #64, which does not apply to it", () => {
  const ltr = `<!doctype html><html lang="en"><head><style>.a{margin-left:8px}</style></head>
    <body><h1>Title</h1></body></html>`;
  const r = selfCheck(PAGE, ltr);
  assertFalse(r.repaired.includes(64), "#64 is not applicable outside RTL");
});
