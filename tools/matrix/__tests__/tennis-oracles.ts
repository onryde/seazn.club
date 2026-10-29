// W2e Task 23: the engine's own answers to "how did this tennis match end, and what does the nested kernel accept at the
// edge?", for the tests that sweep tennis (w2e-streams.test.ts G8, w2e-scenarios.test.ts, pad-adapters.test.ts). Each is read
// off the ENGINE - a cfg declaration or a strict fold - and never off the stream generator or the witness whose expected values
// they are.
import { EngineError, type MatchOutcome } from "@seazn/engine/core";
import { foldStream } from "../lib/fold.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";

/** The nested kernel's cfg (NestedParams, nested/kernel.ts), the fields a tennis stream reads. */
export interface TennisCfg {
  bestOf: number;
  set: { gamesTo: number; winBy: number; tiebreakAt: number | null; tiebreakTo: number; tiebreakWinBy?: number };
  finalSet: "same" | { matchTiebreakTo: number } | { tiebreakTo: number };
  game: { noAd: boolean };
  tiebreak: { winBy: number };
}
/** A closed set as the kernel holds it (ClosedSet) and the product serves it through jsonb: `tb` on a set a tie-break ended,
 *  `mtb` on a match tie-break standing in for the deciding set (its home/away are then POINTS). */
export interface TennisSet { home: number; away: number; tb?: { home: number; away: number }; mtb?: boolean }
export interface TennisFoldState { cfg: TennisCfg; entrants: { home: string; away: string }; phase: string; sets: TennisSet[]; outcome: { kind: string; winner?: string } | null }

export const TN_HOME = "H";
export const TN_AWAY = "A";

export function foldTennis(cfg: unknown, events: readonly StreamEvent[], home = TN_HOME, away = TN_AWAY): { outcome: MatchOutcome | null; state: TennisFoldState } {
  const f = foldStream(sportModule("tennis"), cfg, home, away, events);
  return { outcome: f.outcome, state: f.state as TennisFoldState };
}

/** The sets a side won, by the higher score of each closed set (games, or MTB points). */
export const tennisSetsWonBy = (sets: readonly TennisSet[], side: "home" | "away"): number => {
  const other = side === "home" ? "away" : "home";
  return sets.filter((s) => s[side] > s[other]).length;
};

/** ORACLE (the engine's own refusal): does the strict fold of `events` throw? A refusal is an EngineError; anything else is a defect. */
export function engineRefuses(cfg: unknown, events: readonly StreamEvent[]): boolean {
  try {
    foldTennis(cfg, events);
    return false;
  } catch (e) {
    if (EngineError.is(e)) return true;
    throw e;
  }
}

/** The deciding summary of a tie-break-ended stream, edited: the winner's tie-break (or match tie-break) points moved by
 *  `dWin`, the loser's by `dLose`. The edge probes below ask the ENGINE whether each edit is still a finished tie-break. */
export function withLastTb(events: readonly StreamEvent[], dWin: number, dLose: number): StreamEvent[] {
  const last = events[events.length - 1];
  const p = last.payload as { home: number; away: number; tb?: { home: number; away: number } };
  const homeWon = (p.tb ?? p).home > (p.tb ?? p).away;
  const shift = (n: { home: number; away: number }) => ({ home: n.home + (homeWon ? dWin : dLose), away: n.away + (homeWon ? dLose : dWin) });
  const edited = p.tb === undefined ? shift(p) : { ...p, tb: shift(p.tb) };
  return [...events.slice(0, -1), { type: last.type, payload: edited }];
}

/** ORACLE (the engine's own fold): the deciding tie-break of `events` is a CLOSEST finish - the engine accepts it as streamed,
 *  refuses it one point short of the target (both sides a point lower: still under the target), and refuses it with the loser a
 *  point closer (a lead one short of the margin). That pins both the target and the win-by margin the set was played under,
 *  from the kernel's refusals, with no number typed here. */
export function tbIsClosestFinish(cfg: unknown, events: readonly StreamEvent[]): { accepted: boolean; targetEdge: boolean; marginEdge: boolean } {
  return {
    accepted: !engineRefuses(cfg, events),
    targetEdge: engineRefuses(cfg, withLastTb(events, -1, -1)),
    marginEdge: engineRefuses(cfg, withLastTb(events, 0, 1)),
  };
}
