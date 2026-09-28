// lib/stream-credit-packs.ts — THE match-credit pack catalogue (design §5.2,
// _THEMES.md §8b). Client-safe on purpose: the Phone tab renders these tiles
// and the relay checkout charges them — one table, two readers (P14: the
// panel's own CREDIT_PACKS display table was a second authority and is gone).
// Sandbox placeholders: £6 / £25 / £80; real prices are an owner ruling
// before the GA flip. The lookup keys are the ONE name each price has in
// Stripe (scripts/stripe-stream-packs.ts creates them; relay-checkout.ts
// resolves them) — never an env value, so `_INDEX.md` can record the names.
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

export function formatGbp(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

export function perMatchGbp(pack: StreamCreditPack): string {
  return formatGbp(Math.round(pack.gbpPence / pack.credits));
}
