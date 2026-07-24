// Lists the caller's GitHub repositories for the OAuth tab.
// Uses the user's stored provider token (github_tokens). Returns a compact
// list: name, full_name, primary language, updated_at, private flag.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const { data: tok } = await admin
    .from("github_tokens")
    .select("provider_token")
    .eq("user_id", user.id)
    .single();
  if (!tok?.provider_token) {
    return json({ error: "github_not_connected" }, 428);
  }

  // Pull up to 100 most-recently-pushed repos the user can access.
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
    {
      headers: {
        Authorization: `Bearer ${tok.provider_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (res.status === 401) return json({ error: "github_token_expired" }, 428);
  if (!res.ok) return json({ error: `github ${res.status}` }, 502);

  const repos = (await res.json()) as Array<Record<string, unknown>>;
  const list = repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    language: r.language ?? null,
    updated_at: r.pushed_at ?? r.updated_at,
    private: r.private === true,
    default_branch: r.default_branch ?? "main",
  }));

  return json({ ok: true, repos: list });
});
