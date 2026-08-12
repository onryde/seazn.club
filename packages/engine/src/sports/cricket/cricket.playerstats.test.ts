// S8/#417 — closes three gaps in cricket's player-stat model left after W4:
// fours/sixes were undeclared, dismissals had no batter-attributed total or
// per-mode split, and no metric ever read `cricket.player.line`, so a v1-era
// fixture scored only at the coarse tier folded to zero rows. See cricket.ts
// (`CRICKET_PLAYER_STATS`) for the mechanism and the mixed-stream rule; this
// file pins the behaviour, not the design rationale.
//
// `aggregatePlayerStats` is exercised DIRECTLY on hand-built event arrays
// (never through `foldMatch`), exactly like the existing "playerStats
// leaderboards" block in cricket.domain.test.ts — the stats fold reads only
// payload shapes, never `over`/`ballInOver` sequencing or bowler/order
// legality, so a stream here only needs to be SHAPE-valid, not fold-legal.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EventEnvelope } from "../../core/events.ts";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  type PlayerStatsFoldCtx,
  type PlayerStatsModel,
} from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/index.ts";
import { cricket, CricketPlayerLine, type CricketBallEv } from "./cricket.ts";

const MODEL = cricket.playerStats!;
// Cricket never uses the entrant-fallback attribution (every payload names a
// real personId directly), so an empty ctx is enough to ACTIVATE `folded` —
// `aggregatePlayerStats` only runs it when a ctx is supplied at all.
const CTX: PlayerStatsFoldCtx = { entrants: [], personsOf: () => [] };

type Wicket = NonNullable<CricketBallEv["wicket"]>;
type PlayerLine = z.infer<typeof CricketPlayerLine>;

interface BallSpec {
  striker: string;
  nonStriker: string;
  bowler: string;
  bat?: number;
  boundary?: 4 | 6;
  wicket?: Wicket;
  extras?: NonNullable<CricketBallEv["runs"]["extras"]>;
  // S8/#417 W6b — omitted by every EXISTING call site in this file, which is
  // exactly what keeps the whole pre-W6b suite exercising the LEGACY
  // (whole-stream) fallback path unchanged; only tests that explicitly pass
  // it exercise the new per-innings path.
  innings?: number;
}

const ball = (seq: number, spec: BallSpec): EventEnvelope =>
  makeEnvelope(seq, {
    type: "cricket.ball",
    payload: {
      over: 0,
      ballInOver: seq + 1, // aggregatePlayerStats never reads over/ballInOver — uniqueness only
      striker: spec.striker,
      nonStriker: spec.nonStriker,
      bowler: spec.bowler,
      runs: {
        bat: spec.bat ?? 0,
        ...(spec.extras === undefined ? {} : { extras: spec.extras }),
      },
      ...(spec.wicket === undefined ? {} : { wicket: spec.wicket }),
      ...(spec.boundary === undefined ? {} : { boundary: spec.boundary }),
      ...(spec.innings === undefined ? {} : { innings: spec.innings }),
    } satisfies CricketBallEv,
  });

const line = (seq: number, payload: PlayerLine): EventEnvelope =>
  makeEnvelope(seq, { type: "cricket.player.line", payload });

const table = (rows: ReturnType<typeof aggregatePlayerStats>) =>
  Object.fromEntries(rows.map((r) => [r.personId, r.stats]));

// ---------------------------------------------------------------------------
// Fours and sixes.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: fours and sixes", () => {
  it("a boundary of 4 counts as a four, a boundary of 6 as a six, and a run of 4 with no boundary flag counts as neither", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, boundary: 4 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 6, boundary: 6 }),
      // Four runs scored by running (an overthrow, say) — no `boundary` flag.
      // `boundary` is only ever 4, 6 or absent by schema, so this is the only
      // way to be "not 4/6": absent.
      ball(3, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL));
    expect(t["H-1"]?.fours).toBe(1);
    expect(t["H-1"]?.sixes).toBe(1);
    expect(t["H-1"]?.runs).toBe(14);
  });

  it("fours and sixes attribute to the striker, never the bowler", () => {
    const events = [ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 6, boundary: 6 })];
    const t = table(aggregatePlayerStats(events, MODEL));
    expect(t["A-11"]?.sixes).toBeUndefined();
    expect(t["A-11"]?.fours).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dismissal-mode splits — attributed to the dismissed BATTER (`wicket.out`),
// distinct from the bowler's `wickets` and the fielder's `catches`/etc.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: dismissal-mode splits attribute to the dismissed batter", () => {
  it("a caught dismissal credits the batter, the bowler and the fielder separately — three different people", () => {
    const events = [
      ball(1, {
        striker: "H-1", nonStriker: "H-2", bowler: "A-11",
        wicket: { kind: "caught", out: "H-1", fielder: "A-5", bowlerCredited: true },
      }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL));
    // The batter: dismissed, both the total and the per-mode key — nothing else.
    expect(t["H-1"]?.dismissals).toBe(1);
    expect(t["H-1"]?.dismissals_caught).toBe(1);
    expect(t["H-1"]?.wickets).toBeUndefined();
    expect(t["H-1"]?.catches).toBeUndefined();
    // The bowler: credited a wicket — no dismissal, no catch.
    expect(t["A-11"]?.wickets).toBe(1);
    expect(t["A-11"]?.dismissals).toBeUndefined();
    expect(t["A-11"]?.catches).toBeUndefined();
    // The fielder: credited a catch — no dismissal, no wicket.
    expect(t["A-5"]?.catches).toBe(1);
    expect(t["A-5"]?.dismissals).toBeUndefined();
    expect(t["A-5"]?.wickets).toBeUndefined();
  });

  it("every one of CricketWicket.kind's ten modes splits into its own dismissals_<kind> key, and dismissals sums them", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } }),
      ball(2, { striker: "H-3", nonStriker: "H-2", bowler: "A-11", wicket: { kind: "lbw", out: "H-3", bowlerCredited: true } }),
      ball(3, { striker: "H-4", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "caught", out: "H-4", fielder: "A-5", bowlerCredited: true } }),
      ball(4, { striker: "H-5", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "runout", out: "H-5", fielder: "A-7", bowlerCredited: false } }),
      ball(5, { striker: "H-6", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "stumped", out: "H-6", fielder: "A-2", bowlerCredited: true } }),
      ball(6, { striker: "H-7", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "hitwicket", out: "H-7", bowlerCredited: true } }),
      // "retired" here is the LEGACY delivery-time wicket kind (DOMAIN.md row
      // "Retired out (as a delivery-time entry)"), a `cricket.ball` payload —
      // NOT the `cricket.retire` EVENT TYPE, which stays unscored (see the
      // "person-bearing events... unscored on purpose" tests in
      // cricket.domain.test.ts, extended below).
      ball(7, { striker: "H-8", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "retired", out: "H-8", bowlerCredited: false } }),
      ball(8, { striker: "H-9", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "obstructed", out: "H-9", fielder: "A-7", bowlerCredited: false } }),
      ball(9, { striker: "H-10", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "timedout", out: "H-10", bowlerCredited: false } }),
      ball(10, { striker: "H-11", nonStriker: "H-2", bowler: "A-10", wicket: { kind: "hitballtwice", out: "H-11", bowlerCredited: false } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL));
    const expected: Record<string, string> = {
      "H-1": "dismissals_bowled",
      "H-3": "dismissals_lbw",
      "H-4": "dismissals_caught",
      "H-5": "dismissals_runout",
      "H-6": "dismissals_stumped",
      "H-7": "dismissals_hitwicket",
      "H-8": "dismissals_retired",
      "H-9": "dismissals_obstructed",
      "H-10": "dismissals_timedout",
      "H-11": "dismissals_hitballtwice",
    };
    for (const [person, key] of Object.entries(expected)) {
      expect([person, t[person]?.[key]]).toEqual([person, 1]);
      expect([person, t[person]?.dismissals]).toEqual([person, 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// v1-era coarse stream — `cricket.player.line` only, via `folded`.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: a v1-era cricket.player.line-only stream produces rows", () => {
  it("batting and bowling lines fold into the same stat keys the fine ball ledger would have produced", () => {
    const events = [
      line(1, { innings: 1, person: "H-1", batting: { runs: 45, balls: 30, out: true } }),
      line(2, { innings: 1, person: "A-11", bowling: { legalBalls: 24, runs: 20, wickets: 2 } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]).toEqual({ runs: 45, balls_faced: 30, dismissals: 1 });
    expect(t["A-11"]).toEqual({ balls_bowled: 24, runs_conceded: 20, wickets: 2 });
  });

  it("a not-out batting line never credits a dismissal", () => {
    const events = [line(1, { innings: 1, person: "H-2", batting: { runs: 10, balls: 8, out: false } })];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-2"]).toEqual({ runs: 10, balls_faced: 8 });
  });

  it("is a no-op without a ctx, matching every other S8/#417 folded model — pre-existing callers see nothing new", () => {
    const events = [line(1, { innings: 1, person: "H-1", batting: { runs: 45, balls: 30 } })];
    const rows = aggregatePlayerStats(events, MODEL); // no ctx supplied
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mixed stream — both `cricket.ball` and `cricket.player.line`. THE RULE:
// ball-by-ball data wins wherever it exists for a person's batting/bowling
// aspect; the coarse line fills in only where fine data never touched that
// person in that aspect. Restated from cricket.ts's own `folded` comment,
// which is the authority — this file only pins the observable behaviour.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: mixed stream — no double counting", () => {
  it("a player with fine ball data has his coarse confirmation line ignored, not added on top", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 }),
      // A post-match scorecard line for H-1 that matches the ball totals
      // exactly — the shape `applyPlayerLine` requires of a real ledger when
      // the referenced innings is fine. If this were added rather than
      // ignored, runs would read 12, not 6.
      line(3, { innings: 1, person: "H-1", batting: { runs: 6, balls: 2, out: false } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]?.runs).toBe(6);
    expect(t["H-1"]?.balls_faced).toBe(2);
  });

  it("in the SAME stream, a player with no fine ball data at all still gets his coarse line counted", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, boundary: 4 }),
      // H-9 never appears on a cricket.ball event in this fixture.
      line(2, { innings: 1, person: "H-9", batting: { runs: 12, balls: 9, out: true } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]?.runs).toBe(4);
    expect(t["H-9"]).toEqual({ runs: 12, balls_faced: 9, dismissals: 1 });
  });

  it("the gate is per aspect: a bowler's fine deliveries block his coarse bowling line independently of any other player's", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 }),
      // Matches A-11's fine bowling exactly — must be ignored.
      line(3, { innings: 1, person: "A-11", bowling: { legalBalls: 2, runs: 1, wickets: 0 } }),
      // A-10 never bowls a fine delivery this fixture — his line counts.
      line(4, { innings: 1, person: "A-10", bowling: { legalBalls: 6, runs: 8, wickets: 1 } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["A-11"]?.balls_bowled).toBe(2);
    expect(t["A-11"]?.runs_conceded).toBe(1);
    expect(t["A-10"]).toEqual({ balls_bowled: 6, runs_conceded: 8, wickets: 1 });
  });
});

// ---------------------------------------------------------------------------
// S8/#417 W6b — per-innings scoping. The W6 fix 3 gate (now the LEGACY
// fallback in the next block) blocked a person's coarse credit for the
// WHOLE stream the moment ANY fine ball named them, in ANY innings — a real
// under-count: a player scored fine in innings 1 and only coarse for
// innings 2 lost innings 2 entirely, even though the two innings' figures
// never overlap. `CricketBall.innings` (optional, added this session) lets
// the gate ask "fine IN THIS INNINGS", not "fine ANYWHERE", whenever a
// producer supplies it. See cricket.ts's `folded` comment for the full
// design and cricket/DOMAIN.md's "Player leaderboards from the ledger" row
// for the same fix stated for a reader who never opens cricket.ts.
// ---------------------------------------------------------------------------

describe("cricket S8/#417 W6b: the fine/coarse gate is scoped per innings", () => {
  it("a player with fine ball-by-ball data in innings 1 and ONLY a coarse line for innings 2 gets BOTH innings counted, once each", () => {
    const events = [
      // Innings 1 — H-1 batted fine: 10 runs off 2 legal balls, tagged.
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, innings: 1 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 6, innings: 1 }),
      // Innings 2 — H-1 was scored ONLY at the coarse tier: 20 runs off 15
      // balls, out. The gate now recognises innings 1's fine coverage does
      // NOT extend to innings 2, so this line ADDS rather than being lost —
      // the exact counterfactual the old KNOWN LIMITATION test documented
      // as unimplemented.
      line(3, { innings: 2, person: "H-1", batting: { runs: 20, balls: 15, out: true } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]).toEqual({ runs: 30, balls_faced: 17, dismissals: 1 });
  });

  it("same innings, both fine and coarse present — fine still wins, no double count (unchanged by W6b)", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, innings: 1 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2, innings: 1 }),
      // A confirmation line for the SAME innings the fine balls belong to —
      // must still be ignored, exactly as the whole-stream gate always
      // ignored it, now via a per-innings match rather than a whole-stream
      // one (`hasFineCoverage`'s `byInnings` branch, not its `whole` one).
      line(3, { innings: 1, person: "H-1", batting: { runs: 6, balls: 2, out: false } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]?.runs).toBe(6);
    expect(t["H-1"]?.balls_faced).toBe(2);
  });

  it("a voided fine ball un-counts from ITS OWN innings only, letting a coarse line for that innings through even though the person has other real fine data elsewhere", () => {
    const events0 = [ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, innings: 1 })];
    const events = [
      ...events0,
      makeEnvelope(2, { type: "core.void", payload: {} }, events0[0]!.id),
      // A real, un-voided fine ball for the SAME person in a DIFFERENT innings.
      ball(3, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1, innings: 2 }),
      // The coarse line is for innings 1, whose only fine ball was voided —
      // under the pre-W6b whole-stream gate this would still be blocked by
      // the surviving innings-2 fine ball; per-innings scoping is what lets
      // it through.
      line(4, { innings: 1, person: "H-1", batting: { runs: 20, balls: 15, out: true } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    // Innings 1: no surviving fine data ⇒ the coarse line counts (runs 20,
    // balls 15, dismissals 1). Innings 2: one real fine ball ⇒ its own
    // numbers (runs 1, balls_faced 1), no line to compete with.
    expect(t["H-1"]).toEqual({ runs: 21, balls_faced: 16, dismissals: 1 });
  });
});

// ---------------------------------------------------------------------------
// Legacy fallback — S8/#417 W6 fix 3's original whole-stream gate, still
// exact for any stream (or any single ball) recorded before `innings`
// existed. THE RULE: a fine ball with no `innings` discriminator blocks
// EVERY innings for that person/aspect, never just its own — the
// conservative choice that keeps a v1-era or any not-yet-upgraded stream's
// numbers byte-identical to what W6 shipped. This is the SAME stream the
// old "KNOWN LIMITATION" test pinned, with the SAME expected numbers: it is
// not a limitation any more for a tagged producer, but it remains the
// correct, deliberate behaviour for an untagged one.
// ---------------------------------------------------------------------------

describe("cricket S8/#417 W6b: legacy fallback — balls with no innings discriminator", () => {
  it("a player with fine ball-by-ball data in innings 1 (no innings tag) and ONLY a coarse line for innings 2 still loses innings 2 — the pre-W6b behaviour, unchanged", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 }),
      ball(2, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 6 }),
      line(3, { innings: 2, person: "H-1", batting: { runs: 20, balls: 15, out: true } }),
    ];
    const t = table(aggregatePlayerStats(events, MODEL, undefined, CTX));
    expect(t["H-1"]).toEqual({ runs: 10, balls_faced: 2 });
  });
});

// ---------------------------------------------------------------------------
// Void events un-count everywhere, including the folded (coarse) path.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: void un-counts fours/sixes/dismissals and the folded path", () => {
  it("a voided six and a voided caught dismissal both un-count", () => {
    const events0 = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 6, boundary: 6 }),
      ball(2, {
        striker: "H-3", nonStriker: "H-2", bowler: "A-11",
        wicket: { kind: "caught", out: "H-3", fielder: "A-5", bowlerCredited: true },
      }),
    ];
    const events = [
      ...events0,
      makeEnvelope(3, { type: "core.void", payload: {} }, events0[0]!.id),
      makeEnvelope(4, { type: "core.void", payload: {} }, events0[1]!.id),
    ];
    expect(aggregatePlayerStats(events, MODEL)).toEqual([]);
  });

  it("a voided cricket.player.line un-counts in the folded (coarse) path too", () => {
    const events0 = [line(1, { innings: 1, person: "H-9", batting: { runs: 12, balls: 9, out: true } })];
    const events = [...events0, makeEnvelope(2, { type: "core.void", payload: {} }, events0[0]!.id)];
    expect(aggregatePlayerStats(events, MODEL, undefined, CTX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: determinism", () => {
  it("folding the same mixed stream twice yields deeply equal rows", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, boundary: 4 }),
      ball(2, {
        striker: "H-3", nonStriker: "H-2", bowler: "A-11",
        wicket: { kind: "caught", out: "H-3", fielder: "A-5", bowlerCredited: true },
      }),
      line(3, { innings: 1, person: "H-9", batting: { runs: 12, balls: 9, out: true } }),
    ];
    const first = aggregatePlayerStats(events, MODEL, undefined, CTX);
    const second = aggregatePlayerStats(events, MODEL, undefined, CTX);
    expect(second).toEqual(first);
    expect(second.map((r) => r.personId)).toEqual(first.map((r) => r.personId));
  });

  // S8/#417 W6b — the same determinism property, but through the new
  // per-innings `FineCoverage` Map/Set bookkeeping, not just the pre-existing
  // whole-stream Set.
  it("folding the same per-innings-tagged stream twice yields deeply equal rows", () => {
    const events = [
      ball(1, { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, innings: 1 }),
      line(2, { innings: 2, person: "H-1", batting: { runs: 8, balls: 6, out: false } }),
    ];
    const first = aggregatePlayerStats(events, MODEL, undefined, CTX);
    const second = aggregatePlayerStats(events, MODEL, undefined, CTX);
    expect(second).toEqual(first);
    expect(second.map((r) => r.personId)).toEqual(first.map((r) => r.personId));
  });
});

// ---------------------------------------------------------------------------
// playerStatsKeyCollisions — S8/#417 W6 fix 1. CRICKET_PLAYER_STATS declares
// `folded.keys` HONESTLY (the six keys `fold` actually writes: `runs`,
// `balls_faced`, `balls_bowled`, `runs_conceded`, `wickets`, `dismissals`)
// and marks all six as `sharesMetricKeys` — a declared, intentional overlap
// with `metrics[]` (the gated fine/coarse merge cricket.ts documents), not
// an accidental clash. Before this fix `folded.keys` was hardcoded `[]` to
// dodge the checker entirely, which meant nothing protected those six names
// from a genuinely accidental future `metrics[]` addition either — the test
// below is what proves the checker can still catch THAT.
// ---------------------------------------------------------------------------

describe("cricket S8/#417: playerStatsKeyCollisions", () => {
  it("CRICKET_PLAYER_STATS is clean — every folded/metric overlap is declared", () => {
    expect(playerStatsKeyCollisions(cricket.playerStats!)).toEqual([]);
  });

  it("an UNDECLARED collision — a future metrics[] key duplicating a folded key never listed in sharesMetricKeys — is still caught", () => {
    // A local copy of cricket's real shape, not a mutation of the exported
    // model: adds ONE new metric ("boundaries") whose key the fold ALSO
    // starts writing (simulating the exact accident this fix protects
    // against), without adding it to sharesMetricKeys.
    const withAccidentalCollision: PlayerStatsModel = {
      ...MODEL,
      metrics: [...MODEL.metrics, { key: "boundaries", label: "Boundaries", from: "cricket.ball", agg: "count" }],
      folded: {
        ...MODEL.folded!,
        keys: [...MODEL.folded!.keys, "boundaries"],
        // sharesMetricKeys deliberately NOT extended — this is the accident.
      },
    };
    expect(playerStatsKeyCollisions(withAccidentalCollision)).toEqual(["boundaries"]);
  });
});
