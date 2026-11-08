// Which stages keep a division's entrant list OPEN after it starts.
//
// `enrollEntrants` (`server/usecases/entrants.ts`) refuses a new entrant once a
// division is active/completed — UNLESS the division has a stage of one of
// these kinds, because ladders and americano sessions take late joiners by
// design (Jul3/08 §6), a running root Swiss takes a late player (W3 T9), and
// so does a root knockout — its round 1, while a slot is free (W4 T9).
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

/** A stage row as the guard reads it. `progression` and `config` decide whether a Swiss is a ROOT Swiss; `seq` (the
 *  stage's order in its division) decides which stage is the division's ENTRY stage — a list without it is read in its
 *  own order, which is how every caller holds it (`listStages` orders by `seq`). */
export interface EntryStage {
  kind: string;
  progression: unknown;
  config: unknown;
  seq?: number;
}

/** No progression source and no `qualified` field stored on its config: the stage draws from the live roster. A config
 *  that is not an object is a stage nothing wrote, and draws from nothing. */
function drawsFromRoster(stage: EntryStage): boolean {
  if (stage.progression != null) return false;
  const config = stage.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  return !Object.hasOwn(config, "qualified");
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
  return stage.kind === "swiss" && drawsFromRoster(stage);
}

/** W4 T9 (X-LE-1, X-LE-8): the stage kinds a late player can join as a division's entry stage. `stepladder` and
 *  `page_playoff` are here for a legacy STANDALONE stage created over the API before X-SP-6's refusal (case (2) only);
 *  `double_elim` is not (W4 scope: late entry is the single-elimination bracket's). */
export const ROOT_KNOCKOUT_KINDS: readonly string[] = ["knockout", "stepladder", "page_playoff"];

/** The division's ENTRY stage: its lowest `seq`, or — for rows that carry no `seq` — the first in the list. */
export function divisionEntryStage<T extends EntryStage>(stages: readonly T[]): T | undefined {
  let first: T | undefined;
  for (const s of stages) {
    if (first === undefined || (typeof s.seq === "number" && typeof first.seq === "number" && s.seq < first.seq)) first = s;
  }
  return first;
}

/**
 * W4 T9 (X-LE-1, ruling 263; pre-flight C11): a ROOT knockout — a `ROOT_KNOCKOUT_KINDS` stage that draws from the live
 * roster (no progression source, no stored `qualified` field) AND is its division's ENTRY stage (`divisionEntryStage`:
 * the lowest `seq`). The second half is not redundant: a knockout fed by a group stage carries no progression on stg
 * (65 such stages, the Task 0 census) and fills from a seed proposal, so "no progression" alone would open a fed bracket
 * to late players (an X-LE-2 breach). `stage` must be an element of `division`.
 *
 * The ONE predicate: the Start lock (`hasRootKnockoutStage`), the admission (`usecases/knockout-late-entry.ts`) and this
 * client mirror all read it, so they cannot disagree.
 */
export function isRootKnockoutStage(stage: EntryStage, division: readonly EntryStage[]): boolean {
  if (!ROOT_KNOCKOUT_KINDS.includes(stage.kind) || !drawsFromRoster(stage)) return false;
  return divisionEntryStage(division) === stage;
}

/** A root knockout that still takes a late player: not `complete` (a finished bracket has no round-1 slot left). */
export function isRunningRootKnockout(
  stage: EntryStage & { status: string },
  division: readonly (EntryStage & { status: string })[],
): boolean {
  return isRootKnockoutStage(stage, division) && stage.status !== "complete";
}

/** One stage exempts the WHOLE division at Start: an open-format stage, a root Swiss, or a root knockout (`exists`, not
 *  "every"). */
function keepsListOpen(stages: readonly EntryStage[]): boolean {
  return stages.some(
    (s) => OPEN_ENTRY_STAGE_KINDS.includes(s.kind) || isRootSwissStage(s) || isRootKnockoutStage(s, stages),
  );
}

/**
 * A root Swiss that still takes a late player: not `complete`. A finished one refuses every add by name (SWISS_OVER),
 * so it exempts nothing RIGHT NOW. The ONE rule behind the list lock, the late-add note and the rail's More
 * (review I1, 2026-11-01).
 */
export function isRunningRootSwiss(stage: EntryStage & { status: string }): boolean {
  return isRootSwissStage(stage) && stage.status !== "complete";
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
 * players; said whenever it is true, beside a ladder too), `"knockout_late"` (W4 T9: a root knockout takes a late
 * player into round 1 while it has a free slot — said when no root Swiss is there to say it first), or `null` (an
 * open-format division: the line would be false either way, so it is omitted).
 */
export type StartEntrantsLine = "closes" | "swiss_late" | "knockout_late" | null;
export function startEntrantsLine(stages: readonly EntryStage[]): StartEntrantsLine {
  if (stages.some(isRootSwissStage)) return "swiss_late";
  if (stages.some((s) => isRootKnockoutStage(s, stages))) return "knockout_late";
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
export function entrantListLocked(
  divisionStatus: string,
  stages: readonly (EntryStage & { status: string })[],
): boolean {
  if (!ENTRANT_LIST_LOCKED_STATUSES.includes(divisionStatus)) return false;
  // Right now, a finished root Swiss exempts nothing: the add would only come back SWISS_OVER (review I1). Nor does a
  // finished root knockout (W4 T9): it has no round-1 slot left, so the add would only come back refused.
  return !stages.some(
    (s) => OPEN_ENTRY_STAGE_KINDS.includes(s.kind) || isRunningRootSwiss(s) || isRunningRootKnockout(s, stages),
  );
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
    isRunningRootSwiss(args.stage) &&
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
    stages.some(isRunningRootSwiss)
  );
}
