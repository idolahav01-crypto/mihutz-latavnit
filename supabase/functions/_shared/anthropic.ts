// Shared Anthropic client for every pipeline stage.
//
// The single most important rule from pipeline-models-and-implementation.md §4-5:
// the FIXED block (system prompt = signal list / schema) goes in the `system`
// array with `cache_control: { type: "ephemeral" }`, and the VARIABLE per-scan
// content goes in the user message. Prompt caching only works when the cached
// bytes are identical across calls, so the system prompt must never change.
//
// `fetchImpl` and `baseUrl` are injectable purely so the pipeline can be tested
// without a live API key (a local mock captures the outgoing request); in
// production both default to the real global fetch and api.anthropic.com.
//
// API-CONTRACT NOTES for claude-opus-4-8 (verified against the current Messages
// API — these are the three things that made every earlier version of this file
// fail on a real call, while passing the deterministic tests):
//
//   1. `temperature` / `top_p` / `top_k` were REMOVED on this model. Sending any
//      of them returns 400. Thinking depth and overall token spend are now
//      controlled by `output_config.effort` instead. `detect/` already used
//      effort; the pipeline stages did not.
//   2. Structured output goes in `output_config.format` — the SAME object as
//      `effort`, not a sibling. Two separate `output_config` keys would clobber
//      each other.
//   3. The supported JSON-Schema subset does NOT include union type arrays
//      (`type: ["string", "null"]`). `anyOf` IS supported, so `sanitizeSchema`
//      below rewrites unions into `anyOf` before the request goes out.
//
// Plus: non-streaming requests above ~16k max_tokens hit HTTP idle timeouts, so
// anything larger streams and re-assembles. See `callClaude`.

export const ANTHROPIC_VERSION = "2023-06-01";

/** Effort levels accepted by `output_config.effort` on Opus 4.7+ / Sonnet 5. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Above this many max_tokens a non-streaming request risks an idle-connection
 * timeout before the first byte arrives. Stream instead.
 */
export const STREAM_THRESHOLD_TOKENS = 16000;

/**
 * Supabase Edge Functions are hard-killed at ~150s. Abort a little before that
 * so the caller gets an actionable `stage_timeout` instead of an opaque 546.
 */
export const DEFAULT_TIMEOUT_MS = 135_000;

export interface ClaudeCallOptions {
  apiKey: string;
  model: string;
  /**
   * Replaces the removed `temperature` knob. Higher effort = deeper thinking and
   * more tokens. `high` is the recommended minimum for intelligence-sensitive
   * work; `xhigh` is best for coding but is often too slow for a 150s function.
   */
  effort: Effort;
  maxTokens: number;
  /** The fixed, cacheable system prompt (signal list / schema description). */
  system: string;
  /** The variable per-scan payload (profile, signals, code, diffs). */
  userContent: string;
  /** Optional structured-output JSON schema. */
  schema?: unknown;
  /**
   * Adaptive thinking. Off by default: on Opus 4.8 omitting `thinking` runs
   * without it, which is what keeps these calls inside the edge-function budget.
   * Turn it on per-stage where the quality is worth the latency.
   */
  thinking?: boolean;
  /** Wall-clock budget for the whole call. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Force streaming on/off. Defaults to `maxTokens > STREAM_THRESHOLD_TOKENS`. */
  stream?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResult {
  /** Parsed JSON from the model's single text block. */
  json: unknown;
  usage: ClaudeUsage;
  raw: unknown;
}

// Secrets pasted through a dashboard often carry a trailing newline/space, which
// makes fetch() reject the header as a non-ByteString. Clean + validate here so
// every stage fails with the same, actionable error (mirrors detect/index.ts).
export function cleanApiKey(raw: string | undefined | null): string {
  const key = (raw ?? "").trim();
  if (!key) throw new Error("missing_anthropic_api_key");
  if (!/^[\x20-\x7E]+$/.test(key)) {
    throw new Error("invalid_anthropic_api_key_characters");
  }
  return key;
}

/**
 * Rewrite the parts of a JSON Schema that structured outputs rejects.
 *
 * Only one rewrite is needed today: `type: ["string", "null"]` becomes
 * `anyOf: [{type: "string"}, {type: "null"}]`, carrying any sibling keywords
 * (enum, items, ...) onto the non-null branch so the constraint survives.
 * Exported for tests.
 */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = sanitizeSchema(v);

  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    const { ...siblings } = out;
    for (const k of Object.keys(out)) delete out[k];
    out.anyOf = types.map((t) =>
      t === "null" ? { type: "null" } : { type: t, ...siblings }
    );
  }
  return out;
}

/** Build the exact request body sent to the Messages API. Exported for tests. */
export function buildClaudeRequestBody(opts: ClaudeCallOptions): Record<string, unknown> {
  // NOTE: no `temperature` — it is a 400 on this model family.
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    // The cached, fixed prefix — identical bytes on every call.
    system: [
      {
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: opts.userContent },
    ],
  };

  // effort and format share one output_config object.
  const outputConfig: Record<string, unknown> = { effort: opts.effort };
  if (opts.schema !== undefined) {
    outputConfig.format = { type: "json_schema", schema: sanitizeSchema(opts.schema) };
  }
  body.output_config = outputConfig;

  if (opts.thinking) body.thinking = { type: "adaptive" };
  if (shouldStream(opts)) body.stream = true;
  return body;
}

export function shouldStream(
  opts: Pick<ClaudeCallOptions, "stream" | "maxTokens" | "thinking">,
): boolean {
  // Thinking is the other way to hit an idle timeout: the model can reason for
  // a long time before emitting its first output byte, and a non-streaming
  // connection just sits there. Stream whenever thinking is on, regardless of
  // max_tokens — stage 2 sits exactly ON the token threshold, so it would
  // otherwise take the non-streaming path with adaptive thinking enabled.
  return opts.stream ?? (opts.maxTokens > STREAM_THRESHOLD_TOKENS || opts.thinking === true);
}

/** Pull the first text block out of a Messages API response and JSON-parse it. */
export function parseClaudeJson(data: {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}): unknown {
  if (data?.stop_reason === "refusal") throw new Error("model_refused");
  if (data?.stop_reason === "max_tokens") throw new Error("max_tokens_truncated");
  const textBlock = (data?.content ?? []).find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("no_text_block_in_response");
  }
  try {
    return JSON.parse(textBlock.text);
  } catch {
    throw new Error("model_returned_malformed_json");
  }
}

/**
 * Re-assemble a Messages API SSE stream into the same shape a non-streaming
 * response would have had, so `parseClaudeJson` works either way.
 * Exported for tests.
 */
export function accumulateStream(rawSse: string): {
  stop_reason?: string;
  content: Array<{ type: string; text: string }>;
  usage: ClaudeUsage;
} {
  const blocks: Array<{ type: string; text: string }> = [];
  let stopReason: string | undefined;
  let usage: ClaudeUsage = {};

  for (const line of rawSse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "message_start": {
        const msg = ev.message as { usage?: ClaudeUsage } | undefined;
        if (msg?.usage) usage = { ...usage, ...msg.usage };
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block as { type: string; text?: string };
        blocks[ev.index as number] = { type: cb.type, text: cb.text ?? "" };
        break;
      }
      case "content_block_delta": {
        const delta = ev.delta as { type: string; text?: string };
        const target = blocks[ev.index as number];
        if (target && delta.type === "text_delta") target.text += delta.text ?? "";
        break;
      }
      case "message_delta": {
        const delta = ev.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        if (ev.usage) usage = { ...usage, ...(ev.usage as ClaudeUsage) };
        break;
      }
    }
  }
  return { stop_reason: stopReason, content: blocks.filter(Boolean), usage };
}

export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? Deno.env.get("ANTHROPIC_BASE_URL") ??
    "https://api.anthropic.com").replace(/\/$/, "");

  const streaming = shouldStream(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let res: Response;
  try {
    res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildClaudeRequestBody(opts)),
    });
  } catch (e) {
    clearTimeout(timer);
    if (abort.signal.aborted) {
      // Surfaced to the client so it can retry with a smaller scope rather than
      // seeing a generic edge-function 546.
      throw new Error(`stage_timeout_after_${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }

  try {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${text}`);
    }

    if (streaming) {
      const sse = await res.text();
      const acc = accumulateStream(sse);
      return { json: parseClaudeJson(acc), usage: acc.usage, raw: acc };
    }

    const data = await res.json();
    return {
      json: parseClaudeJson(data),
      usage: (data?.usage ?? {}) as ClaudeUsage,
      raw: data,
    };
  } catch (e) {
    if (abort.signal.aborted) {
      throw new Error(`stage_timeout_after_${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
