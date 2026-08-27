// Signals a computer can decide, decided by a computer.
//
// Measured on five scans of one unchanged repo: 18 signals came back present
// every time and 18 came back present in some runs and absent in others. Half
// the audit was a coin flip, which made the score's noise (+/-3 signals) about
// the size of the improvements we were trying to measure with it.
//
// A model is the right tool for "is this hero centred in a way that reads as
// template output" and the wrong tool for "does this document contain a
// <script type=application/ld+json>". The second kind is a text search: exact,
// free, instant, and identical on every run. Those move here.
//
// Rules for what belongs in this file:
//   1. The check must be TWO-SIDED. A rule that can only prove presence leaves
//      the absent case to the model and stabilises nothing.
//   2. It must implement the signal's WRITTEN detection rule, not a convenient
//      approximation of it. Where the rule contains a judgment clause, either
//      encode the clause exactly or leave the whole signal to the model.
//   3. Getting it wrong is worse than not doing it. A confident, repeatable,
//      wrong answer is invisible; a model's wrong answer at least wobbles.
//
// Anything requiring taste — visual hierarchy, tone, whether a colour carries
// meaning — stays with the model and is not welcome here.

import signalsJson from "./signals.json" with { type: "json" };
import type { DetectedSignal } from "./pipeline.ts";

interface SignalMeta {
  id: number;
  name: string;
  weight: string;
  category: string;
  detection: string;
}
const META = new Map<number, SignalMeta>(
  (signalsJson as SignalMeta[]).map((s) => [s.id, s]),
);

/** The ids this module owns. The model is never asked about them. */
export const MECHANICAL_IDS: number[] = [
  1, 2, 8, 13, 27, 28, 29, 30, 31, 35, 36, 40, 41, 45, 55, 56, 61, 64, 78, 94,
  97, 98, 99, 109,
];

interface Verdict {
  present: boolean;
  applicable?: boolean;
  why: string;
  evidence?: Array<{ file: string; snippet: string }>;
  occurrences?: number;
}

// ---------- small helpers ----------

const isHtml = (p: string) => /\.(html?|vue|svelte|jsx|tsx)$/i.test(p);
const isCss = (p: string) => /\.(css|scss|sass|less)$/i.test(p);

function clip(s: string, n = 180): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

/** Markup with <script>, <style> and comments removed — what a reader sees. */
function visibleMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * What a reader actually reads: markup with tags removed and entities decoded.
 *
 * Every tag becomes a SPACE rather than nothing. Dropping them outright would
 * splice "180" and the word after its </span> into one run and invent a
 * text-direction fault that the page does not have — the checks below read
 * adjacency as evidence, so adjacency has to be real.
 */
function readableText(html: string): string {
  return visibleMarkup(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Script bodies: external JS files plus every inline <script>, tagged by file. */
function allJs(files: Map<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, content] of files) {
    if (/\.(m?js|ts)$/i.test(path)) out.push([path, content]);
    if (isHtml(path)) {
      for (const m of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        // A src= tag has no body worth reading; its file arrives on its own.
        if (!/\bsrc\s*=/i.test(m[1])) out.push([path, m[2]]);
      }
    }
  }
  return out;
}

/** Every stylesheet plus every inline <style> block, tagged by file. */
function allCss(files: Map<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, content] of files) {
    if (isCss(path)) out.push([path, content]);
    if (isHtml(path)) {
      for (const m of content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        out.push([path, m[1]]);
      }
    }
  }
  return out;
}

/** One attribute off a single tag. */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function htmlFiles(files: Map<string, string>): Array<[string, string]> {
  return [...files.entries()].filter(([p]) => /\.html?$/i.test(p));
}

/** The <head> of a document, or the whole thing if it has no head. */
function head(html: string): string {
  const m = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html;
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1]?.trim() ?? "";
}

function docTitle(html: string): string {
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
}

/** Does this project address a Hebrew/Arabic audience? Decides RTL signals. */
function isRtl(files: Map<string, string>): boolean {
  for (const [path, content] of files) {
    if (!isHtml(path)) continue;
    if (/\bdir\s*=\s*["']rtl["']/i.test(content)) return true;
    if (/<html\b[^>]*\blang\s*=\s*["'](he|ar)/i.test(content)) return true;
    if (/[֐-׿]{8,}/.test(visibleMarkup(content))) return true;
  }
  return false;
}

// ---------- the checks ----------

/** #1 — Inter with none of the tuning that would make it a choice. */
function checkInter(files: Map<string, string>): Verdict {
  const css = allCss(files);
  const hits: Array<{ file: string; snippet: string }> = [];
  for (const [file, text] of css) {
    for (const m of text.matchAll(/font-family\s*:[^;{}]*\bInter\b[^;{}]*/gi)) {
      hits.push({ file, snippet: clip(m[0]) });
    }
  }
  // A Google Fonts link counts too — that is how most builders pull it in.
  for (const [file, content] of htmlFiles(files)) {
    if (/fonts\.googleapis\.com[^"']*family=[^"']*\bInter\b/i.test(content)) {
      hits.push({ file, snippet: "Google Fonts link requesting the Inter family" });
    }
  }
  if (!hits.length) return { present: false, why: "Inter אינו בשימוש באתר." };

  const tuned = css.some(([, text]) =>
    /font-variation-settings\s*:|font-feature-settings\s*:|letter-spacing\s*:/i.test(text)
  );
  if (tuned) {
    return {
      present: false,
      why: "Inter בשימוש, אך ה-CSS מכיל כוונון טיפוגרפי (letter-spacing / font-feature-settings / font-variation-settings).",
      evidence: hits.slice(0, 3),
      occurrences: hits.length,
    };
  }
  return {
    present: true,
    why: "Inter בשימוש ללא שום כוונון — אין letter-spacing, font-feature-settings או font-variation-settings בקוד.",
    evidence: hits.slice(0, 5),
    occurrences: hits.length,
  };
}

/**
 * #2 — a font from the worn list.
 *
 * The catalogue names seven families and nothing else counts, which makes this
 * a lookup rather than a judgement. It was left to the model anyway, and on a
 * real audit the model marked it present while its own explanation said the
 * opposite: "Heebo ... not on the exact worn list ... therefore not marked".
 * The verdict and the reasoning disagreed in the same field, and the site was
 * charged for it.
 *
 * A closed list of literal strings has no business being a question.
 */
const WORN_FAMILIES = [
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Nunito",
  "Raleway",
];

function checkWornFont(files: Map<string, string>): Verdict {
  const hits: Array<{ file: string; snippet: string }> = [];
  const seen = new Set<string>();
  // Lower-cased for matching, canonical for reporting: an explanation that
  // says "montserrat" reads like a bug even when the verdict is right.
  const worn = new Map(WORN_FAMILIES.map((f) => [f.toLowerCase(), f]));

  const note = (file: string, snippet: string, family: string) => {
    seen.add(family);
    if (hits.length < 5) hits.push({ file, snippet: clip(snippet) });
  };

  // Whole family names, split on commas and unquoted. "Roboto Slab" is its own
  // typeface and is not Roboto; a word-boundary match called it one.
  for (const [file, text] of allCss(files)) {
    for (const m of text.matchAll(/font-family\s*:([^;{}]*)/gi)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
        const canonical = worn.get(name);
        if (canonical) note(file, m[0], canonical);
      }
    }
  }

  // Loaded but not yet declared still counts: that is how a builder pulls it in.
  for (const [file, content] of htmlFiles(files)) {
    for (const link of content.matchAll(/fonts\.googleapis\.com[^"']*/gi)) {
      for (const fam of link[0].matchAll(/family=([^&:"']+)/gi)) {
        const name = decodeURIComponent(fam[1]).replace(/\+/g, " ").trim().toLowerCase();
        const canonical = worn.get(name);
        if (canonical) note(file, link[0], canonical);
      }
    }
  }

  if (!seen.size) {
    return {
      present: false,
      why: `אף אחד משבעת הפונטים השחוקים אינו בשימוש (${WORN_FAMILIES.join(", ")}).`,
    };
  }
  return {
    present: true,
    why: `האתר משתמש בפונט מהרשימה השחוקה: ${[...seen].join(", ")}.`,
    evidence: hits,
    occurrences: hits.length,
  };
}

/** #27 — structured data, present or not. */
function checkJsonLd(files: Map<string, string>): Verdict {
  for (const [file, content] of htmlFiles(files)) {
    const m = content.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/i);
    if (m) {
      return {
        present: false,
        why: "קיים בלוק JSON-LD בעמוד.",
        evidence: [{ file, snippet: clip(m[0]) }],
        occurrences: 1,
      };
    }
  }
  return { present: true, why: "אין אף <script type=\"application/ld+json\"> בקבצי ה-HTML." };
}

/** #30 — meta description missing, empty, or a copy of the title. */
function checkMetaDescription(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };
  const bad: Array<{ file: string; snippet: string }> = [];
  for (const [file, content] of pages) {
    const desc = metaContent(head(content), "name", "description");
    if (desc === null) { bad.push({ file, snippet: "אין תגית meta name=\"description\"" }); continue; }
    if (!desc) { bad.push({ file, snippet: "meta description ריקה" }); continue; }
    if (desc.toLowerCase() === docTitle(content).toLowerCase()) {
      bad.push({ file, snippet: clip(`description זהה ל-<title>: ${desc}`) });
    }
  }
  if (!bad.length) {
    return { present: false, why: "בכל עמוד יש meta description עם תוכן שאינו זהה לכותרת." };
  }
  return {
    present: true,
    why: "meta description חסרה, ריקה או זהה לכותרת הדף.",
    evidence: bad.slice(0, 5),
    occurrences: bad.length,
  };
}

const OG_REQUIRED = ["og:title", "og:description", "og:image", "og:url"];

/** #31 — Open Graph, complete or not. All four tags, per the rule. */
function checkOpenGraph(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };
  const missing: Array<{ file: string; snippet: string }> = [];
  for (const [file, content] of pages) {
    const h = head(content);
    const gone = OG_REQUIRED.filter((k) => metaContent(h, "property", k) === null);
    if (gone.length) missing.push({ file, snippet: `חסר: ${gone.join(", ")}` });
  }
  if (!missing.length) return { present: false, why: "כל ארבע תגיות ה-Open Graph קיימות." };
  return {
    present: true,
    why: "תגיות Open Graph חסרות או חלקיות.",
    evidence: missing.slice(0, 5),
    occurrences: missing.length,
  };
}

/** #40 — a preload for the font the page actually loads. */
function checkFontPreload(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  const usesWebFont = pages.some(([, c]) =>
    /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(c)
  ) || allCss(files).some(([, t]) => /@font-face/i.test(t));
  if (!usesWebFont) {
    return { present: false, applicable: false, why: "האתר לא טוען web font, ולכן אין מה לעשות preload." };
  }
  for (const [file, content] of pages) {
    const m = content.match(
      /<link\b[^>]*\brel\s*=\s*["']preload["'][^>]*>/gi,
    );
    const fontish = (m ?? []).find((tag) =>
      /\bas\s*=\s*["'](font|style)["']/i.test(tag) &&
      /fonts\.|\.woff2?|\.ttf|\.otf/i.test(tag)
    );
    if (fontish) {
      return {
        present: false,
        why: "קיים preload לפונט.",
        evidence: [{ file, snippet: clip(fontish) }],
        occurrences: 1,
      };
    }
  }
  return { present: true, why: "האתר טוען web font אך אין עבורו <link rel=\"preload\">." };
}

/** #41 — local assets served without a version or content hash. */
function checkAssetVersioning(files: Map<string, string>): Verdict {
  const unversioned: Array<{ file: string; snippet: string }> = [];
  let localRefs = 0;
  for (const [file, content] of htmlFiles(files)) {
    const refs = [
      ...content.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css[^"']*)["'][^>]*>/gi),
      ...content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js[^"']*)["'][^>]*>/gi),
    ];
    for (const m of refs) {
      const url = m[1];
      if (/^https?:|^\/\//i.test(url)) continue; // third-party CDN — not this rule
      localRefs += 1;
      const hashed = /[?&]v=|[?&]ver=|[.-][0-9a-f]{8,}\.(css|js)/i.test(url);
      if (!hashed) unversioned.push({ file, snippet: clip(url) });
    }
  }
  if (!localRefs) {
    return { present: false, applicable: false, why: "אין נכסי CSS/JS מקומיים בעמוד." };
  }
  if (!unversioned.length) {
    return { present: false, why: "לכל נכס מקומי יש גרסה או content hash בכתובת." };
  }
  return {
    present: true,
    why: "נכסי CSS/JS מקומיים נטענים ללא גרסה או content hash, כך שאין דרך לפוצץ קאש.",
    evidence: unversioned.slice(0, 5),
    occurrences: unversioned.length,
  };
}

/** #45 — the OS "reduce motion" setting, honoured or ignored. */
function checkReducedMotion(files: Map<string, string>): Verdict {
  const css = allCss(files);
  const animates = css.some(([, t]) => /@keyframes|\banimation\s*:|\btransition\s*:/i.test(t));
  if (!animates) {
    return { present: false, applicable: false, why: "אין אנימציות או מעברים בקוד." };
  }
  for (const [file, text] of css) {
    const m = text.match(/@media[^{]*prefers-reduced-motion[^{]*\{/i);
    if (m) {
      return {
        present: false,
        why: "קיים בלוק @media (prefers-reduced-motion).",
        evidence: [{ file, snippet: clip(m[0]) }],
        occurrences: 1,
      };
    }
  }
  return { present: true, why: "יש אנימציות בקוד ואין @media (prefers-reduced-motion: reduce) שמכבה אותן." };
}

/** #64 — physical CSS properties in a right-to-left site. */
function checkPhysicalProperties(files: Map<string, string>): Verdict {
  if (!isRtl(files)) {
    return { present: false, applicable: false, why: "האתר אינו RTL, ולכן מאפיינים פיזיים אינם שוברים כיווניות." };
  }
  const re =
    /(?:margin|padding)-(?:left|right)\s*:|float\s*:\s*(?:left|right)|text-align\s*:\s*(?:left|right)|\b(?:left|right)\s*:\s*(?!auto\b)[-\d.]/gi;
  const hits: Array<{ file: string; snippet: string }> = [];
  let count = 0;
  for (const [file, text] of allCss(files)) {
    for (const m of text.matchAll(re)) {
      count += 1;
      if (hits.length < 5) hits.push({ file, snippet: clip(m[0]) });
    }
  }
  if (!count) {
    return { present: false, why: "ה-CSS משתמש רק במאפיינים לוגיים — אין margin/padding-left/right, float או text-align פיזיים." };
  }
  return {
    present: true,
    why: `נמצאו ${count} שימושים במאפייני CSS פיזיים באתר RTL, במקום מאפיינים לוגיים.`,
    evidence: hits,
    occurrences: count,
  };
}

/** #94 — a keyboard user's way past the navigation. */
function checkSkipLink(files: Map<string, string>): Verdict {
  for (const [file, content] of htmlFiles(files)) {
    for (const m of content.matchAll(/<a\b[^>]*href\s*=\s*["']#[^"']+["'][^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
      const tag = m[0];
      const text = m[1].replace(/<[^>]*>/g, " ");
      if (/skip[-_\s]?(link|to|nav)/i.test(tag) || /דלג/.test(text) || /skip to/i.test(text)) {
        return {
          present: false,
          why: "קיים skip link בתחילת העמוד.",
          evidence: [{ file, snippet: clip(tag) }],
          occurrences: 1,
        };
      }
    }
  }
  return { present: true, why: "אין קישור \"דלג לתוכן\" / skip link באף עמוד." };
}

/**
 * #98 — one share image reused across every page.
 *
 * A MISSING og:image is not this signal, it is #31, which already lists
 * og:image among the four tags it requires. Counting the same absence twice
 * would inflate every no-Open-Graph site by one, so absence hands back
 * applicable=false here. This signal is only ever about repetition.
 */
function checkOgImage(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };
  const images: Array<{ file: string; src: string | null }> = pages.map(([file, content]) => ({
    file,
    src: metaContent(head(content), "property", "og:image"),
  }));
  const withImage = images.filter((i) => i.src);
  if (!withImage.length) {
    return { present: false, applicable: false, why: "אין og:image כלל — חוסר בתגיות Open Graph נספר תחת סימן #31 ולא כאן." };
  }
  if (pages.length === 1) {
    return { present: false, applicable: false, why: "אתר של עמוד אחד — אין עמודים נוספים שיחלקו את אותה תמונה." };
  }
  const distinct = new Set(withImage.map((i) => i.src));
  if (distinct.size === 1) {
    return {
      present: true,
      why: "כל העמודים חולקים את אותה og:image בדיוק.",
      evidence: withImage.slice(0, 5).map((i) => ({ file: i.file, snippet: clip(String(i.src)) })),
      occurrences: withImage.length,
    };
  }
  return { present: false, why: "לכל עמוד יש og:image משלו." };
}

// Pictographs, symbols, transport, dingbats and the enclosed keycaps — the
// decorative ranges. Text-presentation characters that happen to live nearby
// (arrows, punctuation) are deliberately not included.
export const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/** #109 — emoji anywhere the reader can see them. */
function checkEmoji(files: Map<string, string>): Verdict {
  const hits: Array<{ file: string; snippet: string }> = [];
  let count = 0;
  for (const [file, content] of files) {
    if (!isHtml(file) && !isCss(file)) continue;
    const text = isCss(file) ? content : visibleMarkup(content);
    for (const m of text.matchAll(EMOJI_RE)) {
      count += 1;
      if (hits.length < 5) {
        const at = m.index ?? 0;
        hits.push({ file, snippet: clip(text.slice(Math.max(0, at - 60), at + 60)) });
      }
    }
  }
  if (!count) return { present: false, why: "אין אמוג'י בשום מקום בקוד הגלוי." };
  return {
    present: true,
    why: `נמצאו ${count} אמוג'י בתוכן או בממשק.`,
    evidence: hits,
    occurrences: count,
  };
}

/**
 * #56 — a focus ring switched off with nothing put in its place.
 *
 * The written rule carries a clause — "ללא חלופה מעוצבת" — and the clause is
 * the whole signal. `outline: none` next to a `:focus-visible` rule that draws
 * a real ring is the CORRECT modern pattern, and a check that flagged it would
 * punish the exact code we tell the builder to write.
 *
 * So a killed outline is only a fault when nothing else in that block, and no
 * :focus-visible rule anywhere, marks the focused element. A model called this
 * present on a block that restyled the border AND the background; the rule
 * says that is a styled alternative, so this says so too.
 */
function checkFocusOutline(files: Map<string, string>): Verdict {
  const cssBlocks: Array<[string, string, string]> = [];
  for (const [file, text] of allCss(files)) {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      cssBlocks.push([file, m[1].trim(), m[2]]);
    }
  }
  if (!cssBlocks.length) {
    return { present: false, applicable: false, why: "אין CSS בפרויקט." };
  }

  const killsOutline = (body: string) => /outline\s*:\s*(?:none|0)\b/i.test(body);
  // A ring drawn by any means: a real outline, a shadow, or a ring-width.
  const drawsRing = (body: string) =>
    /outline\s*:\s*(?!none\b|0\b)[^;]+/i.test(body) ||
    /outline-(?:width|style|color)\s*:/i.test(body) ||
    /box-shadow\s*:\s*(?!none\b)[^;]+/i.test(body);
  // The rule says "styled alternative", not "outline". Anything that visibly
  // marks the focused element counts, and a border or a fill both do.
  const marksFocus = (body: string) =>
    drawsRing(body) ||
    /(?:^|[;{\s])(?:border|border-[a-z-]*color|background|background-color|text-decoration)\s*:/i
      .test(body);

  const globalRing = cssBlocks.some(
    ([, sel, body]) => /:focus-visible/i.test(sel) && !killsOutline(body) && drawsRing(body),
  );

  const bare: Array<{ file: string; snippet: string }> = [];
  let killed = 0;
  for (const [file, sel, body] of cssBlocks) {
    if (!/:focus\b|:focus-visible|:focus-within/i.test(sel)) continue;
    if (!killsOutline(body)) continue;
    killed += 1;
    if (globalRing || marksFocus(body)) continue;
    if (bare.length < 5) bare.push({ file, snippet: clip(`${sel} { ${body} }`) });
  }

  if (!killed) {
    return { present: false, why: "אין כלל CSS שמכבה את מסגרת הפוקוס." };
  }
  if (!bare.length) {
    return {
      present: false,
      why: "מסגרת הפוקוס מכובה, אך קיימת חלופה מעוצבת שמסמנת את האלמנט הממוקד.",
      occurrences: 0,
    };
  }
  return {
    present: true,
    why: `נמצאו ${bare.length} כללי :focus שמכבים את המסגרת בלי שום חלופה מעוצבת.`,
    evidence: bare,
    occurrences: bare.length,
  };
}

/** #61 — no dataLayer anywhere in the site's JavaScript. */
function checkDataLayer(files: Map<string, string>): Verdict {
  for (const [file, body] of allJs(files)) {
    const m = body.match(/[^\n;]*\bdataLayer\b[^\n;]*/);
    if (m) {
      return {
        present: false,
        why: "קיים dataLayer בקוד ה-JavaScript של האתר.",
        evidence: [{ file, snippet: clip(m[0]) }],
        occurrences: 1,
      };
    }
  }
  return {
    present: true,
    why: "לא נמצא window.dataLayer באף קובץ JavaScript או סקריפט מוטמע.",
    occurrences: 0,
  };
}

/**
 * #78 — numbers and currency running the wrong way inside right-to-left text.
 *
 * Two runs in a row reported this present, and both times the evidence they
 * quoted was `₪180` — the CORRECT Hebrew order, symbol first — under an
 * explanation claiming the symbol came last. A search over the whole site
 * found five symbol-first prices and zero number-first ones. The reading was
 * confident, repeatable and backwards, which is precisely the case this file
 * exists to take away from a model.
 *
 * Both halves of the written rule are encoded, and each is one of the rule's
 * own examples: the currency order, and a digit run fused to Hebrew letters
 * with no separator ("₪ 24,900לפרטים" shipped in a real build). Nothing here
 * judges whether isolation is stylistically warranted — only whether the text
 * reads in an order the bidirectional algorithm will visibly break.
 */
const CURRENCY = "₪$€£";

function checkNumberDirection(files: Map<string, string>): Verdict {
  if (!isRtl(files)) {
    return { present: false, applicable: false, why: "האתר אינו RTL, ולכן כיוון המספרים אינו רלוונטי." };
  }
  // A Hebrew RUN of two letters or more. One letter is a legitimate prefix
  // ("ב2024" is how the language is written) and flagging it would be wrong.
  // At most one ordinary space between the number and its symbol. Allowing
  // any whitespace let a match jump a line break and pair a number in one
  // sentence with a symbol in the next, which is not a direction fault at all.
  const gap = "[ \u00A0]?";
  const numberFirst = new RegExp(`\\d[\\d,.]*${gap}[${CURRENCY}]`, "g");
  const symbolFirst = new RegExp(`[${CURRENCY}]${gap}\\d`, "g");
  const glued = /(?:\d[\d,.]*[֐-׿]{2}|[֐-׿]{2}\d)/g;

  const hits: Array<{ file: string; snippet: string }> = [];
  let wrong = 0;
  let right = 0;

  for (const [file, content] of htmlFiles(files)) {
    const text = readableText(content);
    right += [...text.matchAll(symbolFirst)].length;
    for (const re of [numberFirst, glued]) {
      for (const m of text.matchAll(re)) {
        wrong += 1;
        const at = m.index ?? 0;
        if (hits.length < 5) {
          hits.push({ file, snippet: clip(text.slice(Math.max(0, at - 50), at + 50)) });
        }
      }
    }
  }

  if (wrong) {
    return {
      present: true,
      why: `נמצאו ${wrong} מקומות שבהם מספר או מטבע רצים בכיוון שגוי בתוך טקסט עברי.`,
      evidence: hits,
      occurrences: wrong,
    };
  }
  if (right) {
    return {
      present: false,
      why: `כל ${right} סכומי המטבע כתובים בסדר הנכון (הסמל לפני המספר), ואין מספרים דבוקים לטקסט עברי.`,
      occurrences: 0,
    };
  }
  return {
    present: false,
    why: "אין מטבע בסדר הפוך ואין מספרים דבוקים לאותיות עבריות.",
    occurrences: 0,
  };
}

/**
 * #99 — a canonical URL that is missing, or shared instead of self-referential.
 *
 * The rule asks for a canonical "that points at itself on every page", so two
 * pages naming the same URL fail it exactly as an absent tag does: that is the
 * duplicate-content case the rule is named for.
 */
function checkCanonical(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };

  const found = pages.map(([file, content]) => {
    const tag = head(content).match(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
    return {
      file,
      tag,
      href: tag?.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1]?.trim().replace(/\/$/, "") ?? null,
    };
  });

  const missing = found.filter((f) => !f.href);
  if (missing.length) {
    return {
      present: true,
      why: `${missing.length} מתוך ${pages.length} עמודים ללא תג canonical.`,
      evidence: missing.slice(0, 5).map((f) => ({ file: f.file, snippet: "אין <link rel=\"canonical\">" })),
      occurrences: missing.length,
    };
  }
  const distinct = new Set(found.map((f) => f.href));
  if (pages.length > 1 && distinct.size < pages.length) {
    return {
      present: true,
      why: "יש canonical בכל עמוד, אך עמודים שונים מצביעים על אותה כתובת במקום על עצמם.",
      evidence: found.slice(0, 5).map((f) => ({ file: f.file, snippet: clip(String(f.tag)) })),
      occurrences: pages.length - distinct.size,
    };
  }
  return {
    present: false,
    why: "לכל עמוד יש תג canonical משלו שמצביע על עצמו.",
    occurrences: 0,
  };
}

// ---------- headings ----------

/** Every heading in document order, as [level, text, raw]. */
function headings(html: string): Array<[number, string, string]> {
  const out: Array<[number, string, string]> = [];
  for (const m of visibleMarkup(html).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    out.push([Number(m[1]), m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), m[0]]);
  }
  return out;
}

/** #28 — more than one <h1> on a page. A count, nothing else. */
function checkMultipleH1(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };
  const bad: Array<{ file: string; snippet: string }> = [];
  let total = 0;
  for (const [file, content] of pages) {
    const h1s = headings(content).filter(([lvl]) => lvl === 1);
    if (h1s.length > 1) {
      total += h1s.length;
      bad.push({ file, snippet: clip(`${h1s.length} תגיות h1: ` + h1s.map(([, t]) => t || "(ריק)").join(" | ")) });
    }
  }
  if (!bad.length) return { present: false, why: "בכל עמוד יש h1 אחד לכל היותר." };
  return { present: true, why: "יש עמוד עם יותר מ-h1 אחד.", evidence: bad.slice(0, 5), occurrences: total };
}

/**
 * #29 — a skipped level in the heading hierarchy.
 *
 * The written rule names two faults and this implements both: a jump down of
 * more than one level (h2 straight to h4), and an h3 that appears before the
 * page's first h2. Nothing else counts — going back UP any distance is normal
 * and is not a skip.
 */
function checkHeadingOrder(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (!pages.length) return { present: false, applicable: false, why: "אין קבצי HTML." };
  const bad: Array<{ file: string; snippet: string }> = [];
  let total = 0;
  for (const [file, content] of pages) {
    const hs = headings(content);
    if (hs.length < 2) continue;
    let seenH2 = false;
    let prev = hs[0][0];
    if (prev === 2) seenH2 = true;
    for (const [lvl, text] of hs.slice(1)) {
      if (lvl > prev + 1) {
        total += 1;
        bad.push({ file, snippet: clip(`h${prev} ואחריו h${lvl}: "${text || "(ריק)"}"`) });
      } else if (lvl === 3 && !seenH2) {
        total += 1;
        bad.push({ file, snippet: clip(`h3 לפני ה-h2 הראשון: "${text || "(ריק)"}"`) });
      }
      if (lvl === 2) seenH2 = true;
      prev = lvl;
    }
  }
  if (!bad.length) return { present: false, why: "היררכיית הכותרות רציפה בכל עמוד." };
  return { present: true, why: "יש דילוג בהיררכיית הכותרות.", evidence: bad.slice(0, 5), occurrences: total };
}

/** #97 — the same meta description on more than one page. */
function checkDuplicateDescription(files: Map<string, string>): Verdict {
  const pages = htmlFiles(files);
  if (pages.length < 2) {
    return { present: false, applicable: false, why: "לעמוד יחיד אין מול מה לשכפל description." };
  }
  const byDesc = new Map<string, string[]>();
  for (const [file, content] of pages) {
    const desc = (metaContent(head(content), "name", "description") ?? "").trim();
    if (!desc) continue; // an absent description is #30's business, not this one
    const key = desc.toLowerCase();
    byDesc.set(key, [...(byDesc.get(key) ?? []), file]);
  }
  const dupes = [...byDesc.entries()].filter(([, f]) => f.length > 1);
  if (!dupes.length) {
    return { present: false, why: "אין שתי עמודים עם אותה meta description." };
  }
  return {
    present: true,
    why: "אותה meta description חוזרת ביותר מעמוד אחד.",
    evidence: dupes.slice(0, 5).map(([desc, f]) => ({
      file: f[0],
      snippet: clip(`${f.length} עמודים (${f.slice(0, 3).join(", ")}) חולקים: ${desc}`),
    })),
    occurrences: dupes.reduce((n, [, f]) => n + f.length, 0),
  };
}

// ---------- fonts, colour, images ----------

/** #8 — a web font loaded without font-display. */
function checkFontDisplay(files: Map<string, string>): Verdict {
  const faces: Array<{ file: string; snippet: string }> = [];
  let webfonts = 0;

  for (const [file, css] of allCss(files)) {
    for (const m of css.matchAll(/@font-face\s*\{[\s\S]*?\}/gi)) {
      webfonts += 1;
      if (!/font-display\s*:\s*(swap|optional)/i.test(m[0])) {
        faces.push({ file, snippet: clip(m[0]) });
      }
    }
    // @import url("https://fonts.googleapis.com/...") inside a stylesheet.
    for (const m of css.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/fonts\.googleapis\.com[^"')\s]+)/gi)) {
      webfonts += 1;
      if (!/[?&]display=(swap|optional)/i.test(m[1])) faces.push({ file, snippet: clip(m[1]) });
    }
  }
  // <link href="https://fonts.googleapis.com/css2?family=...">
  for (const [file, content] of htmlFiles(files)) {
    for (const m of content.matchAll(/<link\b[^>]*href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com[^"']+)["'][^>]*>/gi)) {
      if (/\brel\s*=\s*["'](preconnect|dns-prefetch)["']/i.test(m[0])) continue;
      webfonts += 1;
      if (!/[?&]display=(swap|optional)/i.test(m[1])) faces.push({ file, snippet: clip(m[1]) });
    }
  }

  if (!webfonts) {
    return { present: false, applicable: false, why: "האתר לא טוען פונט web — אין למה להחיל font-display." };
  }
  if (!faces.length) {
    return { present: false, why: "לכל פונט שנטען מוגדר font-display: swap או optional." };
  }
  return {
    present: true,
    why: "פונט נטען ללא font-display: swap / optional.",
    evidence: faces.slice(0, 5),
    occurrences: faces.length,
  };
}

/**
 * #13 — #000 as the base background in dark mode.
 *
 * Only inside a dark context, per the rule: a dark-only site whose body is
 * black is the same fault, but a light site with a black footer is not.
 */
const DARK_CONTEXT = /@media[^{]*prefers-color-scheme\s*:\s*dark|\.dark\b|\[data-theme\s*=\s*["']?dark|:root\.dark|html\.dark/i;
const BLACK = /background(-color)?\s*:\s*(#000{1,2}([0-9a-f]{2})?\b|#000000\b|black\b|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)])/i;

/** The body of every `@media (prefers-color-scheme: dark) { … }` block. */
function darkMediaBodies(css: string): string[] {
  const out: string[] = [];
  const re = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** Rules in a chunk of CSS whose selector names the page's base surface. */
function baseSurfaceRules(chunk: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!/(^|[\s,>+~])(body|html|:root)\b/i.test(sel)) continue;
    out.push([sel, m[2]]);
  }
  return out;
}

function checkDarkBlack(files: Map<string, string>): Verdict {
  const hits: Array<{ file: string; snippet: string }> = [];
  let darkSeen = false;

  for (const [file, css] of allCss(files)) {
    if (!DARK_CONTEXT.test(css)) continue;
    darkSeen = true;

    // Inside a dark media query, any base-surface rule is a dark-mode rule.
    for (const body of darkMediaBodies(css)) {
      for (const [sel, decls] of baseSurfaceRules(body)) {
        if (BLACK.test(decls)) hits.push({ file, snippet: clip(`@media dark → ${sel} { ${decls.trim()} }`) });
      }
    }
    // Outside one, the selector itself has to carry the dark theme.
    for (const [sel, decls] of baseSurfaceRules(css)) {
      if (!DARK_CONTEXT.test(sel)) continue;
      if (BLACK.test(decls)) hits.push({ file, snippet: clip(`${sel} { ${decls.trim()} }`) });
    }
  }

  if (!darkSeen) {
    return { present: false, applicable: false, why: "אין לאתר מצב dark — הסימן לא ישים." };
  }
  if (!hits.length) {
    return { present: false, why: "מצב ה-dark לא משתמש בשחור מוחלט כרקע הבסיס." };
  }
  return {
    present: true,
    why: "רקע הבסיס במצב dark הוא שחור מוחלט (#000).",
    evidence: hits.slice(0, 5),
    occurrences: hits.length,
  };
}

/** #35 — <img> without both width and height. */
function checkImageDimensions(files: Map<string, string>): Verdict {
  const bad: Array<{ file: string; snippet: string }> = [];
  let imgs = 0;
  for (const [file, content] of htmlFiles(files)) {
    for (const m of visibleMarkup(content).matchAll(/<img\b[^>]*>/gi)) {
      imgs += 1;
      const hasW = /\bwidth\s*=\s*["']?\d/i.test(m[0]);
      const hasH = /\bheight\s*=\s*["']?\d/i.test(m[0]);
      if (!hasW || !hasH) bad.push({ file, snippet: clip(m[0]) });
    }
  }
  if (!imgs) return { present: false, applicable: false, why: "אין תגיות <img> בעמודים." };
  if (!bad.length) return { present: false, why: "לכל <img> יש width ו-height מפורשים." };
  return {
    present: true,
    why: "יש <img> ללא width ו-height — מקור ל-CLS.",
    evidence: bad.slice(0, 5),
    occurrences: bad.length,
  };
}

/**
 * #36 — raster images still served as JPG/PNG.
 *
 * The binaries never reach the bundle (keepPath drops them), so this reads the
 * REFERENCES, which is what the written rule points at: "src מכיל .jpg/.png".
 *
 * Only places that actually PAINT an image count — img/source src and srcset,
 * and CSS url(). A first pass swept every .jpg-looking string in the markup
 * and flagged an og:image, which is a social-card preview nobody downloads
 * while the page renders. That is the wrong fault at the wrong weight.
 */
function checkImageFormat(files: Map<string, string>): Verdict {
  const old: Array<{ file: string; snippet: string }> = [];
  let refs = 0;

  const note = (file: string, url: string) => {
    if (!/\.(jpe?g|png|webp|avif)(\?[^\s]*)?$/i.test(url)) return;
    refs += 1;
    if (/\.(jpe?g|png)(\?[^\s]*)?$/i.test(url)) old.push({ file, snippet: clip(url, 80) });
  };

  for (const [file, content] of htmlFiles(files)) {
    for (const m of visibleMarkup(content).matchAll(/<(img|source)\b[^>]*>/gi)) {
      const src = attr(m[0], "src");
      if (src) note(file, src);
      const set = attr(m[0], "srcset");
      if (set) {
        for (const cand of set.split(",")) note(file, cand.trim().split(/\s+/)[0]);
      }
    }
  }
  for (const [file, css] of allCss(files)) {
    for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) note(file, m[1].trim());
  }

  if (!refs) return { present: false, applicable: false, why: "אין תמונות רסטר שהעמוד מציג." };
  if (!old.length) return { present: false, why: "כל התמונות מוגשות ב-WebP או AVIF." };
  return {
    present: true,
    why: "תמונות מוגשות ב-JPG/PNG ולא ב-WebP/AVIF.",
    evidence: old.slice(0, 5),
    occurrences: old.length,
  };
}

/** #55 — a div or span wired as a button without the keyboard half. */
function checkClickableDiv(files: Map<string, string>): Verdict {
  const bad: Array<{ file: string; snippet: string }> = [];
  for (const [file, content] of htmlFiles(files)) {
    for (const m of visibleMarkup(content).matchAll(/<(div|span)\b[^>]*\bonclick\s*=[^>]*>/gi)) {
      const tag = m[0];
      const isButton = /\brole\s*=\s*["']button["']/i.test(tag);
      const focusable = /\btabindex\s*=\s*["']?0/i.test(tag);
      const keyboard = /\bon(keydown|keypress|keyup)\s*=/i.test(tag);
      if (isButton && focusable && keyboard) continue;
      const missing = [
        isButton ? null : 'role="button"',
        focusable ? null : 'tabindex="0"',
        keyboard ? null : "onkeydown",
      ].filter(Boolean).join(", ");
      bad.push({ file, snippet: clip(`חסר ${missing} — ${tag}`) });
    }
  }
  if (!bad.length) {
    return { present: false, why: "אין div/span עם onclick שחסרים לו role, tabindex ומקלדת." };
  }
  return {
    present: true,
    why: "יש <div>/<span> עם onclick ללא role=\"button\" + tabindex=\"0\" + onkeydown.",
    evidence: bad.slice(0, 5),
    occurrences: bad.length,
  };
}

const CHECKS: Record<number, (f: Map<string, string>) => Verdict> = {
  1: checkInter,
  2: checkWornFont,
  8: checkFontDisplay,
  13: checkDarkBlack,
  27: checkJsonLd,
  28: checkMultipleH1,
  29: checkHeadingOrder,
  30: checkMetaDescription,
  31: checkOpenGraph,
  35: checkImageDimensions,
  36: checkImageFormat,
  40: checkFontPreload,
  41: checkAssetVersioning,
  45: checkReducedMotion,
  55: checkClickableDiv,
  56: checkFocusOutline,
  61: checkDataLayer,
  64: checkPhysicalProperties,
  78: checkNumberDirection,
  94: checkSkipLink,
  97: checkDuplicateDescription,
  98: checkOgImage,
  99: checkCanonical,
  109: checkEmoji,
};

/**
 * Run every mechanical check over the project.
 *
 * confidence is 1 throughout, and that is not bravado: these are text searches,
 * so the answer is the same on every run over the same bytes. What can be wrong
 * is the rule, not the reading of it.
 */
export function mechanicalSignals(files: Map<string, string>): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  for (const id of MECHANICAL_IDS) {
    const meta = META.get(id);
    const check = CHECKS[id];
    if (!meta || !check) continue;
    let v: Verdict;
    try {
      v = check(files);
    } catch (e) {
      // A crashing check must not take the audit down with it; leaving the
      // signal out hands it back to the model on the next merge.
      console.error(`mechanical check #${id} failed:`, e);
      continue;
    }
    out.push({
      id,
      name: meta.name,
      present: v.present,
      applicable: v.applicable !== false,
      weight: meta.weight,
      confidence: 1,
      total_occurrences: v.occurrences ?? (v.present ? 1 : 0),
      explanation: v.why,
      evidence: v.evidence ?? [],
    });
  }
  return out;
}

/**
 * Mechanical verdicts win over whatever the model said about the same ids.
 * Takes the loose shape DetectionResult stores so it can be applied in place.
 */
export function overlayMechanical(
  signals: Array<Record<string, unknown>>,
  mechanical: DetectedSignal[],
): Array<Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  for (const s of signals) byId.set(Number(s.id), s);
  for (const s of mechanical) byId.set(s.id, s as unknown as Record<string, unknown>);
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
