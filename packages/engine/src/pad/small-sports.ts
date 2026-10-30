// @seazn/engine/pad - the carrom, boardgame and generic records (pad wave P4.1). Each field is the very object the fold and padSpec
// read (the adjust-reason list, the coin and board and score sentinels, the tie-break score offer, each module's fidelity map) or a
// pure read of the module's own schema (carrom's bestOf and gameTo, the Armageddon rung's literal). No value is typed here.
//
// Every cfg is read through the module's own configSchema: an absent key is the schema's default, an invalid cfg throws (the
// schema's own refusal). Phone-safe: no node:*, no React, no display strings. Load-time work reads engine constants only.
import { BOARD_MAX, BOARDGAME_FIDELITY, BoardgameArmageddon, TIEBREAK_SCORES } from "../sports/boardgame/boardgame.ts";
import { ADJUST_REASONS, CARROM_FIDELITY, OPPONENT_COINS_MAX, carrom } from "../sports/carrom/carrom.ts";
import { GENERIC_FIDELITY, MAX_PLAUSIBLE_SCORE, MAX_TALLY_STEP } from "../sports/generic/generic.ts";
import type { BoardgamePadRules, CarromPadRules, GenericPadRules } from "./types.ts";

export const carromPadRules: CarromPadRules = Object.freeze<CarromPadRules>({
  eventBands: CARROM_FIDELITY,
  adjustReasons: ADJUST_REASONS,
  opponentCoinsMax: OPPONENT_COINS_MAX,
  bestOf: (cfg) => carrom.configSchema.parse(cfg).bestOf,
  gameTo: (cfg) => carrom.configSchema.parse(cfg).gameTo,
});

export const boardgamePadRules: BoardgamePadRules = Object.freeze<BoardgamePadRules>({
  eventBands: BOARDGAME_FIDELITY,
  boardMax: BOARD_MAX,
  tiebreakScores: TIEBREAK_SCORES,
  armageddonRung: BoardgameArmageddon.shape.rung.value,
});

export const genericPadRules: GenericPadRules = Object.freeze<GenericPadRules>({
  eventBands: GENERIC_FIDELITY,
  maxPlausibleScore: MAX_PLAUSIBLE_SCORE,
  maxTallyStep: MAX_TALLY_STEP,
});
