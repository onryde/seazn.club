// The Redis key of the org home's chip-poll document (`publicOrgLive`,
// usecases/public.ts). One authority for the name, shared by the reader that
// fills it and by `patchCompetition`, which drops it when a competition joins
// or leaves the org home's listing (publish / un-publish, a visibility change).
// Dependency-free, like the sibling `*-cache-key(s).ts` modules.
export const orgLiveCacheKey = (orgId: string): string => `pub:v1:org-live:${orgId}`;
