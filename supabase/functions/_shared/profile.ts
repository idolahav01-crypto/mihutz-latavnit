// What the design stage needs to know about the site before it proposes anything.
//
// Three of the four facts here are measurements, not judgments, so they are
// taken from the bundle in code rather than asked of the model:
//
//   language  — which script the copy is actually written in
//   assets    — what visual material the site actually has
//   colour    — whether a hex is one of the AI tool defaults
//
// The fourth (is this colour a deliberate brand decision, and what industry is
// this) is genuinely a judgment and stays with the model, which is why
// site_profile gains fields for it rather than this file inventing them.
//
// The motive is the same one behind mechanical.ts: a design direction is one
// call and one chance, and building it on a guess about the site is how you get
// a Hebrew site in a Latin-only font, or a photography-led layout for a
// business that owns no photographs.

/** Fonts that ship a real Hebrew face. The design stage may pick only these
 *  for a Hebrew site — not as a prompt request, but as a schema enum, because
 *  a font without Hebrew glyphs silently falls back and the page looks broken.
 *  Signal #74 exists precisely because this keeps happening. */
export const HEBREW_SAFE_FONTS = [
  "Heebo",
  "Assistant",
  "Rubik",
  "Noto Sans Hebrew",
  "Frank Ruhl Libre",
  "Secular One",
  "Suez One",
  "Karantina",
  "Alef",
  "Varela Round",
  "David Libre",
  "Miriam Libre",
  "Bellefair",
  "Amatic SC",
] as const;

/** For a Latin site the field is still closed, but far wider. Inter is absent
 *  on purpose: it is signal #1, and offering it as an option is offering the
 *  single most common AI tell. */
export const LATIN_SAFE_FONTS = [
  "Fraunces",
  "Sora",
  "Manrope",
  "Space Grotesk",
  "Work Sans",
  "IBM Plex Sans",
  "IBM Plex Serif",
  "Source Serif 4",
  "Libre Franklin",
  "Public Sans",
  "Newsreader",
  "Literata",
  "Instrument Serif",
  "Archivo",
  "Chivo",
  "Outfit",
  "Bricolage Grotesque",
  "Crimson Pro",
  "Lora",
  "Spectral",
] as const;

export function fontChoices(rtl: boolean): string[] {
  return rtl ? [...HEBREW_SAFE_FONTS] : [...LATIN_SAFE_FONTS];
}

// ---------------- colour ----------------

// The palettes an AI tool reaches for when nobody chose a colour. Tailwind's
// indigo/violet/blue ramp (signal #11), the purple-to-blue hero gradient
// (signal #9), and the dark+gold "premium" cliche (signal #67). A site wearing
// one of these is not wearing a brand colour, it is wearing a default.
const AI_DEFAULT_HEXES = new Set([
  // tailwind indigo / violet / blue, the exact values signal #11 names
  "#6366f1", "#8b5cf6", "#3b82f6", "#4f46e5", "#7c3aed", "#2563eb",
  "#818cf8", "#a78bfa", "#60a5fa", "#4338ca", "#6d28d9", "#1d4ed8",
  // the gold/amber "premium" accent of signal #67/#70
  "#c9a84c", "#d4a853", "#d4af37", "#b8860b", "#e0b64c",
]);

/** Normalise #abc / #AABBCC / 0xAABBCC to lowercase #aabbcc, or null. */
export function normHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).trim().replace(/^0x/i, "#").match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h);
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** HSL saturation and lightness, 0-1. Used for the neon test. */
function sl(hex: string): { s: number; l: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

/**
 * True if this colour is a tool default rather than a decision.
 *
 * Three tests, all from the catalogue's own rules: the named hex lists, the
 * neon range signal #14 defines (saturation > 90%, lightness > 60%), and pure
 * black/white, which nobody chooses as a brand colour.
 */
export function isAiDefaultColour(raw: string): boolean {
  const hex = normHex(raw);
  if (!hex) return false;
  if (AI_DEFAULT_HEXES.has(hex)) return true;
  if (hex === "#000000" || hex === "#ffffff") return true;
  const { s, l } = sl(hex);
  return s > 0.9 && l > 0.6; // neon, per signal #14
}

// ---------------- assets ----------------

export interface AssetInventory {
  /** Images the pages actually paint, excluding logo/icon chrome. */
  photos: number;
  /** Logo-ish or icon-ish references. */
  chrome: number;
  /** Inline SVG and <svg> use — illustration a page carries with no asset file. */
  inline_svg: number;
  /** Background images declared in CSS. */
  css_images: number;
  /** The honest summary the design stage is given. */
  verdict: "none" | "logo_only" | "some" | "rich";
}

const CHROME = /logo|icon|favicon|sprite|avatar|placeholder/i;

/**
 * What visual material this site actually owns.
 *
 * The binaries never reach the bundle, so this counts REFERENCES — which is
 * the right unit anyway: a direction that calls for full-bleed photography is
 * unbuildable for a business with one logo and nothing else, whether or not we
 * could open the files.
 */
export function assetInventory(files: Map<string, string>): AssetInventory {
  let photos = 0, chrome = 0, inlineSvg = 0, cssImages = 0;
  const seen = new Set<string>();

  for (const [path, content] of files) {
    if (/\.html?$/i.test(path)) {
      const visible = content
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");
      for (const m of visible.matchAll(/<(?:img|source)\b[^>]*\b(?:src|srcset)\s*=\s*["']([^"']+)["']/gi)) {
        const url = m[1].split(",")[0].trim().split(/\s+/)[0];
        if (!url || url.startsWith("data:") || seen.has(url)) continue;
        seen.add(url);
        if (CHROME.test(url)) chrome += 1;
        else photos += 1;
      }
      inlineSvg += [...visible.matchAll(/<svg\b/gi)].length;
    }
    if (/\.(css|scss|sass|less|html?)$/i.test(path)) {
      for (const m of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        const url = m[1].trim();
        if (!/\.(png|jpe?g|webp|avif|gif)$/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        if (CHROME.test(url)) chrome += 1;
        else cssImages += 1;
      }
    }
  }

  const real = photos + cssImages;
  const verdict: AssetInventory["verdict"] = real >= 6
    ? "rich"
    : real >= 1
    ? "some"
    : (chrome > 0 || inlineSvg > 0)
    ? "logo_only"
    : "none";

  return { photos, chrome, inline_svg: inlineSvg, css_images: cssImages, verdict };
}

// ---------------- language ----------------

export interface LanguageRead {
  /** BCP-47-ish tag for the script that dominates the copy. */
  code: "he" | "ar" | "ru" | "am" | "en" | "unknown";
  /** Share of letters belonging to that script, 0-1. */
  share: number;
  /** Whether the product has been built and tested for it. */
  supported: boolean;
  rtl: boolean;
}

const SCRIPTS: Array<[LanguageRead["code"], RegExp, boolean]> = [
  ["he", /[֐-׿]/g, true],
  ["ar", /[؀-ۿݐ-ݿ]/g, true],
  ["ru", /[Ѐ-ӿ]/g, false],
  ["am", /[ሀ-፿]/g, false],
  ["en", /[A-Za-z]/g, false],
];

/**
 * Which language the site is actually written in, by counting letters.
 *
 * site_profile already carries a `primary_language` the model fills in, and
 * nothing has ever read it. This is the same question answered by measurement,
 * which matters because the answer gates a warning we show the user: telling
 * someone their Russian site is outside what we test for is only honest if we
 * are sure it IS a Russian site.
 */
export function detectLanguage(files: Map<string, string>): LanguageRead {
  let text = "";
  for (const [path, content] of files) {
    if (!/\.html?$/i.test(path)) continue;
    text += " " + content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ");
    if (text.length > 400_000) break;
  }

  const counts = SCRIPTS.map(([code, re]) => {
    re.lastIndex = 0;
    return [code, (text.match(re) ?? []).length] as [LanguageRead["code"], number];
  });
  const total = counts.reduce((n, [, c]) => n + c, 0);
  if (!total) return { code: "unknown", share: 0, supported: true, rtl: false };

  counts.sort((a, b) => b[1] - a[1]);
  const [code, count] = counts[0];
  const rtl = SCRIPTS.find(([c]) => c === code)?.[2] ?? false;
  return {
    code,
    share: count / total,
    // Hebrew and English are what the product was built and measured on. Any
    // other script still scans and still builds — the user is simply told.
    supported: code === "he" || code === "en",
    rtl,
  };
}
