// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/football.ts` runs only this contract.
import { football } from "@seazn/engine/sports/football";
import { FOOTBALL_RULES } from "../football.ts";
import { runContract } from "./run-contract.ts";

runContract(football, FOOTBALL_RULES, {
  noWebFieldYet: {
    // Both are stage-scope keys the plan declares (Task 4) but spec §4.1 Q5 does not list, and no football form has ever
    // offered a control for them. Task 17 renders `stageFieldsFor`: a field added here (and its row deleted) is how
    // they would reach an organiser.
    rollingSubs: "declared stage key outside Q5; the football form has never offered it (variants set it)",
    concussionSubs: "declared stage key outside Q5; the football form has never offered it",
  },
});
