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

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MODEL = "claude-opus-4-8";
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
  return (signals as Array<Record<string, string>>)
    .map(
      (s) =>
        `#${s.id} | ${s.name} | category: ${s.category} | weight: ${s.weight} | auto_fixable: ${s.auto_fixable}\n   detection: ${s.detection}`,
    )
    .join("\n\n");
}

const SYSTEM_PROMPT = `You are FingerprintAuditor, an automated static-analysis auditor that detects the "AI fingerprint" in websites built with AI site builders. You audit against a FIXED list of ${SIGNAL_COUNT} signals. In this pass you do exactly TWO things and fix NOTHING: (1) diagnose every signal, (2) build a factual profile of the site.

Your output feeds three downstream stages (fix proposal, code editing, QA). A false positive here poisons the entire pipeline and can cause a working site to be "fixed" into a broken one. When in doubt, report absent with low confidence.

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
STEP 3 — DIAGNOSE BY CATEGORY, in signal ID order. Actively search each signal's detection criteria in every relevant file before deciding.
STEP 4 — APPLICABILITY. RTL/Hebrew signals apply only if the site has Hebrew/Arabic content or dir="rtl". Israeli-regulation signals apply only for the Israeli market. Dark-mode #000 signals apply only if a dark mode exists. applicable=false is NOT a defect and must not affect the score.
STEP 5 — SCORE deterministically: score = round(100 * sum(weight_points of present & applicable) / sum(weight_points of all applicable)). weight_points: high/very-high=3, medium=2, low=1. present_count = count of present=true.
</process>

<evidence_rules>
- Return an entry for ALL ${SIGNAL_COUNT} signals, in ID order. Never skip one.
- present=true requires concrete evidence: file path + a VERBATIM code snippet (max ~200 chars, copied exactly) + a one-line explanation of how it meets the criteria. Cap at 5 representative locations, note total_occurrences.
- Never infer problems not literally in the code. If an absence-type signal cannot be verified because the file wasn't provided, mark present=false, confidence <= 0.3, note "insufficient input".
</evidence_rules>

<confidence_calibration>
0.95-1.0 exact literal match; 0.7-0.9 clear interpretation; 0.4-0.7 ambiguous judgment call; <0.4 weak — prefer present=false unless verbatim.
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
  try {
    ({ scan_id: scanId } = await req.json());
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }

  await admin.from("scans").update({ status: "detecting" }).eq("id", scanId);

  try {
    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage
      .from("scans")
      .download(bundlePath);
    if (dlErr || !file) throw new Error("bundle not found in storage");
    const bundle = await file.text();
    const fileCount = (bundle.match(/^=== FILE: /gm) ?? []).length;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32000,
        // effort medium keeps the single call bounded within the function's
        // wall-clock while staying accurate on deterministic signals.
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: SCHEMA },
        },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Audit this project. Return JSON per the schema.\n\n${bundle}`,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("model refused");

    const textBlock = (data.content ?? []).find(
      (b: { type: string }) => b.type === "text",
    );
    if (!textBlock) throw new Error("no text block in response");
    const detection = JSON.parse(textBlock.text);

    // Recompute the score deterministically from the returned signals.
    const { score, present } = computeScore(detection.signals ?? []);

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
      ai_fingerprint_score: score,
      present_count: present,
      files_scanned: detection.meta?.files_scanned ?? fileCount,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .from("scans")
      .update({ status: "error", error: message })
      .eq("id", scanId);
    return json({ error: message }, 500);
  }
});
