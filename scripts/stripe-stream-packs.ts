// scripts/stripe-stream-packs.ts — create the SANDBOX product and its three
// prices for match credits (streaming R1, design §5.2), idempotent by
// lookup_key exactly as scripts/stripe-sync.ts's ensurePrice is. One drift,
// deliberate: stripe-sync.ts constructs `new Stripe(key)` with NO apiVersion,
// so the pin below follows apps/web/src/lib/stripe.ts instead — the app's own
// pin, which is what actually reads these prices back. Run once per Stripe
// sandbox:
//
//   STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe-stream-packs.ts
//
// Refuses a live key: the prices here are PLACEHOLDERS (£6 / £25 / £80) until
// the owner rules on real prices before the GA flip. GBP is the base and the
// other currencies are rough multipliers, also placeholders. This script
// RETYPES nothing: both the lookup keys and the currency multipliers come out
// of apps/web/src/lib/stream-credit-packs.ts, which is the authority, so the
// two cannot drift.
import Stripe from "stripe";
import { STREAM_CREDIT_PACKS, STREAM_PACK_FX } from "../apps/web/src/lib/stream-credit-packs.ts";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY (a sandbox sk_test_ key) is required");
if (!key.startsWith("sk_test_")) {
  throw new Error("refusing: this script creates PLACEHOLDER prices and runs against the sandbox only");
}
const stripe = new Stripe(key, { apiVersion: "2026-06-24.dahlia" });

const PRODUCT_NAME = "Seazn Club Match Credits";

/** MEASURED, 2026-09-28: `stripe.products.search` is index-backed and lags
 *  creation by seconds, so a second run moments after the first found nothing
 *  and minted a DUPLICATE product (prod_VLHqnfm0BdncHp, then
 *  prod_VLHqDWvglRzYWW) while every price correctly reported `(existing)` —
 *  i.e. the script read as idempotent and was not. `products.list` is
 *  immediately consistent, so the tag below is matched client-side instead.
 *  The tag, not the name: a renamed product must still be found, or the next
 *  run orphans its prices onto a fresh one. */
async function ensureProduct(): Promise<Stripe.Product> {
  // The OLDEST match, not the first page entry: `products.list` returns
  // newest-first, so if a duplicate ever does exist, "first" flips between
  // runs and the next new pack size lands on whichever product happened to be
  // newest. Oldest-wins is stable, and it is the one the existing prices hang
  // off (a duplicate can only ever be the younger one).
  const matches: Stripe.Product[] = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata?.kind === "stream_credits") matches.push(p);
  }
  matches.sort((a, b) => a.created - b.created);
  if (matches[0]) return matches[0];
  return stripe.products.create({
    name: PRODUCT_NAME,
    description:
      "One match credit = one phone-streamed match, up to 5 hours. Sandbox placeholder prices.",
    metadata: { kind: "stream_credits" },
  });
}

async function ensurePrice(
  productId: string,
  lookupKey: string,
  gbpPence: number,
  credits: number,
): Promise<string> {
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (existing.data[0]) return `${lookupKey} = ${existing.data[0].id} (existing)`;
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: gbpPence,
    currency: "gbp",
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    nickname: `${credits} match credit${credits === 1 ? "" : "s"}`,
    // DERIVED from STREAM_PACK_FX, never retyped: the key set has to equal
    // SUPPORTED_CURRENCIES minus gbp, or a buyer quoted in the missing
    // currency meets a Stripe refusal. This script cannot import
    // `lib/currency.ts` to check that (measured: TS1543 + TS2307 under
    // nodenext, and the `@/` alias does not resolve under
    // --experimental-strip-types), so the table lives beside the catalogue and
    // `apps/web/src/lib/__tests__/relay-checkout.test.ts` holds it to the
    // authority.
    currency_options: Object.fromEntries(
      Object.entries(STREAM_PACK_FX).map(([code, rate]) => [
        code,
        { unit_amount: Math.round(gbpPence * rate) },
      ]),
    ),
    metadata: { kind: "stream_credits", credits: String(credits) },
  });
  return `${lookupKey} = ${price.id} (created)`;
}

const product = await ensureProduct();
console.log(`product ${product.id}`);
for (const pack of STREAM_CREDIT_PACKS) {
  console.log(await ensurePrice(product.id, pack.lookupKey, pack.gbpPence, pack.credits));
}
