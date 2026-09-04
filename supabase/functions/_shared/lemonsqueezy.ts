// Lemon Squeezy: making a checkout, and believing a webhook.
//
// Two jobs, and the second one is the one that matters. A webhook endpoint is
// a URL on the open internet that adds tokens to somebody's balance, so the
// only thing standing between it and free tokens for anyone who finds it is
// the signature check below. It is written to be dull and total: verify the
// signature over the EXACT bytes that arrived, before the body is parsed as
// JSON, and compare in constant time.

export class LemonError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const API = "https://api.lemonsqueezy.com/v1";

export interface CheckoutRequest {
  apiKey: string;
  storeId: string;
  variantId: string;
  priceCents: number;
  email: string;
  /** Carried through the payment and handed back on the webhook. Lemon Squeezy
   *  returns custom values as strings, so they are sent as strings. */
  custom: Record<string, string>;
  redirectUrl: string;
}

/**
 * Creates a checkout and returns the URL to send the customer to.
 *
 * custom_price overrides the variant's price, which is what lets one product
 * cover every quantity on the store page. The price is in cents and comes from
 * pricing.ts — never from the browser.
 */
export async function createCheckout(req: CheckoutRequest): Promise<string> {
  const res = await fetch(`${API}/checkouts`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Authorization": `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          custom_price: req.priceCents,
          product_options: {
            redirect_url: req.redirectUrl,
            enabled_variants: [Number(req.variantId)],
          },
          checkout_data: {
            email: req.email,
            custom: req.custom,
          },
        },
        relationships: {
          store: { data: { type: "stores", id: String(req.storeId) } },
          variant: { data: { type: "variants", id: String(req.variantId) } },
        },
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // The provider's own message is worth keeping: "variant does not belong to
    // this store" is a five-second fix and "502" is an afternoon.
    throw new LemonError(`lemonsqueezy ${res.status}: ${text.slice(0, 300)}`);
  }
  let url: unknown;
  try {
    url = JSON.parse(text)?.data?.attributes?.url;
  } catch {
    throw new LemonError("lemonsqueezy returned a body that was not JSON");
  }
  if (typeof url !== "string" || !url) {
    throw new LemonError("lemonsqueezy returned no checkout url");
  }
  return url;
}

/** Hex, lowercase, no separators — the shape Lemon Squeezy signs with. */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * True when `signature` is an HMAC-SHA256 of `rawBody` under `secret`.
 *
 * Two rules, both load-bearing:
 *
 *   1. rawBody is the bytes as they arrived. Parsing to JSON and
 *      re-serialising changes key order and whitespace, and the signature is
 *      over the original — a round trip would fail every honest request and
 *      tempt somebody to "fix" it by skipping the check.
 *   2. The comparison is constant-time. A === on hex strings returns early at
 *      the first wrong character, which leaks the correct prefix to anyone
 *      willing to time the responses, one character at a time.
 */
export async function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
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
    new TextEncoder().encode(rawBody),
  );
  return timingSafeEqual(toHex(mac), signature.trim().toLowerCase());
}

export function timingSafeEqual(a: string, b: string): boolean {
  // Length is not a secret — a signature is a fixed 64 hex characters — so
  // refusing a wrong length early leaks nothing.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface OrderEvent {
  eventName: string;
  /** Lemon Squeezy's own id for the order — the key a repeat delivery is
   *  recognised by, so one payment can only ever be credited once. */
  orderId: string;
  userId: string;
  tokens: number;
  totalCents: number;
  email: string;
  status: string;
}

/**
 * Pulls the few fields we act on out of a webhook body, and refuses anything
 * it cannot read with confidence.
 *
 * user_id and tokens come back from `meta.custom_data` — the values we put on
 * the checkout. They are inside the signed envelope, so they are as trustworthy
 * as the signature: a customer cannot edit them on the way through, because
 * the body they appear in is the one Lemon Squeezy signed.
 */
export function readOrderEvent(body: unknown): OrderEvent {
  const b = body as Record<string, any>;
  const eventName = String(b?.meta?.event_name ?? "");
  const custom = b?.meta?.custom_data ?? {};
  const attrs = b?.data?.attributes ?? {};

  const orderId = String(b?.data?.id ?? "");
  if (!orderId) throw new LemonError("webhook carried no order id", 400);

  const userId = String(custom.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new LemonError("webhook carried no usable user_id", 400);
  }

  const tokens = Number(custom.tokens);
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new LemonError("webhook carried no usable token count", 400);
  }

  return {
    eventName,
    orderId,
    userId,
    tokens,
    totalCents: Number(attrs.total ?? 0),
    email: String(attrs.user_email ?? ""),
    status: String(attrs.status ?? ""),
  };
}
