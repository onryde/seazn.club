// Spectator surface W2, Task 14 — fetch layer for the player page's match
// lines, split out the way `competition-hub-data.ts` is so its URL and unwrap
// are testable apart from the poll (`player-matches-data.test.ts`). `api()`
// already unwraps the endpoint's `{ ok, data }` envelope; unwrapping it again
// here would replace the lines with `undefined` on every tick.
import { api } from "@/lib/client";
import type { PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";

export async function fetchPlayerMatches(
  orgSlug: string,
  competitionSlug: string,
  personId: string,
): Promise<PublicPlayerMatchesT> {
  // `no-store` for the reason `fetchCompetitionHub` gives (R10 H1): the route's
  // `stale-while-revalidate` is meant for the CDN, and Chromium applies it to
  // its own HTTP cache too, which answered a live refetch with the old figures.
  return api<PublicPlayerMatchesT>(
    `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/players/${personId}/matches`,
    { cache: "no-store" },
  );
}
