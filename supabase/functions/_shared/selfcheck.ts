// Self-check — audit the page we just built, and repair what we broke.
//
// The rebuild is measured on what it CLEARS, but it also INTRODUCES. The best
// run on record cleared 17 signals and introduced 4, and eight of the signals
// still lit afterwards were ones the catalogue marks as ours to fix. Asking the
// builder more firmly not to do those things has been tried three times; each
// round it complied with the new instruction and broke something adjacent.
//
// So this does not ask. It runs the same deterministic detector the audit uses
// over the assembled page, repairs what can be repaired in code, and runs the
// detector again to prove the repair landed. No model, no cost, no judgement —
// which is also why it only covers signals with a mechanical check behind them.
// A repair we cannot verify is not a repair, it is a hope.
//
// Scope is deliberately narrow: emoji and physical CSS properties. Both are
// high-weight, both were still lit after real rebuilds, and both have an
// unambiguous correct answer. Everything else stays with the builder.

import { EMOJI_RE, mechanicalSignals } from "./mechanical.ts";
import { NOT_COUNTED } from "./catalogue.ts";
import { collectJs, scriptHooks } from "./preservation.ts";

// The detector's own definition, imported rather than restated: a strip here
// and a check there must never disagree about what an emoji is.
const EMOJI = EMOJI_RE;

// ============================================================
// #109 — emoji the reader can see
// ============================================================

/**
 * Strip emoji from the text a visitor reads, and only from there.
 *
 * The builder is told twice, in two prompts, never to emit one. It mostly
 * obeys and occasionally does not, and a single emoji is enough to light a
 * high-weight signal — so the last word belongs to code.
 *
 * Script and style bodies are left alone: an emoji inside a string literal is
 * the site's own data, removing it could change behaviour, and the detector
 * does not look there for an HTML file either.
 */
export function stripVisibleEmoji(html: string): { html: string; removed: number } {
  let removed = 0;
  const protectedRanges: Array<[number, number]> = [];
  for (const m of html.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    protectedRanges.push([m.index!, m.index! + m[0].length]);
  }
  const isProtected = (i: number) => protectedRanges.some(([a, b]) => i >= a && i < b);

  const out = html.replace(EMOJI, (match, offset: number) => {
    if (isProtected(offset)) return match;
    removed += 1;
    return "";
  });
  // Stripping a leading emoji leaves "  Heading" or " — Heading" behind.
  return { html: collapseOrphanedSpacing(out), removed };
}

function collapseOrphanedSpacing(html: string): string {
  return html
    .replace(/>[ \t]+([^<]*?)[ \t]+</g, (m) => m.replace(/[ \t]{2,}/g, " "))
    .replace(/>\s*[—–-]\s*</g, "><");
}

// ============================================================
// #64 — physical CSS properties in a right-to-left page
// ============================================================

const PHYSICAL: Array<[RegExp, string]> = [
  [/\bmargin-left\s*:/gi, "margin-inline-start:"],
  [/\bmargin-right\s*:/gi, "margin-inline-end:"],
  [/\bpadding-left\s*:/gi, "padding-inline-start:"],
  [/\bpadding-right\s*:/gi, "padding-inline-end:"],
  [/\bborder-left\s*:/gi, "border-inline-start:"],
  [/\bborder-right\s*:/gi, "border-inline-end:"],
  [/\bborder-left-(\w+)\s*:/gi, "border-inline-start-$1:"],
  [/\bborder-right-(\w+)\s*:/gi, "border-inline-end-$1:"],
  [/\bfloat\s*:\s*left\b/gi, "float: inline-start"],
  [/\bfloat\s*:\s*right\b/gi, "float: inline-end"],
  [/\btext-align\s*:\s*left\b/gi, "text-align: start"],
  [/\btext-align\s*:\s*right\b/gi, "text-align: end"],
];

// A bare "left: 12px" — but not the tail of "border-left:", which the loop
// above has already rewritten, and not "auto", which the detector ignores.
const BARE_INSET = /(^|[{;\s])(left|right)\s*:\s*(?!auto\b)/gi;

function toLogicalCss(css: string): string {
  let out = css;
  for (const [re, to] of PHYSICAL) out = out.replace(re, to);
  return out.replace(
    BARE_INSET,
    (_m, lead: string, side: string) =>
      `${lead}inset-inline-${side.toLowerCase() === "left" ? "start" : "end"}: `,
  );
}

/**
 * Rewrite our own CSS to logical properties, and leave the site's alone.
 *
 * A widget is carried over verbatim with its original stylesheet scoped under
 * a private wrapper. That CSS was written by someone who meant "left" — flipping
 * it would move their quiz's buttons to the other side of the box. Any rule
 * whose selector names the widget wrapper is therefore skipped. Everything
 * else in the page is CSS this pipeline generated, where "left" only ever
 * meant "start".
 */
export function logicalCssOutsideWidgets(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) {
      out += toLogicalCss(css.slice(i));
      break;
    }
    // Walk to the matching close brace so nested at-rules stay intact.
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const end = j < css.length ? j + 1 : css.length;
    const prelude = css.slice(i, open);
    const block = css.slice(open, end);
    const isWidget = prelude.includes("#rb-widget-") || block.includes("#rb-widget-");
    out += isWidget ? prelude + block : toLogicalCss(prelude + block);
    i = end;
  }
  return out;
}

/** Apply the CSS rewrite to every <style> block and every inline style attribute. */
export function logicalProperties(html: string): { html: string; changed: number } {
  let changed = 0;
  const count = (before: string, after: string) => {
    if (before !== after) changed += 1;
  };

  let out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, body: string, close: string) => {
      const next = logicalCssOutsideWidgets(body);
      count(body, next);
      return open + next + close;
    },
  );

  out = out.replace(/\sstyle\s*=\s*"([^"]*)"/gi, (m, body: string) => {
    const next = toLogicalCss(body);
    count(body, next);
    return next === body ? m : ` style="${next}"`;
  });

  return { html: out, changed };
}

// ============================================================
// Script hooks that live in the page's chrome
// ============================================================

// Only the structural elements. Re-attaching an id to a <div> would be a guess
// about which of dozens is the right one; a page has one <nav>.
const CHROME_TAGS = ["nav", "header", "footer", "main", "aside"];

/**
 * Put back an id the page's own script needs and the rebuild did not keep.
 *
 * The header and nav are site chrome: the ledger deliberately does not treat
 * them as content, and the shell rebuilds them from scratch. That is right for
 * the markup and wrong for the hooks — on a real run the original's
 * `<nav id="nav">` came back as a plain `<nav>`, and script.js dereferenced
 * null on every scroll.
 *
 * The id is only restored when the answer is unambiguous: the original carried
 * it on a structural tag, and the rebuilt page has exactly one element of that
 * tag with no id of its own. Anything less certain is left alone and reported
 * as missing, because a hook attached to the wrong element is worse than a
 * hook that is honestly absent.
 */
export function restoreChromeHooks(
  originalPage: string,
  files: Map<string, string>,
  builtHtml: string,
): { html: string; restored: string[] } {
  const hooks = scriptHooks(collectJs(files));
  const restored: string[] = [];
  let out = builtHtml;

  for (const id of hooks.ids) {
    if (hasId(out, id)) continue;
    const tag = chromeTagCarrying(originalPage, id);
    if (!tag) continue;

    // Chrome lives outside <main>. Without that restriction a rebuilt page with
    // three section <header>s and one site <header> looks ambiguous and the
    // hook is dropped — which is exactly what happened on the furniture site.
    const searchable = maskMain(out);
    const candidates = [...searchable.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))]
      .filter((m) => !/\bid\s*=/i.test(m[1]));
    if (candidates.length !== 1) continue;

    const m = candidates[0];
    out = out.slice(0, m.index!) + `<${tag} id="${id}"${m[1]}>` + out.slice(m.index! + m[0].length);
    restored.push(`#${id}`);
  }
  return { html: out, restored };
}

/**
 * Blank out the <main> region, keeping every character position intact so a
 * match found here still points at the right offset in the original string.
 */
function maskMain(html: string): string {
  return html.replace(
    /<main\b[\s\S]*?<\/main>/gi,
    (m) => " ".repeat(m.length),
  );
}

function chromeTagCarrying(html: string, id: string): string | null {
  for (const tag of CHROME_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, "i");
    if (re.test(html)) return tag;
  }
  return null;
}

function hasId(html: string, id: string): boolean {
  return new RegExp(`\\sid\\s*=\\s*["']${escapeRegExp(id)}["']`, "i").test(html);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// Structurally broken CSS
// ============================================================

/** What a balance pass did, and whether the result can be trusted. */
export interface CssBalanceReport {
  /** Closing braces appended because the text ran out mid-rule. */
  added: number;
  /** Stray "}" at depth zero, dropped. */
  dropped: number;
  /** An unterminated comment or string the pass had to close. */
  closedLiteral: boolean;
  /** True if anything was repaired. */
  changed: boolean;
  /** The repair did not verify. Should be impossible; reported, never assumed. */
  unbalanced: boolean;
}

/** A balance pass over one stylesheet: the report, plus the repaired text. */
export interface CssBalance extends CssBalanceReport {
  css: string;
}

/**
 * Close the braces a truncated stylesheet left open.
 *
 * A missing "}" does not break one rule, it eats every rule after it: the
 * parser keeps reading declarations into a block that never ends. The rebuild
 * concatenates every section's CSS into a single <style>, so one section that
 * came back mid-rule silently deletes the design of all the sections below it —
 * including FALLBACK_CSS, the completeness floor's own styling.
 *
 * That is the real damage, and it survives the failure path: when a section's
 * markup is rejected and re-rendered from the ledger, the model's CSS is still
 * carried into the page.
 *
 * So this is binary, cheap and deterministic, in the spirit of the rest of this
 * module: count braces outside comments and strings, append what is missing,
 * drop a "}" that closes nothing. It does not attempt to understand the CSS —
 * a repaired tail may be an odd rule, but it is a rule the parser survives,
 * and everything after it lives.
 */
export function balanceCss(css: string): CssBalance {
  const scan = scanBraces(css);
  let out = css;
  let dropped = 0;

  // A "}" with nothing open before it. Left in place it is harmless to the
  // parser but it means the count lies, so it goes.
  if (scan.strayCloses.length) {
    dropped = scan.strayCloses.length;
    const drop = new Set(scan.strayCloses);
    out = [...out].filter((_, i) => !drop.has(i)).join("");
  }

  // Truncated inside a comment or a string: close it first, or the braces we
  // append land inside it and change nothing.
  let closedLiteral = false;
  if (scan.endedIn === "comment") {
    out += " */";
    closedLiteral = true;
  } else if (scan.endedIn === "string") {
    out += scan.quote;
    closedLiteral = true;
  }

  const after = scanBraces(out);
  const added = after.depth;
  if (added > 0) out += "\n" + "}".repeat(added);

  const changed = added > 0 || dropped > 0 || closedLiteral;
  // Verify rather than trust — the same rule the emoji and RTL repairs follow.
  const proof = scanBraces(out);
  const unbalanced = proof.depth !== 0 || proof.strayCloses.length > 0;

  return { css: out, added, dropped, closedLiteral, changed, unbalanced };
}

type ScanEnd = "normal" | "comment" | "string";

/**
 * Brace depth, ignoring braces that are not structure: inside comments and
 * inside quoted strings (content: "{", a font family, a data URI).
 */
function scanBraces(css: string): {
  depth: number;
  strayCloses: number[];
  endedIn: ScanEnd;
  quote: string;
} {
  let depth = 0;
  const strayCloses: number[] = [];
  let i = 0;
  let endedIn: ScanEnd = "normal";
  let quote = "";

  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) { endedIn = "comment"; break; }
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const closed = skipString(css, i);
      if (closed === -1) { endedIn = "string"; quote = c; break; }
      i = closed;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0) strayCloses.push(i);
      else depth -= 1;
    }
    i += 1;
  }
  return { depth, strayCloses, endedIn, quote };
}

/** Index just past the closing quote, or -1 if the string never closes. */
function skipString(css: string, start: number): number {
  const q = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === "\\") { i += 1; continue; }
    if (css[i] === q) return i + 1;
    // A newline ends a CSS string; the value is invalid, but it is not an
    // unterminated string swallowing the rest of the sheet.
    if (css[i] === "\n") return i;
  }
  return -1;
}

// ============================================================
// The loop
// ============================================================

export interface SelfCheckResult {
  html: string;
  /** Script hooks re-attached to the rebuilt chrome. */
  restoredHooks: string[];
  /** Signal ids this pass repaired, proven absent by a re-scan. */
  repaired: number[];
  /** Signal ids a repair targeted that the re-scan still finds. */
  unrepaired: number[];
  /** Mechanically detected signals still present after the repair. */
  stillPresent: number[];
  /** What the brace-balance pass had to repair in the assembled <style>. */
  cssBalance: CssBalanceReport;
}

/** The signals this module knows how to repair, and can prove it repaired. */
export const REPAIRABLE = [64, 109] as const;

/**
 * Audit the built page, repair what is repairable, and verify by re-auditing.
 *
 * The verification is the point. A repair that silently fails is worse than no
 * repair at all, because the run then reports a fix that is not there —
 * exactly the failure mode that let a rebuild delete a site and call it an
 * improvement.
 */
export function selfCheck(
  page: string,
  html: string,
  original?: Map<string, string>,
): SelfCheckResult {
  const before = presentMechanical(page, html);

  let out = html;
  const emoji = stripVisibleEmoji(out);
  out = emoji.html;
  const css = logicalProperties(out);
  out = css.html;

  // Last net under the per-section pass in rebuild. A <style> block that ran
  // out mid-rule silently deletes every rule below it, so it is closed here
  // before anything else is measured against this page.
  const balance = balanceStyleBlocks(out);
  out = balance.html;

  let restoredHooks: string[] = [];
  if (original) {
    const hooks = restoreChromeHooks(original.get(page) ?? "", original, out);
    out = hooks.html;
    restoredHooks = hooks.restored;
  }

  const after = presentMechanical(page, out);
  const targeted = REPAIRABLE.filter((id) => before.includes(id));

  return {
    html: out,
    restoredHooks,
    repaired: targeted.filter((id) => !after.includes(id)),
    unrepaired: targeted.filter((id) => after.includes(id)),
    stillPresent: after,
    cssBalance: balance.result,
  };
}

/**
 * Balance every <style> block in a document, reporting them as one.
 *
 * The blocks are independent stylesheets, so each is repaired on its own; the
 * totals are summed because what the caller needs to know is whether the page
 * that ships had broken CSS in it at all.
 */
function balanceStyleBlocks(html: string): { html: string; result: CssBalanceReport } {
  let added = 0, dropped = 0, closedLiteral = false, unbalanced = false;
  const out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_whole, open: string, body: string, close: string) => {
      const b = balanceCss(body);
      added += b.added;
      dropped += b.dropped;
      closedLiteral = closedLiteral || b.closedLiteral;
      unbalanced = unbalanced || b.unbalanced;
      return open + b.css + close;
    },
  );
  return {
    html: out,
    result: {
      added,
      dropped,
      closedLiteral,
      changed: added > 0 || dropped > 0 || closedLiteral,
      unbalanced,
    },
  };
}

// Signals the catalogue does not score a site on are dropped here too, so the
// self-check and the report cannot disagree about what is still outstanding.
const UNCOUNTED = new Set(NOT_COUNTED.map((n) => n.id));

function presentMechanical(page: string, html: string): number[] {
  return mechanicalSignals(new Map([[page, html]]))
    .filter((s) => s.present === true && s.applicable !== false)
    .map((s) => Number(s.id))
    .filter((id) => !UNCOUNTED.has(id))
    .sort((a, b) => a - b);
}
