// Unit coverage for scripts/stripe-stream-packs.ts's `ensurePrice` (Streaming R1 lane D, Task 14 fix round 4, M3).
//
// The Phone tab's tiles quote `streamPackPriceAmounts`, but a checkout charges the LIVE Stripe price the pack's
// lookup_key resolves to. `ensurePrice` used to return any existing price by key without looking at it, so a price
// minted before a table change, or edited by hand, silently disagreed with every tile. It now compares, reuses only
// an equal price, and on a difference fails loudly — naming the pack and the currency — without touching Stripe.
//
// `ensurePrice` takes its Stripe client as a PARAMETER (stripe-connect-fixture.ts's shape), so the stub below proves
// every call without a key or a network. Importing the module is itself a test: it would throw "STRIPE_SECRET_KEY …
// is required" if the script still ran on import.
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePrice } from "../stripe-stream-packs.ts";
import {
  STREAM_CREDIT_PACKS,
  STREAM_PACK_FX,
  streamPackPriceAmounts,
  type StreamCreditPack,
} from "../../apps/web/src/lib/stream-credit-packs.ts";

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const stripe = { prices: { list, create, update } } as unknown as Stripe;

/** The live price exactly as the table wants it, with Stripe's echo of the base currency in the expanded options. */
function priceFor(pack: StreamCreditPack, id = `price_${pack.size}`) {
  const want = streamPackPriceAmounts(pack);
  return {
    id,
    currency: want.currency as string,
    unit_amount: want.unit_amount as number | null,
    currency_options: { [want.currency]: { unit_amount: want.unit_amount }, ...want.currency_options } as Record<
      string,
      { unit_amount: number | null }
    >,
  };
}

beforeEach(() => {
  list.mockReset();
  create.mockReset();
  update.mockReset();
});

describe("ensurePrice", () => {
  it("an existing price EQUAL to the table is reused — asked for with its currency options expanded, and nothing written", async () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      list.mockResolvedValueOnce({ data: [priceFor(pack)] });
      const line = await ensurePrice(stripe, "prod_1", pack);
      expect(line, pack.lookupKey).toContain(`price_${pack.size}`);
      expect(line, pack.lookupKey).toContain("existing");
      // Stripe omits currency_options unless expanded; without it every run would read "every option missing".
      expect(list).toHaveBeenLastCalledWith({ lookup_keys: [pack.lookupKey], limit: 1, expand: ["data.currency_options"] });
      checked++;
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length);
    expect(checked).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("an existing price whose amount DIFFERS in any currency throws, naming the pack and that currency — and changes nothing", async () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const want = streamPackPriceAmounts(pack);
      const table: Record<string, number> = {
        [want.currency]: want.unit_amount,
        ...Object.fromEntries(Object.entries(want.currency_options).map(([c, o]) => [c, o.unit_amount])),
      };
      for (const [currency, amount] of Object.entries(table)) {
        const live = priceFor(pack);
        if (currency === live.currency) live.unit_amount = amount + 7;
        else live.currency_options[currency] = { unit_amount: amount + 7 };
        list.mockResolvedValueOnce({ data: [live] });
        const err = await ensurePrice(stripe, "prod_1", pack).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err, `${pack.lookupKey} ${currency}: a drifted price was reused`).toBeInstanceOf(Error);
        expect(err!.message, `${pack.lookupKey} ${currency}`).toContain(pack.lookupKey);
        expect(err!.message, `${pack.lookupKey} ${currency}`).toContain(currency);
        expect(err!.message, `${pack.lookupKey} ${currency}: the live amount`).toContain(String(amount + 7));
        expect(err!.message, `${pack.lookupKey} ${currency}: the table amount`).toContain(String(amount));
        checked++;
      }
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length * (1 + Object.keys(STREAM_PACK_FX).length));
    // Fail loudly, never fix quietly: no replacement price, no archive, no edit.
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("a missing currency option is drift too — and the empty case, no price at all, creates one FROM the table", async () => {
    const pack = STREAM_CREDIT_PACKS[1]!;
    const live = priceFor(pack);
    delete live.currency_options.eur;
    list.mockResolvedValueOnce({ data: [live] });
    await expect(ensurePrice(stripe, "prod_1", pack)).rejects.toThrow(/eur/);
    expect(create).not.toHaveBeenCalled();

    list.mockResolvedValueOnce({ data: [] });
    create.mockResolvedValueOnce({ id: "price_new" });
    const line = await ensurePrice(stripe, "prod_1", pack);
    expect(line).toContain("price_new");
    expect(line).toContain("created");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      product: "prod_1",
      lookup_key: pack.lookupKey,
      ...streamPackPriceAmounts(pack),
    });
  });
});
