// Online Chess, paid by size with Seazn credits (spec 2026-11-23-online-chess-credits-design.md, decisions 2-5, 9; P1, P10, P16, P17).
// The price leaf: the five sizes, what each costs, the rounds each includes, the stage kinds an online division may hold and the eight
// refusal codes the package doors answer with. It imports NOTHING, so the smoke suite (scripts/smoke, bare node, which cannot resolve
// `@/`) and the client islands read the SAME numbers the server charges; the import-free invariant is pinned (import-free-leaves.test.ts).
// No number in decision 5's table is typed anywhere else: the server, the size select, the pricing copy, the help tokens and the tests
// all read it from here.

/** The sizes an online chess division can be bought at, smallest first. 256 is the online cap (`ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION`,
 *  lib/online-chess-cap.ts). */
export const ONLINE_SIZES = [16, 32, 64, 128, 256] as const;
export type OnlineSize = (typeof ONLINE_SIZES)[number];

/** Whether `n` is a size on the ladder. A size read back from the database is asserted with this before anything prices it
 *  (server/usecases/online-package/read.ts): V560's CHECK guarantees it, and the assertion turns that "cannot happen" into a
 *  named refusal, so a corrupt row can never be quoted at packagePrice(0) = 0 or packagePrice(48) = 3. */
export function isOnlineSize(n: number): n is OnlineSize {
  return (ONLINE_SIZES as readonly number[]).includes(n);
}

/** One size unit is 16 players (decision 5). */
const PLAYERS_PER_UNIT = 16;
/** Seazn credits per unit without the Fair-play camera, and with it (decision 5; optional cameras cost the same as required, decision 13). */
const CREDITS_PER_UNIT = 1;
const CREDITS_PER_UNIT_WITH_CAMERAS = 2;

/** Swiss rounds each size includes: log2(size) + 2 (P1). Knockout, play-off and tie-break games are always included (decision 2). */
const INCLUDED_ROUNDS: Record<OnlineSize, number> = { 16: 6, 32: 7, 64: 8, 128: 9, 256: 10 };

/** Credits to buy `size`, with or without the Fair-play camera: 16 players cost 1 credit, or 2 with cameras. No time-control multiplier
 *  (decision 6). */
export function packagePrice(size: OnlineSize, cameras: boolean): number {
  return (size / PLAYERS_PER_UNIT) * (cameras ? CREDITS_PER_UNIT_WITH_CAMERAS : CREDITS_PER_UNIT);
}

/** The Swiss rounds a package of `size` includes (P1). */
export function includedRounds(size: OnlineSize): number {
  return INCLUDED_ROUNDS[size];
}

/** A count of places or rounds must be a non-negative number. A NaN or a negative reaching a money quote is a bug upstream, so it throws
 *  rather than quoting a size for it (NaN would otherwise read as "above 256" and a negative as the smallest). */
function assertCount(n: number, what: string): void {
  if (!(n >= 0)) throw new RangeError(`${what} must be a non-negative number, got ${String(n)}`);
}

/** The smallest size that holds `places`. `sizeFor(0)` is 16 (an empty division quotes the smallest size); null above 256. */
export function sizeFor(places: number): OnlineSize | null {
  assertCount(places, "places");
  return ONLINE_SIZES.find((s) => s >= places) ?? null;
}

/** The smallest size whose included rounds cover `rounds` Swiss rounds; null above 10, the most 256 includes (P10). 0 rounds (a division
 *  with no stage yet) fits 16. */
export function sizeForRounds(rounds: number): OnlineSize | null {
  assertCount(rounds, "rounds");
  return ONLINE_SIZES.find((s) => INCLUDED_ROUNDS[s] >= rounds) ?? null;
}

/** The next size up the ladder, or null at 256. */
export function nextSize(size: OnlineSize): OnlineSize | null {
  return ONLINE_SIZES[ONLINE_SIZES.indexOf(size) + 1] ?? null;
}

/** Whether the plan may choose `size` (P17). A plan cap that is not a ladder value (a size pack's 96) may choose the smallest size at or
 *  above it, so a club allowed 96 can buy 128 and not only 64; min(plan cap, size, 256) still limits the seats. `null` is no plan cap. */
export function sizeAllowedByPlan(size: OnlineSize, planCap: number | null): boolean {
  if (planCap === null || size <= planCap) return true;
  return size === ONLINE_SIZES.find((s) => s >= planCap);
}

/** Stage kinds an online division may hold (decision 9, P16): Swiss and knockout, including double elimination (a knockout), the page
 *  play-off and the step ladder. */
export const ONLINE_ALLOWED_STAGE_KINDS: readonly string[] = ["swiss", "knockout", "double_elim", "page_playoff", "stepladder"];
/** Stage kinds that cannot turn online play on, and cannot be added to an online division (422 `ONLINE_FORMAT_NOT_SUPPORTED`). A ladder
 *  is open-ended and has no size. `americano` is in neither list: chess already refuses it (lib/chess-individual-only-rule.ts). */
export const ONLINE_REFUSED_STAGE_KINDS: readonly string[] = ["league", "group", "ladder"];

/** The error codes of the package doors, exactly (plan Global Constraints). Never reuse the stream ledger's `no_credits`. HTTP status
 *  and body fields: 402 noCredits (`owed`, `balance`); 402 unpaid (the quote); 409 quoteChanged (the fresh quote); 422 sizeFull (`size`,
 *  `nextSize`); 422 formatNotSupported (`kind`); 422 roundsNeedSize (`nextSize`); 422 roundsAboveMax; 422 camerasNeedUpgrade
 *  (`divisions: [{ id, name, owed }]`). */
export const ONLINE_PACKAGE_CODES = {
  noCredits: "ONLINE_CHESS_NO_CREDITS",
  unpaid: "ONLINE_CHESS_UNPAID",
  quoteChanged: "ONLINE_QUOTE_CHANGED",
  sizeFull: "ONLINE_SIZE_FULL",
  formatNotSupported: "ONLINE_FORMAT_NOT_SUPPORTED",
  roundsNeedSize: "ONLINE_ROUNDS_NEED_SIZE",
  roundsAboveMax: "ONLINE_ROUNDS_ABOVE_MAX",
  camerasNeedUpgrade: "ONLINE_CAMERAS_NEED_UPGRADE",
} as const;

/** The doors that read the size as the entrant limit (spec 5.2, 7.6), as data, so the door sweep (Task 7) has a list to count against:
 *  it drives each one through its real usecase at the size and at size + 1, and a source scan fails when a call to `sizeForDoor`
 *  (the one read of the live row) appears in a place no door here names. A door is added here in the same change that makes it
 *  read the size.
 *   add_entrants     the organiser adds entrants (createEntrants: one, a batch, the entrants route, a CSV through it)
 *   reinstate        a withdrawn or disqualified entrant brought back (patchEntrant)
 *   sign_up          the public sign-up (a full size waits on the ordinary waitlist: no size code reaches the registrant)
 *   promote          the organiser's Promote, oldest-first or one named
 *   confirm          the organiser's Confirm of a waitlisted or expired entry
 *   waive            the organiser's Waive (confirm without payment)
 *   auto_promotion   the promotions a freed place triggers: a withdrawal, an expiry, a lapsed pay window, a rejection
 *   online_switch    turning online play on / choosing a size: the size must hold the places held (assertSizeFits)
 *   capacity_save    the registration capacity an organiser may promise
 *   places_left      the public register panel's places left */
export const ONLINE_SIZE_DOORS: readonly string[] = [
  "add_entrants",
  "reinstate",
  "sign_up",
  "promote",
  "confirm",
  "waive",
  "auto_promotion",
  "online_switch",
  "capacity_save",
  "places_left",
];
