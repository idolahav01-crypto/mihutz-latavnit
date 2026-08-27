import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { isNonPageCode, isNonPageCodeWithContent, orderForBundle } from "./frontend.ts";
import { unreferencedAssets } from "./pipeline.ts";

Deno.test("isNonPageCode: server and tooling code is not the website", () => {
  assert(isNonPageCode("server.js"));
  assert(isNonPageCode("api/handler.js"));
  assert(isNonPageCode("src/api/users.ts"));
  assert(isNonPageCode("routes/index.js"));
  assert(isNonPageCode("middleware/auth.js"));
  assert(isNonPageCode("vite.config.js"));
  assert(isNonPageCode("tailwind.config.ts"));
  assert(isNonPageCode("gulpfile.js"));
  assert(isNonPageCode("sw.js"));
  assert(isNonPageCode("service-worker.js"));
  assert(isNonPageCode("src/utils.test.js"));
  assert(isNonPageCode("__tests__/a.js"));
});

Deno.test("isNonPageCode: the website's own files are not swept up", () => {
  assertFalse(isNonPageCode("index.html"));
  assertFalse(isNonPageCode("js/main.js"));
  assertFalse(isNonPageCode("js/ui.js"));
  assertFalse(isNonPageCode("css/style.css"));
  assertFalse(isNonPageCode("assets/app.js"));   // only a ROOT app.js is a Node entry
  assertFalse(isNonPageCode("src/components/Card.jsx"));
});

Deno.test("isNonPageCodeWithContent: an express file anywhere is server code", () => {
  assert(isNonPageCodeWithContent("lib/boot.js", `const e = require("express"); e().listen(3000)`));
  assert(isNonPageCodeWithContent("lib/boot.js", `module.exports = {}`));
  assertFalse(isNonPageCodeWithContent("js/ui.js", `export function render(){}`));
});

Deno.test("orderForBundle: the website goes first, nothing is dropped", () => {
  const paths = ["api/a.js", "index.html", "server.js", "js/main.js", "vite.config.js", "css/s.css"];
  const out = orderForBundle(paths);
  assertEquals(out, ["index.html", "js/main.js", "css/s.css", "api/a.js", "server.js", "vite.config.js"]);
  assertEquals(out.length, paths.length);
});

Deno.test("orderForBundle: a pure frontend project keeps its original order", () => {
  const paths = ["index.html", "css/a.css", "js/b.js", "about.html"];
  assertEquals(orderForBundle(paths), paths);
});

// ---------- what the ordering is FOR ----------

Deno.test("a big backend no longer pushes the site out of a 300KB budget", () => {
  const cap = 300_000;
  const files: Array<[string, number]> = [];
  for (let i = 0; i < 40; i++) files.push([`api/route-${i}.js`, 9_000]); // 360KB
  files.push(["index.html", 20_000]);
  files.push(["css/site.css", 30_000]);
  files.push(["js/main.js", 30_000]);

  const take = (paths: string[]) => {
    const size = new Map(files);
    const taken: string[] = [];
    let total = 0;
    for (const p of paths) {
      if (total >= cap) break;
      total += size.get(p)!;
      taken.push(p);
    }
    return taken;
  };

  const site = ["index.html", "css/site.css", "js/main.js"];
  const before = take(files.map(([p]) => p));
  const after = take(orderForBundle(files.map(([p]) => p)));

  // The old order reached the cap while still inside api/.
  assertFalse(site.every((p) => before.includes(p)));
  // The new one takes the whole site before it touches the backend.
  assert(site.every((p) => after.includes(p)));
});

// ---------- the orphan sweep ----------

const MODULE_SITE = new Map<string, string>([
  ["index.html", `<!doctype html><html><head><link rel="stylesheet" href="css/main.css">
</head><body><h1>hi</h1><script type="module" src="js/main.js"></script></body></html>`],
  ["js/main.js", `import { render } from "./ui.js";
import { fetchAll } from "./api-client.js";
navigator.serviceWorker.register("/sw.js");`],
  ["js/ui.js", `export function render(x){ document.body.textContent = x; }`],
  ["js/api-client.js", `export async function fetchAll(){ return fetch("/api"); }`],
  ["css/main.css", `@import "tokens.css";\nbody{margin:0}`],
  ["css/tokens.css", `:root{--brand:#0af}`],
  ["sw.js", `self.addEventListener("install", () => {});`],
  ["server.js", `const express=require("express");express().listen(3000);`],
  ["api/handler.js", `module.exports = (req,res) => res.end("ok");`],
  ["vite.config.js", `export default { root: "." }`],
]);

Deno.test("the sweep never deletes a module the site imports", () => {
  assertEquals(unreferencedAssets(MODULE_SITE), []);
});

Deno.test("the sweep still removes a stylesheet the rebuild orphaned", () => {
  const afterRebuild = new Map<string, string>([
    ["index.html", `<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>hi</h1></body></html>`],
    ["css/style.css", `body{margin:0;box-shadow:0 1px 2px rgba(0,0,0,.1)}`],
  ]);
  assertEquals(unreferencedAssets(afterRebuild), ["css/style.css"]);
});

Deno.test("a stylesheet a page we did not rebuild still links stays", () => {
  const partial = new Map<string, string>([
    ["index.html", `<html><head><style>body{margin:0}</style></head><body></body></html>`],
    ["about.html", `<html><head><link rel="stylesheet" href="css/style.css"></head><body></body></html>`],
    ["css/style.css", `body{margin:0}`],
  ]);
  assertEquals(unreferencedAssets(partial), []);
});

Deno.test("a file naming itself does not keep itself alive", () => {
  const withSourceMap = new Map<string, string>([
    ["index.html", `<html><head><style>body{margin:0}</style></head><body></body></html>`],
    ["style.css", `body{margin:0}\n/*# sourceMappingURL=style.css.map */`],
  ]);
  assertEquals(unreferencedAssets(withSourceMap), ["style.css"]);
});

Deno.test("no HTML at all means nothing is judged orphaned", () => {
  assertEquals(unreferencedAssets(new Map([["js/a.js", "export const a = 1"]])), []);
});
