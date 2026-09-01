// The brief the design stage is held to.
//
// A rebuild is told to depart from the original, and for a template that is
// exactly right. But "different" is not the only requirement a real business
// has, and until this file existed it was the only one the designer was given:
// a law firm could come back playful, a brand colour someone had chosen for
// twenty years could be swapped for a fresher one, and a direction built on
// full-bleed photography could be handed to a business that owns no
// photographs. None of those read as failures in the output — they read as
// confident design — which is why they need to be constrained on the way in
// rather than caught on the way out.
//
// Lifted out of rebuild/index.ts so it can be tested without a model call.

import { fontChoices } from "./profile.ts";

/**
 * What the design stage must NOT depart from.
 *
 * originalLookBlock below is the "move away from this" half, and until now it
 * was the only half — the prompt told the designer to choose a different colour
 * family, full stop, so a business whose colour IS its identity got a new one.
 * The catalogue does not actually ask for that: signal #84 rewards one strong
 * consistent brand colour, and the colour signals (#9 purple gradients, #11
 * Tailwind defaults, #14 neon) are about a tool's defaults, not a decision.
 *
 * So the palette is preserved when the audit found evidence a person chose it,
 * and abandoned when it is a default wearing a brand's clothes. detect decides
 * which, half by model judgment and half by text search; this only reads the
 * verdict. Assets and industry come from the same profile for the same reason:
 * a photography-led direction is unbuildable for a business that owns no
 * photographs, and a playful one is wrong for a law firm however fresh it looks.
 */
export function constraintsBlock(profile: unknown): string {
  const p = (profile ?? {}) as {
    business_domain?: string;
    brand_colour?: { hex?: string; preserve?: boolean; evidence?: string; ai_default?: boolean };
    visual_assets?: { verdict?: string; photos?: number; css_images?: number };
    measured_language?: { code?: string; rtl?: boolean };
    logo_colours?: string[];
  };
  const lines: string[] = [];

  // An inline logo is markup, so its colours are readable. That is the only
  // honest way we can answer "base the design on the logo": a raster mark is a
  // binary the scan never opens, and we do not guess at what is inside it.
  const logo = p.logo_colours ?? [];
  if (logo.length) {
    lines.push(
      `logo_colours: ${logo.join(", ")} — read from the site's own logo mark. The palette ` +
      `must sit with these, not fight them: reuse one as the primary if it also appears in ` +
      `brand_colour, and otherwise choose a family that a header carrying this mark can hold.`,
    );
  }

  const brand = p.brand_colour;
  if (brand?.preserve && brand.hex) {
    lines.push(
      `brand_colour: ${brand.hex} — KEEP IT. Evidence it was chosen: ${brand.evidence}. ` +
      `This exact hex must appear in brand_palette as the primary. Build the rest of the ` +
      `palette around it; change everything else about the design, not this.`,
    );
  } else if (brand?.hex && brand.ai_default) {
    lines.push(
      `brand_colour: ${brand.hex} is a tool default, not a brand. Move away from it entirely.`,
    );
  }

  if (p.business_domain && p.business_domain !== "other") {
    lines.push(
      `business_domain: ${p.business_domain}. The direction must read as credible for this ` +
      `industry to its own customers. Being different from the original never justifies a ` +
      `tone the business could not use.`,
    );
  }

  const a = p.visual_assets;
  if (a?.verdict === "none" || a?.verdict === "logo_only") {
    lines.push(
      `visual_assets: ${a.verdict === "none" ? "none at all" : "a logo and nothing else"}. ` +
      `The site has no photography to lay out. Propose a direction that carries itself on ` +
      `type, colour, space and geometry. Do NOT propose one built on imagery, full-bleed ` +
      `photography or a hero image — there is nothing to put there and the result would be ` +
      `emptier than what it replaced.`,
    );
  } else if (a?.verdict === "some") {
    lines.push(
      `visual_assets: ${(a.photos ?? 0) + (a.css_images ?? 0)} real images. Enough to use, ` +
      `not enough to build the whole direction on.`,
    );
  }

  return lines.join("\n");
}

export const DIRECTION_SCHEMA = {
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
      // Filled in per-run by directionSchema(): a Hebrew site gets only fonts
      // that ship Hebrew glyphs. A prompt asking nicely was not enough — the
      // font is picked HERE, in the design pass, and the shell's Hebrew hint
      // came a step too late to correct it.
      properties: { heading: { type: "string" }, body: { type: "string" } },
      required: ["heading", "body"],
    },
    layout_principle: { type: "string" },
    personality: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["brand_palette", "typography", "layout_principle", "personality", "rationale"],
};

export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    design_direction: DIRECTION_SCHEMA,
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        purpose: { type: "string" },
        audience: { type: "string" },
        tone: { type: "string" },
      },
      required: ["purpose", "audience", "tone"],
    },
  },
  required: ["design_direction", "meta"],
};

/**
 * The direction schema for one specific site.
 *
 * Everything is fixed except the font names, which become an enum drawn from
 * the script the copy is actually written in. A structured-output enum is not
 * a request: the model cannot return "Playfair Display" for a Hebrew site,
 * because the response would not validate. That closes signal #74 at the
 * source rather than catching it in the audit afterwards.
 */
export function directionSchema(rtl: boolean) {
  const choices = fontChoices(rtl);
  return {
    ...DIRECTION_SCHEMA,
    properties: {
      ...DIRECTION_SCHEMA.properties,
      typography: {
        type: "object",
        additionalProperties: false,
        properties: {
          heading: { type: "string", enum: choices },
          body: { type: "string", enum: choices },
        },
        required: ["heading", "body"],
      },
    },
  };
}

export function designSchema(rtl: boolean) {
  return { ...DESIGN_SCHEMA, properties: { ...DESIGN_SCHEMA.properties, design_direction: directionSchema(rtl) } };
}
