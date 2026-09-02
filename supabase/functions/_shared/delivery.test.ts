import { assert, assertEquals, assertFalse, assertNotEquals } from "jsr:@std/assert@1";
import {
  branchName,
  githubFailure,
  hasZipSignature,
  sanitiseBranch,
  suffixed,
  zipVerdict,
  ZIP_MIN_BYTES,
} from "./delivery.ts";

const SCAN = "d5ed2628-93f3-459e-b75b-57d0dc1cb75f";

// ---------- branch names (#34) ----------

Deno.test("two pushes of the same scan get different branches", () => {
  const a = branchName(SCAN, new Date("2026-08-29T09:15:00Z"));
  const b = branchName(SCAN, new Date("2026-08-29T11:42:00Z"));
  assertNotEquals(a, b, "the old name was the scan id alone and collided every time");
});

Deno.test("the branch name is readable and carries the scan", () => {
  const n = branchName(SCAN, new Date("2026-08-29T09:15:00Z"));
  assertEquals(n, "mihutz-latavnit/scan-d5ed2628-20260829-0915");
});

Deno.test("a name taken inside the same minute is retried, not surrendered", () => {
  const base = branchName(SCAN, new Date("2026-08-29T09:15:00Z"));
  assertEquals(suffixed(base, 0), base + "-2");
  assertEquals(suffixed(base, 1), base + "-3");
  const all = new Set([base, suffixed(base, 0), suffixed(base, 1), suffixed(base, 2)]);
  assertEquals(all.size, 4, "every alternative is distinct");
});

Deno.test("a branch name can only contain what git accepts", () => {
  // Assert the RULE, not a dash count: every character that git would refuse
  // is replaced, the path separator survives, and a legal name is untouched.
  const cleaned = sanitiseBranch("feature/עברית ורווחים");
  assertFalse(/[^A-Za-z0-9._/-]/.test(cleaned), "nothing illegal survives");
  assert(cleaned.startsWith("feature/"), "the separator is legal and kept");
  assertEquals(sanitiseBranch("ok/name-1.2_3"), "ok/name-1.2_3");
  assertFalse(/[^A-Za-z0-9._/-]/.test(branchName(SCAN)));
});

// ---------- github failures (#34) ----------

Deno.test("every GitHub failure leaves the user with a way to get the work", () => {
  for (const status of [401, 403, 404, 409, 422, 500, 502]) {
    assert(githubFailure(status).fallback, `${status} must fall back to a download`);
  }
});

Deno.test("the cause is named, because the user can act on some of them", () => {
  assertEquals(githubFailure(403).code, "github_access_denied");
  assertEquals(githubFailure(401).code, "github_access_denied");
  assertEquals(githubFailure(404).code, "github_repo_unavailable");
  assertEquals(githubFailure(422).code, "github_rejected");
  assertEquals(githubFailure(500).code, "github_failed");
});

// ---------- the archive (#33) ----------

const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ARCHIVE = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

Deno.test("a good archive passes", () => {
  assertEquals(zipVerdict(50_000, PK, 12, 12), "ok");
  assertEquals(zipVerdict(50_000, PK, 14, 12), "ok", "more files than expected is fine");
});

Deno.test("an archive that is not an archive is caught", () => {
  // A renamed PNG, the exact thing the upload stage already refuses to accept.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assertEquals(zipVerdict(50_000, png, 12, 12), "not_an_archive");
});

Deno.test("an empty-archive signature is still a real signature", () => {
  assertEquals(zipVerdict(50_000, EMPTY_ARCHIVE, 12, 12), "ok");
});

Deno.test("a truncated archive is caught by reading it back", () => {
  // Signature intact, central directory gone: opens as garbage on the user's
  // machine, which looks exactly like a run that lost their site.
  assertEquals(zipVerdict(50_000, PK, null, 12), "unreadable");
  assertEquals(zipVerdict(50_000, PK, 3, 12), "incomplete");
});

Deno.test("an archive too small to hold a project is caught before the size test can be fooled", () => {
  assertEquals(zipVerdict(0, PK, 12, 12), "too_small");
  assertEquals(zipVerdict(ZIP_MIN_BYTES - 1, PK, 12, 12), "too_small");
  assertEquals(zipVerdict(ZIP_MIN_BYTES, PK, 12, 12), "ok");
});

Deno.test("hasZipSignature rejects a short read rather than reading past it", () => {
  assertFalse(hasZipSignature(new Uint8Array([0x50, 0x4b])));
  assertFalse(hasZipSignature(new Uint8Array([])));
  assert(hasZipSignature(PK));
});

// ---------- what belongs in the asset store ----------
//
// The predicate lives in two places that must agree: fetch-repo decides what to
// keep off a tarball, and js/app.js decides what to keep out of a ZIP. Both are
// "what a page paints or loads", and neither may quietly become "everything the
// bundle filtered", which would put node_modules in the download.

const ASSET_FILE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot)$/i;

Deno.test("the media a rebuilt page will point at is kept", () => {
  for (const p of [
    "images/hero.jpg", "img/logo.svg", "assets/photo.webp", "a/b/c/shot.JPEG",
    "favicon.ico", "fonts/heebo.woff2", "fonts/x.ttf",
  ]) {
    assert(ASSET_FILE.test(p), `${p} must be delivered`);
  }
});

Deno.test("code and archives are not assets", () => {
  for (const p of [
    "index.html", "app.js", "style.css", "package.json", "README.md",
    "build.zip", "video.mp4", "notes.pdf", "data.csv",
  ]) {
    assertFalse(ASSET_FILE.test(p), `${p} is not a page asset`);
  }
});

Deno.test("an extension in the middle of a path does not qualify it", () => {
  assertFalse(ASSET_FILE.test("png/readme.txt"));
  assertFalse(ASSET_FILE.test("images/hero.jpg.bak"));
});
