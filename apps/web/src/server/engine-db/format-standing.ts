import "server-only";
import type postgres from "postgres";
import type { Tx } from "@/lib/db";
import { systemByeSql } from "./system-bye-sql";

// W2c batch-3 I1 — where a match stands for a FORMAT write: the one definition every format door reads. Two facts,
// independent of each other (a walkover over a ledger every void took back is both):
//  - PLAYED: a frozen cfg or a recorded event. Monotonic (rule-locks.ts D1): a void moves `fixtures.status` back, but
//    neither a snapshot nor an event ever goes away, so a played match never reads as unstarted again. A pre-V347 row
//    (events, no snapshot) is played.
//  - DECIDED WITHOUT PLAY: an outcome no standing event records — a bye, F14's walkover at Generate, ruling 116's
//    arriving side over a dead seat. Its score is a stored fold of its award (`writeAwardedMatchState`), not of play.
// The doors read them differently, by ruling, and each says so where it reads them:
//  - the stage and division locks (`rule-locks.ts`) lock on PLAYED only: a walkover decided without play never locks a
//    format — the save re-writes its score instead (`award-rewrite.ts`, batch-3 I1);
//  - the per-match writer (`fixture-rules.ts`) treats EITHER as started: a played match must fit its play (X-SR-5), one
//    decided without play its award (Task 14 fix round 1, I1);
//  - `fixture-override-guards.ts` asks a different question — which cfg a row RESOLVES (`config_snapshot is null`:
//    the live resolution a division save moves) — and is not a reader of either fact.

/** PLAYED, as a predicate over the fixtures row aliased `on`. W3 T3 (SW-M7, X-SW-5): a SYSTEM bye freezes its cfg at
 *  award (the Swiss bye seat, stages.ts) and is not play, so its snapshot does not count (`systemByeSql`, the same
 *  exemption `fixtureEvidenceSql` makes) — else an odd-field Pair would lock the stage's and the division's format. */
export function playedSql(tx: postgres.Sql | Tx, on = "f") {
  const f = tx(on);
  return tx`((${f}.config_snapshot is not null and not ${systemByeSql(tx, on)})
             or exists (select 1 from score_events e where e.fixture_id = ${f}.id))`;
}

/** DECIDED WITHOUT PLAY, as a predicate over the fixtures row aliased `on`: an outcome, and no event that is not a void
 *  and that no void took back (`awarded-state.ts` `ledgerOf`'s `standing`). */
export function decidedWithoutPlaySql(tx: postgres.Sql | Tx, on = "f") {
  const f = tx(on);
  return tx`(${f}.outcome is not null and not exists (
    select 1 from score_events e
     where e.fixture_id = ${f}.id and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)))`;
}

/** Both facts for one fixture. */
export async function formatStanding(tx: Tx, fixtureId: string): Promise<{ played: boolean; decidedWithoutPlay: boolean }> {
  const [row] = await tx<{ played: boolean; decided: boolean }[]>`
    select ${playedSql(tx, "f")} as played, ${decidedWithoutPlaySql(tx, "f")} as decided from fixtures f where f.id = ${fixtureId}`;
  if (!row) throw new Error(`formatStanding: no fixture ${fixtureId}`);
  return { played: row.played, decidedWithoutPlay: row.decided };
}
