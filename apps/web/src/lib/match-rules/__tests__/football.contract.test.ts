// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/football.ts` runs only this contract.
import { football } from "@seazn/engine/sports/football";
import { FOOTBALL_RULES } from "../football.ts";
import { runContract } from "./run-contract.ts";

runContract(football, FOOTBALL_RULES, {
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  // `extraTimeSubs` (engine 7.0.0, F-R3): both leaves are `.int().nonnegative()` only; Law 3 allows one of each, three is the web's.
  noEngineMax: ["halfMinutes", "maxSubs", "subWindows", "sinBinMinutes", "concussionSubs", "extraTimeSubs", "extraTimeWindows"],
});
