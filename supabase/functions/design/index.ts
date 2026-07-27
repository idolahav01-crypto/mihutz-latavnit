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
import { runStage2 } from "../_shared/stages.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
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
    .select("id, user_id, detection, site_profile")
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

    const result = await runStage2({
      apiKey,
      siteProfile: scan.site_profile,
      detection: scan.detection,
      files,
      signals: signals as Signal[],
    });

    await admin
      .from("scans")
      .update({
        design_direction: result.design_direction,
        proposals: result.proposals,
        pipeline_status: "proposed",
      })
      .eq("id", scanId);

    const applicable = result.proposals.filter((p) => p.applicable_edit).length;
    return json({
      ok: true,
      scan_id: scanId,
      design_direction: result.design_direction,
      proposals_count: result.proposals.length,
      applicable_count: applicable,
      usage: result.usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
