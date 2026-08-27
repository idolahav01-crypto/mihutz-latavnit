// Stage 0 for GitHub inputs (URL tab + OAuth tab).
// Pulls a repo tarball server-side, filters vendored/binary/oversized files,
// builds a single "=== FILE: path ===" bundle, and writes it to Storage at
// {user_id}/{scan_id}/bundle.txt so `detect` can read it uniformly.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { UntarStream } from "jsr:@std/tar@0.1/untar-stream";
import { isSiteCode, keepPath, safeRelPath } from "../_shared/pipeline.ts";
import { orderForBundle } from "../_shared/frontend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SERVER_GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";

const MAX_BUNDLE_BYTES = 300_000; // cap code sent to detect (context + cost)
const MAX_FILE_BYTES = 60_000; // skip single huge files
// How much we are willing to hold before choosing what fits in the cap above.
const MAX_READ_BYTES = 3 * MAX_BUNDLE_BYTES;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const authHeader = req.headers.get("Authorization") ?? "";
  const { data: userData } = await admin.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  const user = userData?.user;
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; owner?: string; repo?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const { scan_id: scanId, owner, repo, ref } = body;
  if (!scanId || !owner || !repo) {
    return json({ error: "scan_id, owner, repo required" }, 400);
  }

  const { data: scan } = await admin
    .from("scans")
    .select("id, user_id")
    .eq("id", scanId)
    .single();
  if (!scan || scan.user_id !== user.id) {
    return json({ error: "scan not found" }, 404);
  }

  // Prefer the user's OAuth token (needed for private repos); fall back to a
  // server token for public repos to dodge the 60/hr unauthenticated limit.
  const { data: tok } = await admin
    .from("github_tokens")
    .select("provider_token")
    .eq("user_id", user.id)
    .single();
  const ghToken = tok?.provider_token || SERVER_GITHUB_TOKEN;

  await admin.from("scans").update({ status: "ingesting" }).eq("id", scanId);

  try {
    const refPart = ref ? `/${ref}` : "";
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/tarball${refPart}`,
      {
        headers: {
          ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (res.status === 404) throw new Error("repo_not_found_or_no_access");
    if (!res.ok || !res.body) throw new Error(`github ${res.status}`);

    const entries = res.body
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new UntarStream());

    // Read wider than the cap, then choose. The cap is filled in iteration
    // order, and tar order is the repo's directory order — so on a project
    // with a backend, api/ and routes/ can fill 300KB before the tar reaches
    // the page the audit exists to read. Collecting first costs a bounded
    // amount of memory and lets the website go in ahead of the plumbing.
    const collected: Array<[string, string]> = [];
    let read = 0;
    const decoder = new TextDecoder();

    for await (const entry of entries) {
      // Tar paths are prefixed with "<owner>-<repo>-<sha>/"; strip it, then
      // sanitise — a tar can name any path it likes, and this one ends up as a
      // path in the ZIP the user unpacks and in the pull request we open.
      const rel = safeRelPath(entry.path.replace(/^[^/]+\//, ""));
      if (!entry.readable) continue;
      if (!rel || entry.path.endsWith("/") || !keepPath(rel)) {
        await entry.readable.cancel();
        continue;
      }
      if (read >= MAX_READ_BYTES) {
        await entry.readable.cancel();
        continue;
      }
      const buf = new Uint8Array(
        await new Response(entry.readable).arrayBuffer(),
      );
      if (buf.byteLength > MAX_FILE_BYTES) continue;
      read += buf.byteLength;
      collected.push([rel, decoder.decode(buf)]);
    }

    const byPath = new Map(collected);
    const parts: string[] = [];
    let total = 0;
    let fileCount = 0;
    let siteFiles = 0;
    for (const rel of orderForBundle([...byPath.keys()])) {
      if (total >= MAX_BUNDLE_BYTES) break;
      const block = `=== FILE: ${rel} ===\n${byPath.get(rel)}\n\n`;
      total += block.length;
      fileCount += 1;
      if (isSiteCode(rel)) siteFiles += 1;
      parts.push(block);
    }

    if (fileCount === 0) throw new Error("no_scannable_files");
    // Files, but no website among them — a docs repo, a dataset, a config-only
    // repo. Stop here rather than pay a model pass to discover it.
    if (siteFiles === 0) throw new Error("no_site_code");

    const bundlePath = `${user.id}/${scanId}/bundle.txt`;
    const { error: upErr } = await admin.storage
      .from("scans")
      .upload(bundlePath, new Blob([parts.join("")], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (upErr) throw new Error(`storage: ${upErr.message}`);

    await admin
      .from("scans")
      .update({ files_scanned: fileCount })
      .eq("id", scanId);

    return json({ ok: true, scan_id: scanId, files_scanned: fileCount });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .from("scans")
      .update({ status: "error", error: message })
      .eq("id", scanId);
    return json({ error: message }, 500);
  }
});
