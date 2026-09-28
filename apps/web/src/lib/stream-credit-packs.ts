// lib/stream-credit-packs.ts — THE match-credit pack catalogue (design §5.2,
// _THEMES.md §8b). Client-safe on purpose, because the tiles are meant to be
// rendered by a client component.
//
// INERT, as of this commit. The tile fields — `labelKey`, `popular`,
// `gbpPence` — have NO production consumer: nothing renders a tile, and
// `/api/billing/relay-checkout` and `fetchRelayCheckoutClientSecret` have no
// caller either. Lane C wires the Phone tab and is what makes any of this
// reachable by a buyer; until it lands, no real purchase can reach the
// webhook branch. The only fields with live readers today are `lookupKey`
// (scripts/stripe-stream-packs.ts creates the prices; relay-checkout.ts
// resolves them), `size` and `credits` (the webhook's catalogue fallback).
// Stated plainly on purpose: this repo has six recorded cases of a seam left
// unwired because a comment described the plan as if it had already happened.
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

export function formatGbp(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

export function perMatchGbp(pack: StreamCreditPack): string {
  return formatGbp(Math.round(pack.gbpPence / pack.credits));
}
