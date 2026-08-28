import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { constraintsBlock, designSchema, directionSchema } from "./design_brief.ts";

const profile = (o: Record<string, unknown>) => o;

// ---------- brand colour (#17) ----------

Deno.test("a colour someone chose is kept, by name and by hex", () => {
  const out = constraintsBlock(profile({
    brand_colour: { hex: "#e2001a", preserve: true, evidence: "logo", ai_default: false },
  }));
  assert(out.includes("#e2001a"));
  assert(out.includes("KEEP IT"));
  assert(out.includes("logo"), "the evidence is quoted, so the instruction is arguable");
});

Deno.test("a tool default is explicitly abandoned, not merely left unmentioned", () => {
  const out = constraintsBlock(profile({
    brand_colour: { hex: "#6366f1", preserve: false, evidence: "css_variable_only", ai_default: true },
  }));
  assert(out.includes("tool default"));
  assert(out.includes("Move away"));
  assertFalse(out.includes("KEEP IT"));
});

Deno.test("no brand colour at all produces no colour instruction", () => {
  const out = constraintsBlock(profile({ brand_colour: { hex: "", preserve: false, evidence: "none" } }));
  assertFalse(out.includes("KEEP IT"));
  assertFalse(out.includes("tool default"));
});

// ---------- industry (#19) ----------

Deno.test("the industry is named so the tone can be held to it", () => {
  const out = constraintsBlock(profile({ business_domain: "legal" }));
  assert(out.includes("legal"));
  assert(out.includes("credible"));
});

Deno.test('"other" is not an industry and says nothing', () => {
  assertFalse(constraintsBlock(profile({ business_domain: "other" })).includes("business_domain"));
});

// ---------- assets (#22) ----------

Deno.test("a site with no images is steered off image-led directions", () => {
  const out = constraintsBlock(profile({ visual_assets: { verdict: "none" } }));
  assert(out.includes("type, colour, space and geometry"));
  assert(out.includes("Do NOT"));
});

Deno.test("logo-only is treated as having nothing to lay out", () => {
  const out = constraintsBlock(profile({ visual_assets: { verdict: "logo_only" } }));
  assert(out.includes("logo and nothing else"));
});

Deno.test("a site with real photographs is not steered away from them", () => {
  const out = constraintsBlock(profile({ visual_assets: { verdict: "rich", photos: 9, css_images: 2 } }));
  assertFalse(out.includes("Do NOT"));
});

Deno.test("an empty profile constrains nothing rather than inventing constraints", () => {
  assertEquals(constraintsBlock({}), "");
  assertEquals(constraintsBlock(null), "");
  assertEquals(constraintsBlock(undefined), "");
});

Deno.test("all three constraints coexist in one block", () => {
  const out = constraintsBlock(profile({
    brand_colour: { hex: "#2f6f4e", preserve: true, evidence: "consistent_across_pages" },
    business_domain: "medical",
    visual_assets: { verdict: "none" },
  }));
  assertEquals(out.split("\n").length, 3);
});

// ---------- the font enum (#18) ----------

function fonts(rtl: boolean): string[] {
  const s = directionSchema(rtl) as unknown as {
    properties: { typography: { properties: { heading: { enum: string[] } } } };
  };
  return s.properties.typography.properties.heading.enum;
}

Deno.test("a Hebrew site cannot be given a font without Hebrew glyphs", () => {
  const list = fonts(true);
  assert(list.includes("Heebo"));
  assertFalse(list.includes("Playfair Display"), "signal #74's usual culprit");
  assertFalse(list.includes("Fraunces"));
});

Deno.test("a Latin site gets the wide list", () => {
  const list = fonts(false);
  assert(list.includes("Fraunces"));
  assertFalse(list.includes("Heebo"));
});

Deno.test("heading and body are drawn from the same closed list", () => {
  const s = directionSchema(true) as unknown as {
    properties: { typography: { properties: { heading: { enum: string[] }; body: { enum: string[] } } } };
  };
  assertEquals(s.properties.typography.properties.heading.enum, s.properties.typography.properties.body.enum);
});

Deno.test("the rest of the direction schema is untouched by the font choice", () => {
  const s = directionSchema(true) as unknown as { required: string[]; properties: Record<string, unknown> };
  for (const k of ["brand_palette", "typography", "layout_principle", "personality", "rationale"]) {
    assert(s.required.includes(k), `${k} still required`);
    assert(k in s.properties, `${k} still present`);
  }
});

Deno.test("designSchema carries the per-site direction, not the generic one", () => {
  const s = designSchema(true) as unknown as {
    properties: { design_direction: { properties: { typography: { properties: { heading: { enum: string[] } } } } } };
  };
  assert(s.properties.design_direction.properties.typography.properties.heading.enum.includes("Assistant"));
});
