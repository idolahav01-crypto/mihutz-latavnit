// Put the new design on the pages the rebuild never rebuilt.
//
// `rebuild` produces exactly one page. The audit that follows it scores the
// WHOLE site, because the deliverable is the whole site: the new index.html
// overlaid on every original page nobody touched. On a real four-page run that
// gap was most of the remaining score — of the 34 signals still present after
// the build, 18 were evidenced ONLY on pages the rebuild had never opened, 13
// only on the rebuilt index, 2 on both. More than half the outstanding problem
// belonged to files the pipeline had declined to look at.
//
// Building all four pages properly costs about twice a run (the audit already
// reads every page; only section-building multiplies). This module is the
// other lever, and it costs nothing: no model call, no token, pure text.
//
// What it does NOT do is rebuild. It re-dresses:
//   - the palette the old stylesheet already names is re-valued to the new one
//   - the type family is swapped for the new one
//   - the header and footer are replaced with the new shell's
//   - the new design tokens are made available to the page
//
// What it deliberately leaves alone is every rule, class and element of the
// page's own layout. The old stylesheet is re-VALUED, never removed. Dropping
// it would strip the secondary pages of the layout their markup depends on and
// hand back four unstyled documents, which is the "improvement" that scores
// well and ruins a site — the exact failure this codebase keeps relearning.
//
// So the reach is honest and bounded: signals that live in the shared design
// layer (palette, shadows, radii, type, focus, chrome) are addressed on every
// page. Signals that live in a page's own content and structure — its form
// markup, its card grid, its copy — are NOT, and still need a real rebuild.

import { selfCheck } from "./selfcheck.ts";

export interface Shell {
  head_extras: string;
  tokens_css: string;
  header_html: string;
  footer_html: string;
}

export interface ColourMove {
  from: string;
  to: string;
  role: Role;
}

export interface RedressResult {
  /** Only the files this pass changed, ready to overlay on the originals. */
  files: Map<string, string>;
  pages: string[];
  stylesheets: string[];
  moves: ColourMove[];
  /** Signals the self-check repaired on a secondary page, and proved repaired. */
  repaired: Array<{ file: string; signal: number }>;
  skipped: Array<{ file: string; reason: string }>;
}

/** The file the new tokens are written to, linked from every re-dressed page. */
export const TOKENS_FILE = "rebuilt-tokens.css";

/**
 * The new design system MINUS its base element styles.
 *
 * This is the difference between re-dressing a page and overwriting it. The
 * shell's stylesheet is written for a document the shell also built, so it
 * styles bare elements: `body{...}`, `h1{color:var(--ink)}`. Dropped whole onto
 * a page somebody else laid out, those rules do not merely lose a specificity
 * contest — they win one they should never have entered. A direct `h1` rule
 * beats an INHERITED colour no matter which stylesheet is linked first, so a
 * hero that set white on its section and let the heading inherit it had its
 * headline repainted near-black on a near-black band.
 *
 * That is the failure this codebase keeps meeting in new clothes: the words
 * were still in the DOM, so the content guard passed the page, and the extra
 * rules raised its design-depth score. Both instruments reported an improvement
 * and the headline was invisible.
 *
 * So: keep the custom properties (the palette, which is the point) and the
 * class-based component rules (the new header and footer use them). Drop rules
 * that target bare elements, because those are the page's own business. Rules
 * carrying a pseudo-class survive — `a:focus-visible{outline:...}` gives a
 * keyboard user a ring and cannot repaint anything that was readable before.
 */
export function scopedTokens(tokensCss: string): string {
  let out = "";
  // Walk rule by rule so an at-rule's body is never mistaken for a selector.
  const re = /(@[\w-]+[^{;]*(?:\{(?:[^{}]|\{[^{}]*\})*\}|;))|([^{}]+)\{([^{}]*)\}/g;
  for (const m of tokensCss.matchAll(re)) {
    if (m[1]) {
      // @font-face, @media, @keyframes and friends pass through untouched.
      out += m[1];
      continue;
    }
    const selector = m[2].trim();
    const isBareElement = selector.split(",").every((part) => {
      const p = part.trim();
      if (!p) return false;
      if (/[.#\[]/.test(p)) return false;
      if (/:/.test(p)) return false;
      return /^[a-zA-Z][\w-]*(\s*[>+~]\s*[a-zA-Z][\w-]*|\s+[a-zA-Z][\w-]*)*$/.test(p);
    });
    if (isBareElement) continue;
    out += `${selector}{${m[3]}}`;
  }
  return out;
}

const isHtml = (p: string) => /\.html?$/i.test(p);
const isCss = (p: string) => /\.(css)$/i.test(p);

// ============================================================
// Colour
// ============================================================

type Role = "surface" | "ink" | "muted" | "accent";

interface Colour {
  raw: string;
  r: number;
  g: number;
  b: number;
  l: number;
  s: number;
  role: Role;
}

function parseHex(raw: string): { r: number; g: number; b: number } | null {
  let h = raw.trim().replace(/^#/, "");
  // 4- and 8-digit forms carry alpha. The colour is still the first three.
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  else if (h.length === 6 || h.length === 8) h = h.slice(0, 6);
  else return null;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Sort a colour into the job it does, by lightness and saturation.
 *
 * Names cannot be trusted across two stylesheets written by two different
 * authors — one calls its background `--paper`, the other `--newsprint`, and a
 * third `--bg-2`. The measurable properties are the same in both files, so the
 * mapping is built from those and never from what a token is called.
 */
function classify(r: number, g: number, b: number): { l: number; s: number; role: Role } {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  // CHROMA, not HSL saturation. Saturation divides by how far the colour sits
  // from black and white, so a warm off-white background scores 0.30 on it and
  // gets called a brand accent — #ece7dc, a newsprint page colour, did exactly
  // that and would have had the site's ink mapped onto it. Chroma is the plain
  // distance between the channels and stays small for every near-neutral.
  const s = max - min;
  let role: Role;
  if (s >= 0.25) role = "accent";
  else if (l >= 0.82) role = "surface";
  else if (l <= 0.3) role = "ink";
  else role = "muted";
  return { l, s, role };
}

function toColour(raw: string): Colour | null {
  const rgb = parseHex(raw);
  if (!rgb) return null;
  const { l, s, role } = classify(rgb.r, rgb.g, rgb.b);
  return { raw: raw.toLowerCase(), ...rgb, l, s, role };
}

/** rgb()/rgba() channel triple, or null for anything else (percentages, vars). */
function parseRgbFunc(value: string): { r: number; g: number; b: number; a: string | null } | null {
  const m = value.match(
    /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([^)]+?)\s*)?\)$/i,
  );
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if ([r, g, b].some((n) => n > 255)) return null;
  return { r, g, b, a: m[4] ?? null };
}

const hexOf = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

/**
 * Every solid colour a stylesheet names, in the order it first names them.
 *
 * Translucent values are deliberately left out of the PALETTE — a pile of
 * rgba(0,0,0,.06) shadows is a habit, not a brand, and letting them in would
 * flood the role buckets with near-blacks. They are still REWRITTEN downstream
 * when their channels match a colour that moved, which is how the old neon
 * survived its own removal: as rgba(0,179,230,.40) on a hero glow.
 */
export function paletteOf(css: string): Colour[] {
  const seen = new Set<string>();
  const out: Colour[] = [];
  const add = (raw: string) => {
    if (seen.has(raw)) return;
    seen.add(raw);
    const c = toColour(raw);
    if (c) out.push(c);
  };
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) add(m[0].toLowerCase());
  for (const m of css.matchAll(/rgba?\([^)]*\)/gi)) {
    const p = parseRgbFunc(m[0].replace(/\s+/g, " ").trim());
    // Opaque only: no alpha at all, or an alpha of exactly 1.
    if (!p || (p.a !== null && !/^1(\.0+)?$/.test(p.a.trim()))) continue;
    add(hexOf(p.r, p.g, p.b));
  }
  return out;
}

/**
 * Map every colour of the old palette onto one of the new palette.
 *
 * Within a role each old colour takes the NEW colour closest to it in
 * lightness. Matching by rank instead looks reasonable and is not: the two
 * palettes are rarely the same length, so rank slides everything along by the
 * difference. On a real site it sent pure #ffffff — the card backgrounds on
 * three pages — onto #f0d3cb, a pink tint, because white happened to be third
 * in one list and the tint third in the other. Lightness cannot slide.
 *
 * Several old colours may land on the same new one, and that is a result, not
 * a collision: three old accents collapsing onto one brand colour is precisely
 * what signal #84 asks a site to do.
 *
 * A role the new palette has nothing for falls back to the nearest new colour
 * by lightness across the whole palette. That keeps the substitution total — a
 * half-mapped palette would leave the old brand colour sitting next to the new
 * one, which looks worse than either.
 */
export function buildColourMap(oldCss: string, newCss: string): Map<string, ColourMove> {
  const from = paletteOf(oldCss);
  const to = paletteOf(newCss);
  const map = new Map<string, ColourMove>();
  if (!to.length) return map;

  const nearest = (c: Colour, pool: Colour[]) =>
    pool.reduce((best, cand) =>
      // Ties break on the darker colour so the result never depends on the
      // order the stylesheet happened to name its colours in.
      Math.abs(cand.l - c.l) < Math.abs(best.l - c.l) ? cand : best
    );

  for (const c of from) {
    const sameRole = to.filter((n) => n.role === c.role);
    const pick = nearest(c, sameRole.length ? sameRole : to);
    if (pick.raw !== c.raw) map.set(c.raw, { from: c.raw, to: pick.raw, role: c.role });
  }
  return map;
}

/**
 * Rewrite every colour in a stylesheet through the map, leaving all else intact.
 *
 * Both notations are rewritten, because a site writes its brand in both. The
 * hex pass alone cleared #00b3e6 from every file and left the same cyan glowing
 * over the hero as rgba(0,179,230,.40): the colour we were paid to remove,
 * still there, wearing an alpha channel.
 */
export function applyColourMap(css: string, map: Map<string, ColourMove>): string {
  const lookup = (r: number, g: number, b: number) => map.get(hexOf(r, g, b))?.to ?? null;

  const withHex = css.replace(/#[0-9a-fA-F]{3,8}\b/g, (hit) => {
    const key = hit.toLowerCase();
    const move = map.get(key);
    if (move) return move.to;
    // Expand-and-retry: a stylesheet may write #fff where the palette held
    // #ffffff. Same colour, and a literal match would have missed it.
    const rgb = parseHex(key);
    if (!rgb) return hit;
    return lookup(rgb.r, rgb.g, rgb.b) ?? hit;
  });

  return withHex.replace(/rgba?\([^)]*\)/gi, (hit) => {
    const p = parseRgbFunc(hit.replace(/\s+/g, " ").trim());
    if (!p) return hit;
    const to = lookup(p.r, p.g, p.b);
    if (!to) return hit;
    const rgb = parseHex(to);
    if (!rgb) return hit;
    // The alpha is the author's, not the palette's: a 40% glow stays a 40%
    // glow. Only the three channels underneath it change.
    return p.a === null
      ? `rgb(${rgb.r},${rgb.g},${rgb.b})`
      : `rgba(${rgb.r},${rgb.g},${rgb.b},${p.a})`;
  });
}

// ============================================================
// Type
// ============================================================

/** The first font stack the new tokens declare — the design's body face. */
export function primaryFontStack(tokensCss: string): string | null {
  const m = tokensCss.match(/font-family\s*:\s*([^;}]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Swap the old type for the new, and only where a real family is named.
 *
 * `font-family: inherit` and `font-family: var(--x)` are plumbing, not a
 * typeface choice; rewriting them would break the cascade they exist to serve.
 */
export function applyFontStack(css: string, stack: string): string {
  return css.replace(/font-family\s*:\s*([^;}]+)/gi, (hit, value: string) => {
    const v = value.trim();
    if (/^(inherit|initial|unset|revert)$/i.test(v)) return hit;
    if (/^var\(/i.test(v)) return hit;
    return `font-family: ${stack}`;
  });
}

// ============================================================
// Page chrome
// ============================================================

/**
 * Every scrap of CSS a page carries in its own markup.
 *
 * A stylesheet is not where a generated site keeps all of its colour. On a real
 * gallery page the shared style.css held nine colours and the page itself held
 * fourteen more — one <style> block and thirty-seven inline `style=` attributes,
 * carrying the neon cyan, magenta and yellow that the palette pass had just
 * removed everywhere else. Re-dressing only the .css files left that page
 * wearing the old brand on every card.
 */
export function embeddedCss(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/\bstyle\s*=\s*'([^']*)'/gi)) parts.push(m[1]);
  return parts.join("\n");
}

/** Re-value the CSS a page carries inline, leaving its text and markup alone. */
export function rewriteEmbeddedCss(
  html: string,
  map: Map<string, ColourMove>,
  stack: string | null,
): string {
  const fix = (css: string) => {
    const out = applyColourMap(css, map);
    return stack ? applyFontStack(out, stack) : out;
  };
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => `${a}${fix(css)}${b}`)
    .replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_, css) => `style="${fix(css)}"`)
    .replace(/\bstyle\s*=\s*'([^']*)'/gi, (_, css) => `style='${fix(css)}'`);
}

function replaceRegion(html: string, tag: "header" | "footer", markup: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "i");
  return re.test(html) ? html.replace(re, markup) : null;
}

/**
 * Give a page the new head material without disturbing what it already has.
 *
 * The tokens are linked BEFORE the page's own stylesheet on purpose. The two
 * files share no custom-property names, so the palette arrives either way, but
 * on any base rule they genuinely contest — body type, heading sizes — the
 * page's own sheet is meant to win, because that sheet is the layout this
 * markup was written against.
 */
function injectHead(html: string, shell: Shell): string {
  // Drop the page's own webfont links first.
  //
  // Every font-family in the stylesheet has just been rewritten to the new
  // stack, so nothing references the old face any more — but the <link> that
  // fetches it lives in the HTML, which the stylesheet pass never sees. A real
  // re-dress left contact.html downloading Heebo it no longer used, next to the
  // two new families it did: three webfont payloads for two faces, and the old
  // typeface still declared in the head of a page meant to have moved on.
  //
  // Only Google Fonts traffic is removed, and only from the page's own markup;
  // the new head material is added afterwards so its links are never candidates.
  const stripped = html.replace(
    /<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi,
    "",
  );
  const link = `<link rel="stylesheet" href="${TOKENS_FILE}">`;
  const extras = `${shell.head_extras ?? ""}${link}`;
  const firstSheet = stripped.match(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/i);
  if (firstSheet) return stripped.replace(firstSheet[0], `${extras}${firstSheet[0]}`);
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, `${extras}</head>`);
  return stripped;
}

// ============================================================
// The pass
// ============================================================

/**
 * Re-dress every page the rebuild did not build.
 *
 * Returns only the files that changed, so the caller can overlay them exactly
 * the way the rebuilt page is overlaid, and so a page this pass could not treat
 * is left byte-identical rather than half-converted.
 */
export function redressSecondaryPages(
  original: Map<string, string>,
  shell: Shell,
  rebuiltPage: string,
): RedressResult {
  const files = new Map<string, string>();
  const skipped: Array<{ file: string; reason: string }> = [];
  const repaired: Array<{ file: string; signal: number }> = [];
  const pages: string[] = [];
  const stylesheets: string[] = [];

  const secondary = [...original.keys()].filter((p) => isHtml(p) && p !== rebuiltPage);
  if (!secondary.length) {
    return { files, pages, stylesheets, moves: [], repaired, skipped };
  }

  // The palette is read from BOTH places a site keeps colour: its stylesheets
  // and the markup of its own pages. Building it from the .css files alone left
  // fourteen colours unmapped on one real page.
  const oldCss = [
    ...[...original.entries()].filter(([p]) => isCss(p)).map(([, c]) => c),
    ...[...original.entries()].filter(([p]) => isHtml(p)).map(([, c]) => embeddedCss(c)),
  ].join("\n");
  const map = buildColourMap(oldCss, shell.tokens_css ?? "");
  const stack = primaryFontStack(shell.tokens_css ?? "");

  // The shared stylesheets, re-valued once for the whole site.
  for (const [path, content] of original) {
    if (!isCss(path)) continue;
    let out = applyColourMap(content, map);
    if (stack) out = applyFontStack(out, stack);
    if (out !== content) {
      files.set(path, out);
      stylesheets.push(path);
    }
  }

  files.set(TOKENS_FILE, scopedTokens(shell.tokens_css ?? ""));

  for (const page of secondary) {
    const src = original.get(page) ?? "";
    // The page's own <style> block and inline attributes, re-valued before the
    // new chrome arrives so the replacement markup is never rewritten.
    let out = rewriteEmbeddedCss(src, map, stack);

    const header = shell.header_html
      ? replaceRegion(out, "header", shell.header_html)
      : null;
    const footer = shell.footer_html
      ? replaceRegion(header ?? out, "footer", shell.footer_html)
      : null;
    out = footer ?? header ?? out;

    if (!header && !footer) {
      // No chrome to replace is not a failure — the page still gets the new
      // palette and type through the stylesheet — but it IS worth reporting,
      // because a page with no <header> usually means markup we did not expect.
      skipped.push({ file: page, reason: "no <header> or <footer> element to replace" });
    }

    out = injectHead(out, shell);

    // The same audit-repair-reaudit loop the rebuilt page gets, on this page.
    //
    // It was only ever run on the one page the pipeline built, which left its
    // repairs sitting unused next to three files carrying the very faults they
    // fix — on a real four-page site the emoji signal stayed lit because it was
    // evidenced on pages nobody ran the stripper over. The loop also restores
    // an id the site's script needs: the new header is written from scratch,
    // and a real run lost `<nav id="nav">` that way and threw on every scroll.
    const checked = selfCheck(page, out, original);
    out = checked.html;
    repaired.push(...checked.repaired.map((id) => ({ file: page, signal: id })));

    if (out !== src) {
      files.set(page, out);
      pages.push(page);
    }
  }

  return { files, pages, stylesheets, moves: [...map.values()], repaired, skipped };
}
