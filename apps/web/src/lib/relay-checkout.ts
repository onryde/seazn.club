import "server-only";
// lib/relay-checkout.ts — the Stripe half of buying match credits (design
// §5.2), on lib/credit-packs.ts's split: a PURE params builder and an impure
// caller. EMBEDDED Checkout like every other checkout here (owner ruling
// 2026-09-14, "checkout should be inbuilt as other"): `ui_mode:
// "embedded_page"`, `return_url` → the fixture row with the panel open on the
// Phone tab. Differences from the donor, each deliberate: `metadata.kind:
// "stream_credits"` is the webhook branch's discriminator — NEVER
// `"credit_pack"`, which is the AI credit WALLET's and lands on a different
// ledger; `metadata.credits` SNAPSHOTS the grant (the donor's review fix — a
// later catalogue edit must not change what a paid session grants).
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import { canonicalJson } from "@/lib/canonical-json";
import { CHECKOUT_BRANDING, CUSTOMER_UPDATE_FOR_TAX } from "@/lib/billing";
import { type StreamCreditPack, type StreamPackSize, streamPack } from "@/lib/stream-credit-packs";

/** Stable per-integration tag (stripe skill: `integration_identifier`) so this
 *  checkout surface is distinguishable from the plan/pass/AI-pack ones in the
 *  Dashboard. Not per-session and not random. */
const INTEGRATION_IDENTIFIER = "seazn_stream_credits_rlyq8kzt";

export function buildRelayCheckoutParams(args: {
  priceId: string;
  orgId: string;
  fixtureId: string;
  pack: StreamCreditPack;
  returnUrl: string;
  /** The billing entity's LOCKED currency — Stripe forbids mixing currencies
   *  on one customer, so this is whatever `preferredCurrency` resolved. */
  currency?: string;
  customerId?: string;
  customerEmail?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    ui_mode: "embedded_page",
    mode: "payment",
    ...(args.customerId
      ? { customer: args.customerId, ...CUSTOMER_UPDATE_FOR_TAX }
      : { customer_email: args.customerEmail }),
    invoice_creation: { enabled: true, invoice_data: { description: `Match credits — ${args.pack.credits}` } },
    currency: args.currency ?? "gbp",
    // Adaptive Pricing re-quotes at RENDER time from the buyer's IP unless
    // explicitly disabled — we quote one currency, we must charge in it.
    adaptive_pricing: { enabled: false },
    metadata: {
      kind: "stream_credits",
      org_id: args.orgId,
      fixture_id: args.fixtureId,
      pack: String(args.pack.size),
      credits: String(args.pack.credits),
    },
    payment_intent_data: {
      metadata: { kind: "stream_credits", org_id: args.orgId, pack: String(args.pack.size) },
    },
    line_items: [{ price: args.priceId, quantity: 1 }],
    return_url: args.returnUrl,
    allow_promotion_codes: true,
    branding_settings: { ...CHECKOUT_BRANDING },
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
  };
}

/**
 * The live Stripe price id for a pack, resolved by `lookup_key` at request
 * time (the donor's `resolveCreditPackPriceId` shape — there is no plans row
 * to cache a price id on). 503 when `pnpm stripe:sync` (scripts/stripe-sync.ts)
 * has not created the pack prices on this Stripe account yet — or skipped them,
 * on a live key while `STREAM_PACK_PRICES_FINAL` is false — matching the
 * plan/pass/pack checkout routes' own "Billing is not yet configured" refusal.
 */
export async function resolveStreamPackPriceId(pack: StreamCreditPack): Promise<string> {
  const found = await getStripe().prices.list({ lookup_keys: [pack.lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  return price.id;
}

/**
 * D-A (Task 14 fix round 4): the idempotency key for ONE Checkout Session request — a digest of every parameter the
 * Session is created with, plus the 30-second bucket.
 *
 * It was `relay-checkout-<org>-<size>-<bucket>`, and Stripe answers a reused key whose parameters DIFFER with
 * StripeIdempotencyError: the same pack bought for another fixture (another return_url and metadata) or in another
 * currency inside one bucket was a 502 "Checkout didn't open" (capture pass 3, three times). Hashing the params
 * themselves makes the key vary exactly when the request does — a true double tap (the same request) still dedupes,
 * a different request can never collide, and a field added to the params later is covered without an edit here.
 */
export function relayCheckoutIdempotencyKey(params: Stripe.Checkout.SessionCreateParams, bucket: number): string {
  const digest = createHash("sha256").update(canonicalJson(params)).digest("hex").slice(0, 32);
  return `relay-checkout-${digest}-${bucket}`;
}

/**
 * Open a one-time embedded Checkout Session for a match-credit pack. The route
 * resolves the caller/org/currency and calls this, so the Stripe-call shape
 * lives in one place.
 *
 * The idempotency key (`relayCheckoutIdempotencyKey`) is the request's own
 * digest in a 30-second bucket: enough to dedupe a double-click or a retry of
 * the SAME purchase attempt, short enough that a genuine second pack purchase
 * moments later is not answered with the first (completed) session.
 */
export async function createRelayCheckout(args: {
  orgId: string;
  fixtureId: string;
  size: StreamPackSize;
  returnUrl: string;
  currency?: string;
  customerId?: string | null;
  customerEmail?: string;
}): Promise<Stripe.Checkout.Session> {
  const pack = streamPack(args.size);
  if (!pack) throw new HttpError(400, `Unknown match-credit pack: ${args.size}`);
  const priceId = await resolveStreamPackPriceId(pack);
  const bucket = Math.floor(Date.now() / 30_000);
  const params = buildRelayCheckoutParams({
    priceId,
    orgId: args.orgId,
    fixtureId: args.fixtureId,
    pack,
    returnUrl: args.returnUrl,
    currency: args.currency,
    customerId: args.customerId ?? undefined,
    customerEmail: args.customerEmail,
  });
  return getStripe().checkout.sessions.create(params, { idempotencyKey: relayCheckoutIdempotencyKey(params, bucket) });
}
