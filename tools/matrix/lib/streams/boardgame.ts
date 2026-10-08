// boardgame.result {winner|null, method} requires phase live (boardgame.ts:243-280).
//
// W2a (BG-KO-1, ruling 73): in a bracket (cfg.tiebreak, set by the stage overlay) a drawn game is not a result —
// it opens phase 'tiebreak', and the scorer records the tie-break on a rung (rapid, blitz, armageddon) with the
// WINNER (ruling 82: every rung, the scorer taps who won). Lots is not a rung: it is the organiser's core.settle.
import { OutcomeUnreachable, START, idOf, outcomeLabel, type SportStreamGenerator } from "./types.ts";

export const boardgameGenerator: SportStreamGenerator = {
  sportKeys: ["boardgame"],
  decided(req) {
    if (req.outcome.kind === "draw") return [START, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }];
    return [START, { type: "boardgame.result", payload: { winner: idOf(req, req.outcome.winner), method: "checkmate" } }];
  },
  // The ONE mapping of chess's double forfeit (M7). In a bracket a drawn game opens the tie-break (above), so the only
  // level result a chess bracket has is `boardgame.result {winner: null, method: "double_forfeit"}` (chess.md §7: both
  // sides default), which the engine folds to no_result and the product holds as needs_decision (spec §5.4). No request
  // builds it: `level` is refused here by name. W2b (RB2B-15) turns it into a double-walkover outcome - then a request
  // that builds that replaces this refusal, and nothing else in the harness changes.
  levelRefusal(cfg) {
    return (cfg as { tiebreak?: boolean }).tiebreak === true
      ? "a drawn chess bracket game opens the tie-break (BG-KO-1); its only level result is a double forfeit (no_result), which no request builds (RB2B-15)"
      : null;
  },
  tiebreak(req) {
    // Without the overlay a drawn game is an ordinary draw and the tie-break event is refused (TIEBREAK_NOT_APPLICABLE):
    // the caller owes stageCfg(). Named, never emitted.
    if ((req.cfg as { tiebreak?: boolean }).tiebreak !== true) {
      throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), "cfg.tiebreak is not set: a drawn game here is an ordinary draw (apply stageCfg() for a bracket stage)");
    }
    return [
      START,
      { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
      { type: "boardgame.tiebreak", payload: { rung: req.outcome.rung, winner: idOf(req, req.outcome.winner) } },
    ];
  },
};
