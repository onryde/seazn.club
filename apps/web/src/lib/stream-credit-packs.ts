// lib/stream-credit-packs.ts — THE match-credit pack catalogue (design §5.2,
// _THEMES.md §8b). Client-safe on purpose, because the tiles are meant to be
// rendered by a client component.
//
// Its readers, as of Task 14 fix round 4 (re-state this list whenever it
// changes — this header once called the tile fields INERT for a lane after the
// Phone tab had wired them, and this repo has six recorded cases of a comment
// describing the plan as if it had already happened):
//   * the Phone tab's credit tiles (components/v2/fixture-stream-panel/credits.tsx):
//     `labelKey`, `popular`, and the amounts through `streamPackAmountMinor` /
//     `streamPackPerMatchMinor`;
//   * `/api/billing/relay-checkout` → lib/relay-checkout.ts: `size` → the pack,
//     `lookupKey` → the live Stripe price, `credits` → the grant snapshot;
//   * the webhook's catalogue fallback: `size` and `credits`;
//   * scripts/stripe-sync.ts (`pnpm stripe:sync`, Addendum S — it replaced the
//     one-off scripts/stripe-stream-packs.ts): creates each price FROM
//     `streamPackPriceAmounts`, reuses a live one only when
//     `streamPackPriceDrift` finds nothing, and otherwise RE-MINTS it (a new
//     price with the lookup key, the old one archived) — the same policy every
//     other price in that script follows. `STREAM_PACK_PRICES_FINAL` gates it
//     on a live key;
//   * lib/relay-checkout.ts `resolveStreamPackPriceId`: the PROD drift guard,
//     which refuses to charge a price `streamPackPriceDrift` finds different.
//
// ONE table, for however many readers arrive (P14: the panel's own
// CREDIT_PACKS display table was a second authority and is gone). Prices as the owner
// set them on 2026-11-16 (£3 / £12 / £40, each other currency typed); the owner called them final for live Stripe on
// 2026-11-17 (`STREAM_PACK_PRICES_FINAL` is true, and stream-pack-prices-final.test.ts pins every amount). A lookup key is never an env value, so `_INDEX.md` can record the
// names.
//
// MATCH credits are NOT the AI credit wallet. That currency is
// `lib/credit-packs.ts` / `lib/credits.ts` and its webhook discriminator is
// `metadata.kind === "credit_pack"`; this one is `"stream_credits"` against
// `org_stream_credits`. The two tables, the two ledgers and the two
// discriminators are disjoint on purpose — a pack routed into the wrong one
// silently sells the buyer something they did not ask for.
export type StreamPackSize = 1 | 5 | 20;

/**
 * The three `ui.*` dictionary keys the tiles are captioned from.
 *
 * Declared here as a local union rather than imported as `MessageKey`, and
 * that is NOT a shortcut: `scripts/stripe-sync.ts` imports this
 * catalogue (one authority for the lookup keys), which drags this file into
 * `tsconfig.scripts.json` — `moduleResolution: "nodenext"`, where `@/lib/…`
 * does not resolve without an extension, and where `@/lib/messages.ts` DOES
 * resolve but then reds on its own JSON import needing a `with { type: "json" }`
 * attribute. Measured both ways, 2026-09-28. `lib/messages.ts` is imported by
 * hundreds of modules and is not this task's to change.
 *
 * The union is held to the REAL dictionary by a compile-time assertion in
 * `__tests__/relay-checkout.test.ts` (`const keys: MessageKey[] = …`), which
 * `tsc -p apps/web` does check — so a key that is not in `en/ui.json` is still
 * a build failure, just from the test file rather than from here.
 */
export type StreamPackLabelKey =
  | "stream.credits.pack1"
  | "stream.credits.pack5"
  | "stream.credits.pack20";

export type StreamPackOptionCurrency = "eur" | "usd" | "inr";

export interface StreamCreditPack {
  size: StreamPackSize;
  credits: number;
  lookupKey: string;
  /** The price in GBP, the Stripe price's base currency, in pence. */
  gbpPence: number;
  /** The price in every other currency the platform sells in, in that currency's minor unit. TYPED, not converted:
   *  the owner sets each one (2026-11-16), so a pack can be priced for its market instead of at a flat exchange rate. */
  options: Readonly<Record<StreamPackOptionCurrency, number>>;
  labelKey: StreamPackLabelKey;
  /** §8b: the 5-pack carries `border-purple-500` and the "Most clubs" chip. */
  popular: boolean;
}

/**
 * Addendum S (owner, 2026-09-29): are the prices in this table the REAL ones? While false they are sandbox
 * placeholders, and `pnpm stripe:sync` run with a LIVE key (`sk_live_…` / `rk_live_…`) SKIPS the stream packs and
 * says so loudly — a placeholder must never become a live price because someone synced plans. With a test key the
 * packs always sync. The owner flips this to true in the same change that sets the real prices, then runs sync.
 */
export const STREAM_PACK_PRICES_FINAL = true;

export const STREAM_CREDIT_PACKS: readonly StreamCreditPack[] = [
  { size: 1, credits: 1, lookupKey: "seazn_stream_pack_1", gbpPence: 300, options: { eur: 350, usd: 399, inr: 19900 }, labelKey: "stream.credits.pack1", popular: false },
  { size: 5, credits: 5, lookupKey: "seazn_stream_pack_5", gbpPence: 1200, options: { eur: 1400, usd: 1500, inr: 79900 }, labelKey: "stream.credits.pack5", popular: true },
  { size: 20, credits: 20, lookupKey: "seazn_stream_pack_20", gbpPence: 4000, options: { eur: 4500, usd: 4900, inr: 249900 }, labelKey: "stream.credits.pack20", popular: false },
];

/** The pack a SIZE names, or undefined. Deliberately takes `number`, not
 *  `StreamPackSize`: its callers are a zod-parsed body and the webhook's
 *  `Number(session.metadata.pack)` — both of which can hand it 0 (what
 *  `Number("")` is) or NaN (what `Number(undefined)` is), and neither must
 *  resolve to a pack. */
export function streamPack(size: number): StreamCreditPack | undefined {
  return STREAM_CREDIT_PACKS.find((p) => p.size === size);
}

/**
 * The non-GBP currencies every match-credit price carries an amount for (`StreamCreditPack.options`).
 *
 * It lives HERE rather than in `scripts/stripe-sync.ts` for one reason: the set has to stay equal to
 * `SUPPORTED_CURRENCIES` minus `gbp`, and the script CANNOT import `lib/currency.ts` to check that itself (measured
 * 2026-09-28 under `tsconfig.scripts.json`: TS1543 on its JSON import, TS2307 on its extensionless `@/lib/types`).
 * From here, a vitest test in `apps/web` imports BOTH this list and `SUPPORTED_CURRENCIES` and reds the day a fifth
 * currency is added. Without that, `preferredCurrency` would hand `buildRelayCheckoutParams` a currency the Stripe
 * price has no option for, Stripe would refuse the session, and the buyer would see a 500.
 */
export const STREAM_PACK_OPTION_CURRENCIES = ["eur", "usd", "inr"] as const;

/**
 * P1 (Task 14 fix round 2): THE amounts a pack's Stripe price is created with — the GBP base plus one typed option per
 * `STREAM_PACK_OPTION_CURRENCIES` currency. `scripts/stripe-sync.ts` spreads this into `stripe.prices.create`, and the
 * checkout charges the option for the buyer's `preferredCurrency` (`adaptive_pricing` off), so a tile that quotes
 * anything but these numbers quotes a price the buyer is not charged. The tiles read it back through
 * `streamPackAmountMinor`; nothing else computes a pack's price.
 */
export function streamPackPriceAmounts(pack: StreamCreditPack): {
  unit_amount: number;
  currency: "gbp";
  currency_options: Record<string, { unit_amount: number }>;
} {
  return {
    unit_amount: pack.gbpPence,
    currency: "gbp",
    currency_options: Object.fromEntries(
      STREAM_PACK_OPTION_CURRENCIES.map((code) => [code, { unit_amount: pack.options[code] }]),
    ),
  };
}

/** One way a LIVE Stripe price differs from `streamPackPriceAmounts`: `at` is the currency whose amount differs (or
 *  "base currency"), `live` / `want` the two values — null where one side has no amount at all. */
export interface StreamPackPriceDrift {
  at: string;
  live: number | string | null;
  want: number | string | null;
}

/**
 * M3 (Task 14 fix round 4): how a live Stripe price differs from what `streamPackPriceAmounts(pack)` says it is — empty
 * when it charges exactly the table's amounts. The tiles quote the table while a checkout charges the live price found by
 * lookup_key, so a price minted before a table change, or edited by hand, would silently disagree with every tile; the
 * sync (`pnpm stripe:sync`) re-mints one this reports anything for rather than reuse it.
 *
 * Compared per currency: the price's own currency at `unit_amount`, plus every `currency_options` entry (Stripe echoes
 * the base currency there once expanded — the base amount wins). A missing option, an option the table does not declare
 * and a non-flat (null) amount are all drift. `currency_options` absent reads as every option MISSING, never as a match:
 * the caller must list the price with `expand: ["data.currency_options"]`.
 */
export function streamPackPriceDrift(
  pack: StreamCreditPack,
  live: {
    currency: string;
    unit_amount: number | null;
    currency_options?: Record<string, { unit_amount: number | null }> | null;
  },
): StreamPackPriceDrift[] {
  const want = streamPackPriceAmounts(pack);
  const wantBy = new Map<string, number>([
    [want.currency, want.unit_amount],
    ...Object.entries(want.currency_options).map(([c, o]) => [c, o.unit_amount] as [string, number]),
  ]);
  const liveBy = new Map<string, number | null>([[live.currency, live.unit_amount]]);
  for (const [c, o] of Object.entries(live.currency_options ?? {})) if (!liveBy.has(c)) liveBy.set(c, o.unit_amount);
  const drift: StreamPackPriceDrift[] = [];
  if (live.currency !== want.currency) drift.push({ at: "base currency", live: live.currency, want: want.currency });
  for (const c of new Set([...wantBy.keys(), ...liveBy.keys()])) {
    const l = liveBy.has(c) ? liveBy.get(c)! : null;
    const w = wantBy.has(c) ? wantBy.get(c)! : null;
    if (l !== w) drift.push({ at: c, live: l, want: w });
  }
  return drift;
}

/** The pack's price in `currency`'s minor unit — the amount the checkout's line charges — or undefined for a currency
 *  the price carries no option for (the tile then quotes NO price, never a GBP one: see P1). */
export function streamPackAmountMinor(pack: StreamCreditPack, currency: string): number | undefined {
  const price = streamPackPriceAmounts(pack);
  if (currency === price.currency) return price.unit_amount;
  return Object.hasOwn(price.currency_options, currency) ? price.currency_options[currency]!.unit_amount : undefined;
}

/** §8b's "per match" line: the pack's price over its credits, rounded to the minor unit. */
export function streamPackPerMatchMinor(pack: StreamCreditPack, currency: string): number | undefined {
  const total = streamPackAmountMinor(pack, currency);
  return total === undefined ? undefined : Math.round(total / pack.credits);
}
