// W3 Task 16 (SW-L11): where a Swiss stage stands, for the public standings table's "Round X of N" chip.
//
// Pure and client-safe (no `server-only`, no I/O): the hub builder (`server/public-site/competition-hub.ts`) calls it
// per Swiss stage and publishes the verdict on the table view; the chip (`components/public-site/standings-table-view.tsx`)
// only draws it. The document carries the VERDICT, not a sentence — `swissRoundKey` names the copy, the renderer fills it
// from the org's dictionary.

import type { DictionaryKey } from "./i18n-keys";
import { SWISS_ROUND_STATES, type SwissRoundStateName } from "./swiss-round-state-names";
import { isSwissBoardSeated } from "./swiss-shell";
import { WITHDRAWAL_PLAYED_STATUSES } from "./table-withdrawal";

// The state list is declared in a leaf (see its header) and re-exported here, so every consumer keeps one import.
export { SWISS_ROUND_STATES, type SwissRoundStateName };

export interface SwissRoundState {
  /** The latest round with a seated board (never the bye). */
  round: number;
  /** The stage's CURRENT round count (`config.rounds`): after "Finish the Swiss now" it is the round it finished after. */
  of: number;
  state: SwissRoundStateName;
}

/** One row of the stage, in the shape the hub already holds: `home`/`away` are the seats' entrant ids (null = empty),
 *  `outcome` is the row's own outcome (a walkover keeps one seat and carries an award), `isBye` is the Swiss bye shell
 *  (`isSwissByeShellExtKey` on the row's `ext_key`). `outcome` is required, not optional: a caller that forgot it would
 *  silently drop every walkover board. */
export interface SwissRoundFixture {
  round_no: number;
  home: string | null;
  away: string | null;
  status: string;
  outcome: unknown;
  isBye: boolean;
}

/**
 * The state of a Swiss stage, or null when it has none to state.
 *
 * EMPTY CASE FIRST: a stage with no seated board — nothing yet paired, shells only — is null, and so is one whose only
 * seated row is a round's bye (T13: an engine "empty success" seats the bye and leaves every board vacant; that round was
 * never paired). A board is a row that is not the bye and is seated by the repo's one authority, `isSwissBoardSeated` (the
 * predicate Finish, Add a round and the stage rail read): both seats, or an award. A board whose opponent departed keeps
 * its one seat and its walkover award, and is still the round's board; a one-seat row with no award is a half-built stub
 * and is not.
 *
 * Then, over the LATEST round with a board:
 *  - the stage is complete -> `final` (the stage's own verdict is the authority, not the boards);
 *  - every board decided (`decided`, `finalized`, `forfeited`: usecases/stages/swiss-gen.ts's DECIDED) -> `complete`;
 *  - every board still `scheduled` -> `paired`;
 *  - otherwise -> `in_play`: a board is under way or has a result while another is open, or one was abandoned/cancelled
 *    (it holds no result, so the round is not complete either).
 *
 * `rounds` is the stage's current count; a latest round beyond it states nothing (never "Round 4 of 3"; the rounds edit
 * refuses to lower the count below a seated round, so this is a guard, not a path).
 */
export function swissRoundState(
  rounds: number,
  fixtures: readonly SwissRoundFixture[],
  stageComplete: boolean,
): SwissRoundState | null {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RangeError(`swissRoundState: rounds must be a whole number of 1 or more, got ${rounds}`);
  }
  const boards = fixtures.filter(
    (f) => !f.isBye && isSwissBoardSeated({ home_entrant_id: f.home, away_entrant_id: f.away, outcome: f.outcome }),
  );
  if (boards.length === 0) return null;
  const round = boards.reduce((latest, f) => Math.max(latest, f.round_no), 0);
  if (round > rounds) return null;
  const latest = boards.filter((f) => f.round_no === round);
  const state: SwissRoundStateName = stageComplete
    ? "final"
    : latest.every((f) => WITHDRAWAL_PLAYED_STATUSES.has(f.status))
      ? "complete"
      : latest.every((f) => f.status === "scheduled")
        ? "paired"
        : "in_play";
  return { round, of: rounds, state };
}

/**
 * The dictionary key (`public.json`) that says a state. The final sentence is plural over `of`: one round reads
 * "Final standings after 1 round" (a Swiss finished after round 1). `en`, `es`, `fr` and `nl` all take the singular for
 * exactly 1 and `of` is never 0, so a comparison is the whole rule here; `.one`/`.other` follow the repo's plural keys.
 */
export function swissRoundKey(s: SwissRoundState): DictionaryKey {
  switch (s.state) {
    case "paired":
      return "table.swissRound.paired";
    case "in_play":
      return "table.swissRound.inPlay";
    case "complete":
      return "table.swissRound.complete";
    case "final":
      return s.of === 1 ? "table.swissRound.final.one" : "table.swissRound.final.other";
  }
}
