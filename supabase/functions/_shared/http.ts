// Shared HTTP glue for the pipeline edge functions: CORS, JSON responses, and
// resolving the caller from their JWT via the service-role admin client. Mirrors
// the pattern already used by detect/ and fetch-repo/.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export async function requireUser(admin: SupabaseClient, req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const { data } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
  return data?.user ?? null;
}
