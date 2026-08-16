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
// The loop
// ============================================================

export interface SelfCheckResult {
  html: string;
  /** Signal ids this pass repaired, proven absent by a re-scan. */
  repaired: number[];
  /** Signal ids a repair targeted that the re-scan still finds. */
  unrepaired: number[];
  /** Mechanically detected signals still present after the repair. */
  stillPresent: number[];
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
export function selfCheck(page: string, html: string): SelfCheckResult {
  const before = presentMechanical(page, html);

  let out = html;
  const emoji = stripVisibleEmoji(out);
  out = emoji.html;
  const css = logicalProperties(out);
  out = css.html;

  const after = presentMechanical(page, out);
  const targeted = REPAIRABLE.filter((id) => before.includes(id));

  return {
    html: out,
    repaired: targeted.filter((id) => !after.includes(id)),
    unrepaired: targeted.filter((id) => after.includes(id)),
    stillPresent: after,
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
