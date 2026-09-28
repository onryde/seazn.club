// cricket — one coarse summary per innings (cricket.ts:231-238, applySummary
// :1644); HOME bats first without a toss (battingFirst "home", :3626). A
// non-partial summary closes its innings; the chase closes on the target
// passed. Two-innings cricket is W2's rulebook (the draw lives there).
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator } from "./types.ts";

interface CricketCfg { inningsPerSide: number; ballsPerInnings: number }

export const cricketGenerator: SportStreamGenerator = {
  sportKeys: ["cricket"],
  decided(req) {
    const cfg = req.cfg as CricketCfg;
    if (cfg.inningsPerSide !== 1) {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "two-innings streams land with W2's cricket rulebook");
    }
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
    const B = cfg.ballsPerInnings;
    const summary = (runs: number, wickets: number, legalBalls: number) => ({ type: "cricket.innings.summary", payload: { runs, wickets, legalBalls } });
    return req.outcome.winner === "home"
      ? [START, summary(180, 4, B), summary(150, 5, B)]
      : [START, summary(150, 5, B), summary(151, 3, Math.min(B, 60))];
  },
};
