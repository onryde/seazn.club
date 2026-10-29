// @seazn/engine/pad - the rule facts the ScoringPad v3 skins used to copy, declared once in the engine (pad wave, spec
// 2026-10-29-pad-wave-and-2b-design.md section 3). A facade, not a second source: each later export is the same object the fold
// reads or a pure derivation of it. Phone-safe (listed in phone-subpaths.json): no node:*, no React, no display strings.
//
// P0.1 ships the per-sport record types and the PadSpec lookups. Each later batch adds `export const <sport>PadRules: <Type>` below
// (P4 also adds POST_PHASES).
export type * from "./types.ts";
export { padFieldOf, padEnumValues, padNumberBound } from "./spec-lookup.ts";
