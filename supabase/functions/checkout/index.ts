// Starts a purchase: the browser asks for a quantity, this returns a
// transaction to open a checkout for.
//
// The browser never names a price. It sends how many tokens the customer
// wants and nothing else; the price is worked out here from pricing.ts, and
// the customer's identity comes from their JWT rather than from the request
// body. So the worst a tampered store page can do is order a different
// quantity of tokens, at that quantity's real price, for the account that is
// signed in.
//
// The client token and environment go back with the transaction id on
// purpose. A client token is public by design — it is meant to sit in a web
// page — and returning it here means the store page carries no Paddle
// configuration of its own, so moving from sandbox to live is a change to
// this function's secrets and nothing else.

import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { PriceError, priceCents } from "../_shared/pricing.ts";
import {
  createTransaction,
  PaddleError,
  type PaddleEnv,
} from "../_shared/paddle.ts";

const API_KEY = Deno.env.get("PADDLE_API_KEY") ?? "";
const PRODUCT_ID = Deno.env.get("PADDLE_PRODUCT_ID") ?? "";
const CLIENT_TOKEN = Deno.env.get("PADDLE_CLIENT_TOKEN") ?? "";
const ENV: PaddleEnv = Deno.env.get("PADDLE_ENV") === "production"
  ? "production"
  : "sandbox";
// Where the checkout should be opened. Set per environment so a local build
// does not send a real customer to localhost.
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // A store with no keys is not broken, it is not open yet. Saying which is
  // the difference between the page apologising and the page lying.
  if (!API_KEY || !PRODUCT_ID || !CLIENT_TOKEN) {
    return json({ error: "payments_not_configured" }, 503);
  }

  const admin = adminClient();
  const user = await requireUser(admin, req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let tokens: unknown;
  try {
    tokens = (await req.json())?.tokens;
  } catch {
    return json({ error: "bad request" }, 400);
  }

  let cents: number;
  try {
    cents = priceCents(tokens);
  } catch (e) {
    if (e instanceof PriceError) return json({ error: e.message }, 400);
    throw e;
  }

  const n = tokens as number;
  // he/store/ and store/ are the same page in two languages; opening the
  // checkout over the one the customer is actually on is the whole reason
  // this is read off the request rather than fixed.
  const lang = req.headers.get("x-store-lang") === "he"
    ? "/he/store/"
    : "/store/";
  const base = SITE_URL.replace(/\/+$/, "");

  try {
    const tx = await createTransaction({
      apiKey: API_KEY,
      env: ENV,
      productId: PRODUCT_ID,
      priceCents: cents,
      label: n === 1 ? "1 token" : `${n} tokens`,
      custom: {
        user_id: user.id,
        tokens: String(n),
      },
      checkoutUrl: base ? `${base}${lang}` : undefined,
    });

    return json({
      ok: true,
      transaction_id: tx.transactionId,
      checkout_url: tx.checkoutUrl,
      client_token: CLIENT_TOKEN,
      environment: ENV,
      tokens: n,
      price_cents: cents,
    });
  } catch (e) {
    if (e instanceof PaddleError) {
      console.error("checkout failed:", e.message);
      return json({ error: "checkout_failed" }, 502);
    }
    throw e;
  }
});
