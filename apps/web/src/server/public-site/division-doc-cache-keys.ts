// The Redis keys of a division's public documents (usecases/public.ts): its
// schedule, standings and entrants, 30 s each. ONE place for their names, read
// by the writer of each and by every invalidator that drops them.
//
// Final review r2-m4: an invalidator DELs `publicDivisionCacheKeys(id)` by name
// instead of sweeping `pub:v1:div:{id}:*`. A sweep is a SCAN over the whole
// keyspace (cache.ts), and every page of it is a billed Upstash command — on
// every SCORE write (`invalidatePublicCache`, usecases/scoring.ts, the most
// frequent of them by far), every person write (`dropNamedPublicDocuments`),
// every schedule write (`afterScheduleWrite`) and every stats refresh
// (`invalidateAfterRefresh`).
//
// Adding a document? Add its builder here AND to the list below:
// `__tests__/division-doc-cache-keys.test.ts` fails on a `pub:v1:div:` key
// spelled anywhere else in `src`, and on a builder the list leaves out.
export function publicDivisionScheduleCacheKey(divisionId: string): string {
  return `pub:v1:div:${divisionId}:schedule`;
}

/** `-v2` (W2e D11 b, 2026-10-28): the standings routes now serve `rank: null` on a level table. The entry is still the
 *  stored shape (the routes null it on the way out); the key moves with the document's contract all the same, so an entry
 *  the previous build left in Redis is never read as this build's. */
export function publicDivisionStandingsCacheKey(divisionId: string): string {
  return `pub:v1:div:${divisionId}:standings-v2`;
}

/** `-v2` (privacy hotfix, 2026-09-16): a masked member carries no
 *  `person_id`/`photo`. */
export function publicDivisionEntrantsCacheKey(divisionId: string): string {
  return `pub:v1:div:${divisionId}:entrants-v2`;
}

/** Every public document key of the division: what an invalidator DELs. */
export function publicDivisionCacheKeys(divisionId: string): string[] {
  return [
    publicDivisionScheduleCacheKey(divisionId),
    publicDivisionStandingsCacheKey(divisionId),
    publicDivisionEntrantsCacheKey(divisionId),
  ];
}
