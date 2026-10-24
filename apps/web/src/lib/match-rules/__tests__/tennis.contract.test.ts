// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/tennis.ts` runs only this contract.
import { tennis } from "@seazn/engine/sports/tennis";
import { TENNIS_RULES } from "../tennis.ts";
import { runContract } from "./run-contract.ts";

runContract(tennis, TENNIS_RULES);
