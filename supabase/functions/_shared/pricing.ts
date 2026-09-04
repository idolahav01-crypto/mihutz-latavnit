// What a number of tokens costs, decided by the server.
//
// The store page prints prices, and a page can be edited by whoever is looking
// at it. So the price the customer is charged is never the one the browser
// sends: the browser asks for a QUANTITY, and this module says what that
// quantity costs. A tampered page can therefore ask to buy 250 tokens, but it
// cannot ask to buy them for $1.
//
// The table below is a copy of PACKAGES in js/store.js. The duplication is
// deliberate — the page is static JavaScript and this is Deno, with no build
// step between them — and pricing.test.ts reads js/store.js and fails if the
// two ever drift apart. Change one, change the other, or the suite says so.

export interface Package {
  tokens: number;
  usd: number;
}

export const PACKAGES: Package[] = [
  { tokens: 10, usd: 10 },
  { tokens: 20, usd: 18 },
  { tokens: 50, usd: 42 },
  { tokens: 100, usd: 80 },
];

/** The rate every other price is measured against: the smallest package's own. */
export function baseRate(): number {
  return PACKAGES[0].usd / PACKAGES[0].tokens;
}

/** The most tokens anyone may buy in one go. A quantity above this is far more
 *  likely to be a typo or a probe than an order, and a wrong extra zero is a
 *  charge somebody has to undo by hand. */
export const MAX_TOKENS = 1000;

export class PriceError extends Error {}

/**
 * The price of `tokens` tokens, in whole US cents.
 *
 * A quantity that exactly matches a package is charged that package's price —
 * the same rule the page applies, for the same reason: quoting $50 for 50
 * tokens on a page that sells 50 for $42 would be a trap. Everything else is
 * the base rate.
 *
 * Cents, not dollars: money in floating point is money that eventually comes
 * out a cent short, and the payment provider wants an integer anyway.
 */
export function priceCents(tokens: unknown): number {
  if (typeof tokens !== "number" || !Number.isInteger(tokens)) {
    throw new PriceError("tokens must be a whole number");
  }
  if (tokens < 1) throw new PriceError("tokens must be at least 1");
  if (tokens > MAX_TOKENS) {
    throw new PriceError(`tokens must be at most ${MAX_TOKENS}`);
  }
  const pack = PACKAGES.find((p) => p.tokens === tokens);
  const usd = pack ? pack.usd : tokens * baseRate();
  return Math.round(usd * 100);
}
