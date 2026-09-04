// The only place a customer's balance goes up because money moved.
//
// This runs with no JWT — Lemon Squeezy is calling, not a browser — so deploy
// it with --no-verify-jwt. Everything that makes that safe is in this file:
//
//   * the signature is checked over the raw bytes before anything is parsed,
//     and a body that fails the check is answered 401 and forgotten;
//   * the credit is applied by credit_tokens(), which is keyed on Lemon
//     Squeezy's order id, so a retried delivery credits nothing the second
//     time. Lemon Squeezy retries on any non-2xx, and it is normal for one
//     payment to arrive here more than once.
//
// A 200 means "we have this and will not need it again". Anything we could not
// finish returns non-2xx on purpose, so the provider tries again later.

import { cors } from "../_shared/http.ts";
import {
  LemonError,
  readOrderEvent,
  verifySignature,
} from "../_shared/lemonsqueezy.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET") ?? "";

/** Plain text, not JSON: nothing on the other end reads a body, and an error
 *  string in the provider's delivery log is worth more than a JSON envelope. */
function reply(body: string, status = 200) {
  return new Response(body, { status, headers: { ...cors, "content-type": "text/plain" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply("method not allowed", 405);

  // Without a secret this endpoint would credit anything that reached it. It
  // refuses to run at all rather than run unprotected.
  if (!SECRET) {
    console.error("LEMONSQUEEZY_WEBHOOK_SECRET is not set — refusing the delivery");
    return reply("not configured", 503);
  }

  const raw = await req.text();
  const ok = await verifySignature(raw, req.headers.get("X-Signature"), SECRET);
  if (!ok) {
    console.warn("webhook signature did not verify — ignored");
    return reply("bad signature", 401);
  }

  let event;
  try {
    event = readOrderEvent(JSON.parse(raw));
  } catch (e) {
    // Signed, so it really is from Lemon Squeezy — but shaped in a way we
    // cannot act on. 200, because retrying will not change the shape, and a
    // loud log so the mismatch is found by reading logs rather than by a
    // customer who paid and got nothing.
    console.error("signed webhook we could not read:", (e as Error).message, raw.slice(0, 500));
    return reply("unreadable", e instanceof LemonError && e.status === 400 ? 200 : 500);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // A refund is recorded, not reversed. By the time one arrives the tokens may
  // already be spent, and an automatic clawback would either hit the wallet's
  // check(balance >= 0) or strand a customer mid-build. It surfaces on the
  // admin desk and a person decides — see 0014_purchases.sql.
  if (event.eventName === "order_refunded") {
    const { error } = await admin.rpc("mark_purchase_refunded", {
      provider_ref: event.orderId,
    });
    if (error) {
      console.error(`marking order ${event.orderId} refunded failed:`, error.message);
      return reply("could not record refund", 500);
    }
    console.log(`order ${event.orderId} refunded — recorded, balance left alone`);
    return reply("refund recorded");
  }

  // Every event on the store arrives here. Only a completed order moves money.
  if (event.eventName !== "order_created") {
    console.log(`ignoring ${event.eventName} for order ${event.orderId}`);
    return reply("ignored");
  }
  if (event.status && event.status !== "paid") {
    console.log(`order ${event.orderId} is "${event.status}", not paid — nothing credited`);
    return reply("not paid");
  }

  const { data, error } = await admin.rpc("credit_tokens", {
    target: event.userId,
    amount: event.tokens,
    provider_ref: event.orderId,
    gross_cents: event.totalCents,
  });

  if (error) {
    // Non-2xx on purpose: the customer has paid, and the provider retrying is
    // the mechanism that eventually gets them their tokens.
    console.error(`credit_tokens failed for order ${event.orderId}:`, error.message);
    return reply("could not credit", 500);
  }

  console.log(`order ${event.orderId}: +${event.tokens} to ${event.userId}, balance now ${data}`);
  return reply("ok");
});
