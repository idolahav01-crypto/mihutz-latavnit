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

export const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeCallOptions {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** The fixed, cacheable system prompt (signal list / schema description). */
  system: string;
  /** The variable per-scan payload (profile, signals, code, diffs). */
  userContent: string;
  /** Optional structured-output JSON schema. */
  schema?: unknown;
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

/** Build the exact request body sent to the Messages API. Exported for tests. */
export function buildClaudeRequestBody(opts: ClaudeCallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
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
  if (opts.schema !== undefined) {
    body.output_config = { format: { type: "json_schema", schema: opts.schema } };
  }
  return body;
}

/** Pull the first text block out of a Messages API response and JSON-parse it. */
export function parseClaudeJson(data: {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}): unknown {
  if (data?.stop_reason === "refusal") throw new Error("model_refused");
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

export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? Deno.env.get("ANTHROPIC_BASE_URL") ??
    "https://api.anthropic.com").replace(/\/$/, "");

  const res = await doFetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildClaudeRequestBody(opts)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${text}`);
  }
  const data = await res.json();
  return {
    json: parseClaudeJson(data),
    usage: (data?.usage ?? {}) as ClaudeUsage,
    raw: data,
  };
}
