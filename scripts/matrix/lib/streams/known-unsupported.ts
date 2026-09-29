// Committed list of generator gaps (R11): `${sport}:${variant}:${stageKind}:${outcome}`.
// streams.test.ts fails on an unlisted gap AND on a listed entry that no longer
// throws. A difference found on the first run is a FINDING: record it in
// _INDEX.md "False premises found" before editing this list; never widen it
// to make the sweep green.
export const KNOWN_UNSUPPORTED: readonly string[] = Object.freeze([
  // cricket `test` is two-innings (cricket.ts:3559): W1-driving's generator work.
  "cricket:test:league:win-home", "cricket:test:league:win-away",
  "cricket:test:knockout:win-home", "cricket:test:knockout:win-away",
  "cricket:test:swiss:win-home", "cricket:test:swiss:win-away",
  // supportsDraws is true for 2-innings cricket on league-ish stages only
  // (cricket.ts:3964); the knockout draw is OutcomeUnreachable, not a gap.
  "cricket:test:league:draw", "cricket:test:swiss:draw",
]);
