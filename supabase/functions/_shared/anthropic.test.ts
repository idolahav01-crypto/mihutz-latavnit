import { assert, assertEquals } from "jsr:@std/assert@1";
import { callClaude, cleanApiKey, parseClaudeJson } from "./anthropic.ts";

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
    temperature: 0.7,
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
  assertEquals(body.temperature, 0.7);
  assertEquals(captured!.headers["x-api-key"], "sk-test");
  assertEquals(captured!.headers["anthropic-version"], "2023-06-01");
  // the fixed prompt is in the cached system array; variable content is in the user turn
  const system = body.system as Array<{ text: string; cache_control: { type: string } }>;
  assertEquals(system[0].text, "FIXED SYSTEM PROMPT");
  assertEquals(system[0].cache_control.type, "ephemeral");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assertEquals(messages[0].content, "variable per-scan content");
  assert(body.output_config !== undefined);
});
