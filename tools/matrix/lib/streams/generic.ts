// generic: generic.result, accepted in `pre` or `live` (generic.ts:540-548).
// p1Score = HOME, p2Score = AWAY (generic.ts:107-160).
//
// W2a (GN-KO-1): a generic BRACKET fixture refuses a draw — the scorer enters the winner — so no level stream
// exists there, whatever the cfg's allowDraws says.
import { forbidsLevelResult } from "@seazn/engine/core";
import { GeneratorUnsupported, OutcomeUnreachable, START, idOf, outcomeLabel, type SportStreamGenerator } from "./types.ts";

export const genericGenerator: SportStreamGenerator = {
  sportKeys: ["generic"],
  decided(req) {
    const mode = (req.cfg as { resultMode?: unknown }).resultMode;
    if (mode !== "score" && mode !== "win_loss") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `resultMode '${String(mode)}'`);
    }
    if (req.outcome.kind === "draw" && forbidsLevelResult(req.stageKind)) {
      throw new OutcomeUnreachable(req.sportKey, "draw", `GN-KO-1: a generic '${req.stageKind}' fixture refuses a draw — the scorer enters the winner`);
    }
    if (req.outcome.kind === "draw") {
      return [START, { type: "generic.result", payload: mode === "score" ? { p1Score: 2, p2Score: 2 } : { isDraw: true } }];
    }
    const homeWins = req.outcome.winner === "home";
    return [
      START,
      {
        type: "generic.result",
        payload: mode === "score"
          ? { p1Score: homeWins ? 3 : 1, p2Score: homeWins ? 1 : 3 }
          : { winnerId: idOf(req, req.outcome.winner) },
      },
    ];
  },
};
