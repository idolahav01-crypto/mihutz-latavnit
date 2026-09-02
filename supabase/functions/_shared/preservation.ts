// Content preservation guard — the check that a rebuild did not quietly delete
// the site it was asked to improve.
//
// Why this exists: the score rewards deletion. Signals live inside content, so
// removing half a page removes half its signals, and the run reports a large
// improvement. One real rebuild shipped with 94% of its content gone (8 player
// cards, the stadium facts, an interactive quiz — none of them reached the
// page) and the score fell 47 -> 32, which looked like the best result the
// system had ever produced. Nothing in the pipeline could tell "we cleaned the
// site" apart from "we deleted the site".
//
// This module answers that one question and nothing else. It does not repair,
// it does not guess, and it never calls a model: it compares the page that came
// out against the page that went in and reports what is missing. Callers decide
// what to do with a failure; the point is that a lossy run can no longer pass
// silently.
//
// Every check is two-sided on purpose. A check that can only prove something is
// present stabilises nothing, so each one is defined as "this was in the
// original, and it is not in the result" — which is a fact about both
// documents, not a judgement about either.

// ============================================================
// Text
// ============================================================

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * The words a visitor actually reads.
 *
 * Script and style bodies go first — they are full of text that is not content,
 * and counting them would let a page with no prose look well populated purely
 * because it carries a large stylesheet inline. That matters here: a rebuilt
 * page inlines all of its CSS, so it would otherwise always look bigger than
 * the original no matter how much copy was dropped.
 */
export function visibleText(html: string): string {
  let out = html.replace(SCRIPT_OR_STYLE, " ").replace(COMMENT, " ").replace(TAG, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  return out.replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  return text ? text.split(" ").filter(Boolean).length : 0;
}

// ============================================================
// Facts
// ============================================================

// Runs of two or more digits, with thousands separators folded away so "1,886"
// and "1886" are the same fact. Single digits are deliberately ignored: they
// appear in ordinary prose constantly and would drown the signal in noise.
const NUMBER = /\d[\d,.]*/g;

/**
 * The numeric facts on a page: years, prices, counts, phone numbers.
 *
 * These are the part of a site that must never change, and they are also the
 * part that is cheapest to verify — a founding year either survived the rebuild
 * or it did not. No interpretation, no model, no threshold.
 */
export function factTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(NUMBER) ?? []) {
    // Trim trailing separators ("2026." at the end of a sentence) and fold the
    // ones inside a number away, so grouping style cannot fake a difference.
    const token = raw.replace(/[.,]+$/, "").replace(/,/g, "");
    if (token.replace(/\./g, "").length >= 2) out.add(token);
  }
  return out;
}

// ============================================================
// What the page's own scripts need
// ============================================================

// getElementById("x") / getElementsByClassName("x") / querySelector("#x .y")
const BY_ID = /getElementById\(\s*['"`]([^'"`]+)['"`]/g;
const BY_CLASS = /getElementsByClassName\(\s*['"`]([^'"`]+)['"`]/g;
const QUERY = /querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/g;

export interface ScriptHooks {
  ids: Set<string>;
  classes: Set<string>;
}

/**
 * The ids and classes a page's JavaScript reaches for.
 *
 * A rebuild carries the original <script> blocks over byte for byte, so a
 * script that survives while the elements it drives do not is worse than a
 * script that was dropped: it runs, throws, and takes the rest of the page's
 * behaviour down with it. One shipped rebuild kept `script.js` and removed
 * every one of #nav, #formNote and all 24 .fade-up elements, so the delivered
 * site threw a TypeError on every scroll.
 *
 * Only simple, literal selectors are read. A hook assembled at runtime cannot
 * be checked, and guessing at one would produce false alarms — so it is left
 * out. This is a floor on what we can prove, not a claim of completeness.
 */
export function scriptHooks(js: string): ScriptHooks {
  const ids = new Set<string>();
  const classes = new Set<string>();

  for (const [, id] of js.matchAll(BY_ID)) ids.add(id);
  for (const [, cls] of js.matchAll(BY_CLASS)) classes.add(cls);
  for (const [, selector] of js.matchAll(QUERY)) {
    // A selector list can name several hooks at once (".a, #b .c").
    for (const [, id] of selector.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(id);
    for (const [, cls] of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(cls);
  }
  return { ids, classes };
}

/** Every piece of JavaScript this project ships: inline blocks plus .js files. */
export function collectJs(files: Map<string, string>): string {
  const parts: string[] = [];
  for (const [path, content] of files) {
    if (/\.(js|mjs)$/i.test(path)) parts.push(content);
    else if (/\.html?$/i.test(path)) {
      for (const [, body] of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        parts.push(body);
      }
    }
  }
  return parts.join("\n");
}

function hasId(html: string, id: string): boolean {
  return new RegExp(`\\sid\\s*=\\s*['"]${escapeRegExp(id)}['"]`, "i").test(html);
}

function hasClass(html: string, cls: string): boolean {
  // Inside any class attribute, as a whole word.
  for (const [, value] of html.matchAll(/\sclass\s*=\s*['"]([^'"]*)['"]/gi)) {
    if (value.split(/\s+/).includes(cls)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// The guard
// ============================================================

/**
 * How much of the original's prose the result must still carry.
 *
 * Calibrated against every real rebuild in storage rather than chosen: the
 * healthy runs land at 0.99, 1.02 and 1.13 of the original word count, and the
 * run that deleted the site lands at 0.06. Anything in between is a page that
 * lost most of itself, and 0.6 sits far from both clusters — a rebuild is
 * allowed to tighten copy, not to erase it.
 */
export const MIN_WORD_RATIO = 0.6;

export type FailureKind =
  | "text_shrank"
  | "facts_missing"
  | "script_ids_missing"
  | "script_classes_missing";

export interface PreservationFailure {
  kind: FailureKind;
  detail: string;
  /** The specific items that went missing, for the operator and the log. */
  missing?: string[];
  /**
   * Whether this alone should stop delivery.
   *
   * A missing id breaks the page: the carried script dereferences null and
   * takes the rest of the page's behaviour down with it. A missing class does
   * not — `querySelectorAll` over nothing is a no-op, so the site works and
   * only loses an effect. Blocking on both would refuse to deliver sites that
   * are merely a little plainer than before, which is not what a safety net is
   * for. The class loss is still reported; it is just not fatal.
   */
  blocking: boolean;
}

export interface PreservationReport {
  /** True when nothing blocking was found. Warnings may still be present. */
  ok: boolean;
  failures: PreservationFailure[];
  stats: {
    wordsBefore: number;
    wordsAfter: number;
    wordRatio: number;
    factsBefore: number;
    factsMissing: number;
    hooksChecked: number;
    hooksMissing: number;
  };
}

export interface PreservationInput {
  /** The project as it arrived. */
  original: Map<string, string>;
  /** The project as it will ship (originals with the rebuild applied). */
  rebuilt: Map<string, string>;
  /** The page the rebuild replaced. */
  page: string;
}

/**
 * Compare the shipped page against the original and report what was lost.
 *
 * The caller supplies the assembled result, not the edited fragment, so a file
 * the rebuild never touched is compared against itself and contributes nothing.
 */
export function checkPreservation(input: PreservationInput): PreservationReport {
  const { original, rebuilt, page } = input;
  const beforeHtml = original.get(page) ?? "";
  const afterHtml = rebuilt.get(page) ?? "";

  const beforeText = visibleText(beforeHtml);
  const afterText = visibleText(afterHtml);
  const wordsBefore = wordCount(beforeText);
  const wordsAfter = wordCount(afterText);
  // An empty original cannot have lost anything; ratio 1 keeps the guard quiet
  // rather than dividing by zero and failing every trivial page.
  const wordRatio = wordsBefore === 0 ? 1 : wordsAfter / wordsBefore;

  const failures: PreservationFailure[] = [];

  if (wordRatio < MIN_WORD_RATIO) {
    failures.push({
      kind: "text_shrank",
      detail: `visible text fell to ${Math.round(wordRatio * 100)}% of the original ` +
        `(${wordsBefore} words -> ${wordsAfter})`,
      blocking: true,
    });
  }

  const factsBefore = factTokens(beforeText);
  const afterFacts = factTokens(afterText);
  const factsMissing = [...factsBefore].filter((f) => !afterFacts.has(f)).sort();
  if (factsMissing.length) {
    failures.push({
      kind: "facts_missing",
      detail: `${factsMissing.length} number(s) present in the original are absent from the rebuild`,
      missing: factsMissing,
      blocking: true,
    });
  }

  // Only hooks that were satisfied BEFORE are checked. A script reaching for an
  // element the original never had was already broken, and blaming the rebuild
  // for it would be a false alarm.
  const hooks = scriptHooks(collectJs(original));
  const liveIds = [...hooks.ids].filter((id) => hasId(beforeHtml, id));
  const liveClasses = [...hooks.classes].filter((cls) => hasClass(beforeHtml, cls));
  const missingIds = liveIds.filter((id) => !hasId(afterHtml, id)).map((id) => `#${id}`).sort();
  const missingClasses = liveClasses.filter((cls) => !hasClass(afterHtml, cls))
    .map((cls) => `.${cls}`).sort();
  if (missingIds.length) {
    failures.push({
      kind: "script_ids_missing",
      detail: `the carried scripts dereference ${missingIds.length} element(s) the rebuild did not keep`,
      missing: missingIds,
      blocking: true,
    });
  }
  if (missingClasses.length) {
    failures.push({
      kind: "script_classes_missing",
      detail: `${missingClasses.length} class(es) the scripts decorate are gone, so that effect is lost`,
      missing: missingClasses,
      blocking: false,
    });
  }
  const missingHooks = [...missingIds, ...missingClasses];

  return {
    ok: !failures.some((f) => f.blocking),
    failures,
    stats: {
      wordsBefore,
      wordsAfter,
      wordRatio,
      factsBefore: factsBefore.size,
      factsMissing: factsMissing.length,
      hooksChecked: liveIds.length + liveClasses.length,
      hooksMissing: missingHooks.length,
    },
  };
}

/** One-line summary of what BLOCKED delivery. */
export function summarize(report: PreservationReport): string {
  const blocking = report.failures.filter((f) => f.blocking);
  if (!blocking.length) return "content preserved";
  return blocking.map((f) => f.detail).join("; ");
}

/** Non-fatal losses worth recording next to a successful run. */
export function warnings(report: PreservationReport): PreservationFailure[] {
  return report.failures.filter((f) => !f.blocking);
}

/**
 * Put back a photograph the builder was given and did not use.
 *
 * The section spec carries the images the original page showed, and the section
 * prompt is told to emit every one of them. A prompt is a request, and this
 * file's neighbours do not rely on requests: broken CSS is balanced, a nav link
 * with no target is re-pointed, and both are then reported. Images get the same
 * treatment, because the failure mode is the one the user actually complained
 * about — a rebuild that came back as boxes of text where the site had pictures.
 *
 * The restore is deliberately plain: an <img> appended to the section, with the
 * original src and alt. It is not a design, and it is not meant to be — it is
 * the difference between a page that references its photographs and a page that
 * silently dropped them. Reported so nobody mistakes it for the builder's work.
 */
export function restoreMissingImages(
  html: string,
  wanted: Array<{ src: string; alt?: string }>,
): { html: string; restored: string[] } {
  if (!wanted.length) return { html, restored: [] };

  // Every src the built markup already points at, however it was written.
  const present = new Set<string>();
  for (const m of html.matchAll(/(?:src|srcset|href)\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of m[1].split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) present.add(url);
    }
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) present.add(m[1].trim());

  const restored: string[] = [];
  let out = html;
  for (const image of wanted) {
    const src = (image.src ?? "").trim();
    if (!src || present.has(src)) continue;
    // A path can be written relatively in one place and absolutely in another;
    // matching on the file name too keeps a re-rooted src from being counted
    // as missing and duplicated.
    const base = src.split("/").pop() ?? src;
    if ([...present].some((p) => p.endsWith("/" + base) || p === base)) continue;

    const alt = escapeAttr(image.alt ?? "");
    out += `\n<img src="${escapeAttr(src)}" alt="${alt}" loading="lazy" class="restored-image">`;
    restored.push(src);
    present.add(src);
  }
  return { html: out, restored };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
