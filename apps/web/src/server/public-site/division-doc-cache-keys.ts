// The Redis keys of a division's public documents (usecases/public.ts): its
// schedule, standings and entrants, 30 s each. ONE place for their names, read
// by the writer of each and by every invalidator that drops them.
//
// Final review r2-m4: an invalidator DELs `publicDivisionCacheKeys(id)` by name
// instead of sweeping `pub:v1:div:{id}:*`. A sweep is a SCAN over the whole
// keyspace (cache.ts), and every page of it is a billed Upstash command, on
// every person write, schedule write and stats refresh.
//
// Adding a document? Add its builder here AND to the list below:
// `__tests__/division-doc-cache-keys.test.ts` fails on a `pub:v1:div:` key
// spelled anywhere else in `src`, and on a builder the list leaves out.
export function publicDivisionScheduleCacheKey(divisionId: string): string {
  return `pub:v1:div:${divisionId}:schedule`;
}

export function publicDivisionStandingsCacheKey(divisionId: string): string {
  return `pub:v1:div:${divisionId}:standings`;
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
