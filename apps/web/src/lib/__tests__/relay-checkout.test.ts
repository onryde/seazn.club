// The relay checkout's Stripe shape (design §5.2 on the credit-pack donor).
// Pure builder claims + one mocked-Stripe claim for the idempotency bucket.
// The catalogue is asserted against ITSELF only where the design fixes a
// number (three packs, sizes 1/5/20, sandbox £6/£25/£80) — those ARE the spec
// (_THEMES.md §8b), so they are the one place a literal is the oracle rather
// than a retyped copy of one (S10).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STREAM_CREDIT_PACKS, STREAM_PACK_FX, streamPack, streamPackAmountMinor, streamPackPerMatchMinor, streamPackPriceAmounts,
  streamPackPriceDrift,
} from "../stream-credit-packs";
import { messages, type MessageKey } from "@/lib/messages";
import { SUPPORTED_CURRENCIES, formatMinor } from "@/lib/currency";

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

import {
  buildRelayCheckoutParams, createRelayCheckout, relayCheckoutIdempotencyKey, resolveStreamPackPriceId,
} from "../relay-checkout";

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
    expect(
      STREAM_CREDIT_PACKS.map((p) => [
        formatMinor(streamPackAmountMinor(p, "gbp")!, "gbp", "en"),
        formatMinor(streamPackPerMatchMinor(p, "gbp")!, "gbp", "en"),
      ]),
    ).toEqual([
      ["£6", "£6"],
      ["£25", "£5"],
      ["£80", "£4"],
    ]);
  });

  // P1 (Task 14 fix round 2): the tiles quoted GBP while the checkout charged the buyer's preferredCurrency — capture
  // pass 2 saw a £25 tile open a $33.25 checkout. The tile's number and the Stripe price's number are now one function.
  // m10 (lane-close review): the check this replaces compared streamPackAmountMinor with streamPackPriceAmounts — but the
  // first CALLS the second, so it could not fail. The oracle now comes from outside the code under test: the owner's GBP
  // prices as literals (§8b sandbox £6 / £25 / £80), and every other currency derived from THOSE literals and the
  // declared FX table — never from either function.
  it("P1 (m10): the tile and the Stripe price both charge the owner's GBP literals, and every other currency is that literal × its declared FX rate", () => {
    const OWNER_GBP_PENCE: Readonly<Record<number, number>> = { 1: 600, 5: 2500, 20: 8000 };
    expect(STREAM_CREDIT_PACKS.map((p) => p.size).sort((x, y) => x - y), "one owner price per pack").toEqual(Object.keys(OWNER_GBP_PENCE).map(Number).sort((x, y) => x - y));
    const others = SUPPORTED_CURRENCIES.filter((c) => c !== "gbp");
    expect(Object.keys(STREAM_PACK_FX).sort(), "an FX rate for every other platform currency, and no stray one").toEqual([...others].sort());
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const gbp = OWNER_GBP_PENCE[pack.size]!;
      const price = streamPackPriceAmounts(pack);
      expect(price.currency, `${pack.size}: the price's base currency`).toBe("gbp");
      expect(price.unit_amount, `${pack.size} gbp: the Stripe price`).toBe(gbp);
      expect(streamPackAmountMinor(pack, "gbp"), `${pack.size} gbp: the tile`).toBe(gbp);
      expect(streamPackPerMatchMinor(pack, "gbp"), `${pack.size} gbp per match`).toBe(Math.round(gbp / pack.credits));
      checked++;
      for (const c of others) {
        const want = Math.round(gbp * STREAM_PACK_FX[c]!);
        expect(price.currency_options[c]?.unit_amount, `${pack.size} ${c}: the Stripe price's option`).toBe(want);
        expect(streamPackAmountMinor(pack, c), `${pack.size} ${c}: the tile`).toBe(want);
        expect(streamPackPerMatchMinor(pack, c), `${pack.size} ${c} per match`).toBe(Math.round(want / pack.credits));
        checked++;
      }
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length * SUPPORTED_CURRENCIES.length);
    expect(checked).toBe(12);
  });

  it("P1: one amount a REAL checkout charged, and no amount at all for a currency the price has no option for", () => {
    // Read off Stripe's embedded checkout in capture pass 2 (en-US, the 5-pack): $33.25. Not derived from the code.
    expect(streamPackAmountMinor(streamPack(5)!, "usd")).toBe(3325);
    // Per match is the NEAREST minor unit. Every sandbox price divides exactly, so a synthetic price is the only way to
    // witness it: £25.03 over 5 is 500.6p → 501p (a floor would say 500p).
    expect(streamPackPerMatchMinor({ ...streamPack(5)!, gbpPence: 2503 }, "gbp")).toBe(501);
    expect(streamPackPerMatchMinor({ ...streamPack(5)!, gbpPence: 2502 }, "gbp")).toBe(500);
    // No option ⇒ no quote — never the GBP number under another currency's sign, and never a prototype member.
    for (const c of ["jpy", "GBP", "", "constructor", "toString"]) {
      expect(streamPackAmountMinor(streamPack(5)!, c), c).toBeUndefined();
      expect(streamPackPerMatchMinor(streamPack(5)!, c), c).toBeUndefined();
    }
  });

  // M3 (fix round 4): the tiles quote `streamPackPriceAmounts`, but the checkout charges the LIVE Stripe price found by
  // lookup_key — and the price script reused any existing price by key without looking at it. `streamPackPriceDrift` is
  // the comparison the script now refuses on. The live price is built here from the authority, then moved one amount at
  // a time, so every currency of every pack is witnessed.
  describe("M3: streamPackPriceDrift", () => {
    /** A live price exactly as the table wants it — Stripe echoes the base currency in an expanded currency_options. */
    const livePrice = (pack: (typeof STREAM_CREDIT_PACKS)[number]) => {
      const want = streamPackPriceAmounts(pack);
      return {
        currency: want.currency as string,
        unit_amount: want.unit_amount as number | null,
        currency_options: { [want.currency]: { unit_amount: want.unit_amount }, ...want.currency_options } as Record<string, { unit_amount: number | null }>,
      };
    };

    it("a price equal to the table has NO drift — with or without Stripe's echo of the base currency", () => {
      let checked = 0;
      for (const pack of STREAM_CREDIT_PACKS) {
        expect(streamPackPriceDrift(pack, livePrice(pack)), pack.lookupKey).toEqual([]);
        const { currency_options: opts, ...rest } = livePrice(pack);
        const noEcho = { ...rest, currency_options: Object.fromEntries(Object.entries(opts).filter(([c]) => c !== rest.currency)) };
        expect(streamPackPriceDrift(pack, noEcho), `${pack.lookupKey} without the echo`).toEqual([]);
        checked++;
      }
      expect(checked).toBe(STREAM_CREDIT_PACKS.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("ONE amount moved, in any currency of any pack, is reported — naming that currency, the live and the table amount", () => {
      let checked = 0;
      for (const pack of STREAM_CREDIT_PACKS) {
        const want = streamPackPriceAmounts(pack);
        const table: Record<string, number> = {
          [want.currency]: want.unit_amount,
          ...Object.fromEntries(Object.entries(want.currency_options).map(([c, o]) => [c, o.unit_amount])),
        };
        for (const [currency, amount] of Object.entries(table)) {
          const live = livePrice(pack);
          if (currency === live.currency) live.unit_amount = amount + 1;
          else live.currency_options[currency] = { unit_amount: amount + 1 };
          expect(streamPackPriceDrift(pack, live), `${pack.lookupKey} ${currency}`).toEqual([{ at: currency, live: amount + 1, want: amount }]);
          checked++;
        }
      }
      // 3 packs × (the GBP base + one option per STREAM_PACK_FX currency).
      expect(checked).toBe(STREAM_CREDIT_PACKS.length * (1 + Object.keys(STREAM_PACK_FX).length));
      expect(checked).toBe(12);
    });

    it("a missing option, an option the table does not declare, a non-flat amount and another base currency are each drift", () => {
      const pack = streamPack(5)!;
      const want = streamPackPriceAmounts(pack);
      const missing = livePrice(pack);
      delete missing.currency_options.inr;
      expect(streamPackPriceDrift(pack, missing)).toEqual([{ at: "inr", live: null, want: want.currency_options.inr!.unit_amount }]);
      const extra = livePrice(pack);
      extra.currency_options.jpy = { unit_amount: 500 };
      expect(streamPackPriceDrift(pack, extra)).toEqual([{ at: "jpy", live: 500, want: null }]);
      const tiered = livePrice(pack);
      tiered.unit_amount = null;
      expect(streamPackPriceDrift(pack, tiered)).toEqual([{ at: "gbp", live: null, want: want.unit_amount }]);
      // An UNEXPANDED currency_options (absent) reads as every option missing — never as "matches".
      const bare = livePrice(pack) as { currency: string; unit_amount: number | null; currency_options?: Record<string, { unit_amount: number | null }> };
      delete bare.currency_options;
      expect(streamPackPriceDrift(pack, bare).map((d) => d.at).sort()).toEqual(Object.keys(STREAM_PACK_FX).sort());
      const usdBase = { ...livePrice(pack), currency: "usd" };
      expect(streamPackPriceDrift(pack, usdBase)).toContainEqual({ at: "base currency", live: "usd", want: "gbp" });
    });
  });

  it("P1: the price script creates each price FROM streamPackPriceAmounts — it computes no amount of its own", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "scripts", "stripe-stream-packs.ts"), "utf8");
    expect(src).toMatch(/\.\.\.streamPackPriceAmounts\(pack\)/);
    expect(src, "a second amount computation beside the shared one").not.toMatch(/unit_amount|gbpPence \*/);
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
    // D-A: a digest of the request, then the 30 s bucket — the bucket computed HERE, not read back from the code.
    expect(opts.idempotencyKey).toMatch(new RegExp(`^relay-checkout-[0-9a-f]{32}-${Math.floor(Date.now() / 30_000)}$`));
    // Stripe caps an idempotency key at 255 characters.
    expect(opts.idempotencyKey.length).toBeLessThanOrEqual(255);
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

  // D-A (capture pass 3). The key was `relay-checkout-<org>-<size>-<bucket>`, so the SAME pack bought for another fixture
  // (another return_url and metadata) or in another currency inside one 30 s bucket reused a key with DIFFERENT
  // parameters. Stripe refuses that (StripeIdempotencyError) and the route answered 502 "Checkout didn't open" — seen
  // three times in one pass. The key is now a digest of every parameter the Session is created with, plus the bucket.
  describe("D-A: the idempotency key", () => {
    type Args = Parameters<typeof createRelayCheckout>[0];
    // Every argument, spelled out (`Required` makes the compiler demand a new one here the day it is added). The
    // first-purchase shape — no Stripe customer yet, so the email is what Stripe is sent.
    const BASE: Required<Args> = {
      orgId: "org-1",
      fixtureId: "fx-1",
      size: 5,
      returnUrl: "https://seazn.club/o/a/c/b/d/c?tab=fixtures&fixture=fx-1&stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}",
      currency: "usd",
      customerId: null,
      customerEmail: "o@example.com",
    };
    /** One call, the price id Stripe resolves the pack's lookup key to, and the key and params it was sent with. */
    async function keyFor(args: Args, priceId = "price_5"): Promise<{ key: string; sent: Record<string, unknown> }> {
      stripeMock.pricesList.mockResolvedValueOnce({ data: [{ id: priceId }] });
      stripeMock.sessionsCreate.mockResolvedValueOnce({ id: "cs", client_secret: "cs_secret" });
      await createRelayCheckout(args);
      const [sent, opts] = stripeMock.sessionsCreate.mock.calls.at(-1)!;
      return { key: opts.idempotencyKey as string, sent };
    }

    it("a true double tap (the same request) reuses the key; every argument that changes the Session, ALONE, changes it", async () => {
      const base = await keyFor(BASE);
      expect((await keyFor({ ...BASE })).key, "a double tap must dedupe").toBe(base.key);
      // Each row moves ONE argument. The two repros from capture pass 3 are rows here: another fixture's return, and
      // another currency for the same pack.
      const VARIANTS: { [K in keyof Args]-?: Args[K] } = {
        orgId: "org-2",
        fixtureId: "fx-2",
        size: 20,
        returnUrl: BASE.returnUrl.replaceAll("fx-1", "fx-2"),
        currency: "gbp",
        customerId: "cus_existing",
        customerEmail: "treasurer@example.com",
      };
      expect(Object.keys(VARIANTS).sort(), "a createRelayCheckout argument with no row").toEqual(Object.keys(BASE).sort());
      let checked = 0;
      const seen = new Set([base.key]);
      for (const k of Object.keys(VARIANTS) as (keyof Args)[]) {
        const moved = await keyFor({ ...BASE, [k]: VARIANTS[k] });
        expect(moved.sent, `premise: ${k} changes what Stripe is sent`).not.toEqual(base.sent);
        expect(moved.key, `${k} alone collided with the base key`).not.toBe(base.key);
        seen.add(moved.key);
        checked++;
      }
      // The Stripe price the pack's lookup key resolves to is a parameter too (a re-minted price inside one bucket).
      const repriced = await keyFor(BASE, "price_5_v2");
      expect(repriced.key, "priceId alone collided").not.toBe(base.key);
      seen.add(repriced.key);
      checked++;
      expect(checked).toBe(Object.keys(BASE).length + 1);
      expect(seen.size, "two different requests shared a key").toBe(checked + 1);
    });

    it("the key follows what Stripe is SENT: arguments that do not change the request do not change the key", async () => {
      // A returning buyer is sent `customer`, never `customer_email` (the two are exclusive), so the email is not part
      // of the request — two taps that differ only there are the same request and must dedupe.
      const a = await keyFor({ ...BASE, customerId: "cus_existing", customerEmail: "o@example.com" });
      const b = await keyFor({ ...BASE, customerId: "cus_existing", customerEmail: "someone-else@example.com" });
      expect(b.sent, "premise: Stripe is sent the same thing").toEqual(a.sent);
      expect(b.key).toBe(a.key);
    });

    it("equal requests hash equal whatever order their fields were built in — nested objects included", () => {
      const params = buildRelayCheckoutParams({
        priceId: "price_5", orgId: "org-1", fixtureId: "fx-1", pack: streamPack(5)!, returnUrl: BASE.returnUrl, currency: "usd",
        customerEmail: "o@example.com",
      });
      const reversed = (o: unknown): unknown =>
        o && typeof o === "object" && !Array.isArray(o)
          ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reversed(v)]))
          : o;
      const flipped = reversed(params) as typeof params;
      expect(Object.keys(flipped), "premise: the field order really differs").not.toEqual(Object.keys(params));
      expect(Object.keys(flipped.metadata!), "premise: nested too").not.toEqual(Object.keys(params.metadata!));
      expect(relayCheckoutIdempotencyKey(flipped, 7)).toBe(relayCheckoutIdempotencyKey(params, 7));
      // …and the positive pair: one nested value moved is another key.
      expect(relayCheckoutIdempotencyKey({ ...params, metadata: { ...params.metadata, fixture_id: "fx-2" } }, 7)).not.toBe(
        relayCheckoutIdempotencyKey(params, 7),
      );
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

  it("503s when the sandbox price has not been created yet", async () => {
    stripeMock.pricesList.mockResolvedValue({ data: [] });
    await expect(resolveStreamPackPriceId(streamPack(1)!)).rejects.toMatchObject({ status: 503 });
    // …and the refusal owes its accept (S2): the same call with a synced price
    // returns the id and never throws.
    stripeMock.pricesList.mockResolvedValue({ data: [{ id: "price_1" }] });
    await expect(resolveStreamPackPriceId(streamPack(1)!)).resolves.toBe("price_1");
  });
});
