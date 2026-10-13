// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/boardgame.ts` runs only this contract.
import { boardgame } from "@seazn/engine/sports/boardgame";
import { BOARDGAME_RULES } from "../boardgame.ts";
import { runContract } from "./run-contract.ts";

runContract(boardgame, BOARDGAME_RULES, {
  // No noWebFieldYet row: `tiebreak` left the settable keys in W2c Task 8 fix round 1 (BG-KO-1, BG-KO-3) - the bracket overlay
  // forces it on and the organiser's decider is the `tiebreakRungs` list, which has a field (the editor hides it until Task 17
  // builds its control, `visibleRuleFields`; the table still carries it, so this contract sees it).
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["clockBaseMinutes", "clockIncrementSeconds", "clockDelaySeconds"],
});
