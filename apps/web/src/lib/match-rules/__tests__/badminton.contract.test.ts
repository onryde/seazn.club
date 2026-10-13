// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/badminton.ts` runs only this contract.
import { badminton } from "@seazn/engine/sports/setbased";
import { BADMINTON_RULES } from "../badminton.ts";
import { runContract } from "./run-contract.ts";

runContract(badminton, BADMINTON_RULES);
