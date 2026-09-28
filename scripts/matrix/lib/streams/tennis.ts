// tennis — nested kernel; `tennis.set_summary {home, away}` (nested/kernel.ts:240).
// A plain games score must be terminal and one game earlier still live
// (nested/kernel.ts:1350-1366, strict only), so 6-5 is refused.
import { winningSetScore } from "./setbased.ts";
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

interface TennisCfg {
  bestOf: number;
  set: { gamesTo: number; winBy: number };
  finalSet: "same" | { matchTiebreakTo: number } | { tiebreakTo: number };
  tiebreak: { winBy: number };
}

export const tennisGenerator: SportStreamGenerator = {
  sportKeys: ["tennis"],
  decided(req) {
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "tennis has no draw");
    const cfg = req.cfg as TennisCfg;
    // 6-3, fast4 4-1: never a tie-break set. The 0 floor binds when
    // gamesTo ≤ winBy; at gamesTo = winBy the nil set (2-0) is terminal, and
    // gamesTo < winBy is outside the domain (not terminal: the strict fold
    // refuses it loudly, never a silent wrong outcome).
    const games = { w: cfg.set.gamesTo, l: Math.max(0, cfg.set.gamesTo - cfg.set.winBy - 1) };
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      // Straight sets reach the deciding set only at bestOf 1 (rulesFor,
      // nested/kernel.ts:855-861). Under `matchTiebreakTo` that set IS a match
      // tie-break, and its summary carries tie-break POINTS (:1291-1303).
      const mtbTo = i === cfg.bestOf - 1 && cfg.finalSet !== "same" && "matchTiebreakTo" in cfg.finalSet ? cfg.finalSet.matchTiebreakTo : null;
      const { w, l } = mtbTo === null ? games : winningSetScore(mtbTo, cfg.tiebreak.winBy);
      events.push({ type: "tennis.set_summary", payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
};
