// Spectator surface W2, Task 4 — the ONE champion rule.
//
// Lifted verbatim from the division page's inline IIFE
// (`app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx`),
// which now imports it. The value is unchanged by design: this suite is what
// pins that, so the refactor cannot quietly move a crown.
import { describe, expect, it } from "vitest";
import {
  BRACKET_KINDS,
  divisionChampion,
  type ChampionFixture,
  type ChampionStage,
  type ChampionStandings,
} from "../champion";

const stage = (over: Partial<ChampionStage> & { id: string; seq: number }): ChampionStage => ({
  kind: "league",
  status: "active",
  ...over,
});

const fixture = (
  over: Partial<ChampionFixture> & { stage_id: string },
): ChampionFixture => ({
  round_no: 1,
  status: "decided",
  outcome: null,
  ...over,
});

const snapshot = (
  over: Partial<ChampionStandings> & { stage_id: string },
): ChampionStandings => ({
  pool_id: null,
  rows: [],
  ...over,
});

describe("BRACKET_KINDS", () => {
  it("is the division page's own four kinds — the set the page used to declare locally", () => {
    expect([...BRACKET_KINDS].sort()).toEqual([
      "double_elim",
      "knockout",
      "page_playoff",
      "stepladder",
    ]);
  });
});

describe("divisionChampion", () => {
  it("EMPTY: no stages → null", () => {
    expect(divisionChampion([], [], [])).toBeNull();
  });

  it("EMPTY: stages but no fixtures and no snapshot → null (never crowns a blank)", () => {
    expect(divisionChampion([stage({ id: "s1", seq: 1 })], [], [])).toBeNull();
  });

  it("a stage with NO fixtures is not a played stage, even beside a snapshot", () => {
    // `[].every(...)` is true, so without the length guard an undrawn division
    // crowns whoever sits at the top of a table nobody has played into.
    const stages = [stage({ id: "s1", seq: 1 })];
    const standings = [snapshot({ stage_id: "s1", rows: [{ entrantId: "a", rank: 1 }] })];
    expect(divisionChampion(stages, [], standings)).toBeNull();
  });

  it("league not complete and not fully played → null", () => {
    const stages = [stage({ id: "s1", seq: 1 })];
    const fixtures = [
      fixture({ stage_id: "s1", status: "decided", outcome: { winner: "a" } }),
      fixture({ stage_id: "s1", status: "scheduled" }),
    ];
    const standings = [
      snapshot({
        stage_id: "s1",
        rows: [
          { entrantId: "a", rank: 1 },
          { entrantId: "b", rank: 2 },
        ],
      }),
    ];
    expect(divisionChampion(stages, fixtures, standings)).toBeNull();
  });

  it("league with every fixture decided → rank 1 of the overall snapshot", () => {
    const stages = [stage({ id: "s1", seq: 1 })];
    const fixtures = [
      fixture({ stage_id: "s1", status: "decided", outcome: { winner: "a" } }),
      fixture({ stage_id: "s1", status: "finalized", outcome: { winner: "b" } }),
    ];
    const standings = [
      snapshot({
        stage_id: "s1",
        rows: [
          // Deliberately NOT in rank order, and rank 1 is NOT the last
          // fixture's winner: the rule reads the RANK, never the order of the
          // array and never the last result.
          { entrantId: "b", rank: 2 },
          { entrantId: "a", rank: 1 },
        ],
      }),
    ];
    expect(divisionChampion(stages, fixtures, standings)).toBe("a");
  });

  it("the DECISIVE stage is the highest seq, not the first or the last in the array", () => {
    // Two complete stages. The lower-seq one would crown "a"; the rule must
    // read s2 and crown "z".
    const stages = [
      stage({ id: "s2", seq: 2, status: "complete" }),
      stage({ id: "s1", seq: 1, status: "complete" }),
    ];
    const standings = [
      snapshot({ stage_id: "s1", rows: [{ entrantId: "a", rank: 1 }] }),
      snapshot({ stage_id: "s2", rows: [{ entrantId: "z", rank: 1 }] }),
    ];
    expect(divisionChampion(stages, [], standings)).toBe("z");
  });

  it("knockout: the HIGHEST round_no decided fixture's winner, in either input order", () => {
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout", status: "complete" })];
    const semi = fixture({ stage_id: "s1", round_no: 1, outcome: { winner: "loser-of-final" } });
    const final = fixture({ stage_id: "s1", round_no: 2, outcome: { winner: "champ" } });
    expect(divisionChampion(stages, [semi, final], [])).toBe("champ");
    // ORDER-DIFFERENTIAL: reversing the array must not change the answer, and
    // the lower round's winner is never the champion.
    expect(divisionChampion(stages, [final, semi], [])).toBe("champ");
  });

  it("knockout flagged complete with no decided fixture at all → null", () => {
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout", status: "complete" })];
    const fixtures = [fixture({ stage_id: "s1", round_no: 1, status: "cancelled" })];
    expect(divisionChampion(stages, fixtures, [])).toBeNull();
  });

  it("a stage is done when FLAGGED complete even with an undecided fixture", () => {
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout", status: "complete" })];
    const fixtures = [
      fixture({ stage_id: "s1", round_no: 1, outcome: { winner: "champ" } }),
      fixture({ stage_id: "s1", round_no: 2, status: "scheduled" }),
    ];
    expect(divisionChampion(stages, fixtures, [])).toBe("champ");
  });

  it("stage flagged complete with a POOL snapshot only → the pool row's rank 1", () => {
    // The `?? find(stage_id)` fallback: no overall (pool_id null) snapshot
    // exists, so the single pool's own table answers.
    const stages = [stage({ id: "s1", seq: 1, kind: "group", status: "complete" })];
    const standings = [
      snapshot({
        stage_id: "s1",
        pool_id: "p1",
        rows: [
          { entrantId: "p", rank: 1 },
          { entrantId: "q", rank: 2 },
        ],
      }),
    ];
    expect(divisionChampion(stages, [], standings)).toBe("p");
  });

  it("prefers the OVERALL snapshot over a pool one when both exist", () => {
    const stages = [stage({ id: "s1", seq: 1, kind: "group", status: "complete" })];
    const standings = [
      snapshot({ stage_id: "s1", pool_id: "p1", rows: [{ entrantId: "pool-top", rank: 1 }] }),
      snapshot({ stage_id: "s1", pool_id: null, rows: [{ entrantId: "overall-top", rank: 1 }] }),
    ];
    expect(divisionChampion(stages, [], standings)).toBe("overall-top");
  });

  it("a complete league whose snapshot has no rank 1 → null, never row zero", () => {
    const stages = [stage({ id: "s1", seq: 1, status: "complete" })];
    const standings = [
      snapshot({ stage_id: "s1", rows: [{ entrantId: "a" }, { entrantId: "b" }] }),
    ];
    expect(divisionChampion(stages, [], standings)).toBeNull();
  });

  it("a fixture carrying a winner but a non-terminal status still counts the stage as played", () => {
    // `finished()` is status OR `outcome.winner` — the page's own rule, kept.
    const stages = [stage({ id: "s1", seq: 1 })];
    const fixtures = [fixture({ stage_id: "s1", status: "in_play", outcome: { winner: "a" } })];
    const standings = [snapshot({ stage_id: "s1", rows: [{ entrantId: "a", rank: 1 }] })];
    expect(divisionChampion(stages, fixtures, standings)).toBe("a");
  });

  it("only the DECISIVE stage's fixtures decide whether it is done", () => {
    // s2 is the decisive stage and has an undecided fixture; s1 is fully
    // played. Reading the wrong stage's fixtures crowns somebody early.
    const stages = [stage({ id: "s1", seq: 1 }), stage({ id: "s2", seq: 2 })];
    const fixtures = [
      fixture({ stage_id: "s1", status: "decided", outcome: { winner: "a" } }),
      fixture({ stage_id: "s2", status: "scheduled" }),
    ];
    const standings = [snapshot({ stage_id: "s2", rows: [{ entrantId: "a", rank: 1 }] })];
    expect(divisionChampion(stages, fixtures, standings)).toBeNull();
  });
});
