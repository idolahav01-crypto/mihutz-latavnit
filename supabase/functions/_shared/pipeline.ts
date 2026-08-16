// Pure, dependency-free helpers shared by pipeline stages 2, 4 and 5.
//
// Everything here is deterministic and free of network / Supabase I/O so it can
// be unit-tested directly (see _shared/pipeline.test.ts). The breakage point the
// spec calls out — "a proposal whose old_code is not a verbatim, unique substring
// of the original file can never be applied" — lives here in isVerbatimUnique /
// validateProposals, and is covered by tests.

export interface Signal {
  id: number;
  name: string;
  category: string;
  category_letter?: string;
  detection: string;
  weight: string;
  auto_fixable: string;
}

export interface Evidence {
  file: string;
  snippet: string;
}

export interface DetectedSignal {
  id: number;
  name: string;
  present: boolean;
  applicable: boolean;
  weight: string;
  confidence?: number;
  total_occurrences?: number;
  explanation?: string;
  evidence?: Evidence[];
}

export interface Proposal {
  signal_id: number;
  file?: string;
  fix_type?: "token" | "component" | "copy" | "meta" | "strategic";
  old_code?: string | null;
  new_code?: string | null;
  sample_new_code?: string | null;
  depends_on?: number[];
  needs_human_decision?: boolean;
  recommended_option?: unknown;
  [k: string]: unknown;
}

export interface ApprovedFix {
  signal_id: number;
  file: string;
  old_code: string;
  new_code: string;
  fix_type?: string;
  depends_on?: number[];
}

const FILE_HEADER = /^=== FILE: (.+?) ===$/gm;

/** Format one file block the same way the client / fetch-repo bundler does. */
export function fileBlock(path: string, content: string): string {
  return `=== FILE: ${path} ===\n${content}\n\n`;
}

/** Parse a "=== FILE: path ===" bundle into a path -> content map. */
export function parseBundle(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const marks: Array<{ path: string; start: number; headerEnd: number }> = [];
  FILE_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_HEADER.exec(text)) !== null) {
    marks.push({ path: m[1], start: m.index, headerEnd: FILE_HEADER.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const contentStart = marks[i].headerEnd + 1; // skip the newline after the header
    const contentEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    // The bundler appends "\n\n" after each file; drop that trailing padding.
    const content = text.slice(contentStart, contentEnd).replace(/\n+$/, "");
    map.set(marks[i].path, content);
  }
  return map;
}

/** Serialise a path -> content map back into a bundle. */
export function serializeBundle(files: Map<string, string>): string {
  let out = "";
  for (const [path, content] of files) out += fileBlock(path, content);
  return out;
}

/** Full signal-list text (stable bytes → cacheable). Mirrors detect's format. */
export function buildSignalList(signals: Signal[]): string {
  return signals
    .map(
      (s) =>
        `#${s.id} | ${s.name} | category: ${s.category} | weight: ${s.weight} | auto_fixable: ${s.auto_fixable}\n   detection: ${s.detection}`,
    )
    .join("\n\n");
}

/** The present, applicable signals only — Stage 2 never sees the other ~85. */
export function presentSignals(detection: { signals?: DetectedSignal[] }): DetectedSignal[] {
  return (detection.signals ?? []).filter((s) => s.present === true && s.applicable !== false);
}

/**
 * The flagged code regions only (Stage 2 must NOT receive the whole project).
 * We include, per file referenced by any present signal's evidence, that file's
 * content from the bundle (capped), tagged with its path.
 */
export function extractCodeRegions(
  files: Map<string, string>,
  present: DetectedSignal[],
  // Send the WHOLE flagged file, not a 12KB slice. A truncated region was the
  // main reason Stage 2 quoted an old_code that wasn't a verbatim substring of
  // the real file, so validateProposals rejected it and the fix silently
  // vanished ("45 found, 5 fixed"). The bundler already caps each file at 60KB
  // (MAX_FILE_BYTES), so this is bounded.
  maxBytesPerFile = 60_000,
): Array<{ file: string; content: string }> {
  const wanted = new Set<string>();
  for (const s of present) {
    for (const ev of s.evidence ?? []) {
      if (ev?.file) wanted.add(ev.file);
    }
  }
  const regions: Array<{ file: string; content: string }> = [];
  for (const path of wanted) {
    const content = files.get(path);
    if (content == null) continue;
    regions.push({ file: path, content: content.slice(0, maxBytesPerFile) });
  }
  return regions;
}

/** true iff `needle` occurs exactly once in `haystack`. */
export function isVerbatimUnique(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const first = haystack.indexOf(needle);
  if (first === -1) return false;
  return haystack.indexOf(needle, first + 1) === -1;
}

export interface ProposalValidation extends Proposal {
  old_code_verbatim: boolean;
  applicable_edit: boolean;
  /** Set when a deterministic check rejected an otherwise-valid proposal. */
  rejected_reason?: string;
}

/**
 * Signal #78 is unambiguous: in Hebrew the currency symbol goes BEFORE the
 * number ("₪30"), and the fix for it must never produce "30 ₪".
 *
 * A real run proposed exactly that inversion and shipped it into a pull
 * request, taking correct markup and making it wrong. QA caught it after the
 * fact and after the money was spent. The direction here is a documented rule
 * with one correct answer, so it does not need a model's judgement — checking
 * it costs nothing and turns a paid, after-the-fact catch into a free one.
 *
 * Exported for tests. Returns true when the proposal INVERTS the order.
 */
export function invertsCurrencyOrder(oldCode: string, newCode: string): boolean {
  const symbolFirst = /[₪$€£]\s*\d/;
  const numberFirst = /\d\s*[₪$€£]/;
  // Only a change that had the symbol leading and now trails is a regression.
  // A fix that leaves both forms present, or touches neither, is not our call.
  return symbolFirst.test(oldCode) && !numberFirst.test(oldCode) &&
    numberFirst.test(newCode) && !symbolFirst.test(newCode);
}

/**
 * The spec's "quick check": for every non-strategic proposal, confirm old_code is
 * a verbatim UNIQUE substring of its file. Proposals that fail can never be
 * applied by Stage 4, so we flag them (applicable_edit=false) up front.
 */
export function validateProposals(
  proposals: Proposal[],
  files: Map<string, string>,
): ProposalValidation[] {
  return proposals.map((p) => {
    // Only a missing anchor makes a fix impossible to apply. "strategic" /
    // needs_human no longer opt a fix out of auto-apply — the product now fixes
    // everything it can quote verbatim, with no human-approval step.
    const noAnchor = p.old_code == null || p.old_code === "";
    if (noAnchor) {
      return { ...p, old_code_verbatim: false, applicable_edit: false };
    }
    const content = p.file ? files.get(p.file) : undefined;
    const oldCode = String(p.old_code);
    const verbatim = content != null && isVerbatimUnique(content, oldCode);
    // A fix is applicable if apply() could land it — that includes the exact
    // match AND the whitespace-insensitive unique match apply() falls back to.
    // Validating only the exact form was rejecting fixes the editor could apply,
    // which showed up in the UI as bogus "needs a human" entries.
    const applicable = content != null &&
      (verbatim || findWhitespaceInsensitiveUnique(content, oldCode) != null);

    const newCode = String(p.sample_new_code ?? p.new_code ?? "");
    if (applicable && invertsCurrencyOrder(oldCode, newCode)) {
      return {
        ...p,
        old_code_verbatim: verbatim,
        applicable_edit: false,
        rejected_reason: "inverts_currency_order",
      };
    }
    return { ...p, old_code_verbatim: verbatim, applicable_edit: applicable };
  });
}

/** Unique file paths touched by a set of approved fixes. */
export function filesTouchedByFixes(fixes: ApprovedFix[]): string[] {
  return Array.from(new Set(fixes.map((f) => f.file)));
}

/**
 * Turn validated Stage-2 proposals into the ApprovedFix set Stage 4 consumes.
 * Only applicable (verbatim, non-strategic) proposals become edits; sample_new_code
 * is the fix's new_code. `restrict` limits to specific signal_ids (QA reapply).
 */
export function deriveApprovedFixes(
  proposals: ProposalValidation[],
  restrict?: number[],
): ApprovedFix[] {
  const set = restrict ? new Set(restrict) : null;
  return proposals
    .filter((p) => p.applicable_edit && p.file && p.old_code)
    .filter((p) => !set || set.has(p.signal_id))
    .map((p) => ({
      signal_id: p.signal_id,
      file: String(p.file),
      old_code: String(p.old_code),
      new_code: String(p.sample_new_code ?? p.new_code ?? ""),
      fix_type: typeof p.fix_type === "string" ? p.fix_type : undefined,
      depends_on: Array.isArray(p.depends_on) ? p.depends_on : undefined,
    }))
    .filter((f) => f.new_code !== "");
}

export interface ApplyResult {
  applied: boolean;
  content: string;
  reason: string | null;
}

/**
 * Deterministic single-fix application, used both as an orchestration fallback
 * and as a self-check oracle in tests. Exact unique match first; then a
 * whitespace-insensitive unique match (mirrors PrecisionEditor's allowed
 * relaxation). Never approximates beyond that.
 */
export function applyFix(content: string, oldCode: string, newCode: string): ApplyResult {
  if (isVerbatimUnique(content, oldCode)) {
    return { applied: true, content: content.replace(oldCode, newCode), reason: null };
  }
  // whitespace-insensitive: collapse runs of whitespace and try to locate a
  // unique region whose normalised form equals the normalised old_code.
  const match = findWhitespaceInsensitiveUnique(content, oldCode);
  if (match) {
    return {
      applied: true,
      content: content.slice(0, match.start) + newCode + content.slice(match.end),
      reason: null,
    };
  }
  const count = countOccurrences(content, oldCode);
  return {
    applied: false,
    content,
    reason: count > 1 ? "multiple_matches" : "no_match",
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function findWhitespaceInsensitiveUnique(
  content: string,
  oldCode: string,
): { start: number; end: number } | null {
  const target = normalizeWs(oldCode);
  if (!target) return null;
  // Slide a window over token boundaries. Cheap approach: scan candidate start
  // offsets at each non-space char and grow until normalised length matches.
  const matches: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < content.length; start++) {
    if (/\s/.test(content[start])) continue;
    let end = start;
    let norm = "";
    while (end < content.length && norm.length <= target.length + 1) {
      end++;
      norm = normalizeWs(content.slice(start, end));
      if (norm === target) {
        matches.push({ start, end });
        break;
      }
      if (norm.length > target.length) break;
    }
    if (matches.length > 1) return null; // ambiguous
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Merge edited files over the saved originals → the final, complete project. */
/**
 * A tombstone: this path was deliberately dropped from the delivered project.
 *
 * The edited bundle only carries files a stage rewrote, and everything else
 * comes through from the original — which is right until a stage makes a file
 * obsolete rather than changing it. A rebuilt page carries its own CSS inline,
 * so the old stylesheet is dead code: nothing links it, and it still ships to
 * the user and still scores against them. Measured on one real rebuild, an
 * orphaned style.css alone kept two signals alive (#64 and #77).
 *
 * A sentinel rather than a separate delete list, because every consumer — the
 * zip, the pull request, the after-scan, QA — already funnels through
 * assembleFinalFiles, so they all honour it without changing.
 */
export const DELETED_FILE = "\u0000MIHUTZ_DELETED\u0000";

export function assembleFinalFiles(
  original: Map<string, string>,
  edited: Map<string, string>,
): Map<string, string> {
  const out = new Map(original);
  for (const [path, content] of edited) {
    if (content === DELETED_FILE) out.delete(path);
    else out.set(path, content);
  }
  return out;
}

/**
 * Files nothing links to any more.
 *
 * Only stylesheets and scripts are candidates: an unreferenced image may still
 * be wanted, and another HTML page is a page, not an asset. A file is kept if
 * ANY surviving page mentions its name, so a stylesheet shared with a page we
 * did not rebuild stays. The match is deliberately loose in the keeping
 * direction — a false keep costs nothing, a false delete costs a file.
 */
export function unreferencedAssets(files: Map<string, string>): string[] {
  const pages = [...files.entries()]
    .filter(([p]) => /\.html?$/i.test(p))
    .map(([, c]) => c)
    .join("\n");
  if (!pages) return [];
  const dead: string[] = [];
  for (const path of files.keys()) {
    if (!/\.(css|js|mjs)$/i.test(path)) continue;
    const name = path.split("/").pop() ?? path;
    // Quoted in an href/src, or named anywhere in an import — either counts.
    if (pages.includes(name)) continue;
    dead.push(path);
  }
  return dead;
}

// ---------- unified diff (Stage 5 QA input) ----------

function lcsMatrix(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Compact line-based unified diff with a few lines of context. */
export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp = lcsMatrix(a, b);
  type Op = { t: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ t: "-", line: a[i++] });
  while (j < b.length) ops.push({ t: "+", line: b[j++] });

  // keep only hunks around changes, with `context` lines of surrounding context
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== " ") {
      for (let d = -context; d <= context; d++) {
        if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
      }
    }
  }
  const changed = ops.some((o) => o.t !== " ");
  if (!changed) return "";
  let out = `--- ${path}\n+++ ${path}\n`;
  let prevKept = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      prevKept = false;
      continue;
    }
    if (!prevKept && out.indexOf("@@") !== -1) out += "@@\n"; // hunk separator
    else if (!prevKept) out += "@@\n";
    out += `${ops[k].t}${ops[k].line}\n`;
    prevKept = true;
  }
  return out;
}

/** Build the diff bundle for all edited files (Stage 5 input). */
export function buildDiffs(
  original: Map<string, string>,
  edited: Map<string, string>,
): string {
  const parts: string[] = [];
  for (const [path, newContent] of edited) {
    const oldContent = original.get(path) ?? "";
    const d = unifiedDiff(path, oldContent, newContent);
    if (d) parts.push(d);
  }
  return parts.join("\n");
}

// ============================================================
// Deterministic ordering, conflict detection, and apply fallback
//
// Stages 4's prompt asks the model to order fixes by depends_on and to detect
// overlapping edits itself, and to report honestly when a fix did not apply.
// That is three separate things we were trusting a model to get right with no
// verification. The functions below re-derive all three from the data, so the
// model's judgement is checked rather than assumed:
//
//   orderFixes      — topologically sorts by depends_on before the call, so the
//                     model receives them already in a valid order.
//   detectConflicts — finds fixes whose old_code regions overlap in the same
//                     file. These genuinely cannot both apply.
//   reconcileApply  — after the call, verifies each fix actually landed in the
//                     returned file and deterministically applies (via applyFix)
//                     any the model dropped or silently skipped.
// ============================================================

export interface OrderedFixes {
  ordered: ApprovedFix[];
  /** signal_ids involved in a dependency cycle; order among them is arbitrary. */
  cycles: number[];
  /** depends_on entries pointing at a signal_id not in this fix set. */
  danglingDeps: Array<{ signal_id: number; missing: number }>;
}

/**
 * Topologically sort fixes so a fix always follows everything it depends_on.
 * Token/global fixes therefore land before the component fixes that reference
 * their tokens, which is what makes the old_code of the later fix still match.
 *
 * Ties are broken by the fixes' original order, so the result is stable — the
 * same proposals always produce the same edit sequence, which matters because
 * QA diffs the output.
 */
export function orderFixes(fixes: ApprovedFix[]): OrderedFixes {
  const present = new Set(fixes.map((f) => f.signal_id));
  const danglingDeps: Array<{ signal_id: number; missing: number }> = [];

  // index by signal_id; a signal can legitimately have several fixes (different
  // files), so each id maps to a list and the whole group moves together.
  const groups = new Map<number, ApprovedFix[]>();
  const order: number[] = [];
  for (const f of fixes) {
    if (!groups.has(f.signal_id)) {
      groups.set(f.signal_id, []);
      order.push(f.signal_id);
    }
    groups.get(f.signal_id)!.push(f);
  }

  const deps = new Map<number, Set<number>>();
  for (const id of order) {
    const set = new Set<number>();
    for (const f of groups.get(id)!) {
      for (const d of f.depends_on ?? []) {
        if (d === id) continue; // self-dependency is meaningless, not a cycle
        if (!present.has(d)) {
          danglingDeps.push({ signal_id: id, missing: d });
          continue;
        }
        set.add(d);
      }
    }
    deps.set(id, set);
  }

  // Kahn's algorithm, emitting ready nodes in original order for stability.
  const resolved: number[] = [];
  const remaining = new Set(order);
  while (remaining.size > 0) {
    const ready = order.filter(
      (id) => remaining.has(id) && [...deps.get(id)!].every((d) => !remaining.has(d)),
    );
    if (ready.length === 0) break; // everything left is in a cycle
    for (const id of ready) {
      resolved.push(id);
      remaining.delete(id);
    }
  }

  const cycles = order.filter((id) => remaining.has(id));
  // Cycled fixes still get applied — just in their original relative order,
  // after everything that could be ordered properly. Dropping them would
  // silently lose work over what is usually a mislabelled dependency.
  const finalIds = [...resolved, ...cycles];
  return {
    ordered: finalIds.flatMap((id) => groups.get(id)!),
    cycles,
    danglingDeps,
  };
}

export interface FixConflict {
  file: string;
  /** The fix that keeps its edit (earlier in the ordered list). */
  winner: number;
  /** The fix whose region overlaps the winner's and cannot also apply. */
  loser: number;
}

/**
 * Find fixes whose old_code regions overlap within the same file. Two edits to
 * the same bytes cannot both apply, and letting the model "merge" them is how a
 * plausible-looking but wrong edit gets shipped — the spec is explicit that the
 * second one should fail rather than be guessed at.
 *
 * Only exact-match regions are checked; a fix whose old_code isn't a unique
 * verbatim substring is already rejected upstream by validateProposals.
 */
export function detectConflicts(
  fixes: ApprovedFix[],
  files: Map<string, string>,
): FixConflict[] {
  const conflicts: FixConflict[] = [];
  const claimed = new Map<string, Array<{ start: number; end: number; id: number }>>();

  for (const fix of fixes) {
    const content = files.get(fix.file);
    if (content == null) continue;
    const start = content.indexOf(fix.old_code);
    if (start === -1) continue;
    const range = { start, end: start + fix.old_code.length, id: fix.signal_id };

    const existing = claimed.get(fix.file) ?? [];
    for (const other of existing) {
      if (range.start < other.end && other.start < range.end) {
        conflicts.push({ file: fix.file, winner: other.id, loser: range.id });
      }
    }
    existing.push(range);
    claimed.set(fix.file, existing);
  }
  return conflicts;
}

export interface ReconciledFix {
  signal_id: number;
  file: string;
  applied: boolean;
  /** Who actually made the edit. "none" means it could not be applied at all. */
  applied_by: "model" | "deterministic" | "none";
  reason: string | null;
}

export interface ReconcileResult {
  files: Map<string, string>;
  reconciled: ReconciledFix[];
  /**
   * signal_ids the model's own change_log reported as applied=true, but whose
   * old_code is still present in the file it returned. These are the dangerous
   * ones: a silently false self-report that would otherwise ship as "fixed".
   * Empty when no change_log is supplied.
   */
  falseClaims: number[];
}

/**
 * Safety net for Stage 4: verify the model's output against the fixes it was
 * given, and fall back to deterministic application for anything it dropped.
 *
 * The model self-reports `applied` per fix, but a false "pass" there is exactly
 * the failure the QA stage is meant to catch late and expensively. Checking the
 * bytes is cheap and catches it immediately: a fix has landed only if its
 * old_code is gone from the returned file. Anything still present is re-applied
 * with applyFix(), which never approximates — so the fallback either produces
 * the exact approved edit or reports it as unapplied.
 */
export function reconcileApply(
  original: Map<string, string>,
  modelFiles: Map<string, string>,
  fixes: ApprovedFix[],
  /** The model's own change_log, used only to flag false "applied" self-reports. */
  modelChangeLog?: Array<{ signal_id?: number; applied?: boolean }>,
): ReconcileResult {
  const claimedApplied = new Set(
    (modelChangeLog ?? [])
      .filter((c) => c.applied === true && typeof c.signal_id === "number")
      .map((c) => c.signal_id as number),
  );
  const out = new Map(original);
  for (const [path, content] of modelFiles) out.set(path, content);

  const reconciled: ReconciledFix[] = [];
  const falseClaims: number[] = [];

  for (const fix of fixes) {
    const before = original.get(fix.file);
    const current = out.get(fix.file);
    if (current == null || before == null) {
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: false,
        applied_by: "none",
        reason: "file_missing_from_output",
      });
      continue;
    }

    // A fix whose old_code was never in the original file cannot have been
    // applied by anyone — absence from the output proves nothing about it.
    // Explicit approved_fixes come straight from the request body, so this is
    // not guaranteed upstream and has to be checked here.
    if (!before.includes(fix.old_code)) {
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: false,
        applied_by: "none",
        reason: "no_match",
      });
      continue;
    }

    // Given old_code WAS in the original, its absence now means the edit landed.
    if (!current.includes(fix.old_code)) {
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: true,
        applied_by: "model",
        reason: null,
      });
      continue;
    }

    // old_code is still there, but that does not prove the edit is missing:
    // the model may have INSERTED new_code (a JSON-LD block, a skip-link)
    // rather than replacing, which leaves the anchor in place. Re-applying then
    // writes the addition a second time — that is how a real PR ended up with
    // the HairSalon schema and the skip-link duplicated. If new_code was absent
    // from the original and is present now, the model put it there; leave it be.
    if (fix.new_code && !before.includes(fix.new_code) && current.includes(fix.new_code)) {
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: true,
        applied_by: "model",
        reason: null,
      });
      continue;
    }

    // Still there — the model either reported the failure honestly or claimed a
    // success that isn't in the bytes. Either way, try it ourselves.
    if (claimedApplied.has(fix.signal_id)) falseClaims.push(fix.signal_id);
    const result = applyFix(current, fix.old_code, fix.new_code);
    if (result.applied) {
      out.set(fix.file, result.content);
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: true,
        applied_by: "deterministic",
        reason: null,
      });
    } else {
      reconciled.push({
        signal_id: fix.signal_id,
        file: fix.file,
        applied: false,
        applied_by: "none",
        reason: result.reason,
      });
    }
  }

  return { files: out, reconciled, falseClaims };
}


// ---------- stage 1 multi-pass merge ----------

export interface DetectionResult {
  signals?: Array<Record<string, unknown>>;
  site_profile?: unknown;
  meta?: { files_scanned?: number; excluded_files?: string[] };
}

/**
 * Merge a pass's signals into whatever earlier passes already recorded. Keyed
 * by signal id so a re-run of the same pass overwrites rather than duplicates.
 */
export function mergeDetection(
  prior: DetectionResult,
  incoming: DetectionResult,
): DetectionResult {
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const s of prior.signals ?? []) byId.set(s.id, s);
  for (const s of incoming.signals ?? []) byId.set(s.id, s);
  return {
    // site_profile and meta only ever come from the first pass.
    site_profile: prior.site_profile ?? incoming.site_profile,
    meta: prior.meta ?? incoming.meta,
    signals: [...byId.values()].sort(
      (a, b) => Number(a.id ?? 0) - Number(b.id ?? 0),
    ),
  };
}


/**
 * Which page a single-page rebuild should treat as the site.
 *
 * The rebuild writes one file, so the choice decides what the whole run is
 * worth. It used to be the alphabetically first page, which on a real
 * four-page site ("contact, gallery, index, products") meant contact.html
 * every time and the home page never. Two measured rebuilds picked the wrong
 * page that way, and one of them picked a macOS metadata sidecar.
 *
 * Ranked, not filtered: every page stays eligible, so a site with no index.html
 * still gets its most plausible entry point rather than an error. Ties fall
 * back to the alphabetical order this replaces, so the choice is total and
 * repeatable.
 */
const HOME_BASENAMES = ["index", "home", "default", "main"];

export function pickHomePage(paths: Iterable<string>): string | null {
  const pages = [...paths].filter((p) => /\.html?$/i.test(p)).sort();
  if (!pages.length) return null;

  const rank = (path: string): [number, number, number] => {
    const segments = path.split("/");
    const base = (segments.pop() ?? "").replace(/\.html?$/i, "").toLowerCase();
    const named = HOME_BASENAMES.indexOf(base);
    return [
      // A recognised entry-point name beats any other name, whatever the depth:
      // "public/index.html" is the home page and "about.html" is not.
      named === -1 ? 1 : 0,
      // Among those, the shallowest wins — the root index over a nested one.
      segments.length,
      // "index" over "home" over "default" over "main".
      named === -1 ? 0 : named,
    ];
  };

  let best = pages[0];
  let bestRank = rank(best);
  for (const page of pages.slice(1)) {
    const r = rank(page);
    for (let i = 0; i < r.length; i++) {
      if (r[i] === bestRank[i]) continue;
      if (r[i] < bestRank[i]) {
        best = page;
        bestRank = r;
      }
      break;
    }
  }
  return best;
}

// ============================================================
// Which files belong in a scan bundle
// ============================================================

/**
 * A scan should see the site, and only the site.
 *
 * Everything that gets past this ends up in the bundle: it is sent to the
 * model, it is counted in files_scanned, and any signal found in it scores
 * against the user. Real bundles were carrying an archive-extraction artifact
 * (pax_global_header), repo documentation (README.md), and macOS metadata —
 * none of which a browser ever loads.
 *
 * The dotted-segment rule is the one that matters most: it drops .git, .cache,
 * .DS_Store, the "._name" sidecars macOS puts in every zip, and — the reason it
 * is a rule and not a list — .env, which was being read off disk and sent to
 * the model along with whatever was in it.
 *
 * robots.txt is deliberately NOT filtered as a text file; three signals look
 * for it.
 *
 * js/app.js keeps a copy of these rules, because the browser does the same
 * filtering before upload and cannot import from here. Change one, change both.
 */
const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|\.next|\.nuxt|out|vendor|coverage|\.cache|\.vercel|\.turbo|__MACOSX)(\/|$)/;
// Any path segment starting with a dot: config, VCS internals, macOS sidecars,
// and secrets. None of them are the website.
const SKIP_DOTTED = /(^|\/)\./;
// tar/pax writes this pseudo-entry into archives; GitHub tarballs carry it.
const SKIP_ARCHIVE_ARTIFACT = /(^|\/)pax_global_header$/;
// Repo documentation. It ships to GitHub, not to a browser.
const SKIP_DOCS =
  /(\.(md|markdown|mdx|rst)$|(^|\/)(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING)(\.(txt|rst))?$)/i;
const SKIP_FILE =
  /\.(min\.(js|css)|map|lock|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|br|wasm|ds_store)$/i;
const SKIP_LOCKFILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;

/** True if this path should go into the bundle. Accepts "dir/" for directories. */
export function keepPath(path: string): boolean {
  if (SKIP_DIR.test(path)) return false;
  if (SKIP_DOTTED.test(path)) return false;
  if (SKIP_ARCHIVE_ARTIFACT.test(path)) return false;
  if (SKIP_DOCS.test(path)) return false;
  if (SKIP_LOCKFILES.test(path)) return false;
  if (SKIP_FILE.test(path)) return false;
  return true;
}
