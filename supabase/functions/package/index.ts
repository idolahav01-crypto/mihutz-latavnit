// Stage 6 — packaging.
//
// Everything before this stage produced work the user could not reach: the
// edited files lived only in Storage as edited-bundle.txt, which holds ONLY the
// files stage 4 touched. This function assembles the complete project — every
// original file, with the edited ones overlaid — and hands it back so the client
// can offer it as a ZIP.
//
// It deliberately does not decide anything. The user downloads, reads the diff,
// and judges. Pushing anywhere is a separate, explicitly-confirmed action (see
// push-github/), because a QA verdict of "needs_human" reaching someone's repo
// unasked is exactly the failure this stage exists to prevent.
//
// Body: { scan_id }

import {
  assembleFinalFiles,
  parseBundle,
} from "../_shared/pipeline.ts";
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
    .select("id, user_id, source_ref, change_log, qa_verdict, pipeline_status, ai_fingerprint_score, ai_fingerprint_score_after, design_direction")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }

  try {
    const { data: origFile, error: origErr } = await admin.storage
      .from("scans").download(`${user.id}/${scanId}/bundle.txt`);
    if (origErr || !origFile) throw new Error("bundle_not_found");
    const original = parseBundle(await origFile.text());

    const { data: editedFile } = await admin.storage
      .from("scans").download(`${user.id}/${scanId}/edited-bundle.txt`);
    if (!editedFile) return json({ error: "run_apply_first" }, 409);
    const edited = parseBundle(await editedFile.text());

    // edited-bundle.txt holds only the touched files; overlay them on the
    // originals so the download is a project that actually runs.
    const full = assembleFinalFiles(original, edited);

    const changed: string[] = [];
    for (const [path, content] of full) {
      if (original.get(path) !== content) changed.push(path);
    }

    return json({
      ok: true,
      scan_id: scanId,
      source_ref: scan.source_ref,
      files: [...full.entries()].map(([path, content]) => ({ path, content })),
      // Sent alongside so the ZIP can carry a readable report next to the code,
      // rather than the user having to remember what the run concluded.
      changed_files: changed,
      change_log: scan.change_log ?? [],
      qa_verdict: scan.qa_verdict ?? null,
      pipeline_status: scan.pipeline_status,
      score_before: scan.ai_fingerprint_score,
      score_after: scan.ai_fingerprint_score_after,
      design_direction: scan.design_direction ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
