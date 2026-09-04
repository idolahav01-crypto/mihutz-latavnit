// Starts a purchase: the browser asks for a quantity, this returns a URL.
//
// The browser never names a price. It sends how many tokens the customer wants
// and nothing else; the price is worked out here from pricing.ts, and the
// customer's identity comes from their JWT rather than from the request body.
// So the worst a tampered store page can do is order a different quantity of
// tokens, at that quantity's real price, for the account that is signed in.

import { adminClient, cors, json, requireUser } from "../_shared/http.ts";
import { PriceError, priceCents } from "../_shared/pricing.ts";
import { createCheckout, LemonError } from "../_shared/lemonsqueezy.ts";

const API_KEY = Deno.env.get("LEMONSQUEEZY_API_KEY") ?? "";
const STORE_ID = Deno.env.get("LEMONSQUEEZY_STORE_ID") ?? "";
const VARIANT_ID = Deno.env.get("LEMONSQUEEZY_VARIANT_ID") ?? "";
// Where the customer lands after paying. Set per environment so a local build
// does not send a real customer to localhost.
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // A store with no keys is not broken, it is not open yet. Saying which is
  // the difference between the page apologising and the page lying.
  if (!API_KEY || !STORE_ID || !VARIANT_ID) {
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

  // he/store/ and store/ are the same page in two languages; sending the
  // customer back to the one they left from is the whole reason this is read
  // off the request rather than fixed.
  const lang = req.headers.get("x-store-lang") === "he" ? "/he/store/" : "/store/";
  const base = SITE_URL.replace(/\/+$/, "");

  try {
    const url = await createCheckout({
      apiKey: API_KEY,
      storeId: STORE_ID,
      variantId: VARIANT_ID,
      priceCents: cents,
      email: user.email ?? "",
      custom: {
        user_id: user.id,
        tokens: String(tokens),
      },
      redirectUrl: `${base}${lang}?paid=1`,
    });
    return json({ ok: true, url, tokens, price_cents: cents });
  } catch (e) {
    if (e instanceof LemonError) {
      console.error("checkout failed:", e.message);
      return json({ error: "checkout_failed" }, 502);
    }
    throw e;
  }
});
