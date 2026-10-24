// boardgame.result {winner|null, method} requires phase live (boardgame.ts:243-280).
//
// W2a (BG-KO-1, ruling 73): in a bracket (cfg.tiebreak, set by the stage overlay) a drawn game is not a result —
// it opens phase 'tiebreak', and the scorer records the tie-break on a rung (rapid, blitz, armageddon) with the
// WINNER (ruling 82: rapid and blitz, the scorer taps who won); W2c: an Armageddon records who had Black and how it
// ended, and the engine derives the advancer. Lots is not a rung: it is the organiser's core.settle.
import { OutcomeUnreachable, START, idOf, outcomeLabel, type SportStreamGenerator } from "./types.ts";

export const boardgameGenerator: SportStreamGenerator = {
  sportKeys: ["boardgame"],
  decided(req) {
    if (req.outcome.kind === "draw") return [START, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }];
    return [START, { type: "boardgame.result", payload: { winner: idOf(req, req.outcome.winner), method: "checkmate" } }];
  },
  // M7, rewritten by W2b (BG-DW-1, RB2B-15): in a bracket a drawn game opens the tie-break (above), so a chess bracket
  // has NO level result. Both sides absent is a double walkover — its own outcome, not a level one — which the
  // `double_walkover` request builds (core.forfeit {by: "both"}, every sport alike).
  levelRefusal(cfg) {
    return (cfg as { tiebreak?: boolean }).tiebreak === true
      ? "a drawn chess bracket game opens the tie-break (BG-KO-1), so a chess bracket has no level result; both sides absent is a double walkover (BG-DW-1, X-DW-1) — request double_walkover"
      : null;
  },
  // W2b: chess has no scoring event short of its result (eventSchemas: result, pairing, tiebreak) — the game IS its
  // result, so its partial play is START alone. Ruling 118: in chess START is play (the module's `startIsPlay`), so a
  // retirement and a disqualification after it both stand.
  partial() {
    return [];
  },
  tiebreak(req) {
    // Without the overlay a drawn game is an ordinary draw and the tie-break event is refused (TIEBREAK_NOT_APPLICABLE):
    // the caller owes stageCfg(). Named, never emitted.
    if ((req.cfg as { tiebreak?: boolean }).tiebreak !== true) {
      throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), "cfg.tiebreak is not set: a drawn game here is an ordinary draw (apply stageCfg() for a bracket stage)");
    }
    // W2c BG-KO-3: the stage plays the rungs it lists (absent = all), and an empty list opens no tie-break at all.
    const listed = (req.cfg as { tiebreakRungs?: readonly string[] }).tiebreakRungs;
    if (listed !== undefined && !listed.includes(req.outcome.rung)) {
      throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), `the stage plays ${listed.length === 0 ? "no tie-break rung" : `only ${listed.join(", ")}`} (BG-KO-3)`);
    }
    if (req.outcome.rung !== "armageddon" && req.outcome.result !== undefined) {
      throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), `a ${req.outcome.rung} game records its winner; "result" is an Armageddon's (BG-KO-2)`);
    }
    const winner = idOf(req, req.outcome.winner);
    return [
      START,
      { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
      // W2c BG-KO-2: an Armageddon records Black and the result and the engine derives who advances: Black wins it, or
      // draws it and advances all the same. So `winner` is Black, and the result is the requested one (default: Black won).
      // A rapid or blitz game still names the winner.
      {
        type: "boardgame.tiebreak",
        payload: req.outcome.rung === "armageddon" ? { rung: req.outcome.rung, black: winner, result: req.outcome.result ?? "black" } : { rung: req.outcome.rung, winner },
      },
    ];
  },
};
