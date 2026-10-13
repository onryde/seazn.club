import "server-only";
import { advancesNobody, EngineError, forbidsLevelResult, isLevelOutcome } from "@seazn/engine/core";

/** The statuses under which a bracket fixture's outcome SEATS someone (onDecided, toBracketFixture, the
 *  completed-bracket rebuild). `needs_decision` is deliberately absent: a held fixture seats nobody (X-BR-2). */
export const SEATING_STATUSES: ReadonlySet<string> = new Set(["decided", "forfeited", "finalized"]);

const isBugShape = (f: { stageKind: string | null; status: string; outcome: unknown }): boolean =>
  forbidsLevelResult(f.stageKind) && SEATING_STATUSES.has(f.status) && isLevelOutcome(f.outcome as never);

/** X-BR-1 (R28: competition.ts's old comment SAID draws never reach a bracket; this makes it so). Reachable only
 *  through a bug — the status rule holds a level bracket result as `needs_decision`, and V432's backfill moved the
 *  legacy rows — so every caller's test reaches it by FORCING the row. There is no report-only read-path form. */
export function assertNoLevelSeat(f: { fixtureId: string; stageKind: string | null; status: string; outcome: unknown }): void {
  if (isBugShape(f)) {
    throw new EngineError("LEVEL_RESULT_SEATED", "a level result reached bracket seating", {
      fixtureId: f.fixtureId,
      status: f.status,
      stageKind: f.stageKind,
    });
  }
}

/** W2b D20 — the double walkover's seat assertion, beside X-BR-1's and with the same bug-shape code (a seat that must
 *  not be filled is ONE code; the spec names no new one), told apart by `data.reason: "advances_nobody"`. A decision
 *  that advances nobody (`advancesNobody`: a double walkover) under a seating status must have put nobody in a seat
 *  it feeds. `seatedEntrant` is one of this fixture's own entrants found in a seat it feeds (`fedSeatOccupant`), or
 *  null. Reachable only through a bug, so every caller's test forces the row (double-walkover-seating.test.ts). */
export function assertAdvancingSeat(f: {
  fixtureId: string;
  stageKind: string | null;
  status: string;
  outcome: unknown;
  seatedEntrant: string | null;
}): void {
  if (f.seatedEntrant !== null && SEATING_STATUSES.has(f.status) && advancesNobody(f.outcome as never)) {
    throw new EngineError("LEVEL_RESULT_SEATED", "a double walkover reached bracket seating", {
      fixtureId: f.fixtureId,
      status: f.status,
      stageKind: f.stageKind,
      reason: "advances_nobody",
      entrantId: f.seatedEntrant,
    });
  }
}

/** One of `f`'s own entrants standing in a seat `f` feeds (its winner or loser edge), or null — the input
 *  `assertAdvancingSeat` judges. `seatsOf` answers a target fixture's two seats (null when the target is not in the
 *  caller's rows: a cross-stage edge, read as no seat — the cascade never reaches across stages either). */
export function fedSeatOccupant(
  f: {
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    winner_to_fixture: string | null;
    winner_to_slot: number | null;
    loser_to_fixture: string | null;
    loser_to_slot: number | null;
  },
  seatsOf: (fixtureId: string) => readonly [string | null, string | null] | null,
): string | null {
  const mine = new Set([f.home_entrant_id, f.away_entrant_id].filter((x): x is string => x !== null));
  for (const [target, slot] of [
    [f.winner_to_fixture, f.winner_to_slot],
    [f.loser_to_fixture, f.loser_to_slot],
  ] as const) {
    if (target === null || (slot !== 1 && slot !== 2)) continue;
    const seat = seatsOf(target)?.[slot - 1] ?? null;
    if (seat !== null && mine.has(seat)) return seat;
  }
  return null;
}
