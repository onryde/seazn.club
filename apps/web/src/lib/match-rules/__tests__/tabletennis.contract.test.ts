// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/tabletennis.ts` runs only this contract.
import { tabletennis } from "@seazn/engine/sports/setbased";
import { TABLETENNIS_RULES } from "../tabletennis.ts";
import { runContract } from "./run-contract.ts";

runContract(tabletennis, TABLETENNIS_RULES, {
  // No noWebFieldYet row: the engine offers table tennis no `cap` (ITTF has none; the module narrows the set kernel's key out,
  // W2c fix round 2 M-3), so every key it offers has a field.
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["setTo", "finalSetTo", "winBy"],
});
