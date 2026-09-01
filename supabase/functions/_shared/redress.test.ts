import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  applyColourMap,
  applyFontStack,
  buildColourMap,
  embeddedCss,
  paletteOf,
  primaryFontStack,
  redressSecondaryPages,
  relativePath,
  rewriteEmbeddedCss,
  scopedTokens,
  type Shell,
  TOKENS_FILE,
} from "./redress.ts";

// A palette shaped like the ones real runs produce: a near-black ink, a soft
// ink, a light surface, white, a hairline, and saturated accents.
const OLD_CSS = `:root{
  --cyan:#00b3e6; --magenta:#ff2d87; --yellow:#ffd400;
  --ink:#14121a; --ink-soft:#55505f;
  --paper:#fbf9f6; --paper-2:#ffffff; --line:#e6e1da;
  --radius:18px;
}
body{font-family:"Heebo","Assistant",sans-serif;color:var(--ink);background:var(--paper)}
.card{background:#fff;border:1px solid #e6e1da;border-radius:var(--radius)}
.badge{background:#00b3e6;color:#fff}`;

const NEW_TOKENS = `:root{--ink:#1c1b18;--ink-soft:#38352d;--ink-mute:#5a5648;
--press-red:#c8452e;--newsprint:#ece7dc;--card:#f6f2e9;--card-hi:#fbf9f2;
--kraft:#b9a88a;--white:#ffffff}
body{font-family:"Rubik",system-ui,sans-serif;line-height:1.6}`;

const SHELL: Shell = {
  head_extras: `<link rel="preconnect" href="https://fonts.googleapis.com">`,
  tokens_css: NEW_TOKENS,
  header_html: `<header class="site-header"><nav id="nav"><a href="index.html">בית</a></nav></header>`,
  footer_html: `<footer class="site-footer"><p>דפוס פיקסל</p></footer>`,
};

const PAGE = (body: string) =>
  `<!doctype html><html lang="he" dir="rtl"><head><title>עמוד</title>
<link rel="stylesheet" href="style.css"></head><body>
<header class="old"><nav id="nav"><a href="/">בית</a></nav></header>
${body}
<footer class="old"><p>כל הזכויות שמורות</p></footer>
<script src="script.js"></script></body></html>`;

function project() {
  return new Map<string, string>([
    ["index.html", PAGE(`<main><h1>ראשי</h1></main>`)],
    ["contact.html", PAGE(`<main><h1>צור קשר</h1><p>טלפון 03-1234567</p></main>`)],
    ["products.html", PAGE(`<main><h1>מוצרים</h1><p>מחיר ₪180</p></main>`)],
    ["style.css", OLD_CSS],
    ["script.js", `document.querySelector("#nav").addEventListener("click",()=>{});`],
  ]);
}

Deno.test("the carried nav points at the rebuilt page, not at this one", () => {
  // The shell's nav links are anchors into the ONE page that was rebuilt. On a
  // secondary page they have to cross over to it or they are dead links.
  const shell = {
    ...SHELL,
    header_html: `<header><nav><a href="#הישגים">הישגים</a><a href="index.html">בית</a></nav></header>`,
  };
  const r = redressSecondaryPages(project(), shell, "index.html");
  const contact = r.files.get("contact.html") ?? "";
  assertStringIncludes(contact, `href="index.html#הישגים"`);
  assertStringIncludes(contact, `href="index.html"`); // a page link is left alone
});

Deno.test("a nav carried into a subfolder climbs back out to the rebuilt page", () => {
  const files = project();
  files.set("pages/about.html", PAGE(`<main><h1>אודות</h1></main>`));
  const shell = {
    ...SHELL,
    header_html: `<header><nav><a href="#הישגים">הישגים</a></nav></header>`,
  };
  const r = redressSecondaryPages(files, shell, "index.html");
  assertStringIncludes(r.files.get("pages/about.html") ?? "", `href="../index.html#הישגים"`);
});

Deno.test("relativePath walks between bundle paths", () => {
  assertEquals(relativePath("contact.html", "index.html"), "index.html");
  assertEquals(relativePath("pages/about.html", "index.html"), "../index.html");
  assertEquals(relativePath("a/b/c.html", "a/index.html"), "../index.html");
  assertEquals(relativePath("a/b.html", "a/index.html"), "index.html");
});

// ---------- palette ----------

Deno.test("paletteOf reads each distinct hex once", () => {
  const p = paletteOf(OLD_CSS);
  const raws = p.map((c) => c.raw);
  assertEquals(new Set(raws).size, raws.length);
  assert(raws.includes("#00b3e6"));
  assert(raws.includes("#14121a"));
});

Deno.test("colours are sorted into the job they do, not by their name", () => {
  const byRaw = new Map(paletteOf(OLD_CSS).map((c) => [c.raw, c.role]));
  assertEquals(byRaw.get("#14121a"), "ink");
  assertEquals(byRaw.get("#fbf9f6"), "surface");
  assertEquals(byRaw.get("#ffffff"), "surface");
  assertEquals(byRaw.get("#00b3e6"), "accent");
  assertEquals(byRaw.get("#ff2d87"), "accent");
});

Deno.test("every old colour is given a new one", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  for (const c of paletteOf(OLD_CSS)) {
    const move = map.get(c.raw);
    // A colour is either moved, or already identical in the new palette.
    assert(move || paletteOf(NEW_TOKENS).some((n) => n.raw === c.raw), `#${c.raw} unmapped`);
  }
});

Deno.test("ink stays dark and surface stays light after the swap", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const newBy = new Map(paletteOf(NEW_TOKENS).map((c) => [c.raw, c]));
  const ink = map.get("#14121a");
  const paper = map.get("#fbf9f6");
  assert(ink && newBy.get(ink.to)!.l < 0.3, "ink must land on a dark colour");
  assert(paper && newBy.get(paper.to)!.l > 0.8, "surface must land on a light colour");
});

Deno.test("three old accents may collapse onto one new brand colour", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const accents = ["#00b3e6", "#ff2d87", "#ffd400"].map((h) => map.get(h)?.to);
  assert(accents.every((a) => a !== undefined));
  // The new palette names a single accent, so all three land on it. That IS
  // signal #84's answer: one strong brand colour instead of a spread.
  assertEquals(new Set(accents).size, 1);
});

Deno.test("applyColourMap catches the short form of a mapped colour", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const out = applyColourMap(`.a{color:#fff}`, map);
  // #fff is #ffffff, which the palette holds. It must not survive untouched.
  assertEquals(out.includes("#fff}"), false);
});

Deno.test("applyColourMap leaves everything that is not a colour alone", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const out = applyColourMap(`.a{border-radius:18px;content:"#hash"}`, map);
  assertStringIncludes(out, "border-radius:18px");
});

// ---------- type ----------

Deno.test("primaryFontStack takes the new design's body face", () => {
  assertEquals(primaryFontStack(NEW_TOKENS), `"Rubik",system-ui,sans-serif`);
});

Deno.test("applyFontStack replaces a named family", () => {
  const out = applyFontStack(`body{font-family:"Heebo",sans-serif}`, `"Rubik",sans-serif`);
  assertStringIncludes(out, `font-family: "Rubik",sans-serif`);
  assertEquals(out.includes("Heebo"), false);
});

Deno.test("applyFontStack leaves inherit and var() plumbing alone", () => {
  const src = `.a{font-family:inherit}.b{font-family:var(--display)}`;
  assertEquals(applyFontStack(src, `"Rubik",sans-serif`), src);
});

// ---------- the pass ----------

Deno.test("the rebuilt page is never touched", () => {
  const files = project();
  const r = redressSecondaryPages(files, SHELL, "index.html");
  assertEquals(r.files.has("index.html"), false);
  assertEquals(r.pages.includes("index.html"), false);
});

Deno.test("every secondary page is re-dressed", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  assertEquals(r.pages.sort(), ["contact.html", "products.html"]);
});

Deno.test("the new header and footer replace the old ones", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  const out = r.files.get("contact.html")!;
  assertStringIncludes(out, `class="site-header"`);
  assertStringIncludes(out, `class="site-footer"`);
  assertEquals(out.includes(`<header class="old">`), false);
  assertEquals(out.includes("כל הזכויות שמורות"), false);
});

Deno.test("the page's own content survives the re-dress", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  assertStringIncludes(r.files.get("contact.html")!, "03-1234567");
  assertStringIncludes(r.files.get("products.html")!, "₪180");
});

Deno.test("an id the site's script needs survives the new header", () => {
  // A real run lost <nav id="nav"> and threw on every scroll.
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  assertStringIncludes(r.files.get("contact.html")!, `id="nav"`);
});

Deno.test("the tokens are published and linked from each page", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  // Published SCOPED: the palette travels, the base element styles do not.
  assertEquals(r.files.get(TOKENS_FILE), scopedTokens(NEW_TOKENS));
  assertStringIncludes(r.files.get(TOKENS_FILE)!, "--press-red:#c8452e");
  assertEquals(r.files.get(TOKENS_FILE)!.includes("font-family:\"Rubik\""), false);
  assertStringIncludes(r.files.get("contact.html")!, `href="${TOKENS_FILE}"`);
});

Deno.test("the tokens are linked BEFORE the page's own stylesheet", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  const out = r.files.get("contact.html")!;
  assert(out.indexOf(TOKENS_FILE) < out.indexOf("style.css"));
});

Deno.test("the old stylesheet is re-valued, never removed", () => {
  const r = redressSecondaryPages(project(), SHELL, "index.html");
  const css = r.files.get("style.css")!;
  // Every rule the page's layout depends on is still there...
  assertStringIncludes(css, ".card{");
  assertStringIncludes(css, "border-radius:var(--radius)");
  // ...and the old brand colour is gone from it.
  assertEquals(css.includes("#00b3e6"), false);
  assertEquals(css.includes("Heebo"), false);
});

Deno.test("a site with no secondary pages produces no changes at all", () => {
  const only = new Map([["index.html", PAGE("<main>יחיד</main>")], ["style.css", OLD_CSS]]);
  const r = redressSecondaryPages(only, SHELL, "index.html");
  assertEquals(r.files.size, 0);
  assertEquals(r.pages.length, 0);
});

Deno.test("a page with no header or footer is reported, not silently passed", () => {
  const files = project();
  files.set("bare.html", `<!doctype html><html lang="he" dir="rtl"><head>
<link rel="stylesheet" href="style.css"></head><body><main>ללא כותרת</main></body></html>`);
  const r = redressSecondaryPages(files, SHELL, "index.html");
  assertEquals(r.skipped.map((s) => s.file), ["bare.html"]);
  // It still gets the palette and the tokens — the report is about the chrome.
  assertStringIncludes(r.files.get("bare.html")!, TOKENS_FILE);
});

Deno.test("a warm off-white is a surface, not a brand accent", () => {
  // #ece7dc scores 0.30 on HSL saturation because saturation divides by
  // distance from white. Reading it as an accent mapped the site's ink onto a
  // background colour. Chroma keeps every near-neutral where it belongs.
  const roles = new Map(paletteOf(NEW_TOKENS).map((c) => [c.raw, c.role]));
  assertEquals(roles.get("#ece7dc"), "surface");
  assertEquals(roles.get("#fbf9f2"), "surface");
  assertEquals(roles.get("#c8452e"), "accent");
});

Deno.test("white stays white instead of sliding onto a tint", () => {
  // Rank-matching sent #ffffff onto #f0d3cb, a pink tint, on a real site:
  // white was third in one list and the tint third in the other. Nearest
  // lightness has no such drift.
  const withWhite = `:root{--a:#c8452e;--b:#f0d3cb;--c:#ece7dc;--d:#ffffff;--e:#1c1b18}`;
  const map = buildColourMap(OLD_CSS, withWhite);
  const white = map.get("#ffffff");
  // Either it is left alone (already identical) or it lands on white.
  assertEquals(white === undefined || white.to === "#ffffff", true);
});

Deno.test("a colour maps to something of its own role", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const roles = new Map(paletteOf(NEW_TOKENS).map((c) => [c.raw, c.role]));
  for (const move of map.values()) {
    // The new palette has every role the old one uses here, so no fallback
    // should fire and each colour must keep its job.
    assertEquals(roles.get(move.to), move.role, `${move.from} -> ${move.to}`);
  }
});

Deno.test("the page stops fetching the typeface it no longer uses", () => {
  const files = project();
  files.set(
    "contact.html",
    PAGE(`<main><h1>צור קשר</h1></main>`).replace(
      "</head>",
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo&display=swap"></head>`,
    ),
  );
  const r = redressSecondaryPages(files, SHELL, "index.html");
  const out = r.files.get("contact.html")!;
  assertEquals(out.includes("family=Heebo"), false);
  // The new design's own head material is untouched by the strip.
  assertStringIncludes(out, "fonts.googleapis.com");
});

// ---------- scoped tokens ----------

Deno.test("scopedTokens keeps the palette and drops bare element rules", () => {
  const css = `:root{--ink:#111;--pad:1rem}
body{font-family:Rubik;color:var(--ink)}
h1,h2,h3{color:var(--ink);font-weight:700}
.container{max-width:1180px}
.btn{background:var(--ink)}`;
  const out = scopedTokens(css);
  assertStringIncludes(out, "--ink:#111");
  assertStringIncludes(out, ".container{max-width:1180px}");
  assertStringIncludes(out, ".btn{");
  assertEquals(/(^|})body\{/.test(out), false);
  assertEquals(/(^|})h1,h2,h3\{/.test(out), false);
});

Deno.test("scopedTokens keeps a focus ring on a bare element", () => {
  // It cannot repaint anything that was readable before, and it is the whole
  // of signal #56's answer for a keyboard user.
  const out = scopedTokens(`a:focus-visible{outline:2px solid #c8452e}p{color:#111}`);
  assertStringIncludes(out, "a:focus-visible{");
  assertEquals(out.includes("p{color:#111}"), false);
});

Deno.test("scopedTokens passes at-rules through untouched", () => {
  const out = scopedTokens(`@media (max-width:600px){.container{padding:0}}:root{--a:#fff}`);
  assertStringIncludes(out, "@media (max-width:600px)");
  assertStringIncludes(out, "--a:#fff");
});

Deno.test("a heading that inherited its colour is not repainted", () => {
  // The regression in full: the page put white on the hero and let the h1
  // inherit it; an h1 rule in the new tokens turned it near-black on
  // near-black. The words stayed in the DOM, so the content guard passed.
  const files = project();
  files.set(
    "contact.html",
    PAGE(`<section class="hero"><h1>בואו נדבר על ההזמנה שלכם</h1></section>`),
  );
  const shell: Shell = { ...SHELL, tokens_css: `:root{--ink:#1c1b18}h1{color:var(--ink)}` };
  const r = redressSecondaryPages(files, shell, "index.html");
  assertEquals(r.files.get(TOKENS_FILE)!.includes("h1{"), false);
  assertStringIncludes(r.files.get(TOKENS_FILE)!, "--ink:#1c1b18");
});

// ---------- css the page carries itself ----------

Deno.test("embeddedCss finds style blocks and inline attributes", () => {
  const html = `<style>.a{color:#ff2d87}</style><div style="background:#00b3e6">x</div>`;
  const css = embeddedCss(html);
  assertStringIncludes(css, "#ff2d87");
  assertStringIncludes(css, "#00b3e6");
});

Deno.test("the page's own style block and inline colours are re-valued", () => {
  // A real gallery page kept its neon cyan, magenta and yellow in one <style>
  // block and thirty-seven inline attributes; re-dressing only the .css files
  // left every card wearing the old brand.
  const files = project();
  files.set(
    "gallery.html",
    PAGE(`<style>.tile{background:#ffd400}</style>
<main><div class="tile" style="background:#ff2d87">עבודה</div></main>`),
  );
  const r = redressSecondaryPages(files, SHELL, "index.html");
  const out = r.files.get("gallery.html")!;
  assertEquals(out.includes("#ffd400"), false);
  assertEquals(out.includes("#ff2d87"), false);
  assertStringIncludes(out, "#c8452e");
});

Deno.test("a colour only the markup knows about is still mapped", () => {
  // #7b5cff appears nowhere in style.css. Building the palette from the
  // stylesheets alone left it untouched on the page.
  const files = project();
  files.set("gallery.html", PAGE(`<main><div style="color:#7b5cff">עבודה</div></main>`));
  const r = redressSecondaryPages(files, SHELL, "index.html");
  assertEquals(r.files.get("gallery.html")!.includes("#7b5cff"), false);
});

Deno.test("rewriteEmbeddedCss leaves the page's text alone", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const html = `<p>הקוד הוא #ff2d87 בטקסט</p><div style="color:#ff2d87">x</div>`;
  const out = rewriteEmbeddedCss(html, map, null);
  assertStringIncludes(out, "הקוד הוא #ff2d87 בטקסט");
  assertEquals(out.includes(`style="color:#ff2d87"`), false);
});

// ---------- rgb() notation ----------

Deno.test("a translucent brand colour is re-valued and keeps its alpha", () => {
  // The hex pass cleared #00b3e6 everywhere and left the same cyan glowing
  // over a real hero as rgba(0,179,230,.40).
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const out = applyColourMap(`.glow{background:rgba(0,179,230,.40)}`, map);
  assertEquals(out.includes("0,179,230"), false);
  assertStringIncludes(out, ",.40)");
});

Deno.test("an opaque rgb() brand colour is mapped too", () => {
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const out = applyColourMap(`.a{color:rgb(255,45,135)}`, map);
  assertEquals(out.includes("255,45,135"), false);
});

Deno.test("a plain black shadow is left alone", () => {
  // rgba(0,0,0,.5) is a shadow habit, not a brand colour, and the palette
  // deliberately never learned it.
  const map = buildColourMap(OLD_CSS, NEW_TOKENS);
  const src = `.a{box-shadow:0 2px 4px rgba(0,0,0,.5)}`;
  assertEquals(applyColourMap(src, map), src);
});

Deno.test("translucent values do not join the palette", () => {
  // Letting them in floods the role buckets with near-blacks.
  const raws = paletteOf(`.a{color:rgba(0,0,0,.06);background:rgb(200,69,46)}`).map((c) => c.raw);
  assertEquals(raws.includes("#000000"), false);
  assert(raws.includes("#c8452e"));
});
