import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  checkPreservation,
  collectJs,
  factTokens,
  MIN_WORD_RATIO,
  type PreservationReport,
  scriptHooks,
  summarize,
  visibleText,
  warnings,
  wordCount,
} from "./preservation.ts";

// ---------- visibleText ----------

Deno.test("visibleText: tags go, words stay", () => {
  assertEquals(visibleText("<h1>Hello</h1><p>there</p>"), "Hello there");
});

Deno.test("visibleText: inline CSS and JS are not content", () => {
  const html = `<style>.a{color:red}</style><script>var x = "hello world";</script><p>real</p>`;
  assertEquals(visibleText(html), "real");
});

Deno.test("visibleText: a rebuilt page's inlined stylesheet cannot inflate it", () => {
  const before = "<p>one two three four</p>";
  const after = `<style>${"body{margin:0}".repeat(500)}</style><p>one two three four</p>`;
  assertEquals(wordCount(visibleText(before)), wordCount(visibleText(after)));
});

Deno.test("visibleText: comments and entities", () => {
  assertEquals(visibleText("<!-- note --><p>a&nbsp;&amp;&nbsp;b</p>"), "a & b");
});

// ---------- factTokens ----------

Deno.test("factTokens: years, prices and counts are facts", () => {
  const f = factTokens("founded 1886, moved 1913, 14 titles");
  assert(f.has("1886"));
  assert(f.has("1913"));
  assert(f.has("14"));
});

Deno.test("factTokens: thousands separators do not create a different fact", () => {
  assertEquals([...factTokens("1,886")], [...factTokens("1886")]);
});

Deno.test("factTokens: a sentence-ending period is not part of the number", () => {
  assert(factTokens("built in 2026.").has("2026"));
});

Deno.test("factTokens: single digits are ignored as noise", () => {
  assertEquals(factTokens("pick 1 of 5").size, 0);
});

// ---------- scriptHooks ----------

Deno.test("scriptHooks: reads getElementById, getElementsByClassName and query selectors", () => {
  const h = scriptHooks(`
    document.getElementById("nav");
    document.getElementsByClassName("row");
    document.querySelectorAll(".fade-up");
    document.querySelector("#panel .title");
  `);
  assertEquals([...h.ids].sort(), ["nav", "panel"]);
  assertEquals([...h.classes].sort(), ["fade-up", "row", "title"]);
});

Deno.test("scriptHooks: a selector built at runtime is skipped, not guessed", () => {
  const h = scriptHooks("document.getElementById(prefix + idx);");
  assertEquals(h.ids.size, 0);
  assertEquals(h.classes.size, 0);
});

Deno.test("collectJs: external files and inline blocks, nothing else", () => {
  const js = collectJs(
    new Map([
      ["index.html", `<p>x</p><script>getElementById("a")</script>`],
      ["script.js", `getElementById("b")`],
      ["style.css", `#c { color: red }`],
    ]),
  );
  const h = scriptHooks(js);
  assertEquals([...h.ids].sort(), ["a", "b"]);
});

// ---------- checkPreservation ----------

const PAGE = "index.html";

function check(before: string, after: string, extra: Record<string, string> = {}): PreservationReport {
  const original = new Map([[PAGE, before], ...Object.entries(extra)]);
  const rebuilt = new Map([[PAGE, after], ...Object.entries(extra)]);
  return checkPreservation({ original, rebuilt, page: PAGE });
}

const RICH = `<h1>Arsenal</h1><p>Founded 1886 in Woolwich, moved 1913, invincible 2004.</p>
  <ul><li>one thing</li><li>two thing</li><li>three thing</li><li>four thing</li></ul>
  <p>More prose here to give the page a real body of text worth measuring.</p>`;

Deno.test("checkPreservation: an honest rebuild of the same content passes", () => {
  const after = `<h1>Arsenal</h1><p>Founded in 1886 at Woolwich; moved in 1913; unbeaten in 2004.</p>
    <ul><li>one thing</li><li>two thing</li><li>three thing</li><li>four thing</li></ul>
    <p>More prose here, giving the page a real body of text that is worth measuring.</p>`;
  const r = check(RICH, after);
  assert(r.ok, summarize(r));
});

Deno.test("checkPreservation: the run that deleted the site fails on all three counts", () => {
  const r = check(RICH, `<h1>Arsenal</h1><p>A club.</p>`, { "app.js": `getElementById("nav")` });
  assertFalse(r.ok);
  const kinds = r.failures.map((f) => f.kind).sort();
  assertEquals(kinds, ["facts_missing", "text_shrank"]);
  assert(r.failures.every((f) => f.blocking));
});

Deno.test("checkPreservation: a dropped year is reported by value", () => {
  const after = RICH.replace("1913", "");
  const r = check(RICH, after);
  const facts = r.failures.find((f) => f.kind === "facts_missing");
  assert(facts, "expected a facts failure");
  assertEquals(facts.missing, ["1913"]);
});

Deno.test("checkPreservation: rewording is allowed, deleting is not", () => {
  const reworded = RICH
    .replace("Founded 1886 in Woolwich", "Established in 1886 in Woolwich")
    .replace("More prose here", "Further prose here");
  assert(check(RICH, reworded).ok);
});

Deno.test("checkPreservation: the word-ratio floor sits between the real clusters", () => {
  // Healthy rebuilds measured at 0.99-1.29; the deleting run at 0.27.
  assert(MIN_WORD_RATIO > 0.27);
  assert(MIN_WORD_RATIO < 0.99);
});

Deno.test("checkPreservation: a dereferenced id that vanished blocks delivery", () => {
  const before = `<div id="nav">a</div>${RICH}`;
  const after = `<div id="menu">a</div>${RICH}`;
  const r = check(before, after, { "script.js": `getElementById("nav")` });
  assertFalse(r.ok);
  const ids = r.failures.find((f) => f.kind === "script_ids_missing");
  assert(ids);
  assertEquals(ids.missing, ["#nav"]);
  assert(ids.blocking);
});

Deno.test("checkPreservation: a lost decorative class is reported but does not block", () => {
  const before = `<div class="fade-up">b</div>${RICH}`;
  const after = `<div class="reveal">b</div>${RICH}`;
  const r = check(before, after, { "script.js": `querySelectorAll(".fade-up")` });
  assert(r.ok, "a lost animation is not a reason to withhold the site");
  const warn = warnings(r);
  assertEquals(warn.length, 1);
  assertEquals(warn[0].kind, "script_classes_missing");
  assertEquals(warn[0].missing, [".fade-up"]);
});

Deno.test("checkPreservation: an external .js file protects its ids just like an inline block", () => {
  const before = `<div id="nav">a</div>${RICH}`;
  const after = `<div>a</div>${RICH}`;
  assertFalse(check(before, after, { "js/site.js": `getElementById("nav")` }).ok);
  assertFalse(check(before, after, { "index2.html": `<script>getElementById("nav")</script>` }).ok);
});

Deno.test("checkPreservation: a hook the original never satisfied is not blamed on the rebuild", () => {
  const r = check(RICH, RICH, { "script.js": `getElementById("neverExisted")` });
  assert(r.ok, summarize(r));
  assertEquals(r.stats.hooksChecked, 0);
});

Deno.test("checkPreservation: a hook that survives under a different element still counts as kept", () => {
  const before = `<nav id="nav">a</nav>${RICH}`;
  const after = `<header id="nav" class="new">a</header>${RICH}`;
  assert(check(before, after, { "script.js": `getElementById("nav")` }).ok);
});

Deno.test("checkPreservation: an untouched file contributes nothing either way", () => {
  const original = new Map([[PAGE, RICH], ["about.html", "<p>whatever</p>"]]);
  const rebuilt = new Map(original);
  assert(checkPreservation({ original, rebuilt, page: PAGE }).ok);
});

Deno.test("checkPreservation: an empty original cannot fail", () => {
  const r = check("", "<p>anything</p>");
  assert(r.ok);
  assertEquals(r.stats.wordRatio, 1);
});

Deno.test("summarize: silent on success, specific on failure", () => {
  assertEquals(summarize(check(RICH, RICH)), "content preserved");
  assert(summarize(check(RICH, "<p>gone</p>")).includes("visible text fell"));
});
