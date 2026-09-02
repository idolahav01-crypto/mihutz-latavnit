// Stage 1 — detection + site profile.
// Reads a filtered bundle from Storage, runs ONE Claude call (temp 0 via effort,
// structured output, signal list prompt-cached), writes detection.json +
// site_profile.json + a deterministic score back to the scans row.
//
// Secrets required (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";
import signals from "./signals.json" with { type: "json" };
import {
  assembleFinalFiles,
  type DetectionResult,
  mergeDetection,
  parseBundle,
  serializeBundle,
} from "../_shared/pipeline.ts";
import { MECHANICAL_IDS, mechanicalSignals, overlayMechanical } from "../_shared/mechanical.ts";
import { applyCatalogueRules, fillUnevaluated, missingIds, stampWeights } from "../_shared/catalogue.ts";
import { assetInventory, detectLanguage, isAiDefaultColour, normHex } from "../_shared/profile.ts";
import { checkDetectionSanity } from "../_shared/sanity.ts";
import { assertModelPriced, meteredClaude } from "../_shared/usage.ts";

// Secrets pasted through a dashboard often carry a trailing newline or space,
// which makes fetch() reject the header as a non-ByteString. Clean it here.
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Sonnet 5 is the right tier for diagnosis: it is a fixed-rubric classification
// pass against a documented signal list, not open-ended design work. It is also
// ~2.5x cheaper than Opus ($2/$10 vs $5/$25 per MTok at current rates) and
// faster, which matters directly here because every pass races a 150s
// edge-function wall clock.
const MODEL = "claude-sonnet-5";
// Fail on the first invoke, not after a paid scan recorded $0.00.
assertModelPriced(MODEL);
const SIGNAL_COUNT = (signals as unknown[]).length; // 110
// The mechanical ids are decided by text search in _shared/mechanical.ts, so
// they are never put to the model: same answer every run, and the output tokens
// they used to cost disappear.
const MODEL_SIGNALS = (signals as Array<{ id: number }>).filter(
  (s) => !MECHANICAL_IDS.includes(s.id),
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

// Weight → points, mirrors the pipeline scoring rule.
const WEIGHT_POINTS: Record<string, number> = {
  "very-high": 3,
  high: 3,
  medium: 2,
  low: 1,
};

function buildSignalList(): string {
  // No cast: `id` is a number, so Record<string, string> was never accurate and
  // failed `deno check`. Template interpolation handles the JSON types as-is.
  return signals
    .map(
      (s) =>
        `#${s.id} | ${s.name} | category: ${s.category} | weight: ${s.weight} | auto_fixable: ${s.auto_fixable}\n   detection: ${s.detection}`,
    )
    .join("\n\n");
}

const SYSTEM_PROMPT = `You are FingerprintAuditor, an automated static-analysis auditor that detects the "AI fingerprint" in websites built with AI site builders. You audit against a FIXED list of ${SIGNAL_COUNT} signals. In this pass you do exactly TWO things and fix NOTHING: (1) diagnose every signal, (2) build a factual profile of the site.

Your output feeds three downstream stages (fix proposal, code editing, QA). Two rules govern everything and they do NOT conflict:
(1) HUNT AGGRESSIVELY. Sites built by AI builders carry MANY fingerprints — typically dozens. Your job is to find all of them, not to be cautious. If you finish a pass with only a handful of signals present, you have not looked hard enough: go back through the categories you skimmed.
(2) NEVER FABRICATE. present=true ALWAYS requires a verbatim snippet copied exactly from the code. A claim with no exact snippet is the one thing that poisons the pipeline (a fabricated signal cannot even be fixed downstream), so evidence is non-negotiable.
Aggressive recall means looking HARDER in the real code, never inventing evidence. Genuine, evidenced signals must be reported generously — never withheld out of caution.

<signal_list>
${buildSignalList()}
</signal_list>

<input_format>
The entire project arrives as multiple files delimited by:
=== FILE: <path> ===
Search EVERY file and EVERY language: HTML, CSS, SCSS, JS/TS, JSX/TSX, Vue, Svelte, inline <script>/<style>, and config files (tailwind.config.js, package.json, etc.). Signals live everywhere. Never assume a signal only lives in HTML/CSS.
</input_format>

<process>
STEP 1 — INVENTORY. Note vendored/minified/framework-reset files; EXCLUDE them from diagnosis (signals must be in the site's own code). Record them in meta.excluded_files.
STEP 2 — SITE PROFILE FIRST. Read the real content and design before hunting for problems, so diagnosis has context.
STEP 3 — DIAGNOSE BY CATEGORY, in signal ID order. For EACH signal, actively search its detection criteria across every relevant file before deciding — do not skim. Assume a template-built site is LIKELY to have the signal and try to prove it with a verbatim snippet; only mark absent after you have genuinely looked and found nothing to quote.
STEP 4 — APPLICABILITY. RTL/Hebrew signals apply only if the site has Hebrew/Arabic content or dir="rtl". Israeli-regulation signals apply only for the Israeli market. Dark-mode #000 signals apply only if a dark mode exists. applicable=false is NOT a defect and must not affect the score.
STEP 5 — SCORE deterministically: score = round(100 * sum(weight_points of present & applicable) / sum(weight_points of all applicable)). weight_points: high/very-high=3, medium=2, low=1. present_count = count of present=true.
</process>

<evidence_rules>
- Return an entry for ALL ${SIGNAL_COUNT} signals, in ID order. Never skip one.
- present=true requires concrete evidence: file path + a VERBATIM code snippet (max ~200 chars, copied exactly) + a one-line explanation of how it meets the criteria. Cap at 5 representative locations, note total_occurrences.
- Report EVERY signal you can back with a verbatim snippet as present — do not withhold a genuinely-evidenced signal out of caution. The only thing you must never do is claim a signal with no exact snippet to quote. If an absence-type signal cannot be verified because the file wasn't provided, mark present=false, confidence <= 0.3, note "insufficient input".
</evidence_rules>

<site_profile_rules>
- business_domain: what the business IS, read off its real content. This decides the tone the rebuild is allowed to take — a law firm and a skate shop do not get the same design language. Pick "other" only when the content genuinely will not say.
- brand_colour: the site's single most identity-carrying colour, and — separately — whether it looks CHOSEN or merely DEFAULTED.
  evidence="logo" the colour appears in the logo mark or logo text.
  evidence="consistent_across_pages" the same colour carries the primary action on every page.
  evidence="industry_conventional" it is the colour this industry actually uses.
  evidence="css_variable_only" it is named as a token but nothing else backs it.
  evidence="none" no colour stands out as the site's own.
  deliberate=true ONLY for a colour a person appears to have picked. A default from an AI builder's palette — indigo/violet #6366f1-family, a purple-to-blue hero gradient, neon, or the dark-navy-plus-gold combination — is deliberate=false however consistently it is used. Consistency is not intent.
  When nothing qualifies, return hex "" with evidence "none" and deliberate false. That is a normal answer, not a failure.
</site_profile_rules>

<confidence_calibration>
0.95-1.0 exact literal match; 0.7-0.9 clear interpretation backed by a verbatim snippet → report PRESENT; 0.4-0.7 evidenced judgment call → lean PRESENT if you can quote it; <0.4 nothing to quote → present=false. Simple rule: if you can quote it verbatim, report it present.
</confidence_calibration>

Return ONLY valid JSON matching the provided schema. No prose outside the JSON.`;

// Structured-output schema. Kept intentionally permissive (structured outputs
// ignore min/maxItems); the prompt enforces "all signals, ID order".
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ai_fingerprint_score: { type: "integer" },
    present_count: { type: "integer" },
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        files_scanned: { type: "integer" },
        excluded_files: { type: "array", items: { type: "string" } },
      },
      required: ["files_scanned", "excluded_files"],
    },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          present: { type: "boolean" },
          applicable: { type: "boolean" },
          weight: { type: "string" },
          confidence: { type: "number" },
          total_occurrences: { type: "integer" },
          explanation: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                file: { type: "string" },
                snippet: { type: "string" },
              },
              required: ["file", "snippet"],
            },
          },
        },
        required: [
          "id",
          "name",
          "present",
          "applicable",
          "weight",
          "confidence",
          "total_occurrences",
          "explanation",
          "evidence",
        ],
      },
    },
    site_profile: {
      type: "object",
      additionalProperties: false,
      properties: {
        purpose: { type: "string" },
        audience: { type: "string" },
        design_language: { type: "string" },
        language_direction: { type: "string" },
        primary_language: { type: "string" },
        palette: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              hex: { type: "string" },
              role: { type: "string" },
            },
            required: ["hex", "role"],
          },
        },
        fonts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              family: { type: "string" },
              hebrew_support: { type: "boolean" },
            },
            required: ["family", "hebrew_support"],
          },
        },
        distinctive_elements: { type: "array", items: { type: "string" } },
        tech_stack: { type: "array", items: { type: "string" } },
        // The design stage rebuilds the site in a deliberately different look.
        // Without these two it departs from the brand as readily as from the
        // template — a different colour for a business whose colour IS the
        // business, and a playful direction for a law firm.
        business_domain: {
          type: "string",
          enum: [
            "legal", "medical", "finance", "real_estate", "education",
            "food", "retail", "creative", "technology", "services",
            "nonprofit", "personal", "other",
          ],
        },
        brand_colour: {
          type: "object",
          additionalProperties: false,
          properties: {
            hex: { type: "string" },
            // Where the evidence comes from. "none" is a real answer and the
            // most common one: most AI-built sites wear a default.
            evidence: {
              type: "string",
              enum: ["logo", "consistent_across_pages", "industry_conventional", "css_variable_only", "none"],
            },
            deliberate: { type: "boolean" },
            note: { type: "string" },
          },
          required: ["hex", "evidence", "deliberate", "note"],
        },
      },
      required: [
        "purpose",
        "audience",
        "design_language",
        "language_direction",
        "primary_language",
        "palette",
        "fonts",
        "distinctive_elements",
        "tech_stack",
        "business_domain",
        "brand_colour",
      ],
    },
  },
  required: ["ai_fingerprint_score", "present_count", "meta", "signals", "site_profile"],
};

/**
 * The same audit, asked for two numbers instead of an essay.
 *
 * The "after" pass exists to produce ai_fingerprint_score_after and
 * present_count_after. Nothing reads detection_after itself — not the report,
 * not the download, not the pull request — yet the pass was returning a name,
 * an explanation and up to five evidence snippets for all 110 signals, three
 * times. Measured over 14 runs it cost $0.60 against the first scan's $0.49,
 * because output is where the money is and almost all of that output was prose
 * nobody would ever read.
 *
 * Same model, same signals, same computeScore, same fixed denominator, so the
 * before/after pair stays comparable — the one property this number has to
 * have. `weight` is dropped along with the prose: it belongs to the catalogue,
 * not to the site, and fillUnevaluated already reads it from signals.json.
 */
const AFTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          present: { type: "boolean" },
          applicable: { type: "boolean" },
          confidence: { type: "number" },
        },
        required: ["id", "present", "applicable", "confidence"],
      },
    },
  },
  required: ["signals"],
};

// Deterministic recompute — never trust the model's own arithmetic.
/**
 * How many passes to split the 110-signal audit across.
 *
 * Measured: wall-clock scales with the number of signals the model reports as
 * PRESENT (output tokens), not with input size — a 322KB bundle with 4 present
 * signals finished in 24s, while a 10.5KB bundle timed out past 150s. That
 * makes the failure worst on the most heavily-templated sites, which are
 * exactly this product's target. Splitting bounds the output per request.
 */
const DEFAULT_PARTS = 3;

/**
 * How many times we go back for the signals the model skipped.
 *
 * Two, because the first gap pass fixes an ordinary early stop and a second
 * covers a bad draw on top of it, while a third would mean the model is
 * refusing this slice for a reason more calls will not solve. After that the
 * remaining ids are recorded as unevaluated rather than chased.
 */
const MAX_GAP_ATTEMPTS = 2;

function computeScore(sigs: Array<Record<string, unknown>>): {
  score: number;
  present: number;
} {
  let num = 0;
  let den = 0;
  let present = 0;
  for (const s of sigs) {
    if (s.applicable === false) continue;
    const pts = WEIGHT_POINTS[String(s.weight)] ?? 2;
    den += pts;
    if (s.present === true) {
      num += pts;
      present += 1;
    }
  }
  return { score: den === 0 ? 0 : Math.round((100 * num) / den), present };
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Identify the caller from their JWT so we only ever touch their own scan.
  const authHeader = req.headers.get("Authorization") ?? "";
  const { data: userData } = await admin.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  const user = userData?.user;
  if (!user) return json({ error: "unauthorized" }, 401);

  let scanId: string;
  // mode "after" re-runs this same audit on the FIXED code so the UI can show a
  // real before/after fingerprint score instead of asserting an improvement.
  // Everything about the audit is identical — same prompt, same schema, same
  // scoring — which is the only way the two numbers are comparable.
  let mode: "before" | "after" = "before";
  // The audit is split across `parts` sequential requests; see DEFAULT_PARTS.
  let part = 1;
  let parts = DEFAULT_PARTS;
  // A re-hunt takes a completed "before" detection and looks HARDER, only at the
  // signals currently marked absent, to raise recall on a suspiciously-low count
  // without ever fabricating (it can only ADD present signals, never remove one).
  let rehunt = false;
  // A gap pass re-asks about the signals the model never returned. It is its
  // own request with its own full 150s, rather than a retry squeezed into the
  // milliseconds left over from the previous pass — that version was given a
  // flat 60s and died on `stage_timeout_after_60s`, so completeness depended on
  // how fast the pass before it happened to run. It no longer does.
  let gapPass = false;
  let gapAttempt = 0;
  try {
    const body = await req.json();
    scanId = body.scan_id;
    if (body.mode === "after") mode = "after";
    if (body.rehunt === true) rehunt = true;
    if (body.gap === true) gapPass = true;
    if (Number.isInteger(body.gap_attempt) && body.gap_attempt >= 0) gapAttempt = body.gap_attempt;
    if (Number.isInteger(body.parts) && body.parts >= 1) parts = body.parts;
    if (Number.isInteger(body.part) && body.part >= 1) part = Math.min(body.part, parts);
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection, detection_after")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }

  // ---- re-hunt: one aggressive extra look over the currently-absent signals ----
  if (rehunt) {
    try {
      if (!ANTHROPIC_API_KEY) throw new Error("missing_anthropic_api_key");
      if (!/^[\x20-\x7E]+$/.test(ANTHROPIC_API_KEY)) {
        throw new Error("invalid_anthropic_api_key_characters");
      }
      const startedAt = Date.now();
      const prior = (scan.detection ?? {}) as DetectionResult;
      const absentIds = (prior.signals ?? [])
        .filter((s) => s.present !== true && s.applicable !== false)
        .map((s) => Number(s.id))
        .filter((id) => !MECHANICAL_IDS.includes(id));
      if (!absentIds.length) {
        applyCatalogueRules(prior);
        const { score, present } = computeScore(prior.signals ?? []);
        return json({ ok: true, scan_id: scanId, mode: "rehunt", done: true, ai_fingerprint_score: score, present_count: present });
      }

      const bundlePath = `${user.id}/${scanId}/bundle.txt`;
      const { data: file, error: dlErr } = await admin.storage.from("scans").download(bundlePath);
      if (dlErr || !file) throw new Error("bundle not found in storage");
      const bundle = await file.text();

      const idList = absentIds.map((id) => `#${id}`).join(", ");
      const claude = await meteredClaude({ admin, scanId, startedAt, stage: "detect_rehunt" }, {
        apiKey: ANTHROPIC_API_KEY,
        model: MODEL,
        effort: "medium",
        maxTokens: 32000,
        system: SYSTEM_PROMPT,
        userContent: `RE-HUNT PASS. On an earlier pass these signals were marked ABSENT for this site. ` +
          `Look again, HARDER — a template-built site usually hits most of these, and a low count means the first look was too shy. ` +
          `For EACH, either find a VERBATIM snippet in the code and mark present=true, or leave it out if it is genuinely absent. ` +
          `Return entries ONLY for signals you can now mark present=true with a verbatim snippet; omit all others. ` +
          `Do NOT return site_profile, meta, or scores.\n\n` +
          `Signals to re-examine: ${idList}\n\n${bundle}`,
        schema: SCHEMA,
        timeoutMs: 130_000,
      });

      // Additive only: keep just the newly-present signals and merge over prior.
      const found = claude.json as DetectionResult;
      const additions = (found.signals ?? []).filter((s) => s.present === true);
      const merged = mergeDetection(prior, { signals: additions });
      // A re-hunt is allowed to find more, never to overrule a text search.
      merged.signals = overlayMechanical(
        merged.signals ?? [],
        mechanicalSignals(parseBundle(bundle)),
      );
      applyCatalogueRules(merged);
      const { score, present } = computeScore(merged.signals ?? []);
      await admin.from("scans")
        .update({ detection: merged, ai_fingerprint_score: score, present_count: present })
        .eq("id", scanId);

      return json({ ok: true, scan_id: scanId, mode: "rehunt", done: true, ai_fingerprint_score: score, present_count: present, newly_found: additions.length });
    } catch (e) {
      // Non-fatal: a failed re-hunt must never damage the existing good scan.
      const message = e instanceof Error ? e.message : String(e);
      return json({ error: message, mode: "rehunt" }, 500);
    }
  }

  if (mode === "before" && part === 1) {
    await admin.from("scans").update({ status: "detecting" }).eq("id", scanId);
  }

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("missing_anthropic_api_key");
    // Header values must be Latin-1; a stray unicode char means a bad paste.
    if (!/^[\x20-\x7E]+$/.test(ANTHROPIC_API_KEY)) {
      throw new Error("invalid_anthropic_api_key_characters");
    }

    const startedAt = Date.now();
    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage
      .from("scans")
      .download(bundlePath);
    if (dlErr || !file) throw new Error("bundle not found in storage");
    let bundle = await file.text();

    if (mode === "after") {
      // The edited bundle holds ONLY the files Stage 4 touched. Auditing it
      // alone would score a fraction of the project and look like a huge
      // improvement for the wrong reason, so overlay it on the original and
      // audit the complete, assembled project.
      const { data: editedFile, error: edErr } = await admin.storage
        .from("scans")
        .download(`${user.id}/${scanId}/edited-bundle.txt`);
      if (edErr || !editedFile) throw new Error("edited_bundle_not_found");
      bundle = serializeBundle(
        assembleFinalFiles(parseBundle(bundle), parseBundle(await editedFile.text())),
      );
    }

    const fileCount = (bundle.match(/^=== FILE: /gm) ?? []).length;

    // The size of what we are about to pay to scan, recorded BEFORE the first
    // model call. Scan cost scales with bundle size — the whole bundle is sent
    // on every pass — so this is the per-site driver the estimate buckets on,
    // and a scan that dies half-way is only interpretable if its size was
    // written down before it died. Cheap: one small update, on pass 1 only.
    if (part === 1 && !gapPass && mode !== "after") {
      const { error: sizeErr } = await admin
        .from("scans")
        .update({ bundle_bytes: bundle.length })
        .eq("id", scanId);
      if (sizeErr) console.error(`[usage] bundle_bytes not recorded for ${scanId}: ${sizeErr.message}`);
    }

    // Which signals this pass is responsible for. The SYSTEM prompt still
    // carries all 110 (identical bytes every pass, so it stays prompt-cached);
    // only the user turn narrows the scope.
    const priorStored = mode === "after"
      ? (scan as { detection_after?: unknown }).detection_after
      : scan.detection;

    let detection: DetectionResult;

    if (gapPass) {
      // Only the ids nobody returned, with the whole request to do it in.
      const prior = (priorStored ?? {}) as DetectionResult;
      const need = missingIds(prior);
      if (!need.length) {
        detection = prior;
      } else {
        const claude = await meteredClaude({
          admin, scanId, startedAt,
          stage: `${mode === "after" ? "detect_after" : "detect"}_gap${gapAttempt}`,
        }, {
          apiKey: ANTHROPIC_API_KEY,
          model: MODEL,
          effort: "medium",
          maxTokens: 32000,
          system: SYSTEM_PROMPT,
          userContent: `GAP PASS. These signals were assigned to an earlier pass and it returned ` +
            `no entry for any of them. Evaluate EVERY one now and return an entry for each, ` +
            `present or absent, under the same evidence rules as any other pass. ` +
            `Do NOT return site_profile, meta, or scores.\n\n` +
            `Signals: ${need.map((id) => `#${id}`).join(", ")}\n\n${bundle}`,
          schema: mode === "after" ? AFTER_SCHEMA : SCHEMA,
          timeoutMs: 130_000,
        });
        detection = mergeDetection(prior, claude.json as DetectionResult);
      }
      detection.signals = overlayMechanical(
        detection.signals ?? [],
        mechanicalSignals(parseBundle(bundle)),
      );
    } else {
      const perPart = Math.ceil(MODEL_SIGNALS.length / parts);
      const slice = MODEL_SIGNALS.slice((part - 1) * perPart, part * perPart);
      const idList = slice.map((sg) => `#${sg.id}`).join(", ");

      // Routed through the shared client so this stage gets the same treatment as
      // 2/4/5: streaming (a 32k-token non-streaming response is an idle timeout
      // waiting to happen), an abort budget that reports `stage_timeout_after_Ns`
      // instead of an opaque 546, and schema sanitising.
      //
      // NOT fast mode: this org's fast-mode quota is 0 tokens/min, so speed:"fast"
      // returns a hard 429. Splitting the work is what buys the headroom instead.
      const claude = await meteredClaude({
        admin, scanId, startedAt,
        stage: `${mode === "after" ? "detect_after" : "detect"}_part${part}`,
      }, {
        apiKey: ANTHROPIC_API_KEY,
        model: MODEL,
        effort: "medium",
        maxTokens: 32000,
        system: SYSTEM_PROMPT,
        userContent: `Audit this project. Return JSON per the schema.\n\n` +
          `THIS PASS (${part} of ${parts}): evaluate ONLY these signals and return ` +
          `no others: ${idList}\n` +
          (mode === "after"
            // Re-measurement, not a report. The verdict is the whole product of
            // this pass, and the schema will not accept anything else — so the
            // hunting rules still apply, and the writing-up does not.
            ? `RE-MEASUREMENT PASS. Return ONLY id, present, applicable and confidence ` +
              `for each signal. Do NOT write names, explanations or evidence, and do NOT ` +
              `return site_profile, meta or scores. Judge each signal exactly as ` +
              `rigorously as a first audit — you are simply not writing the verdict up.\n`
            : part === 1
            ? `Also return site_profile and meta on this pass.\n`
            : `Do NOT return site_profile, meta, or scores on this pass.\n`) +
          `\n${bundle}`,
        schema: mode === "after" ? AFTER_SCHEMA : SCHEMA,
        timeoutMs: 130_000,
      });

      // Fold this pass into whatever the earlier passes recorded. In "after" mode
      // the partials accumulate in detection_after so the original "before"
      // detection (scan.detection) is never touched or corrupted mid-rescan.
      const prior = (part === 1 ? {} : (priorStored ?? {})) as DetectionResult;
      detection = mergeDetection(prior, claude.json as DetectionResult);
      // Applied on every pass, not just the last, so a partial save on disk is
      // never internally inconsistent with the finished one.
      detection.signals = overlayMechanical(
        detection.signals ?? [],
        mechanicalSignals(parseBundle(bundle)),
      );
    }

    // Intermediate pass: persist the partial audit and hand the baton back to
    // the client, which drives the next pass. Status stays "detecting" so a
    // half-finished scan can never look complete.
    if (!gapPass && part < parts) {
      await admin.from("scans")
        .update(mode === "after" ? { detection_after: detection } : { detection })
        .eq("id", scanId);
      return json({
        ok: true,
        scan_id: scanId,
        mode,
        part,
        parts,
        done: false,
        signals_so_far: (detection.signals ?? []).length,
      });
    }

    // ---- completeness, before anything is scored ----
    // A signal the model never returned must not quietly leave the denominator.
    // Gaps go back to the client as another pass with its own full budget, up
    // to MAX_GAP_ATTEMPTS times; only then do we write them down as unevaluated.
    // Nothing here depends on how long the previous pass happened to take.
    const gaps = missingIds(detection);
    if (gaps.length && gapAttempt < MAX_GAP_ATTEMPTS) {
      await admin.from("scans")
        .update(mode === "after" ? { detection_after: detection } : { detection })
        .eq("id", scanId);
      return json({
        ok: true,
        scan_id: scanId,
        mode,
        part,
        parts,
        done: false,
        gap: true,
        gap_attempt: gapAttempt + 1,
        missing: gaps.length,
      });
    }
    if (gaps.length) fillUnevaluated(detection, gaps);

    // The catalogue's own decisions, applied after the model and before the
    // score: signals we do not score a site on are struck out, and the ones
    // that need a fact from the owner are marked so the report can ask.
    applyCatalogueRules(detection);
    // Weights come from the catalogue, never from the model — see stampWeights.
    // The lean after-scan schema does not ask for weight at all, so without this
    // the two halves of the before/after pair would be scored on different
    // scales and the comparison would be meaningless.
    stampWeights(detection);

    // Recompute the score deterministically from the returned signals.
    const { score, present } = computeScore(detection.signals ?? []);

    // Three profile facts the design stage needs are measurements, not
    // opinions, so they are taken from the bundle rather than believed from
    // the model: what language the copy is in, what visual material the site
    // owns, and whether its "brand" colour is one of the tool defaults. The
    // model's own reading is kept alongside, never overwritten.
    const files = parseBundle(bundle);
    const profile = (detection.site_profile ?? {}) as Record<string, unknown>;
    const language = detectLanguage(files);
    const assets = assetInventory(files);
    const brand = (profile.brand_colour ?? {}) as { hex?: string; deliberate?: boolean };
    const brandHex = normHex(brand.hex);
    detection.site_profile = {
      ...profile,
      measured_language: language,
      visual_assets: assets,
      brand_colour: {
        ...(brand as Record<string, unknown>),
        hex: brandHex ?? "",
        // The model may call a default deliberate; a text search cannot be
        // talked into it. A colour on the AI-default list is never preserved,
        // whatever the model concluded about intent.
        ai_default: brandHex ? isAiDefaultColour(brandHex) : false,
        preserve: !!brandHex && brand.deliberate === true && !isAiDefaultColour(brandHex),
      },
    };

    // Can this result be shown as a clean bill of health? Only the mechanical
    // checks can corroborate a near-empty audit, and only they can contradict
    // one. This never changes a signal or a score — it labels the run.
    const sanity = checkDetectionSanity(detection.signals ?? []);
    // Stored, not just returned: whether a result can be shown as clean has to
    // survive the tab that produced it, or reopening the scan from the history
    // quietly turns an under-read audit back into a clean bill of health.
    (detection as Record<string, unknown>).sanity_ok = sanity.trustworthy;
    (detection as Record<string, unknown>).sanity_reason = sanity.reason;

    if (mode === "after") {
      // Written to the *_after columns; the original numbers stay untouched so
      // the pair can be shown side by side.
      const { data: before } = await admin
        .from("scans")
        .select("ai_fingerprint_score, present_count")
        .eq("id", scanId)
        .single();

      await admin
        .from("scans")
        .update({
          detection_after: detection,
          ai_fingerprint_score_after: score,
          present_count_after: present,
          rescanned_at: new Date().toISOString(),
        })
        .eq("id", scanId);

      return json({
        ok: true,
        scan_id: scanId,
        mode,
        part,
        parts,
        done: true,
        before: {
          ai_fingerprint_score: before?.ai_fingerprint_score ?? null,
          present_count: before?.present_count ?? null,
        },
        after: { ai_fingerprint_score: score, present_count: present },
        unevaluated: gaps.length,
        // Negative = the fingerprint went down, which is the goal.
        score_delta: before?.ai_fingerprint_score == null
          ? null
          : score - before.ai_fingerprint_score,
      });
    }

    await admin
      .from("scans")
      .update({
        status: "done",
        files_scanned: detection.meta?.files_scanned ?? fileCount,
        ai_fingerprint_score: score,
        present_count: present,
        detection,
        site_profile: detection.site_profile ?? null,
      })
      .eq("id", scanId);

    if (!sanity.trustworthy) {
      console.warn(
        `detection UNDER-READ on ${scanId}: model found ${sanity.model_present} ` +
        `where text search found ${sanity.mechanical_present}`,
      );
    }

    return json({
      ok: true,
      scan_id: scanId,
      mode,
      part,
      parts,
      done: true,
      ai_fingerprint_score: score,
      present_count: present,
      files_scanned: detection.meta?.files_scanned ?? fileCount,
      unevaluated: gaps.length,
      // The client decides what to show on the strength of these: a clean
      // result it can stand behind, or one that needs looking at again.
      sanity: sanity.reason,
      trustworthy: sanity.trustworthy,
      language: detection.site_profile
        ? (detection.site_profile as { measured_language?: unknown }).measured_language ?? null
        : null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A failed re-scan must not mark the original, successful scan as errored.
    if (mode === "before") {
      await admin
        .from("scans")
        .update({ status: "error", error: message })
        .eq("id", scanId);
    }
    return json({ error: message, mode, part, parts }, 500);
  }
});
