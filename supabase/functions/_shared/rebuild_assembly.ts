// Deterministic assembly helpers for the rebuild.
//
// The model designs sections; these functions provide the guarantees around it
// that a prompt cannot: a widget section rendered so its carried-over script
// always has its DOM and its original look, a content section that can always
// be rendered in full from the ledger when a model call comes back short, a
// coverage measure that decides when that floor is needed, and anchor/skip-link
// clean-up so the finished page never links to a section that does not exist.

import { scopeCss, visibleTextLength } from "./ledger.ts";
import { factTokens, visibleText } from "./preservation.ts";
import type { LedgerItem } from "./ledger.ts";

/**
 * The fields these helpers read. A structural subset of both the ledger's
 * section and the rebuild's Section, so either can be passed without casting.
 */
export interface RenderableSection {
  id: string;
  heading?: string;
  subheading?: string;
  body?: string;
  items?: LedgerItem[];
  cta?: { label?: string; href?: string };
  component_id?: string;
  verbatim_html?: string;
  text?: string;
}

export interface RenderedSection {
  html: string;
  css: string;
}

/**
 * A section that hosts an interactive widget. Its heading is redesigned with the
 * shell's token classes, but the widget container is carried verbatim and its
 * original styles are scoped under a private wrapper — so the script's DOM and
 * appearance survive without a single rule touching the redesigned page.
 */
/**
 * Whether this section takes the deterministic widget path — carried verbatim,
 * no model call, no cost. The build and the build PLAN must agree on this or
 * the recorded N is not the N that was paid for, so both ask here rather than
 * repeating the condition.
 */
export function isWidgetSection(section: RenderableSection): boolean {
  return !!(section.component_id && section.verbatim_html);
}

export function renderWidgetSection(
  section: RenderableSection,
  styleText: string,
  wrapId: string,
): RenderedSection {
  const head = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : "";
  const sub = section.subheading
    ? `\n      <p class="section-sub">${escapeHtml(section.subheading)}</p>`
    : "";
  const html = `<section id="${escapeHtml(section.id)}" class="section section--surface">
    <div class="container">
      ${head}${sub}
      <div id="${escapeHtml(wrapId)}" class="widget-embed">${section.verbatim_html ?? ""}</div>
    </div>
  </section>`;
  const css = `#${wrapId}{margin-block-start:var(--sp-4,1.5rem)}\n` + scopeCss(styleText, `#${wrapId}`);
  return { html, css };
}

/**
 * A content section rendered entirely from the ledger — no model. This is the
 * completeness floor: when a model build drops content, this renders every item
 * the ledger holds in a plain, token-styled layout. Not as expressive as a
 * bespoke build, but it can never lose a card or a paragraph.
 */
export function renderContentSection(section: RenderableSection): RenderedSection {
  const head = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : "";
  const sub = section.subheading
    ? `<p class="section-sub">${escapeHtml(section.subheading)}</p>`
    : "";

  // Body AND items, never one or the other. A section that has both — copy
  // introducing a set of cards — used to ship with the copy silently dropped,
  // which is the one thing a completeness floor must not do.
  const items = section.items ?? [];
  const bodyHtml = section.body
    ? section.body.split(/\n\n+/).map((p) => `<p>${escapeHtml(p)}</p>`).join("")
    : "";
  const itemsHtml = items.length
    ? `<div class="rb-grid">` +
      items.map((it) =>
        `<article class="rb-card">` +
        (it.value ? `<div class="rb-value">${escapeHtml(it.value)}</div>` : "") +
        (it.title ? `<h3>${escapeHtml(it.title)}</h3>` : "") +
        (it.text ? `<p>${escapeHtml(it.text)}</p>` : "") +
        `</article>`
      ).join("") +
      `</div>`
    : "";
  const inner = bodyHtml + itemsHtml;

  const cta = section.cta?.label
    ? `<p><a class="btn btn-primary" href="${escapeHtml(section.cta.href ?? "#")}">${escapeHtml(section.cta.label)}</a></p>`
    : "";

  const html = `<section id="${escapeHtml(section.id)}" class="section">` +
    `<div class="container">${head}${sub}${inner}${cta}</div></section>`;
  return { html, css: FALLBACK_CSS };
}

/** Token-styled grid/card CSS for the completeness-floor renderer. */
export const FALLBACK_CSS =
  `.rb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));` +
  `gap:var(--sp-4,1.4rem);margin-block-start:var(--sp-4,1.4rem)}` +
  `.rb-card{background:var(--paper,#fff);border:1px solid var(--line,#e4e0d8);` +
  `border-radius:var(--r-lg,16px);padding:var(--sp-4,1.4rem)}` +
  `.rb-value{font-weight:900;font-size:2.2rem;color:var(--primary,#111);line-height:1}` +
  `.rb-card h3{margin:.3rem 0}`;

/**
 * How much of a section's original visible text a built fragment retained. 1.0
 * means everything (or more); a low value means the model dropped content and
 * the floor renderer should take over. Text is the unit because it survives any
 * markup the model chose.
 */
export function sectionCoverage(builtHtml: string, section: RenderableSection): number {
  const target = (section.text ?? "").length;
  if (target === 0) return 1;
  return visibleTextLength(builtHtml) / target;
}

/**
 * Numbers from this section the build did not carry over.
 *
 * Length coverage alone is not enough. A contact section can be rewritten to
 * the same size and still lose the two things that mattered in it: on a real
 * run the builder kept the prose, met the 0.85 length floor, and dropped the
 * street number and the opening hours — "רחוב הנגרים 12" and "10:00–19:00" —
 * which is precisely the content a visitor needs and Israeli law expects.
 *
 * Numbers are the cheapest facts to verify and the most expensive to lose, so
 * they get their own gate: any that go missing send the section to the floor
 * renderer, which emits every ledger item verbatim.
 */
export function missingSectionFacts(builtHtml: string, section: RenderableSection): string[] {
  const wanted = factTokens(section.text ?? "");
  if (!wanted.size) return [];
  const got = factTokens(visibleText(builtHtml));
  return [...wanted].filter((f) => !got.has(f)).sort();
}

/**
 * Remove skip-link anchors from a fragment. assemble() emits exactly one at the
 * top of the page; any the shell model also produced would be a duplicate.
 */
export function stripSkipLinks(html: string): string {
  return html.replace(
    /<a\b[^>]*class="[^"]*\bskip-link\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
    "",
  );
}

/**
 * The ids a document actually offers as anchor targets.
 *
 * The valid set has to come from the shipped markup, not from the plan. A real
 * run planned a section as "בקצרה-מהאלמנך" and the builder returned it as
 * <section id="section-2">; the plan still listed the planned id, so a nav link
 * to it would have passed every check and landed nowhere.
 */
export function collectIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const id = (m[1] ?? m[2] ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** The id on a built fragment's outermost element, if it carries one. */
export function rootId(html: string): string | null {
  const open = html.trimStart().match(/^<([a-z][\w-]*)\b([^>]*)>/i);
  if (!open) return null;
  const id = open[2].match(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  return id ? (id[1] ?? id[2] ?? "").trim() || null : null;
}

// Hebrew nav labels are almost never the section heading verbatim: the heading
// is "אצטדיון האמירויות" and the link says "האצטדיון", the definite article
// making a plain substring test fail. Comparison therefore happens on words,
// with a leading ה stripped — but only when a real word is left, so "הודעות"
// does not quietly become "ודעות".
function normalizeLabel(s: string): string {
  return s
    .replace(/[\u0591-\u05C7]/g, "") // niqqud
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function labelWords(s: string): string[] {
  return normalizeLabel(s)
    .split(" ")
    .filter((w) => w.length >= 3)
    .map((w) => (/^ה\p{L}{3,}$/u.test(w) ? w.slice(1) : w));
}

/**
 * How well a link's text names a section. 3 = the same phrase, 2 = one contains
 * the other, 1 = they share a significant word, 0 = unrelated. Anything above
 * zero beats the #main fallback, which is a link that scrolls nowhere.
 */
function anchorScore(wanted: string, heading: string): number {
  const a = normalizeLabel(wanted);
  const b = normalizeLabel(heading);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const wb = new Set(labelWords(heading));
  return labelWords(wanted).some((w) => wb.has(w)) ? 1 : 0;
}

/**
 * Words that occur in exactly one section, mapped to it.
 *
 * The last resort before giving up on a link. A nav label often shares no word
 * with the heading it means — "חידון" over a section headed "טריוויית
 * התותחנים" — but the word it uses almost always appears somewhere inside that
 * one section and nowhere else. Uniqueness is the whole safeguard: a word two
 * sections both use says nothing about which one the link wants, so it is not
 * in this index at all.
 */
function uniqueWordIndex(
  sections: Array<{ id: string; heading?: string; text?: string }>,
): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const s of sections) {
    for (const w of labelWords(`${s.heading ?? ""} ${s.text ?? ""}`)) {
      const owners = seen.get(w) ?? new Set<string>();
      owners.add(s.id);
      seen.set(w, owners);
    }
  }
  const unique = new Map<string, string>();
  for (const [w, owners] of seen) if (owners.size === 1) unique.set(w, [...owners][0]);
  return unique;
}

/**
 * Point every in-page anchor at a section that actually exists.
 *
 * `existingIds` is the set of ids in the shipped markup; when it is omitted the
 * targets' own ids stand in. An unknown "#target" is resolved against the
 * section this link most plausibly names — by its text, then by the slug the
 * shell tried to link to, then by a word only one section uses — and falls back
 * to "#main" only when nothing matches at all.
 *
 * Every fallback is reported. A link to #main is not a broken link, but it is
 * not the section the visitor asked for either, and a run that quietly pointed
 * three of five nav items at the top of the page looked perfect in a screenshot
 * and did nothing when clicked.
 */
export function fixAnchors(
  html: string,
  sections: Array<{ id: string; heading?: string; text?: string }>,
  existingIds?: Iterable<string>,
): { html: string; fallbacks: string[] } {
  const ids = new Set(existingIds ?? sections.map((s) => s.id));
  const live = sections.filter((s) => ids.has(s.id));
  const unique = uniqueWordIndex(live);
  const fallbacks: string[] = [];
  const out = html.replace(
    // Both quote styles: a link the regex cannot see is a link nothing checks.
    /(<a\b[^>]*\bhref=)(["'])#([^"']*)\2([^>]*>)([\s\S]*?)(<\/a>)/gi,
    (whole, pre, q, target, post, text, close) => {
      // href="#" is not a target, it is a placeholder the model left behind. It
      // scrolls to the top of the document, which under a nav label like "הסגל"
      // is indistinguishable from a broken link, so it goes through the matcher
      // like any unknown target and only stays "#" if nothing fits.
      if (target === "main" || ids.has(target) || ids.has(decodeTarget(target))) return whole;

      const wanted = stripTags(text).trim();
      const slug = decodeTarget(target).replace(/[-_]+/g, " ");
      let best: { id: string; score: number } | null = null;
      for (const s of live) {
        if (!s.heading) continue;
        const score = Math.max(anchorScore(wanted, s.heading), anchorScore(slug, s.heading));
        if (score > 0 && (!best || score > best.score)) best = { id: s.id, score };
      }
      if (!best) {
        for (const w of [...labelWords(wanted), ...labelWords(slug)]) {
          const owner = unique.get(w);
          if (owner) {
            best = { id: owner, score: 1 };
            break;
          }
        }
      }
      if (best) return `${pre}${q}#${best.id}${q}${post}${text}${close}`;
      fallbacks.push(wanted || `#${target}`);
      return `${pre}${q}#${target === "" ? "" : "main"}${q}${post}${text}${close}`;
    },
  );
  return { html: out, fallbacks };
}

function decodeTarget(t: string): string {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

export interface NavItem {
  section_id: string;
  label: string;
}

/** Where the shell is told to leave room for the nav we generate. */
export const NAV_SLOT = "{{NAV}}";

/**
 * Put the nav into the header without ever letting the model write an href.
 *
 * Repairing a broken link after the fact can only ever be a guess. The links
 * themselves are not a design decision — they are the section list, which is
 * known before the shell is asked for anything — so the model picks WHICH
 * sections and what to call them, from an enum of ids that exist, and the
 * markup is generated here. A link to a section that is not on the page stops
 * being something to detect and becomes something that cannot be written.
 *
 * Two ways in, in order of trust:
 *   1. The header carries the NAV_SLOT token: the generated links replace it.
 *   2. It does not, and wrote its own links: each one whose text matches a
 *      planned label is repointed at that label's id. Exact text, no guessing.
 *
 * Whatever neither path resolves is left to fixAnchors, which is the floor
 * rather than the mechanism.
 */
export function applyNavPlan(
  headerHtml: string,
  nav: NavItem[] | undefined,
  existingIds: Set<string>,
): { html: string; dropped: string[]; slotUsed: boolean } {
  const dropped: string[] = [];
  const planned: NavItem[] = [];
  const seen = new Set<string>();
  for (const item of nav ?? []) {
    const id = (item?.section_id ?? "").trim();
    const label = (item?.label ?? "").trim();
    if (!id || !label || !existingIds.has(id) || seen.has(id)) {
      if (id || label) dropped.push(label || id);
      continue;
    }
    seen.add(id);
    planned.push({ section_id: id, label });
  }

  if (headerHtml.includes(NAV_SLOT)) {
    const links = planned
      .map((i) => `<a class="nav-link" href="#${escapeHtml(i.section_id)}">${escapeHtml(i.label)}</a>`)
      .join("");
    return { html: headerHtml.split(NAV_SLOT).join(links), dropped, slotUsed: true };
  }

  // No slot: the model wrote the nav itself. Its labels came from the same plan,
  // so matching them by text is exact rather than approximate.
  const byLabel = new Map(planned.map((i) => [normalizeLabel(i.label), i.section_id]));
  const html = headerHtml.replace(
    /(<a\b[^>]*\bhref=)(["'])#([^"']*)\2([^>]*>)([\s\S]*?)(<\/a>)/gi,
    (whole, pre, q, target, post, text, close) => {
      const id = byLabel.get(normalizeLabel(stripTags(text)));
      if (!id || id === target) return whole;
      return `${pre}${q}#${id}${q}${post}${text}${close}`;
    },
  );
  return { html, dropped, slotUsed: false };
}

/**
 * Point a page's in-page anchors at the page that actually holds those sections.
 *
 * The rebuilt header is carried onto every other page of the site, and its nav
 * links are anchors into the ONE page that was rebuilt. Left as "#הישגים" they
 * are dead everywhere except that page — the same broken nav as before, just
 * moved to the files nobody looked at. Here they become "index.html#הישגים":
 * the visitor lands on the section, one page over.
 *
 * "#" alone is left alone: it means the top of the page you are on, and it
 * means that on every page.
 */
export function retargetAnchors(html: string, pageHref: string): string {
  if (!pageHref) return html;
  return html.replace(
    /(<a\b[^>]*\bhref=)(["'])#([^"']+)\2/gi,
    (whole, pre, q, target) => `${pre}${q}${pageHref}#${target}${q}`,
  );
}

/**
 * Drop a control the finished page cannot honour.
 *
 * The shell model is asked for markup only — every script on the page is the
 * ORIGINAL site's, carried over byte for byte — so a control it invents has no
 * handler and never will. One run shipped a "ניגודיות" button in the header
 * that did nothing at all when clicked, next to nav links that worked. A button
 * A button is kept whenever anything could plausibly drive it: an inline
 * handler, a form submit, a script that queries buttons by tag, or a script
 * naming its id, one of its classes, a data-attribute, or its aria-controls
 * target. Only what nothing at all can reach is removed.
 */
export function stripDeadControls(
  html: string,
  scriptText: string,
): { html: string; removed: string[] } {
  const removed: string[] = [];
  // A script that reaches for buttons by tag rather than by hook could own any
  // of them, so none may be removed. Only a real query counts: an original
  // script doing document.createElement("button") mentions the word too, and
  // treating that as ownership keeps every dead control on the page.
  const genericSelector =
    /(?:querySelector(?:All)?|closest|matches)\s*\([^)]*\bbutton\b/i.test(scriptText) ||
    /getElementsByTagName\s*\(\s*["'`]button/i.test(scriptText) ||
    // Delegation: a listener on a container that decides by element type.
    /(?:tagName|nodeName)\s*[!=]==?\s*["'`]button/i.test(scriptText) ||
    /instanceof\s+HTMLButtonElement/.test(scriptText);
  const out = html.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (whole, attrs, inner) => {
    if (genericSelector) return whole;
    if (/\son[a-z]+\s*=/i.test(attrs)) return whole;
    if (/\btype\s*=\s*["']?submit/i.test(attrs)) return whole;
    // A bare <button> inside a form is a submit button by default.
    if (!/\btype\s*=/i.test(attrs) && /<form\b/i.test(html)) return whole;
    const hooks: string[] = [];
    const id = attrs.match(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (id) hooks.push(id[1] ?? id[2]);
    const controls = attrs.match(/\baria-controls\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (controls) hooks.push(controls[1] ?? controls[2]);
    const cls = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (cls) hooks.push(...(cls[1] ?? cls[2] ?? "").split(/\s+/));
    for (const m of attrs.matchAll(/\b(data-[\w-]+)/g)) hooks.push(m[1]);
    if (hooks.some((h) => referencedInScript(h, scriptText))) return whole;
    const label = attrs.match(/\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    removed.push(
      stripTags(inner).trim() || (label ? (label[1] ?? label[2]) : "") ||
        (id ? `#${id[1] ?? id[2]}` : "button"),
    );
    return "";
  });
  return { html: out, removed };
}

/**
 * Does a script name this hook as a whole token?
 *
 * A substring test is not good enough: a header button classed "btn" would be
 * kept alive by any script that happens to contain ".ans-btn", which is how a
 * dead control survives a check that looks like it ran.
 */
function referencedInScript(hook: string, scriptText: string): boolean {
  if (!hook || hook.length < 2) return false;
  return new RegExp(`(^|[^\\w-])${escapeRegExp(hook)}($|[^\\w-])`).test(scriptText);
}

/**
 * Make a built section answer to the id the ledger assigned it.
 *
 * The builder is free to invent one, and it does: a run planned a section as
 * "בקצרה-מהאלמנך" and got back <section id="section-2">. Leaving that alone
 * loses the only id anything else links to, so the ledger's id wins and the
 * displaced one is renamed everywhere the section's own CSS referred to it —
 * the id is overwritten, not the styling that hung off it.
 *
 * A fragment whose root is a <div> or <article> rather than a <section> gets
 * the id all the same; an anchor target does not care about the tag name.
 */
export function applySectionId(
  html: string,
  css: string,
  id: string,
): { html: string; css: string } {
  const lead = html.match(/^\s*/)?.[0] ?? "";
  const open = html.slice(lead.length).match(/^<([a-z][\w-]*)\b([^>]*)>/i);
  if (!open) return { html, css };

  const attrs = open[2];
  const existing = attrs.match(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  const current = existing ? (existing[1] ?? existing[2] ?? "").trim() : "";
  if (current === id) return { html, css };

  const newAttrs = existing
    ? attrs.replace(/\bid\s*=\s*(?:"[^"]*"|'[^']*')/, `id="${escapeHtml(id)}"`)
    : ` id="${escapeHtml(id)}"${attrs}`;
  const rebuilt = lead + `<${open[1]}${newAttrs}>` + html.slice(lead.length + open[0].length);
  return { html: rebuilt, css: current ? renameCssId(css, current, id) : css };
}

/** Repoint `#old` selectors at the id the section ended up with. */
function renameCssId(css: string, from: string, to: string): string {
  if (!css || !from) return css;
  return css.replace(
    new RegExp(`#${escapeRegExp(from)}(?![\w-])`, "g"),
    `#${to}`,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A CSS-ident-safe wrapper id for a widget: ascii only, so the scoped selector
// is valid regardless of a Hebrew section slug.
export function widgetWrapId(index: number): string {
  return `rb-widget-${index}`;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
