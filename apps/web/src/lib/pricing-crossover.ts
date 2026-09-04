/**
 * Where the Event Pass stops being the cheaper offer and Pro starts.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * /pricing says the pass is a one-time payment and that Pro is a subscription,
 * and leaves the buyer to work out which one costs them less. Read plainly the
 * page says "the pass is cheaper", because the pass's sticker price is lower —
 * which pushes volume at the ONE-TIME sku when the recurring one is the
 * retention sku, and is only true up to a point nobody was naming.
 *
 * The point is real, and it is a genuinely good ladder: the pass is cheaper up
 * front and dearer per pound of entry fees, so for a competition that runs for
 * a month the two cross exactly once. Below the crossing the pass wins; above
 * it Pro does. Naming it sells Pro to the organisers Pro is actually cheaper
 * for, and sells the pass honestly to everyone else.
 *
 * ── Why nothing here is typed ────────────────────────────────────────────────
 * Every input is read at render time from the two sources the product bills
 * from: `config/stripe-plans.json` (via lib/currency's `passPrice`/`proPrice`)
 * and `registration.fee_percent` in `plan_entitlements`. A typed "$150" is the
 * stale-number failure this wave has already paid for twice — and the figure
 * moves with BOTH: V397 re-cut the fee ladder to 5/4/2/1, and W3 put every sku
 * on a charm price. It also differs per currency (usd $150, gbp £100), which a
 * literal cannot express at all.
 *
 * Kept separate from `pricing-cards.ts` on purpose: W3 redesigns the page this
 * renders on, and the derivation should survive the redesign even if the line's
 * placement does not.
 */

/** The four numbers the crossing is derived from, all in the same currency. */
export interface CrossoverInputs {
  /** One-time price of the pass rung, in minor units. */
  passMinor: number;
  /** ONE month of Pro, in minor units — the pass covers one competition for
   *  its lifetime, so a month is the honest unit to compare a month against. */
  proMonthlyMinor: number;
  /** `registration.fee_percent` on the pass rung. */
  passFeePercent: number | null | undefined;
  /** `registration.fee_percent` on Pro. */
  proFeePercent: number | null | undefined;
}

/**
 * Entry-fee volume (minor units, one month) at which the pass and one month of
 * Pro cost the same — or `null` when the two never cross.
 *
 *   pass total = passMinor       + F * passFee/100
 *   pro  total = proMonthlyMinor + F * proFee/100
 *
 * Equal when `F = 100 * (passMinor - proMonthlyMinor) / (proFee - passFee)`.
 *
 * `null` is returned whenever the ladder is not the shape the copy describes,
 * and each case is a real one rather than defensive noise:
 *
 *  - a fee row is missing or unreadable (`plan_entitlements` read failed, or a
 *    key lost its row) — an unknown rate must never be rendered as a promise,
 *    which is the rule `lib/pass-comparison.ts` applies to the same column;
 *  - the pass is not cheaper up front, or is not dearer per pound. Then one
 *    offer dominates the other everywhere and there is no crossing to name —
 *    saying there is one would invent a threshold. If a reprice ever makes Pro
 *    the cheaper sticker price, the LINE DISAPPEARS rather than quietly
 *    reversing its meaning.
 */
export function feeCrossoverMinor(input: CrossoverInputs): number | null {
  const { passMinor, proMonthlyMinor, passFeePercent, proFeePercent } = input;
  if (typeof passFeePercent !== "number" || typeof proFeePercent !== "number") return null;
  if (!(passMinor < proMonthlyMinor)) return null;
  if (!(passFeePercent > proFeePercent)) return null;
  return (100 * (passMinor - proMonthlyMinor)) / (proFeePercent - passFeePercent);
}

/**
 * The same figure, rounded to something a reader can hold in their head.
 *
 * Two significant figures of the MAJOR unit, never below one whole unit: usd
 * 15000 stays $150 and inr 500000 stays ₹5,000 today, and a future reprice
 * landing on 15037 renders "$150" rather than "$150.37" — a threshold quoted to
 * the cent reads as a rule rather than the guide it is, which is why the copy
 * that renders it says "about".
 */
export function readableMinor(amountMinor: number): number {
  const major = amountMinor / 100;
  if (!(major > 0) || !Number.isFinite(major)) return 0;
  const step = Math.max(1, 10 ** (Math.floor(Math.log10(major)) - 1));
  return Math.round(major / step) * step * 100;
}
