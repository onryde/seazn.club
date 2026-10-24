// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/badminton.ts` runs only this contract.
import { badminton } from "@seazn/engine/sports/setbased";
import { BADMINTON_RULES } from "../badminton.ts";
import { runContract } from "./run-contract.ts";

runContract(badminton, BADMINTON_RULES, {
  // Cross-field refusals of a range end, pinned (see ContractOptions.crossField): cap sits under the preset's set target.
  crossField: {
    "-/cap/15": "cap must be ≥ the set target",
    "bwf/cap/15": "cap must be ≥ the set target",
    "short/setTo/30": "cap must be ≥ the set target",
    "short/finalSetTo/30": "cap must be ≥ the set target",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["setTo", "finalSetTo", "cap", "winBy"],
});
