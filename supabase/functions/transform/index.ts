// Stage T — TransformDesigner: whole-file redesign.
//
// Rewrites each HTML/CSS file top-to-bottom into a bold, premium design that
// resolves every detected AI-fingerprint signal AT ONCE — no per-signal patches,
// so there is no verbatim-anchor limitation and the result can look genuinely
// different. Preserves all functionality (JS logic, handlers, classes, ids,
// data-attrs, forms, routes, imports) and all real content/facts.
//
// Client-driven: ONE file per call (bounds output against the 150s limit). The
// design direction is decided on the first file and reused for the rest, so a
// multi-file site stays coherent. Stage 5 (QA) still verifies functional parity.
//
// Body: { scan_id, part? } — `part` selects which transformable file (1-indexed);
// the response returns `parts` (total) and `done`.

import {
  type DetectedSignal,
  parseBundle,
  presentSignals,
  serializeBundle,
} from "../_shared/pipeline.ts";
import { callClaude, cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

const MODEL = "claude-opus-4-8";
const TRANSFORMABLE = /\.(html?|css|scss)$/i;

const SYSTEM =
  `You are TransformDesigner, a world-class brand & web designer. You receive ONE file from a website, a factual profile of the site, and a list of "AI fingerprint" signals to eliminate. You return the SAME file, REWRITTEN, so the site looks like a top studio designed it — visibly different, premium, and coherent — with every listed signal resolved.

THIS IS A FULL REDESIGN, NOT A PATCH. Change boldly: a real color system, a real type system with fonts that are ACTUALLY loaded, a restructured hero, re-laid-out sections, a proper spacing rhythm, refined components. The output MUST look obviously different and better than the input. A result that resembles the original is a FAILURE — that is the single worst outcome.

<process>
1. Commit to ONE design direction for THIS business, derived from the profile: one strong brand color + neutrals (+ optional single accent), a heading+body type pairing, one layout principle, and 3 personality adjectives. Emit it as design_direction. If an <approved_design_direction> is provided, REUSE it verbatim — do not invent a new one.
2. Rewrite the whole file to implement that direction everywhere.
</process>

<hard_contract_never_break>
- DO NOT change any JavaScript. Keep every <script> block's code, every function, every data array, and every event handler EXACTLY as in the original. You redesign appearance and markup, never behavior.
- Preserve every class name, id, data-* attribute, name/for, inline handler (onclick etc.), form action, href/route, and import/asset reference that JS or forms depend on. If you restructure markup, carry these over intact.
- Keep all real content and FACTS (numbers, names, dates, prices), the logo, and images. You may improve wording and tone, but NEVER invent or fabricate facts.
- LOAD every font you use: add the matching <link rel="stylesheet" href="https://fonts.googleapis.com/..."> (or @import) in the <head>. A font referenced but not loaded is a defect.
- Keep the file self-contained if the input was (inline any CSS you add). Add no external dependencies other than web fonts.
- RTL: if the content is Hebrew/RTL, keep dir="rtl", use logical CSS properties (margin-inline, text-align:start), a right-aligned hero (never a centered Hebrew hero), and currency before the number.
</hard_contract_never_break>

<quality_bar>
One brand color used consistently — NOT a purple gradient, NOT the dark+gold "premium" cliche, NOT Playfair/Cormorant as the elegance serif, NOT bento grids or pill tabs. CTAs that name the action. Editorial, asymmetric layouts over centered symmetric card rows. For Hebrew sites use fonts with true Hebrew support (Heebo, Assistant, Rubik, Frank Ruhl Libre, Noto Sans Hebrew), Hebrew body weight >= 500, headings >= 700.
</quality_bar>

Return ONLY valid JSON: { "design_direction": {...}, "file": { "path": "<exact input path>", "content": "<the COMPLETE rewritten file, ready to save and open>" } }. No prose.`;

const SCHEMA = {
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
          properties: { heading: { type: "string" }, body: { type: "string" } },
          required: ["heading", "body"],
        },
        layout_principle: { type: "string" },
        personality: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["brand_palette", "typography", "layout_principle", "personality", "rationale"],
    },
    file: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  required: ["file"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; part?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);
  let part = Number.isInteger(body.part) && (body.part as number) >= 1 ? (body.part as number) : 1;

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection, site_profile, design_direction")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) return json({ error: "scan not found" }, 404);
  if (!scan.detection) return json({ error: "run_detection_first" }, 409);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage.from("scans").download(bundlePath);
    if (dlErr || !file) throw new Error("bundle_not_found");
    const pristine = parseBundle(await file.text());

    const fileList = [...pristine.keys()].filter((p) => TRANSFORMABLE.test(p)).sort();
    if (!fileList.length) return json({ error: "no_transformable_files" }, 409);
    const parts = fileList.length;
    if (part > parts) part = parts;
    const targetPath = fileList[part - 1];
    const targetContent = pristine.get(targetPath) ?? "";

    const present = presentSignals(scan.detection as { signals?: DetectedSignal[] });
    const checklist = present.map((s) => `#${s.id} ${s.name}`).join("\n");

    const priorDirection = part > 1 ? scan.design_direction : null;
    const userContent =
      (priorDirection
        ? `<approved_design_direction>\n${JSON.stringify(priorDirection, null, 2)}\n</approved_design_direction>\n` +
          `Reuse this EXACT direction; return it unchanged as design_direction.\n\n`
        : "") +
      `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
      `<signals_to_resolve>\n${checklist}\n</signals_to_resolve>\n\n` +
      `<file path="${targetPath}">\n${targetContent}\n</file>\n\n` +
      `Rewrite the file above per your instructions. The returned file.path MUST be exactly "${targetPath}".`;

    const startedAt = Date.now();
    const res = await callClaude({
      apiKey,
      model: MODEL,
      effort: "high",
      maxTokens: 32000,
      stream: true,
      system: SYSTEM,
      schema: SCHEMA,
      userContent,
      timeoutMs: 130_000,
    });
    await recordStageUsage(
      admin,
      scanId,
      buildEntry(`transform_part${part}`, MODEL, res.usage, Date.now() - startedAt, "high"),
    );

    const out = (res.json ?? {}) as {
      design_direction?: unknown;
      file?: { path?: string; content?: string };
    };
    const newContent = out.file?.content;
    if (!newContent || typeof newContent !== "string") throw new Error("empty_transform_output");
    const direction = part === 1 ? (out.design_direction ?? scan.design_direction ?? null) : scan.design_direction;

    // Accumulate the rewritten file into the edited-bundle.
    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    let edited = new Map<string, string>();
    if (part > 1) {
      const { data: prev } = await admin.storage.from("scans").download(editedPath);
      if (prev) edited = parseBundle(await prev.text());
    }
    edited.set(targetPath, newContent);
    const up = await admin.storage
      .from("scans")
      .upload(editedPath, new Blob([serializeBundle(edited)], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (up.error) throw new Error(`storage: ${up.error.message}`);

    const done = part >= parts;
    const update: Record<string, unknown> = {
      // Reuse the allowed status values: mid-run = "applying", finished = "applied".
      pipeline_status: done ? "applied" : "applying",
    };
    if (part === 1) update.design_direction = direction;
    if (done) {
      // The redesign addresses every present signal in one pass — record that.
      update.change_log = present.map((s) => ({
        signal_id: s.id,
        file: targetPath,
        applied: true,
        applied_by: "redesign",
        reason: null,
      }));
    }
    await admin.from("scans").update(update).eq("id", scanId);

    return json({ ok: true, scan_id: scanId, part, parts, done, file: targetPath, design_direction: direction });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `transform: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
