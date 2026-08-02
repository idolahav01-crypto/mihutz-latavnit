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
import { callClaude } from "../_shared/anthropic.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";


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
const SIGNAL_COUNT = (signals as unknown[]).length; // 108

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
      ],
    },
  },
  required: ["ai_fingerprint_score", "present_count", "meta", "signals", "site_profile"],
};

// Deterministic recompute — never trust the model's own arithmetic.
/**
 * How many passes to split the 108-signal audit across.
 *
 * Measured: wall-clock scales with the number of signals the model reports as
 * PRESENT (output tokens), not with input size — a 322KB bundle with 4 present
 * signals finished in 24s, while a 10.5KB bundle timed out past 150s. That
 * makes the failure worst on the most heavily-templated sites, which are
 * exactly this product's target. Splitting bounds the output per request.
 */
const DEFAULT_PARTS = 3;

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
  try {
    const body = await req.json();
    scanId = body.scan_id;
    if (body.mode === "after") mode = "after";
    if (body.rehunt === true) rehunt = true;
    if (Number.isInteger(body.parts) && body.parts >= 1) parts = body.parts;
    if (Number.isInteger(body.part) && body.part >= 1) part = Math.min(body.part, parts);
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection")
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
        .map((s) => Number(s.id));
      if (!absentIds.length) {
        const { score, present } = computeScore(prior.signals ?? []);
        return json({ ok: true, scan_id: scanId, mode: "rehunt", done: true, ai_fingerprint_score: score, present_count: present });
      }

      const bundlePath = `${user.id}/${scanId}/bundle.txt`;
      const { data: file, error: dlErr } = await admin.storage.from("scans").download(bundlePath);
      if (dlErr || !file) throw new Error("bundle not found in storage");
      const bundle = await file.text();

      const idList = absentIds.map((id) => `#${id}`).join(", ");
      const claude = await callClaude({
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
      const { score, present } = computeScore(merged.signals ?? []);

      await recordStageUsage(
        admin, scanId,
        buildEntry("detect_rehunt", MODEL, claude.usage, Date.now() - startedAt, "medium"),
      );
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

    // Which signals this pass is responsible for. The SYSTEM prompt still
    // carries all 108 (identical bytes every pass, so it stays prompt-cached);
    // only the user turn narrows the scope.
    const perPart = Math.ceil(signals.length / parts);
    const slice = signals.slice((part - 1) * perPart, part * perPart);
    const idList = slice.map((sg) => `#${sg.id}`).join(", ");

    // Routed through the shared client so this stage gets the same treatment as
    // 2/4/5: streaming (a 32k-token non-streaming response is an idle timeout
    // waiting to happen), an abort budget that reports `stage_timeout_after_Ns`
    // instead of an opaque 546, and schema sanitising.
    //
    // NOT fast mode: this org's fast-mode quota is 0 tokens/min, so speed:"fast"
    // returns a hard 429. Splitting the work is what buys the headroom instead.
    const claude = await callClaude({
      apiKey: ANTHROPIC_API_KEY,
      model: MODEL,
      effort: "medium",
      maxTokens: 32000,
      system: SYSTEM_PROMPT,
      userContent: `Audit this project. Return JSON per the schema.\n\n` +
        `THIS PASS (${part} of ${parts}): evaluate ONLY these signals and return ` +
        `no others: ${idList}\n` +
        (part === 1
          ? `Also return site_profile and meta on this pass.\n`
          : `Do NOT return site_profile, meta, or scores on this pass.\n`) +
        `\n${bundle}`,
      schema: SCHEMA,
      timeoutMs: 130_000,
    });
    const partDetection = claude.json as DetectionResult;
    const usage = claude.usage;

    // Fold this pass into whatever the earlier passes recorded.
    const prior = (part === 1 ? {} : (scan.detection ?? {})) as DetectionResult;
    const detection = mergeDetection(prior, partDetection);

    await recordStageUsage(
      admin,
      scanId,
      buildEntry(
        `${mode === "after" ? "detect_after" : "detect"}_part${part}`,
        MODEL,
        usage,
        Date.now() - startedAt,
        "medium",
      ),
    );

    // Intermediate pass: persist the partial audit and hand the baton back to
    // the client, which drives the next pass. Status stays "detecting" so a
    // half-finished scan can never look complete.
    if (part < parts) {
      await admin.from("scans").update({ detection }).eq("id", scanId);
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

    // Recompute the score deterministically from the returned signals.
    const { score, present } = computeScore(detection.signals ?? []);

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
