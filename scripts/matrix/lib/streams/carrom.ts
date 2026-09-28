// carrom — board summaries (carrom.ts:88-125). Board points = opponentCoinsLeft
// × pointsPerCoin (applyBoard :374); a game ends at gameTo or on the leader
// after maxBoards (decideGame :306); the match is a majority of bestOf
// (bankGame :320). DO NOT copy seed-demo.ts (no carrom case).
import { GeneratorUnsupported, START, idOf, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

interface CarromCfg { gameTo: number; maxBoards: number; bestOf: number; pointsPerCoin: number }

export const carromGenerator: SportStreamGenerator = {
  sportKeys: ["carrom"],
  decided(req) {
    // Unreachable from every declared variant: supportsDraws (carrom.ts:983)
    // needs tieBoard 'draw', which no variant sets, so generateStream throws
    // OutcomeUnreachable before reaching here.
    if (req.outcome.kind === "draw") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "the tieBoard:'draw' shape lands with W2's carrom rulebook");
    }
    const cfg = req.cfg as CarromCfg;
    const boardsPerGame = Math.min(cfg.maxBoards, Math.ceil(cfg.gameTo / (9 * cfg.pointsPerCoin)));
    const board: StreamEvent = { type: "carrom.board.summary", payload: { winner: idOf(req, req.outcome.winner), opponentCoinsLeft: 9, queenTo: null } };
    return [START, ...Array.from({ length: Math.ceil(cfg.bestOf / 2) * boardsPerGame }, () => board)];
  },
};
