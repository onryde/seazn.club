// football — goals + period markers only (no coarse result event).
// resolveFullTime (football.ts:999-1024): level at FT → ET if enabled, else
// SHOOTOUT if enabled, else draw. applyPeriod (:1528+) gates every marker on
// cfg.halves, so the marker list must match the mode.
import { GeneratorUnsupported, START, idOf, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

export function footballPhases(halves: number): string[] | null {
  if (halves === 2) return ["HT", "FT"];
  if (halves === 4) return ["QT", "HT", "3QT", "FT"];
  return null;
}

interface FootballCfg { halves: number; extraTime?: { enabled?: boolean } | null; shootout?: unknown }

export const footballGenerator: SportStreamGenerator = {
  sportKeys: ["football"],
  decided(req) {
    const cfg = req.cfg as FootballCfg;
    const phases = footballPhases(cfg.halves);
    if (phases === null) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `halves ${cfg.halves}`);
    // supportsDraws (football.ts:2666) reads the stage only, never the cfg, so
    // a league cfg with ET or a shootout is declared drawable while its level
    // FT continues instead of ending. Refuse rather than emit a stream that
    // folds undecided.
    if (req.outcome.kind === "draw" && (cfg.extraTime?.enabled === true || Boolean(cfg.shootout))) {
      throw new GeneratorUnsupported(req.sportKey, "draw", "level FT continues to ET/shootout under this cfg");
    }
    const markers: StreamEvent[] = phases.map((phase) => ({ type: "football.period", payload: { phase } }));
    if (req.outcome.kind === "draw") return [START, ...markers];
    return [START, { type: "football.goal", payload: { by: idOf(req, req.outcome.winner), minute: 10 } }, ...markers];
  },
};
