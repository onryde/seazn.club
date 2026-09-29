// lib/stream-credit-packs.ts — THE match-credit pack catalogue (design §5.2,
// _THEMES.md §8b). Client-safe on purpose, because the tiles are meant to be
// rendered by a client component.
//
// Its readers, as of Task 14 fix round 4 (re-state this list whenever it
// changes — this header once called the tile fields INERT for a lane after the
// Phone tab had wired them, and this repo has six recorded cases of a comment
// describing the plan as if it had already happened):
//   * the Phone tab's credit tiles (components/v2/fixture-stream-panel.tsx):
//     `labelKey`, `popular`, and the amounts through `streamPackAmountMinor` /
//     `streamPackPerMatchMinor`;
//   * `/api/billing/relay-checkout` → lib/relay-checkout.ts: `size` → the pack,
//     `lookupKey` → the live Stripe price, `credits` → the grant snapshot;
//   * the webhook's catalogue fallback: `size` and `credits`;
//   * scripts/stripe-stream-packs.ts: creates each price FROM
//     `streamPackPriceAmounts` and refuses a live one `streamPackPriceDrift`
//     finds different (M3).
//
// ONE table, for however many readers arrive (P14: the panel's own
// CREDIT_PACKS display table was a second authority and is gone). Sandbox
// placeholders: £6 / £25 / £80; real prices are an owner ruling before the GA
// flip. A lookup key is never an env value, so `_INDEX.md` can record the
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
 * that is NOT a shortcut: `scripts/stripe-stream-packs.ts` imports this
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

export interface StreamCreditPack {
  size: StreamPackSize;
  credits: number;
  lookupKey: string;
  gbpPence: number;
  labelKey: StreamPackLabelKey;
  /** §8b: the 5-pack carries `border-purple-500` and the "Most clubs" chip. */
  popular: boolean;
}

export const STREAM_CREDIT_PACKS: readonly StreamCreditPack[] = [
  { size: 1, credits: 1, lookupKey: "seazn_stream_pack_1", gbpPence: 600, labelKey: "stream.credits.pack1", popular: false },
  { size: 5, credits: 5, lookupKey: "seazn_stream_pack_5", gbpPence: 2500, labelKey: "stream.credits.pack5", popular: true },
  { size: 20, credits: 20, lookupKey: "seazn_stream_pack_20", gbpPence: 8000, labelKey: "stream.credits.pack20", popular: false },
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
 * The non-GBP currency options every match-credit price carries, as rough
 * multipliers on the GBP amount. PLACEHOLDERS, like the GBP prices above, and
 * superseded by the owner's pre-GA pricing ruling.
 *
 * It lives HERE rather than in `scripts/stripe-stream-packs.ts`, which is its
 * only reader, for one reason: the key set has to stay equal to
 * `SUPPORTED_CURRENCIES` minus `gbp`, and the script CANNOT import
 * `lib/currency.ts` to check that itself. Measured 2026-09-28 under
 * `tsconfig.scripts.json` (`moduleResolution: "nodenext"`): that import reds
 * with TS1543 on currency.ts's own `@/config/stripe-plans.json` import (no
 * `with { type: "json" }` attribute) and TS2307 on its extensionless
 * `@/lib/types` — and `node --experimental-strip-types` would not resolve the
 * `@/` alias at runtime either. From here, a vitest test in `apps/web` can
 * import BOTH this table and `SUPPORTED_CURRENCIES` and red the day a fifth
 * currency is added. Without that, `preferredCurrency` would hand
 * `buildRelayCheckoutParams` a currency the Stripe price has no option for,
 * Stripe would refuse the session, and the buyer would see a 500.
 */
export const STREAM_PACK_FX: Readonly<Record<string, number>> = {
  eur: 1.17,
  usd: 1.33,
  inr: 111,
};

/**
 * P1 (Task 14 fix round 2): THE amounts a pack's Stripe price is created with — the GBP base plus one option per
 * `STREAM_PACK_FX` currency. `scripts/stripe-stream-packs.ts` spreads this into `stripe.prices.create`, and the
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
      Object.entries(STREAM_PACK_FX).map(([code, rate]) => [code, { unit_amount: Math.round(pack.gbpPence * rate) }]),
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
 * price script refuses to reuse one this reports anything for.
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
