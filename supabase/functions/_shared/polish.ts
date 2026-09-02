// The faults a computer can simply fix, fixed by a computer.
//
// The rebuild's prompts ask for a great deal and the model complies with most
// of it. What it misses is dull, repetitive and completely determined: a
// heading level skipped, an image with no alt, a form field with no dir on a
// Hebrew page. Measured on a real run, six of the signals that survived the
// rebuild were of exactly this kind — every one of them detected mechanically
// by mechanical.ts, and none of them fixed by anything, because asking was the
// only mechanism the builder had.
//
// This is the other half of that pairing: the checks already know what is
// wrong, so here the same rules repair it. It runs on the assembled document,
// after the model is finished and before the page ships, and it costs nothing.
//
// Everything here must be SAFE ON A GOOD PAGE. A pass that mangles correct
// markup to satisfy a rule is worse than the rule going unmet, so each fix
// below either changes nothing or changes one attribute.

export interface PolishResult {
  html: string;
  /** Signal ids repaired, for the run's own report. */
  fixed: number[];
  notes: string[];
}

interface Ctx {
  rtl: boolean;
  /** alt text by image src, from the ledger — the original page's own words. */
  altBySrc: Map<string, string>;
}

export function polishPage(
  html: string,
  opts: { rtl: boolean; images?: Array<{ src: string; alt?: string }> },
): PolishResult {
  const ctx: Ctx = {
    rtl: opts.rtl,
    altBySrc: new Map((opts.images ?? []).filter((i) => i.alt).map((i) => [i.src, i.alt!])),
  };
  const fixed: number[] = [];
  const notes: string[] = [];
  let out = html;

  for (const step of [fixHeadingOrder, fixImageAlt, fixLazyLoading, fixFormDirection]) {
    const r = step(out, ctx);
    if (r.changed) {
      out = r.html;
      fixed.push(r.signal);
      notes.push(r.note);
    }
  }
  return { html: out, fixed, notes };
}

interface Step {
  html: string;
  changed: boolean;
  signal: number;
  note: string;
}

/**
 * #29 — a heading level skipped.
 *
 * Walks the document's headings in order and pulls any that jumps more than one
 * level back to exactly one below its predecessor. Only ever moves a heading
 * UP toward its parent, never down, so the outline can tighten but a section
 * can never be demoted under a sibling. h1 is left alone entirely: which
 * heading is the page title is a decision, not a defect.
 */
function fixHeadingOrder(html: string, _ctx: Ctx): Step {
  let previous = 0;
  let changed = 0;
  const out = html.replace(/<(\/?)h([1-6])(\b[^>]*)>/gi, (whole, slash: string, digit: string, attrs: string) => {
    const level = Number(digit);
    if (slash) return whole; // closing tags are rewritten by their opener below
    if (level === 1) { previous = 1; return whole; }
    if (previous === 0) { previous = level; return whole; }
    if (level <= previous + 1) { previous = level; return whole; }
    const corrected = previous + 1;
    previous = corrected;
    changed++;
    return `<h${corrected}${attrs}>`;
  });
  if (!changed) return { html, changed: false, signal: 29, note: "" };

  // Re-pair the closing tags: the opener rewrite above would otherwise leave
  // <h3>…</h4>. Walk the result and match each close to its open.
  const stack: number[] = [];
  const paired = out.replace(/<(\/?)h([1-6])(\b[^>]*)>/gi, (whole, slash: string, digit: string) => {
    if (!slash) { stack.push(Number(digit)); return whole; }
    const open = stack.pop();
    return open ? `</h${open}>` : whole;
  });
  return {
    html: paired,
    changed: true,
    signal: 29,
    note: `${changed} heading(s) were a level out of sequence and were re-levelled`,
  };
}

/** #33 — an image with no alt text, or an empty one on a content image. */
function fixImageAlt(html: string, ctx: Ctx): Step {
  let changed = 0;
  const out = html.replace(/<img\b([^>]*)>/gi, (whole, attrs: string) => {
    if (/\balt\s*=\s*["'][^"']+["']/i.test(attrs)) return whole;
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    // The original page's own wording first; a filename is a poor caption but
    // an honest one, and far better than a machine-written description of a
    // photograph nobody here has seen.
    const known = ctx.altBySrc.get(src);
    const fallback = (src.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    const alt = known ?? fallback;
    if (!alt) return whole;
    changed++;
    const stripped = attrs.replace(/\balt\s*=\s*["'][^"']*["']/i, "");
    return `<img${stripped} alt="${escapeAttr(alt)}">`;
  });
  return changed
    ? { html: out, changed: true, signal: 33, note: `${changed} image(s) had no alt text and were given one` }
    : { html, changed: false, signal: 33, note: "" };
}

/**
 * #37 — no lazy loading below the fold.
 *
 * The first image on the page is left eager on purpose: it is the one most
 * likely to be the hero, and deferring that one makes the page slower, not
 * faster. Everything after it is deferred.
 */
function fixLazyLoading(html: string, _ctx: Ctx): Step {
  let seen = 0;
  let changed = 0;
  const out = html.replace(/<img\b([^>]*)>/gi, (whole, attrs: string) => {
    seen++;
    if (seen === 1) return whole;
    if (/\bloading\s*=/i.test(attrs)) return whole;
    changed++;
    return `<img${attrs} loading="lazy">`;
  });
  return changed
    ? { html: out, changed: true, signal: 37, note: `${changed} image(s) below the first were set to load lazily` }
    : { html, changed: false, signal: 37, note: "" };
}

/**
 * #79 — a Hebrew form field with no direction.
 *
 * Only on an RTL site, and only on fields that take free text: a number, a date
 * or a colour picker has no direction to get wrong, and stamping dir on those
 * would be noise dressed as a fix.
 */
const FREE_TEXT = /\btype\s*=\s*["'](text|email|tel|search|url|password)["']/i;

function fixFormDirection(html: string, ctx: Ctx): Step {
  if (!ctx.rtl) return { html, changed: false, signal: 79, note: "" };
  let changed = 0;
  const out = html.replace(/<(input|textarea)\b([^>]*)>/gi, (whole, tag: string, attrs: string) => {
    if (/\bdir\s*=/i.test(attrs)) return whole;
    if (tag.toLowerCase() === "input" && !FREE_TEXT.test(attrs) && /\btype\s*=/i.test(attrs)) return whole;
    changed++;
    return `<${tag}${attrs} dir="rtl">`;
  });
  return changed
    ? { html: out, changed: true, signal: 79, note: `${changed} form field(s) were given dir="rtl"` }
    : { html, changed: false, signal: 79, note: "" };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
