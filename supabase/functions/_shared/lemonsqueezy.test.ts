import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import {
  LemonError,
  readOrderEvent,
  timingSafeEqual,
  verifySignature,
} from "./lemonsqueezy.ts";

const SECRET = "a-signing-secret";

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const USER = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function orderBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    meta: {
      event_name: "order_created",
      custom_data: { user_id: USER, tokens: "50" },
      ...(over.meta as object ?? {}),
    },
    data: {
      id: "1234567",
      attributes: { total: 4200, user_email: "buyer@example.com", status: "paid" },
      ...(over.data as object ?? {}),
    },
  });
}

Deno.test("a body signed with the secret verifies", async () => {
  const body = orderBody();
  assert(await verifySignature(body, await sign(body), SECRET));
});

Deno.test("a body signed with the WRONG secret does not verify", async () => {
  const body = orderBody();
  assertFalse(await verifySignature(body, await sign(body, "not-the-secret"), SECRET));
});

Deno.test("REGRESSION: one changed byte in the body breaks the signature", async () => {
  // The reason the raw bytes are verified before anything is parsed. Re-encode
  // the JSON and this is exactly what happens to an honest request.
  const body = orderBody();
  const sig = await sign(body);
  assertFalse(await verifySignature(body.replace('"tokens":"50"', '"tokens":"500"'), sig, SECRET));
});

Deno.test("a missing or empty signature is refused, not skipped", async () => {
  const body = orderBody();
  assertFalse(await verifySignature(body, null, SECRET));
  assertFalse(await verifySignature(body, "", SECRET));
});

Deno.test("with no secret configured, nothing verifies", async () => {
  // The endpoint would otherwise credit anything that reached it.
  const body = orderBody();
  assertFalse(await verifySignature(body, await sign(body), ""));
});

Deno.test("the signature is accepted whatever case or padding it arrives in", async () => {
  const body = orderBody();
  const sig = await sign(body);
  assert(await verifySignature(body, `  ${sig.toUpperCase()}  `, SECRET));
});

Deno.test("timingSafeEqual compares whole strings, and refuses a short one", () => {
  assert(timingSafeEqual("abc123", "abc123"));
  assertFalse(timingSafeEqual("abc123", "abc124"));
  assertFalse(timingSafeEqual("abc123", "abc"));
  assertFalse(timingSafeEqual("", "a"));
});

Deno.test("readOrderEvent lifts out the fields the credit is made from", () => {
  const e = readOrderEvent(JSON.parse(orderBody()));
  assertEquals(e.eventName, "order_created");
  assertEquals(e.orderId, "1234567");
  assertEquals(e.userId, USER);
  assertEquals(e.tokens, 50);
  assertEquals(e.totalCents, 4200);
  assertEquals(e.email, "buyer@example.com");
  assertEquals(e.status, "paid");
});

Deno.test("a body with no order id is refused — it is the idempotency key", () => {
  const body = JSON.parse(orderBody());
  delete body.data.id;
  assertThrows(() => readOrderEvent(body), LemonError);
});

Deno.test("a user_id that is not a uuid is refused rather than credited", () => {
  for (const bad of ["", "nobody", "'; drop table purchases; --", 42]) {
    const body = JSON.parse(orderBody());
    body.meta.custom_data.user_id = bad;
    assertThrows(() => readOrderEvent(body), LemonError, undefined,
      `readOrderEvent accepted user_id ${String(bad)}`);
  }
});

Deno.test("a token count that is not a whole positive number is refused", () => {
  for (const bad of ["0", "-10", "2.5", "lots", "", null]) {
    const body = JSON.parse(orderBody());
    body.meta.custom_data.tokens = bad;
    assertThrows(() => readOrderEvent(body), LemonError, undefined,
      `readOrderEvent accepted tokens ${String(bad)}`);
  }
});

Deno.test("custom values arrive as strings and are read as numbers", () => {
  // Lemon Squeezy returns checkout custom data as strings, so "50" is the
  // normal case and 50 must not be the only one that works.
  const body = JSON.parse(orderBody());
  body.meta.custom_data.tokens = 50;
  assertEquals(readOrderEvent(body).tokens, 50);
});

Deno.test("a refund event is readable too, so it can be recorded", () => {
  const body = JSON.parse(orderBody());
  body.meta.event_name = "order_refunded";
  const e = readOrderEvent(body);
  assertEquals(e.eventName, "order_refunded");
  assertEquals(e.orderId, "1234567");
});
