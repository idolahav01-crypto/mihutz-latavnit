// Deterministic assembly helpers for the rebuild.
//
// The model designs sections; these functions provide the guarantees around it
// that a prompt cannot: a widget section rendered so its carried-over script
// always has its DOM and its original look, a content section that can always
// be rendered in full from the ledger when a model call comes back short, a
// coverage measure that decides when that floor is needed, and anchor/skip-link
// clean-up so the finished page never links to a section that does not exist.

import { scopeCss, visibleTextLength } from "./ledger.ts";
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

  const items = section.items ?? [];
  let inner = "";
  if (items.length) {
    inner = `<div class="rb-grid">` +
      items.map((it) =>
        `<article class="rb-card">` +
        (it.value ? `<div class="rb-value">${escapeHtml(it.value)}</div>` : "") +
        (it.title ? `<h3>${escapeHtml(it.title)}</h3>` : "") +
        (it.text ? `<p>${escapeHtml(it.text)}</p>` : "") +
        `</article>`
      ).join("") +
      `</div>`;
  } else if (section.body) {
    inner = section.body.split(/\n\n+/).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }

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
 * Point every in-page anchor at a section that actually exists. An unknown
 * "#target" is remapped to the section whose heading best matches the link
 * text, and to "#main" when nothing matches — so a nav link is never dead.
 */
export function fixAnchors(
  html: string,
  sections: Array<{ id: string; heading?: string }>,
): string {
  const ids = new Set(sections.map((s) => s.id));
  return html.replace(
    /(<a\b[^>]*\bhref=")#([^"]*)("[^>]*>)([\s\S]*?)(<\/a>)/gi,
    (whole, pre, target, post, text, close) => {
      if (target === "" || target === "main" || ids.has(target)) return whole;
      const wanted = stripTags(text).trim();
      const match = sections.find((s) =>
        s.heading && wanted && (s.heading.includes(wanted) || wanted.includes(s.heading))
      );
      return `${pre}#${match ? match.id : "main"}${post}${text}${close}`;
    },
  );
}

/** Ensure a built section's outer element carries the id the ledger assigned. */
export function ensureSectionId(html: string, id: string): string {
  const openTag = html.match(/<section\b[^>]*>/i);
  if (!openTag) return html;
  if (/\bid=/.test(openTag[0])) return html; // model already set one; leave it
  return html.replace(/<section\b/i, `<section id="${escapeHtml(id)}"`);
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
