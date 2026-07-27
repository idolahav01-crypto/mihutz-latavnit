# AGENTS.md

## Cursor Cloud specific instructions

### What this project is
Bilingual (English + Hebrew) product **מחוץ לתבנית** — a static marketing site plus a
web-app dashboard (`/app/`, `/he/app/`) that audits websites for the "AI fingerprint".
Two parts:

- **Frontend** — vanilla static HTML/CSS/JS at the repo root (`index.html`, `he/`, `app/`,
  `css/`, `js/`). No build step and no package manager; runtime libs (`@supabase/supabase-js`,
  `jszip`) load from a CDN at runtime. Nothing to install.
- **Backend** — Supabase project: Deno edge functions in `supabase/functions/`
  (`detect`, `fetch-repo`, `list-repos`) and SQL in `supabase/migrations/`. The frontend is
  hardcoded to a hosted Supabase project (URL + anon key in `js/main.js` and `js/app.js`), so
  no local Supabase is needed just to run the site.

### Run the frontend (primary dev workflow)
Serve the repo root as static files on port 4173 (matches `.claude/launch.json`):

```
python3 -m http.server 4173
```

Then open `http://localhost:4173/` (English) or `http://localhost:4173/he/` (Hebrew).
`python3` is a system dependency and is already present; there is no dependency install step
for the frontend. Edit files and refresh the browser — there is no hot reload and no bundler.

### Lint / type-check the edge functions
`deno` (installed to `/usr/local/bin` by the update script) is the only code-quality tool in
this repo. From the repo root:

```
deno lint supabase/functions/
deno check supabase/functions/list-repos/index.ts
deno check supabase/functions/fetch-repo/index.ts
```

Notes / gotchas:
- `deno lint` passes on all three functions.
- `deno check supabase/functions/detect/index.ts` fails with a **pre-existing** `TS2352`
  cast error in `detect/index.ts` (unrelated to environment setup — do not "fix" it as part
  of setup work).
- There are **no automated tests** and **no build step** in this repo.

### Things that need external accounts (cannot be exercised in the VM as-is)
- **Auth**: the site uses Google/GitHub OAuth via Supabase. The header Sign up / Sign in modal
  opens and the OAuth redirect is wired, but completing login needs OAuth apps + a Supabase
  project you control (see `SETUP-AUTH.md`).
- **Dashboard** (`/app/`, `/he/app/`): `js/app.js` redirects to the homepage when there is no
  Supabase session, so the audit flow is only reachable after a real login.
- **Audit engine**: the `detect` edge function calls the Anthropic API and needs an
  `ANTHROPIC_API_KEY` secret in Supabase (Edge Functions → Secrets).
- Running the edge functions locally would additionally require the Supabase CLI + Docker.
