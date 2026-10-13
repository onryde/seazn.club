// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/boardgame.ts` runs only this contract.
import { boardgame } from "@seazn/engine/sports/boardgame";
import { BOARDGAME_RULES } from "../boardgame.ts";
import { runContract } from "./run-contract.ts";

runContract(boardgame, BOARDGAME_RULES, {
  noWebFieldYet: {
    // The tie-break decider's on/off switch. W2c Task 8 superseded it for the organiser with `tiebreakRungs` (the ordered
    // list, the first "sequence" field: an EMPTY list is "no tie-break games", BG-KO-3), so no field edits it. The key
    // itself stays declared and settable: the bracket overlay (`bracketDeciders`) forces it on for a knockout stage, and
    // the per-match override and the division locks (I-1, rule-locks) still name it. Because the contract checks this
    // list as an exact set, the row stays for as long as the key is settable.
    tiebreak: "superseded for the organiser by the tiebreakRungs list (an empty list is off); the key stays declared for the bracket overlay and the locks",
  },
  // The engine's schema gives these no maximum (`.positive().int()` only), so the web's range is its own choice and cannot be
  // checked against the engine; the contract lists them so a bound the engine adds later is noticed.
  noEngineMax: ["clockBaseMinutes", "clockIncrementSeconds", "clockDelaySeconds"],
});
