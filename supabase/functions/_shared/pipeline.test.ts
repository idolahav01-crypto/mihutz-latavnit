import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  assembleFinalFiles,
  buildSignalList,
  DELETED_FILE,
  isSiteCode,
  keepPath,
  parseBundle,
  pickHomePage,
  pickHomePageDiagnostic,
  pickHomePageSmart,
  presentSignals,
  serializeBundle,
  unreferencedAssets,
} from "./pipeline.ts";

const BUNDLE = `=== FILE: index.html ===
<button class="cta">Get Started</button>
<p>hello</p>

=== FILE: css/app.css ===
:root { --primary: #6366f1; }
body { font-family: 'Inter'; }

`;

Deno.test("parseBundle round-trips paths and content", () => {
  const files = parseBundle(BUNDLE);
  assertEquals([...files.keys()], ["index.html", "css/app.css"]);
  assertEquals(files.get("index.html"), `<button class="cta">Get Started</button>\n<p>hello</p>`);
  assert(files.get("css/app.css")!.includes("--primary: #6366f1;"));
});

Deno.test("serializeBundle reproduces a parseable bundle", () => {
  const files = parseBundle(BUNDLE);
  const round = parseBundle(serializeBundle(files));
  assertEquals([...round.keys()], [...files.keys()]);
  assertEquals(round.get("index.html"), files.get("index.html"));
});

Deno.test("buildSignalList is stable and includes required fields", () => {
  const txt = buildSignalList([
    { id: 11, name: "Default Tailwind", category: "Color", detection: "indigo-500", weight: "high", auto_fixable: "yes" },
  ]);
  assertEquals(txt, "#11 | Default Tailwind | category: Color | weight: high | auto_fixable: yes\n   detection: indigo-500");
});

Deno.test("presentSignals keeps only present & applicable", () => {
  const det = {
    signals: [
      { id: 1, name: "a", present: true, applicable: true, weight: "high" },
      { id: 2, name: "b", present: false, applicable: true, weight: "low" },
      { id: 3, name: "c", present: true, applicable: false, weight: "low" },
    ],
  };
  assertEquals(presentSignals(det).map((s) => s.id), [1]);
});

Deno.test("assembleFinalFiles overlays edited over original", () => {
  const orig = new Map([["a", "1"], ["b", "2"]]);
  const edited = new Map([["a", "EDITED"]]);
  const out = assembleFinalFiles(orig, edited);
  assertEquals(out.get("a"), "EDITED");
  assertEquals(out.get("b"), "2");
});

// ---------- signal #78: Hebrew currency order ----------

Deno.test("assembleFinalFiles drops a tombstoned path", () => {
  const original = new Map([["index.html", "<p>x</p>"], ["style.css", "a{}"]]);
  const edited = new Map([["index.html", "<p>y</p>"], ["style.css", DELETED_FILE]]);
  const out = assembleFinalFiles(original, edited);
  assertEquals(out.get("index.html"), "<p>y</p>");
  assertEquals(out.has("style.css"), false);
});

Deno.test("unreferencedAssets finds the stylesheet the rebuilt page dropped", () => {
  // the real shape: a page rebuilt with inline CSS, keeping its <script src>
  const files = new Map([
    ["index.html", '<html><head><style>a{}</style></head><body><script src="script.js"></script></body></html>'],
    ["style.css", ".hero{right:0}"],
    ["script.js", "console.log(1)"],
  ]);
  assertEquals(unreferencedAssets(files), ["style.css"]);
});

Deno.test("unreferencedAssets keeps a stylesheet another page still links", () => {
  const files = new Map([
    ["index.html", "<html><head><style>a{}</style></head><body></body></html>"],
    ["about.html", '<html><head><link rel="stylesheet" href="style.css"></head></html>'],
    ["style.css", ".hero{right:0}"],
  ]);
  assertEquals(unreferencedAssets(files), []);
});

Deno.test("unreferencedAssets never touches images or pages", () => {
  const files = new Map([
    ["index.html", "<html><head><style>a{}</style></head><body></body></html>"],
    ["old-page.html", "<html><body>still a page</body></html>"],
    ["logo.png", "binary"],
    ["fonts/x.woff2", "binary"],
  ]);
  assertEquals(unreferencedAssets(files), []);
});

Deno.test("unreferencedAssets does nothing when there is no page to judge by", () => {
  assertEquals(unreferencedAssets(new Map([["style.css", "a{}"]])), []);
});

Deno.test("a pruned project survives a bundle round-trip", () => {
  const original = new Map([["index.html", "<p>x</p>"], ["style.css", "a{}"]]);
  const edited = new Map([["index.html", "<p>y</p>"], ["style.css", DELETED_FILE]]);
  const round = parseBundle(serializeBundle(edited));
  const out = assembleFinalFiles(original, round);
  assertEquals([...out.keys()], ["index.html"]);
});

// ---------- pickHomePage ----------

Deno.test("pickHomePage: the real four-page site that used to pick contact.html", () => {
  assertEquals(
    pickHomePage([
      "contact.html",
      "gallery.html",
      "products.html",
      "index.html",
      "style.css",
    ]),
    "index.html",
  );
});

Deno.test("pickHomePage: a single page is that page", () => {
  assertEquals(pickHomePage(["about.html"]), "about.html");
});

Deno.test("pickHomePage: no html at all is null, not a guess", () => {
  assertEquals(pickHomePage(["style.css", "script.js", "README.md"]), null);
});

Deno.test("pickHomePage: nothing named like a home page falls back alphabetically", () => {
  assertEquals(
    pickHomePage(["gallery.html", "contact.html", "products.html"]),
    "contact.html",
  );
});

Deno.test("pickHomePage: a named entry point beats a shallower ordinary page", () => {
  assertEquals(pickHomePage(["about.html", "public/index.html"]), "public/index.html");
});

Deno.test("pickHomePage: the shallowest index wins", () => {
  assertEquals(
    pickHomePage(["docs/index.html", "index.html", "a/b/index.html"]),
    "index.html",
  );
});

Deno.test("pickHomePage: index beats home beats default beats main", () => {
  assertEquals(pickHomePage(["main.html", "default.html", "home.html"]), "home.html");
  assertEquals(pickHomePage(["main.html", "default.html"]), "default.html");
  assertEquals(pickHomePage(["home.html", "index.html"]), "index.html");
});

Deno.test("pickHomePage: .htm counts, and case does not", () => {
  assertEquals(pickHomePage(["contact.html", "Index.HTM"]), "Index.HTM");
});

Deno.test("pickHomePage: order of input does not change the answer", () => {
  const files = ["products.html", "index.html", "contact.html", "gallery.html"];
  const first = pickHomePage(files);
  assertEquals(first, "index.html");
  assertEquals(pickHomePage([...files].reverse()), first);
});

Deno.test("pickHomePage: a page merely containing 'index' is not an index", () => {
  assertEquals(pickHomePage(["contact.html", "index-of-terms.html"]), "contact.html");
});

// ---------- pickHomePageSmart (link graph) ----------

// Every page shares a nav that links to the inner pages, and a logo that links
// home. The home page is called "welcome" — a name heuristic alone would pick
// "contact" (alphabetical). The link graph must still find welcome.
const NAV = (logoHref: string) =>
  `<header><a class="logo" href="${logoHref}">Site</a>` +
  `<nav><a href="welcome.html">בית</a><a href="about.html">אודות</a>` +
  `<a href="contact.html">צור קשר</a></nav></header><main>x</main>`;

Deno.test("pickHomePageSmart: finds a non-standard home name via inbound links", () => {
  const files = new Map([
    ["welcome.html", NAV("welcome.html")],
    ["about.html", NAV("welcome.html")],
    ["contact.html", NAV("welcome.html")],
  ]);
  assertEquals(pickHomePageSmart(files), "welcome.html");
});

Deno.test("pickHomePageSmart: a root index still wins cleanly", () => {
  const nav = `<a class="logo" href="/">Site</a><a href="/about.html">About</a><a href="/services.html">Services</a>`;
  const files = new Map([
    ["index.html", nav],
    ["about.html", nav],
    ["services.html", nav],
  ]);
  assertEquals(pickHomePageSmart(files), "index.html");
});

Deno.test("pickHomePageSmart: resolves ../ and /-rooted links across folders", () => {
  const files = new Map([
    ["index.html", `<a href="blog/post.html">Post</a>`],
    ["blog/post.html", `<a class="brand" href="../index.html">Home</a><a href="/index.html">Home2</a>`],
  ]);
  assertEquals(pickHomePageSmart(files), "index.html");
});

Deno.test("pickHomePageSmart: no usable links falls back to the name heuristic", () => {
  const files = new Map([
    ["index.html", "<h1>ברוכים הבאים</h1>"],
    ["about.html", "<h1>אודות</h1>"],
  ]);
  assertEquals(pickHomePageSmart(files), "index.html");
});

Deno.test("pickHomePageSmart: a single page is that page; no html is null", () => {
  assertEquals(pickHomePageSmart(new Map([["about.html", "x"]])), "about.html");
  assertEquals(pickHomePageSmart(new Map([["style.css", "x"], ["app.js", "y"]])), null);
});

Deno.test("pickHomePageSmart: the answer does not depend on file order", () => {
  const entries: Array<[string, string]> = [
    ["welcome.html", NAV("welcome.html")],
    ["about.html", NAV("welcome.html")],
    ["contact.html", NAV("welcome.html")],
  ];
  const a = pickHomePageSmart(new Map(entries));
  const b = pickHomePageSmart(new Map([...entries].reverse()));
  assertEquals(a, b);
  assertEquals(a, "welcome.html");
});

// ---------- keepPath ----------

Deno.test("keepPath: keeps the files a site is actually made of", () => {
  for (
    const p of [
      "index.html",
      "contact.htm",
      "style.css",
      "css/app.css",
      "js/main.js",
      "app/index.html",
      "robots.txt",
      "sitemap.xml",
      "manifest.json",
    ]
  ) {
    assert(keepPath(p), `should have kept ${p}`);
  }
});

Deno.test("keepPath: drops the junk found in real scan bundles", () => {
  for (
    const p of [
      "pax_global_header",
      "README.md",
      "SETUP-AUTH.md",
      "._contact.html",
      "._style.css",
      "__MACOSX/contact.html",
      ".gitignore",
      ".DS_Store",
      "node_modules/react/index.js",
      "package-lock.json",
    ]
  ) {
    assertFalse(keepPath(p), `should have dropped ${p}`);
  }
});

Deno.test("keepPath: a secret is never bundled and never sent to the model", () => {
  assertFalse(keepPath(".env"));
  assertFalse(keepPath(".env.local"));
  assertFalse(keepPath("config/.env.production"));
});

Deno.test("keepPath: robots.txt survives, because three signals look for it", () => {
  assert(keepPath("robots.txt"));
  assert(keepPath("public/robots.txt"));
});

Deno.test("keepPath: a dotted segment anywhere in the path, not just the start", () => {
  assertFalse(keepPath("src/.cache/app.css"));
  assertFalse(keepPath("a/b/._index.html"));
  assert(keepPath("src/cache/app.css"));
});

Deno.test("keepPath: directory form with a trailing slash", () => {
  assertFalse(keepPath("node_modules/"));
  assertFalse(keepPath(".git/"));
  assert(keepPath("css/"));
});

Deno.test("keepPath: a filename merely containing a dot or the word readme is kept", () => {
  assert(keepPath("index.min.html"));
  assert(keepPath("readme.html"));
  assert(keepPath("my.page.html"));
});

Deno.test("keepPath: documentation goes, licence-named pages of the site stay html", () => {
  assertFalse(keepPath("CHANGELOG"));
  assertFalse(keepPath("LICENSE.txt"));
  assertFalse(keepPath("docs/guide.md"));
  assert(keepPath("license.html"));
});

// ============================================================
// Path safety
// ============================================================

import { fileBlock, safeRelPath } from "./pipeline.ts";

Deno.test("safeRelPath: an ordinary path is returned unchanged", () => {
  assertEquals(safeRelPath("css/app.css"), "css/app.css");
  assertEquals(safeRelPath("index.html"), "index.html");
  assertEquals(safeRelPath("./index.html"), "index.html");
  assertEquals(safeRelPath("a/./b/c.js"), "a/b/c.js");
});

Deno.test("safeRelPath: a path that escapes the project is refused", () => {
  assertEquals(safeRelPath("../evil.txt"), null);
  assertEquals(safeRelPath("../../etc/passwd"), null);
  assertEquals(safeRelPath("a/../../b"), null);
  assertEquals(safeRelPath("..\\..\\x"), null);
});

Deno.test("safeRelPath: a path that walks up and back stays inside", () => {
  // Legal: it never leaves the root, so it is a real file in the project.
  assertEquals(safeRelPath("a/../b.css"), "b.css");
  assertEquals(safeRelPath("a/b/../c.css"), "a/c.css");
});

Deno.test("safeRelPath: absolute and Windows paths are made relative", () => {
  // Contained rather than refused — a zip written on Windows can carry these
  // for entirely innocent reasons, and inside the folder they are harmless.
  assertEquals(safeRelPath("/etc/passwd"), "etc/passwd");
  assertEquals(safeRelPath("C:\\site\\index.html"), "site/index.html");
  assertEquals(safeRelPath("//host/share/x"), "host/share/x");
});

Deno.test("safeRelPath: nothing to name is refused", () => {
  assertEquals(safeRelPath(""), null);
  assertEquals(safeRelPath("dir/"), null);
  assertEquals(safeRelPath("/"), null);
  assertEquals(safeRelPath("."), null);
});

Deno.test("keepPath: an escaping path never enters a bundle", () => {
  assertFalse(keepPath("../../etc/passwd"));
  assertFalse(keepPath("..\\..\\x.html"));
  assert(keepPath("index.html"));
});

Deno.test("parseBundle: a header injected in a file's content cannot escape", () => {
  // The bundle format has no escaping. A file whose body contains a header
  // line starts a new entry — so the path on that line is re-checked, not
  // trusted because something checked it once upstream.
  const bundle = fileBlock("index.html", "<p>hi</p>\n=== FILE: ../../evil.sh ===\nrm -rf /");
  const files = parseBundle(bundle);
  assertEquals([...files.keys()], ["index.html"]);
});

Deno.test("parseBundle: a normal bundle round-trips", () => {
  const files = new Map([["index.html", "<p>a</p>"], ["css/app.css", ".a{}"]]);
  assertEquals([...parseBundle(serializeBundle(files)).entries()], [...files.entries()]);
});

Deno.test("keepPath: a secret that is not named like a dotfile is filtered too", () => {
  assertFalse(keepPath("secrets.json"));
  assertFalse(keepPath("config/secrets.yml"));
  assertFalse(keepPath("credentials.json"));
  assertFalse(keepPath("service-account.json"));
  assertFalse(keepPath("serviceAccountKey.json"));
  assertFalse(keepPath("keys/private.pem"));
  assertFalse(keepPath("cert.key"));
  assertFalse(keepPath("id_rsa"));
  assertFalse(keepPath(".ssh/id_ed25519"));
  assertFalse(keepPath("htpasswd"));
});

Deno.test("keepPath: an ordinary config file is NOT mistaken for a secret", () => {
  // The rule has to be narrow. These are the website, and a scan that loses
  // them scans less of the site than the user paid for.
  assert(keepPath("config.json"));
  assert(keepPath("package.json"));
  assert(keepPath("robots.txt"));
  assert(keepPath("js/app.js"));
  assert(keepPath("data/services.json"));
  assert(keepPath("keyboard.js"));
  assert(keepPath("monkey.html"));
});

Deno.test("isSiteCode: a website's own files count", () => {
  assert(isSiteCode("index.html"));
  assert(isSiteCode("pages/about.htm"));
  assert(isSiteCode("src/app.js"));
  assert(isSiteCode("src/App.jsx"));
  assert(isSiteCode("src/main.ts"));
  assert(isSiteCode("src/App.tsx"));
  assert(isSiteCode("src/App.vue"));
  assert(isSiteCode("src/App.svelte"));
  assert(isSiteCode("src/index.astro"));
  assert(isSiteCode("index.php"));
});

Deno.test("isSiteCode: an upload with none of these has nothing to audit", () => {
  assertFalse(isSiteCode("package.json"));
  assertFalse(isSiteCode("styles/site.css"));
  assertFalse(isSiteCode("notes.txt"));
  assertFalse(isSiteCode("data.csv"));
  assertFalse(isSiteCode("logo.png"));
  assertFalse(isSiteCode("script.py"));
  // The extension has to end the path, not merely appear in it.
  assertFalse(isSiteCode("html/readme.txt"));
  assertFalse(isSiteCode("app.js.bak"));
});

// ---------- how the home page was chosen, not just which ----------

Deno.test("the pick reports that the link graph decided it", () => {
  const files = new Map<string, string>([
    ["welcome.html", `<h1>ברוכים הבאים</h1><a href="about.html">אודות</a>`],
    ["about.html", `<a class="logo" href="welcome.html">לוגו</a><a href="contact.html">צור קשר</a>`],
    ["contact.html", `<a class="logo" href="welcome.html">לוגו</a><a href="about.html">אודות</a>`],
  ]);
  const pick = pickHomePageDiagnostic(files);
  assertEquals(pick.path, "welcome.html");
  assertEquals(pick.method, "links");
  assert(pick.margin > 0, "a clear winner should have a margin");
  // The wrapper still returns exactly what it always did.
  assertEquals(pickHomePageSmart(files), pick.path);
});

Deno.test("a bundle with no usable links says so instead of looking confident", () => {
  const files = new Map<string, string>([
    ["about.html", "<h1>אודות</h1>"],
    ["index.html", "<h1>בית</h1>"],
    ["contact.html", "<h1>צור קשר</h1>"],
  ]);
  const pick = pickHomePageDiagnostic(files);
  assertEquals(pick.method, "names");
  assertEquals(pick.path, "index.html"); // the name heuristic still gets it right
  assertEquals(pick.margin, 0);
});

Deno.test("a single-page bundle is reported as such", () => {
  const pick = pickHomePageDiagnostic(new Map([["only.html", "<h1>hi</h1>"]]));
  assertEquals(pick.method, "only");
  assertEquals(pick.path, "only.html");
  assertEquals(pick.pages, 1);
});

Deno.test("the diagnostic names the runner-up it beat", () => {
  const files = new Map<string, string>([
    ["index.html", `<a href="about.html">אודות</a>`],
    ["about.html", `<a class="logo" href="index.html">לוגו</a>`],
  ]);
  const pick = pickHomePageDiagnostic(files);
  assertEquals(pick.path, "index.html");
  assertEquals(pick.runnerUp, "about.html");
  assertEquals(pick.pages, 2);
});
