// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/volleyball.ts` runs only this contract.
import { volleyball } from "@seazn/engine/sports/setbased";
import { VOLLEYBALL_RULES } from "../volleyball.ts";
import { runContract } from "./run-contract.ts";

runContract(volleyball, VOLLEYBALL_RULES, {
  // Cross-field refusals of a range end, pinned (see ContractOptions.crossField): cap sits under the preset's set target.
  crossField: {
    "-/cap/15": "cap must be ≥ the set target",
    "indoor/cap/15": "cap must be ≥ the set target",
    "beach/cap/15": "cap must be ≥ the set target",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["setTo", "finalSetTo", "cap", "winBy"],
});
