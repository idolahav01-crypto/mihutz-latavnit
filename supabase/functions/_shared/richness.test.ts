import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkRichness,
  collectCss,
  MIN_RICHNESS_RATIO,
  richnessBrief,
  richnessTargets,
  scoreRichness,
} from "./richness.ts";

const PAGE = "index.html";

// A site with a real design language: layered palette, type contrast, borders,
// motion, considered finish.
const RICH_CSS = `
:root{--ink:#1a1a1a;--paper:#f7f3ec;--clay:#b4553a;--clay-dark:#8c3f2b;--line:#ddd6c9;--slate:#6b6459}
body{font-family:Heebo,sans-serif;font-weight:500;line-height:1.65;font-size:17px;color:#1a1a1a}
h1{font-size:56px;font-weight:800;letter-spacing:-.02em;line-height:1.05}
h2{font-size:34px;font-weight:700;letter-spacing:-.01em}
h3{font-size:22px;font-weight:600}
small{font-size:13px;letter-spacing:.18em;text-transform:uppercase}
.card{border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 8px rgba(26,26,26,.08)}
.card--flat{border-radius:4px;border-block-end:2px solid var(--clay)}
.btn{background:linear-gradient(120deg,#b4553a,#8c3f2b);border-radius:999px;transition:transform .18s ease}
.btn:hover{transform:translateY(-2px)}
.btn:focus-visible{outline:2px solid var(--clay-dark)}
.btn:active{transform:translateY(0)}
.hero{opacity:.98;filter:saturate(1.05)}
@keyframes rise{from{opacity:0}to{opacity:1}}
`;

// The same site drained: one accent, three weights, no layering, one transition.
const PALE_CSS = `
:root{--ink:#222;--paper:#fff;--accent:#b4553a}
body{font-family:Heebo,sans-serif;font-weight:400;line-height:1.6;font-size:17px;color:#222}
h1{font-size:40px;font-weight:700}
h2{font-size:28px;font-weight:500}
.card{border:1px solid #eee}
.btn{background:#b4553a;transition:opacity .2s}
.btn:hover{opacity:.9}
`;

function files(css: string): Map<string, string> {
  return new Map([[PAGE, `<html dir="rtl"><head><style>${css}</style></head><body><h1>כ</h1></body></html>`]]);
}

// ---------- collectCss ----------

Deno.test("collectCss: inline blocks, linked stylesheets and style attributes", () => {
  const css = collectCss(
    new Map([
      [PAGE, `<style>.a{color:red}</style><div style="margin:8px">x</div>`],
      ["style.css", `.b{color:blue}`],
    ]),
    PAGE,
  );
  assertStringIncludes(css, "color:red");
  assertStringIncludes(css, "color:blue");
  assertStringIncludes(css, "margin:8px");
});

// ---------- scoreRichness ----------

Deno.test("scoreRichness: a designed page scores far above a drained one", () => {
  const rich = scoreRichness(RICH_CSS).total;
  const pale = scoreRichness(PALE_CSS).total;
  assert(rich > pale * 1.5, `rich ${rich} should dominate pale ${pale}`);
});

Deno.test("scoreRichness: repetition is not richness", () => {
  const one = ".a{border:1px solid #eee}";
  const forty = Array.from({ length: 40 }, (_, i) => `.a${i}{border:1px solid #eee}`).join("");
  assertEquals(scoreRichness(one).depth, scoreRichness(forty).depth);
});

Deno.test("scoreRichness: layering can be reached with borders instead of shadows", () => {
  const shadows = ".a{box-shadow:0 1px 2px #111}.b{box-shadow:0 4px 12px #222}.c{box-shadow:0 8px 24px #333}";
  const borders = ".a{border:1px solid #111}.b{border-block-end:2px solid #222}" +
    ".c{border-inline-start:3px solid #333}.d{outline:1px dashed #444}";
  assert(scoreRichness(borders).depth > 0);
  assert(scoreRichness(shadows).depth > 0);
});

Deno.test("scoreRichness: an empty stylesheet scores zero", () => {
  assertEquals(scoreRichness("").total, 0);
});

// ---------- checkRichness ----------

Deno.test("checkRichness: draining the design fails the floor", () => {
  const r = checkRichness(files(RICH_CSS), files(PALE_CSS), PAGE);
  assertFalse(r.ok);
  assert(r.ratio < 1);
  assertStringIncludes(r.detail, "design depth fell");
  assert(r.thinnest.length > 0);
});

Deno.test("checkRichness: a different but equally considered design passes", () => {
  // No gradients and no shadows at all — layering done with borders, plus more
  // type contrast. This must pass, or the floor would be forcing AI tells back.
  const ALTERNATIVE = `
  :root{--ink:#101010;--paper:#fbfaf7;--brand:#123c2b;--brand-2:#1d5a41;--brand-3:#0a241a;--line:#d8d3c7;--muted:#5f5a51}
  body{font-family:Assistant,sans-serif;font-weight:500;line-height:1.7;font-size:17px;color:#101010}
  h1{font-size:60px;font-weight:900;letter-spacing:-.03em;line-height:1.02}
  h2{font-size:36px;font-weight:800;letter-spacing:-.015em}
  h3{font-size:21px;font-weight:700}
  h4{font-size:15px;font-weight:600;letter-spacing:.2em;text-transform:uppercase}
  .rule{border-block-end:3px solid var(--ink)}
  .card{border:1px solid var(--line);border-radius:2px}
  .card--lead{border-radius:18px;border-inline-start:4px solid var(--brand)}
  .btn{background:var(--brand);border-radius:6px;transition:background .2s ease}
  .btn:hover{background:var(--brand-2)}
  .btn:focus-visible{outline:3px solid var(--brand-3)}
  .btn:active{transform:scale(.99)}
  .quiet{opacity:.72}
  .lede{line-height:1.45;letter-spacing:.01em}
  .meta{line-height:1.9;letter-spacing:.12em}
  .divider{border-block-start:1px solid var(--muted)}
  .link{transition:color .15s ease}
  .link:hover{color:var(--brand-2)}
  @keyframes fade{from{opacity:0}to{opacity:1}}`;
  const r = checkRichness(files(RICH_CSS), files(ALTERNATIVE), PAGE);
  assert(r.ok, r.detail);
});

Deno.test("checkRichness: an unstyled original cannot be under-served", () => {
  const r = checkRichness(new Map([[PAGE, "<html><body>x</body></html>"]]), files(PALE_CSS), PAGE);
  assert(r.ok);
  assertEquals(r.ratio, 1);
});

Deno.test("checkRichness: parity is the configured bar", () => {
  assertEquals(MIN_RICHNESS_RATIO, 1.0);
  const same = checkRichness(files(RICH_CSS), files(RICH_CSS), PAGE);
  assert(same.ok);
  assertEquals(same.ratio, 1);
});

// ---------- the briefs ----------

Deno.test("richnessTargets: states counts, never devices to add", () => {
  const brief = richnessTargets(RICH_CSS);
  assertStringIncludes(brief, "distinct colours");
  assertStringIncludes(brief, "font weights");
  assertStringIncludes(brief, "Depth score to beat");
  // It must not tell the builder to emit the very things the audit penalises.
  assertFalse(/add a gradient|use a glow|drop shadow on every/i.test(brief));
});

Deno.test("richnessBrief: silent on success, category-shaped on failure", () => {
  const pass = checkRichness(files(RICH_CSS), files(RICH_CSS), PAGE);
  assertEquals(richnessBrief(pass), "");
  const fail = checkRichness(files(RICH_CSS), files(PALE_CSS), PAGE);
  const brief = richnessBrief(fail);
  assertStringIncludes(brief, "design_depth");
  assertStringIncludes(brief, "visually thinner");
});
