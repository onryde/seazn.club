// volleyball / badminton / tabletennis — the set-based kernel. Event type is
// `${key}.${coarseEventType}` (setbased/kernel.ts:1083, :1654; the sweep also
// checks it against the module's eventSchemas). Summaries are positional
// {home, away} and must be REACHABLE under the cfg: terminal, and one point
// earlier still live (reachableSetScore, setbased/kernel.ts:470-489, enforced
// under a strict fold at :728).
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

// setbased/badminton.ts:58, tabletennis.ts:59, volleyball.ts:99.
const COARSE: Readonly<Record<string, string>> = { badminton: "game.summary", tabletennis: "game.summary", volleyball: "set.summary" };

interface SetCfg { bestOf: number; setTo: number; finalSetTo: number; winBy: number }

/** A set (or tie-break race) the winner takes at exactly `target`, the loser
 *  far enough behind that no deuce/cap rule applies. The 0 floor binds when
 *  target < winBy + 3 and still leaves a lead of target ≥ winBy (21-0 at
 *  winBy 20). winBy > target is outside this helper's domain, as it is for the
 *  engine's own generateSetScore (setbased/kernel.ts:1478-1480): the score is
 *  not terminal and the strict fold refuses it loudly (INVALID_EVENT), never a
 *  silent wrong outcome. */
export function winningSetScore(target: number, winBy: number): { w: number; l: number } {
  return { w: target, l: Math.max(0, target - winBy - 3) };
}

export const setbasedGenerator: SportStreamGenerator = {
  sportKeys: ["badminton", "tabletennis", "volleyball"],
  decided(req) {
    if (req.outcome.kind === "draw") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "odd best-of: no draw exists");
    }
    const cfg = req.cfg as SetCfg;
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    // Straight sets: the winner takes the first ⌈bestOf/2⌉. The final-set
    // target applies only when that run reaches set index bestOf-1 (bestOf 1).
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      const target = i === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
      const { w, l } = winningSetScore(target, cfg.winBy);
      events.push({ type: `${req.sportKey}.${COARSE[req.sportKey]}`, payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
};
