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
  return api<CompetitionHubDocT>(`/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/hub`);
}
