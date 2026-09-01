// Stage F — FeatureDesigner: propose ONE content-fit feature, then build it.
//
// Two user-gated calls, each with its own 150s budget:
//   action "propose" — propose ONE new feature that fits this site's content;
//                      stored to features.json (no code yet, small + fast).
//                      Touches nothing in the site — the user has not said yes.
//   action "build"   — implement that one feature (self-contained html/css/js
//                      matching the site's design) and inject it into the page.
//
// Proposing and building are separate so the user sees what is coming before it
// lands in their site, and can ask for a different idea instead.
//
// The feature is ADDED to the primary HTML file, building on the redesigned
// bundle if one exists. Existing <script> blocks are extracted and restored
// byte-for-byte; the feature's own JS is appended as a new <script>.
//
// Body: { scan_id, action, exclude? } — exclude carries already-rejected names.

import { parseBundle, pickHomePageSmart, serializeBundle } from "../_shared/pipeline.ts";
import { cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { assertModelPriced, meteredClaude } from "../_shared/usage.ts";

const MODEL = "claude-opus-4-8";
// Fail on the first invoke, not after a paid call recorded $0.00.
assertModelPriced(MODEL);

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
  `You are FeatureDesigner. Given a website's content and profile, propose EXACTLY ONE NEW feature that genuinely fits THIS site's content and audience and would delight its users — a feature it does NOT already have.

This is your single best idea for this site, and the user sees it before deciding whether to build it. Make it the one you would argue for.

Be specific and content-aware, not generic. (For a football fan site, good ideas are things like: a live next-match countdown, a head-to-head player comparison, a fan prediction poll that saves results, a trivia streak leaderboard, a fixtures filter — NOT "a newsletter signup" or "a contact form".) It must be implementable in plain client-side HTML/CSS/JS with no backend, no external API keys, and no invented facts.

If an <already_rejected> block is present, the user has turned those ideas down. Do not propose them again, and do not propose a reskin of the same idea under another name — go somewhere genuinely different.

Return: name, and a one-line summary of what it does and why it fits this site.

Return ONLY valid JSON: { "feature": { "name": "...", "summary": "..." } }. No prose.`;

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
    feature: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, summary: { type: "string" } },
      required: ["name", "summary"],
    },
  },
  required: ["feature"],
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

  let body: { scan_id?: string; action?: string; exclude?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);
  // No default: a client still speaking the old part-number protocol must fail
  // loudly here rather than half-run something the user never approved.
  const action = body.action;
  if (action !== "propose" && action !== "build") {
    return json({ error: "action must be 'propose' or 'build'" }, 400);
  }
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.filter((n) => typeof n === "string" && n.trim()).slice(0, 10)
    : [];

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
    const targetPath = pickHomePageSmart(pristine);
    if (!targetPath) return json({ error: "no_html_file" }, 409);

    let edited = new Map<string, string>();
    {
      const { data: prev } = await admin.storage.from("scans").download(editedPath);
      if (prev) edited = parseBundle(await prev.text());
    }
    const current = edited.get(targetPath) ?? pristine.get(targetPath) ?? "";
    const { stripped, scripts } = extractScripts(current);

    const startedAt = Date.now();

    if (action === "propose") {
      // Propose one feature. Nothing is written to the bundle — the user has
      // not approved anything yet.
      const rejected = exclude.length
        ? `<already_rejected>\n${exclude.map((n) => `- ${n}`).join("\n")}\n</already_rejected>\n\n`
        : "";
      const userContent =
        `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
        rejected +
        `<site_html>\n${stripped}\n</site_html>\n\n` +
        `Propose exactly one new feature that fits this site.`;
      const res = await meteredClaude({ admin, scanId, startedAt, stage: "features_plan" }, {
        apiKey, model: MODEL, effort: "high", maxTokens: 1500, stream: false,
        system: PLAN_SYSTEM, schema: PLAN_SCHEMA, userContent, timeoutMs: 120_000,
      });

      const out = (res.json ?? {}) as { feature?: { name?: string; summary?: string } };
      const feature = out.feature;
      if (!feature || !feature.name) throw new Error("empty_feature_plan");

      await admin.storage.from("scans").upload(
        planPath,
        new Blob([JSON.stringify(feature)], { type: "application/json" }),
        { upsert: true, contentType: "application/json" },
      );
      return json({ ok: true, scan_id: scanId, action, feature });
    }

    // action === "build" — implement the proposal the user approved.
    const { data: planFile } = await admin.storage.from("scans").download(planPath);
    if (!planFile) throw new Error("feature_plan_missing");
    const feat = JSON.parse(await planFile.text()) as { name: string; summary: string };
    if (!feat || !feat.name) throw new Error("feature_plan_missing");

    const userContent =
      `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
      `<feature_to_build>\nname: ${feat.name}\nsummary: ${feat.summary}\n</feature_to_build>\n\n` +
      `<site_html>\n${stripped}\n</site_html>\n\n` +
      `Implement ONLY this feature as html/css/js that matches the site's design.`;
    const res = await meteredClaude({ admin, scanId, startedAt, stage: "features_impl" }, {
      apiKey, model: MODEL, effort: "high", maxTokens: 12000, stream: false,
      system: IMPL_SYSTEM, schema: IMPL_SCHEMA, userContent, timeoutMs: 120_000,
    });

    const impl = (res.json ?? {}) as { html?: string; css?: string; js?: string };
    const injected = injectFeature(stripped, impl);
    edited.set(targetPath, restoreScripts(injected, scripts));

    const up = await admin.storage.from("scans").upload(
      editedPath,
      new Blob([serializeBundle(edited)], { type: "text/plain" }),
      { upsert: true, contentType: "text/plain" },
    );
    if (up.error) throw new Error(`storage: ${up.error.message}`);

    // Keep the scan deliverable (download/PR available).
    await admin.from("scans").update({ pipeline_status: "applied" }).eq("id", scanId);

    return json({ ok: true, scan_id: scanId, action, done: true, feature: feat });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `features: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
