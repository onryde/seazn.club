// Which stages keep a division's entrant list OPEN after it starts.
//
// `enrollEntrants` (`server/usecases/entrants.ts`) refuses a new entrant once a
// division is active/completed — UNLESS the division has a stage of one of
// these kinds, because ladders and americano sessions take late joiners by
// design (Jul3/08 §6), and a running root Swiss takes a late player (W3 T9).
// Read the predicate there carefully before changing this:
// it is `exists(... kind in ('ladder','americano'))` over the WHOLE division,
// so ONE open-format stage exempts the division. It is not "every stage".
//
// Client-safe on purpose: the Start-tournament confirmation dialog has to know
// whether "Entrant list closes" is true before it says it, and that dialog is a
// client island (`components/v2/launch-actions.tsx`). Importing the usecase
// would drag the server barrel into the browser bundle, so the list is mirrored
// here and `__tests__/open-entry-stages.test.ts` reds if the two drift.
export const OPEN_ENTRY_STAGE_KINDS: readonly string[] = ["ladder", "americano"];

/** A stage row as the guard reads it. `progression` and `config` decide whether a Swiss is a ROOT Swiss. */
export interface EntryStage {
  kind: string;
  progression: unknown;
  config: unknown;
}

/**
 * A ROOT Swiss stage: no progression source, and no `qualified` field stored on its config. It draws from the live
 * roster, which is what a late player joins (W3 T9, ruling 250); a Swiss fed by an earlier stage has a fixed
 * qualified field, so nobody joins it late.
 *
 * The ONE predicate: `hasRootSwissStage` and the admission's own stage read (`usecases/swiss-late-entry.ts`) filter
 * their rows through this, so the Start lock, the admission and this client mirror cannot disagree.
 * `stages.config` is `not null` (V210); a config that is not an object is a stage nothing wrote, and is not
 * treated as a root Swiss.
 */
export function isRootSwissStage(stage: EntryStage): boolean {
  if (stage.kind !== "swiss" || stage.progression != null) return false;
  const config = stage.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  return !Object.hasOwn(config, "qualified");
}

/** One stage exempts the WHOLE division: an open-format stage, or a running root Swiss (`exists`, not "every"). */
function keepsListOpen(stages: readonly EntryStage[]): boolean {
  return stages.some((s) => OPEN_ENTRY_STAGE_KINDS.includes(s.kind) || isRootSwissStage(s));
}

/**
 * Does starting this division close its entrant list?
 *
 * Mirrors `entrants.ts`'s guard exactly: any open-format stage or root Swiss keeps the list open, everything else
 * (including a division with no stages at all) closes it.
 */
export function startClosesEntrantList(stages: readonly EntryStage[]): boolean {
  return !keepsListOpen(stages);
}

/**
 * The Start dialog's entrants line: `"closes"` (the list closes), `"swiss_late"` (a root Swiss keeps taking late
 * players; said whenever it is true, beside a ladder too), or `null` (an open-format division: the line would be
 * false either way, so it is omitted).
 */
export type StartEntrantsLine = "closes" | "swiss_late" | null;
export function startEntrantsLine(stages: readonly EntryStage[]): StartEntrantsLine {
  if (stages.some(isRootSwissStage)) return "swiss_late";
  return startClosesEntrantList(stages) ? "closes" : null;
}

/** The division statuses in which `createEntrants` refuses a new entrant. */
export const ENTRANT_LIST_LOCKED_STATUSES: readonly string[] = ["active", "completed"];

/**
 * Is this division's entrant list closed RIGHT NOW?
 *
 * Mirrors `entrants.ts`'s guard, both halves: the status test AND the
 * exemption. The console used to render the whole Add-entrant form
 * — Kind, Name, Seed, player search, an enabled button and Import CSV — on a
 * started tournament, seconds after the Start dialog promised "no one new can
 * be added". Filling it in produced a 422 and nothing else. Found by driving
 * the product, 2026-09-20.
 *
 * Note this is the INVERSE question to `startClosesEntrantList`, which asks
 * what starting WILL do. They share the exemption and nothing else.
 */
export function entrantListLocked(divisionStatus: string, stages: readonly EntryStage[]): boolean {
  if (!ENTRANT_LIST_LOCKED_STATUSES.includes(divisionStatus)) return false;
  return !keepsListOpen(stages);
}

/**
 * W3 T10 (X-SW-12; controller ruling 2): is "Add late player" offered on this stage? On a ROOT Swiss stage of a
 * started division (the statuses the Start lock refuses in are the ones the admission reads as started,
 * `DIVISION_STARTED_STATUSES`), once a round has a seat, until the stage is finished. It stays at the last round:
 * the add is refused there by name (SWISS_NO_ROUND_LEFT), which tells the organiser what to do. Before Start the
 * ordinary add applies, so it is not offered there.
 */
export function swissLateEntryOffered(args: {
  stage: EntryStage & { status: string };
  divisionStatus: string;
  /** Some round of this stage has a seat (`latestSwissRoundWithAnySeat !== null`). */
  roundSeated: boolean;
}): boolean {
  return (
    ENTRANT_LIST_LOCKED_STATUSES.includes(args.divisionStatus) &&
    isRootSwissStage(args.stage) &&
    args.stage.status !== "complete" &&
    args.roundSeated
  );
}

/**
 * W3 T10: is an add on the Entrants tab a LATE add right now? A started division holding a root Swiss that is still
 * running (not `complete`): the admission (T9) then decides how the entrant joins it. Before Start the ordinary add
 * applies; once every root Swiss is finished the add is refused (SWISS_OVER), and the form says nothing extra.
 */
export function divisionTakesSwissLateEntry(
  divisionStatus: string,
  stages: readonly (EntryStage & { status: string })[],
): boolean {
  return (
    ENTRANT_LIST_LOCKED_STATUSES.includes(divisionStatus) &&
    stages.some((s) => isRootSwissStage(s) && s.status !== "complete")
  );
}
