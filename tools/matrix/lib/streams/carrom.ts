// carrom — board summaries (carrom.ts:88-125). Board points = opponentCoinsLeft
// × pointsPerCoin (applyBoard :374); a game ends at gameTo or on the leader
// after maxBoards (decideGame :306); the match is a majority of bestOf
// (bankGame :320). DO NOT copy seed-demo.ts (no carrom case).
//
// W2a (CA-KO-1, ICF Law 56): a BRACKET match always plays the extra board, whatever the division's
// `tieBoard` (the bracket overlay forces 'extra'). So a bracket game is the level game — maxBoards
// boards with the points equal — then ONE extra board that decides it; a table stage keeps the
// straight nine-coin win. With `tieBoard: 'draw'` (a table stage's house rule) the same level game
// stands as a drawn game, and a match of bestOf drawn games is the drawn match.
import { forbidsLevelResult } from "@seazn/engine/core";
import { CarromBoardSummary } from "@seazn/engine/sports/carrom";
import { OutcomeUnreachable, START, idOf, outcomeLabel, type Side, type SportStreamGenerator, type StreamEvent, type StreamRequest } from "./types.ts";

interface CarromCfg { gameTo: number; maxBoards: number; bestOf: number; pointsPerCoin: number; tieBoard?: "extra" | "draw" }

/** The most coins the schema takes for a board (the number step's bound): read from the event schema itself. */
const COIN_MAX = (CarromBoardSummary.shape.opponentCoinsLeft as unknown as { maxValue: number }).maxValue;

/** Coins a level game's boards carry: the largest count at which the boards one side wins (ceil(maxBoards/2))
 *  stay strictly below gameTo, so no board ends the game early; capped at the schema's bound. Below the bound
 *  whenever gameTo - 1 < COIN_MAX · ppc · ceil(maxBoards/2), which holds for every declared variant. */
export function levelCoins(cfg: CarromCfg): number {
  return Math.min(COIN_MAX, Math.floor((cfg.gameTo - 1) / (Math.ceil(cfg.maxBoards / 2) * cfg.pointsPerCoin)));
}

const board = (req: StreamRequest, winner: Side, coins: number): StreamEvent => ({
  type: "carrom.board.summary",
  payload: { winner: idOf(req, winner), opponentCoinsLeft: coins, queenTo: null },
});

/** maxBoards boards, home and away alternating, with equal points: the game is level when the boards run out.
 *  On an odd maxBoards the last board (home's) carries 0 coins, so the totals still match. */
function levelGame(req: StreamRequest, cfg: CarromCfg): StreamEvent[] {
  const coins = levelCoins(cfg);
  return Array.from({ length: cfg.maxBoards }, (_, i) =>
    board(req, i % 2 === 0 ? "home" : "away", i === cfg.maxBoards - 1 && cfg.maxBoards % 2 === 1 ? 0 : coins));
}

const gamesToWin = (cfg: CarromCfg): number => Math.ceil(cfg.bestOf / 2);

export const carromGenerator: SportStreamGenerator = {
  sportKeys: ["carrom"],
  decided(req) {
    const cfg = req.cfg as CarromCfg;
    if (req.outcome.kind === "draw") {
      // supportsDraws (carrom.ts:983) is true only for tieBoard 'draw' in a table stage; generateStream gates on it
      // first. This guard is for a caller that skipped the gate.
      if (cfg.tieBoard !== "draw") throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), `tieBoard is '${String(cfg.tieBoard)}': a level game plays an extra board, so no match is drawn`);
      return [START, ...Array.from({ length: cfg.bestOf }, () => levelGame(req, cfg)).flat()];
    }
    const winner = req.outcome.winner;
    if (forbidsLevelResult(req.stageKind)) {
      // CA-KO-1 holds only under the bracket overlay: without it a level game is DRAWN (tieBoard 'draw') and the
      // stream below would not fold to this winner. The caller owes stageCfg(); refuse by name rather than emit it.
      if (cfg.tieBoard !== "extra") throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), `a '${req.stageKind}' stage plays the extra board (CA-KO-1) but this cfg has tieBoard '${String(cfg.tieBoard)}' — apply stageCfg() first`);
      const game = [...levelGame(req, cfg), board(req, winner, 1)]; // one extra board, one coin: the level game gets a leader
      return [START, ...Array.from({ length: gamesToWin(cfg) }, () => game).flat()];
    }
    const boardsPerGame = Math.min(cfg.maxBoards, Math.ceil(cfg.gameTo / (COIN_MAX * cfg.pointsPerCoin)));
    return [START, ...Array.from({ length: gamesToWin(cfg) * boardsPerGame }, () => board(req, winner, COIN_MAX))];
  },
};
