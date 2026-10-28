// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/cricket.ts` runs only this contract.
import { cricket } from "@seazn/engine/sports/cricket";
import { CRICKET_RULES } from "../cricket.ts";
import { runContract } from "./run-contract.ts";

runContract(cricket, CRICKET_RULES, {
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
    // W2e Task 28: the result floor's own range end (the field's `max`, as long as the longest innings the overs field takes)
    // sits above every limited preset's innings; the engine's cross-refine is what refuses it, and the control's range does
    // not try to repeat it.
    "-/minOversForResult/100": "minOversForResult exceeds the innings length",
    "t20/minOversForResult/100": "minOversForResult exceeds the innings length",
    "odi/minOversForResult/100": "minOversForResult exceeds the innings length",
    "hundred/minOversForResult/100": "minOversForResult exceeds the innings length",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["overs", "maxOversPerBowler", "minOversForResult", "playersPerSide"],
});
