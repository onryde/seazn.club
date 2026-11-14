// Steered quick match results for the DB tests (plan 5 T4; extracted from quick-match-cut.test.ts and
// quick-match-sweep.test.ts, which each carried a copy).
//
// Chess, so a test picks each winner: a resignation decides the game for the other side (the rulebook), where a rally
// sport's walk (`playToDecided`) picks a winner the test cannot steer. Every result goes through the real write path
// (`scoreEvent` as the system user, the auth the pad's writes resolve to), so the stored table, the bracket seats and the
// quick match's own hooks are the ones a guest's taps produce.
import { sql } from "@/lib/db";
import { systemAuth } from "@/lib/quick-match-auth";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";

/** One league line as the circle reads it. */
export interface SeatedLine {
  id: string;
  home_entrant_id: string;
  away_entrant_id: string;
}

/** `winnerEntrantId` wins the chess game on `fixtureId`: a Start (when the match has none yet), then the other side resigns.
 *  The expected seq is the stored state's own (`match_states.last_seq`), so a game reopened by a void is won again from
 *  where its ledger stands. `auth` defaults to the system user; a pad's link auth (`requireFixtureActor`) plays it as a
 *  guest's phone does. */
export async function playWin(fixtureId: string, winnerEntrantId: string, auth: AuthCtx = systemAuth()): Promise<void> {
  const [state] = await sql<{ last_seq: number }[]>`select last_seq from match_states where fixture_id = ${fixtureId}`;
  let seq = state?.last_seq ?? 0;
  if (seq === 0) {
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    seq = 1;
  }
  await scoreEvent(auth, fixtureId, {
    expected_seq: seq,
    type: "boardgame.result",
    payload: { winner: winnerEntrantId, method: "resign" },
  });
  const [row] = await sql<{ winner: string | null }[]>`select outcome->>'winner' as winner from fixtures where id = ${fixtureId}`;
  if (row?.winner !== winnerEntrantId) {
    throw new Error(`playWin: ${fixtureId} was to be won by ${winnerEntrantId}, the stored outcome names ${String(row?.winner)}`);
  }
}

/** The pair's key, either way round. */
export const pairKey = (x: string, y: string): string => [x, y].sort().join("|");

/**
 * A circle of three under Once: with the sides' ids sorted, ids[0] beats ids[1], ids[1] beats ids[2] and ids[2] beats
 * ids[0], every game by resignation. Every side has one win and one loss with identical metrics, so all three are level on
 * every tiebreaker before the lot. Returns the sorted ids. Refuses any other shape than three lines between three sides.
 */
export async function playCircle(lines: readonly SeatedLine[]): Promise<string[]> {
  const ids = [...new Set(lines.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort();
  if (lines.length !== 3 || ids.length !== 3) {
    throw new Error(`playCircle: a circle is 3 lines between 3 sides, got ${lines.length} lines between ${ids.length} sides`);
  }
  const winnerOf = new Map([
    [pairKey(ids[0]!, ids[1]!), ids[0]!],
    [pairKey(ids[1]!, ids[2]!), ids[1]!],
    [pairKey(ids[0]!, ids[2]!), ids[2]!],
  ]);
  for (const f of lines) await playWin(f.id, winnerOf.get(pairKey(f.home_entrant_id, f.away_entrant_id))!);
  return ids;
}
