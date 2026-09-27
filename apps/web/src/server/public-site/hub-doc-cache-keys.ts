// The Redis keys of a competition's public HUB document (usecases/public.ts,
// `publicCompetitionHub`).
//
// `pub:v1:hub:{competitionId}` is the document itself, 15 s. Every writer that
// makes it stale DELs it by name, through `publicHubCacheKey`
// (`invalidatePublicCache`, `afterScheduleWrite`, `dropNamedPublicDocuments`,
// the stats refresh) — and
// that DEL is also what refuses a rebuild already in flight (the lease lives
// under the same key: lib/cache.ts).
//
// `pub:v1:hub-stale:{competitionId}` is the LAST-KNOWN-GOOD copy (public hub
// perf T2), written in the same Redis step as every successful rebuild and
// served ONLY to a poll that waited out a rebuild still in flight
// (lib/single-flight-cache.ts). A score or schedule write deliberately leaves
// it: serving the previous scoreline for a moment beats a stampede on
// Postgres. A write that WITHDRAWS a name (`dropNamedPublicDocuments`: consent
// off, a youth/name policy change) must drop it as well — a copy printing a
// name the person has taken back is not "a moment stale", it is a leak. Its
// prefix is deliberately not `pub:v1:hub:`, so nothing that matches the
// document's name matches the copy by accident.
export function publicHubCacheKey(competitionId: string): string {
  return `pub:v1:hub:${competitionId}`;
}

export function publicHubStaleCacheKey(competitionId: string): string {
  return `pub:v1:hub-stale:${competitionId}`;
}
