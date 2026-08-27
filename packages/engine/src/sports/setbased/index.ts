// Set-based kernel + presets (volleyball / badminton / table-tennis) — spec 04
// §3–5 + engine/sports/{volleyball,badminton,table-tennis}.md. One parametric
// rally/set engine, three thin presets (PROMPT-06).
export {
  makeSetBasedModule,
  // R5-1 (owner ruling) — the serve-context reader. ONE derivation of the BWF
  // / ITTF / FIVB service rules, in the engine, for the pad AND the public
  // scoreboard; the rules themselves are declared per preset
  // (`SetBasedServeRotation`), never keyed on the sport.
  setBasedServeContext,
  SetBasedRally,
  SetBasedSummary,
  SetSummaryPositional,
  SetSummaryByEntrant,
  SetBasedEv,
  PointsPair,
  type SetBasedCfg,
  type SetBasedParams,
  type SetBasedModule,
  type SetBasedPreset,
  type SetBasedServeContext,
  type SetBasedServeRotation,
  type SetBasedServeSource,
  type SetBasedServeUnknown,
  type SetBasedSetStart,
  type SetBasedServeWithin,
  type SetBasedState,
  type SetState,
} from "./kernel.ts";
export { volleyball } from "./volleyball.ts";
export { badminton } from "./badminton.ts";
export { tabletennis } from "./tabletennis.ts";
