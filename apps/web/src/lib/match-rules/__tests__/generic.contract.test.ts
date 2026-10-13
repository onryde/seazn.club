// single-sport: one file per sport (owner 2026-10-13), so `vitest related src/lib/match-rules/generic.ts` runs only this contract.
import { generic } from "@seazn/engine/sports/generic";
import { GENERIC_RULES } from "../generic.ts";
import { runContract } from "./run-contract.ts";

runContract(generic, GENERIC_RULES, {
  // Owner P-5: sharing the points on an abandon is a drawn result, so "Share the points" is unavailable over the preset that
  // allows no draw (the form shows it unavailable). The owner's wording, as signed; the `score` preset allows draws and
  // takes it.
  crossField: { "win_loss/abandon/share": "Sharing the points needs draws to be allowed." },
});
