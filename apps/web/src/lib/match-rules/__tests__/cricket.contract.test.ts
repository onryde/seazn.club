// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/cricket.ts` runs only this contract.
import { cricket } from "@seazn/engine/sports/cricket";
import { CRICKET_RULES } from "../cricket.ts";
import { runContract } from "./run-contract.ts";

runContract(cricket, CRICKET_RULES, {
  noWebFieldYet: {
    // Stage keys the plan declares (Task 4) but spec §4.1 Q5 does not list; the cricket form has never offered either.
    superOverStillTied: "declared stage key outside Q5; the cricket form has never offered it (w2-coverage-audit row 8)",
    minOversForResult: "declared stage key outside Q5; the cricket form has never offered it (CR-13, w2-coverage-audit row 15)",
  },
  // Cross-field refusals of a range end, pinned (see ContractOptions.crossField): the overs a match is cut to sit under the
  // preset's bowler limit and result minimum, and a bowler limit above the preset's innings.
  crossField: {
    "-/overs/1": "minOversForResult exceeds the innings length",
    "-/maxOversPerBowler/50": "maxOversPerBowler exceeds the innings length",
    "t20/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "t20/maxOversPerBowler/50": "maxOversPerBowler exceeds the innings length",
    "odi/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "hundred/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "hundred/maxOversPerBowler/50": "maxOversPerBowler exceeds the innings length",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["overs", "maxOversPerBowler", "playersPerSide"],
});
