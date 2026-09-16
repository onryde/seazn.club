// Spectator W2, Task 15 — fetch layer for the org home's live poll, split out
// the same way `competition-hub-data.ts` is so the URL and the envelope unwrap
// are unit-testable apart from the polling island (`org-live-data.test.ts`).
// `api()` (`lib/client.ts`) unwraps `{ ok, data }` once; unwrapping it again
// here would replace every poll's answer with `undefined`.
import { api } from "@/lib/client";
import type { PublicOrgLiveT } from "@/server/api-v1/schemas";

export async function fetchOrgLive(orgSlug: string): Promise<PublicOrgLiveT> {
  // R10 H1: never the browser's HTTP cache (see `fetchCompetitionHub`).
  return api<PublicOrgLiveT>(`/api/v1/public/orgs/${orgSlug}/live`, { cache: "no-store" });
}
