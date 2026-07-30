// Stage 4 — apply approved fixes & self-verify.
// Sends ONLY the touched files + the approved fix set + the design_direction to
// claude-opus-4-8 (temp 0.2, PrecisionEditor prompt cached in the system array).
// The model returns edited files + a per-fix change_log with a 6-point
// self-check. We persist the edited touched files as a bundle in Storage and the
// change_log / approved_fixes on the scans row.
//
// Body: { scan_id, approved_fixes?, reapply_signal_ids? }
//   - approved_fixes: explicit [{signal_id,file,old_code,new_code}] (from the UI
//     approval step). When omitted, we derive them from the stored proposals
//     (recommended, applicable_edit, non-strategic) using sample_new_code.
//   - reapply_signal_ids: on a QA reapply round, restrict to these signals.

import { cleanApiKey } from "../_shared/anthropic.ts";
import {
  type ApprovedFix,
  deriveApprovedFixes,
  detectConflicts,
  filesTouchedByFixes,
  orderFixes,
  parseBundle,
  type ProposalValidation,
  reconcileApply,
  serializeBundle,
} from "../_shared/pipeline.ts";
import { MODEL, runStage4 } from "../_shared/stages.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; approved_fixes?: ApprovedFix[]; reapply_signal_ids?: number[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, proposals, design_direction, pipeline_status")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }
  if (!scan.proposals) return json({ error: "run_design_first" }, 409);

  // Stage 2 runs as several passes and only sets pipeline_status="proposed"
  // once every pass has landed. Applying before that edits the project using a
  // fraction of the proposals while reporting success — which is exactly what
  // happened when a browser held a one-deploy-old copy of the dashboard and
  // called design a single time. The client is not allowed to be the only thing
  // enforcing this. "qa_failed" is the legitimate re-entry point for a QA
  // reapply round.
  const readyToApply = scan.pipeline_status === "proposed" ||
    scan.pipeline_status === "qa_failed";
  if (!readyToApply) {
    return json({
      error: "proposals_incomplete",
      pipeline_status: scan.pipeline_status,
      hint: "stage 2 has not finished all of its passes for this scan",
    }, 409);
  }

  const requested = (body.approved_fixes && body.approved_fixes.length)
    ? body.approved_fixes
    : deriveApprovedFixes(scan.proposals as ProposalValidation[], body.reapply_signal_ids);
  if (!requested.length) return json({ error: "no_applicable_fixes" }, 409);

  // Sort by depends_on BEFORE the call rather than asking the model to do it, so
  // token-level fixes land before the component fixes that reference them.
  const { ordered: fixes, cycles, danglingDeps } = orderFixes(requested);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage
      .from("scans").download(bundlePath);
    if (dlErr || !file) throw new Error("bundle_not_found");
    const original = parseBundle(await file.text());

    // Only the touched files are sent through the model (cost + focus).
    const touchedPaths = filesTouchedByFixes(fixes);
    const touched = new Map<string, string>();
    for (const p of touchedPaths) {
      if (original.has(p)) touched.set(p, original.get(p)!);
    }

    // Overlapping old_code regions cannot both apply. Drop the losers here
    // instead of letting the model invent a merged edit for them.
    const conflicts = detectConflicts(fixes, original);
    const dropped = new Set(conflicts.map((c) => c.loser));
    const sendable = fixes.filter((f) => !dropped.has(f.signal_id));

    await admin.from("scans").update({ pipeline_status: "applying" }).eq("id", scanId);

    const startedAt = Date.now();
    const result = await runStage4({
      apiKey,
      files: touched,
      approvedFixes: sendable,
      designDirection: scan.design_direction,
    });
    await recordStageUsage(
      admin,
      scanId,
      buildEntry("apply", MODEL, result.usage, Date.now() - startedAt, "high"),
    );

    // Verify the model's output against the fixes byte-for-byte and
    // deterministically apply anything it dropped or wrongly claimed as applied.
    const modelMap = new Map<string, string>();
    for (const f of result.files) modelMap.set(f.path, f.content);
    const recon = reconcileApply(
      touched,
      modelMap,
      sendable,
      result.change_log as Array<{ signal_id?: number; applied?: boolean }>,
    );
    const editedMap = recon.files;
    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    const { error: upErr } = await admin.storage
      .from("scans")
      .upload(editedPath, new Blob([serializeBundle(editedMap)], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (upErr) throw new Error(`storage: ${upErr.message}`);

    await admin
      .from("scans")
      .update({
        approved_fixes: fixes,
        change_log: recon.reconciled,
        pipeline_status: "applied",
      })
      .eq("id", scanId);

    const applied = recon.reconciled.filter((r) => r.applied).length;
    return json({
      ok: true,
      scan_id: scanId,
      files_edited: [...editedMap.keys()].filter((p) => editedMap.get(p) !== touched.get(p)).length,
      fixes_applied: applied,
      fixes_total: requested.length,
      // Everything below is what the model got wrong; surfaced so a bad run is
      // visible immediately rather than at the QA stage.
      recovered_by_fallback: recon.reconciled.filter((r) => r.applied_by === "deterministic")
        .map((r) => r.signal_id),
      false_applied_claims: recon.falseClaims,
      conflicts,
      dependency_cycles: cycles,
      dangling_dependencies: danglingDeps,
      change_log: result.change_log,
      reconciled: recon.reconciled,
      usage: result.usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .from("scans")
      .update({ pipeline_status: "proposed", error: `apply: ${message}` })
      .eq("id", scanId);
    return json({ error: message }, 500);
  }
});
