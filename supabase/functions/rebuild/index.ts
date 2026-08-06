// Stage R — RebuildDesigner: understand the site, then build it again from
// scratch in OUR canonical format (so the output is uniform, always renders,
// and carries zero AI fingerprints — regardless of how the original was built).
//
// This replaces the "analyse-and-patch foreign markup" approach (transform), whose
// coverage varied wildly by site type. Here we never edit the original markup:
//   part 1              — CONTENT SPEC: extract a precise structured content model
//                         (meta, real facts, ordered sections, interactive
//                         components) + a design_direction. Store spec.json.
//                         The original <script> blocks are carried byte-for-byte.
//   part 2              — SHELL: from the design_direction, build the global
//                         design-token CSS, font links, and header/footer markup.
//   parts 3..(2+S)      — SECTION: build ONE section's markup + CSS from its spec
//                         entry, using only the facts in that entry.
//   last part           — deterministically ASSEMBLE a complete, self-contained
//                         HTML document (tokens + sections + carried scripts) and
//                         write it to edited-bundle.txt (the pipeline deliverable).
//
// Facts are a CONTRACT: builders may only use content present in the spec. This
// is what stops "rebuild from scratch" from inventing or dropping real content.
//
// Body: { scan_id, part? } — response returns { parts, done, ... }.

import {
  type DetectedSignal,
  parseBundle,
  presentSignals,
  serializeBundle,
} from "../_shared/pipeline.ts";
import { callClaude, cleanApiKey } from "../_shared/anthropic.ts";
import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { buildEntry, recordStageUsage } from "../_shared/usage.ts";

const MODEL = "claude-opus-4-8";

// ---- storage layout ----
const paths = (uid: string, sid: string) => ({
  bundle: `${uid}/${sid}/bundle.txt`,
  edited: `${uid}/${sid}/edited-bundle.txt`,
  spec: `${uid}/${sid}/spec.json`,
  shell: `${uid}/${sid}/shell.json`,
  sections: `${uid}/${sid}/rebuild-sections.json`,
});

// ---- shared helpers ----
function extractScripts(html: string): { stripped: string; scripts: string[] } {
  const scripts: string[] = [];
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    const token = `<!--__MIHUTZ_SCRIPT_${scripts.length}__-->`;
    scripts.push(m);
    return token;
  });
  return { stripped, scripts };
}

async function readJson<T>(admin: ReturnType<typeof adminClient>, path: string): Promise<T | null> {
  const { data } = await admin.storage.from("scans").download(path);
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(admin: ReturnType<typeof adminClient>, path: string, value: unknown) {
  const up = await admin.storage.from("scans").upload(
    path,
    new Blob([JSON.stringify(value)], { type: "application/json" }),
    { upsert: true, contentType: "application/json" },
  );
  if (up.error) throw new Error(`storage: ${up.error.message}`);
}

// ---- spec / shell / section shapes ----
interface Section {
  id: string;
  type: string;
  heading?: string;
  subheading?: string;
  body?: string;
  items?: Array<{ title?: string; text?: string; value?: string }>;
  cta?: { label?: string; href?: string };
  image?: string;
  component_id?: string; // an interactive container this section must contain
  note?: string;
}
interface Spec {
  meta: { name: string; purpose: string; language: string; audience: string; tone: string };
  dir: "rtl" | "ltr";
  facts: string[];
  sections: Section[];
  components: Array<{ name: string; purpose: string; container_id: string; script_index?: number }>;
}
interface Direction {
  brand_palette: Array<{ token: string; hex: string; role: string }>;
  typography: { heading: string; body: string };
  layout_principle: string;
  personality: string[];
  rationale: string;
}
interface Shell {
  head_extras: string;
  tokens_css: string;
  header_html: string;
  footer_html: string;
}
interface BuiltSection {
  index: number;
  html: string;
  css: string;
}

// ================= PROMPTS =================
const SPEC_SYSTEM =
  `You are a content architect. You are given the source files of ONE website (its <script> blocks shown as <!--__MIHUTZ_SCRIPT_N__--> placeholders). Produce a PRECISE structured content model of what this site actually is and contains. You are NOT designing anything and NOT writing markup — you are inventorying real content so the site can be rebuilt from scratch.

Rules:
- Extract ONLY content that is genuinely present in the source. NEVER invent, embellish, or add facts, sections, stats, testimonials, or features that are not there.
- Capture every REAL, concrete fact into "facts": names, numbers, prices, dates, contact details, addresses, guarantees, brand claims. These are the ground truth the rebuild is allowed to use.
- List the page's real sections IN ORDER. For each: a stable id (slug), a type (hero, about, services, features, testimonials, faq, pricing, gallery, contact, cta, stats, team, etc.), its heading/subheading, its body copy, its items (cards/list rows with title/text/value), and its primary cta {label, href} if any. You MAY improve wording and tone, but never change facts.
- Identify interactive components (quiz, form, calculator, countdown, carousel, map). For each: name, purpose, the container_id the element uses, and which <!--__MIHUTZ_SCRIPT_N__--> index powers it (script_index). A rebuilt section that hosts a component MUST reference that same container_id so the carried-over script still works.
- meta: name, purpose (one line), language (BCP-47 like "he" or "en"), audience, tone. dir: "rtl" for Hebrew/Arabic, else "ltr".
- STRIP ALL EMOJI from every heading, subheading, body, item, and cta label you extract. Emoji are never content — they are an AI decoration. The content model must contain zero emoji so the rebuilt site is emoji-free.

Return ONLY valid JSON matching the schema. No prose.`;

const SHELL_SYSTEM =
  `You are RebuildDesigner, a world-class web designer building a website from scratch in a clean, hand-crafted style. Given the site's meta and an approved design_direction, produce the GLOBAL shell every section will sit in.

Return:
- head_extras: the <link> tags that load the chosen fonts (Google Fonts is fine). For Hebrew, use Hebrew-capable fonts (Heebo, Assistant, Rubik, Frank Ruhl Libre, Noto Sans Hebrew).
- tokens_css: a real design system as CSS — :root custom properties for the brand palette, type scale, spacing rhythm, radii and shadows; sensible base element styles (body font/line-height/color, headings, links, img{max-width:100%}); and reusable component classes the sections will use (.container, .btn / .btn-primary, .eyebrow, .section, etc.). Body font-weight >= 500, headings >= 700. Respect dir (logical properties for RTL).
- header_html: the site header/nav markup (logo text = site name, real nav links only). Use the token classes.
- footer_html: a real footer using the site's real facts (name, contact). No invented links.

Look hand-built and premium. FORBIDDEN AI fingerprints: default Inter, purple/indigo gradients, the dark-navy+gold cliché, Playfair-as-elegance, generic "Get Started" copy, perfectly symmetric three-card rows as the only rhythm, and — ABSOLUTELY NO EMOJI anywhere (not in the logo, nav, headings, buttons, or footer). Emoji are the single most obvious AI tell; never emit a single one. Return ONLY valid JSON. No prose.`;

const SECTION_SYSTEM =
  `You are RebuildDesigner, building ONE section of a website from scratch. You are given the approved design_direction, the global tokens_css (the classes and CSS variables you MUST reuse), and the content spec for exactly one section. Build beautiful, human, semantic markup for it and its CSS.

Hard rules:
- Use ONLY the content in this section's spec (its heading, body, items, cta, facts). NEVER invent facts, testimonials, stats, logos, or copy that isn't given. If a field is empty, omit that element — do not fill it with placeholder text.
- Reuse the design tokens and component classes from tokens_css (CSS variables, .container, .btn, spacing). Your section CSS should add only what's specific to this section, scoped under a unique wrapper class derived from the section id (e.g. .sec-<id>) so it can't collide.
- If the spec gives this section a component_id, include an element with exactly that id (the original interactive script will be re-attached to it). Do not write any <script>.
- Compose with real design judgement: vary layouts between sections, use asymmetry and editorial rhythm, real whitespace. No AI clichés (see below). RTL if dir is rtl (logical properties, right alignment).
- FORBIDDEN: default Inter, purple/indigo gradients, "Get Started", identical symmetric card rows every time, lorem/placeholder text.
- ABSOLUTELY NO EMOJI — never put an emoji in a heading, card, badge, list item, button, or anywhere in markup or text. If the source content had emoji (as icons or beside headings), DROP them and replace with a real inline SVG icon, a typographic treatment, or nothing. Emoji are the #1 AI fingerprint. For a stats/achievements block, KEEP the real numbers but present them with editorial variety — never as a symmetric row of identical emoji-topped cards.

Return ONLY valid JSON { "html": "...", "css": "..." } for this one section. No prose.`;

// ================= SCHEMAS =================
const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        purpose: { type: "string" },
        language: { type: "string" },
        audience: { type: "string" },
        tone: { type: "string" },
      },
      required: ["name", "purpose", "language", "audience", "tone"],
    },
    dir: { type: "string", enum: ["rtl", "ltr"] },
    facts: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          heading: { type: "string" },
          subheading: { type: "string" },
          body: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" }, text: { type: "string" }, value: { type: "string" } },
              required: [],
            },
          },
          cta: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string" }, href: { type: "string" } },
            required: [],
          },
          image: { type: "string" },
          component_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "type"],
      },
    },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          container_id: { type: "string" },
          script_index: { type: "number" },
        },
        required: ["name", "container_id"],
      },
    },
  },
  required: ["meta", "dir", "facts", "sections", "components"],
};

const DIRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    brand_palette: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { token: { type: "string" }, hex: { type: "string" }, role: { type: "string" } },
        required: ["token", "hex", "role"],
      },
    },
    typography: {
      type: "object",
      additionalProperties: false,
      properties: { heading: { type: "string" }, body: { type: "string" } },
      required: ["heading", "body"],
    },
    layout_principle: { type: "string" },
    personality: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["brand_palette", "typography", "layout_principle", "personality", "rationale"],
};

const SPEC_PLUS_DIRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { spec: SPEC_SCHEMA, design_direction: DIRECTION_SCHEMA },
  required: ["spec", "design_direction"],
};

const SHELL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    head_extras: { type: "string" },
    tokens_css: { type: "string" },
    header_html: { type: "string" },
    footer_html: { type: "string" },
  },
  required: ["tokens_css", "header_html", "footer_html"],
};

const SECTION_BUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { html: { type: "string" }, css: { type: "string" } },
  required: ["html", "css"],
};

// ================= assembly =================
function assemble(spec: Spec, shell: Shell, sections: BuiltSection[], scripts: string[]): string {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const sectionCss = ordered.map((s) => s.css || "").join("\n\n");
  const sectionHtml = ordered.map((s) => s.html || "").join("\n\n");
  const lang = spec.meta.language || (spec.dir === "rtl" ? "he" : "en");
  const scriptBlock = scripts.length ? "\n" + scripts.join("\n") + "\n" : "";
  return `<!doctype html>
<html lang="${lang}" dir="${spec.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.meta.name || "")}</title>
${shell.head_extras || ""}
<style>
${shell.tokens_css}

${sectionCss}
</style>
</head>
<body>
${shell.header_html}
<main>
${sectionHtml}
</main>
${shell.footer_html}
${scriptBlock}</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ================= handler =================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { scan_id?: string; part?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const scanId = body.scan_id;
  if (!scanId) return json({ error: "scan_id required" }, 400);
  let part = Number.isInteger(body.part) && (body.part as number) >= 1 ? (body.part as number) : 1;

  const { data: scan, error: scanErr } = await admin
    .from("scans")
    .select("id, user_id, detection, site_profile, design_direction")
    .eq("id", scanId)
    .single();
  if (scanErr || !scan || scan.user_id !== user.id) return json({ error: "scan not found" }, 404);
  if (!scan.detection) return json({ error: "run_detection_first" }, 409);

  const P = paths(user.id, scanId);

  try {
    const apiKey = cleanApiKey(Deno.env.get("ANTHROPIC_API_KEY"));
    const startedAt = Date.now();

    const present = presentSignals(scan.detection as { signals?: DetectedSignal[] });
    const avoidList = present.map((s) => `#${s.id} ${s.name}`).join("\n");

    // ---------- PART 1: content spec + design direction ----------
    if (part === 1) {
      const { data: file, error: dlErr } = await admin.storage.from("scans").download(P.bundle);
      if (dlErr || !file) throw new Error("bundle_not_found");
      const pristine = parseBundle(await file.text());
      const htmlFiles = [...pristine.keys()].filter((p) => /\.html?$/i.test(p)).sort();
      if (!htmlFiles.length) return json({ error: "no_html_file" }, 409);
      const target = htmlFiles[0];

      // Carry the original scripts byte-for-byte; the model only sees placeholders.
      const { stripped, scripts } = extractScripts(pristine.get(target) ?? "");
      // Include the other files' text as extra context (also stripped of scripts).
      const context = [...pristine.entries()]
        .filter(([p]) => p !== target)
        .map(([p, c]) => `=== ${p} ===\n${extractScripts(c).stripped}`)
        .join("\n\n")
        .slice(0, 40_000);

      const userContent =
        `<site_profile>\n${JSON.stringify(scan.site_profile ?? {}, null, 2)}\n</site_profile>\n\n` +
        `<primary_page file="${target}">\n${stripped}\n</primary_page>\n\n` +
        (context ? `<other_files>\n${context}\n</other_files>\n\n` : "") +
        `Inventory this site into the content model, and propose ONE design_direction for this business.`;

      const res = await callClaude({
        apiKey, model: MODEL, effort: "high", maxTokens: 12000, stream: true,
        system: SPEC_SYSTEM, schema: SPEC_PLUS_DIRECTION_SCHEMA, userContent, timeoutMs: 135_000,
      });
      await recordStageUsage(admin, scanId, buildEntry("rebuild_spec", MODEL, res.usage, Date.now() - startedAt, "high"));

      const out = (res.json ?? {}) as { spec?: Spec; design_direction?: Direction };
      const spec = out.spec;
      if (!spec || !Array.isArray(spec.sections) || !spec.sections.length) throw new Error("empty_spec");
      const direction = out.design_direction ?? (scan.design_direction as Direction | null);

      await writeJson(admin, P.spec, { spec, design_direction: direction, scripts, target });
      // Reset any prior section builds from an earlier run.
      await writeJson(admin, P.sections, []);

      const parts = 2 + spec.sections.length; // spec + shell + one per section
      await admin.from("scans").update({
        design_direction: direction ?? scan.design_direction ?? null,
        pipeline_status: "applying",
      }).eq("id", scanId);

      return json({
        ok: true, scan_id: scanId, part, parts, done: false,
        design_direction: direction, spec_summary: {
          name: spec.meta?.name, sections: spec.sections.map((s) => ({ id: s.id, type: s.type, heading: s.heading })),
        },
      });
    }

    // For parts > 1 the spec must already exist.
    const stored = await readJson<{ spec: Spec; design_direction: Direction | null; scripts: string[]; target: string }>(admin, P.spec);
    if (!stored || !stored.spec) throw new Error("spec_missing_run_part_1");
    const { spec, target, scripts } = stored;
    const direction = stored.design_direction ?? (scan.design_direction as Direction | null);
    const parts = 2 + spec.sections.length;
    if (part > parts) part = parts;

    // ---------- PART 2: shell (tokens + header/footer + fonts) ----------
    if (part === 2) {
      const userContent =
        `<meta>\n${JSON.stringify(spec.meta, null, 2)}\ndir: ${spec.dir}\n</meta>\n\n` +
        `<design_direction>\n${JSON.stringify(direction ?? {}, null, 2)}\n</design_direction>\n\n` +
        `<facts>\n${(spec.facts ?? []).join("\n")}\n</facts>\n\n` +
        `<avoid_ai_patterns>\n${avoidList}\n</avoid_ai_patterns>\n\n` +
        `Build the global shell: head_extras, tokens_css, header_html, footer_html.`;

      const res = await callClaude({
        apiKey, model: MODEL, effort: "high", maxTokens: 12000, stream: true,
        system: SHELL_SYSTEM, schema: SHELL_SCHEMA, userContent, timeoutMs: 135_000,
      });
      await recordStageUsage(admin, scanId, buildEntry("rebuild_shell", MODEL, res.usage, Date.now() - startedAt, "high"));

      const shell = (res.json ?? {}) as Shell;
      if (!shell.tokens_css) throw new Error("empty_shell");
      await writeJson(admin, P.shell, shell);
      return json({ ok: true, scan_id: scanId, part, parts, done: false, phase: "shell" });
    }

    // ---------- PARTS 3..(2+S): one section each ----------
    const shell = await readJson<Shell>(admin, P.shell);
    if (!shell) throw new Error("shell_missing_run_part_2");
    const sectionIndex = part - 3;
    const section = spec.sections[sectionIndex];
    if (!section) return json({ ok: true, scan_id: scanId, part, parts, done: true });

    const userContent =
      `<design_direction>\n${JSON.stringify(direction ?? {}, null, 2)}\n</design_direction>\n\n` +
      `<tokens_css>\n${shell.tokens_css}\n</tokens_css>\n\n` +
      `<dir>${spec.dir}</dir>\n\n` +
      `<section_spec>\n${JSON.stringify(section, null, 2)}\n</section_spec>\n\n` +
      `Build ONLY this section (html + css), using only the content above.`;

    const res = await callClaude({
      apiKey, model: MODEL, effort: "medium", maxTokens: 10000, stream: true,
      system: SECTION_SYSTEM, schema: SECTION_BUILD_SCHEMA, userContent, timeoutMs: 135_000,
    });
    await recordStageUsage(admin, scanId, buildEntry(`rebuild_section_${sectionIndex + 1}`, MODEL, res.usage, Date.now() - startedAt, "medium"));

    const built = (res.json ?? {}) as { html?: string; css?: string };
    if (!built.html) throw new Error(`empty_section_${sectionIndex + 1}`);

    // Accumulate this section (download-merge-upload, keyed by index).
    const prior = (await readJson<BuiltSection[]>(admin, P.sections)) ?? [];
    const merged = prior.filter((s) => s.index !== sectionIndex);
    merged.push({ index: sectionIndex, html: built.html, css: built.css ?? "" });
    await writeJson(admin, P.sections, merged);

    const done = part >= parts;
    if (done) {
      // Every section built — assemble the final self-contained document.
      const full = assemble(spec, shell, merged, scripts);
      const editedMap = new Map<string, string>([[target, full]]);
      const up = await admin.storage.from("scans").upload(
        P.edited,
        new Blob([serializeBundle(editedMap)], { type: "text/plain" }),
        { upsert: true, contentType: "text/plain" },
      );
      if (up.error) throw new Error(`storage: ${up.error.message}`);

      await admin.from("scans").update({
        pipeline_status: "applied",
        change_log: present.map((s) => ({
          signal_id: s.id, file: target, applied: true, applied_by: "rebuild", reason: null,
        })),
      }).eq("id", scanId);
    }

    return json({
      ok: true, scan_id: scanId, part, parts, done,
      phase: "section", section: { id: section.id, type: section.type, heading: section.heading },
      design_direction: direction,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("scans").update({ error: `rebuild: ${message}` }).eq("id", scanId);
    return json({ error: message }, 500);
  }
});
