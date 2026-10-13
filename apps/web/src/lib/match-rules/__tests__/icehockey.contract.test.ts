// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/icehockey.ts` runs only this contract.
import { icehockey } from "@seazn/engine/sports/icehockey";
import { ICEHOCKEY_RULES } from "../icehockey.ts";
import { runContract } from "./run-contract.ts";

runContract(icehockey, ICEHOCKEY_RULES);
