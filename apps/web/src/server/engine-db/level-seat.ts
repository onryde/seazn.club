import "server-only";
import { EngineError, forbidsLevelResult, isLevelOutcome } from "@seazn/engine/core";

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
