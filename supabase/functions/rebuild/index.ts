// Stage R — RebuildDesigner: understand the site, then build it again from
// scratch in OUR canonical format (so the output is uniform, always renders,
// and carries zero AI fingerprints — regardless of how the original was built).
//
// This replaces the "analyse-and-patch foreign markup" approach (transform), whose
// coverage varied wildly by site type. Here we never edit the original markup:
//   part 1              — CONTENT SPEC: extract a precise structured content model
//                         (meta, real facts, ordered sections, interactive
//                         components) + a design_direction. Store spec.json.
//                         The original <script> blocks are carried byte-for-byte.
//   part 2              — SHELL: from the design_direction, build the global
//                         design-token CSS, font links, and header/footer markup.
//   parts 3..(2+S)      — SECTION: build ONE section's markup + CSS from its spec
//                         entry, using only the facts in that entry.
//   last part           — deterministically ASSEMBLE a complete, self-contained
//                         HTML document (tokens + sections + carried scripts) and
//                         write it to edited-bundle.txt (the pipeline deliverable).
//
// Facts are a CONTRACT: builders may only use content present in the spec. This
// is what stops "rebuild from scratch" from inventing or dropping real content.
//
// Body: { scan_id, part? } — response returns { parts, done, ... }.

import {
  DELETED_FILE,
  type DetectedSignal,
  assembleFinalFiles,
  parseBundle,
  pickHomePageDiagnostic,
  presentSignals,
  serializeBundle,
  unreferencedAssets,
} from "../_shared/pipeline.ts";
import { checkPreservation, summarize } from "../_shared/preservation.ts";
import { balanceCss, selfCheck } from "../_shared/selfcheck.ts";
import { redressSecondaryPages } from "../_shared/redress.ts";
import { checkRichness, collectCss, richnessTargets } from "../_shared/richness.ts";
import { cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { constraintsBlock, designSchema } from "../_shared/design_brief.ts";
import { assertModelPriced, meteredClaude } from "../_shared/usage.ts";
import { buildLedger } from "../_shared/ledger.ts";
import {
  ensureSectionId,
  fixAnchors,
  isWidgetSection,
  missingSectionFacts,
  renderContentSection,
  renderWidgetSection,
  sectionCoverage,
  stripSkipLinks,
  widgetWrapId,
} from "../_shared/rebuild_assembly.ts";

const MODEL = "claude-opus-4-8";
// Fail on the first invoke, not after a paid build recorded $0.00.
assertModelPriced(MODEL);

// ---- storage layout ----
const paths = (uid: string, sid: string) => ({
  bundle: `${uid}/${sid}/bundle.txt`,
  edited: `${uid}/${sid}/edited-bundle.txt`,
  spec: `${uid}/${sid}/spec.json`,
  shell: `${uid}/${sid}/shell.json`,
  sections: `${uid}/${sid}/rebuild-sections.json`,
});

// ---- shared helpers ----
function extractScripts(html: string): { stripped: string; scripts: string[] } {
  const scripts: string[] = [];
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    const token = `<!--__MIHUTZ_SCRIPT_${scripts.length}__-->`;
    scripts.push(m);
    return token;
  });
  return { stripped, scripts };
}

async function readJson<T>(admin: ReturnType<typeof adminClient>, path: string): Promise<T | null> {
  const { data } = await admin.storage.from("scans").download(path);
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(admin: ReturnType<typeof adminClient>, path: string, value: unknown) {
  const up = await admin.storage.from("scans").upload(
    path,
    new Blob([JSON.stringify(value)], { type: "application/json" }),
    { upsert: true, contentType: "application/json" },
  );
  if (up.error) throw new Error(`storage: ${up.error.message}`);
}

// A compact summary of the ORIGINAL site's look (palette, fonts, design
// language) drawn from the detect stage's site_profile. It is fed to the
// designer as "DEPART FROM THIS" — the one thing that stops the rebuild from
// re-proposing what it just read and coming out looking like the original.
function originalLookBlock(profile: unknown): string {
  const p = (profile ?? {}) as {
    palette?: Array<{ hex?: string; role?: string }>;
    fonts?: Array<{ family?: string }>;
    design_language?: string;
    distinctive_elements?: string[];
  };
  const palette = (p.palette ?? [])
    .map((c) => [c.hex, c.role].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
  const fonts = (p.fonts ?? []).map((f) => f.family).filter(Boolean).join(", ");
  const lines: string[] = [];
  if (palette) lines.push(`palette: ${palette}`);
  if (fonts) lines.push(`fonts: ${fonts}`);
  if (p.design_language) lines.push(`design_language: ${p.design_language}`);
  if (p.distinctive_elements?.length) {
    lines.push(`distinctive_elements: ${p.distinctive_elements.join("; ")}`);
  }
  return lines.join("\n");
}

// ---- spec / shell / section shapes ----
interface Section {
  id: string;
  type: string;
  heading?: string;
  subheading?: string;
  body?: string;
  items?: Array<{ title?: string; text?: string; value?: string }>;
  cta?: { label?: string; href?: string };
  image?: string;
  component_id?: string; // an interactive container this section must contain
  /** For a component section: the widget container's exact inner HTML to carry. */
  verbatim_html?: string;
  /** The section's original visible text — the ground truth the coverage guard counts. */
  text?: string;
  note?: string;
}
interface Spec {
  meta: { name: string; purpose: string; language: string; audience: string; tone: string };
  dir: "rtl" | "ltr";
  facts: string[];
  sections: Section[];
  components: Array<{ name: string; purpose: string; container_id: string; script_index?: number }>;
  /** Image sources lifted from the ORIGINAL markup — never model-authored. */
  images?: string[];
}
interface Direction {
  brand_palette: Array<{ token: string; hex: string; role: string }>;
  typography: { heading: string; body: string };
  layout_principle: string;
  personality: string[];
  rationale: string;
}
interface Shell {
  head_extras: string;
  tokens_css: string;
  header_html: string;
  footer_html: string;
}
interface BuiltSection {
  index: number;
  html: string;
  css: string;
  /** This section's CSS came back structurally broken and was repaired. */
  cssRepaired?: boolean;
}

// ================= PROMPTS =================
// The site's CONTENT is inventoried deterministically by _shared/ledger.ts — the
// model is never asked what the page contains, only how it should look. That is
// the whole reason content can no longer be summarised away: this pass returns a
// design_direction and three soft descriptors, nothing load-bearing.
const DESIGN_SYSTEM =
  `You are RebuildDesigner's art director. You are shown a website's existing look and a short outline of its content. Propose ONE design_direction that turns it into a genuinely DIFFERENT, hand-built website for the same business, plus three short descriptors of the site. You are NOT writing content and NOT writing markup.

design_direction — the one creative decision:
- DEPART from the original. Treat <original_look>'s palette, fonts and design language as exactly what to move AWAY from: a DIFFERENT typographic pairing and a DIFFERENT layout paradigm, and a different colour family too UNLESS <constraints> tells you to keep the brand colour. Same BUSINESS, unmistakably different WEBSITE — never a recolour of the old one.
- <constraints> OVERRIDES the instruction above wherever the two disagree. It carries facts about this specific business — a brand colour someone actually chose, the industry it must stay credible to, and the visual assets it does or does not own. A direction that ignores them is wrong however fresh it looks: keeping a real brand colour is not a failure to depart, and a photography-led direction for a business with no photographs is unbuildable.
- typography.heading and typography.body must be chosen from the enum in the schema. It is already filtered for this site's script; nothing outside it is available.
- AVOID every AI fingerprint in <avoid_ai_patterns>: the direction must not reintroduce a pattern the original was flagged for, nor reach for a different cliché in its place.
- Look hand-built by a real studio. layout_principle must be SPECIFIC and opinionated (e.g. "editorial split-screen with off-grid imagery over a strong baseline grid"), never generic ("clean and modern"). personality must be concrete adjectives a human designer would say.
- FORBIDDEN AI tells: default Inter, purple/indigo gradients, the dark-navy+gold cliché, Playfair-as-elegance, centre-everything symmetry, three identical cards as the only rhythm, and any emoji.

meta — three short strings describing the site, for the shell to use: purpose (one line), audience, tone. Do not restate content.

Return ONLY valid JSON matching the schema. No prose.`;

const SHELL_SYSTEM =
  `You are RebuildDesigner, a world-class web designer building a website from scratch in a clean, hand-crafted style. Given the site's meta and an approved design_direction, produce the GLOBAL shell every section will sit in.

Return:
- head_extras: the <link> tags that load the chosen fonts (Google Fonts is fine). For Hebrew, use Hebrew-capable fonts (Heebo, Assistant, Rubik, Frank Ruhl Libre, Noto Sans Hebrew).
- tokens_css: a real design system as CSS — :root custom properties for the brand palette, type scale, spacing rhythm, radii and shadows; sensible base element styles (body font/line-height/color, headings, links, img{max-width:100%}); and reusable component classes the sections will use (.container, .btn / .btn-primary, .section, etc.). Do NOT define an .eyebrow class or any other "small label above every heading" helper — offering one makes every section reach for it, and a kicker on every section is itself an AI tell. Body font-weight >= 500, headings >= 700. Respect dir (logical properties for RTL).
- header_html: the site header/nav markup (logo text = site name, real nav links only). Use the token classes.
- footer_html: a real footer built from the site's real facts. EVERY fact given to you that belongs in a footer MUST appear: company number, physical address, opening hours, phone, email, and the legal pages (terms, cancellation, privacy, accessibility statement) with the exact href each one already uses. Israeli law requires several of these and the audit checks for them, so dropping one makes the site worse than it was. Invent nothing: if a fact was not given, omit it rather than filling in a placeholder.

DEPART from the original. If <original_look> is provided, the tokens_css must NOT reuse its palette or fonts — build the shell in the NEW design_direction, clearly different from the old site.

Look hand-built and premium — like a real studio designed it by hand, not like a generator filled a template. FORBIDDEN AI fingerprints: default Inter, purple/indigo gradients, the dark-navy+gold cliché, Playfair-as-elegance, generic "Get Started" copy, perfectly symmetric three-card rows as the only rhythm, and — ABSOLUTELY NO EMOJI anywhere (not in the logo, nav, headings, buttons, or footer). Emoji are the single most obvious AI tell; never emit a single one. Return ONLY valid JSON. No prose.`;

/**
 * The AI fingerprints this specific site was caught with, each with the audit's
 * own note on how it showed up HERE — "a grid of 4 identical cards in the
 * achievements section" rather than the generic rule. That note is already in
 * the stored detection, so this costs no extra lookup and no bundled data.
 *
 * It goes into the section builder's SYSTEM prompt rather than its user turn:
 * the bytes are identical across every section call within a scan, so the
 * prompt cache serves calls 2..N at a tenth of the input price. It also pushes
 * the section prompt (~540 tokens) past the size where caching engages at all,
 * which is why every rebuild call so far measured zero cached input.
 */
/**
 * Rules that apply to every rebuild regardless of what the audit found.
 *
 * buildAvoidBlock only ever lists signals PRESENT in the original site, so a
 * check the original passed is never mentioned — and measurement showed that is
 * exactly the set the rebuild breaks. Three runs in a row introduced physical
 * CSS properties, inconsistent RTL, reversed currency order and icon buttons
 * with no accessible name, none of which the original was guilty of.
 */
const NEVER_INTRODUCE = `

<never_introduce>
These are not site-specific findings — they are rules the rebuilt page must
satisfy even if the original site already did. Breaking one turns a passing
check into a failing one, which is worse than leaving the site alone.

- Logical properties ONLY. Never margin-left/right, padding-left/right,
  float:left, text-align:left. Use inline-start / inline-end / text-align:start.
- RTL must be consistent, not just dir on the root: flex/grid direction, absolute
  offsets (inset-inline-start, never left:0), and icon/arrow direction all follow
  the text direction.
- Currency and numbers: the symbol goes BEFORE the number in Hebrew (₪199, never
  "199 ₪"). Wrap any Latin text or number inside Hebrew in an element with
  dir="ltr" and unicode-bidi:isolate so it cannot reorder.
- Every control needs an accessible name. An icon-only <button> or <a> must carry
  aria-label. Every <img> needs a real alt (empty alt only if purely decorative).
</never_introduce>`;

function buildAvoidBlock(present: DetectedSignal[]): string {
  if (!present.length) return NEVER_INTRODUCE;
  const lines = present
    .map((s) => {
      const found = (s.explanation ?? "").trim();
      return `#${s.id} ${s.name}` + (found ? `\n   found here as: ${found}` : "");
    })
    .join("\n");
  return NEVER_INTRODUCE + `\n\n<avoid_ai_patterns>\nThe audit found these AI fingerprints in THIS site. Removing them is the entire point of rebuilding it, so your section must not reproduce a single one — and must not reach for a different cliché in their place. Each entry is the fingerprint, then how it showed up in this site.\n\n${lines}\n</avoid_ai_patterns>`;
}

const SECTION_SYSTEM =
  `You are RebuildDesigner, building ONE section of a website from scratch. You are given the approved design_direction, the global tokens_css (the classes and CSS variables you MUST reuse), and the content spec for exactly one section. Build beautiful, human, semantic markup for it and its CSS.

Hard rules:
- Use ONLY the content in this section's spec (its heading, body, items, cta, facts). NEVER invent facts, testimonials, stats, logos, or copy that isn't given. If a field is empty, omit that element — do not fill it with placeholder text.
- Reuse the design tokens and component classes from tokens_css (CSS variables, .container, .btn, spacing). Your section CSS should add only what's specific to this section, scoped under a unique wrapper class derived from the section id (e.g. .sec-<id>) so it can't collide.
- If the spec gives this section a component_id, include an element with exactly that id (the original interactive script will be re-attached to it). Do not write any <script>.
- Compose with real design judgement, like a human designer laying out this one section by hand: vary the layout from what a generator would do, use asymmetry and editorial rhythm, real whitespace, an intentional focal point. Do NOT default to a centred heading over a symmetric card grid — that is the #1 "this was AI-built" tell. Follow the design_direction's layout_principle. RTL if dir is rtl (logical properties, right alignment).
- AVOID every AI fingerprint in <avoid_ai_patterns>: do not reintroduce a pattern the original site was flagged for.
- FORBIDDEN: default Inter, purple/indigo gradients, "Get Started", identical symmetric card rows every time, lorem/placeholder text.
- ABSOLUTELY NO EMOJI — never put an emoji in a heading, card, badge, list item, button, or anywhere in markup or text. If the source content had emoji (as icons or beside headings), DROP them and replace with a real inline SVG icon, a typographic treatment, or nothing. Emoji are the #1 AI fingerprint. For a stats/achievements block, KEEP the real numbers but present them with editorial variety — never as a symmetric row of identical emoji-topped cards.

Return ONLY valid JSON { "html": "...", "css": "..." } for this one section. No prose.`;

// ================= SCHEMAS =================
const SHELL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    head_extras: { type: "string" },
    tokens_css: { type: "string" },
    header_html: { type: "string" },
    footer_html: { type: "string" },
  },
  required: ["tokens_css", "header_html", "footer_html"],
};

const SECTION_BUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { html: { type: "string" }, css: { type: "string" } },
  required: ["html", "css"],
};

// ================= assembly =================

/**
 * The head tags the audit checks for (#30 meta description, #31 Open Graph,
 * #27 JSON-LD). These are built from the spec rather than asked of the model:
 * the facts are already in hand, so generating them here makes them certain and
 * free instead of something a prompt can forget — two consecutive runs cleared
 * different subsets of what they were told to fix, and these three never cleared
 * at all.
 *
 * Canonical (#99) is deliberately absent: it needs the site's real deployed URL,
 * which the bundle does not carry, and a guessed canonical is worse than none.
 */
/**
 * The site's own address is the one input the pipeline cannot derive or invent,
 * and three signals hang off it (og:url, og:image, canonical). The user supplies
 * it; we only sanity-check it so a typo can never end up in a canonical tag.
 */
function normalizeSiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const withScheme = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Resolve an image path from the original page against the live site address. */
function absoluteUrl(src: string, siteUrl: string): string | null {
  try {
    return new URL(src, siteUrl + "/").toString();
  } catch {
    return null;
  }
}

/**
 * Candidate share images, in the order the page itself presents them. Logos and
 * icons are pushed to the back: signal #98 is specifically "the logo is the
 * og:image on every page", so a real content image is always the better pick.
 */
function extractImageUrls(html: string): string[] {
  const found: string[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim();
    if (!src || src.startsWith("data:")) continue;
    if (!found.includes(src)) found.push(src);
  }
  const isChrome = (s: string) => /logo|icon|favicon|sprite|avatar/i.test(s);
  return [...found.filter((s) => !isChrome(s)), ...found.filter(isChrome)].slice(0, 5);
}

function headMeta(spec: Spec, siteUrl: string | null): string {
  const name = spec.meta.name || "";
  const desc = (spec.meta.purpose || "").trim().slice(0, 155);
  const q = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");
  const tags: string[] = [];

  if (desc) {
    tags.push(`<meta name="description" content="${q(desc)}">`);
    tags.push(`<meta property="og:description" content="${q(desc)}">`);
  }
  if (name) {
    tags.push(`<meta property="og:title" content="${q(name)}">`);
    tags.push(`<meta property="og:site_name" content="${q(name)}">`);
  }
  tags.push(`<meta property="og:type" content="website">`);
  if (spec.meta.language) tags.push(`<meta property="og:locale" content="${q(spec.meta.language)}">`);

  // These three need the real address. Without it we emit nothing rather than
  // guess — a wrong canonical is worse than a missing one.
  if (siteUrl) {
    tags.push(`<link rel="canonical" href="${q(siteUrl)}">`);
    tags.push(`<meta property="og:url" content="${q(siteUrl)}">`);
    const img = (spec.images ?? [])
      .map((src) => (/^https?:\/\//i.test(src) ? src : absoluteUrl(src, siteUrl)))
      .find((u): u is string => !!u);
    if (img) {
      tags.push(`<meta property="og:image" content="${q(img)}">`);
      tags.push(`<meta name="twitter:card" content="summary_large_image">`);
    }
  }

  // Organisation schema from the real facts only — never invented.
  if (name) {
    const ld: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name,
    };
    if (desc) ld.description = desc;
    const phone = (spec.facts ?? []).find((f) => /0\d[\d\-\s]{7,}/.test(f));
    if (phone) ld.telephone = phone.match(/0\d[\d\-\s]{7,}/)?.[0]?.trim();
    const email = (spec.facts ?? []).find((f) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(f));
    if (email) ld.email = email.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    tags.push(
      `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
    );
  }
  return tags.join("\n");
}

/**
 * The floor every rebuilt page gets whether or not the original had it.
 *
 * The avoid list is derived from the signals found in the ORIGINAL site, so a
 * check the original passed is never mentioned to the builder — which is
 * precisely the set it is free to break. Three consecutive runs introduced the
 * same kinds of regression (no skip link, no reduced-motion block, no font
 * preload), so those three stop being asked for and start being emitted.
 */
function baseA11yCss(): string {
  return `/* keyboard users need a way past the nav (#94) */
.skip-link{position:absolute;inset-block-start:-100%;inset-inline-start:0;z-index:999;
  padding:.75rem 1rem;background:#000;color:#fff;text-decoration:none}
.skip-link:focus{inset-block-start:0}
/* honour the OS "reduce motion" setting (#45) */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;
    transition-duration:.01ms !important;scroll-behavior:auto !important}
}`;
}

/** Preload the font the shell already loads (#40), derived from its own link. */
function fontPreload(headExtras: string): string {
  const m = headExtras.match(/<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/i);
  return m ? `<link rel="preload" as="style" href="${m[1]}">` : "";
}

function assemble(spec: Spec, shell: Shell, sections: BuiltSection[], scripts: string[], siteUrl: string | null): string {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const sectionCss = ordered.map((s) => s.css || "").join("\n\n");
  const sectionHtml = ordered.map((s) => s.html || "").join("\n\n");
  const lang = spec.meta.language || (spec.dir === "rtl" ? "he" : "en");
  const scriptBlock = scripts.length ? "\n" + scripts.join("\n") + "\n" : "";

  // Every real section id, so nav/footer links can only point at sections that
  // exist. The shell model may also emit its own skip-link — drop it, since the
  // one below is the page's single, canonical one.
  const anchorTargets = spec.sections.map((s) => ({ id: s.id, heading: s.heading }));
  const header = fixAnchors(stripSkipLinks(shell.header_html || ""), anchorTargets);
  const footer = fixAnchors(shell.footer_html || "", anchorTargets);
  return `<!doctype html>
<html lang="${lang}" dir="${spec.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.meta.name || "")}</title>
${headMeta(spec, siteUrl)}
${fontPreload(shell.head_extras || "")}
${shell.head_extras || ""}
<style>
${baseA11yCss()}

${shell.tokens_css}

${sectionCss}
</style>
</head>
<body>
<a class="skip-link" href="#main">${spec.dir === "rtl" ? "דלג לתוכן העמוד" : "Skip to content"}</a>
${header}
<main id="main">
${sectionHtml}
</main>
${footer}
${scriptBlock}</body>
</html>
`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…" : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ================= handler =================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; part?: number; site_url?: string; proposal?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);
  let part = Number.isInteger(body.part) && (body.part as number) >= 1 ? (body.part as number) : 1;
  // Which design proposal this is. 1 is the one every run gets; anything
  // higher is a direction the user asked for after turning down the last one.
  // Uncapped by decision — it costs what it costs and the user is choosing.
  const proposalNo = Number.isInteger(body.proposal) && (body.proposal as number) >= 1
    ? (body.proposal as number)
    : 1;

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection, site_profile, design_direction, site_url")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) return json({ error: "scan not found" }, 404);
  if (!scan.detection) return json({ error: "run_detection_first" }, 409);

  // A URL sent with this request wins; otherwise reuse whatever an earlier part
  // stored, so parts 2..N still know the address the user typed once.
  const siteUrl = normalizeSiteUrl(body.site_url) ?? normalizeSiteUrl(scan.site_url);

  const P = paths(user.id, scanId);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));
    const startedAt = Date.now();

    const present = presentSignals(scan.detection as { signals?: DetectedSignal[] });
    const avoidList = present.map((s) => `#${s.id} ${s.name}`).join("\n");
    // "#78 currency order" on its own tells the builder nothing, so the block
    // carries what the audit saw in this site alongside each signal.
    const avoidBlock = buildAvoidBlock(present);
    // The ORIGINAL site's look, to push every design stage AWAY from it.
    const originalLook = originalLookBlock(scan.site_profile);
    const constraints = constraintsBlock(scan.site_profile);
    // Which alphabet the copy is in decides which fonts are on the menu.
    const measured = (scan.site_profile ?? {}) as { measured_language?: { rtl?: boolean } };
    const rtlSite = measured.measured_language?.rtl === true;

    // ---------- PART 1: content spec + design direction ----------
    if (part === 1) {
      const { data: file, error: dlErr } = await admin.storage.from("scans").download(P.bundle);
      if (dlErr || !file) throw new Error("bundle_not_found");
      const pristine = parseBundle(await file.text());
      // The one page this run rebuilds. The site's own link graph decides it —
      // the page every other page's logo and nav point back to — so a home page
      // that isn't called "index" is still found, not a filename guess.
      const pick = pickHomePageDiagnostic(pristine);
      const target = pick.path;
      if (!target) return json({ error: "no_html_file" }, 409);
      // The pick decides what this whole run is worth, so a pick that was not
      // clear-cut says so. AMBIGUOUS means the link graph was unusable or two
      // pages scored within a hair of each other and a tie-break settled it.
      if (pick.method !== "only" && (pick.method === "names" || pick.margin < 10)) {
        console.warn(
          `home page AMBIGUOUS: ${target} (via ${pick.method}, margin ${pick.margin}` +
          `, runner-up ${pick.runnerUp ?? "none"}, ${pick.pages} pages)`,
        );
      }

      const rawTarget = pristine.get(target) ?? "";
      // Carry the original scripts byte-for-byte; the rebuilt page re-attaches them.
      const { scripts } = extractScripts(rawTarget);

      // CONTENT is inventoried deterministically — every section, every repeated
      // item, and the verbatim DOM of any widget a script drives. The model is
      // never asked what the page contains, so content cannot be summarised away.
      // The site's .js FILES, not just the inline blocks. A page whose behaviour
      // lives in script.js otherwise looks script-free, and its containers get
      // no protection at all.
      const externalJs = [...pristine.entries()]
        .filter(([path]) => /\.(js|mjs)$/i.test(path))
        .map(([, code]) => code)
        .join("\n");
      const ledger = buildLedger(rawTarget, externalJs);
      if (!ledger.sections.length) throw new Error("empty_ledger");

      // A headings-only outline is all the design pass needs — enough to judge
      // the site's shape, with none of its copy to be tempted into rewriting.
      const outline = ledger.sections
        .map((s, i) => `${i + 1}. [${s.type}] ${s.heading || s.id}`)
        .join("\n");

      const userContent =
        `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
        (originalLook
          ? `<original_look note="This is the OLD design that is being REPLACED. Do NOT reuse its colours, fonts, or design language — the design_direction must clearly DEPART from everything here.">\n${originalLook}\n</original_look>\n\n`
          : "") +
        (constraints
          ? `<constraints note="Facts about this business that the direction must respect. These OVERRIDE the instruction to depart from the original wherever the two disagree.">\n${constraints}\n</constraints>\n\n`
          : "") +
        (avoidList
          ? `<avoid_ai_patterns note="AI fingerprints detected on the ORIGINAL site. The new design_direction must avoid every one of these.">\n${avoidList}\n</avoid_ai_patterns>\n\n`
          : "") +
        `<content_outline note="What the site contains, for context only. Do NOT restate or rewrite it.">\n${outline}\n</content_outline>\n\n` +
        `Propose ONE design_direction that makes this a genuinely DIFFERENT, hand-built website for the same business: a different colour family, a different type pairing, and a different layout paradigm from <original_look>. It must not look AI-generated. Also return the three short meta descriptors.`;

      // This pass now emits only a design_direction and three descriptors, so it
      // is small and fast — no content to stream. medium effort; a 4k ceiling is
      // ample for the direction JSON.
      // Every proposal after the first is a re-proposal the user asked for, and
      // is named as one so its cost is attributable rather than buried in the
      // first attempt's line. There is no cap: the user decides how many
      // directions are worth paying for.
      const res = await meteredClaude({
        admin, scanId, startedAt,
        stage: proposalNo > 1 ? `rebuild_design_reproposal_${proposalNo}` : "rebuild_design",
      }, {
        apiKey, model: MODEL, effort: "medium", maxTokens: 4000, stream: true,
        system: DESIGN_SYSTEM, schema: designSchema(rtlSite), userContent, timeoutMs: 135_000,
      });

      const out = (res.json ?? {}) as {
        design_direction?: Direction;
        meta?: { purpose?: string; audience?: string; tone?: string };
      };
      const direction = out.design_direction ?? (scan.design_direction as Direction | null);
      const md = out.meta ?? {};

      // The spec is the deterministic ledger plus the model's soft descriptors —
      // name, language, dir, facts, sections and components all come from the page.
      const spec: Spec = {
        meta: {
          name: ledger.meta.name,
          purpose: md.purpose ?? "",
          language: ledger.meta.language,
          audience: md.audience ?? "",
          tone: md.tone ?? "",
        },
        dir: ledger.dir,
        facts: ledger.facts,
        sections: ledger.sections as Section[],
        components: ledger.components.map((c) => ({
          name: c.name,
          purpose: "",
          container_id: c.container_id,
          script_index: c.script_index,
        })),
        // The share image must be a real image off the real page.
        images: extractImageUrls(rawTarget),
      };

      // The design brief, derived from the site being replaced rather than
      // invented. Stored with the spec so the shell pass can state a floor in the
      // same request that lists the prohibitions.
      const depthBrief = richnessTargets(collectCss(pristine, target));
      await writeJson(admin, P.spec, {
        spec,
        design_direction: direction,
        scripts,
        target,
        styleText: ledger.styleText,
        depth_target: depthBrief,
      });
      // Reset any prior section builds from an earlier run.
      await writeJson(admin, P.sections, []);

      const parts = 2 + spec.sections.length; // spec + shell + one per section

      // What this build is going to be, from the deterministic ledger — before
      // a single section is paid for. Widget sections are carried verbatim and
      // cost nothing, so sections_total over-predicts; sections_model is the N
      // the cost equation multiplies. Recording it here (rather than counting
      // stage_usage afterwards) is what lets a build that DIED half-way still
      // say how big it was going to be, instead of looking like a small one.
      const widgetSections = spec.sections.filter(isWidgetSection).length;
      const buildShape = {
        sections_total: spec.sections.length,
        sections_widget: widgetSections,
        sections_model: spec.sections.length - widgetSections,
        components: spec.components?.length ?? 0,
        facts: spec.facts?.length ?? 0,
      };

      const { error: shapeErr } = await admin.from("scans").update({
        design_direction: direction ?? scan.design_direction ?? null,
        site_url: siteUrl,
        pipeline_status: "applying",
        build_shape: buildShape,
        // A fresh attempt must not inherit the error of the one before it.
        error: null,
      }).eq("id", scanId);
      if (shapeErr) console.error(`[usage] build_shape not recorded for ${scanId}: ${shapeErr.message}`);

      return json({
        ok: true, scan_id: scanId, part, parts, done: false,
        design_direction: direction, spec_summary: {
          name: spec.meta?.name, sections: spec.sections.map((s) => ({ id: s.id, type: s.type, heading: s.heading })),
        },
      });
    }

    // For parts > 1 the spec must already exist.
    const stored = await readJson<{
      spec: Spec;
      design_direction: Direction | null;
      scripts: string[];
      target: string;
      styleText?: string;
      depth_target?: string;
    }>(admin, P.spec);
    if (!stored || !stored.spec) throw new Error("spec_missing_run_part_1");
    const { spec, target, scripts } = stored;
    const styleText = stored.styleText ?? "";
    const depthTarget = stored.depth_target ?? "";
    const direction = stored.design_direction ?? (scan.design_direction as Direction | null);
    const parts = 2 + spec.sections.length;
    if (part > parts) part = parts;

    // ---------- PART 2: shell (tokens + header/footer + fonts) ----------
    if (part === 2) {
      const userContent =
        `<meta>\n${JSON.stringify(spec.meta, null, 2)}\ndir: ${spec.dir}\n</meta>\n\n` +
        `<design_direction>\n${JSON.stringify(direction ?? {}, null, 2)}\n</design_direction>\n\n` +
        `<facts>\n${(spec.facts ?? []).join("\n")}\n</facts>\n\n` +
        (originalLook
          ? `<original_look note="The OLD design being replaced. Do NOT reuse its palette or fonts — depart from it.">\n${originalLook}\n</original_look>\n\n`
          : "") +
        `<avoid_ai_patterns>\n${avoidList}\n</avoid_ai_patterns>\n\n` +
        // The prohibitions above are only half an instruction. Without a floor
        // the builder satisfies all 45 of them by removing every device it has,
        // which is how one run came back at 58% of the original's design depth
        // and scored better for it.
        (depthTarget ? `${depthTarget}\n\n` : "") +
        `Build the global shell: head_extras, tokens_css, header_html, footer_html.`;

      const res = await meteredClaude({ admin, scanId, startedAt, stage: "rebuild_shell" }, {
        apiKey, model: MODEL, effort: "high", maxTokens: 12000, stream: true,
        system: SHELL_SYSTEM + NEVER_INTRODUCE, schema: SHELL_SCHEMA, userContent, timeoutMs: 135_000,
      });

      const shell = (res.json ?? {}) as Shell;
      if (!shell.tokens_css) throw new Error("empty_shell");
      await writeJson(admin, P.shell, shell);
      return json({ ok: true, scan_id: scanId, part, parts, done: false, phase: "shell" });
    }

    // ---------- PARTS 3..(2+S): one section each ----------
    const shell = await readJson<Shell>(admin, P.shell);
    if (!shell) throw new Error("shell_missing_run_part_2");
    const sectionIndex = part - 3;
    const section = spec.sections[sectionIndex];
    if (!section) return json({ ok: true, scan_id: scanId, part, parts, done: true });

    const built0 = (await readJson<BuiltSection[]>(admin, P.sections)) ?? [];

    let sectionHtml: string;
    let sectionCss: string;
    let cssRepaired = false;

    if (isWidgetSection(section)) {
      // Interactive section: carried verbatim so the script's DOM survives, its
      // original styles scoped under a private wrapper. No model call — this path
      // cannot drift, cannot drop the widget, and cannot orphan its script.
      const rendered = renderWidgetSection(section, styleText, widgetWrapId(sectionIndex));
      sectionHtml = rendered.html;
      sectionCss = rendered.css;
    } else {
      /* Each section is built in its own request, so without this it cannot see
         what the others look like — and independently reaching for the same
         device is exactly how every section ended up with a kicker label, and in
         another run with the same bento grid. Show it the markup already built so
         it can deliberately do something else. */
      const previous = built0
        .filter((s) => s.index < sectionIndex)
        .sort((a, b) => b.index - a.index)
        .slice(0, 3)
        .map((s) => `--- section ${s.index + 1} ---\n${clip(s.html, 700)}`)
        .join("\n\n");
      const alreadyBuilt = previous
        ? `<already_built_sections>\n${previous}\n</already_built_sections>\n\n` +
          `The sections above are already on this page. Give THIS section a visibly ` +
          `different composition — do not repeat their layout pattern, their heading ` +
          `treatment, or any small label above the heading.\n\n`
        : "";

      const userContent =
        `<design_direction>\n${JSON.stringify(direction ?? {}, null, 2)}\n</design_direction>\n\n` +
        `<tokens_css>\n${shell.tokens_css}\n</tokens_css>\n\n` +
        `<dir>${spec.dir}</dir>\n\n` +
        (avoidList ? `<avoid_ai_patterns>\n${avoidList}\n</avoid_ai_patterns>\n\n` : "") +
        `<section_spec>\n${JSON.stringify(section, null, 2)}\n</section_spec>\n\n` +
        alreadyBuilt +
        `Build ONLY this section (html + css) and include EVERY item in section_spec.items — all of them, not a sample. Lay it out like a human designer would — not the symmetric, centred default a generator produces.`;

      /* Sections produce nearly all of the page's markup and CSS, so they get the
         same effort the shell already had — this stage was the one doing the most
         work on the least thinking. */
      const res = await meteredClaude(
        { admin, scanId, startedAt, stage: `rebuild_section_${sectionIndex + 1}` },
        {
          apiKey, model: MODEL, effort: "high", maxTokens: 10000, stream: true,
          system: SECTION_SYSTEM + avoidBlock, schema: SECTION_BUILD_SCHEMA, userContent, timeoutMs: 135_000,
        },
      );

      const built = (res.json ?? {}) as { html?: string; css?: string };
      const modelHtml = built.html ? ensureSectionId(built.html, section.id) : "";

      // Completeness floor: if the model dropped content (kept a sample of a
      // repeated group, or skipped copy), render every item from the ledger
      // instead. The page always ships whole — the guarantee never depends on the
      // model getting it right, and there is no failure branch.
      const lostFacts = modelHtml ? missingSectionFacts(modelHtml, section) : [];

      // Close the braces before this section's CSS is concatenated with the
      // others. A section that came back mid-rule does not break itself, it
      // eats every rule below it in the assembled <style> — and it does that on
      // the failure path too, because the floor renderer replaces the model's
      // MARKUP and carries its CSS through unchanged.
      const balanced = balanceCss(built.css ?? "");
      cssRepaired = balanced.changed;

      if (modelHtml && sectionCoverage(modelHtml, section) >= 0.85 && !lostFacts.length) {
        sectionHtml = modelHtml;
        sectionCss = balanced.css;
      } else {
        const floor = renderContentSection(section);
        sectionHtml = floor.html;
        sectionCss = balanced.css ? `${balanced.css}\n${floor.css}` : floor.css;
      }
    }

    // Accumulate this section (merge-upload, keyed by index). Parts run strictly
    // one at a time per scan, so the copy read before the call is still current.
    const merged = built0.filter((s) => s.index !== sectionIndex);
    merged.push({ index: sectionIndex, html: sectionHtml, css: sectionCss, cssRepaired });
    await writeJson(admin, P.sections, merged);

    const done = part >= parts;
    // Findings from the final part, returned with the deliverable so the
    // dashboard can show them next to the download rather than instead of it.
    let deliveryWarnings: Array<{ kind: string; detail: string; items: unknown }> = [];
    if (done) {
      // Every section built — assemble the final self-contained document.
      const assembled = assemble(spec, shell, merged, scripts, siteUrl);

      // The original is read before anything is judged against it: the
      // self-check needs it to know which ids the page's scripts require, the
      // dead-asset sweep needs it to know what is orphaned, and the
      // preservation guard needs it to know what was there. A run that cannot
      // compare must not pretend it did.
      const { data: origFile, error: origErr } = await admin.storage
        .from("scans").download(P.bundle);
      if (origErr || !origFile) throw new Error("bundle_not_found");
      const originals = parseBundle(await origFile.text());

      // Audit our own output and repair what code can repair. The builder is
      // asked in two prompts not to emit emoji or physical CSS properties; it
      // mostly complies and occasionally does not, and both are high-weight
      // signals still lit after real rebuilds. It also re-attaches the ids the
      // carried scripts need but the rebuilt header dropped. Every repair is
      // verified by a second detector pass, and all of it runs BEFORE the
      // preservation guard so the guard validates the bytes that actually ship.
      const check = selfCheck(target, assembled, originals);
      const full = check.html;
      const editedMap = new Map<string, string>([[target, full]]);

      // Carry the new design to the pages this run did not build.
      //
      // The audit scores the whole site, because the whole site is what ships:
      // one rebuilt page overlaid on every original nobody touched. Measured on
      // a real four-page run, that gap WAS most of the remaining score — 18 of
      // the 34 signals still present were evidenced only on pages the rebuild
      // had never opened, against 13 on the rebuilt page itself.
      //
      // This re-values their palette and type, gives them the new header and
      // footer, and runs the same self-check over them. It is text work: no
      // model call, no token, no added cost to a run. It is NOT a rebuild, and
      // the signals living in a page's own content and structure survive it.
      const redress = redressSecondaryPages(originals, shell, target);
      for (const [path, content] of redress.files) editedMap.set(path, content);

      // The rebuilt page is self-contained: its CSS is inline and the original
      // <script> blocks are carried inside it. That leaves the old stylesheet
      // orphaned — nothing links it, and it still shipped to the user and still
      // scored against them. Measured on a real rebuild, one dead style.css kept
      // #64 alive with all 8 of its physical properties and dragged #77 in with
      // it, so two of the remaining signals were pure dead code.
      //
      // Only assets nothing references are dropped, and only after the whole
      // project is assembled — a stylesheet a page we did NOT rebuild still
      // links stays exactly where it is.
      for (const dead of unreferencedAssets(new Map([...originals, ...editedMap]))) {
        editedMap.set(dead, DELETED_FILE);
      }
      const up = await admin.storage.from("scans").upload(
        P.edited,
        new Blob([serializeBundle(editedMap)], { type: "text/plain" }),
        { upsert: true, contentType: "text/plain" },
      );
      if (up.error) throw new Error(`storage: ${up.error.message}`);

      // The safety net. The score cannot tell cleaning apart from deleting —
      // signals live inside content, so a page that loses half its body loses
      // half its signals and reports a large improvement. One real run shipped
      // with 94% of the site gone and scored 47 -> 33 for it.
      //
      // The bundle above is uploaded first and on purpose: a run that fails
      // here still cost real money, and the artefact has to be inspectable.
      // What the failure withholds is DELIVERY — the scan never reaches
      // "applied", so the dashboard offers no download and no pull request.
      const shipped = assembleFinalFiles(originals, editedMap);

      // Second floor, same idea as the first. The audit only measures what is
      // WRONG, so stripping a site's design language scores as a triumph: one
      // run cleared 30 signals, scored 50 -> 19, and came back with 47 colours
      // reduced to 12, every gradient and shadow gone, and six font weights
      // down to three. Nothing was broken and nothing was lost — the builder
      // obeyed 45 prohibitions and had nothing left to design with.
      //
      // Parity with the original is the bar, by product decision. The check is
      // on design DEPTH as a total across substitutable categories, never on
      // specific devices: requiring the gradients back would reintroduce the
      // very signals we are paid to remove.
      const depth = checkRichness(originals, shipped, target);

      const guard = checkPreservation({
        original: originals,
        rebuilt: shipped,
        page: target,
      });
      // Both checks REPORT. Neither refuses.
      //
      // They used to withhold the build, and the reasoning was that a result we
      // know is damaged should not be handed over. What that missed is who pays
      // for the certainty. A refusal confiscates work the user already bought,
      // so it is only defensible when the finding is beyond doubt — and the
      // design floor is a proxy for "does this look good", which it cannot be
      // certain about. It proved that by blocking a build whose content was
      // whole, whose scripts ran clean, and whose palette was better organised
      // than the original's; the fault was in the measure, not the page.
      //
      // So the findings travel with the deliverable instead of replacing it.
      // Nothing is hidden — the original failure was a lossy run passing
      // SILENTLY — and nothing is seized. The user reads what we found and
      // decides whether to ship it or build again.
      //
      // Broken CSS travels the same way, and for the same reason. The braces
      // are already closed by the time this runs — on the page that ships, not
      // only in a message — so the finding is not "we refused", it is "we
      // repaired this, look at it". A structurally broken stylesheet is the one
      // failure a user cannot see in a screenshot and can see instantly in a
      // browser, so it is worth naming.
      const repairedSections = merged
        .filter((s) => s.cssRepaired)
        .map((s) => s.index + 1)
        .sort((a, b) => a - b);
      const cssBroken = repairedSections.length > 0 || check.cssBalance.changed;

      const warnings: Array<{ kind: string; detail: string; items: unknown }> = [
        ...(guard.ok ? [] : [{ kind: "content_loss", detail: summarize(guard), items: guard.failures }]),
        ...(depth.ok ? [] : [{ kind: "design_thin", detail: depth.detail, items: depth.thinnest }]),
        ...(cssBroken
          ? [{
            kind: "css_repaired",
            // The user-facing sentence lives in the dashboard, keyed by kind,
            // in both languages. This line is the evidence next to it.
            detail: `sections repaired: ${repairedSections.join(", ") || "none"}; ` +
              `page: +${check.cssBalance.added} closing, -${check.cssBalance.dropped} stray` +
              (check.cssBalance.unbalanced ? "; STILL UNBALANCED" : ""),
            items: { sections: repairedSections, page: check.cssBalance },
          }]
          : []),
      ];
      deliveryWarnings = warnings;

      await admin.from("scans").update({
        pipeline_status: "applied",
        // What the self-check repaired, what it could not, and what a
        // deterministic re-scan of the shipped page still finds. Stored so the
        // next run is judged against a record rather than a memory.
        // Recorded whether or not they passed, so a run's weaknesses are on the
        // record next to its result rather than only in a message that scrolled
        // away.
        self_check: {
          warnings,
          content_ok: guard.ok,
          design_depth: { ratio: depth.ratio, before: depth.before.total, after: depth.after.total },
          css_balance: { sections: repairedSections, page: check.cssBalance },
          restored_hooks: check.restoredHooks,
          repaired: check.repaired,
          unrepaired: check.unrepaired,
          still_present: check.stillPresent,
          // What the free pass over the un-rebuilt pages actually did. On the
          // record so the next run can tell a weak build apart from a build
          // that was only ever allowed to touch a quarter of the site.
          redress: {
            pages: redress.pages,
            stylesheets: redress.stylesheets,
            colour_moves: redress.moves.length,
            repaired: redress.repaired,
            skipped: redress.skipped,
          },
        },
        // Only a run that reached here is deliverable, so clear whatever a
        // previous failed attempt left behind. Without this a scan can sit as
        // "applied" while still carrying an error from an earlier try, which is
        // exactly how one run looked delivered and broken at the same time.
        error: null,
        change_log: present.map((s) => ({
          signal_id: s.id, file: target, applied: true, applied_by: "rebuild", reason: null,
        })),
      }).eq("id", scanId);
    }

    return json({
      ok: true, scan_id: scanId, part, parts, done,
      phase: "section", section: { id: section.id, type: section.type, heading: section.heading },
      design_direction: direction,
      warnings: deliveryWarnings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `rebuild: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
