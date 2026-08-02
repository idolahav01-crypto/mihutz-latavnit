// Stage T — TransformDesigner: CSS-first whole-site redesign.
//
// The model returns ONLY a new stylesheet (+ the font <link>s to load) — never
// the HTML or JS. That is the key to reliability: CSS is where the whole visual
// identity lives (color, type, spacing, layout via grid/flex), so a new
// stylesheet can make the site look completely different — while the output stays
// small enough to finish well inside the 150s limit, and the HTML structure and
// all JavaScript are preserved byte-for-byte (the safest possible edit).
//
// Client-driven: one file per call. The design direction is decided on the first
// file and reused for the rest so a multi-file site stays coherent.
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

// Pull every <script>…</script> out of an HTML file and leave a placeholder so
// the model never sees or regenerates JS: output stays small and the JavaScript
// is preserved byte-for-byte.
function extractScripts(html: string): { stripped: string; scripts: string[] } {
  const scripts: string[] = [];
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    const token = `<!--__MIHUTZ_SCRIPT_${scripts.length}__-->`;
    scripts.push(m);
    return token;
  });
  return { stripped, scripts };
}

function restoreScripts(html: string, scripts: string[]): string {
  let out = html;
  const used = new Set<number>();
  scripts.forEach((s, i) => {
    const token = `<!--__MIHUTZ_SCRIPT_${i}__-->`;
    if (out.indexOf(token) !== -1) {
      out = out.replace(token, () => s);
      used.add(i);
    }
  });
  const missing = scripts.filter((_, i) => !used.has(i));
  if (missing.length) {
    const inject = "\n" + missing.join("\n") + "\n";
    out = out.indexOf("</body>") !== -1 ? out.replace("</body>", inject + "</body>") : out + inject;
  }
  return out;
}

// Swap the site's stylesheet for the redesigned one and load the new fonts,
// leaving all other markup untouched.
function applyNewStyles(html: string, css: string, headExtras: string): string {
  const styleTag = `<style>\n${css}\n</style>`;
  let replaced = false;
  let out = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, () => {
    if (!replaced) {
      replaced = true;
      return styleTag; // first existing <style> becomes the new stylesheet
    }
    return ""; // drop any other old <style> blocks
  });
  if (!replaced) {
    out = out.indexOf("</head>") !== -1
      ? out.replace("</head>", styleTag + "\n</head>")
      : styleTag + out;
  }
  if (headExtras && headExtras.trim()) {
    out = out.indexOf("</head>") !== -1
      ? out.replace("</head>", headExtras + "\n</head>")
      : headExtras + out;
  }
  return out;
}

const SYSTEM =
  `You are TransformDesigner, a world-class brand & web designer. You are given a website's HTML (its structure, classes, ids and current CSS) plus a profile of the site and a list of "AI fingerprint" signals to eliminate. You return a COMPLETE NEW STYLESHEET (and the font links to load) that redesigns the site to look like a top studio built it — visibly different, premium, and coherent.

You return ONLY CSS — never HTML, never JavaScript. The HTML structure stays exactly as it is; your new stylesheet targets the SAME selectors (classes, ids, tags) that already exist in the markup, and restyles them completely.

THIS IS A FULL REDESIGN, NOT A TWEAK. Change boldly: a real brand color system, a real type system with fonts that you actually load, a modern type scale, generous spacing rhythm, redesigned buttons/cards/nav/hero, backgrounds, borders, shadows. Use CSS layout aggressively to change the composition — flexbox/grid, gap, order, alignment, asymmetry, decorative ::before/::after — so the page reads as a different, better-composed site even though the DOM is unchanged. A result that looks like the original is a FAILURE.

<process>
1. Commit to ONE design direction for THIS business (from the profile): one strong brand color + neutrals, a heading+body type pairing, one layout principle, 3 personality adjectives. Emit it as design_direction. If an <approved_design_direction> is given, reuse it verbatim.
2. Write a complete stylesheet that implements that direction across every relevant selector in the provided HTML, resolving every listed signal.
</process>

<rules>
- Return ONLY: design_direction, stylesheet (the full CSS, no <style> wrapper), head_extras (the <link rel="stylesheet" href="https://fonts.googleapis.com/..."> tags for the fonts you use — every font MUST be loaded).
- Target the real selectors from the HTML. Do not invent class names the markup doesn't have. It is fine (and good) to also style semantic tags (body, header, h1..h3, section, a, button, ul, footer).
- Do NOT rely on fonts being present — always load them via head_extras.
- Resolve the AI-fingerprint signals through CSS: no Inter-default, no purple gradient, no generic symmetric card rows — replace them with a coherent, branded look. Avoid the "dark + gold premium" cliché and Playfair-as-elegance unless the profile truly calls for it.
- RTL: if the content is Hebrew/RTL, use logical properties (margin-inline, text-align: start), right-aligned hero, and fonts with true Hebrew support (Heebo, Assistant, Rubik, Frank Ruhl Libre, Noto Sans Hebrew), Hebrew body weight >= 500 and headings >= 700.
</rules>

Return ONLY valid JSON: { "design_direction": {...}, "stylesheet": "<full CSS>", "head_extras": "<font link tags>" }. No prose.`;

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
    stylesheet: { type: "string" },
    head_extras: { type: "string" },
  },
  required: ["stylesheet"],
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
    const isHtml = /\.html?$/i.test(targetPath);
    // For HTML, strip scripts (kept verbatim) so the model reads only markup+CSS.
    const extracted = isHtml
      ? extractScripts(targetContent)
      : { stripped: targetContent, scripts: [] as string[] };

    const present = presentSignals(scan.detection as { signals?: DetectedSignal[] });
    const checklist = present.map((s) => `#${s.id} ${s.name}`).join("\n");

    const priorDirection = part > 1 ? scan.design_direction : null;
    const label = isHtml ? "html" : "css";
    const userContent =
      (priorDirection
        ? `<approved_design_direction>\n${JSON.stringify(priorDirection, null, 2)}\n</approved_design_direction>\n` +
          `Reuse this EXACT direction; return it unchanged as design_direction.\n\n`
        : "") +
      `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
      `<signals_to_resolve>\n${checklist}\n</signals_to_resolve>\n\n` +
      (isHtml
        ? `The HTML below is for CONTEXT ONLY (its selectors and current CSS). Return a new stylesheet that restyles it. <!--__MIHUTZ_SCRIPT_N__--> comments are removed <script> blocks — ignore them.\n`
        : `Rewrite this stylesheet completely. Put any @import font rules at the very top of the stylesheet (there is no HTML head here).\n`) +
      `\n<${label} path="${targetPath}">\n${extracted.stripped}\n</${label}>`;

    const startedAt = Date.now();
    const res = await callClaude({
      apiKey,
      model: MODEL,
      effort: "high", // output is only CSS now, so high effort fits comfortably
      maxTokens: 16000,
      stream: true,
      system: SYSTEM,
      schema: SCHEMA,
      userContent,
      timeoutMs: 135_000,
    });
    await recordStageUsage(
      admin,
      scanId,
      buildEntry(`transform_part${part}`, MODEL, res.usage, Date.now() - startedAt, "high"),
    );

    const out = (res.json ?? {}) as {
      design_direction?: unknown;
      stylesheet?: string;
      head_extras?: string;
    };
    const css = out.stylesheet;
    if (!css || typeof css !== "string") throw new Error("empty_transform_output");

    const finalContent = isHtml
      ? restoreScripts(applyNewStyles(extracted.stripped, css, out.head_extras ?? ""), extracted.scripts)
      : css;

    const direction = part === 1
      ? (out.design_direction ?? scan.design_direction ?? null)
      : scan.design_direction;

    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    let edited = new Map<string, string>();
    if (part > 1) {
      const { data: prev } = await admin.storage.from("scans").download(editedPath);
      if (prev) edited = parseBundle(await prev.text());
    }
    edited.set(targetPath, finalContent);
    const up = await admin.storage
      .from("scans")
      .upload(editedPath, new Blob([serializeBundle(edited)], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (up.error) throw new Error(`storage: ${up.error.message}`);

    const done = part >= parts;
    const update: Record<string, unknown> = {
      pipeline_status: done ? "applied" : "applying",
    };
    if (part === 1) update.design_direction = direction;
    if (done) {
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
