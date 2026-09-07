import {
  assert,
  assertEquals,
  assertFalse,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  apiBase,
  DEFAULT_TOLERANCE_SECONDS,
  PaddleError,
  parseSignatureHeader,
  readEvent,
  timingSafeEqual,
  verifySignature,
} from "./paddle.ts";

const SECRET = "pdl_ntfset_a-signing-secret";
const NOW = 1_760_000_000;
const USER = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const TXN = "txn_01h04vsbhqc62t8hmd4z3b578c";

async function hmacHex(payload: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A header the way Paddle builds one: HMAC over `<ts>:<rawBody>`. */
async function signHeader(
  body: string,
  ts = NOW,
  secret = SECRET,
): Promise<string> {
  return `ts=${ts};h1=${await hmacHex(`${ts}:${body}`, secret)}`;
}

function txnBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: TXN,
      status: "completed",
      custom_data: { user_id: USER, tokens: "50" },
      details: { totals: { grand_total: "4200", total: "4200" } },
      ...(over as object),
    },
  });
}

Deno.test("sandbox and live are different hosts, and never guessed", () => {
  assertEquals(apiBase("sandbox"), "https://sandbox-api.paddle.com");
  assertEquals(apiBase("production"), "https://api.paddle.com");
});

// ---------- the signature header ----------

Deno.test("parseSignatureHeader reads Paddle's ts=...;h1=... shape", () => {
  const p = parseSignatureHeader(`ts=${NOW};h1=abcdef0123456789`);
  assertEquals(p, { ts: String(NOW), h1: "abcdef0123456789" });
});

Deno.test("a header in the other order, or with spaces, still reads", () => {
  const p = parseSignatureHeader(` h1=ABCDEF ; ts=${NOW} `);
  assertEquals(p, { ts: String(NOW), h1: "abcdef" });
});

Deno.test("a malformed header is refused rather than half-read", () => {
  for (
    const bad of [
      null,
      "",
      "nonsense",
      "ts=;h1=abc",
      `ts=${NOW}`,
      "h1=abc",
      `ts=not-a-number;h1=abc`,
      `ts=${NOW};h1=nothexatall!!`,
    ]
  ) {
    assertEquals(
      parseSignatureHeader(bad),
      null,
      `parseSignatureHeader accepted ${String(bad)}`,
    );
  }
});

// ---------- verification ----------

Deno.test("a body signed with the secret verifies", async () => {
  const body = txnBody();
  assert(
    await verifySignature(
      body,
      await signHeader(body),
      SECRET,
      DEFAULT_TOLERANCE_SECONDS,
      NOW,
    ),
  );
});

Deno.test("a body signed with the WRONG secret does not verify", async () => {
  const body = txnBody();
  const header = await signHeader(body, NOW, "pdl_ntfset_not-the-secret");
  assertFalse(
    await verifySignature(body, header, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW),
  );
});

Deno.test("REGRESSION: the signature covers the timestamp, not just the body", async () => {
  // Signed at NOW, replayed with the clock moved on. Signing `ts:body` rather
  // than `body` is what makes the header's own timestamp unforgeable — swap
  // it and the HMAC no longer matches.
  const body = txnBody();
  const header = await signHeader(body, NOW);
  const moved = header.replace(`ts=${NOW}`, `ts=${NOW + 10}`);
  assertFalse(
    await verifySignature(body, moved, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW + 10),
  );
});

Deno.test("REGRESSION: one changed byte in the body breaks the signature", async () => {
  // The reason the raw bytes are verified before anything is parsed.
  // Re-encoding the JSON is exactly what does this to an honest request.
  const body = txnBody();
  const header = await signHeader(body);
  const tampered = body.replace('"tokens":"50"', '"tokens":"500"');
  assertFalse(
    await verifySignature(
      tampered,
      header,
      SECRET,
      DEFAULT_TOLERANCE_SECONDS,
      NOW,
    ),
  );
});

Deno.test("a correctly signed body goes stale, so a captured one cannot be replayed forever", async () => {
  const body = txnBody();
  const header = await signHeader(body, NOW);
  // inside the window
  assert(await verifySignature(body, header, SECRET, 300, NOW + 299));
  // outside it
  assertFalse(await verifySignature(body, header, SECRET, 300, NOW + 301));
});

Deno.test("clock skew is allowed to run either way", async () => {
  // Our clock being ahead of Paddle's is as likely as being behind, and a
  // future timestamp is not evidence of an attack.
  const body = txnBody();
  const header = await signHeader(body, NOW);
  assert(await verifySignature(body, header, SECRET, 300, NOW - 299));
  assertFalse(await verifySignature(body, header, SECRET, 300, NOW - 301));
});

Deno.test("a missing signature is refused, not skipped", async () => {
  const body = txnBody();
  assertFalse(await verifySignature(body, null, SECRET, 300, NOW));
  assertFalse(await verifySignature(body, "", SECRET, 300, NOW));
});

Deno.test("with no secret configured, nothing verifies", async () => {
  // The endpoint would otherwise credit anything that reached it.
  const body = txnBody();
  const header = await signHeader(body);
  assertFalse(await verifySignature(body, header, "", 300, NOW));
});

Deno.test("timingSafeEqual compares whole strings, and refuses a short one", () => {
  assert(timingSafeEqual("abc123", "abc123"));
  assertFalse(timingSafeEqual("abc123", "abc124"));
  assertFalse(timingSafeEqual("abc123", "abc"));
  assertFalse(timingSafeEqual("", "a"));
});

// ---------- reading the event ----------

Deno.test("readEvent lifts out the fields the credit is made from", () => {
  const e = readEvent(JSON.parse(txnBody()));
  assertEquals(e.eventType, "transaction.completed");
  assertEquals(e.transactionId, TXN);
  assertEquals(e.userId, USER);
  assertEquals(e.tokens, 50);
  assertEquals(e.totalCents, 4200);
  assertEquals(e.status, "completed");
});

Deno.test("a refund names the transaction it adjusts, not its own id", () => {
  // An adjustment is a separate entity with its own adj_ id. Reading that as
  // the purchase reference would fail to find the purchase it refunds.
  const e = readEvent({
    event_type: "adjustment.created",
    data: {
      id: "adj_01h8blahblahblahblahblahbl",
      action: "refund",
      transaction_id: TXN,
      custom_data: { user_id: USER, tokens: "50" },
    },
  });
  assertEquals(e.transactionId, TXN);
});

Deno.test("a body with no transaction id is refused — it is the idempotency key", () => {
  const body = JSON.parse(txnBody());
  delete body.data.id;
  assertThrows(() => readEvent(body), PaddleError);
});

Deno.test("a user_id that is not a uuid is refused rather than credited", () => {
  for (const bad of ["", "nobody", "'; drop table purchases; --", 42]) {
    const body = JSON.parse(txnBody());
    body.data.custom_data.user_id = bad;
    assertThrows(
      () => readEvent(body),
      PaddleError,
      undefined,
      `readEvent accepted user_id ${String(bad)}`,
    );
  }
});

Deno.test("a token count that is not a whole positive number is refused", () => {
  for (const bad of ["0", "-10", "2.5", "lots", "", null]) {
    const body = JSON.parse(txnBody());
    body.data.custom_data.tokens = bad;
    assertThrows(
      () => readEvent(body),
      PaddleError,
      undefined,
      `readEvent accepted tokens ${String(bad)}`,
    );
  }
});

Deno.test("an event carrying none of our custom data is refused, not credited", () => {
  // Every event on the account reaches the endpoint, including customer and
  // address events that were never ours. They must not look creditable.
  assertThrows(
    () =>
      readEvent({
        event_type: "customer.created",
        data: { id: "ctm_01grnn4zta5a1mf02jjze7y2ys" },
      }),
    PaddleError,
  );
});

Deno.test("custom values arrive as strings and are read as numbers", () => {
  const body = JSON.parse(txnBody());
  body.data.custom_data.tokens = 50;
  assertEquals(readEvent(body).tokens, 50);
});

Deno.test("the amount recorded is what the customer was asked for", () => {
  // grand_total is the figure due; `total` is before credits. When they
  // differ, the one that reflects the charge is the one worth storing.
  const body = JSON.parse(txnBody());
  body.data.details.totals = { total: "5000", grand_total: "4200" };
  assertEquals(readEvent(body).totalCents, 4200);
});

Deno.test("a transaction with no totals reads as zero rather than throwing", () => {
  // transaction.created fires before any money is calculated. It is ignored
  // by the handler, but it must not blow up on the way to being ignored.
  const body = JSON.parse(txnBody());
  delete body.data.details;
  assertEquals(readEvent(body).totalCents, 0);
});
