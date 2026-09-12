// Fetch layer for the public live scoreboard, split out so the payload
// unwrapping is unit-testable (lib/client.ts's api() already returns the
// endpoint's `data` — unwrapping it twice was a live bug: every 15 s poll
// replaced the score with `undefined`).
import { api } from "@/lib/client";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { RecentEvent } from "@/lib/overlay-recent-types";
import type { OverlayClosedOver, OverlayCricketLive, OverlayCricketToss } from "@/lib/overlay-cricket";

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
  // (`data.match_centre`).
  //
  // Task 14b update — the "later task" this comment used to point at has
  // shipped: Task 9 wired `getPublicFixture`'s own `matchCentre` field
  // (`server/public-site/data.ts`) and Task 14 wired BOTH real production
  // callers of this type — the fixture detail page's own
  // `initial.match_centre = data.matchCentre` (`page.tsx`) for first paint,
  // and this same `publicFixture()` (`server/usecases/public.ts:376-377`,
  // the `/api/v1/public/fixtures/[id]` polling endpoint `fetchLiveFixture`
  // below calls) for every poll tick after that. Both go through the
  // identical `loadMatchCentre`, which is non-nullable
  // (`Promise<MatchCentreDocT>`, `match-centre-load.ts:224`) — so in
  // production this field is always populated today, on first paint and on
  // every refresh.
  //
  // Still optional here (not `MatchCentreDocT` bare), not because a real
  // caller can omit it, but because `MatchCentre` itself guards on its
  // absence rather than asserting it non-null (`match-centre.tsx`'s
  // `if (!doc || …) return <fallback/>`) — kept for the deliberately
  // no-`matchCentre` fixtures `page.test.ts`'s `baseData()` still
  // constructs, which prove that fallback path (`mc-fallback`) stays intact.
  match_centre?: MatchCentreDocT;
}

/** The overlay's one poll target (design §3.2). `status`/`summary`/`outcome`
 *  are the SAME row `LiveFixtureData` reads (one authority: match_states);
 *  `clock` and `cricket` are projected server-side off the folded state.
 *  W2 reads `lastSeq` as its mount-seq.
 *
 *  `clock` is present only while the folded state's `asOf.period === phase`:
 *  during a play phase it anchors the stage's 1 Hz tick, and at half-time /
 *  full-time the field is ABSENT so the stage holds the last displayed value.
 *  `anchorAtWallMs` is the wall time of the LAST active envelope, so a viewer
 *  joining mid-half sees `anchorSeconds + (now − anchorAtWallMs)`. */
export interface OverlayLiveData extends LiveFixtureData {
  lastSeq: number | null;
  venueTz: string;
  /** `nominalSeconds` — F16: the phase's declared length, from the cfg the
   *  fixture was folded under (`server/overlay/project.ts`'s
   *  `nominalSecondsOf`). The stage shows `45+` past it instead of counting on;
   *  ABSENT when the state declares no readable length, and the stage then
   *  HOLDS at the anchor rather than ticking without a bound. */
  clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number; nominalSeconds?: number };
  cricket?: {
    innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[];
  };
  /** W2 — the last `OVERLAY_RECENT_WINDOW` surviving module events, oldest
   *  first, with the engine's own type strings and a consent-resolved person
   *  where the payload names one (`server/overlay/recent.ts`). The moment slab
   *  derives from this and from nothing else; `match_centre` never arrives on
   *  this payload (it typechecks, because this interface extends
   *  `LiveFixtureData`, and is always `undefined` at runtime).
   *
   *  OPTIONAL here, ALWAYS EMITTED by the endpoint. The asymmetry is deliberate:
   *  `projectOverlayLiveData` always sets an array (possibly empty), but
   *  `fixture-stream-panel.tsx` seeds an `OverlayLiveData` from a fixture ROW
   *  before any poll has happened, and `[]` there would assert "this fixture has
   *  no recent events" when the truth is "none have been loaded". */
  recent?: RecentEvent[];
  /** W2 Task 3 — the crease: who is batting with their figures, the bowler's
   *  analysis and this over's glyphs, from the engine's own scorecard. Absent
   *  for every sport but cricket, and for a cricket fixture between innings or
   *  before its first ball. `cricket` above carries the SCORE; this carries the
   *  people. */
  cricketLive?: OverlayCricketLive | null;
  /** Match openers — toss winner side + bat/bowl election. */
  cricketToss?: OverlayCricketToss | null;
  /** End-of-over card — most recently completed over in the active innings. */
  lastClosedOver?: OverlayClosedOver | null;
  /** True once any scoring (ball / over) has been recorded. */
  scoringStarted?: boolean;
}

export interface PublicRealtimeToken {
  token: string;
  channel: string;
}

export async function fetchLiveFixture(fixtureId: string): Promise<LiveFixtureData> {
  return api<LiveFixtureData>(`/api/v1/public/fixtures/${fixtureId}`);
}

export async function fetchOverlayFixture(fixtureId: string): Promise<OverlayLiveData> {
  return api<OverlayLiveData>(`/api/v1/public/fixtures/${fixtureId}/overlay`);
}

export async function fetchPublicRealtimeToken(
  fixtureId: string,
): Promise<PublicRealtimeToken> {
  return api<PublicRealtimeToken>(`/api/v1/public/fixtures/${fixtureId}/realtime-token`);
}
