// End-to-end contract test for the full fix pipeline (Stage 2 -> 4 -> 5), with a
// realistic mock Claude at each hop. It proves the data contract the spec cares
// about most: a Stage-2 proposal whose old_code is verbatim can actually be
// applied by Stage 4, and Stage 5 then sees a correct diff for the targeted
// signal. No live API key needed — the mocks stand in for the model, but every
// join between stages is exercised for real.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ClaudeCallOptions, type ClaudeResult } from "./anthropic.ts";
import {
  applyFix,
  assembleFinalFiles,
  deriveApprovedFixes,
  filesTouchedByFixes,
  parseBundle,
  type Signal,
} from "./pipeline.ts";
import { runStage2, runStage4, runStage5 } from "./stages.ts";

const SIGNALS: Signal[] = [
  { id: 9, name: "Purple gradient hero", category: "Color", detection: "purple gradient", weight: "high", auto_fixable: "yes" },
  { id: 10, name: "Generic CTA", category: "Copy", detection: "Get Started", weight: "medium", auto_fixable: "yes" },
];

const BUNDLE = `=== FILE: index.html ===
<a class="cta" href="/signup" onclick="track()">Get Started</a>

=== FILE: css/app.css ===
.hero { background: linear-gradient(135deg, #a855f7, #6366f1); }

`;

const DETECTION = {
  signals: [
    { id: 9, name: "Purple gradient hero", present: true, applicable: true, weight: "high", explanation: "purple gradient hero", evidence: [{ file: "css/app.css", snippet: "linear-gradient(135deg, #a855f7, #6366f1)" }] },
    { id: 10, name: "Generic CTA", present: true, applicable: true, weight: "medium", explanation: "generic CTA copy", evidence: [{ file: "index.html", snippet: "Get Started" }] },
  ],
};

const SITE_PROFILE = { purpose: "pottery studio", language_direction: "ltr", palette: [] };

Deno.test("pipeline: stage2 -> stage4 -> stage5 contract holds end to end", async () => {
  const files = parseBundle(BUNDLE);

  // --- Stage 2: a well-behaved designer returns verbatim old_code proposals ---
  const stage2Mock = (_o: ClaudeCallOptions): Promise<ClaudeResult> =>
    Promise.resolve({
      json: {
        design_direction: {
          brand_palette: [{ token: "--color-primary", hex: "#b45309", role: "brand" }],
          typography: { heading: "Fraunces", body: "Inter", weights: "700/400", scale: "1.25" },
          layout_principle: "editorial whitespace for a craft studio",
          personality: ["earthy", "crafted", "warm"],
          rationale: "pottery studio audience; warm terracotta over generic indigo",
        },
        proposals: [
          { signal_id: 9, file: "css/app.css", fix_type: "token", risk: "low", old_code: "linear-gradient(135deg, #a855f7, #6366f1)", sample_new_code: "#b45309", rationale: "replace purple gradient with a single terracotta brand color", depends_on: [], needs_human_decision: false },
          { signal_id: 10, file: "index.html", fix_type: "copy", risk: "low", old_code: "Get Started", sample_new_code: "Book a studio session", rationale: "name the action for the pottery audience", depends_on: [], needs_human_decision: false },
        ],
      },
      usage: {},
      raw: {},
    });

  const s2 = await runStage2({
    apiKey: "k", siteProfile: SITE_PROFILE, detection: DETECTION,
    files, signals: SIGNALS, callImpl: stage2Mock,
  });
  // both proposals quote real file text, so both are applicable
  assertEquals(s2.proposals.filter((p) => p.applicable_edit).length, 2);

  // --- derive approved fixes (what the UI/orchestrator sends to Stage 4) ---
  const fixes = deriveApprovedFixes(s2.proposals);
  assertEquals(fixes.length, 2);
  assertEquals(filesTouchedByFixes(fixes).sort(), ["css/app.css", "index.html"]);

  // --- Stage 4: a faithful PrecisionEditor applies exactly the approved fixes ---
  const touched = new Map<string, string>();
  for (const p of filesTouchedByFixes(fixes)) touched.set(p, files.get(p)!);

  const stage4Mock = (_o: ClaudeCallOptions): Promise<ClaudeResult> => {
    const outFiles = [...touched.entries()].map(([path, content]) => {
      let next = content;
      let edited = false;
      for (const f of fixes.filter((f) => f.file === path)) {
        const r = applyFix(next, f.old_code, f.new_code);
        if (r.applied) { next = r.content; edited = true; }
      }
      return { path, content: next, edited };
    });
    const change_log = fixes.map((f) => ({
      signal_id: f.signal_id, file: f.file, applied: true, fail_reason: null,
      self_check: { functional_parity: true, syntax_valid: true, change_applied: true, token_consistency: true, rtl_integrity: true, human_quality: true },
    }));
    return Promise.resolve({ json: { files: outFiles, change_log }, usage: {}, raw: {} });
  };

  const s4 = await runStage4({
    apiKey: "k", files: touched, approvedFixes: fixes,
    designDirection: s2.design_direction, callImpl: stage4Mock,
  });

  const editedTouched = new Map<string, string>();
  for (const f of s4.files) editedTouched.set(f.path, f.content);

  // the fixes are actually present, functionality (onclick/href/class) preserved
  assert(editedTouched.get("css/app.css")!.includes("#b45309"));
  assert(!editedTouched.get("css/app.css")!.includes("linear-gradient"));
  assert(editedTouched.get("index.html")!.includes("Book a studio session"));
  assert(editedTouched.get("index.html")!.includes('onclick="track()"'));
  assert(editedTouched.get("index.html")!.includes('class="cta"'));

  // --- Stage 5: QA receives the real diff; verify what it is handed ---
  const edited = assembleFinalFiles(files, editedTouched);
  let captured: ClaudeCallOptions | null = null;
  const stage5Mock = (o: ClaudeCallOptions): Promise<ClaudeResult> => {
    captured = o;
    return Promise.resolve({
      json: { pass: true, functional_issues: [], unapproved_changes: [], regressions: [], signal_resolution: [{ signal_id: 9, resolved: true, note: "gradient gone" }, { signal_id: 10, resolved: true, note: "CTA named" }], human_quality_score: 91, recommend_reapply: [] },
      usage: {}, raw: {},
    });
  };
  const s5 = await runStage5({
    apiKey: "k", original: files, edited,
    targetedSignals: SIGNALS, designDirection: s2.design_direction, callImpl: stage5Mock,
  });

  assertEquals((s5.verdict as { pass: boolean }).pass, true);
  const uc = captured!.userContent;
  assert(uc.includes("+.hero { background: #b45309; }"));
  assert(uc.includes("-.hero { background: linear-gradient(135deg, #a855f7, #6366f1); }"));
  assert(uc.includes("Book a studio session"));
});

Deno.test("pipeline: a non-verbatim proposal is dropped before Stage 4", async () => {
  const files = parseBundle(BUNDLE);
  const stage2Mock = (_o: ClaudeCallOptions): Promise<ClaudeResult> =>
    Promise.resolve({
      json: {
        design_direction: {},
        proposals: [
          // old_code does NOT appear verbatim in the file -> must be filtered out
          { signal_id: 9, file: "css/app.css", fix_type: "token", risk: "low", old_code: "background: purple;", sample_new_code: "#b45309", rationale: "x", depends_on: [], needs_human_decision: false },
        ],
      },
      usage: {}, raw: {},
    });
  const s2 = await runStage2({ apiKey: "k", siteProfile: SITE_PROFILE, detection: DETECTION, files, signals: SIGNALS, callImpl: stage2Mock });
  assertEquals(s2.proposals[0].applicable_edit, false);
  assertEquals(deriveApprovedFixes(s2.proposals).length, 0);
});
