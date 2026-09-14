// Spectator surface W2, Task 7 — fetch layer for the competition hub
// document, split out the same way `live-score-data.ts` is (W1): the
// payload-unwrap is unit-testable independent of polling
// (`competition-hub-data.test.ts`). `api()` (`lib/client.ts:6`) already
// unwraps the endpoint's `{ ok, data }` envelope once — the W1 history this
// split exists to prevent repeating is that unwrapping it a SECOND time here
// would silently replace the whole document with `undefined` on every poll.
import { api } from "@/lib/client";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

export async function fetchCompetitionHub(
  orgSlug: string,
  competitionSlug: string,
): Promise<CompetitionHubDocT> {
  // R10 H1: never the browser's HTTP cache. The route answers `Cache-Control:
  // public, s-maxage=30, stale-while-revalidate=300`, which is meant for the
  // CDN in front of share-link traffic and stays as it is. Chromium applies
  // stale-while-revalidate to its own private cache as well, though. Measured
  // on spectw2: a push-triggered refetch came back from that cache with a
  // document built BEFORE the score, and the page never moved. PR #782 made the
  // same fix for `fetchLiveFixture`.
  return api<CompetitionHubDocT>(`/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/hub`, {
    cache: "no-store",
  });
}
