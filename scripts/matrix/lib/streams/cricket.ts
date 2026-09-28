// cricket — one coarse summary per innings (cricket.ts:231-238, applySummary
// :1644); HOME bats first without a toss (battingFirst "home", :3626). A
// non-partial summary closes its innings; the chase closes on the target
// passed. Wickets never exceed the engine's all-out, which follows
// playersPerSide (allOutWickets, :625-629, refused under a strict fold at
// :1682); a winning chase keeps a wicket in hand. Two-innings streams (the
// `test` preset, and its draw) are W1-driving's generator work, not built yet.
import type { PadSpec } from "@seazn/engine/sport";
import { sportModule } from "../sport-cfg.ts";
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator } from "./types.ts";

interface CricketCfg { inningsPerSide: number; ballsPerInnings: number }

const SUMMARY = "cricket.innings.summary";

/** The engine's own declaration refused: its padSpec carries no usable wicket
 *  ceiling for an innings total, so there is no all-out to clamp to. */
export class AllOutUndeclared extends Error {
  constructor(why: string) {
    super(`streams: cricket padSpec declares no all-out for '${SUMMARY}' — ${why}`);
    this.name = "AllOutUndeclared";
  }
}

/** All-out as the engine declares it: the `wickets` ceiling of the innings
 *  summary action (cricket.ts padSpec, max = playersPerSide − 1, :3097) — the
 *  same threshold allOutWickets enforces for the harness's empty lineups. A
 *  winning chase needs a wicket in hand, so a ceiling below 1 is refused. */
export function declaredAllOut(spec: PadSpec | undefined): number {
  const action = spec?.panels.flatMap((p) => p.actions).find((a) => a.type === SUMMARY);
  if (action === undefined) throw new AllOutUndeclared("no such action");
  const field = action.fields.find((f) => f.path === "wickets");
  if (field?.kind !== "number") throw new AllOutUndeclared("no numeric 'wickets' field");
  if (!Number.isInteger(field.max) || field.max < 1) throw new AllOutUndeclared(`wickets max is ${field.max}`);
  return field.max;
}

export const cricketGenerator: SportStreamGenerator = {
  sportKeys: ["cricket"],
  decided(req) {
    const cfg = req.cfg as CricketCfg;
    if (cfg.inningsPerSide !== 1) {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "two-innings streams are W1-driving's generator work");
    }
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
    const B = cfg.ballsPerInnings;
    const allOut = declaredAllOut(sportModule(req.sportKey).padSpec?.(req.cfg));
    const w = (n: number): number => Math.min(n, allOut);
    const summary = (runs: number, wickets: number, legalBalls: number) => ({ type: SUMMARY, payload: { runs, wickets, legalBalls } });
    return req.outcome.winner === "home"
      ? [START, summary(180, w(4), B), summary(150, w(5), B)]
      : [START, summary(150, w(5), B), summary(151, Math.min(3, allOut - 1), Math.min(B, 60))];
  },
};
