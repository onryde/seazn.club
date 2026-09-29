// buildCreditPackCheckoutParams / CREDIT_PACKS — the one-time Checkout for AI
// credit packs (v17 SPEC-2 §5/§6/§8, Phase 3 Task 1). Pure (no Stripe/DB) —
// mirrors billing-checkout.test.ts's coverage of buildPassCheckoutParams:
// mode:"payment", locked currency, no payment_method_types, and the
// `kind: "credit_pack"` / `pack_key` / `credits` metadata contract the webhook
// branches on. `metadata.credits` SNAPSHOTS the grant amount at checkout-
// creation time (P3 T1 review fix) so the webhook grants exactly what was
// sold even if the live CREDIT_PACKS catalog changes or drops the `pack_key`
// before the session is paid — see credit-packs.ts and billing-events.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `createCreditPackCheckout` reaches Stripe; every pure-builder claim below is untouched by this mock.
const stripeMock = vi.hoisted(() => ({ pricesList: vi.fn(), sessionsCreate: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    prices: { list: stripeMock.pricesList },
    checkout: { sessions: { create: stripeMock.sessionsCreate } },
  }),
}));

import {
  buildCreditPackCheckoutParams, CREDIT_PACKS, createCreditPackCheckout, creditPackCheckoutIdempotencyKey,
} from "@/lib/credit-packs";
import seed from "@/config/stripe-plans.json";
import { SUPPORTED_CURRENCIES, creditPackOptions, type Currency } from "@/lib/currency";

const base = {
  priceId: "price_pack_10",
  orgId: "org-abc",
  packKey: "credits_10",
  credits: 40,
  returnUrl: "https://app.test/o/x/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
};

describe("CREDIT_PACKS catalog", () => {
  it("has exactly the 4 SKUs from SPEC-2 §6, credits never sent to Stripe", () => {
    expect(Object.keys(CREDIT_PACKS).sort()).toEqual(
      ["credits_10", "credits_100", "credits_25", "credits_50"].sort(),
    );
    expect(CREDIT_PACKS.credits_10).toEqual({ credits: 40, lookupKey: "seazn_credits_10" });
    expect(CREDIT_PACKS.credits_25).toEqual({ credits: 105, lookupKey: "seazn_credits_25" });
    expect(CREDIT_PACKS.credits_50).toEqual({ credits: 220, lookupKey: "seazn_credits_50" });
    expect(CREDIT_PACKS.credits_100).toEqual({ credits: 460, lookupKey: "seazn_credits_100" });
  });

  // Every currency the app can hand these builders must exist in the seed's
  // pack prices, or checkout 400s at runtime — same pin as
  // billing-checkout.test.ts's plan/pass check.
  it("every pack prices every supported currency", () => {
    const missing: string[] = [];
    for (const pack of seed.packs ?? []) {
      const opts = new Set([seed.currency, ...Object.keys(pack.price.currency_options ?? {})]);
      for (const c of SUPPORTED_CURRENCIES) {
        if (!opts.has(c)) missing.push(`${c} missing from ${pack.key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("creditPackOptions (Buy Credits ladder, SPEC-6 §A4)", () => {
  it("renders the ladder from the SAME catalog keys the checkout route validates", () => {
    const opts = creditPackOptions("usd");
    // Same keys as CREDIT_PACKS — the modal sends pack_key, the route checks it.
    expect(opts.map((o) => o.key)).toEqual(Object.keys(CREDIT_PACKS));
    for (const o of opts) expect(o.credits).toBe(CREDIT_PACKS[o.key]!.credits);
  });

  it("derives the bonus % from the smallest pack's rate and flags one best value", () => {
    const opts = creditPackOptions("usd");
    expect(opts[0]!.bonusPct).toBe(0); // the baseline rung has no bonus
    // Bonus rises with size; only the top rung is best value.
    expect(opts.filter((o) => o.bestValue)).toHaveLength(1);
    expect(opts.at(-1)!.bestValue).toBe(true);
    expect(opts.at(-1)!.bonusPct).toBe(Math.max(...opts.map((o) => o.bonusPct)));
  });

  it("prices each rung in the requested currency's set price points", () => {
    for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
      for (const o of creditPackOptions(currency)) {
        const pack = (seed.packs ?? []).find((p) => p.key === o.key)!;
        const expected =
          currency === "usd"
            ? pack.price.unit_amount
            : (pack.price.currency_options as Record<string, number>)[currency];
        expect(o.amountMinor).toBe(expected);
      }
    }
  });
});

describe("buildCreditPackCheckoutParams", () => {
  it("is a one-time embedded payment carrying the credit_pack metadata contract", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.mode).toBe("payment");
    expect(p.return_url).toBe(base.returnUrl);
    expect(p.line_items).toEqual([{ price: "price_pack_10", quantity: 1 }]);
    expect(p.metadata).toEqual({
      kind: "credit_pack",
      org_id: "org-abc",
      pack_key: "credits_10",
      credits: "40",
    });
    expect("subscription_data" in p).toBe(false);
    expect("payment_method_collection" in p).toBe(false);
  });

  it("stamps the PaymentIntent metadata so charge.refunded can recognise a pack charge (P3 T4)", () => {
    // Stripe copies PI metadata onto the Charge; the refund webhook reads it
    // there (the Charge does NOT carry the session metadata). No `credits`
    // snapshot here — a refund claws back from the ledger, never a wire number.
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.payment_intent_data?.metadata).toEqual({
      kind: "credit_pack",
      org_id: "org-abc",
      pack_key: "credits_10",
    });
  });

  it("never sends payment_method_types (stripe skill: dynamic payment methods)", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect("payment_method_types" in p).toBe(false);
  });

  it("tags the session with a stable, non-random integration_identifier", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.integration_identifier).toBe("seazn_credit_pack_wmzqkdxc");
    // Two calls agree — it is a per-integration label, not per-session.
    expect(buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" }).integration_identifier).toBe(
      p.integration_identifier,
    );
  });

  it("disables Stripe Adaptive Pricing and always sends an explicit currency", () => {
    expect(buildCreditPackCheckoutParams(base).adaptive_pricing).toEqual({ enabled: false });
    expect(buildCreditPackCheckoutParams(base).currency).toBe("usd");
    expect(buildCreditPackCheckoutParams({ ...base, currency: "inr" }).currency).toBe("inr");
  });

  it("honours the locked currency for every currency the packs price", () => {
    for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
      expect(buildCreditPackCheckoutParams({ ...base, currency }).currency).toBe(currency);
    }
  });

  it("reuses an existing customer id (with the tax customer_update), else falls back to customer_email", () => {
    const withCust = buildCreditPackCheckoutParams({ ...base, customerId: "cus_9" });
    expect(withCust.customer).toBe("cus_9");
    expect(withCust.customer_update).toEqual({ address: "auto", name: "auto" });
    expect("customer_email" in withCust).toBe(false);

    const withEmail = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withEmail.customer_email).toBe("a@b.com");
    expect("customer" in withEmail).toBe(false);
    expect("customer_update" in withEmail).toBe(false);
  });

  it("creates an invoice named after the credit amount, one per pack size", () => {
    const p10 = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p10.invoice_creation?.enabled).toBe(true);
    expect(p10.invoice_creation?.invoice_data?.description).toBe("AI Credit Pack — 40 credits");
    const p105 = buildCreditPackCheckoutParams({
      ...base,
      packKey: "credits_25",
      credits: 105,
      customerEmail: "a@b.com",
    });
    expect(p105.invoice_creation?.invoice_data?.description).toBe("AI Credit Pack — 105 credits");
  });

  it("brands the checkout like the plan/pass flows", () => {
    const p = buildCreditPackCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.branding_settings).toMatchObject({
      background_color: "#150b36",
      button_color: "#a3e635",
      border_style: "rounded",
      display_name: "Seazn Club",
    });
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.tax_id_collection).toEqual({ enabled: true });
  });
});

// R5b (Streaming R1 lane D, Task 14 fix round 5) — the same collision class as the relay pack's D-A. The key was
// `credit-pack-checkout-<org>-<pack>-<bucket>`, so two requests for the same pack inside one 30 s bucket that differ
// anywhere else — another currency (`preferredCurrency` reads the request), another billing owner's email, another
// host in the return URL, a customer id that appeared in between, a re-minted price — reused one key with DIFFERENT
// parameters, which Stripe refuses (StripeIdempotencyError) and the route turns into a failed checkout. The key is now
// a digest of every parameter the Session is created with, plus the bucket.
describe("R5b: createCreditPackCheckout's idempotency key", () => {
  type Args = Parameters<typeof createCreditPackCheckout>[0];
  // Every argument, spelled out (`Required` makes the compiler demand a new one here the day it is added). The
  // first-purchase shape — no Stripe customer yet, so the email is what Stripe is sent.
  const BASE: Required<Args> = {
    orgId: "org-abc",
    packKey: "credits_10",
    returnUrl: base.returnUrl,
    currency: "usd",
    customerId: null,
    customerEmail: "a@b.com",
  };
  /** One call, the price id Stripe resolves the pack's lookup key to, and the key and params it was sent with. */
  async function keyFor(args: Args, priceId = "price_pack_10"): Promise<{ key: string; sent: Record<string, unknown> }> {
    stripeMock.pricesList.mockResolvedValueOnce({ data: [{ id: priceId }] });
    stripeMock.sessionsCreate.mockResolvedValueOnce({ id: "cs", client_secret: "cs_secret" });
    await createCreditPackCheckout(args);
    const [sent, opts] = stripeMock.sessionsCreate.mock.calls.at(-1)!;
    return { key: opts.idempotencyKey as string, sent };
  }

  beforeEach(() => {
    stripeMock.pricesList.mockReset();
    stripeMock.sessionsCreate.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:07.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the same request twice reuses the key; every argument that changes the Session, ALONE, changes it", async () => {
    const first = await keyFor(BASE);
    expect((await keyFor({ ...BASE })).key, "a double click must dedupe").toBe(first.key);
    // Each row moves ONE argument.
    const VARIANTS: { [K in keyof Args]-?: Args[K] } = {
      orgId: "org-def",
      packKey: "credits_25",
      returnUrl: base.returnUrl.replace("https://app.test", "https://www.app.test"),
      currency: "gbp",
      customerId: "cus_existing",
      customerEmail: "treasurer@example.com",
    };
    expect(Object.keys(VARIANTS).sort(), "a createCreditPackCheckout argument with no row").toEqual(Object.keys(BASE).sort());
    let checked = 0;
    const seen = new Set([first.key]);
    for (const k of Object.keys(VARIANTS) as (keyof Args)[]) {
      const moved = await keyFor({ ...BASE, [k]: VARIANTS[k] });
      expect(moved.sent, `premise: ${k} changes what Stripe is sent`).not.toEqual(first.sent);
      expect(moved.key, `${k} alone collided with the base key`).not.toBe(first.key);
      seen.add(moved.key);
      checked++;
    }
    // The Stripe price the pack's lookup key resolves to is a parameter too (a re-minted price inside one bucket).
    const repriced = await keyFor(BASE, "price_pack_10_v2");
    expect(repriced.key, "priceId alone collided").not.toBe(first.key);
    seen.add(repriced.key);
    checked++;
    expect(checked, "anti-vacuity: every argument plus the price id").toBe(Object.keys(BASE).length + 1);
    expect(seen.size, "two different requests shared a key").toBe(checked + 1);
    // The bucket is computed HERE, never read back from the code under test; Stripe caps a key at 255 characters.
    expect(first.key).toMatch(new RegExp(`^credit-pack-checkout-[0-9a-f]{32}-${Math.floor(Date.now() / 30_000)}$`));
    expect(first.key.length).toBeLessThanOrEqual(255);
  });

  it("the key follows what Stripe is SENT: an argument that does not change the request does not change the key", async () => {
    // A returning buyer is sent `customer`, never `customer_email` (the two are exclusive), so the email is not part
    // of the request — two clicks that differ only there are the same request and must dedupe.
    const a = await keyFor({ ...BASE, customerId: "cus_existing", customerEmail: "a@b.com" });
    const b = await keyFor({ ...BASE, customerId: "cus_existing", customerEmail: "someone-else@example.com" });
    expect(b.sent, "premise: Stripe is sent the same thing").toEqual(a.sent);
    expect(b.key).toBe(a.key);
  });

  it("equal params hash equal whatever order their fields were built in — nested objects included", () => {
    const params = buildCreditPackCheckoutParams({ ...base, currency: "usd", customerEmail: "a@b.com" });
    const again = buildCreditPackCheckoutParams({ ...base, currency: "usd", customerEmail: "a@b.com" });
    expect(again, "premise: two builds of one request are distinct objects").not.toBe(params);
    expect(creditPackCheckoutIdempotencyKey(again, 7)).toBe(creditPackCheckoutIdempotencyKey(params, 7));
    const reversed = (o: unknown): unknown =>
      o && typeof o === "object" && !Array.isArray(o)
        ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reversed(v)]))
        : o;
    const flipped = reversed(params) as typeof params;
    expect(Object.keys(flipped), "premise: the field order really differs").not.toEqual(Object.keys(params));
    expect(Object.keys(flipped.metadata!), "premise: nested too").not.toEqual(Object.keys(params.metadata!));
    expect(creditPackCheckoutIdempotencyKey(flipped, 7)).toBe(creditPackCheckoutIdempotencyKey(params, 7));
    // …and the positive pair: one nested value moved is another key.
    expect(
      creditPackCheckoutIdempotencyKey({ ...params, metadata: { ...params.metadata, credits: "105" } }, 7),
    ).not.toBe(creditPackCheckoutIdempotencyKey(params, 7));
  });

  it("the bucket still ends a key: the same request 30 s later is a new purchase attempt", async () => {
    const now = await keyFor(BASE);
    vi.setSystemTime(Date.now() + 30_000);
    const later = await keyFor(BASE);
    expect(later.sent).toEqual(now.sent);
    expect(later.key).not.toBe(now.key);
    expect(later.key.endsWith(`-${Math.floor(Date.now() / 30_000)}`)).toBe(true);
  });
});
