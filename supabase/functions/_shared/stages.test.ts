import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { buildClaudeRequestBody, type ClaudeCallOptions, type ClaudeResult } from "./anthropic.ts";
import { parseBundle, type Signal } from "./pipeline.ts";
import {
  MODEL,
  runStage2,
  runStage4,
  runStage5,
  STAGE2_SYSTEM,
  STAGE4_SYSTEM,
  STAGE5_SYSTEM,
} from "./stages.ts";

// A mock Claude that records the request and returns a canned response.
function mockCall(response: unknown) {
  const calls: ClaudeCallOptions[] = [];
  const impl = (opts: ClaudeCallOptions): Promise<ClaudeResult> => {
    calls.push(opts);
    return Promise.resolve({ json: response, usage: { cache_read_input_tokens: 10 }, raw: {} });
  };
  return { impl, calls };
}

const SIGNALS: Signal[] = [
  { id: 9, name: "Purple gradient hero", category: "Color", detection: "linear-gradient purple", weight: "high", auto_fixable: "yes" },
  { id: 40, name: "Missing sitemap", category: "SEO", detection: "no sitemap.xml", weight: "low", auto_fixable: "no" },
];

const BUNDLE = `=== FILE: index.html ===
<section class="hero">Transform Your Pottery Experience</section>

=== FILE: css/app.css ===
.hero { background: linear-gradient(135deg,#a855f7,#6366f1); }

=== FILE: js/untouched.js ===
console.log("this file is not flagged and must not be sent");

`;

const DETECTION = {
  signals: [
    { id: 9, name: "Purple gradient hero", present: true, applicable: true, weight: "high", explanation: "purple gradient", evidence: [{ file: "css/app.css", snippet: "linear-gradient(135deg,#a855f7,#6366f1)" }] },
    { id: 40, name: "Missing sitemap", present: true, applicable: true, weight: "low", explanation: "no sitemap", evidence: [] },
    { id: 5, name: "Not present", present: false, applicable: true, weight: "low", evidence: [] },
  ],
};

// ---------- STAGE 2 ----------

Deno.test("runStage2: correct model + effort, no temperature, cached system prompt", async () => {
  const { impl, calls } = mockCall({ design_direction: { palette: [] }, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: { language_direction: "rtl" }, detection: DETECTION,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].model, MODEL);
  // temperature is a 400 on opus-4-8; effort replaces it.
  assertEquals(calls[0].effort, "high");
  // Thinking is deliberately OFF here: stage 2 is output-bound against the
  // 150s edge-function limit, and adaptive thinking spends that budget before
  // a single proposal is emitted.
  assertEquals(calls[0].thinking, undefined);
  assertEquals(calls[0].system, STAGE2_SYSTEM);

  // cache_control must sit on the system array, not the user message
  const body = buildClaudeRequestBody(calls[0]) as Record<string, unknown>;
  const system = body.system as Array<{ cache_control?: unknown }>;
  assertEquals((system[0].cache_control as { type: string }).type, "ephemeral");
});

Deno.test("runStage2: sends only present signals + flagged code, never the whole project", async () => {
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: {}, detection: DETECTION,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
  });
  const uc = calls[0].userContent;
  assert(uc.includes("#9 | Purple gradient hero"));
  assertFalse(uc.includes("Not present")); // absent signal excluded
  assert(uc.includes("css/app.css")); // flagged file included
  assertFalse(uc.includes("this file is not flagged")); // unflagged file excluded
  assert(uc.includes("<site_profile>") && uc.includes("<code_regions>"));
});

Deno.test("runStage2: validates proposals' old_code verbatim against the file", async () => {
  const { impl } = mockCall({
    design_direction: {},
    proposals: [
      { signal_id: 9, file: "css/app.css", fix_type: "token", old_code: "linear-gradient(135deg,#a855f7,#6366f1)", sample_new_code: "#b91c1c", needs_human_decision: false },
      { signal_id: 9, file: "css/app.css", fix_type: "token", old_code: "THIS IS NOT IN THE FILE", sample_new_code: "x", needs_human_decision: false },
      { signal_id: 40, file: null, fix_type: "strategic", old_code: null, sample_new_code: null, needs_human_decision: true },
    ],
  });
  const out = await runStage2({
    apiKey: "k", siteProfile: {}, detection: DETECTION,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
  });
  assertEquals(out.proposals[0].applicable_edit, true);
  assertEquals(out.proposals[1].applicable_edit, false); // not verbatim
  assertEquals(out.proposals[2].applicable_edit, false); // strategic
});

// ---------- STAGE 4 ----------

Deno.test("runStage4: effort high, only touched files + approved fixes + tokens", async () => {
  const { impl, calls } = mockCall({ files: [], change_log: [] });
  const files = parseBundle(BUNDLE);
  const touched = new Map([["css/app.css", files.get("css/app.css")!]]);
  await runStage4({
    apiKey: "k", files: touched, designDirection: { primary: "#b91c1c" },
    approvedFixes: [{ signal_id: 9, file: "css/app.css", old_code: "linear-gradient(135deg,#a855f7,#6366f1)", new_code: "#b91c1c" }],
    callImpl: impl,
  });
  assertEquals(calls[0].effort, "high");
  assertEquals(calls[0].system, STAGE4_SYSTEM);
  const uc = calls[0].userContent;
  assert(uc.includes("<approved_fixes>") && uc.includes("<design_direction>"));
  assert(uc.includes("css/app.css"));
  assertFalse(uc.includes("this file is not flagged")); // untouched file not sent
});

// ---------- STAGE 5 ----------

Deno.test("runStage5: effort high, sends diffs + signals, NO prior rationale", async () => {
  const { impl, calls } = mockCall({ pass: true, functional_issues: [], unapproved_changes: [], regressions: [], signal_resolution: [], human_quality_score: 92, recommend_reapply: [] });
  const original = parseBundle(BUNDLE);
  const edited = new Map(original);
  edited.set("css/app.css", ".hero { background: #b91c1c; }");
  await runStage5({
    apiKey: "k", original, edited, targetedSignals: [SIGNALS[0]],
    designDirection: { primary: "#b91c1c" }, callImpl: impl,
  });
  assertEquals(calls[0].effort, "high");
  assertEquals(calls[0].system, STAGE5_SYSTEM);
  const uc = calls[0].userContent;
  assert(uc.includes("<diffs>"));
  assert(uc.includes("-.hero { background: linear-gradient")); // removed line in diff
  assert(uc.includes("+.hero { background: #b91c1c; }")); // added line in diff
  assert(uc.includes("#9 | Purple gradient hero"));
  // clean context: the detected-signal explanation text must NOT leak in
  assertFalse(uc.includes("purple gradient")); // stage-1 explanation not forwarded
});

Deno.test("stage 2 streams even though it sits exactly on the token threshold", () => {
  // Regression guard. 16000 max_tokens is ON the threshold, not above it, so
  // without an explicit stream:true this stage would take the non-streaming
  // path and risk an idle timeout inside the ~150s edge-function budget.
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  return runStage2({
    apiKey: "k", siteProfile: {}, detection: DETECTION,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
  }).then(() => {
    const body = buildClaudeRequestBody(calls[0]) as Record<string, unknown>;
    assertEquals(body.stream, true);
    assertEquals(body.thinking, undefined);
  });
});

// ---------- stage 2 multi-pass ----------

const MANY = {
  signals: Array.from({ length: 9 }, (_, i) => ({
    id: i + 1, name: `S${i + 1}`, present: true, applicable: true, weight: "low",
    evidence: [{ file: "css/app.css", snippet: "x" }],
  })),
};

Deno.test("runStage2 sends only its own slice of the present signals", async () => {
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: {}, detection: MANY,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
    part: 2, parts: 3,
  });
  const uc = calls[0].userContent;
  // 9 present signals over 3 passes -> pass 2 owns #4..#6 only.
  assert(uc.includes("#4 | S4") && uc.includes("#6 | S6"));
  assertFalse(uc.includes("#1 | S1"));
  assertFalse(uc.includes("#7 | S7"));
});

Deno.test("runStage2 pass 1 covers the first slice and gets no prior direction", async () => {
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: {}, detection: MANY,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
    part: 1, parts: 3,
  });
  const uc = calls[0].userContent;
  assert(uc.includes("#1 | S1"));
  assertFalse(uc.includes("<approved_design_direction>"));
});

Deno.test("runStage2 hands later passes the approved direction so proposals stay coherent", async () => {
  // Without this, each batch would invent its own palette and typography and
  // the "one coherent design direction" guarantee would quietly break.
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: {}, detection: MANY,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
    part: 3, parts: 3,
    priorDirection: { brand_palette: [{ token: "--color-primary", hex: "#b91c1c" }] },
  });
  const uc = calls[0].userContent;
  assert(uc.includes("<approved_design_direction>"));
  assert(uc.includes("#b91c1c"));
  assert(uc.includes("do NOT invent a new"));
});

Deno.test("runStage2 unsplit (parts=1) still sees every present signal", async () => {
  const { impl, calls } = mockCall({ design_direction: {}, proposals: [] });
  await runStage2({
    apiKey: "k", siteProfile: {}, detection: MANY,
    files: parseBundle(BUNDLE), signals: SIGNALS, callImpl: impl,
  });
  const uc = calls[0].userContent;
  assert(uc.includes("#1 | S1") && uc.includes("#9 | S9"));
});
