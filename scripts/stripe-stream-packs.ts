// scripts/stripe-stream-packs.ts — create the SANDBOX product and its three
// prices for match credits (streaming R1, design §5.2), idempotent by
// lookup_key. Unlike scripts/stripe-sync.ts's ensurePrice, an existing price is
// reused ONLY when it charges exactly what `streamPackPriceAmounts` says (M3,
// Task 14 fix round 4): the Phone tab's tiles quote that table while a checkout
// charges the live price, so a mismatch fails the run LOUDLY with the diff and
// changes nothing in Stripe — re-minting a price is the owner's call, never a
// side effect of a sync. One drift from stripe-sync.ts, deliberate: it
// constructs `new Stripe(key)` with NO apiVersion, so the pin below follows
// apps/web/src/lib/stripe.ts instead — the app's own pin, which is what
// actually reads these prices back. Run once per Stripe sandbox:
//
//   STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe-stream-packs.ts
//
// Refuses a live key: the prices here are PLACEHOLDERS (£6 / £25 / £80) until
// the owner rules on real prices before the GA flip. GBP is the base and the
// other currencies are rough multipliers, also placeholders. This script
// RETYPES nothing: both the lookup keys and the currency multipliers come out
// of apps/web/src/lib/stream-credit-packs.ts, which is the authority, so the
// two cannot drift.
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import {
  STREAM_CREDIT_PACKS,
  streamPackPriceAmounts,
  streamPackPriceDrift,
  type StreamCreditPack,
} from "../apps/web/src/lib/stream-credit-packs.ts";

/** The sandbox client — read only by main(), so importing this module (the tests do) needs no key and calls nothing. */
function requireSandboxStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY (a sandbox sk_test_ key) is required");
  if (!key.startsWith("sk_test_")) {
    throw new Error("refusing: this script creates PLACEHOLDER prices and runs against the sandbox only");
  }
  return new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
}

const PRODUCT_NAME = "Seazn Club Match Credits";

/** MEASURED, 2026-09-28: `stripe.products.search` is index-backed and lags
 *  creation by seconds, so a second run moments after the first found nothing
 *  and minted a DUPLICATE product (prod_VLHqnfm0BdncHp, then
 *  prod_VLHqDWvglRzYWW) while every price correctly reported `(existing)` —
 *  i.e. the script read as idempotent and was not. `products.list` is
 *  immediately consistent, so the tag below is matched client-side instead.
 *  The tag, not the name: a renamed product must still be found, or the next
 *  run orphans its prices onto a fresh one. */
async function ensureProduct(stripe: Stripe): Promise<Stripe.Product> {
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

/** The pack's price: the existing one when it matches the table, a new one when there is none — and a thrown Error,
 *  naming the pack and every differing currency, when the existing one does not match. Takes its client as a
 *  PARAMETER so a stub can prove every call (scripts/__tests__/stripe-stream-packs.test.ts). */
export async function ensurePrice(stripe: Stripe, productId: string, pack: StreamCreditPack): Promise<string> {
  const { lookupKey, credits } = pack;
  // `currency_options` is omitted from the default response; without the expand every option would read as missing.
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, expand: ["data.currency_options"] });
  const live = existing.data[0];
  if (live) {
    const drift = streamPackPriceDrift(pack, live);
    if (drift.length > 0) {
      const diff = drift.map((d) => `${d.at}: live ${d.live ?? "none"}, table ${d.want ?? "none"}`).join("; ");
      throw new Error(
        `${lookupKey} (${credits} match credit${credits === 1 ? "" : "s"}): live price ${live.id} does not charge ` +
          `what streamPackPriceAmounts says — ${diff}. Nothing was changed. Re-mint it by hand (a new price with ` +
          `transfer_lookup_key, then archive ${live.id}), or fix the table.`,
      );
    }
    return `${lookupKey} = ${live.id} (existing, amounts match)`;
  }
  const price = await stripe.prices.create({
    product: productId,
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
    //
    // P1: the amounts come from `streamPackPriceAmounts` — the SAME function the
    // Phone tab's tiles read back — so the price a tile quotes and the price
    // this creates cannot disagree.
    ...streamPackPriceAmounts(pack),
    metadata: { kind: "stream_credits", credits: String(credits) },
  });
  return `${lookupKey} = ${price.id} (created)`;
}

/** Every pack is checked before the run fails, so one run reports every drifted price rather than the first. */
async function main(): Promise<number> {
  const stripe = requireSandboxStripe();
  const product = await ensureProduct(stripe);
  console.log(`product ${product.id}`);
  const failures: string[] = [];
  for (const pack of STREAM_CREDIT_PACKS) {
    try {
      console.log(await ensurePrice(stripe, product.id, pack));
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  for (const f of failures) console.error(`DRIFT ${f}`);
  return failures.length === 0 ? 0 : 1;
}

// Only run when invoked as a script (stripe-connect-fixture.ts's guard), so the tests can import ensurePrice.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
