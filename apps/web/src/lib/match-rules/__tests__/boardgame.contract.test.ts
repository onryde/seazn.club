// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/boardgame.ts` runs only this contract.
import { boardgame } from "@seazn/engine/sports/boardgame";
import { BOARDGAME_RULES } from "../boardgame.ts";
import { runContract } from "./run-contract.ts";

runContract(boardgame, BOARDGAME_RULES, {
  noWebFieldYet: {
    // The tie-break decider's on/off switch. Task 8 supersedes it with `tiebreakRungs` (an ordered list: the first
    // "sequence" field) and must delete this row when it adds that field.
    tiebreak: "Task 8 replaces the on/off switch with the tiebreakRungs sequence field",
  },
});
