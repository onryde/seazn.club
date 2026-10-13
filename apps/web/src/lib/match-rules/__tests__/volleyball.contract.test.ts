// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/volleyball.ts` runs only this contract.
import { volleyball } from "@seazn/engine/sports/setbased";
import { VOLLEYBALL_RULES } from "../volleyball.ts";
import { runContract } from "./run-contract.ts";

runContract(volleyball, VOLLEYBALL_RULES);
