// @seazn/engine/pad - the rule facts the ScoringPad v3 skins used to copy, declared once in the engine (pad wave, spec
// 2026-10-29-pad-wave-and-2b-design.md section 3). A facade, not a second source: each later export is the same object the fold
// reads or a pure derivation of it. Phone-safe (listed in phone-subpaths.json): no node:*, no React, no display strings.
//
// P0.1 ships the per-sport record types and the PadSpec lookups. Each later batch adds `export const <sport>PadRules: <Type>` below
// (P4 also adds POST_PHASES).
export type * from "./types.ts";
export { padFieldOf, padEnumValues, padNumberBound } from "./spec-lookup.ts";
export type { PadFieldScope } from "./spec-lookup.ts";

// One region per batch: P1, P2 and P3 run in parallel, so each appends its exports under its own marker (a blank line
// apart) and the merges do not touch one another's lines.

// P1: period + football
// Load-time work in a record runs at import of THIS barrel, which every v3 skin imports: hockey/icehockey parse their default and
// every declared variant cfg when built, so one variant its schema refused would throw for every sport's pad. The declared-cfg
// sweeps in period.test.ts are the guard; a later record doing load-time work owes the same sweep, or a lazy build.
export { hockeyPadRules, icehockeyPadRules } from "./period.ts";
export { footballPadRules } from "./football.ts";

// P2: cricket

// P3: set-based + tennis

// P4: carrom, boardgame, generic, POST_PHASES
