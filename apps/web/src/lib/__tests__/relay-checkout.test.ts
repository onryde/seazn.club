// The relay checkout's Stripe shape (design §5.2 on the credit-pack donor).
// Pure builder claims + one mocked-Stripe claim for the idempotency bucket.
// The catalogue is asserted against ITSELF only where the design fixes a
// number (three packs, sizes 1/5/20, sandbox £6/£25/£80) — those ARE the spec
// (_THEMES.md §8b), so they are the one place a literal is the oracle rather
// than a retyped copy of one (S10).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_CREDIT_PACKS, STREAM_PACK_FX, formatGbp, perMatchGbp, streamPack } from "../stream-credit-packs";
import { messages, type MessageKey } from "@/lib/messages";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";

const stripeMock = vi.hoisted(() => ({
  pricesList: vi.fn(),
  sessionsCreate: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    prices: { list: stripeMock.pricesList },
    checkout: { sessions: { create: stripeMock.sessionsCreate } },
  }),
}));

import { buildRelayCheckoutParams, createRelayCheckout, resolveStreamPackPriceId } from "../relay-checkout";

describe("STREAM_CREDIT_PACKS", () => {
  it("is the three packs the design names, one popular, lookup keys unique", () => {
    expect(STREAM_CREDIT_PACKS.map((p) => [p.size, p.credits, p.gbpPence])).toEqual([
      [1, 1, 600],
      [5, 5, 2500],
      [20, 20, 8000],
    ]);
    expect(STREAM_CREDIT_PACKS.filter((p) => p.popular).map((p) => p.size)).toEqual([5]);
    expect(new Set(STREAM_CREDIT_PACKS.map((p) => p.lookupKey)).size).toBe(3);
    // Every lookup key is the pack's own name — a copy/paste that pointed two
    // sizes at one Stripe price would still pass the uniqueness count above if
    // the third key were unique, so the mapping is pinned per row.
    expect(STREAM_CREDIT_PACKS.map((p) => p.lookupKey)).toEqual([
      "seazn_stream_pack_1",
      "seazn_stream_pack_5",
      "seazn_stream_pack_20",
    ]);
    expect(streamPack(5)?.credits).toBe(5);
    expect(streamPack(7)).toBeUndefined();
    // `Number("")` is 0 and `Number(undefined)` is NaN — neither is a pack, and
    // the webhook's catalogue fallback leans on that (S8, empty input).
    expect(streamPack(0)).toBeUndefined();
    expect(streamPack(Number.NaN)).toBeUndefined();
    // THE compile-time half of the catalogue's i18n contract. `labelKey` is a
    // local union in stream-credit-packs.ts (that module has to typecheck under
    // tsconfig.scripts.json, where `@/lib/messages` cannot resolve), so this
    // annotation is what holds the union to the real `en/ui.json` surface:
    // a key that is not a MessageKey fails `tsc -p apps/web` right here. The
    // runtime half below catches a key that exists in the type but was never
    // authored — which is exactly how a tile renders an empty caption.
    const labelKeys: MessageKey[] = STREAM_CREDIT_PACKS.map((p) => p.labelKey);
    expect(labelKeys).toHaveLength(3);
    for (const k of labelKeys) expect(messages[k]?.length).toBeGreaterThan(0);
  });
  it("formats sandbox prices as the sheet shows them (§8b)", () => {
    expect(STREAM_CREDIT_PACKS.map((p) => [formatGbp(p.gbpPence), perMatchGbp(p)])).toEqual([
      ["£6", "£6"],
      ["£25", "£5"],
      ["£80", "£4"],
    ]);
    // The pence branch: no pack uses it today, so without this the `% 100`
    // test is a whole dead limb the moment the owner rules real prices.
    expect(formatGbp(1999)).toBe("£19.99");
    expect(formatGbp(50)).toBe("£0.50");
  });
});

describe("buildRelayCheckoutParams", () => {
  const params = buildRelayCheckoutParams({
    priceId: "price_x",
    orgId: "org-1",
    fixtureId: "fx-1",
    pack: streamPack(5)!,
    returnUrl:
      "https://seazn.club/o/a/c/b/d/c?tab=fixtures&fixture=fx-1&stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}",
    currency: "gbp",
    customerEmail: "o@example.com",
  });
  it("is an EMBEDDED one-time payment (owner ruling 8: like the other checkouts) with the pack's price and a return_url that reopens the panel", () => {
    expect(params.mode).toBe("payment");
    expect(params.ui_mode).toBe("embedded_page");
    expect(params.line_items).toEqual([{ price: "price_x", quantity: 1 }]);
    expect(params.return_url).toContain("stream=open");
    expect(params.return_url).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect((params as { success_url?: string }).success_url).toBeUndefined();
    expect((params as { cancel_url?: string }).cancel_url).toBeUndefined();
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.currency).toBe("gbp");
    // No customer id was passed, so the buyer is identified by email — the
    // donor's branch, and the one a first-ever purchase takes.
    expect(params.customer_email).toBe("o@example.com");
    expect(params.customer).toBeUndefined();
    // THE OTHER MODE (S8): a returning buyer whose billing group already has a
    // Stripe customer. The two are exclusive — sending both is how a purchase
    // lands on a second customer record and the locked currency stops
    // matching. `customer_update` rides along so Stripe Tax can read the
    // address off the existing customer.
    const returning = buildRelayCheckoutParams({
      priceId: "price_x",
      orgId: "org-1",
      fixtureId: "fx-1",
      pack: streamPack(1)!,
      returnUrl: "https://a/?stream=open&session_id={CHECKOUT_SESSION_ID}",
      currency: "gbp",
      customerId: "cus_existing",
      customerEmail: "o@example.com",
    });
    expect(returning.customer).toBe("cus_existing");
    expect(returning.customer_email).toBeUndefined();
    expect(returning.customer_update).toBeDefined();
  });
  it("stamps the webhook contract: kind stream_credits, org, fixture, pack and a credits SNAPSHOT", () => {
    expect(params.metadata).toEqual({
      kind: "stream_credits",
      org_id: "org-1",
      fixture_id: "fx-1",
      pack: "5",
      credits: "5",
    });
    expect(params.payment_intent_data?.metadata).toEqual({
      kind: "stream_credits",
      org_id: "org-1",
      pack: "5",
    });
    // The AI credit WALLET is a different currency on a different ledger
    // (billing-events.ts `kind === "credit_pack"` → recordPackPurchase). The
    // two discriminators must never collide, or a match-credit purchase tops
    // up the wrong balance.
    expect(params.metadata?.kind).not.toBe("credit_pack");
  });
});

// `scripts/stripe-stream-packs.ts` writes ONE Stripe price per pack carrying a
// `currency_options` entry per non-GBP currency. If that key set ever falls
// short of what the platform quotes, `preferredCurrency` hands
// `buildRelayCheckoutParams` a currency the price has no option for, Stripe
// refuses the session, and the buyer meets a 500 with nothing to do about it.
//
// The script cannot assert this itself: it runs under `nodenext` +
// `--experimental-strip-types`, where importing `lib/currency.ts` reds twice
// (TS1543 on its JSON import, TS2307 on `@/lib/types`) and the `@/` alias does
// not resolve at runtime. So the table lives in `lib/stream-credit-packs.ts`,
// which the script CAN import, and the parity claim lives here, where
// `SUPPORTED_CURRENCIES` is importable. Add a fifth currency and this reds.
describe("STREAM_PACK_FX", () => {
  it("carries exactly the platform's non-GBP currencies — never a retyped subset", () => {
    expect(new Set(Object.keys(STREAM_PACK_FX))).toEqual(
      new Set(SUPPORTED_CURRENCIES.filter((c) => c !== "gbp")),
    );
    // GBP is the base the multipliers are applied TO — an option for it would
    // be a second, disagreeing GBP amount on the same price.
    expect(Object.keys(STREAM_PACK_FX)).not.toContain("gbp");
    // Non-vacuous: an empty table would satisfy a subset check.
    expect(Object.keys(STREAM_PACK_FX).length).toBeGreaterThan(0);
    for (const rate of Object.values(STREAM_PACK_FX)) expect(rate).toBeGreaterThan(0);
  });
});

describe("createRelayCheckout", () => {
  beforeEach(() => {
    stripeMock.pricesList.mockReset();
    stripeMock.sessionsCreate.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:37.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the price by lookup key and buckets the idempotency key to 30 s", async () => {
    stripeMock.pricesList.mockResolvedValue({ data: [{ id: "price_5" }] });
    stripeMock.sessionsCreate.mockResolvedValue({ id: "cs_1", client_secret: "cs_1_secret_abc" });
    const s = await createRelayCheckout({
      orgId: "org-1",
      fixtureId: "fx-1",
      size: 5,
      returnUrl: "https://a/?stream=open&session_id={CHECKOUT_SESSION_ID}",
      currency: "gbp",
    });
    expect(s.client_secret).toBe("cs_1_secret_abc");
    expect(stripeMock.pricesList).toHaveBeenCalledWith({
      lookup_keys: [streamPack(5)!.lookupKey],
      limit: 1,
    });
    const [sent, opts] = stripeMock.sessionsCreate.mock.calls[0]!;
    expect(sent.line_items).toEqual([{ price: "price_5", quantity: 1 }]);
    expect(opts.idempotencyKey).toBe(`relay-checkout-org-1-5-${Math.floor(Date.now() / 30_000)}`);
    // A SECOND call inside the same 30 s window reuses the key, so Stripe
    // replays the first session rather than opening a second charge (S8).
    // A different pack is a different purchase and gets its own key.
    await createRelayCheckout({
      orgId: "org-1",
      fixtureId: "fx-1",
      size: 5,
      returnUrl: "https://a/?stream=open&session_id={CHECKOUT_SESSION_ID}",
      currency: "gbp",
    });
    expect(stripeMock.sessionsCreate.mock.calls[1]![1].idempotencyKey).toBe(opts.idempotencyKey);
    vi.setSystemTime(new Date("2026-09-28T12:01:37.000Z"));
    await createRelayCheckout({
      orgId: "org-1",
      fixtureId: "fx-1",
      size: 5,
      returnUrl: "https://a/?stream=open&session_id={CHECKOUT_SESSION_ID}",
      currency: "gbp",
    });
    expect(stripeMock.sessionsCreate.mock.calls[2]![1].idempotencyKey).not.toBe(opts.idempotencyKey);
  });

  it("503s when the sandbox price has not been created yet", async () => {
    stripeMock.pricesList.mockResolvedValue({ data: [] });
    await expect(resolveStreamPackPriceId(streamPack(1)!)).rejects.toMatchObject({ status: 503 });
    // …and the refusal owes its accept (S2): the same call with a synced price
    // returns the id and never throws.
    stripeMock.pricesList.mockResolvedValue({ data: [{ id: "price_1" }] });
    await expect(resolveStreamPackPriceId(streamPack(1)!)).resolves.toBe("price_1");
  });
});
