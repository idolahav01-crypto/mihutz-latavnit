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
export const MECHANICAL_IDS: number[] = [1, 27, 30, 31, 40, 41, 45, 64, 94, 98, 109];

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

const CHECKS: Record<number, (f: Map<string, string>) => Verdict> = {
  1: checkInter,
  27: checkJsonLd,
  30: checkMetaDescription,
  31: checkOpenGraph,
  40: checkFontPreload,
  41: checkAssetVersioning,
  45: checkReducedMotion,
  64: checkPhysicalProperties,
  94: checkSkipLink,
  98: checkOgImage,
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
