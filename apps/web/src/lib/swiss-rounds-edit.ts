// W3 Task 12 Phase 2 (SW-M10, #838, X-SW-17; owner pick B, "the edit dialog"): what the stage rail's "Rounds: N · Edit"
// dialog says BEFORE Save — the exact unplayed round shells a new count removes or adds — and the bounds its stepper
// keeps. Every number here is the server's own rule read client-side over the same rows and the same predicates, so the
// preview is what `patchSwissStage` (server/usecases/swiss-rounds-admin.ts) then writes:
//   - removed: every row of a round above the new count (the PATCH deletes `round_no > to`); a bye is a shell, not a
//     match, so the count says matches (boards) only;
//   - added: a round above the old count that holds no row, minted for round N + 1's field (`addRound.field`, the field
//     `swissAddRoundState` reads), ⌊n/2⌋ boards (`swissBoardsForField`, the one mint rule) — once the stage holds any
//     shell; before its first Generate the count is only stored;
//   - min: the latest round with a seat (`latestSwissRoundWithAnySeat`, the PATCH's SWISS_ROUNDS_BELOW_SEATED bound);
//   - max: the hard maximum for the next Pair's field (`judgeSwissRounds`, the PATCH's SWISS_ROUNDS_ABOVE_MAX bound).
//
// Client-safe: imports only client-safe lib modules (the stage rail and the stages panel are client components).
import { judgeSwissRounds, type SwissRoundsJudgement } from "./swiss-rounds";
import { isSwissByeShellExtKey, latestSwissRoundWithAnySeat, swissBoardsForField } from "./swiss-shell";

/** The add-round half of the server's `SwissAddRoundState` (swiss-rounds-admin.ts) — the predicate `addSwissRound` judges
 *  by, so the desk offers "Add a round" exactly when that predicate lets it through (controller ruling C11). A frozen
 *  timetable is outside it: checked first, it still answers 422 SCHEDULE_LOCKED (review m2). */
export interface SwissAddRoundControl {
  canAddRound: boolean;
  /** Why it would be refused, or null when it goes through: the Swiss is over, the field is under two, or N + 1 is
   *  above the field's hard maximum. */
  refusal: "over" | "field" | "above_max" | null;
  /** Round N + 1's field (null: over, or a fed Swiss before its draw). */
  field: number | null;
  /** That field's hard maximum (null with no pairable field). */
  hardMax: number | null;
}

/** One Swiss stage as the desk reads it (`listSwissRoundControls`, read by the division page for an organiser). */
export interface SwissRoundControl {
  /** A board of the stage has started (`swissBoardStartedSql`): the count and the chess colours are fixed. */
  started: boolean;
  /** The stored round count. */
  rounds: number;
  /** The stored chess-colours switch (`config.chess === true`). */
  chess: boolean;
  /** The field the next Pair seats — the one the PATCH judges a count against (null: no field known yet). */
  field: number | null;
  addRound: SwissAddRoundControl;
}

/** The stepper's ceiling with no field to judge against (a fed Swiss before its draw): the round-count input's own bound
 *  in the builder and the Settings tab (`max={15}`, division-builder.tsx / division-settings.tsx). */
export const SWISS_ROUNDS_UNKNOWN_FIELD_MAX = 15;

/** The rows the preview reads: a stage's fixtures as the desk holds them. */
export interface SwissRoundsEditFixture {
  round_no: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

export interface SwissRoundsEditPreview {
  /** The lowest count the stage takes: its latest round with a seat (Unpair it to go lower), else 1. */
  min: number;
  /** The highest: the next Pair field's hard maximum (or `SWISS_ROUNDS_UNKNOWN_FIELD_MAX` with no field). A stored count
   *  above it (the field shrank before Start, carry c2) is shown as it is and may only go down. */
  max: number;
  /** Shells exist: the change deletes or mints rows. False before the first Generate (the count is only stored). */
  drawn: boolean;
  /** The rounds the change deletes, and their unplayed matches (boards; a bye is no match). */
  removed: { from: number; to: number; matches: number } | null;
  /** The rounds the change mints, and the matches each holds. */
  added: { from: number; to: number; matchesPerRound: number } | null;
  /** The new count against the next Pair's field (null with no pairable field): ok, warn above the safe maximum, refuse
   *  above the hard one. */
  judgement: SwissRoundsJudgement | null;
}

/**
 * The preview for moving a Swiss stage from `from` rounds to `to` (`control` from `listSwissRoundControls`, `fixtures`
 * the stage's own rows). Pure: the dialog renders it, and its tests pin it against the rulebook.
 */
export function swissRoundsEditPreview(args: {
  fixtures: readonly SwissRoundsEditFixture[];
  from: number;
  to: number;
  control: Pick<SwissRoundControl, "field" | "addRound">;
}): SwissRoundsEditPreview {
  const { fixtures, from, to, control } = args;
  const pairable = control.field !== null && control.field >= 2 ? control.field : null;
  const judgement = pairable === null ? null : judgeSwissRounds(to, pairable);
  const max = judgement?.hardMax ?? SWISS_ROUNDS_UNKNOWN_FIELD_MAX;
  const min = Math.max(1, latestSwissRoundWithAnySeat(fixtures) ?? 1);
  const drawn = fixtures.length > 0;

  let removed: SwissRoundsEditPreview["removed"] = null;
  if (drawn && to < from) {
    const gone = fixtures.filter((f) => f.round_no > to);
    if (gone.length > 0) {
      const top = gone.reduce((m, f) => Math.max(m, f.round_no), to + 1);
      removed = { from: to + 1, to: top, matches: gone.filter((f) => !isSwissByeShellExtKey(f.ext_key)).length };
    }
  }

  let added: SwissRoundsEditPreview["added"] = null;
  if (drawn && to > from) {
    const held = new Set(fixtures.map((f) => f.round_no));
    const minted = Array.from({ length: to - from }, (_, i) => from + 1 + i).filter((r) => !held.has(r));
    const field = control.addRound.field;
    if (minted.length > 0 && field !== null && field >= 2) {
      added = { from: minted[0]!, to: minted[minted.length - 1]!, matchesPerRound: swissBoardsForField(field).boards };
    }
  }
  return { min, max, drawn, removed, added, judgement };
}
