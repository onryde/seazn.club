// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/tabletennis.ts` runs only this contract.
import { tabletennis } from "@seazn/engine/sports/setbased";
import { TABLETENNIS_RULES } from "../tabletennis.ts";
import { runContract } from "./run-contract.ts";

runContract(tabletennis, TABLETENNIS_RULES, {
  noWebFieldYet: {
    // The set kernel declares `cap` for all three set sports, but the table-tennis table has never offered it: a game is
    // always won by two, with no hard ceiling (badminton and volleyball carry one). Add a field to tabletennis.ts and
    // delete this row if an organiser should be able to set one.
    cap: "a table-tennis game has no hard cap (always win by two), and the form has never offered one",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["setTo", "finalSetTo", "winBy"],
});
