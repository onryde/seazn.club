// Spectator surface W2, Task 4 — the ONE champion rule.
//
// Lifted verbatim from the division page's inline IIFE
// (`app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx`),
// which now imports it. The value was unchanged by that move; this suite is
// what pinned it, so the refactor could not quietly move a crown.
//
// 2026-09-13 (hub Knockout tab, fix round 1) — the BRACKET branch DID move, on
// purpose. It now answers with `bracketChampion`, the engine's own rule
// (`packages/engine/src/competition/stage.ts` `bracketRanks`: the latest-round
// settled final that produced a winner), which the hub's knockout view calls
// too — one authority for who won a bracket instead of two that disagreed.
// That changed the crown on four shapes, each pinned below as `CHANGED` with
// its reason:
//   • a decided final while the bronze match is unplayed now crowns (it used to
//     wait for every fixture in the stage);
//   • a knockout FLAGGED complete whose final is unplayed no longer crowns an
//     earlier round's winner;
//   • a bronze match listed before the final it shares a round with no longer
//     takes the crown (the old highest-round reduce kept the first on a tie);
//   • a final `in_play` with a winner already in its outcome no longer crowns
//     (settled means decided, finalized or forfeited).
// League and group crowns are untouched.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRACKET_KINDS,
  BRACKET_SETTLED,
  bracketChampion,
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

let nextId = 0;
const fixture = (
  over: Partial<ChampionFixture> & { stage_id: string },
): ChampionFixture => ({
  id: `f${++nextId}`,
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
    // No `is_final` on either row: the last round's single fixture is the
    // final (`bracketChampion`'s fallback), so the answer is unchanged.
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

  it("a stage is done when FLAGGED complete even with an undecided fixture (a table's crown)", () => {
    // This used to be witnessed on a knockout. The flag no longer decides a
    // BRACKET's crown (see the CHANGED case below), so it is witnessed where it
    // still does: a league, whose champion is its table's rank 1.
    const fixtures = [
      fixture({ stage_id: "s1", round_no: 1, outcome: { winner: "a" } }),
      fixture({ stage_id: "s1", round_no: 2, status: "scheduled" }),
    ];
    const standings = [snapshot({ stage_id: "s1", rows: [{ entrantId: "top", rank: 1 }] })];
    expect(
      divisionChampion([stage({ id: "s1", seq: 1, status: "complete" })], fixtures, standings),
    ).toBe("top");
    // The positive pair for the flag: the same stage, NOT flagged, waits.
    expect(divisionChampion([stage({ id: "s1", seq: 1 })], fixtures, standings)).toBeNull();
  });

  it("CHANGED 2026-09-13: a knockout's crown is its FINAL, never the stage flag — flagged complete with the final unplayed crowns nobody", () => {
    // Was "champ" — round 1's winner — because the flag made the stage done and
    // the highest DECIDED round answered. A bracket whose final has not been
    // played has no champion, whatever the stage row says.
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout", status: "complete" })];
    const fixtures = [
      fixture({ stage_id: "s1", round_no: 1, outcome: { winner: "champ" } }),
      fixture({ stage_id: "s1", round_no: 2, status: "scheduled" }),
    ];
    expect(divisionChampion(stages, fixtures, [])).toBeNull();
  });

  it("CHANGED 2026-09-13: a decided final crowns while the bronze match is still to be played", () => {
    // Was null: the stage was not done until every fixture was. The engine
    // crowns off the final alone, and so does the hub's knockout view now.
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout" })];
    const fixtures = [
      fixture({ stage_id: "s1", round_no: 2, is_final: true, outcome: { winner: "champ" } }),
      fixture({ stage_id: "s1", round_no: 2, third_place: true, status: "scheduled" }),
    ];
    expect(divisionChampion(stages, fixtures, [])).toBe("champ");
  });

  it("CHANGED 2026-09-13: a bronze match listed BEFORE the final it shares a round with never takes the crown", () => {
    // Was "third": `reduce((a, b) => b.round_no > a.round_no ? b : a)` keeps the
    // FIRST row on a tie. `data.ts` orders by round then seq, so production
    // happened to list the final first — luck, not a rule.
    const stages = [stage({ id: "s1", seq: 1, kind: "knockout", status: "complete" })];
    const fixtures = [
      fixture({ stage_id: "s1", round_no: 2, third_place: true, outcome: { winner: "third" } }),
      fixture({ stage_id: "s1", round_no: 2, is_final: true, outcome: { winner: "champ" } }),
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
    // `finished()` is status OR `outcome.winner` — the page's own rule, kept
    // for TABLE stages. (A bracket final in that state does not crown: see
    // `bracketChampion`'s settled-set sweep.)
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

describe("bracketChampion — the engine's rule, and the one authority for a bracket's crown", () => {
  const ko = (id: string, over: Partial<ChampionFixture> = {}): ChampionFixture =>
    fixture({ id, stage_id: "ko", ...over });

  it("EMPTY: no fixtures → null", () => {
    expect(bracketChampion([])).toBeNull();
  });

  it("the FINAL crowns, not the bronze match sharing its round — in either input order", () => {
    const final = ko("final", { round_no: 3, is_final: true, outcome: { winner: "champ" } });
    const bronze = ko("bronze", { round_no: 3, third_place: true, outcome: { winner: "third" } });
    const semi = ko("semi", { round_no: 2, outcome: { winner: "semi-winner" } });
    expect(bracketChampion([bronze, final, semi])).toEqual({ fixtureId: "final", winner: "champ" });
    expect(bracketChampion([semi, final, bronze])).toEqual({ fixtureId: "final", winner: "champ" });
  });

  it("SETTLED is decided, finalized and forfeited — every other status crowns nobody, winner or not", () => {
    // Enumerated, not sampled. A forfeit is written WITH a winner
    // (`engine-db/append-event.ts` `fixtureStatusFromFold`), and the engine
    // counts its walkover as settled.
    for (const status of ["decided", "finalized", "forfeited"]) {
      expect(
        bracketChampion([ko("final", { is_final: true, status, outcome: { winner: "w" } })]),
        status,
      ).toEqual({ fixtureId: "final", winner: "w" });
    }
    for (const status of ["scheduled", "in_play", "abandoned", "cancelled", "postponed"]) {
      expect(
        bracketChampion([ko("final", { is_final: true, status, outcome: { winner: "w" } })]),
        status,
      ).toBeNull();
    }
  });

  it("a settled final with NO winner crowns nobody", () => {
    expect(bracketChampion([ko("final", { is_final: true, outcome: {} })])).toBeNull();
    expect(bracketChampion([ko("final", { is_final: true, outcome: null })])).toBeNull();
  });

  it("a decided final crowns while the bronze match is still to be played", () => {
    expect(
      bracketChampion([
        ko("bronze", { round_no: 3, third_place: true, status: "scheduled" }),
        ko("final", { round_no: 3, is_final: true, outcome: { winner: "champ" } }),
      ]),
    ).toEqual({ fixtureId: "final", winner: "champ" });
  });

  it("no is_final flag anywhere: the last round's SINGLE non-bronze fixture is the final — two there, and nothing crowns", () => {
    const semi = ko("semi", { round_no: 1, outcome: { winner: "s" } });
    expect(
      bracketChampion([
        ko("bronze", { round_no: 2, third_place: true, outcome: { winner: "b" } }),
        ko("last", { round_no: 2, outcome: { winner: "w" } }),
        semi,
      ]),
    ).toEqual({ fixtureId: "last", winner: "w" });
    expect(
      bracketChampion([
        ko("a", { round_no: 2, outcome: { winner: "w" } }),
        ko("b", { round_no: 2, outcome: { winner: "v" } }),
        semi,
      ]),
    ).toBeNull();
  });

  describe("double elimination: the grand final and its conditional reset", () => {
    // `bracket.ts` seats the winners' champion at HOME in the first grand final
    // and owes the reset only when the losers' champion (away) wins it. NOTHING
    // in production voids an unneeded reset: the one writer that does is the
    // engine's own test harness (`testkit/simulation.ts`, `gf1.winner ===
    // gf1.home`). So a reset nobody owes stays `scheduled`, and "owed" is read
    // off the first grand final's RESULT, never off the reset's row.
    const gf = (over: Partial<ChampionFixture>) =>
      ko("gf", { round_no: 7, is_final: true, home_entrant_id: "wb", ...over });
    const reset = (over: Partial<ChampionFixture>) =>
      ko("gf-reset", { round_no: 8, is_final: true, conditional: true, home_entrant_id: "lb", ...over });

    it("the winners' champion took the first grand final: no reset is owed, so it crowns beside a reset row still scheduled", () => {
      expect(
        bracketChampion([reset({ status: "scheduled" }), gf({ outcome: { winner: "wb" } })]),
      ).toEqual({ fixtureId: "gf", winner: "wb" });
    });

    it("the losers' champion took it: the reset is OWED, and the crown waits for it", () => {
      expect(
        bracketChampion([reset({ status: "scheduled" }), gf({ outcome: { winner: "lb" } })]),
      ).toBeNull();
    });

    it("the reset, once settled, crowns — the LATEST-round settled final, in either input order", () => {
      const first = gf({ outcome: { winner: "lb" } });
      const second = reset({ outcome: { winner: "wb" } });
      expect(bracketChampion([first, second])).toEqual({ fixtureId: "gf-reset", winner: "wb" });
      expect(bracketChampion([second, first])).toEqual({ fixtureId: "gf-reset", winner: "wb" });
    });

    it("a reset won by FORFEIT crowns the reset's winner — never the first grand final's", () => {
      expect(
        bracketChampion([
          gf({ outcome: { winner: "lb" } }),
          reset({ status: "forfeited", outcome: { winner: "wb" } }),
        ]),
      ).toEqual({ fixtureId: "gf-reset", winner: "wb" });
    });
  });

  it("a row flagged BOTH is_final and third_place is a bronze match, not a final — it never crowns", () => {
    // The generator never marks a bronze match `is_final` (`bracket.ts`
    // `generateSingleElim`), so this guards hand-entered rows. Listed FIRST and
    // sharing the final's round, so a filter that let it through finds it
    // before the real final.
    const misflagged = ko("bronze", {
      round_no: 3,
      is_final: true,
      third_place: true,
      outcome: { winner: "third" },
    });
    expect(
      bracketChampion([misflagged, ko("final", { round_no: 3, is_final: true, status: "scheduled" })]),
    ).toBeNull();
    expect(
      bracketChampion([misflagged, ko("final", { round_no: 3, is_final: true, outcome: { winner: "champ" } })]),
    ).toEqual({ fixtureId: "final", winner: "champ" });
  });

  it("a later final that is NOT conditional is always owed — an earlier decided final cannot crown past it", () => {
    expect(
      bracketChampion([
        ko("first", { round_no: 1, is_final: true, home_entrant_id: "w", outcome: { winner: "w" } }),
        ko("second", { round_no: 2, is_final: true, status: "scheduled" }),
      ]),
    ).toBeNull();
  });

  it("BRACKET_SETTLED is the repo's own settled set — `usecases/stages.ts`'s DECIDED, read from source", () => {
    // `stages.ts` is a server-only usecase and cannot be imported into this
    // pure module, so its declaration is read as TEXT: a status added to or
    // removed from that set reds here instead of drifting silently.
    const source = readFileSync(new URL("../../usecases/stages.ts", import.meta.url), "utf8");
    const match = /const DECIDED = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match, "stages.ts still declares DECIDED").not.toBeNull();
    const declared = [...match![1]!.matchAll(/"([a-z_]+)"/g)].map(([, s]) => s!);
    expect(declared.length).toBeGreaterThan(0);
    expect([...BRACKET_SETTLED].sort()).toEqual(declared.sort());
  });
});
