// Stage F — FeatureDesigner: propose 5 content-fit features and add them.
//
// Client-driven, one call per part (each a separate 150s budget):
//   part 1        — propose EXACTLY 5 new features that fit this site's content;
//                   stored to features.json (no code yet, small + fast output).
//   parts 2..6    — implement ONE feature each (self-contained html/css/js that
//                   matches the site's design) and inject it into the page.
//
// Features are ADDED to the primary HTML file, building on the redesigned bundle
// if one exists. Existing <script> blocks are extracted and restored byte-for-
// byte; each feature's own JS is appended as a new <script>.
//
// Body: { scan_id, part? } — response returns parts (6) and done.

import { parseBundle, serializeBundle } from "../_shared/pipeline.ts";
import { callClaude, cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

const MODEL = "claude-opus-4-8";
const FEATURE_COUNT = 5;
const PARTS = FEATURE_COUNT + 1; // 1 plan + 5 implementations

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
  scripts.forEach((s, i) => {
    const token = `<!--__MIHUTZ_SCRIPT_${i}__-->`;
    if (out.indexOf(token) !== -1) out = out.replace(token, () => s);
  });
  return out;
}

// Inject one feature's markup/styles/behavior into the page, additively.
function injectFeature(
  html: string,
  feat: { html?: string; css?: string; js?: string },
): string {
  let out = html;
  if (feat.css && feat.css.trim()) {
    const css = feat.css;
    if (/<\/style>/i.test(out)) out = out.replace(/<\/style>/i, () => "\n" + css + "\n</style>");
    else if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, () => "<style>\n" + css + "\n</style>\n</head>");
    else out = "<style>\n" + css + "\n</style>\n" + out;
  }
  if (feat.html && feat.html.trim()) {
    const block = "\n" + feat.html + "\n";
    if (/<footer\b/i.test(out)) out = out.replace(/<footer\b/i, () => block + "<footer");
    else if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => block + "</body>");
    else out = out + block;
  }
  if (feat.js && feat.js.trim()) {
    const s = "\n<script>\n" + feat.js + "\n</script>\n";
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => s + "</body>");
    else out = out + s;
  }
  return out;
}

const PLAN_SYSTEM =
  `You are FeatureDesigner. Given a website's content and profile, propose EXACTLY 5 NEW features that genuinely fit THIS site's content and audience and would delight its users — features it does NOT already have.

Be specific and content-aware, not generic. (For a football fan site, good ideas are things like: a live next-match countdown, a head-to-head player comparison, a fan prediction poll that saves results, a trivia streak leaderboard, a fixtures filter — NOT "a newsletter signup" or "a contact form".) Each feature must be implementable in plain client-side HTML/CSS/JS with no backend, no external API keys, and no invented facts.

For each feature return: name, and a one-line summary of what it does and why it fits this site.

Return ONLY valid JSON: { "features": [ { "name": "...", "summary": "..." } x5 ] }. No prose.`;

const IMPL_SYSTEM =
  `You are FeatureDesigner, implementing ONE feature for an existing website. You are given the site's HTML for design context (its classes, design tokens, and style — <script> blocks are shown as placeholders) and the feature to build.

Return a self-contained implementation of just this one feature: html (the markup block to add), css (its styles), js (its behavior). Requirements:
- It MUST look hand-crafted and match the site's existing design system — reuse its colors, spacing, type and component styles. NEVER introduce a generic AI look (no purple gradients, no "Get Started", no default Inter, no symmetric three-card row).
- ABSOLUTELY NO EMOJI anywhere in the feature — not as icons, not in headings, buttons, or labels. Emoji are the #1 AI fingerprint. Use a real inline SVG icon or none.
- Plain client-side HTML/CSS/JS only. No external libraries, no API keys, no network calls to third parties.
- Genuinely functional and interactive. Use localStorage where persistence helps. Never invent facts — use the site's real data, or interactive inputs the user fills.
- Keep selectors unique to this feature (prefix classes/ids) so it can't collide with the page.
- RTL: if the site is Hebrew, keep it RTL-correct (logical properties, right alignment).

Return ONLY valid JSON: { "html": "...", "css": "...", "js": "..." }. No prose.`;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, summary: { type: "string" } },
        required: ["name", "summary"],
      },
    },
  },
  required: ["features"],
};

const IMPL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    html: { type: "string" },
    css: { type: "string" },
    js: { type: "string" },
  },
  required: ["html", "css", "js"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; part?: number; feature_index?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);
  let part = Number.isInteger(body.part) && (body.part as number) >= 1 ? (body.part as number) : 1;
  if (part > PARTS) part = PARTS;
  // The client now proposes first, lets the user pick, then asks to implement
  // specific features by index. feature_index (0-based) implements exactly that
  // feature; when absent we fall back to the old sequential part-based order.
  const wantImpl = Number.isInteger(body.feature_index) && (body.feature_index as number) >= 0;

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, site_profile")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) return json({ error: "scan not found" }, 404);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    const planPath = `${user.id}/${scanId}/features.json`;

    const { data: file, error: dlErr } = await admin.storage.from("scans").download(bundlePath);
    if (dlErr || !file) throw new Error("bundle_not_found");
    const pristine = parseBundle(await file.text());

    // Features go into the primary HTML file, built on the redesigned bundle if
    // one exists.
    const htmlFiles = [...pristine.keys()].filter((p) => /\.html?$/i.test(p)).sort();
    if (!htmlFiles.length) return json({ error: "no_html_file" }, 409);
    const targetPath = htmlFiles[0];

    let edited = new Map<string, string>();
    {
      const { data: prev } = await admin.storage.from("scans").download(editedPath);
      if (prev) edited = parseBundle(await prev.text());
    }
    const current = edited.get(targetPath) ?? pristine.get(targetPath) ?? "";
    const { stripped, scripts } = extractScripts(current);

    const startedAt = Date.now();

    if (part === 1 && !wantImpl) {
      // Propose the 5 features (no code yet).
      const userContent =
        `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
        `<site_html>\n${stripped}\n</site_html>\n\n` +
        `Propose exactly 5 new features that fit this site.`;
      const res = await callClaude({
        apiKey, model: MODEL, effort: "high", maxTokens: 4000, stream: false,
        system: PLAN_SYSTEM, schema: PLAN_SCHEMA, userContent, timeoutMs: 120_000,
      });
      await recordStageUsage(admin, scanId, buildEntry("features_plan", MODEL, res.usage, Date.now() - startedAt, "high"));

      const out = (res.json ?? {}) as { features?: Array<{ name?: string; summary?: string }> };
      const features = (out.features ?? []).slice(0, FEATURE_COUNT);
      if (!features.length) throw new Error("empty_feature_plan");

      await admin.storage.from("scans").upload(
        planPath,
        new Blob([JSON.stringify(features)], { type: "application/json" }),
        { upsert: true, contentType: "application/json" },
      );
      return json({ ok: true, scan_id: scanId, part, parts: PARTS, done: false, features });
    }

    // Implement ONE feature — the one the user picked (feature_index), or the
    // sequential fallback (part-2).
    const { data: planFile } = await admin.storage.from("scans").download(planPath);
    if (!planFile) throw new Error("feature_plan_missing");
    const features = JSON.parse(await planFile.text()) as Array<{ name: string; summary: string }>;
    const idx = wantImpl ? (body.feature_index as number) : part - 2;
    const feat = features[idx];
    if (!feat) return json({ error: "feature_index_out_of_range", index: idx, count: features.length }, 409);

    const userContent =
      `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
      `<feature_to_build>\nname: ${feat.name}\nsummary: ${feat.summary}\n</feature_to_build>\n\n` +
      `<site_html>\n${stripped}\n</site_html>\n\n` +
      `Implement ONLY this feature as html/css/js that matches the site's design.`;
    const res = await callClaude({
      apiKey, model: MODEL, effort: "high", maxTokens: 12000, stream: false,
      system: IMPL_SYSTEM, schema: IMPL_SCHEMA, userContent, timeoutMs: 120_000,
    });
    await recordStageUsage(admin, scanId, buildEntry(`features_impl_${idx + 1}`, MODEL, res.usage, Date.now() - startedAt, "high"));

    const impl = (res.json ?? {}) as { html?: string; css?: string; js?: string };
    const injected = injectFeature(stripped, impl);
    edited.set(targetPath, restoreScripts(injected, scripts));

    const up = await admin.storage.from("scans").upload(
      editedPath,
      new Blob([serializeBundle(edited)], { type: "text/plain" }),
      { upsert: true, contentType: "text/plain" },
    );
    if (up.error) throw new Error(`storage: ${up.error.message}`);

    // Each call fully implements ONE feature; the client drives the loop over
    // the features the user selected, so this call is "done" on its own.
    await admin.from("scans").update({ pipeline_status: "applied" }).eq("id", scanId);

    return json({ ok: true, scan_id: scanId, index: idx, done: true, feature: feat, features });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `features: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
