// The tells the builder puts back after being told not to.
//
// buildAvoidBlock sends the model every fingerprint the audit found in this
// site, under the instruction "your section must not reproduce a single one".
// Measured on a real run, six came back anyway — a standard hero, a symmetric
// card grid, a kicker above every heading, a row of round numbers, one uniform
// shadow everywhere, and fade-in on scroll for every element. The prompt even
// forbids the eyebrow class by name; the model wrote them regardless.
//
// A prompt is a request. This file is the check, so a section that reproduces
// a fingerprint the original was flagged for can be sent back once with the
// violation named — the same move mechanical.ts made for the audit, applied to
// the builder's own output.
//
// Every detector is deliberately narrow. A retry costs a model call, so a
// false positive costs real money and a missed tell costs nothing but a signal
// that was going to survive anyway. When in doubt these say nothing.

export interface Tell {
  signal: number;
  /** Named back to the builder, so the retry is specific rather than a scolding. */
  detail: string;
}

const has = (re: RegExp, s: string) => re.test(s);

/** #69 — a small label above the heading, on section after section. */
function eyebrow(html: string, css: string): Tell | null {
  const named = /class\s*=\s*["'][^"']*\b(eyebrow|kicker|overline|pretitle|section-label|tagline)\b/i;
  if (has(named, html)) {
    return { signal: 69, detail: 'an eyebrow/kicker label above the heading (class named for it)' };
  }
  // Or the same thing built without naming it: a short element immediately
  // before the heading, styled uppercase with letter-spacing.
  const before = html.match(/<(span|p|div)\b[^>]*>([^<]{1,40})<\/\1>\s*<h[1-3]\b/i);
  if (before && /text-transform\s*:\s*uppercase/i.test(css) && /letter-spacing/i.test(css)) {
    return { signal: 69, detail: `an uppercase letter-spaced label above the heading ("${before[2].trim()}")` };
  }
  return null;
}

/** #16 — the one shadow every generator reaches for. */
function uniformShadow(_html: string, css: string): Tell | null {
  const shadows = css.match(/box-shadow\s*:[^;}]+/gi) ?? [];
  const tenth = shadows.filter((s) => /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.1\s*\)/i.test(s));
  if (tenth.length === 0) return null;
  return {
    signal: 16,
    detail: `box-shadow using rgba(0,0,0,0.1) — the default shade, ${tenth.length} time(s)`,
  };
}

/** #110 — a row of impressive round numbers. */
function statsRow(html: string, _css: string): Tell | null {
  const text = html.replace(/<[^>]*>/g, " ");
  // No trailing \b: the tell ENDS in "+" or "%", and a word boundary after a
  // non-word character never matches. That silently found only "24/7".
  const round = text.match(/(?<![\w.])(\d{1,3}(?:,\d{3})*\+|\d{1,3}[KkMm]\+|\d{2,3}%|24\/7)/g) ?? [];
  const distinct = new Set(round);
  if (distinct.size < 3) return null;
  return {
    signal: 110,
    detail: `a row of round "impressive" numbers (${[...distinct].slice(0, 4).join(", ")}) presented as a stats bar`,
  };
}

/** #42 — everything fades up on scroll. */
function fadeInEverything(_html: string, css: string): Tell | null {
  const opacityAnim = /@keyframes[^{]*\{[^}]*opacity\s*:\s*0[^}]*\}/is.test(css) ||
    /animation[^;}]*fade/i.test(css);
  const rise = /translateY\s*\(/i.test(css);
  if (opacityAnim && rise) {
    return { signal: 42, detail: "a fade-up-on-scroll animation (opacity 0 plus translateY)" };
  }
  return null;
}

/** #20 — three or four identical cards, side by side, as the whole idea. */
function symmetricCards(html: string, _css: string): Tell | null {
  const classes = new Map<string, number>();
  for (const m of html.matchAll(/<(?:div|article|li)\b[^>]*class\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const key = m[1].trim().replace(/\s+/g, " ");
    classes.set(key, (classes.get(key) ?? 0) + 1);
  }
  for (const [cls, n] of classes) {
    if (n < 3 || n > 4) continue;
    // Identical shells only: each one carrying a small heading and a line of
    // copy is the shape the signal names. A repeated wrapper with varied
    // content inside is a list, not the template.
    const shell = new RegExp(`class\\s*=\\s*["']${cls.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["']`, "g");
    if ((html.match(shell) ?? []).length !== n) continue;
    const headings = (html.match(/<h[34]\b/gi) ?? []).length;
    if (headings >= n) {
      return { signal: 20, detail: `${n} identical cards in a row (class "${cls}"), the symmetric grid the original was flagged for` };
    }
  }
  return null;
}

const DETECTORS: Array<(html: string, css: string) => Tell | null> = [
  eyebrow,
  uniformShadow,
  statsRow,
  fadeInEverything,
  symmetricCards,
];

/**
 * Which fingerprints this section reproduced.
 *
 * `flagged` is the set the ORIGINAL site was caught with — the same set the
 * builder was handed as "do not reproduce". Anything outside it is left alone:
 * a pattern the original never had is the designer making a choice, and second-
 * guessing that with a regex is how you get a bland site and a large bill.
 */
export function sectionTells(
  html: string,
  css: string,
  flagged: Set<number>,
): Tell[] {
  const out: Tell[] = [];
  for (const detect of DETECTORS) {
    const tell = detect(html, css ?? "");
    if (tell && flagged.has(tell.signal)) out.push(tell);
  }
  return out;
}
