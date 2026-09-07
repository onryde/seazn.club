// The Event Pass rung ladder (v17 #294, spec A7) — the data behind the M/L
// picker on a competition's upgrade page.
//
// Pure by design. The caps are NOT queried here: the upgrade page already reads
// `plan_entitlements` once for its comparison table, and this takes those same
// values, so the picker and the table can never disagree about what L grants.
// (lib/pass-comparison.ts explains at length why no figure in this feature is
// written down in code or copy.) Prices come from `lib/currency`'s
// stripe-plans.json-backed `passPrice` for the same reason — one price list,
// the same one `stripe:sync` pushes to Stripe.
import {
  SELLABLE_PASS_KEYS,
  passPrice,
  type Currency,
  type PassKey,
  type SellablePassKey,
} from "@/lib/currency";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import type { Dict } from "@/lib/i18n-constants";
import type { DictionaryKey } from "@/lib/i18n-keys";
// TYPE-ONLY, and it has to stay that way: `@/lib/entitlements` pulls in postgres
// and ioredis, and this module is imported by client islands (upgrade-gate,
// pass-upgrade). A type import is erased; a value import would put the database
// in the browser bundle.
import type { PassLockReason } from "@/lib/entitlements";
import { t } from "@/lib/i18n-runtime";

export interface PassRungOption {
  /** `PassKey`, deliberately wider than `PassRungCaps` below. WHICH rungs are
   *  offered is decided once, by `passLadderOptions`, the only producer of
   *  these; `<PassRungLadder>` is a presentation component that renders the
   *  ladder it is handed. Narrowing this to `SellablePassKey` would put the
   *  authority in two places and, worse, would make the picker's multi-rung
   *  behaviour — the pre-selected default the real-money e2e suite clicks
   *  through — impossible to test at all while one rung is on sale. */
  key: PassKey;
  /** Price in the display currency's minor units. */
  amountMinor: number;
  /** null = unlimited — `plan_entitlements`' own convention for "no ceiling". */
  entrants: number | null;
  divisions: number | null;
  /** AI credits granted on purchase. PER RUNG since entitlements v18 W2 T5
   *  (design R9): M grants 25, L grants 50. It was flat, and while it was, this
   *  card advertised M's 25 beside L's price — the number a buyer reads on the
   *  rung they are about to pick. */
  credits: number;
}

/** A ladder row as `passLadderOptions` PRODUCES it — narrowed to a rung that is
 *  actually on sale. `<PassRungLadder>` takes the wider `PassRungOption`,
 *  because a presentation component renders whatever ladder it is handed; this
 *  is what a CALLER gets back, so a surface that also labels the rung (the
 *  `/pricing` card reads `PASS_RUNG_MARKETING_KEY`, which is keyed by the
 *  sellable set) type-checks without a cast. */
export interface SellablePassRungOption extends PassRungOption {
  key: SellablePassKey;
}

/** Caps for the rungs the ladder RENDERS — keyed by `SellablePassKey`, not by
 *  `PassKey`. A rung that is off sale is never quoted here, so asking a caller
 *  for its caps would be asking it to read a matrix row it must not print. */
export type PassRungCaps = Readonly<
  Record<SellablePassKey, { entrants: number | null; divisions: number | null }>
>;

/**
 * The rungs ON SALE, cheapest-size first, priced in `currency`, with the
 * caller's live caps.
 *
 * Ordered smallest-first because that is the order the stub renders and the
 * order the buyer reads; the first element is also what the picker pre-selects,
 * so it is the default sale.
 *
 * `SELLABLE_PASS_KEYS`, never `PASS_KEYS` (owner decision 2026-09-05, the L
 * rung off sale). This is the buy ladder — the one place a customer picks a
 * rung — so it reads the authority rather than the full rung set. The full set
 * stays complete for resolution, and `PASS_RUNG_NAME_KEY` below is still keyed
 * by it, because a held pass must go on naming whichever rung it is.
 */
export function passLadderOptions(
  currency: Currency,
  caps: PassRungCaps,
): SellablePassRungOption[] {
  return SELLABLE_PASS_KEYS.map((key) => ({
    key,
    amountMinor: passPrice(currency, key),
    entrants: caps[key].entrants,
    divisions: caps[key].divisions,
    credits: PASS_CREDIT_GRANT[key],
  }));
}

/** A rung with a price attached — the least any "which of these is cheapest"
 *  question needs to know. Structural so `PassRungOption` satisfies it too. */
export interface PricedRung {
  key: PassKey;
  amountMinor: number;
}

/**
 * The cheapest of some priced rungs, ties going to the earlier one.
 *
 * Split out from `lowestPassRung` so the CHOICE can be tested against a price
 * list where the answer is not M. Against the live seed M is cheapest in all
 * five currencies, so a "lowest" that simply returned `event_pass` would pass
 * every assertion made against the real numbers — and would keep passing on the
 * day L is discounted or a rung is added underneath.
 *
 * Ties keep ladder order because the price is quoted NEXT TO a rung name on
 * some surfaces; a coin-flip between equal amounts would flip the name.
 */
export function lowestPricedRung<T extends PricedRung>(rungs: readonly T[]): T {
  // PASS_KEYS is a non-empty `as const` tuple and every caller derives from it,
  // so there is always a first element to reduce from.
  return rungs.reduce((lowest, rung) => (rung.amountMinor < lowest.amountMinor ? rung : lowest));
}

/**
 * The rung a surface should quote when it shows ONE price for a product that
 * sells at two — "Event Pass — from $29 one-time".
 *
 * Five surfaces (the paywall, the billing-page offer, the dashboard card menu,
 * the competition header and competition settings) invite a purchase without
 * offering the choice; the choice itself lives on the upgrade page. Each of them
 * passed the literal `"event_pass"` to `passPrice`, which is honest only while M
 * is the cheapest rung — an assumption `tsc` cannot see and no test held. This
 * derives it instead, and hands back the KEY as well as the amount so a caller
 * that also names the rung cannot name a different one from the one it priced.
 */
export function lowestPassRung(currency: Currency): PricedRung {
  // SELLABLE, not every rung. A "from" price is an offer, and quoting the floor
  // of a ladder that includes a rung nobody can buy advertises a price the
  // checkout would refuse — which is a worse version of the mis-sale the "from"
  // wording exists to prevent. Today the entry rung is cheapest anyway, so this
  // choice is invisible in the numbers; it stops being invisible the moment a
  // hidden rung is discounted.
  return lowestPricedRung(
    SELLABLE_PASS_KEYS.map((key) => ({ key, amountMinor: passPrice(currency, key) })),
  );
}

/**
 * "Event Pass L active" — the held signal, NAMING the rung.
 *
 * The three surfaces that render it (the dashboard card's seal, the competition
 * header, competition settings) said a flat "Event Pass active": the product
 * FAMILY, with nothing beside it to say which size. That reads as M's name to an
 * org that paid $59 for L, on the only surfaces where the rung is not disclosed
 * anywhere else — the upgrade page's own stub prints `data-pass-held-rung`
 * immediately under the family name, which is why it needs no change.
 *
 * A helper rather than a `t(dict, "pass.entry.active", { rung })` at each call
 * site: `t()` renders a forgotten var as the literal `{rung}`, and three call
 * sites each remembering is three chances to ship a brace to a customer.
 */
export function passActiveLabel(dict: Dict, passKey: PassKey): string {
  return t(dict, "pass.entry.active", { rung: t(dict, PASS_RUNG_NAME_KEY[passKey]) });
}

/**
 * Both rungs' held signals, finished.
 *
 * The pages that mount `<CompetitionPassEntry>` hold the dictionary but not the
 * rung — the pass row is resolved once by the competition LAYOUT and reaches the
 * island through `CompetitionPassProvider`. So the page hands over every label
 * and the island picks the one it knows about.
 *
 * An explicit object literal, not `Object.fromEntries(PASS_KEYS.map(…))`: a
 * third rung must be a compile error here, not a card that silently falls back
 * to a missing key.
 */
export function passActiveLabels(dict: Dict): Record<PassKey, string> {
  return {
    event_pass: passActiveLabel(dict, "event_pass"),
    event_pass_l: passActiveLabel(dict, "event_pass_l"),
  };
}

/**
 * WHY a held pass has stopped applying, as a dictionary key (v17 gap #301).
 *
 * A `Record<PassLockReason, DictionaryKey>` keyed off the union, and that is the
 * whole point: `PASS_LOCK_REASONS` is the one place the reason set is written
 * down, and a third reason added there must be a COMPILE ERROR here rather than
 * a card that silently shows the wrong sentence — or none. A chain of
 * `=== "terminal" ? … : …` (which is what every surface reached for first) gets
 * no such protection: it keeps compiling and quietly files the new reason under
 * "ran past its end date".
 *
 * The two sentences differ because the two situations do. A competition that
 * reached a terminal status is DONE and the organiser's next move is next
 * season; one that merely ran past `ends_on` is often still being played, and
 * the end date is the thing to fix. Collapsing them shows an apologetic "your
 * pass has ended" to someone whose only problem is a stale date.
 */
export const PASS_LOCK_REASON_KEY: Record<PassLockReason, DictionaryKey> = {
  terminal: "pass.entry.ended.reasonTerminal",
  past_ends_on: "pass.entry.ended.reasonPastEnds",
};

/**
 * The same two reasons, said to someone who never bought a pass (#376).
 *
 * A separate Record rather than a reuse of `PASS_LOCK_REASON_KEY`: every one
 * of those sentences ends "so its Event Pass has stopped lifting its limits",
 * which is a statement about a purchase. On this state there was no purchase,
 * and the sentence would be a plain falsehood on the one screen that exists to
 * explain what the org can and cannot buy.
 *
 * Keyed off the union for the same compile-error protection.
 */
export const PASS_CLOSED_REASON_KEY: Record<PassLockReason, DictionaryKey> = {
  terminal: "upgrade.closed.reasonTerminal",
  past_ends_on: "upgrade.closed.reasonPastEnds",
};

/**
 * Every lock reason's sentence, finished — `passActiveLabels` for the ended
 * state, and here for the same reason.
 *
 * The pages that mount `<CompetitionPassEntry>` hold the dictionary but not the
 * reason: `passLockReason` is judged once by the competition LAYOUT (it lives in
 * a server module, so a client island cannot call it at all) and reaches the
 * island through `CompetitionPassProvider`. So the page hands over every
 * sentence and the island picks the one it knows about.
 *
 * An explicit object literal rather than `Object.fromEntries(PASS_LOCK_REASONS
 * .map(…))`, exactly as `passActiveLabels` is: the `fromEntries` form types as a
 * complete Record whatever it actually contains, so a missing arm would resolve
 * to `undefined` and render an empty explanation under "Event Pass ended".
 */
export function passEndedReasons(dict: Dict): Record<PassLockReason, string> {
  return {
    terminal: t(dict, PASS_LOCK_REASON_KEY.terminal),
    past_ends_on: t(dict, PASS_LOCK_REASON_KEY.past_ends_on),
  };
}

/**
 * The rung's full NAME, as a dictionary key — "Event Pass L". Used where the
 * rung has to identify itself away from the ladder: the held ticket stub, the
 * comparison column.
 *
 * A `Record<PassKey, …>` rather than a ternary so a third rung added to
 * `PASS_KEYS` is a compile error here instead of a silently mislabelled ticket.
 */
export const PASS_RUNG_NAME_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "upgrade.rung.m",
  event_pass_l: "upgrade.rung.l",
};

/**
 * The rung's SIZE CODE, as a dictionary key — "M", "L". Used inside the ladder,
 * where "Event Pass" is already the name on the ticket and repeating it twice
 * per row is noise.
 *
 * Translatable despite being one letter: a locale that ships sizes in its own
 * words needs its own initials (fr Moyen/Grand → M/G), and nothing user-facing
 * in this product is allowed to be a literal in the component.
 */
export const PASS_RUNG_SIZE_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "upgrade.rung.sizeM",
  event_pass_l: "upgrade.rung.sizeL",
};

/**
 * The size code again, in the MARKETING dictionary — for `/pricing`, which
 * loads `marketing` and not `ui`, and would otherwise have to ship a second
 * dictionary to a page that needs two words from it.
 *
 * Keyed by `SellablePassKey`, unlike the two maps above, and the split is the
 * point. Those two label a rung a customer HOLDS, so they stay complete; this
 * one labels a rung a customer is being OFFERED, and `/pricing` offers only
 * what is on sale. A hidden rung with a marketing label here is a label with
 * nowhere to render — and the day it does render is the day the page advertises
 * a rung the owner withdrew.
 *
 * Same compile-error discipline either way: a rung added to
 * `SELLABLE_PASS_KEYS` without an entry here is a type error rather than a
 * `/pricing` card that silently prices two sizes and labels one.
 */
export const PASS_RUNG_MARKETING_KEY: Record<SellablePassKey, DictionaryKey> = {
  event_pass: "pricing.pass.rung.m",
};

/**
 * Does a rung letter earn its place on a surface that is SELLING a pass?
 *
 * A size code is a disambiguator, and it only has a job when there is more
 * than one size to be confused with. With a single rung on sale, "M" names a
 * size that appears nowhere else the reader can see — not on `/pricing`'s
 * ticket stub, not in its matrix column, not on the invoice — and a lone
 * letter with no sibling reads as a product they have not been shown rather
 * than as the one they are looking at.
 *
 * Takes the COUNT rather than reading `SELLABLE_PASS_KEYS` itself so a test
 * can drive both directions; every production caller passes
 * `SELLABLE_PASS_KEYS.length`, so the letter returns on its own the day a
 * second rung goes back on sale instead of needing four surfaces remembered.
 *
 * **The catalogue's count, never the reader's.** `passLadderOptions` filters
 * to the rungs THIS org may still buy (#327 — on a paid plan, only rungs that
 * beat it), so a Pro org can be shown one option out of two on sale. That is a
 * one-org view of a two-rung product, and the letter must still be printed:
 * the sibling exists on every other surface, which is exactly the confusion
 * this answers.
 *
 * Deliberately `> 1` and not `>= 1`: at zero there is nothing on sale, so
 * there is no selling surface to name a rung on, and the answer is the same
 * "no" as at one.
 *
 * NOT for surfaces describing a pass the org HOLDS. `PASS_RUNG_NAME_KEY` and
 * `passActiveLabel` stay complete over `PassKey` for that reason: L is off
 * sale but rows holding it are live, and a $44.99 buyer reading their own
 * competition as the $11.99 product is the v17 #294 mis-sale exactly.
 */
export function rungNamingRequired(sellableCount: number): boolean {
  return sellableCount > 1;
}

/**
 * What to call a rung being OFFERED — "Event Pass M" while two sizes sell,
 * plain "Event Pass" while one does.
 *
 * The offer/hold split this expresses is the same one `PASS_RUNG_MARKETING_KEY`
 * draws against `PASS_RUNG_NAME_KEY` above; this is that rule applied to the
 * in-app buy page, which had been borrowing the hold-side map and so kept
 * printing a letter after the ruling that removed it from `/pricing`.
 */
export function offeredRungName(dict: Dict, rung: PassKey, sellableCount: number): string {
  return rungNamingRequired(sellableCount)
    ? t(dict, PASS_RUNG_NAME_KEY[rung])
    : t(dict, "upgrade.rung.plain");
}

/**
 * Which localised sentence a failed checkout gets, from the HTTP status alone.
 *
 * The buyer must never be shown the server's own text. Every message
 * `/api/billing/pass-checkout` can emit is hardcoded English inside a
 * four-locale product, and `lib/http.ts`'s catch-all hands back a raw
 * `err.message` on an unexpected 500 — so a Stripe or Postgres exception string
 * is one unhandled throw away from being rendered to a buyer as purchase
 * advice. Mapping on status makes that structurally impossible.
 *
 * Five buckets, and the 4xx one is deliberately NOT narrowed to "bad rung":
 *
 *   409  a previous payment for this competition was taken and then REFUSED by
 *        the mint guard (v17 gap #326), so the sale is frozen until staff
 *        resolve it. Split out of the 4xx bucket because that bucket's whole
 *        premise — "the page is out of date, reload and try again" — is a
 *        confident lie here: reloading changes nothing, and the person reading
 *        it has already been charged. It is the one refusal on this route the
 *        buyer cannot clear by any action at all, so the copy says what
 *        happened to their money instead of asking them to retry.
 *   410  the competition itself is over — completed, archived, or more than the
 *        grace week past its end date — so the pass would apply to nothing
 *        (v17 gap #353). Split out of the 4xx bucket for the same reason 409 is,
 *        and it is worth being precise about how it differs from `stale`: a
 *        stale page is a page RELOADING fixes, and reloading fixes nothing here.
 *        On the recoverable arm the remedy is off this page entirely — move the
 *        competition's end date, or reopen it — and on the terminal arm there is
 *        no remedy at all, because a pass cannot be bought twice for one
 *        competition (#248 Q4) and this one was never bought once. So the copy
 *        states the fact rather than issuing an instruction that cannot work.
 *   503  the only thing this route 503s for is a rung whose one-time price has
 *        not been `stripe:sync`'d in this environment. Unambiguous as a CAUSE,
 *        so the copy names the rung — but it says "try the other size" rather
 *        than "pick the other size", because an environment that has never been
 *        synced at all has both rungs in this state and the second one would be
 *        a second dead end.
 *   4xx  every other refusal — already holds a pass, plan now covers it, no
 *        active org, signed out, competition gone, rung not in `PASS_KEYS`.
 *        They differ in cause and NOT in remedy: each means the page was
 *        rendered against state that has since moved, and each is resolved by
 *        reloading. Telling all of them "that size isn't one we sell" would be
 *        a confident lie in five cases out of six.
 *   else 5xx, a rejected fetch, an ok body with no secret. Nothing is known;
 *        say so, and invite a retry.
 */
export function passCheckoutErrorKey(status: number | null): DictionaryKey {
  if (status === 409) return "upgrade.buyError.underReview";
  // Ahead of the 4xx arm below, which would otherwise swallow it: 410 is inside
  // that range, and order is the only thing keeping these two apart.
  if (status === 410) return "upgrade.buyError.ended";
  if (status === 503) return "upgrade.buyError.rung";
  if (status !== null && status >= 400 && status < 500) return "upgrade.buyError.stale";
  return "upgrade.buyError.generic";
}

