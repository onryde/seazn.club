// Fetch layer for the public live scoreboard, split out so the payload
// unwrapping is unit-testable (lib/client.ts's api() already returns the
// endpoint's `data` — unwrapping it twice was a live bug: every 15 s poll
// replaced the score with `undefined`).
import { api } from "@/lib/client";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";

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
  // Task 10 dispatch ruling 1 — the match-centre document `MatchCentre` reads
  // (`data.match_centre`). Optional, not `MatchCentreDocT` bare: the SERVER
  // side that populates it is a later task (`getPublicFixture`/`publicFixture()`
  // in server/usecases/public.ts do not select it yet), and the current
  // production page still constructs `initial` without it (see the fixture
  // detail page's `<LiveScore initial={{ status, summary, outcome }} .../>`)
  // — making this required would have been a real (silent, since this task
  // does not run tsc) type break on that still-unwired call site. `MatchCentre`
  // itself guards on its absence rather than asserting it non-null.
  match_centre?: MatchCentreDocT;
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
