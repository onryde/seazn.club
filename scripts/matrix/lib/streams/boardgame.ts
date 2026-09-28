// boardgame.result {winner|null, method} requires phase live (boardgame.ts:243-280).
import { START, idOf, type SportStreamGenerator } from "./types.ts";

export const boardgameGenerator: SportStreamGenerator = {
  sportKeys: ["boardgame"],
  decided(req) {
    if (req.outcome.kind === "draw") return [START, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }];
    return [START, { type: "boardgame.result", payload: { winner: idOf(req, req.outcome.winner), method: "checkmate" } }];
  },
};
