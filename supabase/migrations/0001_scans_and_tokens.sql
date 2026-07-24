-- מחוץ לתבנית — dashboard backend schema
-- Stage 0/1 storage: scan records + GitHub tokens, all owner-scoped via RLS.

-- ============================================================
-- scans: one row per diagnosis run (Stage 0 ingest → Stage 1 detect)
-- ============================================================
create table if not exists public.scans (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  source_type          text not null check (source_type in ('zip', 'url', 'github')),
  source_ref           text,
  status               text not null default 'pending'
                         check (status in ('pending', 'ingesting', 'detecting', 'done', 'error')),
  files_scanned        integer,
  ai_fingerprint_score integer,
  present_count        integer,
  detection            jsonb,
  site_profile         jsonb,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists scans_user_id_created_at_idx
  on public.scans (user_id, created_at desc);

alter table public.scans enable row level security;

drop policy if exists "scans_select_own" on public.scans;
create policy "scans_select_own" on public.scans
  for select using (auth.uid() = user_id);

drop policy if exists "scans_insert_own" on public.scans;
create policy "scans_insert_own" on public.scans
  for insert with check (auth.uid() = user_id);

drop policy if exists "scans_update_own" on public.scans;
create policy "scans_update_own" on public.scans
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "scans_delete_own" on public.scans;
create policy "scans_delete_own" on public.scans
  for delete using (auth.uid() = user_id);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scans_touch_updated_at on public.scans;
create trigger scans_touch_updated_at
  before update on public.scans
  for each row execute function public.touch_updated_at();

-- ============================================================
-- github_tokens: OAuth provider token per user (for repo access)
-- Written by the client right after GitHub OAuth; read server-side
-- by edge functions via the service role. Sensitive — owner-only RLS.
-- ============================================================
create table if not exists public.github_tokens (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  provider_token         text,
  provider_refresh_token text,
  updated_at             timestamptz not null default now()
);

alter table public.github_tokens enable row level security;

drop policy if exists "github_tokens_select_own" on public.github_tokens;
create policy "github_tokens_select_own" on public.github_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "github_tokens_upsert_own" on public.github_tokens;
create policy "github_tokens_upsert_own" on public.github_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "github_tokens_update_own" on public.github_tokens;
create policy "github_tokens_update_own" on public.github_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Storage bucket for filtered source bundles (private).
-- Objects live under {user_id}/{scan_id}/bundle.txt — RLS keys off
-- the first path segment matching the caller's uid.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('scans', 'scans', false)
on conflict (id) do nothing;

drop policy if exists "scans_bucket_select_own" on storage.objects;
create policy "scans_bucket_select_own" on storage.objects
  for select using (
    bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "scans_bucket_insert_own" on storage.objects;
create policy "scans_bucket_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "scans_bucket_update_own" on storage.objects;
create policy "scans_bucket_update_own" on storage.objects
  for update using (
    bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "scans_bucket_delete_own" on storage.objects;
create policy "scans_bucket_delete_own" on storage.objects
  for delete using (
    bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text
  );
