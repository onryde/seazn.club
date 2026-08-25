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
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 0, personId: null });
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
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 5, personId: null });
    });
  });

  describe("personId via the declared doubles pair order", () => {
    it("names the pair member due, advancing the rotation as games are played", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      expect(serveContext(fold(doubles, cfg, [start]))).toEqual({
        side: "home",
        serviceTurn: 0,
        personId: "H-first",
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H)]))).toEqual({
        side: "away",
        serviceTurn: 0,
        personId: "A-first",
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A)]))).toEqual({
        side: "home",
        serviceTurn: 1,
        personId: "H-second",
      });
      expect(
        serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A), ...game(H), ...game(A)])),
      ).toEqual({ side: "home", serviceTurn: 2, personId: "H-first" }); // rotation cycles back
    });
  });

  describe("a tie-break counts as one game", () => {
    it("flips side and continues the pair rotation across a closed tie-break", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const atTB = fold(doubles, cfg, to66Events);
      expect(atTB.points.kind).toBe("tiebreak"); // sanity
      expect(atTB.serving).toBe("home"); // sanity — matches nested.test.ts's own fixture
      expect(serveContext(atTB)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first" });

      const done = fold(doubles, cfg, [...to66Events, ...straight(H, 7)]); // H takes the TB 7-0
      expect(done.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 0 } }]); // sanity
      expect(done.serving).toBe("away"); // sanity — ITF: TB's first server receives next
      expect(serveContext(done)).toEqual({ side: "away", serviceTurn: 6, personId: "A-first" });
    });

    it("scopes personId to the service game, not the point, inside a live tie-break", () => {
      const cfg = cfgFor();
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const opening = fold(doubles, cfg, to66Events);
      expect(serveContext(opening)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first" });

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
      expect(serveContext(afterP3)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first" });
    });
  });

  describe("the match-tie-break trap", () => {
    // 6-4 then 3-6: 10 + 9 = 19 games into the decider — an ODD total,
    // deliberately. If the MTB's "+1" were ever dropped, an EVEN total (e.g.
    // 10 + 10) would floor to the exact same serviceTurn either way and the
    // regression would pass unnoticed; 19 vs 20 crosses a floor(_/2)
    // boundary, so the two are only ever equal if the fix is present.
    const oneSetAll = [start, summary(6, 4), summary(3, 6)];

    it("adds nothing for an MTB still in progress, same as any other current game", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const atDecider = fold(doubles, cfg, oneSetAll);
      expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity: reached the decider

      const midMtb = fold(doubles, cfg, [...oneSetAll, ...straight(H, 3)]);
      expect(serveContext(midMtb)).toEqual({ side: "home", serviceTurn: 9, personId: "H-second" });
    });

    it("does not inflate completed games by a banked MTB's raw point score", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      // MTB closes 10-0: banked as ONE game (the 20th), not its 10 raw
      // points and not zero. Either wrong count changes `serviceTurn` here
      // (19 games → turn 9 → "H-second" is due, not away at all; 29 raw
      // points → turn 14 → "A-first" but for the wrong reason) — proven by
      // mutation testing on the production line, not re-derived in this file.
      const done = fold(doubles, cfg, [...oneSetAll, ...straight(H, 10)]);
      expect(done.sets[2]).toEqual({ home: 10, away: 0, mtb: true }); // sanity
      expect(serveContext(done)).toEqual({ side: "away", serviceTurn: 10, personId: "A-first" });
    });
  });
});
