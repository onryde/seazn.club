// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/generic.ts` runs only this contract.
import { generic } from "@seazn/engine/sports/generic";
import { GENERIC_RULES } from "../generic.ts";
import { runContract } from "./run-contract.ts";

runContract(generic, GENERIC_RULES);
