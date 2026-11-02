import "server-only";
// Match Day E2 item 7 — the database half of a match's round code. `lib/match-day/rounds.ts` names a round the way the schedule
// board does (its `boardRoundCodes`, the one authority); that function ranks a round against EVERY fixture of its stage, so this
// module fetches those rows for the stages the shown matches are in. Shared by the Match Day read (`match-day.ts`) and the call
// preview (`match-day-call.ts`), which name the same matches and must agree.
import type postgres from "postgres";
import type { RoundCodeFixture } from "@/components/v2/board/round-codes";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { matchDayRounds } from "@/lib/match-day/rounds";
import type { MatchDayRound } from "@/lib/match-day/types";

type Tx = postgres.TransactionSql;

/** A match to be named: where it sits (`fixtures.round_no` is NOT NULL, V214) and its stage's kind. */
export interface RoundRow {
  id: string;
  stage_id: string;
  stage_kind: string;
  round_no: number;
}

/**
 * Each of `rows`' round, named by the schedule board's own `boardRoundCodes` in the reader's language (`dict`: load it BEFORE the
 * transaction, a file read is no place for an open connection). Reads every fixture of every stage a shown match is in, as
 * `fed-seats.ts`'s `boardRef` does for a refusal — not just today's — because a semi-final is told from a final only by the rest
 * of its stage.
 */
export async function readRounds(tx: Tx, rows: readonly RoundRow[], dict: Dict): Promise<Map<string, MatchDayRound>> {
  const stages = [...new Map(rows.map((r) => [r.stage_id, { id: r.stage_id, kind: r.stage_kind }])).values()];
  if (stages.length === 0) return new Map();
  const stageRows = await tx<RoundCodeFixture[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional
      from fixtures where stage_id in ${tx(stages.map((s) => s.id))}`;
  return matchDayRounds(rows, stageRows, stages, (key, vars) => t(dict, key, vars));
}

/** A shown match's round: `readRounds` names every match it is handed, so one missing is a wiring fault, never a match to show
 *  without its code. */
export function roundOf(rounds: ReadonlyMap<string, MatchDayRound>, id: string): MatchDayRound {
  const round = rounds.get(id);
  if (round === undefined) throw new Error(`match-day: no round was read for match ${id}`);
  return round;
}
