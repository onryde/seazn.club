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
});
