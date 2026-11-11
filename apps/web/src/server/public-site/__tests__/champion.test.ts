// Spectator surface W2, Task 4 — the ONE champion rule.
//
// Lifted verbatim from the division page's inline IIFE
// (`app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx`),
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
  bracketTitleOf,
  decisiveStageOf,
  divisionTitle,
  stageFeedsOf,
  titleEntrantIds,
  type ChampionFixture,
  type ChampionStage,
  type ChampionStandings,
} from "../champion";

// The pre-W4 vocabulary, kept as thin adapters over the title functions so every pin below (the `CHANGED` cases
// included) still asserts what a SINGLE-CHAMPION division answers. A joint or vacant title is NOT a champion here —
// the W4 describes at the bottom of this file pin those.
const bracketChampion = (fixtures: readonly ChampionFixture[]) => {
  const t = bracketTitleOf(fixtures);
  return t?.kind === "champion" ? { fixtureId: t.fixtureId, winner: t.champion } : null;
};
const divisionChampion = (...a: Parameters<typeof divisionTitle>) => {
  const t = divisionTitle(...a);
  return t?.kind === "champion" ? t.champion : null;
};

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

  it("BRACKET_SETTLED is the repo's own settled set — `usecases/stages/swiss-gen.ts`'s DECIDED, read from source", () => {
    // `stages/swiss-gen.ts` is a server-only usecase and cannot be imported into this
    // pure module, so its declaration is read as TEXT: a status added to or
    // removed from that set reds here instead of drifting silently.
    const source = readFileSync(new URL("../../usecases/stages/swiss-gen.ts", import.meta.url), "utf8");
    // W3 T9 exported it with a type (`export const DECIDED: ReadonlySet<string> = new Set([...])`); the annotation is optional.
    const match = /const DECIDED(?::[^=]*)? = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match, "stages/swiss-gen.ts still declares DECIDED").not.toBeNull();
    const declared = [...match![1]!.matchAll(/"([a-z_]+)"/g)].map(([, s]) => s!);
    expect(declared.length).toBeGreaterThan(0);
    expect([...BRACKET_SETTLED].sort()).toEqual(declared.sort());
  });
});

// ---------------------------------------------------------------- W4 B2a: the title
// X-FR-4 (the champion half), X-CH-1, X-CH-3, C16. `// differential: today null` marks a case the pre-W4 rule answered
// null (the crown vanished, unannounced); each is paired with the case where the answer is a champion.
describe("bracketTitleOf — champion, joint winners, vacant (X-CH-1, X-CH-3)", () => {
  const ko = (id: string, over: Partial<ChampionFixture> = {}): ChampionFixture =>
    fixture({ id, stage_id: "ko", ...over });
  const finalRow = (over: Partial<ChampionFixture> = {}) =>
    ko("final", { round_no: 3, is_final: true, home_entrant_id: "a", away_entrant_id: "b", ...over });

  it("EMPTY: no fixtures → null (an empty bracket titles nobody)", () => {
    expect(bracketTitleOf([])).toBeNull();
  });

  it("X-FR-4 a joint final crowns both finalists (joint)", () => {
    // differential: today null
    const t = bracketTitleOf([finalRow({ outcome: null, joint_winners_at: "2026-11-10T10:00:00Z" })]);
    expect(t).toEqual({ kind: "joint", winners: ["a", "b"], fixtureId: "final" });
    expect(titleEntrantIds(t)).toEqual(["a", "b"]);
  });

  it("a joint ruling on a final that is NOT settled titles nobody (the ruling alone is not a result)", () => {
    expect(bracketTitleOf([finalRow({ status: "scheduled", outcome: null, joint_winners_at: "2026-11-10T10:00:00Z" })])).toBeNull();
  });

  it("X-FR-4 a departure double walkover on the final is a vacant title", () => {
    // differential: today null
    const t = bracketTitleOf([finalRow({ status: "forfeited", outcome: { kind: "double_walkover" } })]);
    expect(t).toEqual({ kind: "vacant", fixtureId: "final" });
    expect(titleEntrantIds(t)).toEqual([]);
  });

  it("X-FR-4 a vacant title reverses when the final is re-decided", () => {
    // The same rows with the final re-decided, as the reversal leaves them: a winner, no double walkover.
    const vacant = [finalRow({ status: "forfeited", outcome: { kind: "double_walkover" } })];
    const redecided = [finalRow({ status: "decided", outcome: { kind: "win", winner: "a" } })];
    expect(bracketTitleOf(vacant)?.kind).toBe("vacant");
    expect(bracketTitleOf(redecided)).toEqual({ kind: "champion", champion: "a", fixtureId: "final" });
  });

  it("a double walkover on a SEMI-final is not a vacant title (only the deciding final titles)", () => {
    const semi = ko("semi", { round_no: 2, status: "forfeited", outcome: { kind: "double_walkover" } });
    expect(bracketTitleOf([semi, finalRow({ status: "scheduled" })])).toBeNull();
  });

  it("a double walkover that is not yet SETTLED titles nobody", () => {
    expect(bracketTitleOf([finalRow({ status: "scheduled", outcome: { kind: "double_walkover" } })])).toBeNull();
  });

  it("a vacant first grand final with its conditional reset still scheduled: the title is WITHHELD (the reset cannot be proven unnecessary)", () => {
    // DE: a double-walkover grand final has no winner, so a later CONDITIONAL reset is not provably unnecessary → withheld.
    const gf = ko("gf", { round_no: 4, is_final: true, home_entrant_id: "wb", away_entrant_id: "lb", status: "forfeited", outcome: { kind: "double_walkover" } });
    const reset = ko("reset", { round_no: 5, is_final: true, conditional: true, status: "scheduled" });
    expect(bracketTitleOf([gf, reset])).toBeNull();
  });

  it("a joint ruling on a final with an EMPTY seat titles nobody (the guard: a joint pair needs both sides seated)", () => {
    // The engine throws joint_winners_side_missing; the read must never invent a one-sided pair.
    for (const seats of [{ away_entrant_id: null }, { home_entrant_id: null }, { away_entrant_id: undefined }]) {
      expect(bracketTitleOf([finalRow({ outcome: null, joint_winners_at: "2026-11-10T10:00:00Z", ...seats })]), JSON.stringify(seats)).toBeNull();
    }
  });

  it("titleEntrantIds: null and every kind (the empty case first)", () => {
    expect(titleEntrantIds(null)).toEqual([]);
    expect(titleEntrantIds({ kind: "champion", champion: "x" })).toEqual(["x"]);
    expect(titleEntrantIds({ kind: "joint", winners: ["x", "y"] })).toEqual(["x", "y"]);
    expect(titleEntrantIds({ kind: "vacant" })).toEqual([]);
  });
});

describe("divisionTitle — the title through the division rule", () => {
  const koStage = (over: Partial<ChampionStage> = {}) => stage({ id: "ko", seq: 1, kind: "knockout", status: "complete", ...over });

  it("EMPTY: no stages → null", () => {
    expect(divisionTitle([], [], [])).toBeNull();
  });

  it("a bracket division answers joint and vacant, not null", () => {
    // differential: today null
    const joint = fixture({ stage_id: "ko", round_no: 2, is_final: true, home_entrant_id: "a", away_entrant_id: "b", outcome: null, joint_winners_at: "2026-11-10T10:00:00Z" });
    expect(divisionTitle([koStage()], [joint], [])).toEqual({ kind: "joint", winners: ["a", "b"] });
    const vacant = fixture({ stage_id: "ko", round_no: 2, is_final: true, status: "forfeited", outcome: { kind: "double_walkover" } });
    expect(divisionTitle([koStage()], [vacant], [])).toEqual({ kind: "vacant" });
  });

  it("a TABLE stage answers champion only (never joint or vacant), the pair of the bracket cases above", () => {
    const stages = [stage({ id: "s1", seq: 1, status: "complete" })];
    const standings = [snapshot({ stage_id: "s1", rows: [{ entrantId: "a", rank: 1 }, { entrantId: "b", rank: 1 }] })];
    expect(divisionTitle(stages, [], standings)).toEqual({ kind: "champion", champion: "a" });
  });
});

describe("C16 — the decisive stage comes from the progression graph, not from seq", () => {
  const mainDraw = stage({ id: "main", seq: 1, kind: "knockout", status: "complete" });
  const plate = stage({ id: "plate", seq: 2, kind: "knockout", status: "complete", feeds_from: [{ stageId: "main", side: "losers" }] });
  const fx = (stage_id: string, winner: string) =>
    fixture({ stage_id, round_no: 3, is_final: true, home_entrant_id: winner, outcome: { winner } });

  it("a Knockout + Plate division crowns the main-draw winner, never the plate's", () => {
    // differential: seq made it "plate-winner"
    const fixtures = [fx("main", "main-winner"), fx("plate", "plate-winner")];
    expect(divisionTitle([mainDraw, plate], fixtures, [])).toEqual({ kind: "champion", champion: "main-winner" });
    expect(decisiveStageOf([plate, mainDraw])?.id, "in either input order").toBe("main");
  });

  it("the Plate's own result never titles the division even when the main draw is still undecided", () => {
    const fixtures = [fx("plate", "plate-winner")];
    expect(divisionTitle([mainDraw, plate], fixtures, [])).toBeNull();
  });

  it("positive pair: a plain knockout is its own decisive stage; group → knockout titles the knockout", () => {
    expect(decisiveStageOf([stage({ id: "k", seq: 1, kind: "knockout" })])?.id).toBe("k");
    const group = stage({ id: "g", seq: 1, kind: "group", status: "complete" });
    const ko = stage({ id: "ko", seq: 2, kind: "knockout", feeds_from: [{ stageId: "g", side: "winners" }] });
    expect(decisiveStageOf([group, ko])?.id).toBe("ko");
    expect(divisionTitle([group, ko], [fx("ko", "kw")], [])).toEqual({ kind: "champion", champion: "kw" });
  });

  it("a group feeding a knockout WITH a plate: the knockout titles it (feeder excluded, consolation excluded)", () => {
    const group = stage({ id: "g", seq: 1, kind: "group", status: "complete" });
    const ko = stage({ id: "ko", seq: 2, kind: "knockout", feeds_from: [{ stageId: "g", side: "winners" }] });
    const pl = stage({ id: "pl", seq: 3, kind: "knockout", feeds_from: [{ stageId: "ko", side: "losers" }] });
    expect(decisiveStageOf([group, ko, pl])?.id).toBe("ko");
  });

  it("m5 (PO ruling): a group feeding a Cup (ranks 1-4) AND a Bowl (ranks 5-8, higher seq) is titled by the CUP", () => {
    const group = stage({ id: "g", seq: 1, kind: "group", status: "complete" });
    const cup = stage({ id: "cup", seq: 2, kind: "knockout", feeds_from: [{ stageId: "g", side: "winners", top: true }] });
    const bowl = stage({ id: "bowl", seq: 3, kind: "knockout", feeds_from: [{ stageId: "g", side: "winners" }] });
    expect(decisiveStageOf([group, cup, bowl])?.id).toBe("cup");
    expect(decisiveStageOf([bowl, group, cup])?.id, "any input order").toBe("cup");
    // Still ambiguous (neither takes rank 1): the highest seq, as before.
    const a = stage({ id: "a", seq: 2, kind: "knockout", feeds_from: [{ stageId: "g", side: "winners" }] });
    expect(decisiveStageOf([group, a, bowl])?.id).toBe("bowl");
  });

  it("no feed declared anywhere → the highest seq, as before; empty list → undefined", () => {
    expect(decisiveStageOf([stage({ id: "a", seq: 1 }), stage({ id: "b", seq: 2 })])?.id).toBe("b");
    expect(decisiveStageOf([])).toBeUndefined();
  });

  it("a malformed graph (a cycle) degrades to the highest seq instead of answering nothing", () => {
    const a = stage({ id: "a", seq: 1, feeds_from: [{ stageId: "b", side: "winners" }] });
    const b = stage({ id: "b", seq: 2, feeds_from: [{ stageId: "a", side: "winners" }] });
    expect(decisiveStageOf([a, b])?.id).toBe("b");
  });
});

describe("stageFeedsOf — the stored progression, read as edges", () => {
  const rows = [
    { id: "g", seq: 1, progression: null },
    { id: "ko", seq: 2, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }] } },
    { id: "pl", seq: 3, progression: { sources: [{ stage: { stageId: "ko" }, take: [{ kind: "roundLosers", round: 0, count: 4 }] }] } },
  ];

  it("EMPTY: no stages → no edges; a stage without a progression has none", () => {
    expect(stageFeedsOf([]).size).toBe(0);
    expect(stageFeedsOf(rows).has("g")).toBe(false);
  });

  it("'previous' resolves by seq, an explicit stageId by id; roundLosers is the losers' side, a cut the winners'", () => {
    const feeds = stageFeedsOf(rows);
    expect(feeds.get("ko")).toEqual([{ stageId: "g", side: "winners", top: true }]);
    expect(feeds.get("pl")).toEqual([{ stageId: "ko", side: "losers" }]);
    expect(feeds.size, "edges checked").toBe(2);
  });

  it("a source naming no stage of the division, a self-reference and a malformed progression contribute nothing", () => {
    const feeds = stageFeedsOf([
      { id: "a", seq: 1, progression: { sources: [{ stage: "previous", take: [] }] } }, // first stage: no previous
      { id: "b", seq: 2, progression: { sources: [{ stage: { stageId: "ghost" }, take: [] }, { stage: { stageId: "b" }, take: [] }] } },
      { id: "c", seq: 3, progression: "nonsense" },
      { id: "d", seq: 4, progression: { sources: [null, 7, { stage: 3 }] } },
    ]);
    expect(feeds.size).toBe(0);
  });

  it("top: a rankRange 1-4 cut and a rankRange 5-8 cut are told apart, per take kind", () => {
    const src = (take: unknown[]) => stageFeedsOf([{ id: "a", seq: 1, progression: null }, { id: "b", seq: 2, progression: { sources: [{ stage: "previous", take }] } }]).get("b")![0]!;
    expect(src([{ kind: "rankRange", from: 1, to: 4 }]).top).toBe(true);
    expect(src([{ kind: "rankRange", from: 5, to: 8 }]).top).toBeUndefined();
    expect(src([{ kind: "topNPerGroup", n: 2 }]).top).toBe(true);
    expect(src([{ kind: "bestNth", nth: 3, count: 2 }]).top).toBeUndefined();
    expect(src([{ kind: "picks", picks: [{ pool: "A", rank: 1 }] }]).top).toBe(true);
    expect(src([{ kind: "picks", picks: [{ pool: "A", rank: 2 }] }]).top).toBeUndefined();
  });

  it("B2a carried minor: a MIXED take (a losers' take plus a table cut of rank 1) is the winners' side and NOT top - the schema does not forbid it", () => {
    const src = (take: unknown[]) => stageFeedsOf([{ id: "a", seq: 1, progression: null }, { id: "b", seq: 2, progression: { sources: [{ stage: "previous", take }] } }]).get("b")![0]!;
    const mixed = src([{ kind: "roundLosers", round: 1, count: 2 }, { kind: "rankRange", from: 1, to: 2 }]);
    expect(mixed.side).toBe("winners");
    // differential: the table cut alone is top; beside a losers' take the source feeds the losers' bracket, which never crowns.
    expect(src([{ kind: "rankRange", from: 1, to: 2 }]).top).toBe(true);
    expect(mixed.top).toBeUndefined();
    // every loser kind alone stays a plain losers' edge
    expect(src([{ kind: "firstLosses", count: 2 }, { kind: "roundLosers", round: 1, count: 2 }])).toEqual({ stageId: "a", side: "losers" });
  });

  it("a source with no take array is the winners' side (the default), not the losers'", () => {
    const feeds = stageFeedsOf([
      { id: "a", seq: 1, progression: null },
      { id: "b", seq: 2, progression: { sources: [{ stage: "previous" }] } },
    ]);
    expect(feeds.get("b")).toEqual([{ stageId: "a", side: "winners", top: true }]);
  });
});
