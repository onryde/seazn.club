// R4-3 (owner ruling, R4 dispatch) — the ITF doubles serve rotation lives in
// the engine, not the pad: a pad-side copy would fork from the fold the
// moment either one drifts. `serveContext` answers "who serves the current
// service game" by side and (in a declared doubles fixture) by person, for
// the state as folded so far.
//
// Every test names a concrete side/turn/personId, never just checks a field
// is present — a fold that stored the right numbers under the wrong key
// would still pass a shape-only assertion.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { tennis } from "../tennis/tennis.ts";
import { serveContext, type NestedState } from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

const H = "H";
const A = "A";

// No declared pair order — `defaultLineupPair` puts one player per side.
const singles: LineupPair = defaultLineupPair(tennis.positions);

// A declared doubles order, first-named first — `orderNo` runs the OTHER
// way, matching `lineup.test.ts`'s fixture, so a reader that quietly used
// `orderNo` instead answers with the wrong player.
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}
const doubles: LineupPair = {
  home: pairSide(H, "H-first", "H-second"),
  away: pairSide(A, "A-first", "A-second"),
};

function cfgFor(variant?: string, extra?: Record<string, unknown>) {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) });
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function fold(lineups: LineupPair, cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events), STRICT_ALL);
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const straight = (by: string, n: number): ModuleEvent[] => Array(n).fill(point(by));
// A clean 4-straight-point game — noAd or not, 4 straight points for one
// side never reaches a contested deuce, so it always closes the game.
const game = (by: string): ModuleEvent[] => straight(by, 4);
const gamesFor = (by: string, n: number): ModuleEvent[] =>
  Array.from({ length: n }, () => game(by)).flat();
const summary = (home: number, away: number, tb?: { home: number; away: number }): ModuleEvent => ({
  type: "tennis.set_summary",
  payload: { home, away, ...(tb === undefined ? {} : { tb }) },
});

describe("serveContext", () => {
  describe("side and service-game turn (singles, no declared pair order)", () => {
    it("starts the match with the initial server, turn 0, no personId", () => {
      const state = fold(singles, cfgFor(), [start]);
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 0, personId: null, serveOrderKnown: true });
    });

    it("floor(completed games / 2) matches the fold's own alternation, game by game", () => {
      // Serve alternates every game regardless of who WINS it, so who scores
      // each game is irrelevant here — only the count matters.
      const events: ModuleEvent[] = [start];
      for (let g = 0; g <= 7; g++) {
        const state = fold(singles, cfgFor(), events);
        expect(serveContext(state)).toEqual({
          side: g % 2 === 0 ? "home" : "away",
          serviceTurn: Math.floor(g / 2),
          personId: null,
          serveOrderKnown: true,
        });
        events.push(...game(g % 2 === 0 ? H : A));
      }
    });

    it("keeps counting across a closed-set boundary", () => {
      // Same fixture as nested.test.ts's "wins a 6-4 set" — 10 games total,
      // banked as ONE closed set, not left sitting in `state.games`.
      const seq = [start, ...gamesFor(H, 5), ...gamesFor(A, 4), ...game(H)];
      const state = fold(singles, cfgFor(), seq);
      expect(state.sets).toEqual([{ home: 6, away: 4 }]); // sanity: set banked
      expect(state.games).toEqual({ home: 0, away: 0 }); // sanity: new set fresh
      // 10 games completed (an even count) → serve is back with the side that
      // opened the match.
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 5, personId: null, serveOrderKnown: true });
    });
  });

  describe("personId via the declared doubles pair order", () => {
    it("names the pair member due, advancing the rotation as games are played", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      expect(serveContext(fold(doubles, cfg, [start]))).toEqual({
        side: "home",
        serviceTurn: 0,
        personId: "H-first",
        serveOrderKnown: true,
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H)]))).toEqual({
        side: "away",
        serviceTurn: 0,
        personId: "A-first",
        serveOrderKnown: true,
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A)]))).toEqual({
        side: "home",
        serviceTurn: 1,
        personId: "H-second",
        serveOrderKnown: true,
      });
      expect(
        serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A), ...game(H), ...game(A)])),
      ).toEqual({ side: "home", serviceTurn: 2, personId: "H-first", serveOrderKnown: true }); // rotation cycles back
    });
  });

  describe("a tie-break counts as one game", () => {
    it("flips side and continues the pair rotation across a closed tie-break", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const atTB = fold(doubles, cfg, to66Events);
      expect(atTB.points.kind).toBe("tiebreak"); // sanity
      expect(atTB.serving).toBe("home"); // sanity — matches nested.test.ts's own fixture
      expect(serveContext(atTB)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });

      const done = fold(doubles, cfg, [...to66Events, ...straight(H, 7)]); // H takes the TB 7-0
      expect(done.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 0 } }]); // sanity
      expect(done.serving).toBe("away"); // sanity — ITF: TB's first server receives next
      // R4 defect 1 fix: 6 standard-game turns each in the set, then the
      // 7-point (4-turn, 2-per-side) breaker — 8 turns each once it closes.
      // Still "A-first": 6 (the pre-fix value) and 8 share a parity, the
      // coincidence the next test's OWN following game does not get.
      expect(serveContext(done)).toEqual({ side: "away", serviceTurn: 8, personId: "A-first", serveOrderKnown: true });
    });

    // R4 defect 1 (HIGH) — a 7-point breaker is really 4 ITF turns (1, then
    // 2-2-2), 2 per side, not the one "game" `nestedGamesOf` credits it. The
    // set 2 game 1 case above still names the right partner because 6 and
    // the real 8 share a parity by coincidence; ONE more game crosses a
    // floor(_/2) boundary the old formula cannot see, and the rotation
    // desyncs for the rest of the match. Real turns per side once the
    // breaker closes: 6 standard games + 2 breaker turns = 8 each — home's
    // NEXT turn (index 8, home's 9th) is even, so H-first is due again,
    // same as their pre-breaker turn 6; the old formula's index 7 is odd,
    // naming H-second instead.
    it("does not desync the doubles rotation for the game after a closed tie-break", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const afterTb = [...to66Events, ...straight(H, 7)]; // H takes the TB 7-0

      const setTwoGameTwo = fold(doubles, cfg, [...afterTb, ...game(A)]); // away opens set 2
      expect(setTwoGameTwo.serving).toBe("home"); // sanity — alternation continues normally
      // Today's code answers floor(14/2) = 7 (odd), naming H-second — the
      // wrong partner, and the defect this test pins.
      expect(serveContext(setTwoGameTwo)).toEqual({
        side: "home",
        serviceTurn: 8,
        personId: "H-first",
        serveOrderKnown: true,
      });
    });

    it("scopes personId to the service game, not the point, inside a live tie-break", () => {
      const cfg = cfgFor();
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const opening = fold(doubles, cfg, to66Events);
      expect(serveContext(opening)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });

      // 3 TB points in: real service has already passed to home's SECOND
      // partner for this (4th) point (ITF: 1 point then 2-each rotating
      // through all four players) — `side` tracks that correctly...
      const afterP3 = fold(doubles, cfg, [...to66Events, point(H), point(H), point(H)]);
      expect(afterP3.serving).toBe("home"); // sanity — point 4 is home's turn again
      // ...but `serviceTurn` is a service-GAME count (completed games are
      // unchanged mid-tie-break) and does not advance point by point, so
      // `personId` still names whoever opened home's spell in this
      // tie-break, not the individual actually due this rally. Documented
      // scope, not a silent miss — see serveContext's doc comment.
      expect(serveContext(afterP3)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });
    });

    it("stays known one point into a tie-break, where `serving` has rotated", () => {
      // ITF hands the breaker's second point to the other side, so after
      // exactly one point `state.serving` is NOT the side the walk expects
      // to be serving this set — the breaker's FIRST server is. Comparing
      // `serving` alone here would report a drift in a match that has never
      // been anything but rally-scored, and would kill the serve pip for
      // half of every tie-break. `tbFirstServer` is what makes that right.
      // Mutation-proved: dropping the `tbFirstServer ?? …` fallback fails
      // this test alone.
      const cfg = cfgFor();
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const afterP1 = fold(doubles, cfg, [...to66Events, point(H)]);
      expect(afterP1.serving).toBe("away"); // sanity — point 2 is away's
      expect(serveContext(afterP1)).toEqual({
        side: "away",
        serviceTurn: 6,
        personId: "A-first",
        serveOrderKnown: true,
      });
    });
  });

  describe("the match-tie-break trap", () => {
    // 6-4 then 3-6, both banked via a `*.set_summary`. `serving` is never
    // touched by a summary fold (this struct's own field comment: "rally
    // fidelity only"), so it stays at `init`'s "home serves first" through
    // both closures — but the turn walk DOES cross them, and 3-6 is nine
    // games, so it flips its opener where the fold did not. This fixture is
    // therefore a desynced one, deliberately: it pins the MTB turn
    // arithmetic (what these two tests are for) AND the refusal that
    // desync must produce. The even-game fixture below is the paired case
    // where the rotation survives a summary backfill intact.
    const oneSetAll = [start, summary(6, 4), summary(3, 6)];

    it("adds nothing for an MTB still in progress, same as any other current game", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const atDecider = fold(doubles, cfg, oneSetAll);
      expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity: reached the decider

      const midMtb = fold(doubles, cfg, [...oneSetAll, ...straight(H, 3)]);
      // 10 (6-4, even, no flip) + 9 (3-6, odd, home stays ahead) standard-
      // game turns credit home 10, away 9 before the live (still open, so
      // not yet counted) MTB — unaffected by the 3 MTB points already
      // played, same as any other live breaker (see the live-tie-break
      // test above).
      // The turn count stands on its own; the person does not, because the
      // 3-6 summary desynced the rotation (see the fixture comment).
      expect(serveContext(midMtb)).toEqual({
        side: "home",
        serviceTurn: 10,
        personId: null,
        serveOrderKnown: false,
      });
    });

    it("does not inflate completed games by a banked MTB's raw point score", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      // MTB closes 10-0: 6 real turns (1, then 2-2-2-2), split 3-3 since 6
      // is even — not its 10 raw points and not zero. Either wrong count
      // changes `serviceTurn` here (10 raw turns/side inflates it further;
      // 0 turns leaves it at 10/9) — proven by mutation testing on the
      // production line, not re-derived in this file.
      const done = fold(doubles, cfg, [...oneSetAll, ...straight(H, 10)]);
      expect(done.sets[2]).toEqual({ home: 10, away: 0, mtb: true }); // sanity
      expect(serveContext(done)).toEqual({
        side: "away",
        serviceTurn: 12,
        personId: null,
        serveOrderKnown: false,
      });
    });

    it("still names the partner into an MTB when both summary sets are even", () => {
      // The paired case: 6-4 (10 games) and 2-6 (8) both leave the opener
      // where it was, so the walk and the fold never diverge and a scorer
      // who backfilled two sets still gets a serve pip in the decider.
      // Guards against the refusal above being a blanket "any summary set
      // kills the rotation" — that would cost the feature its most common
      // real use, a late-arriving scorer entering the sets already played.
      const cfg = cfgFor("doubles-noad-mtb10");
      const atDecider = fold(doubles, cfg, [start, summary(6, 4), summary(2, 6)]);
      expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity
      expect(serveContext(atDecider)).toEqual({
        side: "home",
        serviceTurn: 9,
        personId: "H-second",
        serveOrderKnown: true,
      });
    });

    // A match tie-break is NOT handed off under ITF 5b — there is no next set
    // to hand off to, and `applyTbPoint` skips the `serving:
    // opponent(tbFirstServer)` overwrite it applies to an ordinary breaker,
    // banking the raw point-by-point rotation instead. The walk must mirror
    // that rotation, not assume a handoff.
    //
    // Pinned across EVERY reachable 10-N scoreline rather than one of them,
    // because the two rules agree on a coincidence: an unconditional flip is
    // right exactly when `ceil(points / 2)` is odd, so 10-0 — the obvious
    // fixture, and the only one this file used to carry — passes under both.
    // 10-1, 10-2, 10-5 and 10-6 are where they part.
    //
    // The domain claim under the whole table, independent of the arithmetic:
    // once a match is OVER, its serve rotation is fully determined. There is
    // no honest reason for `serveOrderKnown` to be false on any row.
    const MTB_ROTATION: Array<{ lost: number; side: "home" | "away"; serviceTurn: number; personId: string }> = [
      { lost: 0, side: "away", serviceTurn: 12, personId: "A-first" },
      { lost: 1, side: "home", serviceTurn: 12, personId: "H-first" },
      { lost: 2, side: "home", serviceTurn: 13, personId: "H-second" },
      { lost: 3, side: "away", serviceTurn: 12, personId: "A-first" },
      { lost: 4, side: "away", serviceTurn: 13, personId: "A-second" },
      { lost: 5, side: "home", serviceTurn: 13, personId: "H-second" },
      { lost: 6, side: "home", serviceTurn: 14, personId: "H-first" },
      { lost: 7, side: "away", serviceTurn: 13, personId: "A-second" },
      { lost: 8, side: "away", serviceTurn: 14, personId: "A-first" },
    ];

    for (const row of MTB_ROTATION) {
      it(`tracks the fold's own rotation across a CLOSED match tie-break won 10-${row.lost}`, () => {
        const cfg = cfgFor("doubles-noad-mtb10");
        // Point ORDER cannot matter — the ITF handoff counts points, not who
        // won them — so the loser's points are taken first, then the winner's.
        const done = fold(doubles, cfg, [
          start,
          summary(6, 4),
          summary(2, 6),
          ...straight(A, row.lost),
          ...straight(H, 10),
        ]);
        expect(done.sets[2]).toEqual({ home: 10, away: row.lost, mtb: true }); // sanity
        expect(done.phase).toBe("done"); // sanity — the walk is answering for a finished match
        expect(serveContext(done)).toEqual({
          side: row.side,
          serviceTurn: row.serviceTurn,
          personId: row.personId,
          serveOrderKnown: true,
        });
      });
    }
  });

  // A tier-0 `*.set_summary` banks a set without advancing `state.serving`
  // (`bankSet` never touches it) — but the turn walk DOES advance its own
  // opener across that set's game parity. Where those two disagree the pair
  // rotation has no honest answer, and `serveContext` must not invent one.
  describe("a summary-banked set can desync the fold from the walk", () => {
    it("refuses to name a partner after an ODD-game summary set", () => {
      const state = fold(doubles, cfgFor(), [start, summary(6, 3), ...game(H)]);
      // 9 games: the walk flips its opener, `serving` did not. Naming anyone
      // here picks a partner off a rotation the fold never agreed to.
      expect(serveContext(state).serveOrderKnown).toBe(false);
      expect(serveContext(state).personId).toBeNull();
    });

    it("still names the partner after an EVEN-game summary set", () => {
      // 8 games: the walk does not flip either, so the two agree and the
      // rotation is genuinely derivable — the guard must not over-refuse.
      const state = fold(doubles, cfgFor(), [start, summary(6, 2)]);
      expect(serveContext(state)).toMatchObject({
        side: "home",
        serviceTurn: 4,
        serveOrderKnown: true,
        personId: "H-first",
      });
    });

    it("refuses after a tie-break summary set (ITF 5b flips, the fold did not)", () => {
      const state = fold(doubles, cfgFor(), [start, summary(7, 6, { home: 7, away: 5 })]);
      expect(serveContext(state).serveOrderKnown).toBe(false);
      expect(serveContext(state).personId).toBeNull();
    });

    it("reports a rally-scored match as known throughout, live tie-break included", () => {
      const state = fold(doubles, cfgFor(), [start, ...gamesFor(H, 6), ...gamesFor(A, 6)]);
      expect(serveContext(state).serveOrderKnown).toBe(true);
    });
  });
});
