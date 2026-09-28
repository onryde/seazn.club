// tennis — nested kernel; `tennis.set_summary {home, away}` (nested/kernel.ts:240).
// A plain games score must be terminal and one game earlier still live
// (nested/kernel.ts:1350-1366, strict only), so 6-5 is refused.
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

interface TennisCfg { bestOf: number; set: { gamesTo: number; winBy: number } }

export const tennisGenerator: SportStreamGenerator = {
  sportKeys: ["tennis"],
  decided(req) {
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "tennis has no draw");
    const cfg = req.cfg as TennisCfg;
    const w = cfg.set.gamesTo;
    const l = Math.max(0, cfg.set.gamesTo - cfg.set.winBy - 1); // 6-3, fast4 4-1: never a tie-break set
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      events.push({ type: "tennis.set_summary", payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
};
