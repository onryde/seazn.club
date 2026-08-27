// Fetch layer for the public live scoreboard, split out so the payload
// unwrapping is unit-testable (lib/client.ts's api() already returns the
// endpoint's `data` — unwrapping it twice was a live bug: every 15 s poll
// replaced the score with `undefined`).
import { api } from "@/lib/client";

export interface LiveFixtureData {
  status: string;
  summary: {
    headline?: string;
    perSide?: { entrantId: string; line: string }[];
    detail?: unknown;
  } | null;
  // R3.5/Task O — widened from `{ kind?; winner? }`, same gap and same fix as
  // `PublicFixture.outcome` (server/public-site/data.ts, R3.5/Task G): the
  // live polling endpoint (`/api/v1/public/fixtures/[id]`, `publicFixture()`
  // in server/usecases/public.ts) already selects the WHOLE `outcome` JSONB
  // off `public_fixtures_v`, so `method` was already arriving at runtime —
  // this hand-written client type was just under-declaring it. Without
  // `method` here, `LiveScore` cannot say HOW a fixture it is polling was
  // decided, only who won.
  outcome: { kind?: string; winner?: string; loser?: string; method?: string } | null;
}

export interface PublicRealtimeToken {
  token: string;
  channel: string;
}

export async function fetchLiveFixture(fixtureId: string): Promise<LiveFixtureData> {
  return api<LiveFixtureData>(`/api/v1/public/fixtures/${fixtureId}`);
}

export async function fetchPublicRealtimeToken(
  fixtureId: string,
): Promise<PublicRealtimeToken> {
  return api<PublicRealtimeToken>(`/api/v1/public/fixtures/${fixtureId}/realtime-token`);
}
