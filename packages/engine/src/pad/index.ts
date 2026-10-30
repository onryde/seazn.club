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

// P2: cricket

// P3: set-based + tennis
export { badmintonPadRules, tabletennisPadRules, volleyballPadRules } from "./setbased.ts";
export { tennisPadRules } from "./tennis.ts";

// P4: carrom, boardgame, generic, POST_PHASES
