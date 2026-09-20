// Stage state machines — spec 05 §1 (completion), §3 (rank locks), §5
// (division events, withdrawal). PROMPT-08 §1.
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import type { FixtureResult } from "./standings.ts";
import {
  bracketRanks,
  completeBracketStage,
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  openStage,
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketFixture,
  type BracketStage,
  type TableFixture,
  type TableStage,
} from "./stage.ts";

function fb(home: string, away: string, hg: number, ag: number): FixtureResult {
  const draw = hg === ag;
  const homeWon = hg > ag;
  const side = (id: string, gf: number, ga: number, w: number, d: number, l: number, pts: number): StandingsDelta => ({
    entrantId: id,
    played: 1,
    won: w,
    drawn: d,
    lost: l,
    points: pts,
    metrics: { gf, ga, gd: gf - ga },
  });
  return [
    side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, draw ? 1 : homeWon ? 3 : 0),
    side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, draw ? 1 : homeWon ? 0 : 3),
  ];
}

const leagueStage: TableStage = {
  id: "s1",
  kind: "league",
  entrants: ["X", "Y", "Z"],
  cascade: ["points", "diff", "for", "lots"],
  rngSeed: 5,
};

describe("openStage", () => {
  it("emits stage_opened", () => {
    expect(openStage("s1")).toEqual([{ type: "stage_opened", stageId: "s1" }]);
  });
});

describe("completion predicates (spec 05 §1)", () => {
  it("league completes only when every fixture is settled", () => {
    const decided: TableFixture[] = [
      { id: "f1", status: "decided", result: fb("X", "Y", 1, 0) },
      { id: "f2", status: "void" },
    ];
    expect(isTableStageComplete(leagueStage, decided)).toBe(true);
    expect(
      isTableStageComplete(leagueStage, [...decided, { id: "f3", status: "scheduled" }]),
    ).toBe(false);
  });

  it("swiss completes when the configured rounds are all played", () => {
    const swiss: TableStage = { ...leagueStage, kind: "swiss", rounds: 2 };
    const fixtures: TableFixture[] = [
      { id: "r1a", roundNo: 1, status: "decided", result: fb("X", "Y", 1, 0) },
      { id: "r2a", roundNo: 2, status: "decided", result: fb("X", "Z", 1, 0) },
    ];
    expect(isTableStageComplete(swiss, fixtures)).toBe(true);
    expect(isTableStageComplete({ ...swiss, rounds: 3 }, fixtures)).toBe(false);
  });

  it("a one-sided award bye counts as a played win on the table", () => {
    // Swiss odd-field sit-out: walkover + awardDelta, no [home,away] pair.
    // Without folding awardDelta the bye winner stays P0/pts=0 while pairing
    // still treats them as having scored — the Gus defect on Swiss 7.
    const swiss: TableStage = {
      id: "sw",
      kind: "swiss",
      swiss: true,
      entrants: ["A", "B", "C"],
      cascade: ["points", "wins", "lots"],
      rounds: 1,
      rngSeed: 1,
    };
    const fixtures: TableFixture[] = [
      { id: "board", roundNo: 1, status: "decided", result: fb("A", "B", 1, 0) },
      {
        id: "bye",
        roundNo: 1,
        status: "walkover",
        awardDelta: {
          entrantId: "C",
          played: 1,
          won: 1,
          drawn: 0,
          lost: 0,
          points: 2,
          metrics: {},
        },
      },
    ];
    const { tables } = completeTableStage(swiss, fixtures);
    const byId = new Map((tables.overall ?? []).map((r) => [r.entrantId, r]));
    expect(byId.get("C")).toMatchObject({ played: 1, won: 1, points: 2 });
    expect(byId.get("A")).toMatchObject({ played: 1, won: 1, points: 3 });
  });

  it("a bracket completes when its final is decided", () => {
    const stage: BracketStage = { id: "ko", kind: "knockout" };
    const semis: BracketFixture[] = [
      { id: "sf1", round: 0, status: "decided", home: "A", away: "B", winner: "A", loser: "B" },
      { id: "fin", round: 1, isFinal: true, status: "scheduled", home: "A", away: "C" },
    ];
    expect(isBracketStageComplete(stage, semis)).toBe(false);
    semis[1] = { ...(semis[1] as BracketFixture), status: "decided", winner: "A", loser: "C" };
    expect(isBracketStageComplete(stage, semis)).toBe(true);
  });
});

describe("completeTableStage — division events (spec 05 §3/§5)", () => {
  it("emits stage_completed with cross-pool interleaved final ranks", () => {
    const stage: TableStage = {
      id: "grp",
      kind: "group",
      entrants: ["A1", "A2", "B1", "B2"],
      cascade: ["points", "diff", "for", "lots"],
    };
    const fixtures: TableFixture[] = [
      { id: "a", poolId: "A", status: "decided", result: fb("A1", "A2", 2, 0) },
      { id: "b", poolId: "B", status: "decided", result: fb("B1", "B2", 3, 0) },
    ];
    const { events, tables } = completeTableStage(stage, fixtures);
    expect(tables.pools.map((p) => p.pool)).toEqual(["A", "B"]);
    // rank-1s first (A1, B1), then rank-2s (A2, B2).
    const completed = events.find((e) => e.type === "stage_completed");
    expect(completed).toEqual({ type: "stage_completed", stageId: "grp", finalRanks: ["A1", "B1", "A2", "B2"] });
  });

  it("emits rank_lock_required + rank_lock when the cascade exhausts to lots", () => {
    const fixtures: TableFixture[] = [{ id: "f", status: "decided", result: fb("X", "Y", 1, 1) }];
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y"], cascade: ["points", "lots"], rngSeed: 2 };
    const { events } = completeTableStage(stage, fixtures);
    expect(events).toContainEqual({ type: "rank_lock_required", stageId: "s", group: ["X", "Y"] });
    expect(events).toContainEqual({ type: "rank_lock", stageId: "s", method: "lots", group: ["X", "Y"] });
  });

  it("marks lot-decided rows as rankLocked", () => {
    const fixtures: TableFixture[] = [{ id: "f", status: "decided", result: fb("X", "Y", 2, 2) }];
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y"], cascade: ["points", "lots"], rngSeed: 2 };
    const { tables } = completeTableStage(stage, fixtures);
    expect(tables.overall?.every((r) => r.rankLocked === true)).toBe(true);
  });
});

describe("bracketRanks (spec 05 §1)", () => {
  const stage: BracketStage = { id: "ko", kind: "knockout", seeds: new Map([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 4]]) };
  const bracket: BracketFixture[] = [
    { id: "sf1", round: 0, status: "decided", home: "S1", away: "S4", winner: "S1", loser: "S4" },
    { id: "sf2", round: 0, status: "decided", home: "S2", away: "S3", winner: "S2", loser: "S3" },
    { id: "fin", round: 1, isFinal: true, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
  ];

  it("ranks champion, runner-up, then losers by elimination round & seed", () => {
    expect(bracketRanks(stage, bracket)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("a 3rd-place playoff fixes ranks 3 and 4 from its result", () => {
    const withThird: BracketFixture[] = [
      ...bracket,
      { id: "3p", round: 1, thirdPlace: true, status: "decided", home: "S3", away: "S4", winner: "S4", loser: "S3" },
    ];
    expect(bracketRanks(stage, withThird)).toEqual(["S1", "S2", "S4", "S3"]);
  });

  it("completeBracketStage emits stage_completed with those ranks", () => {
    const { events, finalRanks } = completeBracketStage(stage, bracket);
    expect(finalRanks).toEqual(["S1", "S2", "S3", "S4"]);
    expect(events).toEqual([{ type: "stage_completed", stageId: "ko", finalRanks }]);
  });
});

// L3/#414 — page_playoff is a NEW BracketStage.kind, but bracketRanks reads
// only round/isFinal/loser (never stage.kind — grep confirms no branch on it
// anywhere in this file), so the fixed 4-team IPL-style page playoff
// (scheduling/generatePagePlayoff: pp-q1 + pp-elim at round 0, pp-q2 feeding
// from both at round 1, pp-final isFinal at round 2 — no thirdPlace fixture)
// needs zero changes to bracketRanks itself, only the type widen below. This
// is the regression proving that: without `"page_playoff"` in BracketStage's
// kind union this file fails to typecheck (TS2322).
describe("bracketRanks — page_playoff (L3/#414, spec 2026-07-19)", () => {
  const stage: BracketStage = {
    id: "pp",
    kind: "page_playoff",
    seeds: new Map([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 4]]),
  };
  // Q1 (major semi) S1 beats S2; Eliminator (minor semi) S3 beats S4; Q2
  // (preliminary final) is an UPSET — S2 (the Q1 loser) beats S3 (the
  // Eliminator winner) for a second life; the Final is S1 over S2.
  const bracket: BracketFixture[] = [
    { id: "pp-q1", round: 0, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
    { id: "pp-elim", round: 0, status: "decided", home: "S3", away: "S4", winner: "S3", loser: "S4" },
    { id: "pp-q2", round: 1, status: "decided", home: "S2", away: "S3", winner: "S2", loser: "S3" },
    {
      id: "pp-final",
      round: 2,
      isFinal: true,
      status: "decided",
      home: "S1",
      away: "S2",
      winner: "S1",
      loser: "S2",
    },
  ];

  it("ranks champion, runner-up, the Q2 (2nd-life) loser, then the Eliminator loser", () => {
    // S3 lost the Eliminator (round 0) but got a 2nd life via S2's upset, then
    // lost Q2 (round 1) — later elimination ⇒ ranked above S4, who never got
    // a 2nd life and is out after round 0. No thirdPlace fixture is involved:
    // this is the lastLossRound fallback alone.
    expect(bracketRanks(stage, bracket)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("completes once the Final alone is decided, regardless of the other three", () => {
    const beforeFinal = bracket.map((f) => (f.id === "pp-final" ? { ...f, status: "scheduled" as const, winner: undefined, loser: undefined } : f));
    expect(isBracketStageComplete(stage, beforeFinal)).toBe(false);
    expect(isBracketStageComplete(stage, bracket)).toBe(true);
  });

  it("completeBracketStage emits stage_completed with the page_playoff ranks", () => {
    const { events, finalRanks } = completeBracketStage(stage, bracket);
    expect(finalRanks).toEqual(["S1", "S2", "S3", "S4"]);
    expect(events).toEqual([{ type: "stage_completed", stageId: "pp", finalRanks }]);
  });
});

describe("withdrawal policies (spec 05 §5)", () => {
  const stage: TableStage = { id: "s", kind: "league", entrants: ["W", "A", "B", "C"], cascade: ["points", "lots"] };

  it("void_remaining EXPUNGES when the entrant has played < 50%", () => {
    const { events, updates } = withdrawTableEntrant(stage, "W", {
      played: [{ id: "p1", status: "decided", result: fb("W", "A", 1, 0) }],
      pending: [
        { id: "p2", opponent: "B" },
        { id: "p3", opponent: "C" },
      ],
    });
    expect(events[0]).toMatchObject({ type: "entrant_withdrawn", entrantId: "W", policy: "void_remaining", mode: "expunge" });
    expect(updates).toEqual([
      { fixtureId: "p1", status: "void" },
      { fixtureId: "p2", status: "void" },
      { fixtureId: "p3", status: "void" },
    ]);
  });

  it("void_remaining AWARDS remaining games when the entrant has played ≥ 50%", () => {
    const { events, updates } = withdrawTableEntrant(stage, "W", {
      played: [
        { id: "p1", status: "decided", result: fb("W", "A", 1, 0) },
        { id: "p2", status: "decided", result: fb("W", "B", 0, 1) },
      ],
      pending: [{ id: "p3", opponent: "C" }],
    });
    expect(events[0]).toMatchObject({ mode: "award" });
    expect(updates).toEqual([{ fixtureId: "p3", status: "walkover", walkoverTo: "C" }]);
  });

  it("bracket_walkover advances the opponent in each pending fixture", () => {
    const koStage: BracketStage = { id: "ko", kind: "knockout" };
    const fixtures: BracketFixture[] = [
      { id: "qf", round: 0, status: "decided", home: "W", away: "P", winner: "W", loser: "P" },
      { id: "sf", round: 1, status: "scheduled", home: "W", away: "Q" },
    ];
    const { events, updates } = withdrawBracketEntrant(koStage, "W", fixtures);
    expect(events[0]).toMatchObject({ type: "entrant_withdrawn", policy: "bracket_walkover" });
    expect(updates).toEqual([{ fixtureId: "sf", status: "walkover", walkoverTo: "Q" }]);
  });
});
