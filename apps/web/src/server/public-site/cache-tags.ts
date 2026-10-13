// The public site's cache tags: what an `unstable_cache` entry is tagged with (data.ts and its readers) and what a
// write fires (revalidate.ts). A LEAF on purpose — no imports. revalidate.ts sits on the scoring write path
// (usecases/fixtures.ts imports it), and when it took these from data.ts it pulled the whole public read layer, and
// through it the online-play result writer, into that path: an import cycle that unbound the guard/fixtures test
// mocks (T16 fix round 2, N1; usecases/external-play/__tests__/no-import-cycle.test.ts).

export const divisionTag = (divisionId: string) => `division:${divisionId}`;
export const competitionTag = (competitionId: string) => `competition:${competitionId}`;
export const orgTag = (orgSlug: string) => `org-public:${orgSlug}`;
/** One person's public card entries — at every competition URL, allowed or
 *  refused. Fired by every write to what a card shows about them
 *  (`firePersonRevalidate`); nothing else carries it. */
export const personTag = (personId: string) => `pub-person:${personId}`;
/** One shared tag for every discovery surface (doc 15, PROMPT-19). */
export const DISCOVERY_TAG = "discovery";
