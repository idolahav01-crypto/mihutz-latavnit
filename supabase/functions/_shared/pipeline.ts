// Pure, dependency-free helpers shared by the scan, the rebuild and packaging.
//
// Everything here is deterministic and free of network / Supabase I/O so it can
// be unit-tested directly (see _shared/pipeline.test.ts): the bundle format,
// which files a scan is allowed to see, which path is safe to write, which page
// is the home page, and how a run's edits are merged back over the originals.
//
// This file used to also hold the propose-and-patch engine — proposal
// validation, fix ordering, conflict detection, unified diffs and the apply
// fallback. That pipeline (design -> apply -> QA) was removed when the rebuild
// became the only path a user can take, and the engine went with it.

export interface Signal {
  id: number;
  name: string;
  category: string;
  category_letter?: string;
  detection: string;
  weight: string;
  auto_fixable: string;
}

export interface Evidence {
  file: string;
  snippet: string;
}

export interface DetectedSignal {
  id: number;
  name: string;
  present: boolean;
  applicable: boolean;
  weight: string;
  confidence?: number;
  total_occurrences?: number;
  explanation?: string;
  evidence?: Evidence[];
}

const FILE_HEADER = /^=== FILE: (.+?) ===$/gm;

/** Format one file block the same way the client / fetch-repo bundler does. */
export function fileBlock(path: string, content: string): string {
  return `=== FILE: ${path} ===\n${content}\n\n`;
}

/** Parse a "=== FILE: path ===" bundle into a path -> content map. */
export function parseBundle(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const marks: Array<{ path: string; start: number; headerEnd: number }> = [];
  FILE_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_HEADER.exec(text)) !== null) {
    marks.push({ path: m[1], start: m.index, headerEnd: FILE_HEADER.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const contentStart = marks[i].headerEnd + 1; // skip the newline after the header
    const contentEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    // The bundler appends "\n\n" after each file; drop that trailing padding.
    const content = text.slice(contentStart, contentEnd).replace(/\n+$/, "");
    // The bundle format has no escaping: any line in a file's CONTENT that
    // looks like a header starts a new entry, at whatever path it names. So
    // the path is re-checked here rather than trusted because it was checked
    // once on the way in.
    const safe = safeRelPath(marks[i].path);
    if (!safe) continue; // dropped in silence — one bad path is not a failed run
    map.set(safe, content);
  }
  return map;
}

/** Serialise a path -> content map back into a bundle. */
export function serializeBundle(files: Map<string, string>): string {
  let out = "";
  for (const [path, content] of files) out += fileBlock(path, content);
  return out;
}

/** Full signal-list text (stable bytes → cacheable). Mirrors detect's format. */
export function buildSignalList(signals: Signal[]): string {
  return signals
    .map(
      (s) =>
        `#${s.id} | ${s.name} | category: ${s.category} | weight: ${s.weight} | auto_fixable: ${s.auto_fixable}\n   detection: ${s.detection}`,
    )
    .join("\n\n");
}

/** The present, applicable signals only — Stage 2 never sees the other ~85. */
export function presentSignals(detection: { signals?: DetectedSignal[] }): DetectedSignal[] {
  return (detection.signals ?? []).filter((s) => s.present === true && s.applicable !== false);
}

/**
 * A tombstone: this path was deliberately dropped from the delivered project.
 *
 * The edited bundle only carries files a stage rewrote, and everything else
 * comes through from the original — which is right until a stage makes a file
 * obsolete rather than changing it. A rebuilt page carries its own CSS inline,
 * so the old stylesheet is dead code: nothing links it, and it still ships to
 * the user and still scores against them. Measured on one real rebuild, an
 * orphaned style.css alone kept two signals alive (#64 and #77).
 *
 * A sentinel rather than a separate delete list, because every consumer — the
 * zip, the pull request, the after-scan — already funnels through
 * assembleFinalFiles, so they all honour it without changing.
 */
export const DELETED_FILE = "\u0000MIHUTZ_DELETED\u0000";

/** Merge edited files over the saved originals → the final, complete project. */
export function assembleFinalFiles(
  original: Map<string, string>,
  edited: Map<string, string>,
): Map<string, string> {
  const out = new Map(original);
  for (const [path, content] of edited) {
    if (content === DELETED_FILE) out.delete(path);
    else out.set(path, content);
  }
  return out;
}

/**
 * Files nothing links to any more.
 *
 * Only stylesheets and scripts are candidates: an unreferenced image may still
 * be wanted, and another HTML page is a page, not an asset. A file is kept if
 * ANY surviving page mentions its name, so a stylesheet shared with a page we
 * did not rebuild stays. The match is deliberately loose in the keeping
 * direction — a false keep costs nothing, a false delete costs a file.
 */
export function unreferencedAssets(files: Map<string, string>): string[] {
  const pages = [...files.entries()]
    .filter(([p]) => /\.html?$/i.test(p))
    .map(([, c]) => c)
    .join("\n");
  if (!pages) return [];
  const dead: string[] = [];
  for (const path of files.keys()) {
    if (!/\.(css|js|mjs)$/i.test(path)) continue;
    const name = path.split("/").pop() ?? path;
    // Quoted in an href/src, or named anywhere in an import — either counts.
    if (pages.includes(name)) continue;
    dead.push(path);
  }
  return dead;
}

// ---------- stage 1 multi-pass merge ----------

export interface DetectionResult {
  signals?: Array<Record<string, unknown>>;
  site_profile?: unknown;
  meta?: { files_scanned?: number; excluded_files?: string[] };
}

/**
 * Merge a pass's signals into whatever earlier passes already recorded. Keyed
 * by signal id so a re-run of the same pass overwrites rather than duplicates.
 */
export function mergeDetection(
  prior: DetectionResult,
  incoming: DetectionResult,
): DetectionResult {
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const s of prior.signals ?? []) byId.set(s.id, s);
  for (const s of incoming.signals ?? []) byId.set(s.id, s);
  return {
    // site_profile and meta only ever come from the first pass.
    site_profile: prior.site_profile ?? incoming.site_profile,
    meta: prior.meta ?? incoming.meta,
    signals: [...byId.values()].sort(
      (a, b) => Number(a.id ?? 0) - Number(b.id ?? 0),
    ),
  };
}


/**
 * Which page a single-page rebuild should treat as the site.
 *
 * The rebuild writes one file, so the choice decides what the whole run is
 * worth. It used to be the alphabetically first page, which on a real
 * four-page site ("contact, gallery, index, products") meant contact.html
 * every time and the home page never. Two measured rebuilds picked the wrong
 * page that way, and one of them picked a macOS metadata sidecar.
 *
 * Ranked, not filtered: every page stays eligible, so a site with no index.html
 * still gets its most plausible entry point rather than an error. Ties fall
 * back to the alphabetical order this replaces, so the choice is total and
 * repeatable.
 */
const HOME_BASENAMES = ["index", "home", "default", "main"];

// Names that belong to a specific inner page, never the home page. When nothing
// is named like an entry point, a page called one of these is the least likely
// to be home — the home page is the one WITHOUT a section's name.
const INNER_BASENAMES = new Set([
  "about", "about-us", "aboutus", "contact", "contact-us", "contactus",
  "services", "service", "products", "product", "gallery", "portfolio",
  "blog", "news", "faq", "faqs", "pricing", "price", "prices", "team",
  "shop", "store", "cart", "checkout", "terms", "privacy", "policy",
  "login", "signin", "sign-in", "register", "signup", "sign-up", "account",
  "search", "sitemap", "404", "thanks", "thank-you", "careers", "jobs",
]);

function baseOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.html?$/i, "").toLowerCase();
}

/** The name/depth ranking (lower is better): the total, content-free tie-break. */
function entryRank(path: string): [number, number, number] {
  const segments = path.split("/");
  segments.pop();
  const named = HOME_BASENAMES.indexOf(baseOf(path));
  return [
    // A recognised entry-point name beats any other name, whatever the depth:
    // "public/index.html" is the home page and "about.html" is not.
    named === -1 ? 1 : 0,
    // Among those, the shallowest wins — the root index over a nested one.
    segments.length,
    // "index" over "home" over "default" over "main".
    named === -1 ? 0 : named,
  ];
}

function rankLess(a: string, b: string): boolean {
  const ra = entryRank(a), rb = entryRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] < rb[i];
  }
  return a < b; // alphabetical, so the choice is total and repeatable
}

/**
 * Which page a single-page rebuild should treat as the site.
 *
 * The rebuild writes one file, so the choice decides what the whole run is
 * worth. It used to be the alphabetically first page, which on a real
 * four-page site ("contact, gallery, index, products") meant contact.html
 * every time and the home page never. Two measured rebuilds picked the wrong
 * page that way, and one of them picked a macOS metadata sidecar.
 *
 * Ranked, not filtered: every page stays eligible, so a site with no index.html
 * still gets its most plausible entry point rather than an error. Ties fall
 * back to the alphabetical order this replaces, so the choice is total and
 * repeatable.
 */
export function pickHomePage(paths: Iterable<string>): string | null {
  const pages = [...paths].filter((p) => /\.html?$/i.test(p));
  if (!pages.length) return null;
  let best = pages[0];
  for (const page of pages.slice(1)) {
    if (rankLess(page, best)) best = page;
  }
  return best;
}

/**
 * The smart home-page pick: let the site's own link structure decide.
 *
 * A filename heuristic guesses wrong the moment the home page is not called
 * "index" — a site whose entry point is "welcome.html" looks no different from
 * "contact.html" by name alone. But the home page gives itself away in the link
 * graph: every other page's logo and nav link back to it, and the logo is the
 * page's first link. This reads the real markup, counts who links to whom, and
 * scores each page — falling back to the name/depth heuristic when a bundle has
 * no usable links at all. Fully deterministic; no model, no network.
 */
export function pickHomePageSmart(files: Map<string, string>): string | null {
  const pages = [...files.keys()].filter((p) => /\.html?$/i.test(p));
  if (pages.length <= 1) return pages[0] ?? pickHomePage(files.keys());

  // Match resolved hrefs to real files case-insensitively; return real casing.
  const byNorm = new Map<string, string>();
  for (const p of pages) byNorm.set(p.toLowerCase(), p);

  const inbound = new Map<string, number>(); // page -> distinct pages linking to it
  const logo = new Map<string, number>(); // page -> pages whose logo/first link points here
  const root = new Map<string, number>(); // page -> pages linking to it as "/"

  for (const page of pages) {
    const fromDir = page.includes("/") ? page.replace(/\/[^/]*$/, "") : "";
    const links = extractLinks(files.get(page) ?? "");
    const seen = new Set<string>();
    let firstInternal: string | null = null;
    for (const { href, isLogo } of links) {
      const target = resolveHref(href, fromDir, byNorm);
      if (!target || target === page) continue;
      if (!seen.has(target)) {
        seen.add(target);
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
      if (firstInternal === null) firstInternal = target;
      if (isLogo) logo.set(target, (logo.get(target) ?? 0) + 1);
      if (isRootHref(href)) root.set(target, (root.get(target) ?? 0) + 1);
    }
    // The first internal link on a page is almost always its logo → home.
    if (firstInternal) logo.set(firstInternal, (logo.get(firstInternal) ?? 0) + 1);
  }

  const linkTotal = [...inbound.values()].reduce((a, b) => a + b, 0);
  if (linkTotal === 0) return pickHomePage(pages); // no usable links — fall back

  const maxInbound = Math.max(1, ...inbound.values());
  const maxLogo = Math.max(1, ...logo.values());
  const n = pages.length;

  const score = (path: string): number => {
    const base = baseOf(path);
    const depth = path.split("/").length - 1;
    const named = HOME_BASENAMES.indexOf(base);
    return Math.round(
      ((inbound.get(path) ?? 0) / maxInbound) * 100 + // who links here (dominant)
      ((logo.get(path) ?? 0) / maxLogo) * 45 +        // the logo / first-link target
      (named >= 0 ? 40 - named * 3 : 0) +             // a real entry-point name
      (INNER_BASENAMES.has(base) ? -30 : 0) +         // an inner-page name is not home
      ((root.get(path) ?? 0) / n) * 20 -              // linked to as "/"
      depth * 6,                                        // shallower is more likely home
    );
  };

  let best = pages[0];
  let bestScore = score(best);
  for (const page of pages.slice(1)) {
    const s = score(page);
    if (s > bestScore || (s === bestScore && rankLess(page, best))) {
      best = page;
      bestScore = s;
    }
  }
  return best;
}

/** Pull every <a> link with a hint of whether it is a logo/brand link. */
function extractLinks(html: string): Array<{ href: string; isLogo: boolean }> {
  const out: Array<{ href: string; isLogo: boolean }> = [];
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = m[1];
    const href = attrValue(attrs, "href");
    if (href === null) continue;
    const cls = (attrValue(attrs, "class") ?? "").toLowerCase();
    const isLogo = /\b(logo|brand|navbar-brand|site-title|site-logo|header-logo|home-link)\b/.test(cls);
    out.push({ href, isLogo });
  }
  return out;
}

function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

const ROOT_HREFS = new Set(["", "/", "./", ".", "index.html", "/index.html", "index.htm", "/index.htm"]);

function isRootHref(href: string): boolean {
  return ROOT_HREFS.has(href.trim().split("#")[0].split("?")[0].toLowerCase());
}

/** Resolve an href to a real HTML file in the bundle, or null. */
function resolveHref(href: string, fromDir: string, byNorm: Map<string, string>): string | null {
  let h = href.trim();
  if (!h || h.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  if (/^https?:\/\//i.test(h) || h.startsWith("//")) return null; // external
  h = h.split("#")[0].split("?")[0];
  if (!h) h = "./";

  const rooted = h.startsWith("/");
  const combined = rooted ? h.slice(1) : (fromDir ? `${fromDir}/${h}` : h);
  const norm = normalizeSegments(combined);

  const candidates: string[] = [];
  if (norm === "" || norm.endsWith("/")) {
    candidates.push(`${norm}index.html`, `${norm}index.htm`);
  } else if (/\.html?$/i.test(norm)) {
    candidates.push(norm);
  } else {
    candidates.push(norm, `${norm}.html`, `${norm}.htm`, `${norm}/index.html`, `${norm}/index.htm`);
  }
  for (const c of candidates) {
    const hit = byNorm.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Collapse "." and ".." segments and stray slashes in a relative path. */
function normalizeSegments(path: string): string {
  const trailing = path.endsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/") + (trailing && out.length ? "/" : "");
}

// ============================================================
// Path safety
// ============================================================

/**
 * A path that can only ever name a file INSIDE the project, or null.
 *
 * Nothing here writes to a filesystem, so this is not about our own disk. The
 * path travels: it becomes an entry in the ZIP the user opens on their machine
 * (js/app.js hands it straight to JSZip) and the path of a file in the pull
 * request we open on their repository. A "../../.ssh/authorized_keys" that
 * survives the pipeline is a file written outside the folder the user thought
 * they were unpacking.
 *
 * keepPath's dotted-segment rule already drops "..", as a side effect of
 * dropping .git and .env. This is the rule that means it, and it covers what
 * that side effect misses: an absolute path, a Windows drive letter, and
 * backslash separators.
 *
 * normalizeSegments is deliberately NOT reused as-is: it pops past the root
 * silently, which turns "../evil" into "evil" — an escape that is hidden
 * rather than refused. Here, a pop with nothing to pop is the whole point.
 *
 * Returns the cleaned relative path, or null if it escapes, names nothing, or
 * is a directory.
 */
export function safeRelPath(path: string): string | null {
  if (!path) return null;
  // Windows separators, and the drive letter or UNC prefix in front of them.
  let p = path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  // Any number of leading slashes: "/etc/passwd", "//host/share".
  p = p.replace(/^\/+/, "");
  if (p.endsWith("/")) return null; // a directory names no file

  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null; // escapes the project root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (!out.length) return null;
  return out.join("/");
}

// ============================================================
// Which files belong in a scan bundle
// ============================================================

/**
 * A scan should see the site, and only the site.
 *
 * Everything that gets past this ends up in the bundle: it is sent to the
 * model, it is counted in files_scanned, and any signal found in it scores
 * against the user. Real bundles were carrying an archive-extraction artifact
 * (pax_global_header), repo documentation (README.md), and macOS metadata —
 * none of which a browser ever loads.
 *
 * The dotted-segment rule is the one that matters most: it drops .git, .cache,
 * .DS_Store, the "._name" sidecars macOS puts in every zip, and — the reason it
 * is a rule and not a list — .env, which was being read off disk and sent to
 * the model along with whatever was in it.
 *
 * robots.txt is deliberately NOT filtered as a text file; three signals look
 * for it.
 *
 * The dotted rule only catches secrets that are named like dotfiles. The
 * SKIP_SECRETS rule below covers the ones that are not — secrets.json, a .pem,
 * an id_rsa — which were reaching the model until it existed.
 *
 * js/app.js keeps a copy of these rules, because the browser does the same
 * filtering before upload and cannot import from here. Change one, change both.
 */
const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|\.next|\.nuxt|out|vendor|coverage|\.cache|\.vercel|\.turbo|__MACOSX)(\/|$)/;
// Any path segment starting with a dot: config, VCS internals, macOS sidecars,
// and secrets. None of them are the website.
const SKIP_DOTTED = /(^|\/)\./;
// tar/pax writes this pseudo-entry into archives; GitHub tarballs carry it.
const SKIP_ARCHIVE_ARTIFACT = /(^|\/)pax_global_header$/;
// Repo documentation. It ships to GitHub, not to a browser.
const SKIP_DOCS =
  /(\.(md|markdown|mdx|rst)$|(^|\/)(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING)(\.(txt|rst))?$)/i;
const SKIP_FILE =
  /\.(min\.(js|css)|map|lock|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|br|wasm|ds_store)$/i;
const SKIP_LOCKFILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;
// Secrets whose names do NOT start with a dot, so the rule above misses them.
// A key or a service account is not the website, it is the keys to it, and it
// has no business in a prompt. The browser keeps its own copy of these files
// and puts them back into the downloaded ZIP untouched — they are excluded
// from the scan, not taken away.
const SKIP_SECRETS =
  /((^|\/)(secrets?\.(json|ya?ml|toml)|credentials?\.(json|ya?ml)|service[-_]?account[^/]*\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|htpasswd)$)|\.(pem|key|p12|pfx|keystore|jks|ppk|asc|gpg)$/i;

/** True if this path should go into the bundle. Accepts "dir/" for directories. */
export function keepPath(path: string): boolean {
  // A path that cannot be expressed safely inside the project is not a file we
  // are willing to carry, whatever its extension.
  if (!path.endsWith("/") && !safeRelPath(path)) return false;
  if (SKIP_DIR.test(path)) return false;
  if (SKIP_DOTTED.test(path)) return false;
  if (SKIP_ARCHIVE_ARTIFACT.test(path)) return false;
  if (SKIP_DOCS.test(path)) return false;
  if (SKIP_LOCKFILES.test(path)) return false;
  if (SKIP_SECRETS.test(path)) return false;
  if (SKIP_FILE.test(path)) return false;
  return true;
}
