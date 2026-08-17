// Design floor — did the rebuild redesign the site, or just drain it?
//
// The audit only ever measures what is WRONG. Signals live in visual devices,
// so removing the devices removes the signals, and an empty page scores
// perfectly. Measured on a real rebuild that scored 50 -> 19, the best result
// the system had ever produced:
//
//   distinct colours   47 -> 12      gradients  16 -> 0
//   box-shadows         6 -> 0       transforms 17 -> 4
//   font weights        6 -> 3       motion     19 -> 7
//
// Nothing was broken and nothing was lost — the builder did exactly what it was
// told. It receives one prohibition per signal the audit found (45 of them on
// that run) plus a fixed block of rules, and every individual prohibition is
// reasonable: no gradients, no uniform shadows, no scroll animations, no hover
// glow, no accent palette, no centring, no card grid. Together they remove
// every tool a designer has. The catalogue has signals for a site being too
// flat — #3, #6, #7, #88 — and all of them were dark, so nothing in the system
// could see it.
//
// This module is the counterweight. It is deliberately NOT a list of devices to
// require: demanding the gradients back would reintroduce #9 and #15, the very
// signals we are paid to remove. Instead it scores a page's design DEPTH as a
// total, with substitutable categories, and compares the rebuild against the
// original. The builder is free to reach parity with borders, type contrast and
// colour layers instead of gradients and glow — it just is not free to reach it
// with nothing.

// ============================================================
// Reading the CSS
// ============================================================

/** Every stylesheet the page ships: linked files plus inline <style> blocks. */
export function collectCss(files: Map<string, string>, page: string): string {
  const parts: string[] = [];
  const html = files.get(page) ?? "";
  for (const [, body] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(body);
  for (const [path, content] of files) {
    if (/\.(css|scss|sass|less)$/i.test(path)) parts.push(content);
  }
  // Inline style attributes carry real design decisions on a generated page.
  for (const [, body] of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) parts.push(`x{${body}}`);
  return parts.join("\n");
}

function distinctColours(css: string): number {
  const set = new Set<string>();
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) set.add(m[0].toLowerCase());
  for (const m of css.matchAll(/(?:rgb|hsl)a?\([^)]*\)/gi)) set.add(m[0].replace(/\s+/g, "").toLowerCase());
  return set.size;
}

function distinctValues(css: string, prop: string): number {
  const set = new Set<string>();
  const re = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, "gi");
  for (const m of css.matchAll(re)) set.add(m[1].trim().toLowerCase());
  return set.size;
}

function count(css: string, re: RegExp): number {
  return (css.match(re) ?? []).length;
}

// ============================================================
// Scoring
// ============================================================

export interface RichnessBreakdown {
  palette: number;
  type: number;
  depth: number;
  motion: number;
  shape: number;
  detail: number;
  total: number;
}

/**
 * Distinct design DECISIONS, not occurrences.
 *
 * Counting occurrences was the first attempt and it failed on the real data:
 * every category saturated its cap for both a rich page and a drained one, and
 * the score said 89% where the eye said "the life is gone". Repeating
 * `border: 1px solid` forty times is one decision, not forty.
 *
 * The metrics below are the ones that actually separated the drained rebuild
 * from the two good ones on stored runs. The drained page shrank on twelve of
 * them; both good pages grew on nearly all. Caps sit well above every value
 * observed, so they only stop gaming, never blunt the instrument.
 *
 * Categories are substitutable on purpose. DEPTH accepts distinct border
 * treatments as readily as shadows and gradients, so a page can build layering
 * with rules and edges and never emit the uniform soft shadow of signal #16.
 */
const CAP = {
  colours: 48,
  fontSizes: 32,
  motion: 40,
  depth: 28,
  shape: 16,
  finish: 24,
} as const;

export function scoreRichness(css: string): RichnessBreakdown {
  const d = (prop: string) => distinctValues(css, prop);
  const n = (re: RegExp) => count(css, re);
  const cap = (v: number, c: number) => Math.min(v, c);

  const palette = cap(distinctColours(css), CAP.colours) + cap(d("opacity"), 8);

  const type = d("font-weight") * 3 + d("font-family") * 3 +
    cap(d("font-size"), CAP.fontSizes);

  // Borders count as much as shadows, and the LOGICAL forms count at all — the
  // first version matched only `border:` and `border-block:`, so
  // border-block-end and border-inline-start scored nothing. Those are exactly
  // the properties our own RTL rules require, which made the floor punish the
  // correct approach and reward a soft shadow on every card.
  const depth = cap(
    d("box-shadow") * 3 +
      distinctGradients(css) * 2 +
      distinctBorderDecisions(css) * 2 +
      d("outline") * 2,
    CAP.depth,
  );

  const motion = cap(
    d("transition") * 2 + d("transform") +
      n(/@keyframes/gi) * 3 +
      n(/:hover/gi) + n(/:focus-visible|:focus\b/gi) + n(/:active/gi),
    CAP.motion,
  );

  const shape = cap(d("border-radius") * 2, CAP.shape);

  const detail = cap(
    d("letter-spacing") + d("line-height") + n(/text-transform\s*:/gi) +
      n(/clip-path\s*:|mix-blend-mode\s*:|filter\s*:/gi) * 2,
    CAP.finish,
  );

  return {
    palette,
    type,
    depth,
    motion,
    shape,
    detail,
    total: palette + type + depth + motion + shape + detail,
  };
}

/**
 * Every distinct border decision, physical or logical, shorthand or longhand.
 *
 * One set, so `border-block-end: 2px solid #222` and `border-bottom: 2px solid
 * #222` are one decision rather than two, and a page that layers with rules
 * scores the same whether it writes them the logical way or the old way. Ours
 * must write them the logical way; the score must not care.
 */
function distinctBorderDecisions(css: string): number {
  const set = new Set<string>();
  const re =
    /\bborder(?:-(?:block|inline)(?:-(?:start|end))?|-top|-bottom|-left|-right)?(?:-(?:width|style|color))?\s*:\s*([^;}]+)/gi;
  for (const m of css.matchAll(re)) {
    const value = m[1].trim().toLowerCase();
    if (!value || value === "none" || value === "0") continue;
    set.add(value);
  }
  return set.size;
}

function distinctGradients(css: string): number {
  const set = new Set<string>();
  for (const m of css.matchAll(/(?:linear|radial|conic)-gradient\([^;}]*/gi)) {
    set.add(m[0].replace(/\s+/g, "").toLowerCase());
  }
  return set.size;
}

// ============================================================
// The floor
// ============================================================

/**
 * How much of the original's design depth the rebuild must carry.
 *
 * Set to parity by product decision: a rebuild is meant to replace the site's
 * design language, not to spend it. A number below 1 would license every run to
 * come back a little plainer than the last.
 */
export const MIN_RICHNESS_RATIO = 1.0;

export interface RichnessReport {
  ok: boolean;
  ratio: number;
  before: RichnessBreakdown;
  after: RichnessBreakdown;
  /** Categories where the rebuild came back thinner, worst first. */
  thinnest: Array<{ category: string; before: number; after: number }>;
  detail: string;
}

export function checkRichness(
  original: Map<string, string>,
  rebuilt: Map<string, string>,
  page: string,
): RichnessReport {
  const before = scoreRichness(collectCss(original, page));
  const after = scoreRichness(collectCss(rebuilt, page));
  // An original with no styling at all cannot be under-served.
  const ratio = before.total === 0 ? 1 : after.total / before.total;

  const categories = ["palette", "type", "depth", "motion", "shape", "detail"] as const;
  const thinnest = categories
    .map((c) => ({ category: c, before: before[c], after: after[c] }))
    .filter((x) => x.after < x.before)
    .sort((a, b) => (b.before - b.after) - (a.before - a.after));

  const ok = ratio >= MIN_RICHNESS_RATIO;
  const detail = ok
    ? `design depth ${Math.round(ratio * 100)}% of the original`
    : `design depth fell to ${Math.round(ratio * 100)}% of the original ` +
      `(${before.total} -> ${after.total}); thinnest: ` +
      thinnest.slice(0, 3).map((t) => `${t.category} ${t.before}->${t.after}`).join(", ");

  return { ok, ratio, before, after, thinnest, detail };
}

/**
 * What to tell the builder so the next attempt is not thinner than the last.
 *
 * Named categories, not named devices: "more depth" leaves room for borders and
 * edges, where "add shadows" would walk straight into signal #16.
 */
export function richnessBrief(report: RichnessReport): string {
  if (report.ok || !report.thinnest.length) return "";
  const asks: Record<string, string> = {
    palette: "a deeper palette — more than one tint and shade of the brand colour, " +
      "used with intent rather than a single flat accent",
    type: "real typographic contrast — a wider weight range and a size scale where the " +
      "largest heading is at least 2.5x the body",
    depth: "visual layering — rules, edges and surface separation (borders and outlines " +
      "count; a uniform soft shadow on every card does not)",
    motion: "considered motion and interaction states — hover, focus-visible and active " +
      "that each read differently, not one transition reused everywhere",
    shape: "a shape hierarchy — different radii for different roles, not one value everywhere",
    detail: "finish — deliberate letter-spacing, line-height and case decisions",
  };
  return `<design_depth>\nThe previous attempt came back visually thinner than the site it ` +
    `replaced (design depth ${Math.round(report.ratio * 100)}% of the original). Removing ` +
    `AI tells must not mean removing design. This build needs:\n` +
    report.thinnest.slice(0, 3).map((t) => `- ${asks[t.category]}`).join("\n") +
    `\nEvery device still has to earn its place: no gradient, glow or shadow for its own ` +
    `sake, and none of the forbidden patterns above.\n</design_depth>`;
}

/**
 * The design brief, written from the site being replaced.
 *
 * The builder used to hear only prohibitions — one per signal the audit found,
 * 45 of them on one real run — and nothing at all about what a good page needs.
 * It complied perfectly and returned a page at 51% of the original's design
 * depth. This is the other half of the instruction, and it is derived from the
 * original rather than invented: these are the numbers the site it replaces
 * actually hit, so meeting them is a floor, not an aspiration.
 *
 * Deliberately expressed as counts of DECISIONS, never as devices. "At least
 * this many distinct colours" leaves the palette to the designer; "add a
 * gradient" would walk straight back into signal #9.
 */
export function richnessTargets(css: string): string {
  const s = scoreRichness(css);
  const d = (prop: string) => distinctValues(css, prop);
  return `<design_depth_target>
The site you are replacing is visually richer than a default template, and the
rebuild must not come back thinner than it. Removing AI tells is not the same as
removing design: a page with one accent colour, three font weights and no
layering passes every check we run and still looks dead.

What the ORIGINAL site spends, and what yours has to match or beat:
- ${distinctColours(css)} distinct colours (it does not have to be the same hues — it has to be as considered a palette; tints and shades of one brand colour count)
- ${d("font-weight")} font weights and ${d("font-size")} distinct sizes, with the largest heading at least 2.5x the body
- ${d("box-shadow") + distinctGradients(css) + d("border")} separate surface-separation decisions (borders, rules, edges, shadows — your choice which)
- ${d("transition") + d("transform")} distinct motion/interaction decisions, with hover, focus-visible and active each reading differently
- ${d("border-radius")} distinct corner treatments and ${d("letter-spacing") + d("line-height")} typographic finish decisions

Depth score to beat: ${s.total}. Reach it with craft — type contrast, colour
layering, real borders and considered spacing — not with the forbidden patterns.
</design_depth_target>`;
}
