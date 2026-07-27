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
  maxBytesPerFile = 12_000,
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
    const isStrategic = p.fix_type === "strategic" || p.needs_human_decision === true ||
      p.old_code == null || p.old_code === "";
    if (isStrategic) {
      return { ...p, old_code_verbatim: false, applicable_edit: false };
    }
    const content = p.file ? files.get(p.file) : undefined;
    const verbatim = content != null && isVerbatimUnique(content, String(p.old_code));
    return { ...p, old_code_verbatim: verbatim, applicable_edit: verbatim };
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
export function assembleFinalFiles(
  original: Map<string, string>,
  edited: Map<string, string>,
): Map<string, string> {
  const out = new Map(original);
  for (const [path, content] of edited) out.set(path, content);
  return out;
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
