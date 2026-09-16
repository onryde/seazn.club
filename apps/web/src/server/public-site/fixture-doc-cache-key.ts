// The Redis key of the public fixture document (`publicFixture`,
// usecases/public.ts) — ONE name for its reader and for every invalidator
// that drops it (`invalidatePublicCache` in scoring.ts, `afterScheduleWrite`
// in schedule.ts). Three hand-typed copies of a key that has to change
// together is how one of them gets missed.
//
// `v2` (owner decision 2026-09-16): the document's
// `match_centre.header.statusLine` changed shape — a cricket margin is now
// its own key (`matchCentre.result.runs.other`, `{ winner, runs }`) instead of
// a `{margin}` word in `regulation`. A v1 entry written before the deploy
// renders "X won" with the margin dropped on a new pod for its whole TTL, and
// during a rolling deploy an old pod reading a v2 entry prints a raw key it
// has no dictionary line for. Retiring the name isolates the two.
//
// The `pub:v1:fixture:` prefix is kept on purpose: it is the family every
// "literal key, never through a SCAN" guard filters on.
export function publicFixtureCacheKey(fixtureId: string): string {
  return `pub:v1:fixture:v2:${fixtureId}`;
}
