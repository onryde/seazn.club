// Which stage kinds keep a division's entrant list OPEN after it starts.
//
// `enrollEntrants` (`server/usecases/entrants.ts`) refuses a new entrant once a
// division is active/completed — UNLESS the division has a stage of one of
// these kinds, because ladders and americano sessions take late joiners by
// design (Jul3/08 §6). Read the predicate there carefully before changing this:
// it is `exists(... kind in ('ladder','americano'))` over the WHOLE division,
// so ONE open-format stage exempts the division. It is not "every stage".
//
// Client-safe on purpose: the Start-tournament confirmation dialog has to know
// whether "Entrant list closes" is true before it says it, and that dialog is a
// client island (`components/v2/launch-actions.tsx`). Importing the usecase
// would drag the server barrel into the browser bundle, so the list is mirrored
// here and `__tests__/open-entry-stages.test.ts` reds if the two drift.
export const OPEN_ENTRY_STAGE_KINDS: readonly string[] = ["ladder", "americano"];

/**
 * Does starting this division close its entrant list?
 *
 * Mirrors `entrants.ts`'s guard exactly: any open-format stage keeps the list
 * open, everything else (including a division with no stages at all) closes it.
 */
export function startClosesEntrantList(stageKinds: readonly string[]): boolean {
  return !stageKinds.some((kind) => OPEN_ENTRY_STAGE_KINDS.includes(kind));
}

/** The division statuses in which `createEntrants` refuses a new entrant. */
export const ENTRANT_LIST_LOCKED_STATUSES: readonly string[] = ["active", "completed"];

/**
 * Is this division's entrant list closed RIGHT NOW?
 *
 * Mirrors `entrants.ts`'s guard, both halves: the status test AND the
 * open-format exemption. The console used to render the whole Add-entrant form
 * — Kind, Name, Seed, player search, an enabled button and Import CSV — on a
 * started tournament, seconds after the Start dialog promised "no one new can
 * be added". Filling it in produced a 422 and nothing else. Found by driving
 * the product, 2026-09-20.
 *
 * Note this is the INVERSE question to `startClosesEntrantList`, which asks
 * what starting WILL do. They share the open-format list and nothing else.
 */
export function entrantListLocked(divisionStatus: string, stageKinds: readonly string[]): boolean {
  if (!ENTRANT_LIST_LOCKED_STATUSES.includes(divisionStatus)) return false;
  return !stageKinds.some((kind) => OPEN_ENTRY_STAGE_KINDS.includes(kind));
}
