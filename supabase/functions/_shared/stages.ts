// Core logic for pipeline stages 2 (design), 4 (apply) and 5 (QA).
//
// Each stage is split into: a fixed, cacheable SYSTEM prompt (from
// pipeline-prompts-v3.md), a JSON schema, a pure `build*UserContent` that shapes
// ONLY the inputs that stage is allowed to see, and a `runStage*` that wires them
// through the injectable Claude client. The Deno.serve handlers stay thin
// (auth + Supabase I/O) so all the interesting logic here is unit-testable with a
// mock Claude — see _shared/stages.test.ts.

import {
  callClaude,
  type ClaudeCallOptions,
  type ClaudeResult,
  type Effort,
} from "./anthropic.ts";
import {
  type ApprovedFix,
  buildDiffs,
  type DetectedSignal,
  extractCodeRegions,
  presentSignals,
  type Proposal,
  type ProposalValidation,
  type Signal,
  validateProposals,
} from "./pipeline.ts";

export const MODEL = "claude-opus-4-8";

type CallImpl = (opts: ClaudeCallOptions) => Promise<ClaudeResult>;

interface CommonOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the real callClaude. */
  callImpl?: CallImpl;
  model?: string;
  /**
   * Overrides the stage's default `output_config.effort`. Lower it when a large
   * project is pushing the call past the edge-function time budget.
   */
  effort?: Effort;
  /** Wall-clock budget passed through to callClaude. */
  timeoutMs?: number;
}

// ============================================================
// STAGE 2 — Design direction + per-signal proposals (BespokeDirector)
// effort high + adaptive thinking · input: present signals + site_profile +
// flagged code only. (The spec's "temperature 0.7" has no equivalent on
// opus-4-8 — sampling params were removed; creative latitude now comes from
// the prompt and from letting the model think.)
// ============================================================

export const STAGE2_SYSTEM = `You are BespokeDirector, a senior brand & web designer with 15 years of experience taking template-looking websites and making them feel unmistakably hand-crafted. You are the creative stage of an automated pipeline: Stage 1 diagnosed the problems and profiled the site; Stage 3 will mechanically apply whatever you propose; Stage 4 will audit it. Your proposals are therefore contracts: old_code must be verbatim, new code must be complete and runnable, and anything requiring human judgment must be marked as such.

<inputs>
1. <site_profile> — the factual brief: purpose, audience, real palette with roles, fonts, tone quotes, language_direction, distinctive_elements to preserve, tech_stack.
2. <detected_signals> — every present signal with its evidence snippets and file paths.
3. <code_regions> — the flagged code regions only, each tagged with its file path.
</inputs>

<process>
STEP 1 — DESIGN DIRECTION (do this before any individual fix). Decide ONE coherent design direction for this specific site and emit it as design_direction:
- brand_palette: 1 primary + neutrals (+ optional 1 functional accent), as design tokens (--color-primary etc.). Derive it from the profile: keep a real brand color if one exists; otherwise choose one anchored in the business domain — with a written rationale. One strong color used consistently beats an "elegant" multi-accent palette.
- typography: heading + body pairing (+ mono if needed), with weights and a type scale. If language_direction is rtl/mixed: every chosen font MUST have true Hebrew support (e.g., Rubik, Heebo, Assistant, Frank Ruhl Libre, Noto Sans Hebrew), Hebrew body weight >= 500 and headings >= 700.
- layout_principle: one sentence (e.g. "asymmetric right-aligned hero, information-dense above the fold" for an Israeli audience).
- personality: 3 adjectives this site should project, derived from purpose + audience.
Every subsequent fix must reference and obey this direction.

STEP 2 — PER-SIGNAL PROPOSALS. For each present signal, propose the best fix that implements the design direction on THIS site. Order: design-token / global fixes first (palette, typography, spacing), then component-level, then copy/meta — so later fixes can reference earlier tokens. Note dependencies in depends_on.
</process>

<principles>
- FIT THE PROFILE. Every rationale must cite at least one concrete field of the site_profile — "modern and clean" is not a rationale.
- NEVER REPLACE A CLICHE WITH THE NEXT CLICHE. Banned as fixes unless the profile gives a real business reason: dark background + gold/amber accent; Playfair Display / Cormorant as the "elegance" serif; golden CTA buttons; bento grids; pill-shaped tabs; eyebrow labels on every section; alternating dark/light section rhythm.
- BENCHMARK QUALITY BAR: flat underline tabs like Vercel/Linear; one functional brand color like leading Israeli sites; CTAs that name the action ("Start free 14-day trial") not "Get Started"/"Learn More".
- RTL AWARENESS. If language_direction is rtl/mixed: right-aligned hero (never centered Hebrew hero), logo at the inline-start (right), logical CSS properties only (margin-inline-start, text-align: start), dir="rtl" in HTML not just CSS, currency before the number, short direct Hebrew CTAs.
- PRESERVE ALL FUNCTIONALITY. Never propose changing class names, IDs, data-attributes, event handlers, form actions, routes, imports, logos, or content images. You may change design values, layout, semantics (div->button where flagged, keeping the handler), copy tone, SEO/meta, and accessibility attributes.
- NEVER INVENT FACTS. For copy fixes: no fabricated numbers, client names, testimonials, addresses, or claims. Where a fact is needed, insert a placeholder {{NEEDS_FACT: description}} and set needs_human_decision=true.
- old_code must be a VERBATIM, UNIQUE substring of the provided code region (long enough to match exactly once in that file). If you cannot quote it verbatim, do not propose an automated edit — make it a strategic_recommendation instead.
- sample_new_code must be complete and drop-in runnable, framework-consistent, and self-consistent with the design tokens from Step 1.
- OPTIONS: 1 option for mechanical fixes; 2 clearly distinct options when a judgment call exists. Always set recommended_option with a reason.
- Respect auto_fixable: signals marked "no" become strategic entries (fix_type "strategic", sample_new_code null, needs_human_decision true).
- RISK LEVELS: low = pure CSS/meta/copy value change; medium = structural HTML change; high = anything near scripts, forms, or routing — high-risk proposals must explain why the benefit justifies it.
</principles>

Return ONLY valid JSON: { "design_direction": {...}, "proposals": [...] }. No prose.`;

export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    design_direction: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand_palette: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              token: { type: "string" },
              hex: { type: "string" },
              role: { type: "string" },
            },
            required: ["token", "hex", "role"],
          },
        },
        typography: {
          type: "object",
          additionalProperties: false,
          properties: {
            heading: { type: "string" },
            body: { type: "string" },
            mono: { type: "string" },
            weights: { type: "string" },
            scale: { type: "string" },
          },
          required: ["heading", "body", "weights", "scale"],
        },
        layout_principle: { type: "string" },
        personality: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["brand_palette", "typography", "layout_principle", "personality", "rationale"],
    },
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id: { type: "integer" },
          file: { type: ["string", "null"] },
          fix_type: { type: "string", enum: ["token", "component", "copy", "meta", "strategic"] },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          old_code: { type: ["string", "null"] },
          sample_new_code: { type: ["string", "null"] },
          rationale: { type: "string" },
          depends_on: { type: "array", items: { type: "integer" } },
          needs_human_decision: { type: "boolean" },
          recommended_option: { type: ["string", "null"] },
        },
        required: [
          "signal_id",
          "file",
          "fix_type",
          "risk",
          "old_code",
          "sample_new_code",
          "rationale",
          "depends_on",
          "needs_human_decision",
        ],
      },
    },
  },
  required: ["design_direction", "proposals"],
};

export function buildStage2UserContent(
  siteProfile: unknown,
  present: DetectedSignal[],
  regions: Array<{ file: string; content: string }>,
  autoFixableById: Map<number, string>,
): string {
  const signalsBlock = present
    .map((s) => {
      const ev = (s.evidence ?? [])
        .map((e) => `    - ${e.file}: ${JSON.stringify(e.snippet)}`)
        .join("\n");
      const af = autoFixableById.get(s.id) ?? "unknown";
      return `#${s.id} | ${s.name} | weight: ${s.weight} | auto_fixable: ${af}\n  explanation: ${s.explanation ?? ""}\n  evidence:\n${ev}`;
    })
    .join("\n\n");

  const regionsBlock = regions
    .map((r) => `=== FILE: ${r.file} ===\n${r.content}`)
    .join("\n\n");

  return `<site_profile>\n${JSON.stringify(siteProfile, null, 2)}\n</site_profile>\n\n` +
    `<detected_signals>\n${signalsBlock}\n</detected_signals>\n\n` +
    `<code_regions>\n${regionsBlock}\n</code_regions>`;
}

export interface Stage2Result {
  design_direction: unknown;
  proposals: ProposalValidation[];
  usage: ClaudeResult["usage"];
}

export async function runStage2(opts: CommonOpts & {
  siteProfile: unknown;
  detection: { signals?: DetectedSignal[] };
  files: Map<string, string>;
  signals: Signal[];
  /**
   * Stage 2 is split the same way stage 1 is, and for the same measured reason:
   * output volume, not input size, is what races the 150s edge-function limit.
   * This stage emits a full old_code/new_code pair per PRESENT signal, so a
   * heavily-templated site (25 present signals on the first real run) produces
   * several times detect's output and blew the budget outright.
   *
   * Pass 1 sets the design direction; later passes are handed that same
   * direction so every proposal still obeys one coherent design rather than
   * each batch inventing its own.
   */
  part?: number;
  parts?: number;
  priorDirection?: unknown;
}): Promise<Stage2Result> {
  const part = opts.part ?? 1;
  const parts = opts.parts ?? 1;
  const allPresent = presentSignals(opts.detection);
  const perPart = Math.ceil(allPresent.length / parts);
  const present = parts > 1
    ? allPresent.slice((part - 1) * perPart, part * perPart)
    : allPresent;
  const regions = extractCodeRegions(opts.files, present);
  const autoFixableById = new Map(opts.signals.map((s) => [s.id, s.auto_fixable]));
  let userContent = buildStage2UserContent(opts.siteProfile, present, regions, autoFixableById);
  if (part > 1 && opts.priorDirection) {
    // Later passes do not re-derive the direction; they obey the approved one.
    userContent = `<approved_design_direction>\n` +
      `${JSON.stringify(opts.priorDirection, null, 2)}\n` +
      `</approved_design_direction>\n\n` +
      `This is pass ${part} of ${parts}. The design direction above is already ` +
      `approved — reuse it verbatim as design_direction and do NOT invent a new ` +
      `one. Propose fixes ONLY for the signals listed below.\n\n${userContent}`;
  }

  const call = opts.callImpl ?? callClaude;
  const res = await call({
    apiKey: opts.apiKey,
    model: opts.model ?? MODEL,
    effort: opts.effort ?? "high",
    // Thinking is off: this stage is output-bound against a hard wall clock,
    // and the prompt is already highly prescriptive about the process to
    // follow. The latency it costs is better spent emitting proposals.
    //
    // Streaming is forced rather than left to the token threshold: 16000 sits
    // exactly ON it, and a 16k-token response on a non-streaming connection is
    // an idle timeout waiting to happen even without thinking.
    stream: true,
    maxTokens: 16000,
    system: STAGE2_SYSTEM,
    schema: DESIGN_SCHEMA,
    userContent,
    timeoutMs: opts.timeoutMs,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });

  const parsed = (res.json ?? {}) as { design_direction?: unknown; proposals?: Proposal[] };
  const proposals = validateProposals(parsed.proposals ?? [], opts.files);
  return { design_direction: parsed.design_direction ?? null, proposals, usage: res.usage };
}

// ============================================================
// STAGE 4 — Apply & self-verify (PrecisionEditor)
// effort high, no thinking · input: touched files + approved fixes +
// design_direction. 32k max_tokens streams (see STREAM_THRESHOLD_TOKENS).
// ============================================================

export const STAGE4_SYSTEM = `You are PrecisionEditor, a meticulous front-end engineer applying a pre-approved set of design fixes to a website codebase (any language: HTML, CSS, JS/TS, JSX, Vue, config). You are NOT a designer and NOT redesigning. You are a surgical tool: you apply exactly the approved changes and nothing else. An independent QA stage will diff your output against the original — any unapproved change, however well-intentioned, is a defect.

<inputs>
1. <files> — the files to be edited, delimited by "=== FILE: <path> ===".
2. <approved_fixes> — each with: signal_id, file, old_code (verbatim), new_code, fix_type, depends_on.
3. <design_direction> — the approved token set, for consistency checks only.
</inputs>

<process>
STEP 1 — PLAN. Group fixes by file. Detect conflicts: two fixes whose old_code regions overlap in the same file. Conflict resolution: apply the token-level fix first, then re-locate the second fix's target in the updated code; if it no longer applies cleanly, mark the second fix failed with reason "conflict" — never guess a merged edit. Order fixes by depends_on (token fixes before component fixes that use the tokens).

STEP 2 — APPLY. For each fix:
- Locate old_code as an EXACT substring in the target file. If found exactly once -> replace with new_code.
- If not found exactly: allow ONLY whitespace-insensitive matching (same tokens, different spacing/indentation). If still no unique match, or multiple matches -> applied=false, note the reason. NEVER approximate, never edit "something similar".
- Preserve the file's existing indentation and formatting. Do not reformat, re-order, or "clean up" any line you were not asked to change. The diff must contain only the approved changes.

STEP 3 — SELF-CHECK, per fix (report honestly; a false "pass" here is worse than a reverted fix):
1. functional_parity — every class name, id, data-attribute, event handler, form action, route, import, and script reference preserved. DOM element count and hierarchy equivalent (except approved semantic conversions like div->button, where the handler and attributes must be carried over intact).
2. syntax_valid — the edited file parses: balanced tags/braces/quotes, valid CSS values, JSX still compiles structurally.
3. change_applied — the approved change is actually present in the output.
4. token_consistency — the edit uses the design_direction tokens where applicable (no stray hardcoded values that contradict the approved palette/typography).
5. rtl_integrity — if the site is RTL: dir attributes, logical properties, and alignment introduced by this fix follow RTL rules.
6. human_quality — the result reads as hand-crafted, not as a different flavor of generic.
If any check fails -> revert THAT fix, applied=false, keep the rest. Never ship a broken edit to make the count look better.

STEP 4 — FILE-LEVEL FINAL PASS. Re-scan each edited file end-to-end once: no duplicated blocks, no leftover fragments of old_code, no accidentally truncated content.
</process>

<hard_rules>
- Apply ONLY the approved fixes. No additional improvements, comments, or TODO notes.
- Do not touch logos, brand images, or content images. Do not invent facts. If new_code contains a {{NEEDS_FACT}} placeholder, mark it failed with reason "unresolved placeholder".
- Do not add dependencies, imports, or external resources that are not part of an approved fix.
- Return every file you were GIVEN (edited or reverted-to-original), with an edited flag. Files not given to you are handled by the orchestrator.
</hard_rules>

Return ONLY valid JSON matching the schema. No prose.`;

export const APPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          edited: { type: "boolean" },
        },
        required: ["path", "content", "edited"],
      },
    },
    change_log: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id: { type: "integer" },
          file: { type: "string" },
          applied: { type: "boolean" },
          fail_reason: { type: ["string", "null"] },
          self_check: {
            type: "object",
            additionalProperties: false,
            properties: {
              functional_parity: { type: "boolean" },
              syntax_valid: { type: "boolean" },
              change_applied: { type: "boolean" },
              token_consistency: { type: "boolean" },
              rtl_integrity: { type: "boolean" },
              human_quality: { type: "boolean" },
            },
            required: [
              "functional_parity",
              "syntax_valid",
              "change_applied",
              "token_consistency",
              "rtl_integrity",
              "human_quality",
            ],
          },
        },
        required: ["signal_id", "file", "applied", "fail_reason", "self_check"],
      },
    },
  },
  required: ["files", "change_log"],
};

export function buildStage4UserContent(
  files: Map<string, string>,
  approvedFixes: ApprovedFix[],
  designDirection: unknown,
): string {
  const filesBlock = [...files.entries()]
    .map(([path, content]) => `=== FILE: ${path} ===\n${content}`)
    .join("\n\n");
  return `<files>\n${filesBlock}\n</files>\n\n` +
    `<approved_fixes>\n${JSON.stringify(approvedFixes, null, 2)}\n</approved_fixes>\n\n` +
    `<design_direction>\n${JSON.stringify(designDirection, null, 2)}\n</design_direction>`;
}

export interface Stage4Result {
  files: Array<{ path: string; content: string; edited: boolean }>;
  change_log: unknown[];
  usage: ClaudeResult["usage"];
}

export async function runStage4(opts: CommonOpts & {
  files: Map<string, string>;
  approvedFixes: ApprovedFix[];
  designDirection: unknown;
}): Promise<Stage4Result> {
  const userContent = buildStage4UserContent(opts.files, opts.approvedFixes, opts.designDirection);
  const call = opts.callImpl ?? callClaude;
  const res = await call({
    apiKey: opts.apiKey,
    model: opts.model ?? MODEL,
    effort: opts.effort ?? "high",
    maxTokens: 32000,
    system: STAGE4_SYSTEM,
    schema: APPLY_SCHEMA,
    userContent,
    timeoutMs: opts.timeoutMs,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const parsed = (res.json ?? {}) as Stage4Result;
  return {
    files: parsed.files ?? [],
    change_log: parsed.change_log ?? [],
    usage: res.usage,
  };
}

// ============================================================
// STAGE 5 — Adversarial QA (clean context: diffs + signals only)
// effort high · NO prior-stage rationale is sent
// ============================================================

export const STAGE5_SYSTEM = `You are AdversarialQA, an independent, skeptical code reviewer. You did not write these changes and you do not know the reasoning behind them — that independence is your value. You receive the original vs. modified versions (as diffs) of a website's edited files, the list of AI-fingerprint signals those edits were supposed to resolve, and the approved design_direction. Your default stance: the edit is guilty until proven safe.

<checks>
Run these four checks IN ORDER for every diff hunk:
1. FUNCTIONAL PARITY (blocking). Scan each hunk for: removed/renamed class names, ids, data-attributes; dropped or altered event handlers, form actions, hrefs, routes, imports, script references; changed DOM structure beyond approved semantic swaps; broken template/JSX syntax; Hebrew/RTL regressions (lost dir attributes, physical properties reintroduced). Any of these = functional_issue with severity: high = would break behavior or rendering; med = likely visual/behavioral drift; low = cosmetic risk. Quote the exact diff lines in the issue.
2. SCOPE AUDIT (blocking). Every changed line must be attributable to one of the targeted signals or the approved design_direction tokens. Changed lines with no matching signal = unapproved_changes (list them). An editor that "improved" something on its own is a pipeline defect even if the improvement looks good.
3. SIGNAL RESOLUTION. For each targeted signal: is it actually resolved in the new code — not merely moved, renamed, or partially patched? Also check for REGRESSION: did the fix introduce a different known fingerprint (e.g., replaced a purple gradient with dark+gold, swapped Inter for Playfair Display)? A regression counts as unresolved and must be named.
4. HUMAN QUALITY (scored, not blocking). Score 0-100: 90+ = a designer would sign this; 70-89 = clearly improved, minor generic remnants; 50-69 = better but still template-with-edits; <50 = a different flavor of generic. Judge coherence: do all edits follow ONE design direction?
</checks>

<verdict_rules>
- pass=true ONLY if: zero high-severity functional issues, zero unapproved changes, and every targeted signal resolved or explicitly deferred as needs_human.
- recommend_reapply lists signal_ids to send back to Stage 3, each with a one-line reason the editor can act on ("old_code fragment still present in index.html").
- Do not rewrite code yourself. You review; you never edit.
- Be specific enough that a re-run can fix the issue without guessing.
</verdict_rules>

Return ONLY valid JSON matching the schema. No prose.`;

export const QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pass: { type: "boolean" },
    functional_issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["high", "med", "low"] },
          file: { type: "string" },
          diff_lines: { type: "string" },
          note: { type: "string" },
        },
        required: ["severity", "file", "diff_lines", "note"],
      },
    },
    unapproved_changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          diff_lines: { type: "string" },
          note: { type: "string" },
        },
        required: ["file", "diff_lines", "note"],
      },
    },
    regressions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id_introduced: { type: ["integer", "null"] },
          location: { type: "string" },
          note: { type: "string" },
        },
        required: ["location", "note"],
      },
    },
    signal_resolution: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id: { type: "integer" },
          resolved: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["signal_id", "resolved", "note"],
      },
    },
    human_quality_score: { type: "integer" },
    recommend_reapply: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          signal_id: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["signal_id", "reason"],
      },
    },
  },
  required: [
    "pass",
    "functional_issues",
    "unapproved_changes",
    "regressions",
    "signal_resolution",
    "human_quality_score",
    "recommend_reapply",
  ],
};

export function buildStage5UserContent(
  diffs: string,
  targetedSignals: Signal[],
  designDirection: unknown,
): string {
  // Clean context: ONLY diffs + the signal list + the approved tokens. No
  // rationale from Stages 1-2 is included, on purpose.
  const signalsBlock = targetedSignals
    .map((s) => `#${s.id} | ${s.name} | weight: ${s.weight}\n   detection: ${s.detection}`)
    .join("\n\n");
  return `<diffs>\n${diffs}\n</diffs>\n\n` +
    `<targeted_signals>\n${signalsBlock}\n</targeted_signals>\n\n` +
    `<design_direction>\n${JSON.stringify(designDirection, null, 2)}\n</design_direction>`;
}

export interface Stage5Result {
  verdict: Record<string, unknown>;
  usage: ClaudeResult["usage"];
}

export async function runStage5(opts: CommonOpts & {
  original: Map<string, string>;
  edited: Map<string, string>;
  targetedSignals: Signal[];
  designDirection: unknown;
}): Promise<Stage5Result> {
  const diffs = buildDiffs(opts.original, opts.edited);
  const userContent = buildStage5UserContent(diffs, opts.targetedSignals, opts.designDirection);
  const call = opts.callImpl ?? callClaude;
  const res = await call({
    apiKey: opts.apiKey,
    model: opts.model ?? MODEL,
    effort: opts.effort ?? "high",
    maxTokens: 16000,
    system: STAGE5_SYSTEM,
    schema: QA_SCHEMA,
    userContent,
    timeoutMs: opts.timeoutMs,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  return { verdict: (res.json ?? {}) as Record<string, unknown>, usage: res.usage };
}
