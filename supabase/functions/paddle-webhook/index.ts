// The only place a customer's balance goes up because money moved.
//
// This runs with no JWT — Paddle is calling, not a browser — so deploy it
// with --no-verify-jwt. Everything that makes that safe is in this file:
//
//   * the signature is checked over the raw bytes before anything is parsed,
//     and a body that fails the check is answered 401 and forgotten;
//   * the credit is applied by credit_tokens(), which is keyed on Paddle's
//     transaction id, so a retried delivery credits nothing the second time.
//     Paddle retries on any non-2xx, and it is normal for one payment to
//     arrive here more than once.
//
// A 200 means "we have this and will not need it again". Anything we could
// not finish returns non-2xx on purpose, so Paddle tries again later.

import { cors } from "../_shared/http.ts";
import { PaddleError, readEvent, verifySignature } from "../_shared/paddle.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET") ?? "";

/** Plain text, not JSON: nothing on the other end reads a body, and an error
 *  string in Paddle's delivery log is worth more than a JSON envelope. */
function reply(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...cors, "content-type": "text/plain" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply("method not allowed", 405);

  // Without a secret this endpoint would credit anything that reached it. It
  // refuses to run at all rather than run unprotected.
  if (!SECRET) {
    console.error("PADDLE_WEBHOOK_SECRET is not set — refusing the delivery");
    return reply("not configured", 503);
  }

  const raw = await req.text();
  const ok = await verifySignature(raw, req.headers.get("Paddle-Signature"), SECRET);
  if (!ok) {
    console.warn("webhook signature did not verify — ignored");
    return reply("bad signature", 401);
  }

  let event;
  try {
    event = readEvent(JSON.parse(raw));
  } catch (e) {
    // Signed, so it really is from Paddle — but shaped in a way we cannot act
    // on. Most of the time that is simply an event carrying no custom_data of
    // ours (a customer or address event), which is not a fault and must not
    // be retried. 200, and a loud log so a real mismatch is found by reading
    // logs rather than by a customer who paid and got nothing.
    console.error(
      "signed webhook we could not read:",
      (e as Error).message,
      raw.slice(0, 500),
    );
    return reply("unreadable", 200);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // A refund is recorded, not reversed. By the time one arrives the tokens
  // may already be spent, and an automatic clawback would either hit the
  // wallet's check(balance >= 0) or strand a customer mid-build. It surfaces
  // on the admin desk and a person decides — see 0014_purchases.sql.
  if (event.eventType === "adjustment.created") {
    const { error } = await admin.rpc("mark_purchase_refunded", {
      provider_ref: event.transactionId,
    });
    if (error) {
      console.error(
        `marking ${event.transactionId} refunded failed:`,
        error.message,
      );
      return reply("could not record refund", 500);
    }
    console.log(
      `${event.transactionId} adjusted — recorded, balance left alone`,
    );
    return reply("adjustment recorded");
  }

  // Every event on the account arrives here. Only a completed transaction
  // moves money: transaction.created and .ready fire before payment, and
  // crediting on those would hand out tokens for a checkout nobody paid.
  if (event.eventType !== "transaction.completed") {
    console.log(`ignoring ${event.eventType} for ${event.transactionId}`);
    return reply("ignored");
  }
  if (event.status && event.status !== "completed" && event.status !== "paid") {
    console.log(
      `${event.transactionId} is "${event.status}", not paid — nothing credited`,
    );
    return reply("not paid");
  }

  const { data, error } = await admin.rpc("credit_tokens", {
    target: event.userId,
    amount: event.tokens,
    provider_ref: event.transactionId,
    gross_cents: event.totalCents,
    provider: "paddle",
  });

  if (error) {
    // Non-2xx on purpose: the customer has paid, and Paddle retrying is the
    // mechanism that eventually gets them their tokens.
    console.error(
      `credit_tokens failed for ${event.transactionId}:`,
      error.message,
    );
    return reply("could not credit", 500);
  }

  console.log(
    `${event.transactionId}: +${event.tokens} to ${event.userId}, balance now ${data}`,
  );
  return reply("ok");
});
