// Which files are the website, and which merely live next to it.
//
// Two stages need this question answered, for opposite reasons.
//
// The orphan sweep (unreferencedAssets) deletes code nothing links to. Its
// candidates are .css/.js/.mjs, which is also what a Node server, a build
// config and a service worker are made of — none of which any page links to,
// and all of which were being deleted out of the project the user downloads.
//
// The bundlers cap what they send at 300KB in iteration order, so a large
// backend can push the actual website out of its own audit.
//
// The two stages get different tools on purpose. Ordering happens while a
// tarball is still streaming and a ZIP has not been read yet, so it may only
// look at PATHS. The orphan sweep holds every file in memory and can read
// content too. Path rules are shared; content rules are used only where
// content exists.

// Directories that hold server or tooling code in every convention we have
// seen. Matched on any segment: "src/api/users.js" counts as much as
// "api/users.js".
const SERVER_DIR =
  /(^|\/)(api|routes?|controllers?|middlewares?|server|backend|lambda|handlers?|migrations|prisma|db|netlify|supabase|functions)(\/|$)/i;

// Anything named "*.config.js" plus the build tools that predate that habit.
// These are not the website. Deleting a vite.config.js does not break the page
// in the browser, which is exactly why nobody would notice until they tried to
// build the project again.
const TOOL_FILE =
  /(^|\/)([\w.-]*\.config\.(m|c)?[jt]s|gulpfile\.(m|c)?js|gruntfile\.(m|c)?js|karma\.conf\.js|webpack\.[\w.-]*\.(m|c)?js|jest\.setup\.(m|c)?js)$/i;

// A Node entry point, by any of its usual names, at the root of the project.
const SERVER_FILE = /^(server|app|index|main|start|bin|cli|worker|daemon)\.(m|c)?[jt]s$/i;

// A service worker is registered from JavaScript, never linked from a page, so
// the reference search cannot see it however wide we make it.
const SERVICE_WORKER = /(^|\/)(sw|service-worker|serviceworker|firebase-messaging-sw)\.(m|c)?js$/i;

const TEST_FILE = /(\.(test|spec)\.(m|c)?[jt]sx?$)|(^|\/)(__tests__|__mocks__|test|tests|e2e|cypress|playwright)(\/|$)/i;

/**
 * True for code that is part of the project but is not something a page loads.
 *
 * Path-only, so the bundlers can call it on a name alone, mid-stream. It errs
 * toward saying yes: every caller treats a yes as "leave this file alone",
 * and leaving a frontend file alone costs nothing.
 */
export function isNonPageCode(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const atRoot = !path.includes("/");
  return SERVER_DIR.test(path) ||
    TOOL_FILE.test(path) ||
    SERVICE_WORKER.test(path) ||
    TEST_FILE.test(path) ||
    (atRoot && SERVER_FILE.test(base));
}

// Things that only appear in code meant to run on a server. `process.env` is
// deliberately included even though bundlers sometimes leave it in browser
// code: a false positive here means a file is KEPT, which is free.
const SERVER_CODE = [
  /\brequire\s*\(\s*["'](express|fastify|koa|http|https|fs|path|crypto|mongoose|pg|mysql2?|sqlite3|redis|dotenv)["']\s*\)/,
  /\bfrom\s+["'](express|fastify|koa|node:[\w/]+|fs|path|mongoose|pg|mysql2?|redis)["']/,
  /\bmodule\.exports\b/,
  /\bexports\.\w+\s*=/,
  /\bprocess\.env\b/,
  /\bDeno\.serve\s*\(/,
  /\bapp\.listen\s*\(/,
  /\bcreateServer\s*\(/,
  /^#!.*\bnode\b/m,
];

/**
 * The same question, with the file's contents available.
 *
 * Used by the orphan sweep, which is the caller that can actually destroy
 * something. Path rules first, then the content tells.
 */
export function isNonPageCodeWithContent(path: string, content: string): boolean {
  if (isNonPageCode(path)) return true;
  return SERVER_CODE.some((re) => re.test(content));
}

/** Files a page could plausibly load, in the order a bundler should take them. */
export function orderForBundle(paths: string[]): string[] {
  const site: string[] = [];
  const rest: string[] = [];
  for (const p of paths) (isNonPageCode(p) ? rest : site).push(p);
  // Stable within each group: the original order is still the order, so a
  // project with no server code at all bundles exactly as it did before.
  return [...site, ...rest];
}
