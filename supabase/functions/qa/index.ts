// Stage 5 — adversarial QA with a CLEAN context.
// Rebuilds the full edited project (original bundle overlaid with the edited
// touched files), diffs it against the original, and sends ONLY the diffs + the
// targeted signal list + the approved design_direction to claude-opus-4-8
// (temp 0, AdversarialQA prompt cached). No Stage 1/2 rationale is forwarded —
// that independence is the whole point of the stage.
//
// The reapply loop (qa_failed -> Stage 4 -> QA, up to 2 rounds, then
// needs_human) is driven by the client orchestrator; this function just records
// the verdict and advances pipeline_status / qa_rounds.

import signals from "../_shared/signals.json" with { type: "json" };
import { cleanApiKey } from "../_shared/anthropic.ts";
import {
  type ApprovedFix,
  assembleFinalFiles,
  parseBundle,
  type Signal,
} from "../_shared/pipeline.ts";
import { MODEL, runStage5 } from "../_shared/stages.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

const MAX_ROUNDS = 2;

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
    .select("id, user_id, approved_fixes, design_direction, qa_rounds")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }
  if (!scan.approved_fixes) return json({ error: "run_apply_first" }, 409);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));

    const base = `${user.id}/${scanId}`;
    const [origFile, editFile] = await Promise.all([
      admin.storage.from("scans").download(`${base}/bundle.txt`),
      admin.storage.from("scans").download(`${base}/edited-bundle.txt`),
    ]);
    if (origFile.error || !origFile.data) throw new Error("bundle_not_found");
    if (editFile.error || !editFile.data) throw new Error("edited_bundle_not_found");

    const original = parseBundle(await origFile.data.text());
    const editedTouched = parseBundle(await editFile.data.text());
    const edited = assembleFinalFiles(original, editedTouched);

    // Targeted signals = the ones the approved fixes were meant to resolve.
    const fixes = scan.approved_fixes as ApprovedFix[];
    const targetIds = new Set(fixes.map((f) => f.signal_id));
    const targetedSignals = (signals as Signal[]).filter((s) => targetIds.has(s.id));

    await admin.from("scans").update({ pipeline_status: "qa" }).eq("id", scanId);

    const startedAt = Date.now();
    const { verdict, usage } = await runStage5({
      apiKey,
      original,
      edited,
      targetedSignals,
      designDirection: scan.design_direction,
    });
    await recordStageUsage(
      admin,
      scanId,
      buildEntry("qa", MODEL, usage, Date.now() - startedAt, "high"),
    );

    const rounds = (scan.qa_rounds ?? 0) + 1;
    const pass = verdict.pass === true;
    const status = pass ? "qa_passed" : (rounds >= MAX_ROUNDS ? "needs_human" : "qa_failed");

    await admin
      .from("scans")
      .update({ qa_verdict: verdict, qa_rounds: rounds, pipeline_status: status })
      .eq("id", scanId);

    return json({
      ok: true,
      scan_id: scanId,
      pass,
      pipeline_status: status,
      qa_rounds: rounds,
      can_reapply: !pass && rounds < MAX_ROUNDS,
      verdict,
      usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Persist it: a stage that fails silently costs a real API call to
    // diagnose, and the previous QA failure left nothing behind to read.
    await admin
      .from("scans")
      .update({ pipeline_status: "applied", error: `qa: ${message}` })
      .eq("id", scanId);
    return json({ error: message }, 500);
  }
});
