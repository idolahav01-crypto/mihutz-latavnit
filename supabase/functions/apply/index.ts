// Stage 4 — apply approved fixes DETERMINISTICALLY.
// Stage 2 already produced, per fix, a verbatim old_code and a complete drop-in
// new_code. Applying them is therefore an exact string replacement — no model
// call. That removes the single slowest, most expensive call in the pipeline
// (the one that kept blowing the 150s edge-function limit / stage_timeout) and
// makes this stage effectively instant and free. Fixes are applied in dependency
// order, so token/global fixes land before the component fixes that use them.
// Stage 5 (QA) still independently verifies the result.
//
// Body: { scan_id, approved_fixes?, reapply_signal_ids? }
//   - approved_fixes: explicit [{signal_id,file,old_code,new_code}] (from the UI
//     approval step). When omitted, we derive them from the stored proposals
//     (recommended, applicable_edit, non-strategic) using sample_new_code.
//   - reapply_signal_ids: on a QA reapply round, restrict to these signals.

import {
  type ApprovedFix,
  applyFix,
  assembleFinalFiles,
  deriveApprovedFixes,
  detectConflicts,
  filesTouchedByFixes,
  orderFixes,
  parseBundle,
  type ProposalValidation,
  serializeBundle,
} from "../_shared/pipeline.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: {
    scan_id?: string;
    approved_fixes?: ApprovedFix[];
    reapply_signal_ids?: number[];
    part?: number;
    parts?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);

  // Applied in several client-driven passes — each a SEPARATE HTTP call with its
  // own 150s budget. Batching inside one call cannot help, because the whole
  // invocation shares one 150s wall clock; only more invocations buy more time.
  let parts = 1;
  let part = 1;
  if (Number.isInteger(body.parts) && (body.parts as number) >= 1) parts = body.parts as number;
  if (Number.isInteger(body.part) && (body.part as number) >= 1) part = Math.min(body.part as number, parts);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, proposals, design_direction, pipeline_status, change_log")
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
  // Block apply only before design has finished (status is still a pre-design
  // state). Once proposals exist, allow apply AND re-apply freely — "applied"
  // and "qa_failed" both re-enter cleanly (a fresh apply rebuilds from pristine).
  const readyToApply = scan.pipeline_status === "proposed" ||
    scan.pipeline_status === "qa_failed" ||
    scan.pipeline_status === "applied" ||
    scan.pipeline_status === "applying";
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
    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { data: file, error: dlErr } = await admin.storage
      .from("scans").download(bundlePath);
    if (dlErr || !file) throw new Error("bundle_not_found");
    const pristine = parseBundle(await file.text());

    // A QA reapply round builds on the work so far, not the pristine bundle, so
    // it never discards what earlier rounds already achieved.
    const editedPath = `${user.id}/${scanId}/edited-bundle.txt`;
    const isReapply = Boolean(body.reapply_signal_ids?.length);
    let original = pristine;
    if (isReapply) {
      const { data: prevFile } = await admin.storage.from("scans").download(editedPath);
      if (prevFile) original = assembleFinalFiles(pristine, parseBundle(await prevFile.text()));
    }

    // Overlapping old_code regions can't both apply — drop the losers.
    const conflicts = detectConflicts(fixes, original);
    const dropped = new Set(conflicts.map((c) => c.loser));
    const sendable = fixes.filter((f) => !dropped.has(f.signal_id));

    await admin.from("scans").update({ pipeline_status: "applying" }).eq("id", scanId);

    // Apply every fix DETERMINISTICALLY, in dependency order. No model call — so
    // this stage cannot time out and costs nothing. applyFix does an exact unique
    // replacement (with a whitespace-insensitive fallback) and never approximates;
    // validateProposals already guaranteed each old_code is a verbatim unique
    // substring, so applicable fixes land. Stage 5 (QA) still verifies the output.
    const working = new Map(original);
    const reconciled: Array<
      { signal_id: number; file: string; applied: boolean; applied_by: string; reason: string | null }
    > = [];
    for (const fix of sendable) {
      const before = working.get(fix.file);
      if (before == null) {
        reconciled.push({ signal_id: fix.signal_id, file: fix.file, applied: false, applied_by: "none", reason: "file_missing_from_bundle" });
        continue;
      }
      const res = applyFix(before, fix.old_code, fix.new_code);
      if (res.applied) {
        working.set(fix.file, res.content);
        reconciled.push({ signal_id: fix.signal_id, file: fix.file, applied: true, applied_by: "deterministic", reason: null });
      } else {
        reconciled.push({ signal_id: fix.signal_id, file: fix.file, applied: false, applied_by: "none", reason: res.reason });
      }
    }

    // The edited-bundle holds every file this run touched.
    const editedMap = new Map<string, string>();
    for (const p of filesTouchedByFixes(sendable)) {
      if (working.has(p)) editedMap.set(p, working.get(p)!);
    }
    const { error: upErr } = await admin.storage
      .from("scans")
      .upload(editedPath, new Blob([serializeBundle(editedMap)], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (upErr) throw new Error(`storage: ${upErr.message}`);

    // Merge the change log across reapply rounds.
    const priorLog = isReapply
      ? ((scan.change_log ?? []) as typeof reconciled)
      : [];
    const logById = new Map(priorLog.map((c) => [c.signal_id, c]));
    for (const c of reconciled) logById.set(c.signal_id, c);
    const mergedLog = [...logById.values()].sort((a, b) => a.signal_id - b.signal_id);

    await admin
      .from("scans")
      .update({
        approved_fixes: fixes,
        change_log: mergedLog,
        pipeline_status: "applied",
      })
      .eq("id", scanId);

    const applied = mergedLog.filter((r) => r.applied).length;
    return json({
      ok: true,
      scan_id: scanId,
      done: true,
      files_edited: [...editedMap.keys()].filter((p) => editedMap.get(p) !== pristine.get(p)).length,
      fixes_applied: applied,
      fixes_total: isReapply ? mergedLog.length : requested.length,
      recovered_by_fallback: reconciled.filter((r) => r.applied_by === "deterministic").map((r) => r.signal_id),
      false_applied_claims: [],
      conflicts,
      dependency_cycles: cycles,
      dangling_dependencies: danglingDeps,
      change_log: reconciled,
      reconciled,
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
