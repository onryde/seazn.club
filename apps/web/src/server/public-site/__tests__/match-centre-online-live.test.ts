// T16 fix round 1, R3 — an online game being played leaves its fixture `scheduled` (nothing marks a fixture in play
// for a Lichess game: the result is written when the game ends), so the match centre said "Scheduled" — and "Starts
// 14:00" — over a game spectators could watch move by move. The header now reads the live state for such a board.
//
// The rule (one authority): the board is being played exactly when the division Fixtures list offers "Watch live"
// (`watchLinkOf`, I4) — so the list and the header never disagree. Swept over every fixture status: only a fixture
// still to be played can be lifted to live; a settled or held one keeps its own state whatever the input says.
//
// Pure here (the DB pair is in public-fixture-external-play.test.ts). Single-sport by construction: online play is
// boardgame only.
import { describe, expect, it } from "vitest";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { buildMatchCentre, statusOf, type MatchCentreInput } from "../match-centre";
import type { PublicFixture } from "../data";
import type { SideT } from "../match-centre-schema";

const F = (over: Partial<PublicFixture> = {}): PublicFixture => ({
  id: "fx1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "home",
  away_entrant_id: "away",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-10-16T18:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});
const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "Ada Okonkwo", short: "ADA", colour: null, badgeUrl: null },
  { entrantId: "away", name: "Tomasz Wieczorek", short: "TOM", colour: null, badgeUrl: null },
];
const input = (over: Partial<MatchCentreInput> = {}): MatchCentreInput => ({
  fixture: F(),
  sportKey: "boardgame",
  cfg: boardgame.configSchema.parse({ variant: "classical" }),
  events: [],
  lineups: { home: [], away: [] },
  sides: SIDES,
  venueTz: "Europe/London",
  locale: "en",
  now: new Date("2026-10-16T18:05:00.000Z"),
  hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
  stage: null,
  moduleVersion: null,
  formatLabel: null,
  ...over,
});

describe("match centre header — an online game being played (R3)", () => {
  it("the empty case first: no online game (the input absent or false) is today's header — Scheduled, 'Starts …'", () => {
    for (const doc of [buildMatchCentre(input()), buildMatchCentre(input({ onlineGameInPlay: false }))]) {
      expect([doc.header.status, doc.header.live, doc.header.statusLine?.key]).toEqual(["scheduled", false, "matchCentre.status.startsAt"]);
    }
  });

  it("a scheduled fixture whose online game is being played reads live: the Live pill, no start-time sentence", () => {
    const doc = buildMatchCentre(input({ onlineGameInPlay: true }));
    expect([doc.header.status, doc.header.live, doc.header.statusLine]).toEqual(["in_play", true, null]);
  });

  it("every fixture status: only one still to be played is lifted; every other keeps its own state", () => {
    let checked = 0;
    let lifted = 0;
    for (const status of FIXTURE_STATUSES) {
      const doc = buildMatchCentre(input({ fixture: F({ status }), onlineGameInPlay: true }));
      const want = status === "scheduled" || status === "in_play" ? "in_play" : statusOf(status);
      expect(doc.header.status, status).toBe(want);
      if (status === "scheduled") lifted += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(FIXTURE_STATUSES.length);
    expect(lifted, "the case the rule exists for was reached").toBe(1);
  });
});
