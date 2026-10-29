// W2e Task 22: the engine's own answers to "does this set cfg have a deciding set / a binding cap?", for the tests that sweep
// the set sports (w2e-streams.test.ts G6 G7, w2e-scenarios.test.ts). Each is read off the ENGINE - a declaration or a fold -
// and never off the stream generator or the witness whose expected values they are.
import { EngineError, type MatchOutcome } from "@seazn/engine/core";
import { foldStream } from "../lib/fold.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import { START, type Side, type StreamEvent } from "../lib/streams/types.ts";

/** The set kernel's cfg fields a stream reads (SetBasedParams, kernel.ts). */
export interface SetCfg { bestOf: number; setTo: number; finalSetTo: number; winBy: number; cap: number | null }
/** The set kernel's folded state (SetBasedState), as the product serves it through jsonb. */
export interface SetFoldState { cfg: SetCfg; entrants: { home: string; away: string }; phase: string; sets: { home: number; away: number; closed: boolean }[]; outcome: { kind: string; winner?: string } | null }

export const SET_HOME = "H";
export const SET_AWAY = "A";

export function foldSet(sport: string, cfg: unknown, events: readonly StreamEvent[], home = SET_HOME, away = SET_AWAY): { outcome: MatchOutcome | null; state: SetFoldState } {
  const f = foldStream(sportModule(sport), cfg, home, away, events);
  return { outcome: f.outcome, state: f.state as SetFoldState };
}

/** The set sports, by the ENGINE's own mark: only the set kernel declares `reachableSetScores` (a set table pays by set score). */
export const setSportsOf = (sportKeys: readonly string[]): string[] => sportKeys.filter((s) => sportModule(s).reachableSetScores !== undefined);

export const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

/** ORACLE (the engine's own declaration): a deciding set is played iff the final set scores the module declares
 *  (`reachableSetScores`: the winner's majority against each losing count) include one where the loser took a set
 *  (majority - 1 >= 1 sets won before the last, i.e. the sets were level). A best of one has none: its only set is the match. */
export function decidingSetReachable(sport: string, cfg: SetCfg): boolean {
  const m = majority(cfg.bestOf);
  return m - 1 >= 1 && sportModule(sport).reachableSetScores!(cfg).includes(`${m}-${m - 1}`);
}

/** ORACLE (the engine's own fold): the cap decides a set iff folding rallies, alternately, up to (cap-1, cap-1) leaves the set
 *  OPEN and one more rally closes it at (cap, cap-1) - a lead of one, which only the cap can end (a win-by rule needs more).
 *  A cfg with no cap, or a lead of one that already wins (winBy 1: the set ends before the deuce), fails one of the steps. */
export function capBinds(sport: string, cfg: SetCfg): boolean {
  if (cfg.cap === null) return false;
  const rally = (side: Side): StreamEvent => ({ type: `${sport}.rally`, payload: { wonBy: side === "home" ? SET_HOME : SET_AWAY } });
  const level: StreamEvent[] = [START];
  for (let i = 0; i < cfg.cap - 1; i++) level.push(rally("home"), rally("away"));
  try {
    const before = foldSet(sport, cfg, level).state;
    if (before.sets.length !== 1 || before.sets[0].closed || before.sets[0].home !== cfg.cap - 1 || before.sets[0].away !== cfg.cap - 1) return false;
    const after = foldSet(sport, cfg, [...level, rally("home")]).state;
    return after.sets[0].closed && after.sets[0].home === cfg.cap && after.sets[0].away === cfg.cap - 1;
  } catch (e) {
    if (EngineError.is(e)) return false; // the match was over before the deuce: the cap never binds
    throw e;
  }
}
