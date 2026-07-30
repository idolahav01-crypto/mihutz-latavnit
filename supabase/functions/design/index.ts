// Stage 2 — design direction + per-signal proposals.
// Reads the scan's detection + site_profile (from Stage 1) and the filtered
// bundle, runs ONE Claude call (claude-opus-4-8, temp 0.7, signal list / schema
// prompt-cached in the system array), and writes { design_direction, proposals }
// back onto the scans row. proposals are pre-validated so the UI/Stage 4 only
// ever try to apply fixes whose old_code is a verbatim, unique substring.
//
// Secrets required (Supabase -> Edge Functions -> Secrets): ANTHROPIC_API_KEY
// Auto-provided by the platform: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import signals from "../_shared/signals.json" with { type: "json" };
import { cleanApiKey } from "../_shared/anthropic.ts";
import { parseBundle, type Signal } from "../_shared/pipeline.ts";
import { MODEL, runStage2 } from "../_shared/stages.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let scanId: string;
  // Split across sequential passes, like stage 1 — see runStage2's `part` doc.
  let part = 1;
  let parts = 3;
  try {
    const body = await req.json();
    scanId = body.scan_id;
    if (Number.isInteger(body.parts) && body.parts >= 1) parts = body.parts;
    if (Number.isInteger(body.part) && body.part >= 1) part = Math.min(body.part, parts);
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection, site_profile, design_direction, proposals")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }
  if (!scan.detection || !scan.site_profile) {
    return json({ error: "run_detection_first" }, 409);
  }

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage
      .from("scans")
      .download(bundlePath);
    if (dlErr || !file) throw new Error("bundle_not_found");
    const files = parseBundle(await file.text());

    const startedAt = Date.now();
    const result = await runStage2({
      apiKey,
      siteProfile: scan.site_profile,
      detection: scan.detection,
      files,
      signals: signals as Signal[],
      part,
      parts,
      priorDirection: part > 1 ? scan.design_direction : undefined,
    });
    await recordStageUsage(
      admin,
      scanId,
      buildEntry(`design_part${part}`, MODEL, result.usage, Date.now() - startedAt, "high"),
    );

    // Merge this pass's proposals into the earlier ones, keyed by signal_id so
    // a retried pass overwrites instead of duplicating a fix.
    const prior = part === 1 ? [] : ((scan.proposals ?? []) as typeof result.proposals);
    const byId = new Map(prior.map((p) => [p.signal_id, p]));
    for (const p of result.proposals) byId.set(p.signal_id, p);
    const merged = [...byId.values()].sort((a, b) => a.signal_id - b.signal_id);

    const direction = part === 1 ? result.design_direction : scan.design_direction;
    const done = part >= parts;

    await admin
      .from("scans")
      .update({
        design_direction: direction,
        proposals: merged,
        // Only claim "proposed" once every pass has landed; a half-built
        // proposal set must never look ready to apply.
        pipeline_status: done ? "proposed" : null,
      })
      .eq("id", scanId);

    const applicable = merged.filter((p) => p.applicable_edit).length;
    return json({
      ok: true,
      scan_id: scanId,
      part,
      parts,
      done,
      design_direction: direction,
      proposals_count: merged.length,
      applicable_count: applicable,
      usage: result.usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `design: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
