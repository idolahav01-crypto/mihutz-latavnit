// Stage 6b — open a pull request with the edited files.
//
// SAFETY POSTURE, and why it is shaped this way:
//
//   - It never writes to the repository's default branch. It creates a new
//     branch off the default branch's head and opens a PR. The user's live site
//     cannot change as a result of this call; merging stays a human decision
//     made in GitHub's own review UI.
//   - It refuses outright when the run is not deliverable, or when the rebuild
//     found a fault it could NOT repair, unless the caller explicitly sets
//     acknowledge_warnings. The first real run ended at pipeline_status
//     "needs_human" with a quality score of 42 and a currency regression that
//     made Hebrew markup worse — pushing that silently is the exact outcome
//     this guard exists to prevent. The adversarial QA stage that used to
//     produce that verdict is gone; the two floors the rebuild runs on its own
//     output — content preservation and design depth — took its place, and
//     they are what is checked here now.
//     A finding the rebuild already REPAIRED does not stop the push: what would
//     be pushed no longer has the fault in it, so the stop would be about a
//     condition that is not in the commit. It is reported, not enforced.
//   - It sends only files whose content actually differs from the original, so
//     the PR diff is reviewable rather than a whole-repo rewrite.
//   - The PR body carries every finding — repaired ones included — so a reviewer
//     sees what the pipeline thought of the work before merging it.
//
// Body: { scan_id, branch?, acknowledge_warnings? }

import { assembleFinalFiles, parseBundle } from "../_shared/pipeline.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";

const GH = "https://api.github.com";

interface GhOpts {
  token: string;
  owner: string;
  repo: string;
}

async function gh(
  opts: GhOpts,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GH}/repos/${opts.owner}/${opts.repo}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      "User-Agent": "mihutz-latavnit",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** base64 for arbitrary UTF-8 (btoa alone throws on non-Latin1 — Hebrew source). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; branch?: string; acknowledge_warnings?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, source_type, source_ref, self_check, pipeline_status, change_log")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }
  if (scan.source_type !== "github") {
    return json({ error: "not_a_github_scan", hint: "download the ZIP instead" }, 409);
  }

  // A run that never reached "applied" has no verified output to push.
  if (scan.pipeline_status !== "applied") {
    return json({
      error: "run_not_deliverable",
      pipeline_status: scan.pipeline_status,
    }, 409);
  }

  const selfCheck = (scan.self_check ?? {}) as {
    warnings?: Array<{ kind: string; detail: string }>;
  };
  const warnings = selfCheck.warnings ?? [];

  // A finding that describes a fault ALREADY REPAIRED is not a reason to stop.
  //
  // content_loss and design_thin describe something wrong with the bytes about
  // to be pushed; there is something to warn a reviewer away from. css_repaired
  // describes a stylesheet that came back truncated and was closed before it
  // shipped — the braces are balanced, the rules below survived, and what goes
  // into the commit is valid CSS. Stopping on it would be warning about a
  // condition that no longer exists in the output.
  //
  // It still travels: it is in the response, in the PR body, and in self_check.
  // Worth a human's eye, not worth a hard stop.
  const REPAIRED_KINDS = new Set(["css_repaired"]);
  const blocking = warnings.filter((w) => !REPAIRED_KINDS.has(w.kind));

  if (blocking.length && !body.acknowledge_warnings) {
    // Deliberately a hard stop rather than a note in the response. The download
    // is never withheld — the user paid for it and can read it — but a pull
    // request writes into someone's repository, so the caller has to say, in
    // the request, that it knows what the run found in its own output.
    return json({
      error: "build_has_warnings",
      pipeline_status: scan.pipeline_status,
      warnings: blocking,
      hint: "re-send with acknowledge_warnings: true to open the PR anyway",
    }, 409);
  }

  const [owner, repo] = String(scan.source_ref).split("/");
  if (!owner || !repo) return json({ error: "bad_source_ref" }, 400);

  try {
    const { data: tok } = await admin
      .from("github_tokens")
      .select("provider_token")
      .eq("user_id", user.id)
      .maybeSingle();
    const token = tok?.provider_token;
    if (!token) return json({ error: "github_not_connected" }, 409);

    const { data: origFile } = await admin.storage
      .from("scans").download(`${user.id}/${scanId}/bundle.txt`);
    const { data: editedFile } = await admin.storage
      .from("scans").download(`${user.id}/${scanId}/edited-bundle.txt`);
    if (!origFile) throw new Error("bundle_not_found");
    if (!editedFile) return json({ error: "run_apply_first" }, 409);

    const original = parseBundle(await origFile.text());
    const full = assembleFinalFiles(original, parseBundle(await editedFile.text()));

    // Only genuinely changed files go in the commit — a PR that rewrites every
    // file is unreviewable, which defeats the point of opening one.
    const changed = [...full.entries()].filter(([p, c]) => original.get(p) !== c);
    // A file the pipeline dropped is absent from `full`. Absent is not enough
    // here: the tree is built on base_tree, so a path we simply omit survives
    // untouched. Deleting it takes an explicit tombstone entry.
    const removed = [...original.keys()].filter((p) => !full.has(p));
    if (!changed.length && !removed.length) return json({ error: "no_changes_to_push" }, 409);

    const o: GhOpts = { token, owner, repo };
    const repoInfo = await gh(o, "");
    const baseBranch = String(repoInfo.default_branch ?? "main");
    const baseRef = await gh(o, `/git/ref/heads/${baseBranch}`) as {
      object: { sha: string };
    };
    const baseSha = baseRef.object.sha;
    const baseCommit = await gh(o, `/git/commits/${baseSha}`) as {
      tree: { sha: string };
    };

    const branch = (body.branch ?? `mihutz-latavnit/scan-${scanId.slice(0, 8)}`)
      .replace(/[^A-Za-z0-9._\/-]/g, "-");
    if (branch === baseBranch) return json({ error: "refuses_to_target_default_branch" }, 400);

    await gh(o, "/git/refs", {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });

    const tree = [];
    for (const [path, content] of changed) {
      const blob = await gh(o, "/git/blobs", {
        method: "POST",
        body: { content: toBase64(content), encoding: "base64" },
      }) as { sha: string };
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    // sha: null is git's way of saying "this path is gone".
    for (const path of removed) {
      tree.push({ path, mode: "100644", type: "blob", sha: null });
    }

    const newTree = await gh(o, "/git/trees", {
      method: "POST",
      body: { base_tree: baseCommit.tree.sha, tree },
    }) as { sha: string };

    const commit = await gh(o, "/git/commits", {
      method: "POST",
      body: {
        message: `Remove AI-template fingerprints (${changed.length} changed` +
          `${removed.length ? `, ${removed.length} removed` : ""})\n\n` +
          `Generated by מחוץ לתבנית, scan ${scanId}.`,
        tree: newTree.sha,
        parents: [baseSha],
      },
    }) as { sha: string };

    await gh(o, `/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: { sha: commit.sha },
    });

    const applied = ((scan.change_log ?? []) as Array<{ applied?: boolean }>)
      .filter((c) => c.applied).length;
    const prBody = [
      `Automated de-templating pass from **מחוץ לתבנית**.`,
      ``,
      `- Fixes applied: **${applied}**`,
      `- Files changed: **${changed.length}**`,
      `- Findings on our own output: **${warnings.length ? warnings.length : "none"}**`,
      ``,
      ...(warnings.length
        ? [
          `> The rebuild's own checks flagged this result:`,
          ...warnings.map((w) => `> - ${w.kind}: ${w.detail}`),
          `>`,
          `> It is opened as a PR precisely so a human decides. Read the diff carefully.`,
        ]
        : [`Review the diff before merging.`]),
    ].join("\n");

    const pr = await gh(o, "/pulls", {
      method: "POST",
      body: {
        title: `Remove AI-template fingerprints (${applied} fixes)`,
        head: branch,
        base: baseBranch,
        body: prBody,
      },
    }) as { html_url: string; number: number };

    return json({
      ok: true,
      scan_id: scanId,
      branch,
      base_branch: baseBranch,
      files_changed: changed.length,
      pull_request_url: pr.html_url,
      pull_request_number: pr.number,
      warnings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
