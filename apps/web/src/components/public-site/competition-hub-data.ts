// Spectator surface W2, Task 7 — fetch layer for the competition hub
// document, split out the same way `live-score-data.ts` is (W1): the
// payload-unwrap is unit-testable independent of polling
// (`competition-hub-data.test.ts`). `api()` (`lib/client.ts:6`) already
// unwraps the endpoint's `{ ok, data }` envelope once — the W1 history this
// split exists to prevent repeating is that unwrapping it a SECOND time here
// would silently replace the whole document with `undefined` on every poll.
import { ApiError, api } from "@/lib/client";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

/** W5 follow-ups B4: the build each competition's document came from, and that document - the poll sends the build back
 *  (`If-None-Match`), and a 304 is answered with the document already held, the SAME object, so nothing re-renders. Keyed
 *  per competition URL; one entry each, replaced by every 200. */
const held = new Map<string, { etag: string; doc: CompetitionHubDocT }>();

export async function fetchCompetitionHub(
  orgSlug: string,
  competitionSlug: string,
): Promise<CompetitionHubDocT> {
  const url = `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/hub`;
  const seen = held.get(url);
  let etag: string | null = null;
  try {
    // R10 H1: never the browser's HTTP cache. The route answers `Cache-Control:
    // public, s-maxage=30, stale-while-revalidate=300`, which is meant for the
    // CDN in front of share-link traffic and stays as it is. Chromium applies
    // stale-while-revalidate to its own private cache as well, though. Measured
    // on spectw2: a push-triggered refetch came back from that cache with a
    // document built BEFORE the score, and the page never moved. PR #782 made the
    // same fix for `fetchLiveFixture`. With `no-store` the browser holds no copy to
    // revalidate, so a 304 reaches this code as it was sent.
    const doc = await api<CompetitionHubDocT>(url, {
      cache: "no-store",
      headers: seen === undefined ? {} : { "If-None-Match": seen.etag },
      onResponse: (res) => {
        etag = res.headers.get("ETag");
      },
    });
    if (etag !== null) held.set(url, { etag, doc });
    else held.delete(url);
    return doc;
  } catch (err) {
    if (err instanceof ApiError && err.status === 304 && seen !== undefined) return seen.doc;
    throw err;
  }
}
