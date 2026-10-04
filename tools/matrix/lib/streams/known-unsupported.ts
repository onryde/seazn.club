// Committed list of generator gaps (R11): `${sport}:${variant}:${stageKind}:${outcome}`.
// streams.test.ts fails on an unlisted gap AND on a listed entry that no longer
// throws. A difference found on the first run is a FINDING: record it in
// _INDEX.md "False premises found" before editing this list; never widen it
// to make the sweep green. Empty since ruling 44: cricket's two-innings
// streams (the `test` preset, its draw and its tie) are built, and that was
// the last gap.
export const KNOWN_UNSUPPORTED: readonly string[] = Object.freeze([]);
