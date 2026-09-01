// Deterministic content extraction for the rebuild pipeline.
//
// The rebuild used to ask a model to re-inventory a page into a content spec,
// then rebuilt everything from that spec. That single step was lossy: the model
// kept one representative of each repeated group and dropped whole sections, so
// eight player cards became zero and an interactive quiz lost the DOM its
// carried-over script needed. Measured on a real page (Arsenal), the rebuild
// shipped with most of its content gone while the fingerprint score still fell,
// so the loss looked like success.
//
// This module removes the model from content entirely. It parses the ORIGINAL
// markup into a ledger that is complete by construction — every section, every
// repeated item, and the verbatim inner HTML of any element a script targets —
// so the model is left with exactly one job downstream: the design. Content can
// only be re-skinned, never invented and never dropped.

import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1.56/wasm";

export interface LedgerItem {
  title?: string;
  text?: string;
  value?: string;
}

export interface LedgerImage {
  src: string;
  alt?: string;
}

/**
 * The site's mark. Either a file at a path, or an inline <svg> — which is worth
 * separating, because an inline logo is TEXT: its colours can be read, and the
 * design stage can be told what the brand's own mark is coloured before it
 * proposes a palette to sit beside it. A raster logo cannot be read that way
 * and does not pretend to be.
 */
export interface LedgerLogo {
  src?: string;
  alt?: string;
  /** Verbatim markup, when the logo is drawn inline rather than linked. */
  svg?: string;
  /** Colours found in an inline mark, most-used first. */
  colours?: string[];
}

export interface LedgerSection {
  /** Stable slug: the element's own id, else a slug of the heading, else section-N. */
  id: string;
  /** Coarse hint for the builder: "hero" | "interactive" | "content". Not load-bearing. */
  type: string;
  heading?: string;
  subheading?: string;
  body?: string;
  items: LedgerItem[];
  cta?: { label?: string; href?: string };
  /**
   * The images this section actually shows, in document order.
   *
   * The ledger had no concept of an image at all — the word did not appear in
   * this file — so a page's photography was invisible to every stage that came
   * after it, and the rebuild returned text in boxes. A src the original used
   * is a real asset at a real path: carrying it means the rebuilt page points
   * at the same file the site already ships.
   */
  images?: LedgerImage[];
  /** Set when this section hosts an element a carried <script> references. */
  component_id?: string;
  /**
   * For a component section: the container's exact inner HTML, carried through
   * untouched so the script's DOM (its ids) survives the rebuild verbatim.
   */
  verbatim_html?: string;
  /** The section's full visible text — the ground truth the coverage check counts. */
  text: string;
}

/** script_index for a container driven by a .js file rather than an inline block. */
export const EXTERNAL_SCRIPT = -1;

export interface LedgerComponent {
  name: string;
  container_id: string;
  /** Index into the extracted scripts array whose code references this container. */
  script_index?: number;
}

export interface Ledger {
  meta: {
    name: string;
    language: string;
    dir: "rtl" | "ltr";
    /**
     * The site's logo, if the page carries one.
     *
     * It lives in the header, which the ledger skips as chrome, so it was being
     * thrown away before anything downstream could see it — and the shell is
     * told to write the logo as TEXT. A business's mark is not a fault to be
     * cleaned out of its own site.
     */
    logo?: LedgerLogo;
  };
  dir: "rtl" | "ltr";
  facts: string[];
  sections: LedgerSection[];
  components: LedgerComponent[];
  /**
   * The original page's own <style> text, concatenated. A widget carried
   * verbatim needs its original look; the rebuild scopes this under the widget's
   * wrapper (see scopeCss) so the quiz styles itself exactly as before without
   * leaking a single rule into the redesigned sections.
   */
  styleText: string;
}

// Blocks that are chrome, not page content. A <footer> is rebuilt by the shell;
// a nav-only <header> likewise. A <header> that carries a heading is a hero and
// stays as content.
const CHROME_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "NOSCRIPT"]);

/** Tags that declare themselves to be a section. Never split one open. */
const SECTION_TAGS = new Set(["SECTION", "ARTICLE"]);
/** Containers that hold sections rather than being one. */
const WRAPPER_TAGS = new Set(["MAIN", "DIV", "BODY"]);
/** How far to chase a nest of wrappers before calling it content. */
const MAX_WRAPPER_DEPTH = 5;

/** Images an element shows, in document order, with their alt text. */
function imagesIn(el: Element, limit = 8): LedgerImage[] {
  const out: LedgerImage[] = [];
  const seen = new Set<string>();
  const add = (src: string | null, alt?: string | null) => {
    const url = (src ?? "").trim();
    // A data: URI is already inline in the markup and would bloat the spec that
    // gets sent to the model; a real path is what makes the asset reusable.
    if (!url || url.startsWith("data:") || seen.has(url) || out.length >= limit) return;
    seen.add(url);
    const image: LedgerImage = { src: url };
    const text = (alt ?? "").trim();
    if (text) image.alt = text;
    out.push(image);
  };

  for (const node of Array.from(el.querySelectorAll("img, source, [style*='background-image']")) as Element[]) {
    if (node.tagName === "IMG") {
      add(node.getAttribute("src"), node.getAttribute("alt"));
    } else if (node.tagName === "SOURCE") {
      add((node.getAttribute("srcset") ?? "").split(",")[0].trim().split(/\s+/)[0]);
    } else {
      const m = (node.getAttribute("style") ?? "").match(/background-image\s*:\s*url\(\s*["']?([^"')]+)/i);
      if (m) add(m[1]);
    }
  }
  return out;
}

/** Hex colours used in a chunk of SVG markup, most-used first. */
function svgColours(svg: string): string[] {
  const tally = new Map<string, number>();
  for (const m of svg.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    // Black and white are the ink a mark is drawn in, not the brand's colour.
    if (hex === "000000" || hex === "ffffff") continue;
    tally.set("#" + hex, (tally.get("#" + hex) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).slice(0, 4);
}

/** The logo, hunted where a logo is actually put. */
function findLogo(doc: ReturnType<DOMParser["parseFromString"]>): LedgerLogo | undefined {
  const homes = [
    "header .logo", "header [class*='logo']", ".logo", "[class*='logo']",
    "header a[href='/']", "a[href='/']", "header",
  ];
  for (const sel of homes) {
    const host = doc.querySelector(sel);
    if (!host) continue;

    const img = host.querySelector("img");
    const src = img?.getAttribute("src") ?? "";
    if (src && !src.startsWith("data:")) {
      const alt = (img?.getAttribute("alt") ?? "").trim();
      return alt ? { src, alt } : { src };
    }

    // An inline mark. Carried verbatim so the rebuilt header shows the real
    // logo rather than the site's name set in whatever font won the design.
    const svg = host.querySelector("svg");
    if (svg) {
      const markup = (svg as unknown as { outerHTML?: string }).outerHTML ?? "";
      if (markup) {
        const colours = svgColours(markup);
        return { svg: markup, ...(colours.length ? { colours } : {}) };
      }
    }
  }
  return undefined;
}

function hasHeadingChild(el: Element): boolean {
  return (Array.from(el.children) as Element[])
    .some((c) => /^H[1-4]$/.test(c.tagName));
}

/** Does this element look like a section in its own right? */
function looksLikeSection(el: Element): boolean {
  if (SECTION_TAGS.has(el.tagName)) return true;
  return !!el.querySelector("h1, h2, h3, h4");
}

/**
 * The blocks that are actually the page's sections.
 *
 * This used to be `body.children`, which assumes every site lays its sections
 * out as direct children of <body>. Almost none do: a wrapper div, or a <main>,
 * or both, sits in between. On a real site that assumption collapsed an entire
 * page into two or three "sections", each of which then kept only its heading,
 * one paragraph and one repeated group — so the rebuild came back as a handful
 * of boxes of text, and two whole areas of the site (a price list and a
 * branches page) vanished with the run's own log noting the nav links to them
 * had nowhere to point.
 *
 * So: descend through anything that is holding sections rather than being one,
 * and stop at the first thing that looks like content. A <section> or <article>
 * is never opened up — it has declared what it is.
 */
function sectionBlocks(root: Element, depth = 0): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(root.children) as Element[]) {
    if (CHROME_TAGS.has(child.tagName)) continue;
    if (isChrome(child)) continue; // footer / nav-only header

    // A declared section, or a block with a heading of its own, IS the content.
    if (SECTION_TAGS.has(child.tagName) || hasHeadingChild(child)) {
      out.push(child);
      continue;
    }

    // Otherwise it may be a wrapper. It is one if it holds several things that
    // look like sections, or if it is a lone box around the whole page.
    const inner = (Array.from(child.children) as Element[])
      .filter((c) => !CHROME_TAGS.has(c.tagName) && !isChrome(c));
    const sectionish = inner.filter(looksLikeSection);
    const isWrapper = depth < MAX_WRAPPER_DEPTH && WRAPPER_TAGS.has(child.tagName) &&
      (sectionish.length >= 2 || (inner.length === 1 && sectionish.length === 1));

    if (isWrapper) {
      const found = sectionBlocks(child, depth + 1);
      // Descending must never LOSE a block: if the wrapper turned out to hold
      // nothing we recognise, keep the wrapper itself rather than dropping it.
      if (found.length) out.push(...found);
      else out.push(child);
      continue;
    }
    out.push(child);
  }
  return out;
}

/**
 * Parse the original page into a complete content ledger.
 *
 * @param html   the raw original markup (scripts still inline — they are read
 *               here to learn which ids the page's behaviour depends on)
 */
export function buildLedger(html: string, externalJs = ""): Ledger {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("ledger: could not parse document");

  const root = doc.querySelector("html");
  const langAttr = (root?.getAttribute("lang") ?? "").trim();
  const dirAttr = (root?.getAttribute("dir") ?? "").trim().toLowerCase();

  const bodyText = doc.querySelector("body")?.textContent ?? "";
  const dir: "rtl" | "ltr" = dirAttr === "rtl" || dirAttr === "ltr"
    ? (dirAttr as "rtl" | "ltr")
    : (hasHebrew(bodyText) ? "rtl" : "ltr");

  const name = (doc.querySelector("title")?.textContent
    ?? getMeta(doc, "og:site_name")
    ?? getMeta(doc, "og:title")
    ?? "").trim();
  const language = langAttr || (dir === "rtl" ? "he" : "en");

  // Which ids does page behaviour depend on? Every getElementById / #id selector
  // inside a <script>, mapped back to the script that named it.
  //
  // externalJs carries the site's .js FILES. Reading only inline <script> was a
  // real hole: a page whose behaviour lives in script.js looked script-free, so
  // none of its containers were protected, and one shipped rebuild dropped #nav
  // and #formNote while still linking the script that dereferences them — a
  // TypeError on every scroll. External code has no inline script to carry, so
  // its ids map to EXTERNAL_SCRIPT: the container must survive, but there is no
  // script block to re-attach with it.
  const scripts = [...doc.querySelectorAll("script")].map((s) => s.textContent ?? "");
  const idToScript = new Map<string, number>();
  scripts.forEach((code, i) => {
    for (const id of referencedIds(code)) {
      if (!idToScript.has(id)) idToScript.set(id, i);
    }
  });
  for (const id of referencedIds(externalJs)) {
    if (!idToScript.has(id)) idToScript.set(id, EXTERNAL_SCRIPT);
  }

  const body = doc.querySelector("body");
  const blocks = body ? sectionBlocks(body) : [];

  const sections: LedgerSection[] = [];
  let n = 0;
  for (const block of blocks) {
    n++;
    sections.push(buildSection(block, n, idToScript, sections.length === 0));
  }

  // Components: every script-referenced id that actually resolves to an element.
  const components: LedgerComponent[] = [];
  for (const [id, scriptIndex] of idToScript) {
    if (doc.getElementById(id)) {
      components.push({ name: id, container_id: id, script_index: scriptIndex });
    }
  }

  // Found before the header is discarded as chrome — that is where it lives.
  const logo = findLogo(doc);

  const styleText = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");

  return {
    meta: { name, language, dir, ...(logo ? { logo } : {}) },
    dir,
    facts: extractFacts(doc),
    sections,
    components,
    styleText,
  };
}

/** Visible-text length of an HTML fragment — the unit the coverage guard counts. */
export function visibleTextLength(htmlFragment: string): number {
  const doc = new DOMParser().parseFromString(htmlFragment, "text/html");
  const text = doc?.querySelector("body")?.textContent ?? doc?.textContent ?? "";
  return normalizeText(text).length;
}

// ---------------------------------------------------------------- internals

function buildSection(
  block: Element,
  n: number,
  idToScript: Map<string, number>,
  isFirst: boolean,
): LedgerSection {
  const heading = firstText(block, "h1, h2, h3, h4");
  const id = slugId(block.getAttribute("id"), heading, n);
  const text = normalizeText(block.textContent ?? "");

  // Does this block contain (or is) an element some script targets?
  const componentId = componentIdWithin(block, idToScript);
  if (componentId) {
    // Carry only the smallest element that holds every script-referenced id in
    // this section — the widget container itself — so its heading and intro can
    // still be redesigned while the DOM the script drives is preserved intact.
    const container = widgetContainer(block, [...idToScript.keys()]);
    return {
      id,
      type: "interactive",
      heading,
      subheading: extractSubheading(block, heading),
      items: [],
      component_id: componentId,
      verbatim_html: stripScripts(container.outerHTML ?? block.innerHTML),
      text,
    };
  }

  const items = extractItems(block);
  const subheading = extractSubheading(block, heading);
  const body = items.length ? undefined : sectionBody(block, heading, subheading);
  const cta = extractCta(block);
  const images = imagesIn(block);

  const type = isFirst && block.querySelector("h1") ? "hero" : "content";

  return {
    id,
    type,
    heading,
    subheading,
    body,
    items,
    cta,
    text,
    ...(images.length ? { images } : {}),
  };
}

/**
 * The section's repeated content: find the largest group of sibling elements
 * that share a class/tag signature and appear more than once, then read each
 * member into {title, text, value}. This is what recovers all 8 player cards or
 * all 7 timeline rows rather than a single sample.
 */
function extractItems(block: Element): LedgerItem[] {
  const group = largestRepeatedGroup(block);
  if (!group) return [];

  return group.map((el) => {
    const title = firstText(el, "h1, h2, h3, h4, h5, .name, .title, dt, b, strong");
    const value = firstText(el, ".num, .value, .big, .stat-num, [class*='num']");
    const full = elementText(el);
    // Body text = everything in the item that is not its own title/value, so a
    // card's paragraph survives without repeating its heading.
    let text = full;
    for (const strip of [title, value]) {
      if (strip && text.startsWith(strip)) text = text.slice(strip.length);
      else if (strip) text = text.replace(strip, "");
    }
    // Cutting a title out of the middle leaves the spaces that surrounded it on
    // both sides, which is how "חדש  אגוז" reached a shipped card.
    text = normalizeText(text);
    const item: LedgerItem = {};
    if (title) item.title = title;
    if (value) item.value = value;
    if (text && text !== title && text !== value) item.text = text;
    // An item that yielded nothing but repeats the section heading is noise.
    if (!item.title && !item.text && !item.value) item.text = full || undefined;
    return item;
  }).filter((it) => it.title || it.text || it.value);
}

/**
 * The biggest set of same-signature siblings anywhere under the block. Elements
 * are bucketed by their first class (or tag name when unclassed); the largest
 * bucket with two or more members is the repeated group. Returns the actual
 * member elements in document order.
 */
function largestRepeatedGroup(root: Element): Element[] | null {
  const buckets = new Map<string, Element[]>();
  const walk = (el: Element) => {
    for (const child of Array.from(el.children) as Element[]) {
      if (CHROME_TAGS.has(child.tagName)) continue;
      // Only card-like elements count as repeated items. A run of bare <p> or
      // <li> that carries text but no class and no children is body copy, not a
      // card group — treating it as items would strip a paragraph section into
      // fragments.
      if (isCardLike(child)) {
        const sig = signature(child);
        const arr = buckets.get(sig) ?? [];
        arr.push(child);
        buckets.set(sig, arr);
      }
      walk(child);
    }
  };
  walk(root);

  let best: Element[] | null = null;
  for (const arr of buckets.values()) {
    if (arr.length > 1 && (!best || arr.length > best.length)) best = arr;
  }
  return best;
}

function signature(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  return (cls ? "." + cls : el.tagName) + "@" + el.tagName;
}

/** A repeated item is a container: it has a class or wraps child elements. */
function isCardLike(el: Element): boolean {
  return (el.getAttribute("class") ?? "").trim() !== "" || el.children.length > 0;
}

/** Prose for a section with no card group: its paragraphs, else residual text. */
function sectionBody(block: Element, heading: string, subheading?: string): string | undefined {
  const p = paragraphText(block);
  if (p) return p;
  let t = elementText(block);
  for (const strip of [heading, subheading]) {
    if (strip && t.startsWith(strip)) t = t.slice(strip.length).trim();
  }
  return t || undefined;
}

function componentIdWithin(block: Element, idToScript: Map<string, number>): string | undefined {
  for (const id of idToScript.keys()) {
    if (block.getAttribute("id") === id) return id;
    if (block.querySelector(`#${cssEscape(id)}`)) return id;
  }
  return undefined;
}

/** The smallest element inside `block` that contains every referenced id present. */
/**
 * The element carried over verbatim so a script keeps the DOM it drives.
 *
 * The smallest ancestor holding every script-referenced id is the right answer
 * for a self-contained widget like a quiz, whose ids span its whole body. It is
 * the wrong answer when the only referenced id is a leaf: a contact section
 * whose script touches nothing but `<p id="formNote">` — an empty status line —
 * would carry that paragraph and drop the address, the opening hours and the
 * form itself. Measured on a real run: the section's entire content vanished
 * and the delivery was blocked for three missing numbers.
 *
 * So the container has to earn its narrowness. The test is what would be LEFT
 * BEHIND: the block's text, minus the container's, minus the heading the
 * rebuild redesigns anyway. A quiz leaves nothing behind — its boxes are empty
 * until the script fills them — while the contact section leaves an address, a
 * phone number and opening hours. Anything more than a stray word and the
 * block wins.
 *
 * Carrying too much costs a section that keeps its original markup. Carrying
 * too little costs the content itself, so the tie goes to carrying too much.
 */
const MAX_ABANDONED_TEXT = 40;

function widgetContainer(block: Element, ids: string[]): Element {
  const els: Element[] = [];
  for (const id of ids) {
    const el = block.getAttribute("id") === id
      ? block
      : block.querySelector(`#${cssEscape(id)}`);
    if (el) els.push(el as Element);
  }
  if (els.length === 0) return block;
  let anc: Element | null = els[0];
  while (anc && !els.every((e) => containsEl(anc as Element, e))) {
    anc = anc.parentElement;
  }
  const chosen = anc ?? block;
  if (chosen === block) return block;

  const heading = block.querySelector("h1,h2,h3,h4,h5,h6");
  const abandoned = normalizeText(block.textContent ?? "").length -
    normalizeText(chosen.textContent ?? "").length -
    normalizeText(heading?.textContent ?? "").length;
  return abandoned > MAX_ABANDONED_TEXT ? block : chosen;
}

function containsEl(anc: Element, node: Element): boolean {
  let n: Element | null = node;
  while (n) {
    if (n === anc) return true;
    n = n.parentElement;
  }
  return false;
}

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/**
 * Re-scope a stylesheet under `prefix` (e.g. "#w-quiz") so every rule only
 * applies inside that wrapper. Used to give a verbatim-carried widget its
 * original look without any rule reaching the redesigned page. Selectors that
 * target the document root (:root, html, body) are rewritten to the wrapper so
 * custom properties and base styles still resolve for the widget's subtree.
 * @media / @supports blocks are recursed into; @keyframes / @font-face are left
 * global. Rules the widget never uses are harmless dead selectors.
 */
export function scopeCss(css: string, prefix: string): string {
  const out: string[] = [];
  for (const block of parseBlocks(stripCssComments(css))) {
    const p = block.prelude.trim();
    if (!p) continue;
    if (/^@(keyframes|font-face|import|charset|namespace)/i.test(p)) {
      out.push(block.hasBody ? `${p}{${block.body}}` : `${p};`);
    } else if (/^@(media|supports|container|layer)/i.test(p)) {
      out.push(`${p}{${scopeCss(block.body, prefix)}}`);
    } else if (block.hasBody) {
      out.push(`${scopeSelector(p, prefix)}{${block.body}}`);
    }
  }
  return out.join("\n");
}

function scopeSelector(selectorList: string, prefix: string): string {
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      /^(:root|html|body)\b/i.test(s)
        ? s.replace(/^(:root|html|body)/i, prefix)
        : `${prefix} ${s}`
    )
    .join(", ");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split CSS into top-level blocks, brace-depth aware (handles nested @media). */
function parseBlocks(css: string): Array<{ prelude: string; body: string; hasBody: boolean }> {
  const blocks: Array<{ prelude: string; body: string; hasBody: boolean }> = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = -1;
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) {
        prelude = css.slice(preludeStart, i);
        bodyStart = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        blocks.push({ prelude, body: css.slice(bodyStart, i), hasBody: true });
        preludeStart = i + 1;
      }
    }
  }
  return blocks;
}

function extractSubheading(block: Element, heading: string): string | undefined {
  // A short lead paragraph directly under the heading (e.g. .section-sub).
  const sub = block.querySelector(".section-sub, .subtitle, .lead, .sub");
  if (sub) {
    const t = normalizeText(sub.textContent ?? "");
    if (t && t !== heading) return t;
  }
  return undefined;
}

function paragraphText(block: Element): string | undefined {
  const parts = (Array.from(block.querySelectorAll("p")) as Element[])
    .map((p) => elementText(p))
    .filter(Boolean);
  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function extractCta(block: Element): { label?: string; href?: string } | undefined {
  const a = block.querySelector("a.btn, a.button, a.cta, .cta a, a[class*='btn']");
  if (!a) return undefined;
  const label = normalizeText(a.textContent ?? "");
  const href = a.getAttribute("href") ?? undefined;
  if (!label && !href) return undefined;
  return { label: label || undefined, href };
}

/**
 * The facts the rebuilt page must carry over.
 *
 * The footer is rebuilt rather than kept, because its markup is part of the old
 * design. Its CONTENT is not: a business footer holds the company number, the
 * physical address, opening hours and the links to the terms, cancellation and
 * privacy pages. Israeli law requires several of those, and three of the 110
 * signals check for them.
 *
 * Taking only tel: and mailto: — which is what this did — meant a site that was
 * already compliant came back less compliant than it went in, and then scored
 * for the loss. Measured on a real print shop: the address, the founding year
 * and both legal links were dropped, and only the phone and email survived.
 *
 * Facts are extracted, never composed. Every string here is copied out of the
 * page; nothing is inferred, formatted or filled in.
 */
function extractFacts(doc: ReturnType<DOMParser["parseFromString"]>): string[] {
  const facts = new Set<string>();
  if (!doc) return [];

  for (const a of Array.from(doc.querySelectorAll("a[href^='tel:'], a[href^='mailto:']")) as Element[]) {
    const href = a.getAttribute("href") ?? "";
    const val = href.replace(/^(tel:|mailto:)/, "").trim();
    if (val) facts.add(val);
  }

  // Legal and contact pages, with the href the site already uses. Rebuilding
  // the footer must not invent a URL, and must not drop one either.
  for (const a of Array.from(doc.querySelectorAll("footer a")) as Element[]) {
    const href = (a.getAttribute("href") ?? "").trim();
    const label = normalizeText(a.textContent ?? "");
    if (!href || !label) continue;
    if (/^(tel:|mailto:|#)/.test(href)) continue;
    facts.add(`${label} -> ${href}`);
  }

  // Address, company number, hours, year of establishment, and the names of the
  // legal pages. Lines are split on the markup's own breaks first: a footer
  // address is written with <br> between the street and the city, and reading
  // textContent alone glues them into "אזור תעשייהראשון לציון03-765-4321".
  for (const el of Array.from(doc.querySelectorAll("footer")) as Element[]) {
    const lines = (el.innerHTML ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|span|td|tr|address)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split(/[\n\r]|·|\|/);
    for (const raw of lines) {
      const line = normalizeText(raw);
      // Every line, not only the ones that look important. Filtering by "has a
      // digit" split "הדפוס 12, אזור תעשייה" from "ראשון לציון" and kept only
      // half an address; deciding which of a business's own footer lines matter
      // is exactly the judgement that loses facts. A footer is small, and a
      // redundant line costs nothing.
      if (line.length < 2 || line.length > 160) continue;
      facts.add(line);
    }
  }

  return [...facts];
}

function isChrome(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "FOOTER") return true;
  // A <header> or <nav> with no heading and links is site chrome, not content.
  if (tag === "HEADER" || tag === "NAV") {
    const hasHeading = !!el.querySelector("h1, h2, h3");
    const hasLinks = (el.querySelectorAll("a").length ?? 0) > 0;
    if (!hasHeading && hasLinks) return true;
  }
  return false;
}

function referencedIds(code: string): string[] {
  const ids = new Set<string>();
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z_][\w-]*)['"]\s*\)/g)) ids.add(m[1]);
  return [...ids];
}

function firstText(scope: Element, selector: string): string {
  const el = scope.querySelector(selector);
  return el ? elementText(el as Element) : "";
}

function getMeta(doc: ReturnType<DOMParser["parseFromString"]>, prop: string): string | null {
  const el = doc?.querySelector(`meta[property='${prop}'], meta[name='${prop}']`);
  return el?.getAttribute("content") ?? null;
}

function slugId(rawId: string | null, heading: string, n: number): string {
  if (rawId && rawId.trim()) return rawId.trim();
  const slug = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `section-${n}`;
}

// Emoji are never content — they are one of the AI fingerprints the product
// removes — so every text field the ledger extracts is stripped of them. The
// rebuilt page is emoji-free too, so the coverage check compares like with like.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu;

function normalizeText(s: string): string {
  return s.replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

// Elements that end one piece of content and begin another. A link is on the
// list: a price and the "read more" beside it are two things, not one word.
// Inline formatting is NOT — a decorative <span> inside a heading is part of
// the same run of text, and separating it would put a space before a full stop.
const TEXT_BOUNDARY =
  /<\s*\/?\s*(?:a|p|div|section|article|header|footer|aside|nav|main|li|ul|ol|dl|dt|dd|table|tr|td|th|h[1-6]|address|blockquote|figure|figcaption|form|label|button|br)\b[^>]*>/gi;

/**
 * An element's text with its internal boundaries preserved.
 *
 * textContent concatenates across elements, which is faithful to the bytes and
 * wrong for an inventory: the real page holds
 * `<span class="price">₪ 24,900</span><a>לפרטים ←</a>` with no whitespace
 * between them — the browser keeps them apart with CSS — and reading
 * textContent produced "₪ 24,900לפרטים ←", which then shipped into a rebuilt
 * card exactly like that. The footer had the same fault, with the street and
 * the city glued into "אזור תעשייהראשון לציון"; it was patched there and left
 * everywhere else. This is the general fix.
 */
function elementText(el: Element): string {
  const html = el.innerHTML ?? "";
  if (!html) return normalizeText(el.textContent ?? "");
  return normalizeText(html.replace(TEXT_BOUNDARY, " ").replace(/<[^>]+>/g, ""));
}

function hasHebrew(s: string): boolean {
  return /[֐-׿]/.test(s);
}

// CSS.escape is not available in the WASM runtime; ids here are simple slugs, so
// escape only the characters a bare id selector cannot carry.
function cssEscape(id: string): string {
  return id.replace(/([^\w-])/g, "\\$1");
}
