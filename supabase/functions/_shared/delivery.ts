// The last stage, where the user finally gets something in their hands.
//
// Everything upstream can succeed and still leave them empty-handed: a branch
// name that collides, a repository whose permissions changed since the scan, an
// archive that assembles but does not open. All three end the same way — a
// finished rebuild the user cannot hold — and all three used to surface as a
// raw error string.
//
// The rules that decide those outcomes live here so they can be tested without
// a GitHub token and without generating a real archive.

/** A branch name that will not collide with the last attempt on the same scan.
 *
 * The old name was derived from the scan id alone, so it was the SAME name
 * every time a scan was pushed — and a second push, after a closed PR or a
 * rebuild run again, hit 422 "Reference already exists" and stopped there. The
 * timestamp makes the ordinary case unique; `suffixed` below covers two pushes
 * inside the same minute, and a name a human happened to take. */
export function branchName(scanId: string, at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return sanitiseBranch(`mihutz-latavnit/scan-${scanId.slice(0, 8)}-${stamp}`);
}

/** The nth alternative for a name that was already taken. */
export function suffixed(base: string, attempt: number): string {
  return `${base}-${attempt + 2}`;
}

/** git refs allow a limited character set; anything else becomes a dash. */
export function sanitiseBranch(name: string): string {
  return name.replace(/[^A-Za-z0-9._/-]/g, "-");
}

/**
 * What a GitHub failure means to the person waiting for a pull request.
 *
 * Only two outcomes matter to them: fix something and try again, or take the
 * work another way. Anything in the second group falls back to a download —
 * the rebuild is finished and paid for either way, and how it is delivered is
 * our problem, not something they should lose the result over.
 */
export function githubFailure(status: number): { code: string; fallback: boolean } {
  if (status === 401 || status === 403) return { code: "github_access_denied", fallback: true };
  if (status === 404) return { code: "github_repo_unavailable", fallback: true };
  if (status === 422) return { code: "github_rejected", fallback: true };
  return { code: "github_failed", fallback: true };
}

/** The four bytes a ZIP can legitimately start with. */
export function hasZipSignature(head: Uint8Array): boolean {
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return false;
  return (head[2] === 0x03 && head[3] === 0x04) || // local file header
    (head[2] === 0x05 && head[3] === 0x06); // empty archive
}

/** Below this an "archive" cannot be holding a project. */
export const ZIP_MIN_BYTES = 200;

export type ZipVerdict = "ok" | "too_small" | "not_an_archive" | "unreadable" | "incomplete";

/**
 * Is this archive safe to hand over?
 *
 * Checked before the download is triggered, not after: an archive that fails to
 * open on the user's machine looks exactly like a run that lost their site, and
 * by then the only thing we can offer is an apology. `filesRead` is the count
 * from reading the finished bytes BACK — a truncated central directory passes
 * the signature test and fails here, which is the corruption worth catching.
 */
export function zipVerdict(
  size: number,
  head: Uint8Array,
  filesRead: number | null,
  expected: number,
): ZipVerdict {
  if (!size || size < ZIP_MIN_BYTES) return "too_small";
  if (!hasZipSignature(head)) return "not_an_archive";
  if (filesRead === null) return "unreadable";
  if (filesRead < expected) return "incomplete";
  return "ok";
}
