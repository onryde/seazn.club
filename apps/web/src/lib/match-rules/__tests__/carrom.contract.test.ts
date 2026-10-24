// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/carrom.ts` runs only this contract.
import { carrom } from "@seazn/engine/sports/carrom";
import { CARROM_RULES } from "../carrom.ts";
import { runContract } from "./run-contract.ts";

runContract(carrom, CARROM_RULES, {
  noWebFieldYet: {
    pointsPerCoin: "declared stage key outside Q5; the carrom form has never offered it (w2-coverage-audit, carrom row 6)",
  },
  // The schema refines queenCapAt <= gameTo, and queenCapAt's own default (22) is only valid for gameTo >= 22, so lowering
  // gameTo below 22 also lowers queenCapAt (carrom.ts, the gameTo field's `build`). queenCapAt is a STAGE key, gameTo a
  // match key, so gameTo cannot list it in `edits` without ceasing to be a match field.
  companionWrites: { gameTo: ["queenCapAt"] },
  // Cross-field refusals of a range end, pinned (see ContractOptions.crossField): the schema refines queenCapAt <= gameTo.
  crossField: {
    "-/queenCapAt/50": "queenCapAt must not exceed gameTo",
    "icf/queenCapAt/50": "queenCapAt must not exceed gameTo",
    "club-29/queenCapAt/50": "queenCapAt must not exceed gameTo",
    // Owner P-5, applied to carrom: sharing the points on an abandon is a drawn result, and carrom takes a draw only under the
    // tieBoard "draw" house rule. Every shipped carrom variant plays ICF "extra", so "Share the points" is unavailable over
    // each until the same save also turns tieBoard to "draw" (the form shows it unavailable). The owner's wording (fix round 1
    // ruling: it names the setting the organiser has to change).
    "-/abandon/share": "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.",
    "icf/abandon/share": "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.",
    "club-29/abandon/share": "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["gameTo", "maxBoards", "queenPoints", "queenCapAt"],
});
