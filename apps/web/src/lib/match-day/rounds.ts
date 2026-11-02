// Match Day — a match's round, named the way the SCHEDULE BOARD names it (Match Day E2 item 7, owner 2026-11-01: "we don't know
// which matches are going on? R1, R2… or SF, like in schedule board").
//
// ONE authority: the board's own `boardRoundCodes` (components/v2/board/round-codes.ts, over the engine's `roundRole`). This module
// only asks it, for the rows of the stages the displayed matches belong to, and keeps the board's own fallback for a round it does
// not code: the chip `R{round_no}` (fixture-block.tsx), and the plain "Round {n}" name. It never maps a role to a word itself —
// a second mapping is exactly the drift the board's header warns of.
//
// Pure and client-safe; the server read (server/usecases/match-day.ts) fetches the stage rows and calls it.
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import type { MessageKey } from "@/lib/messages";
import type { MatchDayRound } from "./types";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** A match to be named: its stage and its place in it. */
export interface RoundSource {
  id: string;
  stage_id: string;
  round_no: number;
}

/**
 * Fixture id -> its round, for every one of `shown`. `stageRows` must hold EVERY fixture of every stage a shown match is in (the
 * board ranks a stage's rounds against the whole stage, so a lone semi-final could not be told from a final), `stages` the kind of
 * each. A match the board does not code keeps the board's fallback.
 */
export function matchDayRounds(
  shown: readonly RoundSource[],
  stageRows: readonly RoundCodeFixture[],
  stages: readonly { id: string; kind: string }[],
  msg: Msg,
): Map<string, MatchDayRound> {
  const codes = boardRoundCodes(stageRows, stages, msg);
  const out = new Map<string, MatchDayRound>();
  for (const f of shown) {
    const rc = codes.get(f.id);
    out.set(
      f.id,
      rc !== undefined
        ? { code: rc.code, label: rc.label, coded: true }
        : { code: `R${f.round_no}`, label: msg("schedule.round", { n: f.round_no }), coded: false },
    );
  }
  return out;
}
