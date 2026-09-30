// Addendum S (owner, 2026-09-29): the match-credit packs are synced by `pnpm stripe:sync` (scripts/stripe-sync.ts), on
// the SAME re-mint policy as every other price there — the owner re-prices by editing the table and running sync.
// This file replaces scripts/__tests__/stripe-stream-packs.test.ts, which covered the retired one-off script:
//   * an existing price EQUAL to the table is reused and nothing is written;
//   * a CHANGED amount (the base or any option) is ONE new price carrying the lookup key (transfer_lookup_key), then
//     the old price archived — never a thrown "fix it by hand" as the old script did;
//   * a MISSING currency option is a change too, and re-mints;
//   * the product is found by `metadata.kind = "stream_credits"`, oldest match wins;
//   * a LIVE key skips the packs, loudly, while STREAM_PACK_PRICES_FINAL is false; a test key always syncs them.
//
// Every Stripe call goes through a stub passed as a PARAMETER, so nothing here needs a key or a network. The amounts
// the stub is checked against come from the owner's GBP literals and the declared FX table, never from the builder
// under test alone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import {
  ensureStreamPackPrice,
  ensureStreamPackProduct,
  isLiveStripeKey,
  streamPackPriceCreateParams,
  STREAM_PACK_PRODUCT,
  syncStreamPacks,
} from "../../../../scripts/stripe-sync.ts";
import {
  STREAM_CREDIT_PACKS,
  STREAM_PACK_FX,
  STREAM_PACK_PRICES_FINAL,
  streamPackPriceAmounts,
  type StreamCreditPack,
} from "@/lib/stream-credit-packs";

type LivePrice = {
  id: string;
  product: string;
  currency: string;
  unit_amount: number | null;
  currency_options: Record<string, { unit_amount: number | null }>;
};
type LiveProduct = { id: string; created: number; metadata: Record<string, string> };

/** The live price exactly as the table wants it, with Stripe's echo of the base currency in the expanded options. */
function priceFor(pack: StreamCreditPack, id = `price_${pack.size}`): LivePrice {
  const want = streamPackPriceAmounts(pack);
  return {
    id,
    product: "prod_live",
    currency: want.currency,
    unit_amount: want.unit_amount,
    currency_options: { [want.currency]: { unit_amount: want.unit_amount }, ...want.currency_options },
  };
}

/** A Stripe stub recording every call in order. `prices` maps a lookup key to its live price (absent = none). */
function fakeStripe(opts: { prices?: Record<string, LivePrice | undefined>; products?: LiveProduct[] } = {}) {
  const calls: string[] = [];
  const pricesList = vi.fn(async (p: Stripe.PriceListParams) => {
    const key = p.lookup_keys![0]!;
    calls.push(`prices.list ${key}`);
    const live = opts.prices?.[key];
    return { data: live ? [live] : [] };
  });
  const pricesCreate = vi.fn(async (p: Stripe.PriceCreateParams) => {
    calls.push(`prices.create ${p.lookup_key}`);
    return { id: `price_new_${p.lookup_key}` };
  });
  const pricesUpdate = vi.fn(async (id: string, p: Stripe.PriceUpdateParams) => {
    calls.push(`prices.update ${id} active=${String(p.active)}`);
    return { id };
  });
  const productsList = vi.fn((p: Stripe.ProductListParams) => {
    calls.push(`products.list active=${String(p.active)}`);
    return {
      async *[Symbol.asyncIterator]() {
        for (const p of opts.products ?? []) yield p;
      },
    };
  });
  const productsCreate = vi.fn(async (p: Stripe.ProductCreateParams) => {
    calls.push("products.create");
    return { id: "prod_created", created: 999, metadata: p.metadata };
  });
  const stripe = {
    prices: { list: pricesList, create: pricesCreate, update: pricesUpdate },
    products: { list: productsList, create: productsCreate },
  } as unknown as Stripe;
  return { stripe, calls, pricesList, pricesCreate, pricesUpdate, productsList, productsCreate };
}

/** The owner's GBP prices (§8b sandbox £6 / £25 / £80), in pence — the oracle, typed here on purpose. */
const OWNER_GBP_PENCE: Readonly<Record<number, number>> = { 1: 600, 5: 2500, 20: 8000 };

afterEach(() => vi.restoreAllMocks());

describe("streamPackPriceCreateParams — the price sync mints, from the table and nothing else", () => {
  it("carries the lookup key (transferred), the owner's GBP amount and each FX option derived from it, and the stream_credits tag", () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const gbp = OWNER_GBP_PENCE[pack.size]!;
      const params = streamPackPriceCreateParams(pack, "prod_x");
      expect(params).toMatchObject({
        product: "prod_x",
        lookup_key: pack.lookupKey,
        transfer_lookup_key: true,
        currency: "gbp",
        unit_amount: gbp,
        metadata: { kind: "stream_credits", credits: String(pack.credits) },
      });
      expect(params.currency_options).toEqual(
        Object.fromEntries(Object.entries(STREAM_PACK_FX).map(([c, rate]) => [c, { unit_amount: Math.round(gbp * rate) }])),
      );
      checked++;
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length);
    expect(checked).toBe(3);
  });

  it("the sync computes no amount of its own — no gbpPence arithmetic, no FX table read beside streamPackPriceAmounts", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "stripe-sync.ts"), "utf8");
    expect(src).toMatch(/\.\.\.streamPackPriceAmounts\(pack\)/);
    expect(src, "a second amount computation beside the shared one").not.toMatch(/gbpPence|STREAM_PACK_FX/);
  });
});

describe("ensureStreamPackPrice — the re-mint policy every other price in stripe:sync follows", () => {
  it("an existing price EQUAL to the table is reused — listed with its currency options expanded — and nothing is written", async () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const f = fakeStripe({ prices: { [pack.lookupKey]: priceFor(pack) } });
      expect(await ensureStreamPackPrice(f.stripe, "prod_1", pack)).toEqual({ priceId: `price_${pack.size}`, action: "existing" });
      // Stripe omits currency_options unless expanded; without it every run would read "every option missing".
      expect(f.pricesList).toHaveBeenCalledWith({ lookup_keys: [pack.lookupKey], limit: 1, expand: ["data.currency_options"] });
      expect(f.calls, pack.lookupKey).toEqual([`prices.list ${pack.lookupKey}`]);
      checked++;
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length);
  });

  it("a CHANGED amount in any currency is ONE new price with the lookup key transferred and the table's amounts, THEN the old one archived", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const want = streamPackPriceAmounts(pack);
      const table: Record<string, number> = {
        [want.currency]: want.unit_amount,
        ...Object.fromEntries(Object.entries(want.currency_options).map(([c, o]) => [c, o.unit_amount])),
      };
      for (const [currency, amount] of Object.entries(table)) {
        const live = priceFor(pack, `price_old_${pack.size}`);
        if (currency === live.currency) live.unit_amount = amount + 7;
        else live.currency_options[currency] = { unit_amount: amount + 7 };
        const f = fakeStripe({ prices: { [pack.lookupKey]: live } });
        const label = `${pack.lookupKey} ${currency}`;
        expect(await ensureStreamPackPrice(f.stripe, "prod_1", pack), label).toEqual({ priceId: `price_new_${pack.lookupKey}`, action: "re-minted" });
        // Mint first, archive second: archiving first would leave the lookup key resolving to nothing for a checkout.
        expect(f.calls, label).toEqual([`prices.list ${pack.lookupKey}`, `prices.create ${pack.lookupKey}`, `prices.update price_old_${pack.size} active=false`]);
        // On the product the live price hangs off, with the table's amounts — never the drifted ones.
        expect(f.pricesCreate.mock.calls[0]![0], label).toEqual(streamPackPriceCreateParams(pack, "prod_live"));
        expect(f.pricesUpdate, label).toHaveBeenCalledWith(`price_old_${pack.size}`, { active: false });
        checked++;
      }
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length * (1 + Object.keys(STREAM_PACK_FX).length));
    expect(log.mock.calls.some(([m]) => String(m).includes("drift → new price")), "the re-mint is reported").toBe(true);
  });

  it("a MISSING currency option is a change too — re-minted, not reused and not refused", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let checked = 0;
    for (const currency of Object.keys(STREAM_PACK_FX)) {
      const pack = STREAM_CREDIT_PACKS[1]!;
      const live = priceFor(pack, "price_old");
      delete live.currency_options[currency];
      const f = fakeStripe({ prices: { [pack.lookupKey]: live } });
      expect(await ensureStreamPackPrice(f.stripe, "prod_1", pack), currency).toEqual({ priceId: `price_new_${pack.lookupKey}`, action: "re-minted" });
      expect(f.pricesCreate, currency).toHaveBeenCalledTimes(1);
      expect(f.pricesUpdate, currency).toHaveBeenCalledWith("price_old", { active: false });
      checked++;
    }
    expect(checked).toBe(Object.keys(STREAM_PACK_FX).length);
  });

  it("the empty case — no price at all — creates one FROM the table on the given product, and archives nothing", async () => {
    const pack = STREAM_CREDIT_PACKS[2]!;
    const f = fakeStripe();
    expect(await ensureStreamPackPrice(f.stripe, "prod_1", pack)).toEqual({ priceId: `price_new_${pack.lookupKey}`, action: "created" });
    expect(f.calls).toEqual([`prices.list ${pack.lookupKey}`, `prices.create ${pack.lookupKey}`]);
    expect(f.pricesCreate.mock.calls[0]![0]).toEqual(streamPackPriceCreateParams(pack, "prod_1"));
  });
});

describe("ensureStreamPackProduct — found by its tag, oldest match wins", () => {
  it("the OLDEST active product tagged kind=stream_credits, whatever its name and whatever else is listed", async () => {
    const f = fakeStripe({
      products: [
        { id: "prod_ai", created: 50, metadata: { kind: "credit_pack" } },
        { id: "prod_young", created: 300, metadata: { kind: "stream_credits" } },
        { id: "prod_old", created: 100, metadata: { kind: "stream_credits" } },
        { id: "prod_untagged", created: 10, metadata: {} },
      ],
    });
    expect(await ensureStreamPackProduct(f.stripe)).toBe("prod_old");
    expect(f.productsList).toHaveBeenCalledWith({ active: true, limit: 100 });
    expect(f.productsCreate).not.toHaveBeenCalled();
  });

  it("none tagged → one product created, tagged, with the pack product's copy", async () => {
    const f = fakeStripe({ products: [{ id: "prod_ai", created: 50, metadata: { kind: "credit_pack" } }] });
    expect(await ensureStreamPackProduct(f.stripe)).toBe("prod_created");
    expect(f.productsCreate).toHaveBeenCalledWith({ ...STREAM_PACK_PRODUCT, metadata: { kind: "stream_credits" } });
  });
});

describe("syncStreamPacks — the live-key guard (STREAM_PACK_PRICES_FINAL)", () => {
  it("the table is NOT final today: its prices are sandbox placeholders (owner, Addendum S)", () => {
    expect(STREAM_PACK_PRICES_FINAL).toBe(false);
  });

  it("a key is live unless it is a test key — an unrecognised key is treated as live, so the guard fails safe", () => {
    const cases: [string, boolean][] = [["sk_live_abc", true], ["rk_live_abc", true], ["sk_test_abc", false], ["rk_test_abc", false], ["weird", true]];
    let checked = 0;
    for (const [key, live] of cases) {
      expect(isLiveStripeKey(key), key).toBe(live);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("LIVE key while not final: SKIPS every pack — not one Stripe call — and says so loudly", async () => {
    let checked = 0;
    for (const key of ["sk_live_abc", "rk_live_abc"]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = fakeStripe();
      expect(await syncStreamPacks(f.stripe, key, false), key).toEqual({ skipped: true, prices: [] });
      expect(f.calls, `${key}: a skipped sync still called Stripe`).toEqual([]);
      const note = warn.mock.calls.map(([m]) => String(m)).join("\n");
      expect(note, key).toMatch(/SKIPPED/);
      expect(note, key).toMatch(/STREAM_PACK_PRICES_FINAL/);
      warn.mockRestore();
      checked++;
    }
    expect(checked).toBe(2);
    // The default reads the constant: with no third argument a live key is skipped today.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeStripe();
    expect(await syncStreamPacks(f.stripe, "sk_live_abc")).toEqual({ skipped: true, prices: [] });
    expect(f.calls).toEqual([]);
  });

  it("TEST key: always syncs every pack; LIVE key once final: syncs too", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let checked = 0;
    for (const [key, final] of [["sk_test_abc", false], ["rk_test_abc", false], ["sk_test_abc", true], ["sk_live_abc", true]] as const) {
      const f = fakeStripe({ products: [{ id: "prod_old", created: 1, metadata: { kind: "stream_credits" } }] });
      const out = await syncStreamPacks(f.stripe, key, final);
      expect(out.skipped, `${key} final=${final}`).toBe(false);
      expect(out.prices.map((p) => p.action), `${key} final=${final}`).toEqual(STREAM_CREDIT_PACKS.map(() => "created"));
      expect(f.calls.filter((c) => c.startsWith("prices.create")), `${key} final=${final}`).toHaveLength(STREAM_CREDIT_PACKS.length);
      expect(f.pricesCreate.mock.calls.every(([p]) => p.product === "prod_old"), "every pack on the one tagged product").toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("main() runs it: `pnpm stripe:sync` reaches the packs with the process's own key", () => {
    // main() needs a database and a key, so its wiring is read, not run — the seam every test above drives is the
    // function it calls.
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "stripe-sync.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main()"));
    expect(main).toMatch(/await syncStreamPacks\(stripe, key\)/);
  });
});
