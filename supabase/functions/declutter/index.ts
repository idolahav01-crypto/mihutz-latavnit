// Stage D — Declutter review. Looks over the site and SUGGESTS what is
// unnecessary and worth removing. It never deletes anything — the output is
// advice only, applied later solely with the user's approval. Recommending
// "remove nothing, it's already lean" is a valid, expected answer.
//
// Body: { scan_id } — returns { removals: [{ what, why }] } (empty = nothing to cut).

import { parseBundle } from "../_shared/pipeline.ts";
import { callClaude, cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

const MODEL = "claude-opus-4-8";

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<!--script-->");
}

const SYSTEM =
  `You are a senior editor and designer reviewing ONE website for CLUTTER — things that add no value and would make the site cleaner, more focused and more premium if removed.

You only ADVISE. Nothing is deleted as a result of your answer; the user decides. Recommending that NOTHING be removed ("the site is already lean") is a perfectly valid and common answer — do not invent problems to seem useful.

Flag only genuinely unnecessary things, e.g.: filler/empty sections, duplicate or competing CTAs, fake or generic testimonials/trust badges, meaningless or unsupported stats, redundant navigation, dead or placeholder links, repeated boilerplate, decorative elements that add noise. Do NOT propose removing real content, facts, functionality, the logo, or anything users rely on.

For each item: "what" — name the specific element/section and quote a short verbatim identifier from the code so it's unambiguous; "why" — one line on why it's clutter.

Return ONLY valid JSON: { "removals": [ { "what": "...", "why": "..." } ] }. Empty array if there is nothing worth removing.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    removals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { what: { type: "string" }, why: { type: "string" } },
        required: ["what", "why"],
      },
    },
  },
  required: ["removals"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, site_profile")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) return json({ error: "scan not found" }, 404);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    // Review the current (redesigned) site if there is one, else the original.
    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    let text = "";
    const { data: editedFile } = await admin.storage.from("scans").download(editedPath);
    if (editedFile) {
      text = await editedFile.text();
    } else {
      const { data: file, error: dlErr } = await admin.storage.from("scans").download(bundlePath);
      if (dlErr || !file) throw new Error("bundle_not_found");
      text = await file.text();
    }
    const files = parseBundle(text);
    const html = [...files.entries()].filter(([p]) => /\.html?$/i.test(p)).map(([p, c]) => `=== ${p} ===\n${stripScripts(c)}`).join("\n\n");
    const review = html || text;

    const userContent =
      `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
      `<site>\n${review}\n</site>\n\n` +
      `Review the site above and list what is worth removing (or an empty array).`;

    const startedAt = Date.now();
    const res = await callClaude({
      apiKey, model: MODEL, effort: "high", maxTokens: 6000, stream: false,
      system: SYSTEM, schema: SCHEMA, userContent, timeoutMs: 120_000,
    });
    await recordStageUsage(admin, scanId, buildEntry("declutter", MODEL, res.usage, Date.now() - startedAt, "high"));

    const out = (res.json ?? {}) as { removals?: Array<{ what?: string; why?: string }> };
    return json({ ok: true, scan_id: scanId, removals: out.removals ?? [] });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
