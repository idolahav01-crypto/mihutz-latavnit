import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  accumulateStream,
  buildClaudeRequestBody,
  callClaude,
  cleanApiKey,
  parseClaudeJson,
  sanitizeSchema,
  shouldStream,
} from "./anthropic.ts";

Deno.test("cleanApiKey trims and rejects empty / non-latin1", () => {
  assertEquals(cleanApiKey("  sk-abc\n"), "sk-abc");
  let threw = false;
  try {
    cleanApiKey("");
  } catch {
    threw = true;
  }
  assert(threw);
  threw = false;
  try {
    cleanApiKey("sk-\u2028bad");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("parseClaudeJson extracts the text block and throws on refusal", () => {
  const parsed = parseClaudeJson({ content: [{ type: "text", text: '{"pass":true}' }] }) as { pass: boolean };
  assertEquals(parsed.pass, true);
  let threw = false;
  try {
    parseClaudeJson({ stop_reason: "refusal", content: [] });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("callClaude posts a real request with cache_control on system + correct headers", async () => {
  // Spin up a local stand-in for api.anthropic.com and capture what we send.
  let captured: { headers: Record<string, string>; body: unknown } | null = null;
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    captured = {
      headers: Object.fromEntries(req.headers.entries()),
      body: await req.json(),
    };
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: '{"design_direction":{},"proposals":[]}' }],
        usage: { cache_read_input_tokens: 123 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const { port } = server.addr as Deno.NetAddr;

  const res = await callClaude({
    apiKey: "sk-test",
    model: "claude-opus-4-8",
    effort: "high",
    maxTokens: 16000,
    system: "FIXED SYSTEM PROMPT",
    userContent: "variable per-scan content",
    schema: { type: "object" },
    baseUrl: `http://127.0.0.1:${port}`,
  });

  ac.abort();
  await server.finished;

  // response parsed + usage surfaced (for cache-hit tracking)
  assertEquals((res.json as { proposals: unknown[] }).proposals.length, 0);
  assertEquals(res.usage.cache_read_input_tokens, 123);

  const body = captured!.body as Record<string, unknown>;
  assertEquals(body.model, "claude-opus-4-8");
  // temperature/top_p/top_k were removed on opus-4-8 and return 400. The one
  // thing this test most needs to guarantee is that we never send them.
  assertEquals(body.temperature, undefined);
  assertEquals(body.top_p, undefined);
  assertEquals(body.top_k, undefined);
  assertEquals(captured!.headers["x-api-key"], "sk-test");
  assertEquals(captured!.headers["anthropic-version"], "2023-06-01");
  // the fixed prompt is in the cached system array; variable content is in the user turn
  const system = body.system as Array<{ text: string; cache_control: { type: string } }>;
  assertEquals(system[0].text, "FIXED SYSTEM PROMPT");
  assertEquals(system[0].cache_control.type, "ephemeral");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assertEquals(messages[0].content, "variable per-scan content");
  // effort and format share ONE output_config object — two keys would clobber.
  const oc = body.output_config as Record<string, unknown>;
  assertEquals(oc.effort, "high");
  assertEquals((oc.format as { type: string }).type, "json_schema");
  // 16000 is at the threshold, not above it, so this one does not stream.
  assertEquals(body.stream, undefined);
});

Deno.test("sanitizeSchema rewrites union types as anyOf (structured outputs rejects unions)", () => {
  const out = sanitizeSchema({
    type: "object",
    properties: {
      a: { type: ["string", "null"] },
      b: { type: ["integer", "null"] },
      keep: { type: "string", enum: ["x", "y"] },
    },
  }) as Record<string, Record<string, Record<string, unknown>>>;

  assertEquals(out.properties.a.type, undefined);
  assertEquals(out.properties.a.anyOf, [{ type: "string" }, { type: "null" }]);
  assertEquals(out.properties.b.anyOf, [{ type: "integer" }, { type: "null" }]);
  // untouched branches survive verbatim, enum included
  assertEquals(out.properties.keep, { type: "string", enum: ["x", "y"] });
});

Deno.test("sanitizeSchema carries sibling keywords onto the non-null branch", () => {
  const out = sanitizeSchema({ type: ["string", "null"], enum: ["a", "b"] }) as Record<string, unknown>;
  assertEquals(out.anyOf, [{ type: "string", enum: ["a", "b"] }, { type: "null" }]);
});

Deno.test("the real pipeline schemas contain no union types after sanitizing", async () => {
  const { DESIGN_SCHEMA, APPLY_SCHEMA, QA_SCHEMA } = await import("./stages.ts");
  for (const schema of [DESIGN_SCHEMA, APPLY_SCHEMA, QA_SCHEMA]) {
    const json = JSON.stringify(sanitizeSchema(schema));
    // `"type":[` is the only shape structured outputs rejects here.
    assertFalse(json.includes('"type":['));
    // ...and the originals really did have some, so this test can fail.
    assert(JSON.stringify(schema).includes('"type":['));
  }
});

Deno.test("requests above the streaming threshold set stream:true", () => {
  assertFalse(shouldStream({ maxTokens: 16000 }));
  assert(shouldStream({ maxTokens: 32000 }));
  assert(shouldStream({ maxTokens: 1000, stream: true }));
  const body = buildClaudeRequestBody({
    apiKey: "k", model: "claude-opus-4-8", effort: "high", maxTokens: 32000,
    system: "s", userContent: "u",
  });
  assertEquals(body.stream, true);
});

Deno.test("accumulateStream reassembles SSE into a non-streaming-shaped response", () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":99}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"pass\\":"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"true}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    "data: [DONE]",
  ].join("\n");
  const acc = accumulateStream(sse);
  assertEquals(acc.stop_reason, "end_turn");
  assertEquals(acc.usage.cache_read_input_tokens, 99);
  assertEquals(acc.usage.output_tokens, 7);
  assertEquals((parseClaudeJson(acc) as { pass: boolean }).pass, true);
});

Deno.test("callClaude streams a 32k-token request end to end", async () => {
  const ac = new AbortController();
  let sawStream: unknown = "unset";
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    sawStream = (await req.json()).stream;
    const sse = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"files\\":[]}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      "",
    ].join("\n");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  const { port } = server.addr as Deno.NetAddr;

  const res = await callClaude({
    apiKey: "sk-test", model: "claude-opus-4-8", effort: "high",
    maxTokens: 32000, system: "S", userContent: "U",
    baseUrl: `http://127.0.0.1:${port}`,
  });
  ac.abort();
  await server.finished;

  assertEquals(sawStream, true);
  assertEquals((res.json as { files: unknown[] }).files, []);
  assertEquals(res.usage.output_tokens, 4);
});

Deno.test("callClaude surfaces a named stage_timeout instead of hanging past the 150s edge cap", async () => {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, async () => {
    await new Promise((r) => setTimeout(r, 5000));
    return new Response("{}");
  });
  const { port } = server.addr as Deno.NetAddr;

  let msg = "";
  try {
    await callClaude({
      apiKey: "sk-test", model: "claude-opus-4-8", effort: "high",
      maxTokens: 1000, system: "S", userContent: "U",
      timeoutMs: 80, baseUrl: `http://127.0.0.1:${port}`,
    });
  } catch (e) {
    msg = (e as Error).message;
  }
  ac.abort();
  await server.finished.catch(() => {});
  assert(msg.startsWith("stage_timeout_after_"), msg);
});

Deno.test("parseClaudeJson flags a max_tokens truncation rather than returning junk", () => {
  let threw = "";
  try {
    parseClaudeJson({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"files":' }] });
  } catch (e) {
    threw = (e as Error).message;
  }
  assertEquals(threw, "max_tokens_truncated");
});
