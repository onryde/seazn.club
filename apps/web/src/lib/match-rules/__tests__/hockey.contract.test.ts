// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/hockey.ts` runs only this contract.
import { hockey } from "@seazn/engine/sports/hockey";
import { HOCKEY_RULES } from "../hockey.ts";
import { runContract } from "./run-contract.ts";

runContract(hockey, HOCKEY_RULES, {
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["quarterMinutes", "shootoutAttempts"],
});
