// Paddle: making a transaction, and believing a webhook.
//
// Two jobs, and the second one is the one that matters. A webhook endpoint is
// a URL on the open internet that adds tokens to somebody's balance, so the
// only thing standing between it and free tokens for anyone who finds it is
// the signature check below. It is written to be dull and total: verify the
// signature over the EXACT bytes that arrived, before the body is parsed as
// JSON, and compare in constant time.
//
// Paddle differs from most providers in one way worth knowing before reading
// on: creating a transaction does NOT return a hosted checkout page. It
// returns a link back to OUR OWN page with ?_ptxn=<transaction id>, and
// Paddle.js on that page opens the checkout over it. So this module's job
// ends at "here is a transaction id" — the browser opens the checkout itself.

export class PaddleError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** Sandbox and live are separate accounts with separate keys and separate
 *  data. Getting this wrong is not a security problem, it is a "why did my
 *  test purchase never arrive" problem, so it is explicit rather than
 *  guessed from the key. */
export type PaddleEnv = "sandbox" | "production";

export function apiBase(env: PaddleEnv): string {
  return env === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

export interface TransactionRequest {
  apiKey: string;
  env: PaddleEnv;
  /** The catalogue product the charge hangs off. The PRICE is not from the
   *  catalogue — see priceCents in pricing.ts. */
  productId: string;
  priceCents: number;
  /** Shown to the customer at checkout and on the invoice. */
  label: string;
  /** Carried through the payment and handed back on the webhook. Paddle
   *  returns custom values as they were sent; strings keep that predictable. */
  custom: Record<string, string>;
  /** Which of our approved pages the payment link should point back at.
   *  Omit to use the account's default payment link. */
  checkoutUrl?: string;
}

export interface TransactionResult {
  transactionId: string;
  /** Our own page + ?_ptxn=... . Kept because it is the documented fallback
   *  when a browser cannot run Paddle.js and has to be sent somewhere. */
  checkoutUrl: string | null;
}

/**
 * Creates a transaction for an exact amount and returns its id.
 *
 * The price is passed as a "non-catalog price" — a one-off price attached to
 * the catalogue product — which is what lets a single product cover every
 * quantity the store sells, including a quantity the customer typed. The
 * amount is in the currency's lowest denomination, as a string of a whole
 * number, because that is what Paddle accepts: "4200" is $42.00.
 */
export async function createTransaction(
  req: TransactionRequest,
): Promise<TransactionResult> {
  const body: Record<string, unknown> = {
    items: [{
      quantity: 1,
      price: {
        product_id: req.productId,
        // description is internal; name is what the customer reads.
        description: `${req.label} - bought from the store`,
        name: req.label,
        unit_price: {
          amount: String(Math.round(req.priceCents)),
          currency_code: "USD",
        },
      },
    }],
    custom_data: req.custom,
    currency_code: "USD",
    collection_mode: "automatic",
  };
  if (req.checkoutUrl) body.checkout = { url: req.checkoutUrl };

  const res = await fetch(`${apiBase(req.env)}/transactions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // Paddle's own message is worth keeping: "default payment link not set"
    // is a two-minute fix in the dashboard and "502" is an afternoon.
    throw new PaddleError(`paddle ${res.status}: ${text.slice(0, 400)}`);
  }
  let data: Record<string, any>;
  try {
    data = JSON.parse(text)?.data;
  } catch {
    throw new PaddleError("paddle returned a body that was not JSON");
  }
  const transactionId = data?.id;
  if (typeof transactionId !== "string" || !transactionId.startsWith("txn_")) {
    throw new PaddleError("paddle returned no transaction id");
  }
  return {
    transactionId,
    checkoutUrl: typeof data?.checkout?.url === "string"
      ? data.checkout.url
      : null,
  };
}

/** Hex, lowercase, no separators — the shape Paddle signs with. */
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ParsedSignature {
  ts: string;
  h1: string;
}

/** `Paddle-Signature: ts=1671552777;h1=eb4d0dc8853be92b...` */
export function parseSignatureHeader(
  header: string | null,
): ParsedSignature | null {
  if (!header) return null;
  let ts = "", h1 = "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "h1") h1 = v.toLowerCase();
  }
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]+$/.test(h1)) return null;
  return { ts, h1 };
}

/**
 * A webhook is genuine when h1 is an HMAC-SHA256 of `<ts>:<rawBody>` under the
 * destination's secret key, and ts is recent.
 *
 * Three rules, all load-bearing:
 *
 *   1. rawBody is the bytes as they arrived. Parsing to JSON and
 *      re-serialising changes key order and whitespace, and the signature is
 *      over the original — a round trip would fail every honest request and
 *      tempt somebody to "fix" it by skipping the check.
 *   2. The comparison is constant-time. A === on hex strings returns early at
 *      the first wrong character, which leaks the correct prefix to anyone
 *      willing to time the responses, one character at a time.
 *   3. The timestamp is checked, so a body captured once cannot be replayed
 *      forever. Paddle's own SDKs allow five seconds; that is tight enough to
 *      reject honest deliveries over ordinary clock skew and a cold start, so
 *      this allows five minutes — long enough to be reliable, short enough
 *      that a stolen body stops working the same afternoon.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, for the log. Never contains the secret or the signature. */
  reason?: "no_secret" | "bad_header" | "stale" | "mismatch";
  /** Seconds between Paddle's timestamp and ours. Useful exactly once: when
   *  a correct secret still fails and the clocks are the reason. */
  skewSeconds?: number;
}

export async function verifySignatureDetailed(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  // A secret pasted into a form picks up whitespace and, from a textarea, a
  // trailing newline. Neither is visible and either changes the HMAC
  // completely, so the value is trimmed before it is ever used as a key.
  const key0 = secret.trim();
  if (!key0) return { ok: false, reason: "no_secret" };
  const sig = parseSignatureHeader(header);
  if (!sig) return { ok: false, reason: "bad_header" };

  // Future timestamps are allowed the same slack as past ones: the skew can
  // run either way, and it is our clock that is as likely to be wrong.
  const skewSeconds = nowSeconds - Number(sig.ts);
  if (Math.abs(skewSeconds) > toleranceSeconds) {
    return { ok: false, reason: "stale", skewSeconds };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key0),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${sig.ts}:${rawBody}`),
  );
  if (!timingSafeEqual(toHex(mac), sig.h1)) {
    return { ok: false, reason: "mismatch", skewSeconds };
  }
  return { ok: true, skewSeconds };
}

export async function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const r = await verifySignatureDetailed(
    rawBody, header, secret, toleranceSeconds, nowSeconds,
  );
  return r.ok;
}

export function timingSafeEqual(a: string, b: string): boolean {
  // Length is not a secret — a signature is a fixed 64 hex characters — so
  // refusing a wrong length early leaks nothing.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface PaddleEvent {
  eventType: string;
  /** Paddle's own id for the transaction — the key a repeat delivery is
   *  recognised by, so one payment can only ever be credited once. */
  transactionId: string;
  userId: string;
  tokens: number;
  totalCents: number;
  status: string;
}

/**
 * Pulls the few fields we act on out of a webhook body, and refuses anything
 * it cannot read with confidence.
 *
 * user_id and tokens come back from `data.custom_data` — the values we put on
 * the transaction. They are inside the signed envelope, so they are as
 * trustworthy as the signature: a customer cannot edit them on the way
 * through, because the body they appear in is the one Paddle signed.
 */
export function readEvent(body: unknown): PaddleEvent {
  const b = body as Record<string, any>;
  const eventType = String(b?.event_type ?? "");
  const d = b?.data ?? {};
  const custom = d.custom_data ?? {};

  // An adjustment (a refund) is its own entity and names the transaction it
  // adjusts; everything else IS the transaction.
  const transactionId = String(
    (eventType.startsWith("adjustment.") ? d.transaction_id : d.id) ?? "",
  );
  if (!transactionId) {
    throw new PaddleError("webhook carried no transaction id", 400);
  }

  const userId = String(custom.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new PaddleError("webhook carried no usable user_id", 400);
  }

  const tokens = Number(custom.tokens);
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new PaddleError("webhook carried no usable token count", 400);
  }

  // Totals are strings in the lowest denomination, and grand_total is the
  // number the customer was actually asked for.
  const totals = d.details?.totals ?? {};
  const raw = totals.grand_total ?? totals.total ?? "0";
  const totalCents = Number.isFinite(Number(raw)) ? Math.round(Number(raw)) : 0;

  return {
    eventType,
    transactionId,
    userId,
    tokens,
    totalCents,
    status: String(d.status ?? ""),
  };
}
