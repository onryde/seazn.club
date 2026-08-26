// Cricket goldens + properties + conformance — spec 04 §2, PROMPT-05 §8/§9.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { shuffle } from "../../core/rng.ts";
import type { LineupPair, StageCtx, StandingsDelta } from "../../core/types.ts";
import { evalPadGate, type PadField, type PadSpec } from "../../sport/module.ts";
import { buildWalk, conformanceSuite, makeEnvelope } from "../../testkit/index.ts";
// S6/#416 (W5) — deliberately NOT from the testkit barrel: conformance-pad.ts
// touches node:fs (DOMAIN.md presence), mirroring golden.ts's own exclusion.
import { checkActionCoverage, padItemLabelKey, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import {
  cricket,
  padSpec,
  CRICKET_EVENT_SCHEMAS,
  nextBattingSide,
  eligibleBowlers,
  reviewsRemaining,
  activeInnings,
  soBattingSideAt,
  type CricketBallEv,
  type CricketCfg,
  type CricketEv,
  type CricketState,
} from "./cricket.ts";
import { dlsTarget, resources, resourcesFromBalls } from "./dls.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

// Eleven per side; batting order = orderNo (spec §2.7).
function lineup(prefix: string): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${prefix}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const league: StageCtx = { kind: "league" };

const t20: CricketCfg = cricket.configSchema.parse(
  cricket.variants.t20,
);
const fold = (cfg: CricketCfg, events: EventEnvelope[]) =>
  foldMatch(cricket, cfg, lineups, events, STRICT_ALL);

// `voids` (3rd tuple slot) mirrors core/events.test.ts's own stream() — a
// core.void's target travels in EventEnvelope.voids, not the payload
// (CoreVoid = z.strictObject({})); resolveVoids reads it by that field.
function stream(
  ...specs: Array<[type: string, payload?: unknown, voids?: string]>
): EventEnvelope[] {
  return specs.map(([type, payload, voids], i) =>
    makeEnvelope(i, { type, payload: payload ?? {} }, voids),
  );
}

// Compact ball notation for hand-written goldens.
interface BallSpec {
  striker: string;
  nonStriker: string;
  bowler: string;
  bat?: number;
  extras?: { kind: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number };
  wicket?: CricketBallEv["wicket"];
  boundary?: 4 | 6;
  freeHit?: boolean;
}

// Expands specs into cricket.ball payloads, deriving over/ballInOver the way
// the fold expects them (wides/no-balls repeat the ball number).
function balls(type: string, specs: BallSpec[], bpo = 6): Array<[string, CricketBallEv]> {
  let legal = 0;
  return specs.map((spec) => {
    const payload: CricketBallEv = {
      over: Math.floor(legal / bpo),
      ballInOver: (legal % bpo) + 1,
      striker: spec.striker,
      nonStriker: spec.nonStriker,
      bowler: spec.bowler,
      runs: { bat: spec.bat ?? 0, ...(spec.extras ? { extras: spec.extras } : {}) },
      ...(spec.wicket ? { wicket: spec.wicket } : {}),
      ...(spec.boundary ? { boundary: spec.boundary } : {}),
      ...(spec.freeHit ? { freeHit: true } : {}),
    };
    const isIllegal = spec.extras?.kind === "wide" || spec.extras?.kind === "noball";
    if (!isIllegal) legal++;
    return [type, payload];
  });
}

// ---------------------------------------------------------------------------
// Fine-fidelity golden — hand-scored 2-over-a-side match exercising the ball
// grammar: extras, free hit, wickets, striker rotation, bowler figures.
// ---------------------------------------------------------------------------

describe("cricket golden: ball-by-ball mini match (fine fidelity)", () => {
  const mini = cricket.configSchema.parse({
    ballsPerInnings: 12,
    maxOversPerBowler: 1,
    minOversForResult: 2,
  });
  const inningsOne = balls("cricket.ball", [
    { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, boundary: 4 },
    { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 },
    { striker: "H-2", nonStriker: "H-1", bowler: "A-11", extras: { kind: "wide", runs: 1 } },
    { striker: "H-2", nonStriker: "H-1", bowler: "A-11", bat: 6, boundary: 6 },
    {
      striker: "H-2",
      nonStriker: "H-1",
      bowler: "A-11",
      wicket: { kind: "bowled", out: "H-2", bowlerCredited: true },
    },
    { striker: "H-3", nonStriker: "H-1", bowler: "A-11", bat: 2 },
    { striker: "H-3", nonStriker: "H-1", bowler: "A-11", bat: 1 }, // over end
    { striker: "H-3", nonStriker: "H-1", bowler: "A-10", bat: 2, extras: { kind: "noball", runs: 1 } },
    {
      striker: "H-3",
      nonStriker: "H-1",
      bowler: "A-10",
      bat: 1,
      wicket: { kind: "runout", out: "H-1", bowlerCredited: false },
      freeHit: true,
    },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 1 }, // odd → H-4 on strike
    { striker: "H-4", nonStriker: "H-3", bowler: "A-10", bat: 0 }, // balls exhausted → 22/2
  ]);
  const inningsTwo = balls("cricket.ball", [
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 6, boundary: 6 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 4, boundary: 4 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
    { striker: "A-2", nonStriker: "A-1", bowler: "H-11", extras: { kind: "legbye", runs: 2 } },
    { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 0 }, // over end
    { striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 2 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 4, boundary: 4 },
    {
      striker: "A-1",
      nonStriker: "A-2",
      bowler: "H-10",
      wicket: { kind: "caught", out: "A-1", bowlerCredited: true },
    },
    { striker: "A-3", nonStriker: "A-2", bowler: "H-10", bat: 1 },
    { striker: "A-2", nonStriker: "A-3", bowler: "H-10", bat: 0 },
    { striker: "A-2", nonStriker: "A-3", bowler: "H-10", bat: 0 }, // 20/1 — H wins by 2
  ]);
  const events = stream(["core.start"], ...inningsOne, ...inningsTwo);

  it("folds totals, rotation and figures to the hand-scored card", () => {
    const state = fold(mini, events);
    expect(state.innings[0]).toMatchObject({ runs: 22, wickets: 2, legalBalls: 12, boundaries: 2 });
    expect(state.innings[1]).toMatchObject({ runs: 20, wickets: 1, legalBalls: 12, boundaries: 3 });
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "regulation" });
    expect(state.margin).toBe("by 2 runs");
    const fine = state.innings[0]!.fine!;
    expect(fine.batterRuns).toMatchObject({ "H-1": 5, "H-2": 6, "H-3": 9, "H-4": 0 });
    expect(fine.batterBalls).toMatchObject({ "H-1": 2, "H-2": 2, "H-3": 8, "H-4": 1 });
    expect(fine.bowlerBalls).toMatchObject({ "A-11": 6, "A-10": 6 });
    expect(fine.bowlerRuns).toMatchObject({ "A-11": 15, "A-10": 7 });
    expect(fine.bowlerWickets).toMatchObject({ "A-11": 1 });
    expect(fine.extras).toBe(2);
  });

  it("summary reads only InningsTotals (spec §2.2)", () => {
    const state = fold(mini, events);
    expect(cricket.summary(state).headline).toBe("22/2 (2) — 20/1 (2)");
  });

  it("§2.2 dual fidelity: coarsen(ballEvents) folds to the identical match", () => {
    const coarse = cricket
      .coarsen!(events as EventEnvelope<CricketEv | CoreEv>[])
      .map((event, i) => makeEnvelope(i, event));
    const fineState = fold(mini, events);
    const coarseState = fold(mini, coarse);
    expect(cricket.outcome(coarseState)).toEqual(cricket.outcome(fineState));
    expect(cricket.summary(coarseState)).toEqual(cricket.summary(fineState));
  });

  it("enforces ball legality: counters, consecutive overs, quotas, wides", () => {
    const start = stream(["core.start"]);
    const bad = (payload: Partial<CricketBallEv>) =>
      fold(mini, [
        ...start,
        makeEnvelope(1, {
          type: "cricket.ball",
          payload: {
            over: 0,
            ballInOver: 1,
            striker: "H-1",
            nonStriker: "H-2",
            bowler: "A-11",
            runs: { bat: 0 },
            ...payload,
          },
        }),
      ]);
    expect(() => bad({ ballInOver: 2 })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() => bad({ striker: "H-3" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() =>
      bad({ runs: { bat: 1, extras: { kind: "wide", runs: 1 } } }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    expect(() => bad({ freeHit: true })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );

    // Consecutive overs: A-11 bowled over 0, may not bowl over 1.
    const overByEleven = balls("cricket.ball", [
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
    ]);
    const consecutive = [
      ...stream(["core.start"], ...overByEleven),
      makeEnvelope(7, {
        type: "cricket.ball",
        payload: {
          over: 1,
          ballInOver: 1,
          striker: "H-2",
          nonStriker: "H-1",
          bowler: "A-11",
          runs: { bat: 0 },
        },
      }),
    ];
    expect(() => fold(mini, consecutive)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // …and the free-hit dismissal restriction (only the run-out family).
    const freeHitWicket = [
      ...stream(
        ["core.start"],
        ...balls("cricket.ball", [
          { striker: "H-1", nonStriker: "H-2", bowler: "A-11", extras: { kind: "noball", runs: 1 } },
        ]),
      ),
      makeEnvelope(2, {
        type: "cricket.ball",
        payload: {
          over: 0,
          ballInOver: 1,
          striker: "H-1",
          nonStriker: "H-2",
          bowler: "A-11",
          runs: { bat: 0 },
          wicket: { kind: "bowled", out: "H-1", bowlerCredited: true },
          freeHit: true,
        },
      }),
    ];
    expect(() => fold(mini, freeHitWicket)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  // doc 14 §1 Tier 2 — player lines validate against the fine-derived card.
  it("accepts matching player lines and rejects mismatches with a diff", () => {
    const withLine = (payload: unknown) =>
      fold(mini, [...events, makeEnvelope(events.length, { type: "cricket.player.line", payload })]);
    const ok = withLine({
      innings: 1,
      person: "H-3",
      batting: { runs: 9, balls: 8 },
    });
    expect(ok.playerLines).toHaveLength(1);
    expect(
      withLine({ innings: 1, person: "A-11", bowling: { legalBalls: 6, runs: 15, wickets: 1 } })
        .playerLines,
    ).toHaveLength(1);
    try {
      withLine({ innings: 1, person: "H-3", batting: { runs: 10, balls: 8 } });
      expect.unreachable("mismatched card must be rejected");
    } catch (err) {
      expect(err).toMatchObject({
        code: "INVALID_EVENT",
        data: { field: "batting.runs", expected: 9, got: 10 },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (a)+(d) — real scorecard: 2019 Cricket World Cup final,
// Lord's (NZ 241/8; England 241 all out; Super Over 15–15; England won on
// boundary count 26–17). Sources: ESPNcricinfo match 1144530 scorecard;
// Wikipedia "2019 Cricket World Cup final". Innings entered at Tier-1
// summary fidelity; the Super Over ball-by-ball as published. Player ids:
// A-* = England (A-4 Stokes, A-6 Buttler, A-10 Archer), H-* = New Zealand
// (H-6 Neesham, H-1 Guptill, H-11 Boult).
// ---------------------------------------------------------------------------

describe("cricket golden (a): 2019 CWC final — tie, super over, boundary count", () => {
  const odiKO = cricket.configSchema.parse({
    ballsPerInnings: 300,
    maxOversPerBowler: 10,
    minOversForResult: 20,
    superOver: true,
    superOverStillTied: "boundary_count",
  });
  // England (A) batted second in the match, so bats first in the super over.
  const englandSO = balls("cricket.superover.ball", [
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 3 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 1 },
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 4, boundary: 4 },
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 1 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 2 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 4, boundary: 4 },
  ]);
  const newZealandSO = balls("cricket.superover.ball", [
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", extras: { kind: "wide", runs: 1 } },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 6, boundary: 6 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 1 },
    {
      striker: "H-1",
      nonStriker: "H-6",
      bowler: "A-10",
      bat: 1,
      wicket: { kind: "runout", out: "H-1", bowlerCredited: false },
    },
  ]);
  const events = stream(
    ["cricket.toss", { wonBy: "H", elected: "bat" }],
    ["core.start"],
    ["cricket.innings.summary", { runs: 241, wickets: 8, legalBalls: 300, boundaries: 16 }],
    ["cricket.innings.summary", { runs: 241, wickets: 10, legalBalls: 300, boundaries: 24 }],
    ...englandSO,
    ...newZealandSO,
  );

  it("replays the published result: England win on boundary count", () => {
    const state = fold(odiKO, events);
    expect(state.outcome).toEqual({
      kind: "win",
      winner: "A",
      loser: "H",
      method: "boundary_count",
    });
    expect(state.margin).toBe("on boundary count");
    const so = state.superOver!;
    expect(so.innings.map((i) => ({ side: i.battingSide, runs: i.runs }))).toEqual([
      { side: "away", runs: 15 },
      { side: "home", runs: 15 },
    ]);
  });

  it("keeps the super over out of the NRR ledger (ICC convention)", () => {
    const state = fold(odiKO, events);
    const [home, away] = cricket.standingsDelta(state.outcome!, odiKO, league, state);
    // England all out ⇒ charged the full quota (equal to actual here).
    expect(away.metrics).toMatchObject({
      runs_for: 241,
      balls_faced_eff: 300,
      runs_against: 241,
      balls_bowled_eff: 300,
    });
    expect([home.points, away.points]).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (b) — all-out NRR rule (ESPNcricinfo/CricHeroes methodology:
// a side bowled out is charged its full quota of overs, not balls faced).
// ---------------------------------------------------------------------------

describe("cricket golden (b): all-out NRR ledger", () => {
  const events = stream(
    ["core.start"],
    ["cricket.innings.summary", { runs: 180, wickets: 4, legalBalls: 120 }],
    ["cricket.innings.summary", { runs: 150, wickets: 10, legalBalls: 100 }],
  );

  it("charges the bowled-out side its full 20-over quota", () => {
    const state = fold(t20, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H" });
    expect(state.margin).toBe("by 30 runs");
    const [home, away] = cricket.standingsDelta(state.outcome!, t20, league, state);
    expect(home.metrics).toMatchObject({
      runs_for: 180,
      balls_faced_eff: 120,
      runs_against: 150,
      balls_bowled_eff: 120, // ← not 100: all-out full-quota rule (spec §2.4)
    });
    expect(away.metrics).toMatchObject({ runs_for: 150, balls_faced_eff: 120 });
    // NRR computed from the integer ledger at rank time: 180/20 − 150/20.
    const nrr =
      home.metrics.runs_for! / (home.metrics.balls_faced_eff! / 6) -
      home.metrics.runs_against! / (home.metrics.balls_bowled_eff! / 6);
    expect(nrr).toBeCloseTo(1.5, 10);
  });

  // PROMPT-05 acceptance — permuting fixture order never changes the ledger.
  it("accumulated ledger is permutation-invariant", () => {
    const fixtures = [
      [180, 4, 120, 150, 10, 100],
      [200, 6, 120, 201, 3, 110],
      [90, 10, 80, 91, 2, 60],
    ].map(([r1, w1, b1, r2, w2, b2]) =>
      fold(
        t20,
        stream(
          ["core.start"],
          ["cricket.innings.summary", { runs: r1, wickets: w1, legalBalls: b1 }],
          ["cricket.innings.summary", { runs: r2, wickets: w2, legalBalls: b2 }],
        ),
      ),
    );
    const deltas = fixtures.map(
      (state) => cricket.standingsDelta(state.outcome!, t20, league, state)[0],
    );
    const total = (list: StandingsDelta[]) =>
      list.reduce(
        (acc, delta) => {
          for (const [key, value] of Object.entries(delta.metrics)) {
            acc[key] = (acc[key] ?? 0) + value;
          }
          return acc;
        },
        {} as Record<string, number>,
      );
    const reference = total(deltas);
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        expect(total(shuffle(seed, deltas))).toEqual(reference);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (c) — DLS Standard Edition vs the published 2002 D/L table
// (© Duckworth/Lewis, ICC-hosted; engine/11-sources.md). Exact on table values.
// ---------------------------------------------------------------------------

describe("cricket golden (c): DLS Standard Edition", () => {
  const odiDls = cricket.configSchema.parse({
    ballsPerInnings: 300,
    maxOversPerBowler: 10,
    minOversForResult: 20,
    dls: { enabled: true, edition: "standard" },
  });

  it("reads the published resource table exactly", () => {
    expect(resources(50, 0)).toBe(100.0);
    expect(resources(40, 0)).toBe(89.3);
    expect(resources(25, 0)).toBe(66.5);
    expect(resources(20, 2)).toBe(52.4);
    expect(resources(10, 2)).toBe(30.8);
    expect(resources(18, 3)).toBe(45.9);
    expect(resources(4, 4)).toBe(13.2);
    expect(resources(0, 0)).toBe(0);
  });

  it("computes the reduced-target case (R2 < R1)", () => {
    // Team 1: 250 in the full 50; rain cuts the chase to 25 overs.
    // R1 = 100, R2 = 66.5 ⇒ target = ⌊250 × 0.665⌋ + 1 = 167.
    expect(dlsTarget(250, 100, 66.5)).toBe(167);
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.revise", { oversPerSide: 25 }],
      ["cricket.innings.summary", { runs: 167, wickets: 3, legalBalls: 140 }],
    );
    const state = fold(odiDls, events);
    expect(state.revisedTarget).toBe(167);
    expect(state.targetSource).toBe("dls");
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "dls" });
    expect(state.margin).toBe("by 7 wickets");
  });

  it("computes the increased-target case (R2 > R1) with G50", () => {
    // Team 1 interrupted at 120/2 after 30 of 50 overs, restarted at 40:
    // R1 = 100 − (res(20,2) − res(10,2)) = 100 − (52.4 − 30.8) = 78.4.
    // Team 2 gets 40 overs: R2 = 89.3 ⇒ target = ⌊190 + 245×10.9/100⌋ + 1 = 217.
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
      ["cricket.interruption", { kind: "rain" }],
      ["cricket.revise", { oversPerSide: 40 }],
      ["cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }],
      ["cricket.innings.summary", { runs: 0, wickets: 0, legalBalls: 0, partial: true }],
    );
    const state = fold(odiDls, events);
    expect(state.r1).toBeCloseTo(78.4, 9);
    expect(state.r2).toBeCloseTo(89.3, 9);
    expect(state.revisedTarget).toBe(217);
  });

  it("decides an abandoned chase by the DLS par score (method 'dls')", () => {
    // Continuing the R2>R1 scenario: chase 150/3 after 22 of 40 overs, rain
    // ends play. Par = ⌊216 × (89.3 − res(18,3))/89.3⌋ = 104 ⇒ win by 46.
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
      ["cricket.revise", { oversPerSide: 40 }],
      ["cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }],
      ["cricket.innings.summary", { runs: 150, wickets: 3, legalBalls: 132, partial: true }],
      ["core.abandon", { reason: "rain" }],
    );
    const state = fold(odiDls, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "dls" });
    expect(state.margin).toBe("by 46 runs");
  });

  it("no_result below the minimum overs; manual umpire target always wins", () => {
    const washout = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 60, partial: true }],
      ["core.abandon", { reason: "rain" }],
    );
    expect(fold(odiDls, washout).outcome).toEqual({ kind: "no_result" });

    const manual = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.revise", { oversPerSide: 25, target: 200 }],
      ["cricket.revise", { oversPerSide: 20 }], // later DLS revise must not override
    );
    const state = fold(odiDls, manual);
    expect(state.revisedTarget).toBe(200);
    expect(state.targetSource).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// #451 — the published D/L table is FIXED at six-ball overs and ten wickets,
// but every fold call site fed it cfg-scaled quantities. `resourcesFromBalls`
// is now the single conversion entry point; these pin both axes.
// ---------------------------------------------------------------------------

describe("DLS scales: table units vs config units (#451)", () => {
  it("is the identity for a ten-wicket innings — no standard value moves", () => {
    // The wickets scale is 10/10 = 1 exactly, so every 11-a-side figure must
    // stay bit-identical to the pre-#451 `resources(balls / 6, wickets)`.
    for (const balls of [0, 1, 5, 6, 7, 30, 60, 119, 120, 150, 251, 300, 301]) {
      for (let w = 0; w <= 10; w++) {
        expect(resourcesFromBalls(balls, w, 10)).toBe(resources(balls / 6, w));
      }
    }
    // Spot-check against the published rows the old call sites happened to hit.
    expect(resourcesFromBalls(300, 0, 10)).toBe(100.0);
    expect(resourcesFromBalls(120, 0, 10)).toBe(56.6);
    expect(resourcesFromBalls(30, 0, 10)).toBe(17.2);
  });

  it("converts the overs axis by SIX, not by cfg.ballsPerOver (the Hundred)", () => {
    // 100 balls is 16.667 six-ball overs, NOT the 20 five-ball overs the config
    // counts. Row 16 col 0 = 47.6, row 17 col 0 = 49.9, fraction 2/3 ⇒
    // 47.6 + (2/3) × 2.3 = 49.1333…  The old code read row 20 col 0 = 56.6.
    expect(resourcesFromBalls(100, 0, 10)).toBeCloseTo(47.6 + (2 / 3) * 2.3, 9);
    expect(resourcesFromBalls(100, 0, 10)).toBeCloseTo(49.13333333333333, 9);
    expect(resourcesFromBalls(100, 0, 10)).not.toBeCloseTo(56.6, 6);
  });

  it("converts the wickets axis by the innings' all-out count (six-a-side)", () => {
    // A six-a-side innings ends at 5 wickets, so 4 down is 8/10 of the batting
    // gone, not 4/10. Row 5: col 4 = 16.1 (what the old code read), col 8 = 9.4.
    expect(resourcesFromBalls(30, 4, 5)).toBe(resources(5, 8));
    expect(resourcesFromBalls(30, 4, 5)).toBe(9.4);
    expect(resourcesFromBalls(30, 4, 5)).not.toBe(16.1);
    // Every wicket in a five-wicket innings maps to an even column.
    expect(resourcesFromBalls(30, 1, 5)).toBe(resources(5, 2));
    expect(resourcesFromBalls(30, 2, 5)).toBe(resources(5, 4));
    expect(resourcesFromBalls(30, 3, 5)).toBe(resources(5, 6));
  });

  it("clamps an all-out side to the last column", () => {
    // 5 of 5 scales to 10, beyond the table's 0..9 — clamp, never index out.
    expect(resourcesFromBalls(30, 5, 5)).toBe(resources(5, 9));
    expect(resourcesFromBalls(30, 5, 5)).toBe(4.6);
    expect(resourcesFromBalls(300, 10, 10)).toBe(resources(50, 9));
  });

  it("rounds a scale that does not divide 10, rather than flooring it", () => {
    // Every variant shipped today has an exact scale — 11-a-side is 10/10 = 1,
    // six-a-side is 10/5 = 2 — so rounding and truncation agree and nothing
    // recorded moves. An eight-a-side innings (all out at 7) does NOT: the
    // scale is 10/7, and truncating would read 2 wickets down as column 2
    // (2.857 → 2) instead of column 3, crediting the batting side MORE
    // resources than it still has. Same "wrong side of the rounding" family as
    // the bug this file exists for, one variant away.
    expect(resourcesFromBalls(30, 2, 7)).toBe(resources(5, 3));
    expect(resourcesFromBalls(30, 2, 7)).not.toBe(resources(5, 2));
    expect(resourcesFromBalls(30, 1, 7)).toBe(resources(5, 1)); // 1.43 → 1
    expect(resourcesFromBalls(30, 5, 7)).toBe(resources(5, 7)); // 7.14 → 7

    // Rounding never credits MORE resource than the true proportion would, in
    // either direction: the scaled column is within half a column of exact.
    for (const allOut of [3, 4, 6, 7, 8, 9]) {
      for (let w = 0; w <= allOut; w++) {
        const exact = Math.min((w * 10) / allOut, 9);
        const used = resourcesFromBalls(30, w, allOut);
        expect(used).toBeLessThanOrEqual(resources(5, Math.floor(exact)));
        expect(used).toBeGreaterThanOrEqual(resources(5, Math.min(Math.ceil(exact), 9)));
      }
    }
  });

  it("keeps every currently shipped scale byte-identical under rounding", () => {
    // The guard that lets the change above ship with no golden churn: for
    // allOut 10 and 5, round(w × scale) === trunc(w × scale) for every w.
    for (const allOut of [10, 5]) {
      for (let w = 0; w <= allOut; w++) {
        const scaled = (w * 10) / allOut;
        expect(Math.round(scaled)).toBe(Math.trunc(scaled));
      }
    }
  });

  it("survives a non-positive all-out count without producing NaN", () => {
    // Unreachable from the fold (`allOutWickets()` is Math.max(1, …)) but a bare
    // divide gives Infinity, and 0 × Infinity is NaN — which would index the
    // table out of bounds and silently poison r1/r2 on every read.
    for (const allOut of [0, -1, -10]) {
      for (const w of [0, 3, 9]) {
        const value = resourcesFromBalls(30, w, allOut);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBe(resources(5, w)); // falls back to the unscaled column
      }
    }
  });
});

// ---------------------------------------------------------------------------
// #431 ruling 3 (2026-08-11) — the declared `pairs-6-a-side` variant only ever
// shrank the side and the innings length; the real pairs convention is a
// different scoring grammar, not an extension of this one, so the preset was
// dropped rather than left half-built. Full reasoning:
// docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md, the
// 2026-08-11 decision log entry.
//
// Drift guard: pins the exact surviving key set, not just the one removed
// key, so ANY future addition or removal of a cricket variant has to touch
// this test deliberately instead of drifting in silently.
// ---------------------------------------------------------------------------

describe("#431 ruling 3: pairs-6-a-side dropped", () => {
  it("is no longer a declared cricket variant", () => {
    expect(cricket.variants).not.toHaveProperty("pairs-6-a-side");
    expect(Object.keys(cricket.variants).sort()).toEqual(["hundred", "odi", "t20", "test"]);
  });
});

// ---------------------------------------------------------------------------
// #451 regression — the issue's two worked examples, end to end through the
// fold. Both are RED without the source fix.
// ---------------------------------------------------------------------------

describe("#451 regression: cfg-scaled DLS inputs", () => {
  const hundredDls = cricket.configSchema.parse({
    ...cricket.variants.hundred,
    dls: { enabled: true, edition: "standard" },
  });
  // #431 ruling 3 dropped the `pairs-6-a-side` preset (see above), so the
  // six-a-side config this regression needs is inlined directly instead of
  // spread from a now-removed preset. Byte-identical to the old
  // `{...cricket.variants["pairs-6-a-side"], dls: {...}}` spread.
  const pairsDls = cricket.configSchema.parse({
    playersPerSide: 6,
    ballsPerInnings: 60,
    maxOversPerBowler: 2,
    dls: { enabled: true, edition: "standard" },
  });

  it("the Hundred's r1 is 16.667 six-ball overs of resource, not 20", () => {
    const state = fold(
      hundredDls,
      stream(
        ["core.start"],
        ["cricket.innings.summary", { runs: 80, wickets: 5, legalBalls: 100 }],
      ),
    );
    expect(state.r1).toBeCloseTo(49.13333333333333, 9);
    expect(state.r1).not.toBeCloseTo(56.6, 6);
  });

  it("a six-a-side abandoned chase is decided the RIGHT way round", () => {
    // 60 balls a side ⇒ R1 = R2 = res(10, 0) = 32.1. Team H makes 80. Team A is
    // 45/4 after 30 balls (5 overs, at the 5-over minimum) when rain ends play.
    //   4 of 5 wickets down = column 8 ⇒ remaining res(5,8) = 9.4,
    //   used = 32.1 − 9.4 = 22.7, par = ⌊80 × 22.7/32.1⌋ = 56 ⇒ H by 11.
    // The old code read column 4 ⇒ remaining 16.1, used 16.0,
    //   par = ⌊80 × 16/32.1⌋ = 39 ⇒ A by 6 — a full result REVERSAL.
    const state = fold(
      pairsDls,
      stream(
        ["core.start"],
        ["cricket.innings.summary", { runs: 80, wickets: 5, legalBalls: 60 }],
        ["cricket.innings.summary", { runs: 45, wickets: 4, legalBalls: 30, partial: true }],
        ["core.abandon", { reason: "rain" }],
      ),
    );
    expect(state.r1).toBeCloseTo(32.1, 9);
    expect(state.r2).toBeCloseTo(32.1, 9);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "dls" });
    expect(state.margin).toBe("by 11 runs");
  });
});

// ---------------------------------------------------------------------------
// W4a follow-up §3.3 — `applyRevise` compares the revised quota against the
// balls ALREADY BOWLED, and both sides of that comparison move with cfg
// (`oversPerSide × cfg.ballsPerOver`). A league that re-cuts its over length
// would otherwise refuse a revise the ledger already holds, on every read,
// with no event to void. The entry rule stays exactly as strict.
// ---------------------------------------------------------------------------

describe("a recorded revise survives a shortened over (§3.3)", () => {
  const raw = { ballsPerInnings: 300, maxOversPerBowler: 10, minOversForResult: 20 };
  const events = stream(
    ["core.start"],
    ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
    ["cricket.revise", { oversPerSide: 40 }],
  );

  it("re-reads the ledger after ballsPerOver drops to 4", () => {
    // WRITE path: 40 × 6 = 240 balls, comfortably above the 180 bowled.
    const cfg = cricket.configSchema.parse(raw);
    expect(fold(cfg, events)).toBeDefined();

    // READ path under the edit: the same 40 overs are now 160 balls, below the
    // 180 already in the ledger — the innings is recorded in balls and does not
    // move with the config, so only the quota does.
    const shortened = cricket.configSchema.parse({ ...raw, ballsPerOver: 4 });
    const state = foldMatch(cricket, shortened, lineups, events);
    expect(state.quota).toBe(160);
    expect(state.innings[0]?.legalBalls).toBe(180);
  });

  it("still refuses a revise below the balls bowled on the WRITE path", () => {
    const cfg = cricket.configSchema.parse(raw);
    expect(() =>
      fold(
        cfg,
        stream(
          ["core.start"],
          ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
          ["cricket.revise", { oversPerSide: 20 }],
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});

// ---------------------------------------------------------------------------
// R2b (v3 pad, over-by-over tile) — the tile's gate rests entirely on the
// per-innings fidelity lock (createInnings/applyDelivery/applySummary above)
// and on undo recovering it by REPLAY, not by "resetting to coarse". This had
// ZERO coverage before this addition; test-only, per the wave's brief — no
// packages/engine/src line changes, only this file.
// ---------------------------------------------------------------------------

describe("cricket: per-innings fidelity lock is bidirectional, and undo recovers it by replay", () => {
  // Batting side for innings 0 is "home" (battingFirst defaults "home" with
  // no toss event, cricket.ts:2879); H-1/H-2 open, A-1 is a legal bowler.
  const oneBall = [{ striker: "H-1", nonStriker: "H-2", bowler: "A-1", bat: 4 }];

  it("refuses a partial summary on a ball-scored (fine) innings", () => {
    const events = stream(
      ["core.start"],
      ...balls("cricket.ball", oneBall),
      ["cricket.innings.summary", { runs: 4, wickets: 0, legalBalls: 1, partial: true }],
    );
    expect(() => fold(t20, events)).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        message: expect.stringMatching(/recorded ball-by-ball — summaries are not allowed for it/),
      }),
    );
  });

  // The mirror of the refusal above. No existing test in this file covers a
  // ball on a coarse innings (checked: zero hits for "summary fidelity" or
  // "ball events are not allowed" outside this block) — new coverage, not a
  // duplicate.
  it("refuses a ball on a summary-fidelity (coarse) innings", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 10, wickets: 0, legalBalls: 6, partial: true }],
      ...balls("cricket.ball", oneBall),
    );
    expect(() => fold(t20, events)).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        message: expect.stringMatching(/recorded at summary fidelity — ball events are not allowed/),
      }),
    );
  });

  it("undo of an innings' only ball reopens BOTH fidelities — fold replays from init, it does not reset to coarse", () => {
    const voidOnly = fold(
      t20,
      stream(["core.start"], ...balls("cricket.ball", oneBall), ["core.void", {}, "e-1"]),
    );
    // createInnings("fine") ran once, folding e-1. resolveVoids drops e-1 (and
    // the core.void itself) from the active stream before apply() ever sees
    // it, and foldMatch replays the survivors from module.init — so the
    // innings was never opened at all, not "reset to coarse": state.innings
    // stays the [] init() started with (cricket.ts:2881).
    expect(voidOnly.innings).toHaveLength(0);

    const afterSummary = fold(
      t20,
      stream(
        ["core.start"],
        ...balls("cricket.ball", oneBall),
        ["core.void", {}, "e-1"],
        ["cricket.innings.summary", { runs: 4, wickets: 0, legalBalls: 1, partial: true }],
      ),
    );
    expect(afterSummary.innings).toHaveLength(1);
    expect(afterSummary.innings[0]).toMatchObject({ runs: 4, wickets: 0, legalBalls: 1, fine: null });
  });

  it("a sequence of partial summaries folds to the totals a scorer expects, without tripping the monotone guard", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 12, wickets: 0, legalBalls: 6, partial: true }],
      ["cricket.innings.summary", { runs: 24, wickets: 1, legalBalls: 12, partial: true }],
      ["cricket.innings.summary", { runs: 31, wickets: 2, legalBalls: 18, partial: true }],
    );
    const state = fold(t20, events);
    expect(state.innings).toHaveLength(1);
    expect(state.innings[0]).toMatchObject({
      runs: 31,
      wickets: 2,
      legalBalls: 18,
      fine: null,
      closed: false,
    });
  });

  // Negative case for the monotone guard above (cricket.ts:1416-1426) — a
  // grep of this file shows zero refusal coverage for it anywhere, so
  // dropping the guard entirely would leave every existing test green.
  // Matches the fold's own message, not a bare "it threw": a mutant that
  // throws for some OTHER reason (e.g. the strict all-out/ballsLimit checks
  // just below it) would still pass a bare-throw assertion.
  it("refuses a partial summary whose totals go backwards from the previous partial", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 24, wickets: 1, legalBalls: 12, partial: true }],
      ["cricket.innings.summary", { runs: 20, wickets: 1, legalBalls: 12, partial: true }],
    );
    expect(() => fold(t20, events)).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        message: expect.stringMatching(/summary totals may not decrease/),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (d) — tied T20 → super over → still-tied policies.
// ---------------------------------------------------------------------------

describe("cricket golden (d): tied T20 super over policies", () => {
  const tiedMain = (policy: "repeat" | "boundary_count" | "shared") =>
    ({
      cfg: cricket.configSchema.parse({ superOver: true, superOverStillTied: policy }),
      events: stream(
        ["core.start"],
        ["cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120, boundaries: 10 }],
        ["cricket.innings.summary", { runs: 150, wickets: 7, legalBalls: 120, boundaries: 12 }],
      ),
    }) as const;

  // Away batted second ⇒ bats first in the super over (ICC).
  it("boundary_count: more boundaries across match + super over wins", () => {
    const { cfg, events } = tiedMain("boundary_count");
    // Both super-over innings score 10 — still tied ⇒ boundaries 13 v 10.
    const awaySO = balls("cricket.superover.ball", [
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 4, boundary: 4 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
      { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 1 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
      { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 1 },
    ]);
    const homeSO = balls("cricket.superover.ball", [
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 },
      { striker: "H-2", nonStriker: "H-1", bowler: "A-11", bat: 1 },
    ]);
    const state = fold(cfg, [...events, ...streamFrom(events.length, [...awaySO, ...homeSO])]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "boundary_count" });
  });

  it("repeat: a second super over decides (batting order flips)", () => {
    const { cfg, events } = tiedMain("repeat");
    const so1 = [
      ...balls("cricket.superover.ball", [
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 }, // 12
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 }, // 12 — tied again
      ]),
    ];
    // Second super over: home bats first now; away chases 7 and wins.
    const so2 = [
      ...balls("cricket.superover.ball", [
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 }, // 6
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "A-3", nonStriker: "A-4", bowler: "H-10", bat: 6, boundary: 6 },
        { striker: "A-3", nonStriker: "A-4", bowler: "H-10", bat: 1 }, // 7 ≥ 7 → away wins
      ]),
    ];
    const state = fold(cfg, [...events, ...streamFrom(events.length, [...so1, ...so2])]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "super_over" });
    expect(state.superOver!.innings).toHaveLength(4);
  });

  it("shared: the tie stands and pays tie points", () => {
    const { cfg, events } = tiedMain("shared");
    const so = [
      ...balls("cricket.superover.ball", [
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
      ]),
    ];
    const state = fold(cfg, [...events, ...streamFrom(events.length, so)]);
    expect(state.outcome).toEqual({ kind: "tie" });
    const [home, away] = cricket.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home.metrics.ties).toBe(1);
  });

  it("league tie without a super over stands as a tie (≠ no_result)", () => {
    const { events } = tiedMain("repeat");
    const state = fold(t20, events); // superOver: false
    expect(state.outcome).toEqual({ kind: "tie" });
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (e) — two-innings (test) rules: draw, innings victory,
// follow-on enforcement, 4th-innings chase.
// ---------------------------------------------------------------------------

describe("cricket golden (e): two-innings matches", () => {
  const test = cricket.configSchema.parse(cricket.variants.test);

  it("draws on time expiry with draw points", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 400, wickets: 6, legalBalls: 540, declared: true }],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 480 }],
      ["cricket.innings.summary", { runs: 200, wickets: 2, legalBalls: 180, declared: true }],
      ["cricket.match.close"],
    );
    const state = fold(test, events);
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(cricket.supportsDraws(test, "league")).toBe(true);
    expect(cricket.supportsDraws(t20, "league")).toBe(false);
    const [home, away] = cricket.standingsDelta(state.outcome!, test, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect([home.drawn, away.drawn]).toEqual([1, 1]);
  });

  it("enforces the follow-on and scores an innings victory", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 500, wickets: 3, legalBalls: 540, declared: true }],
      ["cricket.innings.summary", { runs: 200, wickets: 10, legalBalls: 300 }],
      ["cricket.followon"],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 350 }],
    );
    const state = fold(test, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "innings" });
    expect(state.margin).toBe("by an innings and 50 runs");
  });

  it("rejects a follow-on below the configured lead", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 300, wickets: 10, legalBalls: 400 }],
      ["cricket.innings.summary", { runs: 200, wickets: 10, legalBalls: 350 }],
      ["cricket.followon"],
    );
    expect(() => fold(test, events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("resolves a fourth-innings chase by wickets", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 300, wickets: 10, legalBalls: 400 }],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 380 }],
      ["cricket.innings.summary", { runs: 150, wickets: 10, legalBalls: 200 }],
      ["cricket.innings.summary", { runs: 201, wickets: 5, legalBalls: 240 }],
    );
    const state = fold(test, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "regulation" });
    expect(state.margin).toBe("by 5 wickets");
    expect(cricket.summary(state).perSide).toEqual([
      { entrantId: "H", line: "300 & 150" },
      { entrantId: "A", line: "250 & 201/5" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// nextBattingSide (R2b-next) — public mirror of the private battingSideAt/
// maxInningsCount innings-sequencing rule, exported so apps/web's v3 cricket
// skin can target a next innings that has not been created yet (see this
// function's own doc, cricket.ts) instead of hand-copying the rule. Each
// `it` below covers one cfg SHAPE end to end (every index through the
// boundary), per the task brief's own ask.
// ---------------------------------------------------------------------------

describe("nextBattingSide", () => {
  it("single innings per side: strictly alternates from battingFirst, then null once both sides have batted", () => {
    const base = { battingFirst: "home" as const, followOnEnforced: false, cfg: { inningsPerSide: 1 as const } };
    expect(nextBattingSide({ ...base, inningsCount: 0 })).toBe("home");
    expect(nextBattingSide({ ...base, inningsCount: 1 })).toBe("away");
    expect(nextBattingSide({ ...base, inningsCount: 2 })).toBeNull(); // nothing further due
  });

  it("reads battingFirst, not a hardcoded 'home' — an away-first match alternates the other way", () => {
    const base = { battingFirst: "away" as const, followOnEnforced: false, cfg: { inningsPerSide: 1 as const } };
    expect(nextBattingSide({ ...base, inningsCount: 0 })).toBe("away");
    expect(nextBattingSide({ ...base, inningsCount: 1 })).toBe("home");
  });

  it("two innings per side, no follow-on: strict alternation (index % 2) across all four innings, then null", () => {
    const base = { battingFirst: "home" as const, followOnEnforced: false, cfg: { inningsPerSide: 2 as const } };
    expect(nextBattingSide({ ...base, inningsCount: 0 })).toBe("home");
    expect(nextBattingSide({ ...base, inningsCount: 1 })).toBe("away");
    expect(nextBattingSide({ ...base, inningsCount: 2 })).toBe("home");
    expect(nextBattingSide({ ...base, inningsCount: 3 })).toBe("away");
    expect(nextBattingSide({ ...base, inningsCount: 4 })).toBeNull();
  });

  it("two innings per side, follow-on enforced: F,S,S,F — diverges from plain alternation at innings 3 (a test only covering simple alternation cannot see this)", () => {
    const base = { battingFirst: "home" as const, followOnEnforced: true, cfg: { inningsPerSide: 2 as const } };
    expect(nextBattingSide({ ...base, inningsCount: 0 })).toBe("home");
    expect(nextBattingSide({ ...base, inningsCount: 1 })).toBe("away");
    // Plain alternation (index % 2 === 0) would say "home" here — the
    // follow-on keeps "away" batting again instead (Law: the side asked to
    // follow on bats immediately, skipping the other side's normal turn).
    expect(nextBattingSide({ ...base, inningsCount: 2 })).toBe("away");
    expect(nextBattingSide({ ...base, inningsCount: 3 })).toBe("home");
    expect(nextBattingSide({ ...base, inningsCount: 4 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R3.5 Task C — activeInnings: the ONE definition of "which innings list is
// actually being played", shared by cricketPosition (below) and the v3 pad
// (apps/web skins/cricket.tsx), which used to re-derive it as `state.innings`
// alone and so spent every super over describing the innings before it.
// ---------------------------------------------------------------------------

describe("activeInnings — one definition, shared by the position axis and the pad", () => {
  const main = [{ closed: true }, { closed: true }];
  it("main innings while there is no super over", () => {
    expect(activeInnings({ innings: main, superOver: null }))
      .toEqual({ list: main, offset: 0, inSuperOver: false });
  });
  it("super-over innings once there is one, offset past the main innings", () => {
    const so = [{ closed: false }];
    expect(activeInnings({ innings: main, superOver: { innings: so } }))
      .toEqual({ list: so, offset: 2, inSuperOver: true });
  });
  it("an EMPTY super-over list is still the active list", () => {
    // The state decideTie leaves behind: phase super_over, no ball yet.
    expect(activeInnings({ innings: main, superOver: { innings: [] } }))
      .toEqual({ list: [], offset: 2, inSuperOver: true });
  });
  it("treats an absent superOver field the same as null", () => {
    expect(activeInnings({ innings: main, superOver: undefined }).inSuperOver).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3.5 Task S — soBattingSideAt: the ICC super-over alternation rule, now
// exported (same posture as nextBattingSide/eligibleBowlers/reviewsRemaining/
// activeInnings above) so apps/web's v3 cricket skin can ask "who bats the
// very first super-over ball" instead of hand-copying this formula — the
// live 422 this task fixes. Each `it` below covers one `battingFirst` value
// across indices 0..3 (pair 1's two innings, then pair 2's two), the same
// "one cfg shape end to end, every index through the boundary" convention
// `nextBattingSide`'s own suite (above) uses.
// ---------------------------------------------------------------------------

describe("soBattingSideAt", () => {
  it("battingFirst home: the side batting second in the match (away) opens the super over, then alternates every innings, then flips again for pair 2", () => {
    const state = { battingFirst: "home" as const };
    expect(soBattingSideAt(state, 0)).toBe("away"); // pair 1, innings 1 — opponent of battingFirst
    expect(soBattingSideAt(state, 1)).toBe("home"); // pair 1, innings 2
    expect(soBattingSideAt(state, 2)).toBe("home"); // pair 2, innings 1 — the side batting second in pair 1
    expect(soBattingSideAt(state, 3)).toBe("away"); // pair 2, innings 2
  });

  it("reads battingFirst, not a hardcoded home — an away-first match opens the super over with home instead", () => {
    const state = { battingFirst: "away" as const };
    expect(soBattingSideAt(state, 0)).toBe("home");
    expect(soBattingSideAt(state, 1)).toBe("away");
    expect(soBattingSideAt(state, 2)).toBe("away");
    expect(soBattingSideAt(state, 3)).toBe("home");
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 acceptance — bowler-legality property over generated streams.
// ---------------------------------------------------------------------------

// Segments fine deliveries into innings by the engine's OWN innings ordinal
// (`states[i].innings.length` right after that ball was applied), not by
// re-deriving boundaries from over/ballInOver arithmetic. An over/ball-
// counter heuristic (originally: "new segment when the counter goes backward
// to over 0, ball 1") is ambiguous exactly when an innings closes after its
// very first ball (e.g. a rain-shortened "time" close): the next innings'
// first ball is ALSO over 0/ball 1, an identical key rather than a smaller
// one, so the heuristic silently merged two different innings — with two
// different bowling sides — into one fake segment (seed 1224485596, length
// 20 reproduced this: A-3 bowled the only ball of innings 1, H-4 opened
// innings 2, both read as "the same over"). The innings ordinal has no such
// ambiguity. Shared by the property below and its pinned regression case so
// a reversion of this fix reds both, not just the one an editor happens to
// touch (see reference_parallel_vocab_lookup_paths_drift in project memory).
function segmentBallsByInnings(
  events: EventEnvelope[],
  states: CricketState[],
): Map<number, CricketBallEv[]> {
  const segments = new Map<number, CricketBallEv[]>();
  events.forEach((event, i) => {
    if (event.type !== "cricket.ball") return;
    const inningsNo = (states[i] as CricketState).innings.length;
    const segment = segments.get(inningsNo) ?? [];
    segment.push(event.payload as CricketBallEv);
    segments.set(inningsNo, segment);
  });
  return segments;
}

describe("cricket property: generated streams respect bowling legality", () => {
  it("never violates consecutive-over or quota rules", () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 20, max: 300 }), (seed, length) => {
        const { events, states } = buildWalk(cricket, t20, lineups, seed, length);
        const segments = segmentBallsByInnings(events, states);
        for (const segment of segments.values()) {
          const overBowler = new Map<number, string>();
          for (const ball of segment) {
            const existing = overBowler.get(ball.over);
            expect(existing ?? ball.bowler).toBe(ball.bowler); // one bowler per over
            overBowler.set(ball.over, ball.bowler);
          }
          const overs = [...overBowler.entries()].sort((a, b) => a[0] - b[0]);
          const perBowler = new Map<string, number>();
          for (const [overNo, bowler] of overs) {
            const prev = overs.find(([n]) => n === overNo - 1);
            if (prev !== undefined) expect(prev[1]).not.toBe(bowler); // no consecutive overs
            perBowler.set(bowler, (perBowler.get(bowler) ?? 0) + 1);
          }
          for (const count of perBowler.values()) {
            expect(count).toBeLessThanOrEqual(t20.maxOversPerBowler as number); // quota
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  // Pins the exact counterexample the segmentation bug above shipped with
  // (CI run https://github.com/ashokhein/seazn.club/actions/runs/31544606387,
  // S7/#427) — an UNSEEDED property run only re-finds a rare edge case by
  // luck, so this is the actual regression guard, not the property above.
  it("does not merge a one-ball innings into the next innings' first over (regression)", () => {
    const { events, states } = buildWalk(cricket, t20, lineups, 1224485596, 20);
    const ballsByInnings = segmentBallsByInnings(events, states);
    expect(ballsByInnings.get(1)).toMatchObject([{ over: 0, ballInOver: 1, bowler: "A-3" }]);
    expect(ballsByInnings.get(2)).toMatchObject([{ over: 0, ballInOver: 1, bowler: "H-4" }]);
  });
});

// Helper: envelope a pre-built [type, payload] list continuing a stream.
function streamFrom(
  offset: number,
  specs: Array<[type: string, payload?: unknown]>,
): EventEnvelope[] {
  return specs.map(([type, payload], i) =>
    makeEnvelope(offset + i, { type, payload: payload ?? {} }),
  );
}

// PROMPT-05 acceptance — conformance green across the fidelity/format matrix.
conformanceSuite(cricket, { cfg: {}, lineups, label: "t20", numRuns: 120, maxEvents: 60 });
conformanceSuite(cricket, {
  cfg: { superOver: true, superOverStillTied: "boundary_count" },
  lineups,
  label: "t20 knockout",
  stageCtxs: [{ kind: "knockout" }, { kind: "group" }],
  numRuns: 120,
  maxEvents: 60,
});
conformanceSuite(cricket, {
  cfg: {
    inningsPerSide: 2,
    ballsPerInnings: null,
    points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 },
    followOn: { enabled: true, lead: 200 },
    minOversForResult: 0,
  },
  lineups,
  label: "test",
  numRuns: 120,
  maxEvents: 60,
});

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec conformance. Cricket is the reference/pilot module:
// this is what proves the harness is real, not vacuous.
// ---------------------------------------------------------------------------

const TEST_CFG_RAW = {
  inningsPerSide: 2 as const,
  ballsPerInnings: null,
  points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 },
  followOn: { enabled: true, lead: 200 },
  minOversForResult: 0,
};

// Randomises the cfg knobs padSpec's own bounds/inclusion logic actually
// reads, so the never-throws/determinism property gets more than the four
// named presets: over/ball-count bounds (`ballsPerOver`, `ballsPerInnings`),
// the all-out wicket ceiling (`playersPerSide`), and the DLS panel's cfg-only
// inclusion (`dls.enabled`). Combinations `configSchema` itself rejects
// (e.g. `dls.enabled` with `ballsPerInnings: null`) are silently skipped by
// `checkTotalDeterministicAndPureData` — not padSpec's problem, per its own
// doc comment.
const cricketCfgPerturbations = fc.record(
  {
    ballsPerOver: fc.integer({ min: 4, max: 8 }),
    ballsPerInnings: fc.option(fc.integer({ min: 20, max: 300 }), { nil: null }),
    playersPerSide: fc.integer({ min: 2, max: 11 }),
    dls: fc.record({ enabled: fc.boolean(), edition: fc.constant("standard" as const) }),
  },
  { requiredKeys: [] },
);

padSpecConformanceSuite(cricket, {
  cfg: {},
  lineups,
  label: "default",
  numRuns: 150,
  cfgPerturbations: cricketCfgPerturbations,
});
padSpecConformanceSuite(cricket, {
  cfg: { superOver: true, superOverStillTied: "boundary_count" },
  lineups,
  label: "t20 knockout (superOver)",
  numRuns: 80,
});
padSpecConformanceSuite(cricket, { cfg: TEST_CFG_RAW, lineups, label: "test", numRuns: 80 });
padSpecConformanceSuite(cricket, {
  cfg: { dls: { enabled: true, edition: "standard" } },
  lineups,
  label: "dls",
  numRuns: 80,
});

// (a), the module-level half: `cricket.superOver` requires `inningsPerSide
// === 1` and `cricket.followOn`/`.innings.declare` require `inningsPerSide
// === 2` (CricketCfg's own `.refine()`s) — no single legal cfg reaches both,
// so "every branch reachable from some action" is checked once, across the
// union of the variants this file actually exercises above.
describe("cricket padSpec — action coverage across the format space", () => {
  it("every registered event type is reachable from some action, across variants", () => {
    const specs = [
      padSpec(cricket.configSchema.parse({})),
      padSpec(cricket.configSchema.parse({ superOver: true })),
      padSpec(cricket.configSchema.parse(TEST_CFG_RAW)),
      padSpec(cricket.configSchema.parse({ dls: { enabled: true, edition: "standard" } })),
    ];
    expect(checkActionCoverage(specs, CRICKET_EVENT_SCHEMAS)).toEqual([]);
  });

  it("MUTATION SHAPE — coverage fails if any one of those four cfgs is dropped from the union (superOver, uniquely covering cricket.superover.ball)", () => {
    const specsWithoutSuperOver = [
      padSpec(cricket.configSchema.parse({})),
      padSpec(cricket.configSchema.parse(TEST_CFG_RAW)),
      padSpec(cricket.configSchema.parse({ dls: { enabled: true, edition: "standard" } })),
    ];
    const problems = checkActionCoverage(specsWithoutSuperOver, CRICKET_EVENT_SCHEMAS);
    expect(problems.join(" ")).toMatch(/cricket\.superover\.ball/);
  });
});

// S7/#427 — the two wicket prompts the dossier names as owed. Both are
// OPTIONAL person slots on an action whose own label ("Wicket") names none of
// them: a scorer looking at four person pickers in a row cannot tell the
// assisting fielder from the incoming batter without copy, and the renderer
// has nothing but the dotted path to fall back on.
describe("cricket padSpec — wicket prompts carry their own label keys (S7/#427)", () => {
  const spec = padSpec(cricket.configSchema.parse({}));

  it("labels wicket.fielderAssist and wicket.incoming", () => {
    expect(padItemLabelKey(spec, "cricket.ball", "wicket.fielderAssist")).toMatchObject({
      key: "pad.cricket.action.wicket.field.fielderAssist",
      where: "attribution",
    });
    expect(padItemLabelKey(spec, "cricket.ball", "wicket.incoming")).toMatchObject({
      key: "pad.cricket.action.wicket.field.incoming",
      where: "attribution",
    });
  });

  it("ships an English fallback beside each key (nothing renders a bare path)", () => {
    for (const path of ["wicket.fielderAssist", "wicket.incoming"]) {
      expect(padItemLabelKey(spec, "cricket.ball", path)?.label ?? "").not.toBe("");
    }
  });
});

function findField(spec: PadSpec, type: string, path: string): PadField | undefined {
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== type) continue;
      const field = action.fields.find((f) => f.path === path);
      if (field) return field;
    }
  }
  return undefined;
}

function actionTypesOf(spec: PadSpec): Set<string> {
  return new Set(spec.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
}

describe("cricket padSpec — variant reshaping: t20 vs test are demonstrably different", () => {
  const t20Spec = padSpec(cricket.configSchema.parse(cricket.variants.t20));
  const testSpec = padSpec(cricket.configSchema.parse(TEST_CFG_RAW));

  it("test adds declare/follow-on/time-expiry-draw panels; t20 has none of them", () => {
    const t20Types = actionTypesOf(t20Spec);
    const testTypes = actionTypesOf(testSpec);
    for (const twoInningsOnly of ["cricket.innings.declare", "cricket.followon", "cricket.match.close"]) {
      expect(t20Types.has(twoInningsOnly), twoInningsOnly).toBe(false);
      expect(testTypes.has(twoInningsOnly), twoInningsOnly).toBe(true);
    }
  });

  it("bounds are cfg-derived, not a hardcoded preset number: legalBalls caps at t20's 120, test's unlimited sentinel differs", () => {
    const t20LegalBalls = findField(t20Spec, "cricket.innings.summary", "legalBalls");
    const testLegalBalls = findField(testSpec, "cricket.innings.summary", "legalBalls");
    expect(t20LegalBalls?.kind).toBe("number");
    expect(testLegalBalls?.kind).toBe("number");
    if (t20LegalBalls?.kind === "number" && testLegalBalls?.kind === "number") {
      expect(t20LegalBalls.max).toBe(120); // cfg.ballsPerInnings
      expect(testLegalBalls.max).toBeGreaterThan(t20LegalBalls.max); // unlimited sentinel
    }
  });

  it("the over-index bound tracks ballsPerInnings/ballsPerOver directly", () => {
    const t20Over = findField(t20Spec, "cricket.ball", "over");
    // 120 balls / 6 per over = 20 overs, 0-based last index 19.
    if (t20Over?.kind === "number") expect(t20Over.max).toBe(19);
  });

  it("hundred honours its own 5-ball-set structure via ballsPerOver, not t20's 6", () => {
    const hundredSpec = padSpec(cricket.configSchema.parse(cricket.variants.hundred));
    const ballInOver = findField(hundredSpec, "cricket.ball", "ballInOver");
    if (ballInOver?.kind === "number") expect(ballInOver.max).toBe(5); // cfg.ballsPerOver
  });
});

describe("cricket padSpec — DLS panel gated on dls.enabled", () => {
  it("is absent when dls.enabled is false (the default)", () => {
    const spec = padSpec(cricket.configSchema.parse({}));
    expect(spec.panels.some((panel) => panel.labelKey.key === "pad.cricket.panel.dls")).toBe(false);
  });

  it("is present when dls.enabled is true", () => {
    const spec = padSpec(cricket.configSchema.parse({ dls: { enabled: true, edition: "standard" } }));
    expect(spec.panels.some((panel) => panel.labelKey.key === "pad.cricket.panel.dls")).toBe(true);
  });
});

describe("cricket padSpec — super over panel: cfg gates existence, a runtime gate governs reachability", () => {
  it("is absent from the spec entirely when cfg.superOver is false", () => {
    const spec = padSpec(cricket.configSchema.parse({}));
    expect(spec.panels.some((panel) => panel.labelKey.key === "pad.cricket.panel.superOver")).toBe(false);
  });

  it("is present but its gate is a path-equals against the real cricket phase value, not a typo", () => {
    const spec = padSpec(cricket.configSchema.parse({ superOver: true }));
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.cricket.panel.superOver");
    expect(panel?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "super_over" });
  });

  it("integration: the gate is false pre-match and false while merely live, against REAL cricket state", () => {
    const cfg = cricket.configSchema.parse({ superOver: true });
    const spec = padSpec(cfg);
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.cricket.panel.superOver");
    const gate = panel?.gate;
    expect(gate).toBeDefined();
    const preState = cricket.init(cfg, lineups);
    expect(evalPadGate(gate as NonNullable<typeof gate>, { state: preState, summary: cricket.summary(preState) })).toBe(
      false,
    );
    const liveState = fold(cfg, stream(["core.start"]));
    expect(
      evalPadGate(gate as NonNullable<typeof gate>, { state: liveState, summary: cricket.summary(liveState) }),
    ).toBe(false);
  });

  it("integration: the gate is true once the match actually ties into a super over — reachable, not merely configured", () => {
    const cfg = cricket.configSchema.parse({ superOver: true });
    const spec = padSpec(cfg);
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.cricket.panel.superOver");
    const gate = panel?.gate;
    expect(gate).toBeDefined();
    const tiedEvents = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120 }],
      ["cricket.innings.summary", { runs: 150, wickets: 7, legalBalls: 120 }],
    );
    const tiedState = fold(cfg, tiedEvents);
    expect(tiedState.phase).toBe("super_over"); // sanity: this really is a tie, not a fixture bug
    expect(
      evalPadGate(gate as NonNullable<typeof gate>, { state: tiedState, summary: cricket.summary(tiedState) }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2c — two rules the PAD must mirror, exported rather than forked.
//
// `eligibleBowlers` was already the private filter the random-stream generator
// used; R2b needed the same rule in the v3 cricket skin, was not granted the
// export, and hand-copied it as `isEligibleOverBowler` — which cost that
// wave's review a byte-for-byte verification to trust. R2c needs the LIST (to
// narrow the bowler chip's candidates), which is exactly what this function
// already is, so it is exported and the fork deleted.
//
// `reviewsRemaining` is new, and exists because the quota arithmetic is
// ALREADY forked twice INSIDE this file (`applyReview` and the generator each
// open-code `lost >= allowance`). A third copy in the pad is the drift bug
// this repo keeps paying for.
// ---------------------------------------------------------------------------

describe("eligibleBowlers (R2c — exported for the pad's bowler chip)", () => {
  // A REAL eleven, from this file's own lineup helper — not a toy array.
  // Production passes the whole fielding side (`state.orders[bowlingSide]`,
  // eleven names), and most of them have bowled nothing, so a 3-name fixture
  // cannot show that the untouched majority stay eligible.
  const order = lineup("away").slots.map((sl) => sl.personId);
  const [b1, b2, b3] = order as [string, string, string];

  it("returns the whole eleven when nobody has bowled and no over has been bowled yet", () => {
    expect(eligibleBowlers(order, { prevOverBowler: null, bowlerBalls: {} }, 4, 6)).toEqual(order);
  });

  it("excludes whoever bowled the previous over — the consecutive-over law — and only them", () => {
    const fine = { prevOverBowler: b2, bowlerBalls: {} };
    expect(eligibleBowlers(order, fine, undefined, 6)).toEqual(order.filter((id) => id !== b2));
  });

  it("an ABSENT maxOversPerBowler means no quota at all, never a quota of zero", () => {
    const fine = { prevOverBowler: null, bowlerBalls: { [b1]: 600 } };
    expect(eligibleBowlers(order, fine, undefined, 6)).toEqual(order);
  });

  it("excludes a bowler who has reached the quota, and keeps one still short of it", () => {
    // A real T20 spell: b1 has bowled his 4 overs, b2 three and a half.
    const fine = { prevOverBowler: null, bowlerBalls: { [b1]: 24, [b2]: 21 } };
    expect(eligibleBowlers(order, fine, 4, 6)).toEqual(order.filter((id) => id !== b1));
  });

  it("applies the consecutive-over and quota grounds together, not either/or", () => {
    const fine = { prevOverBowler: b3, bowlerBalls: { [b1]: 24 } };
    expect(eligibleBowlers(order, fine, 4, 6)).toEqual(order.filter((id) => id !== b1 && id !== b3));
  });

  it("divides by the cfg's ballsPerOver, not a hardcoded 6 — the Hundred bowls 5", () => {
    // 20 balls is 4 overs at bpo 5 (quota reached) but only 3.33 at bpo 6.
    const fine = { prevOverBowler: null, bowlerBalls: { [b1]: 20 } };
    expect(eligibleBowlers(order, fine, 4, 5)).toEqual(order.filter((id) => id !== b1));
    expect(eligibleBowlers(order, fine, 4, 6)).toEqual(order);
  });

  it("accepts a null fine — at an over boundary before the innings opens, nobody is yet ineligible", () => {
    expect(eligibleBowlers(order, null, 4, 6)).toEqual(order);
  });

  it("can empty the eleven completely — every bowler spent is a real state the pad must handle", () => {
    const spent = Object.fromEntries(order.map((id) => [id, 24]));
    expect(eligibleBowlers(order, { prevOverBowler: null, bowlerBalls: spent }, 4, 6)).toEqual([]);
  });
});

describe("reviewsRemaining (R2c — the quota rule, de-forked)", () => {
  const ledger = (home: number, away: number) => ({
    reviews: { home: { taken: 9, lost: home }, away: { taken: 0, lost: away } },
  });

  it("returns null when the cfg declares no allowance — uncapped, never zero", () => {
    expect(reviewsRemaining(ledger(5, 5), undefined, "home")).toBeNull();
  });

  it("counts down from the allowance as reviews are LOST", () => {
    expect(reviewsRemaining(ledger(0, 0), 2, "home")).toBe(2);
    expect(reviewsRemaining(ledger(1, 0), 2, "home")).toBe(1);
  });

  it("reads `lost`, not `taken` — an upheld review is not spent", () => {
    // home has TAKEN 9 and lost none; it still holds its full allowance.
    expect(reviewsRemaining(ledger(0, 0), 2, "home")).toBe(2);
  });

  it("is exactly zero at the boundary, and never negative past it", () => {
    expect(reviewsRemaining(ledger(2, 0), 2, "home")).toBe(0);
    expect(reviewsRemaining(ledger(3, 0), 2, "home")).toBe(0);
  });

  it("an innings with no ledger yet holds the full allowance for both sides", () => {
    expect(reviewsRemaining({}, 2, "home")).toBe(2);
    expect(reviewsRemaining({}, 2, "away")).toBe(2);
  });

  it("tracks each side independently", () => {
    expect(reviewsRemaining(ledger(2, 0), 2, "home")).toBe(0);
    expect(reviewsRemaining(ledger(2, 0), 2, "away")).toBe(2);
  });
});
