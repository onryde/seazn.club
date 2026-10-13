// W2b PF-1 for the hand-rolled replay loops (public-site/timeline.ts `buildTimeline`, overlay/recent.ts
// `replayDerived`). Those loops re-apply a ledger event by event to diff summaries, and skip whatever the kernel folds
// itself (`kernelOwnsEvent`). One kernel-owned event changes the RESULT: a `core.forfeit{reason: "withdrew"}` over a
// held level result, which the kernel admits beside module state as `levelWithdrawal` (packages/engine
// core/events.ts `foldMatchWithStoppage`) and which `summaryOf` overlays on the headline. A loop that only skipped
// it kept rendering the draw after the withdrawal had decided the match.
//
// Client-safe on purpose (pure, engine-only import), like lib/fixture-bye.ts.
import { forfeitOf, type EventEnvelope, type LevelWithdrawal, type LineupPair } from "@seazn/engine/core";

/**
 * The `levelWithdrawal` a kernel-owned event admits, or null when it admits none. Call it ONLY for an event
 * `kernelOwnsEvent` claimed: of the kernel-owned types the one conditional forfeit member is PF-1's withdrawal
 * (`kernelOwnsEvent` admits a `core.forfeit` only as a withdrawal over a level, unsettled result), and every other
 * kernel-owned event (suspend, resume, settle, the lineup family, a settled finalize) admits nothing.
 *
 * The winner is the side that did NOT withdraw, the same derivation the kernel makes; a `by` naming neither side is
 * refused, as the kernel refuses it (INVALID_EVENT) — a stored ledger never holds one, so a replay meeting it throws
 * into the loop's own degrade path rather than crediting a stranger.
 */
export function admittedLevelWithdrawal(
  event: Pick<EventEnvelope, "id" | "type" | "payload">,
  lineups: LineupPair,
): LevelWithdrawal | null {
  if (event.type !== "core.forfeit") return null;
  const { by } = forfeitOf(event.payload);
  const home = lineups.home.entrantId;
  const away = lineups.away.entrantId;
  if (by !== home && by !== away) {
    throw new Error(`admittedLevelWithdrawal: core.forfeit by "${by}" is neither side of this fixture`);
  }
  return { winner: by === home ? away : home, loser: by, eventId: event.id };
}
