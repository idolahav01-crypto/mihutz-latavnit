import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  applyFix,
  assembleFinalFiles,
  buildDiffs,
  buildSignalList,
  DELETED_FILE,
  extractCodeRegions,
  filesTouchedByFixes,
  isVerbatimUnique,
  parseBundle,
  pickHomePage,
  presentSignals,
  serializeBundle,
  unifiedDiff,
  unreferencedAssets,
  validateProposals,
} from "./pipeline.ts";

const BUNDLE = `=== FILE: index.html ===
<button class="cta">Get Started</button>
<p>hello</p>

=== FILE: css/app.css ===
:root { --primary: #6366f1; }
body { font-family: 'Inter'; }

`;

Deno.test("parseBundle round-trips paths and content", () => {
  const files = parseBundle(BUNDLE);
  assertEquals([...files.keys()], ["index.html", "css/app.css"]);
  assertEquals(files.get("index.html"), `<button class="cta">Get Started</button>\n<p>hello</p>`);
  assert(files.get("css/app.css")!.includes("--primary: #6366f1;"));
});

Deno.test("serializeBundle reproduces a parseable bundle", () => {
  const files = parseBundle(BUNDLE);
  const round = parseBundle(serializeBundle(files));
  assertEquals([...round.keys()], [...files.keys()]);
  assertEquals(round.get("index.html"), files.get("index.html"));
});

Deno.test("buildSignalList is stable and includes required fields", () => {
  const txt = buildSignalList([
    { id: 11, name: "Default Tailwind", category: "Color", detection: "indigo-500", weight: "high", auto_fixable: "yes" },
  ]);
  assertEquals(txt, "#11 | Default Tailwind | category: Color | weight: high | auto_fixable: yes\n   detection: indigo-500");
});

Deno.test("presentSignals keeps only present & applicable", () => {
  const det = {
    signals: [
      { id: 1, name: "a", present: true, applicable: true, weight: "high" },
      { id: 2, name: "b", present: false, applicable: true, weight: "low" },
      { id: 3, name: "c", present: true, applicable: false, weight: "low" },
    ],
  };
  assertEquals(presentSignals(det).map((s) => s.id), [1]);
});

Deno.test("extractCodeRegions returns only flagged files, capped", () => {
  const files = parseBundle(BUNDLE);
  const regions = extractCodeRegions(files, [
    { id: 10, name: "cta", present: true, applicable: true, weight: "high", evidence: [{ file: "index.html", snippet: "Get Started" }] },
  ]);
  assertEquals(regions.length, 1);
  assertEquals(regions[0].file, "index.html");
  assertFalse(regions.some((r) => r.file === "css/app.css"));
});

Deno.test("isVerbatimUnique detects exactly-once vs missing vs duplicate", () => {
  assert(isVerbatimUnique("abc def abc", "def"));
  assertFalse(isVerbatimUnique("abc def abc", "abc")); // twice
  assertFalse(isVerbatimUnique("abc", "xyz")); // missing
  assertFalse(isVerbatimUnique("abc", "")); // empty
});

Deno.test("validateProposals flags applicable vs strategic vs non-verbatim", () => {
  const files = parseBundle(BUNDLE);
  const out = validateProposals([
    { signal_id: 10, file: "index.html", fix_type: "copy", old_code: "Get Started", new_code: "Start free trial" },
    { signal_id: 11, file: "css/app.css", fix_type: "token", old_code: "--primary: #6366f1;", new_code: "--primary: #b91c1c;" },
    { signal_id: 99, file: "index.html", fix_type: "copy", old_code: "DOES NOT EXIST", new_code: "x" },
    { signal_id: 40, fix_type: "strategic", old_code: null, new_code: null, needs_human_decision: true },
  ], files);
  assertEquals(out[0].applicable_edit, true);
  assertEquals(out[1].applicable_edit, true);
  assertEquals(out[2].applicable_edit, false); // not present in file
  assertEquals(out[3].applicable_edit, false); // strategic
});

Deno.test("applyFix: exact unique replacement", () => {
  const r = applyFix(`a\nGet Started\nb`, "Get Started", "Start free trial");
  assert(r.applied);
  assert(r.content.includes("Start free trial"));
});

Deno.test("applyFix: fails on multiple matches", () => {
  const r = applyFix(`x x`, "x", "y");
  assertFalse(r.applied);
  assertEquals(r.reason, "multiple_matches");
});

Deno.test("applyFix: whitespace-insensitive unique match", () => {
  const r = applyFix(`<button   class="cta">Go</button>`, `<button class="cta">Go</button>`, `<button class="cta">Start</button>`);
  assert(r.applied);
  assert(r.content.includes("Start"));
});

Deno.test("filesTouchedByFixes dedupes", () => {
  assertEquals(
    filesTouchedByFixes([
      { signal_id: 1, file: "a.css", old_code: "x", new_code: "y" },
      { signal_id: 2, file: "a.css", old_code: "p", new_code: "q" },
      { signal_id: 3, file: "b.html", old_code: "m", new_code: "n" },
    ]).sort(),
    ["a.css", "b.html"],
  );
});

Deno.test("unifiedDiff shows added and removed lines", () => {
  const d = unifiedDiff("f.txt", "line1\nold\nline3", "line1\nnew\nline3");
  assert(d.includes("-old"));
  assert(d.includes("+new"));
  assert(d.includes(" line1"));
});

Deno.test("unifiedDiff empty when identical", () => {
  assertEquals(unifiedDiff("f.txt", "same", "same"), "");
});

Deno.test("buildDiffs only includes changed files", () => {
  const orig = new Map([["a", "x"], ["b", "y"]]);
  const edited = new Map([["a", "X"], ["b", "y"]]);
  const d = buildDiffs(orig, edited);
  assert(d.includes("--- a"));
  assertFalse(d.includes("--- b"));
});

Deno.test("assembleFinalFiles overlays edited over original", () => {
  const orig = new Map([["a", "1"], ["b", "2"]]);
  const edited = new Map([["a", "EDITED"]]);
  const out = assembleFinalFiles(orig, edited);
  assertEquals(out.get("a"), "EDITED");
  assertEquals(out.get("b"), "2");
});

// ---------- signal #78: Hebrew currency order ----------

import { invertsCurrencyOrder, validateProposals as vp } from "./pipeline.ts";

Deno.test("invertsCurrencyOrder catches the regression that reached a pull request", () => {
  // Shipped for real: ₪30 was correct and the fix made it 30 ₪.
  assert(invertsCurrencyOrder("<span>₪30</span>", "<span>30 ₪</span>"));
  assert(invertsCurrencyOrder("₪110", "110 ₪"));
});

Deno.test("invertsCurrencyOrder allows the correct direction", () => {
  // Turning "30 ₪" into "₪30" is the fix this signal actually wants.
  assertFalse(invertsCurrencyOrder("<span>30 ₪</span>", "<span>₪30</span>"));
});

Deno.test("invertsCurrencyOrder ignores edits that are not about currency", () => {
  assertFalse(invertsCurrencyOrder("color: red", "color: blue"));
  assertFalse(invertsCurrencyOrder("<h1>שלום</h1>", "<h1>ברוכים הבאים</h1>"));
});

Deno.test("invertsCurrencyOrder stays out of ambiguous edits", () => {
  // Both orders present on either side — not a clean inversion, so not ours
  // to reject. A deterministic guard that overreaches is worse than none.
  assertFalse(invertsCurrencyOrder("₪30 and 40 ₪", "40 ₪ and ₪30"));
});

Deno.test("validateProposals rejects a currency-inverting fix before it can apply", () => {
  const files = new Map([["index.html", '<span class="menu-price">₪30</span>']]);
  const out = vp([{
    signal_id: 78,
    file: "index.html",
    fix_type: "copy",
    old_code: '<span class="menu-price">₪30</span>',
    sample_new_code: '<span class="menu-price">30 ₪</span>',
  }], files);
  assertEquals(out[0].old_code_verbatim, true); // the anchor was fine
  assertEquals(out[0].applicable_edit, false); // but the edit is a regression
  assertEquals(out[0].rejected_reason, "inverts_currency_order");
});

Deno.test("assembleFinalFiles drops a tombstoned path", () => {
  const original = new Map([["index.html", "<p>x</p>"], ["style.css", "a{}"]]);
  const edited = new Map([["index.html", "<p>y</p>"], ["style.css", DELETED_FILE]]);
  const out = assembleFinalFiles(original, edited);
  assertEquals(out.get("index.html"), "<p>y</p>");
  assertEquals(out.has("style.css"), false);
});

Deno.test("unreferencedAssets finds the stylesheet the rebuilt page dropped", () => {
  // the real shape: a page rebuilt with inline CSS, keeping its <script src>
  const files = new Map([
    ["index.html", '<html><head><style>a{}</style></head><body><script src="script.js"></script></body></html>'],
    ["style.css", ".hero{right:0}"],
    ["script.js", "console.log(1)"],
  ]);
  assertEquals(unreferencedAssets(files), ["style.css"]);
});

Deno.test("unreferencedAssets keeps a stylesheet another page still links", () => {
  const files = new Map([
    ["index.html", "<html><head><style>a{}</style></head><body></body></html>"],
    ["about.html", '<html><head><link rel="stylesheet" href="style.css"></head></html>'],
    ["style.css", ".hero{right:0}"],
  ]);
  assertEquals(unreferencedAssets(files), []);
});

Deno.test("unreferencedAssets never touches images or pages", () => {
  const files = new Map([
    ["index.html", "<html><head><style>a{}</style></head><body></body></html>"],
    ["old-page.html", "<html><body>still a page</body></html>"],
    ["logo.png", "binary"],
    ["fonts/x.woff2", "binary"],
  ]);
  assertEquals(unreferencedAssets(files), []);
});

Deno.test("unreferencedAssets does nothing when there is no page to judge by", () => {
  assertEquals(unreferencedAssets(new Map([["style.css", "a{}"]])), []);
});

Deno.test("a pruned project survives a bundle round-trip", () => {
  const original = new Map([["index.html", "<p>x</p>"], ["style.css", "a{}"]]);
  const edited = new Map([["index.html", "<p>y</p>"], ["style.css", DELETED_FILE]]);
  const round = parseBundle(serializeBundle(edited));
  const out = assembleFinalFiles(original, round);
  assertEquals([...out.keys()], ["index.html"]);
});

// ---------- pickHomePage ----------

Deno.test("pickHomePage: the real four-page site that used to pick contact.html", () => {
  assertEquals(
    pickHomePage([
      "contact.html",
      "gallery.html",
      "products.html",
      "index.html",
      "style.css",
    ]),
    "index.html",
  );
});

Deno.test("pickHomePage: a single page is that page", () => {
  assertEquals(pickHomePage(["about.html"]), "about.html");
});

Deno.test("pickHomePage: no html at all is null, not a guess", () => {
  assertEquals(pickHomePage(["style.css", "script.js", "README.md"]), null);
});

Deno.test("pickHomePage: nothing named like a home page falls back alphabetically", () => {
  assertEquals(
    pickHomePage(["gallery.html", "contact.html", "products.html"]),
    "contact.html",
  );
});

Deno.test("pickHomePage: a named entry point beats a shallower ordinary page", () => {
  assertEquals(pickHomePage(["about.html", "public/index.html"]), "public/index.html");
});

Deno.test("pickHomePage: the shallowest index wins", () => {
  assertEquals(
    pickHomePage(["docs/index.html", "index.html", "a/b/index.html"]),
    "index.html",
  );
});

Deno.test("pickHomePage: index beats home beats default beats main", () => {
  assertEquals(pickHomePage(["main.html", "default.html", "home.html"]), "home.html");
  assertEquals(pickHomePage(["main.html", "default.html"]), "default.html");
  assertEquals(pickHomePage(["home.html", "index.html"]), "index.html");
});

Deno.test("pickHomePage: .htm counts, and case does not", () => {
  assertEquals(pickHomePage(["contact.html", "Index.HTM"]), "Index.HTM");
});

Deno.test("pickHomePage: order of input does not change the answer", () => {
  const files = ["products.html", "index.html", "contact.html", "gallery.html"];
  const first = pickHomePage(files);
  assertEquals(first, "index.html");
  assertEquals(pickHomePage([...files].reverse()), first);
});

Deno.test("pickHomePage: a page merely containing 'index' is not an index", () => {
  assertEquals(pickHomePage(["contact.html", "index-of-terms.html"]), "contact.html");
});

