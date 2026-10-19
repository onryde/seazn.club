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
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { onlineHeaderOf } from "@/server/usecases/external-play-read";

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

// T17 owner change (2026-10-13): from the round's open until the first move an online board reads STARTING. The
// header's STATUS stays `scheduled` (the poster, the hub, the subheading and every other reader keep their scheduled
// reading); a separate flag, present ONLY in that state, is what the court card's chip reads. Its source is the
// Fixtures list's link (`watchLinkOf` — kind "starting"), as R3's is, so the list and the header never disagree.
describe("match centre header — an online board starting: the round open, no move yet (owner, 2026-10-13)", () => {
  it("the empty case first: the input absent or false — no flag at all, the header byte-for-byte today's", () => {
    let checked = 0;
    for (const doc of [buildMatchCentre(input()), buildMatchCentre(input({ onlineGameStarting: false })), buildMatchCentre(input({ onlineGameInPlay: false, onlineGameStarting: false }))]) {
      expect(Object.hasOwn(doc.header, "onlineStarting"), "no key, not a false one").toBe(false);
      expect(doc.header).toEqual(buildMatchCentre(input()).header);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("starting: the header stays scheduled (not live, the start-time sentence kept) and carries the flag", () => {
    const doc = buildMatchCentre(input({ onlineGameStarting: true }));
    expect([doc.header.status, doc.header.live, doc.header.statusLine?.key, doc.header.onlineStarting]).toEqual([
      "scheduled",
      false,
      "matchCentre.status.startsAt",
      true,
    ]);
    // Nothing else of the header moved: the same document as today's, plus the one key.
    const rest = { ...doc.header };
    delete rest.onlineStarting;
    expect(rest).toEqual(buildMatchCentre(input()).header);
  });

  it("every fixture status: only a scheduled one carries the flag; every other keeps its own header", () => {
    let checked = 0;
    let flagged = 0;
    for (const status of FIXTURE_STATUSES) {
      const doc = buildMatchCentre(input({ fixture: F({ status }), onlineGameStarting: true }));
      const today = buildMatchCentre(input({ fixture: F({ status }) }));
      if (status === "scheduled") {
        expect(doc.header.onlineStarting, status).toBe(true);
        flagged += 1;
      } else {
        expect(doc.header, status).toEqual(today.header);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(FIXTURE_STATUSES.length);
    expect(flagged, "the case the ruling exists for was reached").toBe(1);
  });

  it("a guard, not an assumption: both inputs at once (one link kind gives one) — live wins and no flag is carried", () => {
    const doc = buildMatchCentre(input({ onlineGameInPlay: true, onlineGameStarting: true }));
    expect([doc.header.status, doc.header.live, Object.hasOwn(doc.header, "onlineStarting")]).toEqual(["in_play", true, false]);
  });

  it("the one authority: the header inputs come from the Fixtures list's link — Starting, Live, and Scheduled before the open", () => {
    const cases: [PublicWatchLink | null, { onlineGameInPlay: boolean; onlineGameStarting: boolean }][] = [
      [{ kind: "starting" }, { onlineGameInPlay: false, onlineGameStarting: true }],
      [{ kind: "live" }, { onlineGameInPlay: true, onlineGameStarting: false }],
      [{ kind: "not_opened" }, { onlineGameInPlay: false, onlineGameStarting: false }],
      [{ kind: "final", score: "1–0", noResult: false }, { onlineGameInPlay: false, onlineGameStarting: false }],
      [null, { onlineGameInPlay: false, onlineGameStarting: false }],
    ];
    let checked = 0;
    for (const [link, want] of cases) {
      expect(onlineHeaderOf(link), JSON.stringify(link)).toEqual(want);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});
