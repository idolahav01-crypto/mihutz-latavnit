import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  applyFix,
  assembleFinalFiles,
  buildDiffs,
  buildSignalList,
  extractCodeRegions,
  filesTouchedByFixes,
  isVerbatimUnique,
  parseBundle,
  presentSignals,
  serializeBundle,
  unifiedDiff,
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
