// The bracket-finish family's tests. Every expected value is read from a signed rule row (packages/engine/rules/*.md),
// spec 2026-10-08-format-matrix-w2a-design.md (§5.1, §5.4.2, §5.4.3, §7) or a CONTROLLER ruling P2-1..P2-8 on T15's
// questions (2026-10-08; controller rulings, not owner rulings) — never from engine source (R8). W2b (Task 15, lane P2)
// adds Appendix A's forfeit, double-walkover and dead-seat rows (spec 2026-10-08-format-matrix-w2b-design.md §5.3,
// §5.4, §7) and the plan's D3/D4/D19/PF-1/PF-2 — below "W2b". The engine is touched only for its DECLARED domain at
// test time: StageKind.options and the sport registry.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The one sanctioned VALUE import of the product (brief Step 4, R8): the core BRACKET_KINDS, for the cross-check
// below. NOT the 4-kind BRACKET_STAGE_KINDS namesake in competition/progression.ts (review m4).
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";
import { forEachSport } from "@seazn/engine/testkit";
import {
  FORFEIT_REASONS,
  LEVEL_KINDS,
  OUT_OF_SCOPE,
  OutOfScope,
  RULED_OUT,
  RULED_SPORTS,
  RuledOut,
  bracketFinish,
  expectBracketFinish,
  type Action,
  type BracketCase,
  type BracketExpect,
  type LevelKind,
  type PlayResult,
  type RefusalCode,
  type Side,
} from "./bracket-finish.ts";
import { bracketKindsFromRows, drawKindsFromXDR1, levelKindsFromXBR1, readRuleRows, rowById } from "../../test/rule-rows.ts";
import { readAppendixA, readRowsWithAppendixA } from "../../test/appendix-a.ts";

const DRAW = { kind: "level", as: "draw" } as const satisfies PlayResult;
const base: BracketCase = { stageKind: "knockout", sport: "boardgame", play: DRAW, actions: [], hasLoserLine: false };

describe("reference family bracket-finish (rule rows X-BR-1/2, X-ST-1/2, BG-KO-1/2, CA-KO-1, GN-KO-1, CK-KO-1)", () => {
  it("empty case first: a bracket with zero fixtures has nothing to expect (and a fixture with nothing played is scheduled)", () => {
    expect(bracketFinish.expectAll([])).toEqual([]);
    expect(expectBracketFinish({ ...base, play: { kind: "none" } })).toEqual({ status: "scheduled", advances: null, refused: [] });
  });
  it("X-BR-2: a level result in a bracket is needs_decision and seats nobody", () => {
    expect(expectBracketFinish({ ...base, sport: "football" })).toEqual({ status: "needs_decision", advances: null, refused: [] });
  });
  it("X-ST-1: settle after a level result advances the winner and the loser, by method", () => {
    const e = expectBracketFinish({ ...base, sport: "football", hasLoserLine: true, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] });
    expect(e).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: "settled_lot" }, refused: [] });
  });
  it("X-ST-1: settle on a decided win is refused; a second settle is refused", () => {
    expect(expectBracketFinish({ ...base, play: { kind: "win", winner: "home" }, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 0, code: "SETTLE_NOT_APPLICABLE" }]);
    expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }, { kind: "settle", winner: "home", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 1, code: "SETTLE_NOT_APPLICABLE" }]);
  });
  it("X-ST-2: a scorer's or a device's settle is refused FORBIDDEN, whatever the state", () => {
    for (const by of ["scorer", "device"] as const) {
      expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "settle", winner: "away", method: "lot", by }] }).refused, by).toEqual([{ index: 0, code: "FORBIDDEN" }]);
    }
  });
  it("X-ST-1: an abandon with nothing decided, then settle: decided; a void of the settle: back to abandoned", () => {
    expect(expectBracketFinish({ ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }] }).status).toBe("decided");
    expect(expectBracketFinish({ ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }, { kind: "void-last" }] }).status).toBe("abandoned");
  });
  it("BG-KO-1: a drawn chess game in a bracket goes to a tie-break; each rung decides with its own method", () => {
    for (const rung of ["rapid", "blitz", "armageddon"] as const) {
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung, winner: "home" }] }).advances, rung).toEqual({ winner: "home", loser: null, method: `tiebreak_${rung}` });
    }
  });
  it("BG-KO-1 + ruling C12: a drawn chess bracket game awaits its tie-break (in_play, nobody seated); lots is the organiser's settle there", () => {
    expect(expectBracketFinish(base)).toEqual({ status: "in_play", advances: null, refused: [] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] })).toEqual({ status: "decided", advances: { winner: "away", loser: null, method: "settled_lot" }, refused: [] });
    // the positive pair's negative: after the tie-break decided it, a settle is refused
    expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "rapid", winner: "home" }, { kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 1, code: "SETTLE_NOT_APPLICABLE" }]);
  });
  it("BG-KO-2 (W2a enforcement per ruling 82): the armageddon winner the scorer records advances, either side — no draw is recorded in W2a", () => {
    for (const winner of ["home", "away"] as const) {
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "armageddon", winner }] }), winner).toEqual({ status: "decided", advances: { winner, loser: null, method: "tiebreak_armageddon" }, refused: [] });
    }
  });
  it("CA-KO-1: a carrom bracket match never ends level — the extra board decides, so 'level' is not a carrom bracket result", () => {
    expect(() => expectBracketFinish({ ...base, sport: "carrom" })).toThrow(/CA-KO-1/);
  });
  it("GN-KO-1: a generic draw in a bracket is refused LEVEL_RESULT_IN_BRACKET", () => {
    expect(expectBracketFinish({ ...base, sport: "generic" })).toEqual({ status: "scheduled", advances: null, refused: [{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }] });
  });
  it("CK-KO-1: a cricket knockout no-result is held and settled by the higher group finisher", () => {
    expect(expectBracketFinish({ ...base, sport: "cricket", play: { kind: "level", as: "no_result" }, actions: [{ kind: "settle", winner: "home", method: "higher_seed", by: "organiser" }] }).advances).toEqual({ winner: "home", loser: null, method: "settled_higher_seed" });
  });
  it("finalize of a level result is refused until it is settled", () => {
    expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "finalize" }] }).refused).toEqual([{ index: 0, code: "LEVEL_RESULT_IN_BRACKET" }]);
  });
});

// ── Scope: which stage kinds and sports the family answers, read from the rules directory ────────────────────────

const ROWS = readRuleRows();
const KINDS: readonly string[] = StageKind.options;
const BRACKET_KINDS_FROM_ROWS = bracketKindsFromRows(ROWS, KINDS);
const DRAW_KINDS_FROM_ROWS = drawKindsFromXDR1(ROWS, KINDS);

/** X-BR-1's level kinds, read from its sentence: "`draw`, `tie` and `no_result` are never a decided result". */
const LEVEL_KINDS_FROM_ROWS = levelKindsFromXBR1(ROWS) as LevelKind[];
const HELD_BY_X_BR_2: BracketExpect = { status: "needs_decision", advances: null, refused: [] }; // "held as needs_decision: not decided, nobody seated"
type LevelAnswer = BracketExpect | "ruled-out";
/** What a level PLAY result in a bracket becomes, per a sport's own KO row and per X-BR-1 level kind — the oracle's
 *  reading of each row's sentence. A row answers only the level kinds it names; `null`: the row does not speak to a
 *  level play result at all. A level kind no row of the sport names answers by X-BR-2 (spec §5.4.3 / ruling 79: "every
 *  other level result in a bracket is accepted and held"). Every `-KO-` row in the rules directory must be classified
 *  here (a new one reds the sweep below). */
const LEVEL_PLAY_BY_KO_ROW: Readonly<Record<string, Readonly<Partial<Record<LevelKind, LevelAnswer>>> | null>> = {
  // "a drawn chess game goes to a tie-break" + ruling C12 (in_play). A chess double forfeit is no level result at all
  // since W2b: BG-DW-1 folds it to the double walkover (play `double_walkover`, below "W2b"), retiring T15-R1's hold.
  "BG-KO-1": { draw: { status: "in_play", advances: null, refused: [] } },
  "BG-KO-2": null, // the armageddon winner — about the tie-break, not the play
  // W2c BG-KO-3: "the tie-break sequence is the organiser's ordered list; an empty list sends a drawn game to the
  // organiser". One answer per row, and two rows answering chess `draw` is a contradiction the sweep refuses, so BG-KO-1
  // keeps the DEFAULT stage's answer (rungs preset: in_play, awaiting its tie-break). The EMPTY-list case (held,
  // needs_decision, ruling 79) is owned by W2c Task 8, which proves BG-KO-3 and gives the oracle a stage-rules input.
  "BG-KO-3": null,
  // W2c IH-KO-1: "a knockout stage starts with overtime and a shootout" is what a NEW stage is given, not what a recorded
  // level result becomes. With the preset on a level regulation score plays on and there is no level result to record;
  // with every decider off X-SR-6 holds it for the organiser, which is X-BR-2's answer the oracle already gives. A
  // BracketCase carries no stage rules, and tools/matrix's reference-bracket.test.ts models ice hockey as held, so the
  // row answers no kind. Tasks 6 and 12 own the preset's proof.
  "IH-KO-1": null,
  // "always plays the ICF extra board": a level board SCORE never stands. A no_result is no score: X-BR-2 holds it.
  "CA-KO-1": { draw: "ruled-out", tie: "ruled-out" },
  // "refuses a draw" (ruling 79: "refusal remains only for a generic draw"); a tie or a no_result is held by X-BR-2.
  "GN-KO-1": { draw: { status: "scheduled", advances: null, refused: [{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }] } },
  // "a cricket knockout tie with no super over, or a no-result, is held and closed by settle"
  "CK-KO-1": { tie: HELD_BY_X_BR_2, no_result: HELD_BY_X_BR_2 },
};
const KO_ROW = /^[A-Z]+-KO-\d+$/;
/** The level kind BG-KO-1 sends to a tie-break: "a drawn chess game" (the table above answers it in_play). */
const DRAWN: LevelKind = "draw";

/** Which row answers a level play result of kind `as` for `sport` — the sport's KO row that names `as`, else X-BR-2 —
 *  and how many of the sport's rows name it (more than one is a contradiction the sweep refuses). */
function levelAnswer(sport: string, as: LevelKind): { id: string; want: LevelAnswer; naming: number } {
  const own = ROWS.filter((r) => r.file === sport && KO_ROW.test(r.id) && LEVEL_PLAY_BY_KO_ROW[r.id]?.[as] !== undefined);
  const want = own[0] === undefined ? undefined : LEVEL_PLAY_BY_KO_ROW[own[0].id]?.[as];
  return own[0] === undefined || want === undefined ? { id: "X-BR-2", want: HELD_BY_X_BR_2, naming: own.length } : { id: own[0].id, want, naming: own.length };
}
const heldByRows = (sport: string, as: LevelKind): boolean => {
  const { want } = levelAnswer(sport, as);
  return typeof want === "object" && want.status === "needs_decision";
};

/** The rows this family owes an answer: every bracket, settle and draw row (X-BR, X-ST, X-DR) and every sport's KO
 *  row. Any other row — a later wave's — is not this family's. */
const OWED_ROW = /^X-(BR|ST|DR)-\d+$|^[A-Z]+-KO-\d+$/;
const owedRows = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id).filter((id) => OWED_ROW.test(id)).sort();
/** The sport whose own row sends a drawn bracket game to a tie-break (BG-KO-1's rules file). */
const CHESS = rowById(ROWS, "BG-KO-1").file;

describe("bracket-finish scope, read from the rules directory (X-BR-1, X-DR-1, the per-sport KO rows)", () => {
  it("X-BR-1 + X-DR-1: the family's stage kinds are exactly the engine's declared kinds minus X-DR-1's draw kinds", () => {
    // Both sides of the split are non-empty, or the comparison below proves nothing.
    expect(DRAW_KINDS_FROM_ROWS.length).toBeGreaterThan(0);
    expect(BRACKET_KINDS_FROM_ROWS.length).toBeGreaterThan(0);
    expect(BRACKET_KINDS_FROM_ROWS.length + DRAW_KINDS_FROM_ROWS.length).toBe(KINDS.length);
    expect(new Set(bracketFinish.stageKinds).size).toBe(bracketFinish.stageKinds.length); // no kind listed twice
    expect([...bracketFinish.stageKinds].sort()).toEqual([...BRACKET_KINDS_FROM_ROWS].sort());
    expect(bracketFinish.sports).toBe("any");
  });

  it("Step 4 cross-check (R8's one meeting point): the engine's core BRACKET_KINDS equals the family's stage kinds AND the rule rows' bracket kinds — a disagreement is a FINDING, never a fix to either side", () => {
    const engine: string[] = [...BRACKET_KINDS];
    // empty case: an empty export would make the set-equalities below compare nothing
    expect(engine.length).toBeGreaterThan(0);
    // full case: not every declared kind — X-DR-1's draw kinds stay out
    expect(engine.length).toBeLessThan(KINDS.length);
    expect(new Set(engine).size, "BRACKET_KINDS lists a kind twice").toBe(engine.length);
    let declared = 0;
    for (const k of engine) {
      expect(KINDS, `${k} is not a declared StageKind`).toContain(k);
      declared++;
    }
    expect(declared).toBe(engine.length);
    expect([...engine].sort(), "engine BRACKET_KINDS vs the family's stageKinds").toEqual([...bracketFinish.stageKinds].sort());
    expect([...engine].sort(), "engine BRACKET_KINDS vs the rule rows (declared kinds minus X-DR-1's)").toEqual([...BRACKET_KINDS_FROM_ROWS].sort());
  });

  it("X-DR-1: a draw kind is outside the family — every draw kind × every registered sport is RuledOut, naming the kind", () => {
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      for (const stageKind of DRAW_KINDS_FROM_ROWS) {
        const c = { ...base, stageKind: stageKind as BracketCase["stageKind"], sport: key };
        expect(() => expectBracketFinish(c), `${stageKind} × ${key}`).toThrow(RuledOut);
        expect(() => expectBracketFinish(c), `${stageKind} × ${key}`).toThrow(`${stageKind} is not a bracket kind`);
        judged++;
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBe(sports * DRAW_KINDS_FROM_ROWS.length);
  });

  it("X-BR-1: every bracket kind answers alike (no bracket row names a kind) — every bracket kind × every sport × a case per decided path", () => {
    const cases: readonly Omit<BracketCase, "stageKind" | "sport">[] = [
      { play: { kind: "none" }, actions: [], hasLoserLine: false },
      { play: { kind: "win", winner: "away" }, actions: [{ kind: "finalize" }], hasLoserLine: true },
      { play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "away", method: "higher_seed", by: "organiser" }], hasLoserLine: true },
      { play: { kind: "win", winner: "home" }, actions: [{ kind: "settle", winner: "away", method: "lot", by: "scorer" }], hasLoserLine: false },
    ];
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      for (const c of cases) {
        const knockout = expectBracketFinish({ ...c, stageKind: "knockout", sport: key });
        for (const stageKind of bracketFinish.stageKinds) {
          expect(expectBracketFinish({ ...c, stageKind, sport: key }), `${stageKind} × ${key}`).toEqual(knockout);
          judged++;
        }
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBe(sports * cases.length * bracketFinish.stageKinds.length);
  });

  it("the sports the family special-cases are exactly the rules files holding a KO row, and each is a registered sport", () => {
    const koFiles = [...new Set(ROWS.filter((r) => KO_ROW.test(r.id)).map((r) => r.file))].sort();
    expect(koFiles.length).toBeGreaterThan(0);
    expect(Object.keys(RULED_SPORTS).sort()).toEqual(koFiles);
    const registered: string[] = [];
    const sports = forEachSport(({ key }) => { registered.push(key); });
    expect(sports).toBeGreaterThan(0);
    // every non-cross-sport rules file is a sport the registry knows: a renamed key would otherwise drop its rows silently
    const sportFiles = [...new Set(ROWS.map((r) => r.file))].filter((f) => f !== "cross-sport");
    expect(sportFiles.length).toBeGreaterThan(0);
    for (const f of sportFiles) expect(registered, f).toContain(f);
    // and the family cites, per sport, exactly the KO rows its file holds
    for (const [sport, ids] of Object.entries(RULED_SPORTS)) {
      expect([...ids].sort(), sport).toEqual(ROWS.filter((r) => r.file === sport && KO_ROW.test(r.id)).map((r) => r.id).sort());
    }
  });

  it("the rows the family cites are rules-directory rows (or Appendix A rows Task 14 has yet to write there), every one signed, and every X-BR, X-ST, X-DR and KO row is cited (none stale, none unanswered; a later wave's other row is not this family's)", () => {
    expect(ROWS.length).toBeGreaterThan(0);
    const withAppendix = readRowsWithAppendixA();
    const ids = withAppendix.map((r) => r.id);
    expect(new Set(bracketFinish.rows).size).toBe(bracketFinish.rows.length); // no row cited twice
    for (const id of bracketFinish.rows) expect(ids, `${id} is cited but is no rules row (stale)`).toContain(id);
    for (const id of bracketFinish.rows) expect(rowById(withAppendix, id).status, id).toMatch(/^signed \d+ \d{4}-\d{2}-\d{2}$/);
    const owed = owedRows(ROWS);
    expect(owed.length).toBeGreaterThan(0);
    for (const id of owed) expect(bracketFinish.rows, `${id} is owed but not cited (unanswered)`).toContain(id);
    // the filter's own witness: a later wave's unrelated row is not owed; a new KO or bracket row is
    const row = (id: string) => ({ id });
    expect(owedRows([...ROWS, row("TN-SC-9")])).toEqual(owed);
    expect(owedRows([...ROWS, row("ZZ-KO-9"), row("X-BR-9")])).toEqual([...owed, "X-BR-9", "ZZ-KO-9"].sort());
  });
});

describe("bracket-finish, swept over the registry (X-BR-2 and each sport's own KO row)", () => {
  it("X-BR-1 level kinds: the family's level kinds are exactly X-BR-1's (draw, tie, no_result as the row names them)", () => {
    expect(LEVEL_KINDS_FROM_ROWS.length).toBeGreaterThan(0);
    expect(new Set(LEVEL_KINDS).size).toBe(LEVEL_KINDS.length);
    expect([...LEVEL_KINDS].sort()).toEqual([...LEVEL_KINDS_FROM_ROWS].sort());
  });

  it("X-BR-2 / BG-KO-1 / CA-KO-1 / GN-KO-1 / CK-KO-1: every X-BR-1 level kind, in every bracket kind, for every registered sport, answers by the sport's KO row that names that kind, or else X-BR-2", () => {
    // every KO row in the directory is classified, and every classification names a real row
    const koRows = ROWS.filter((r) => KO_ROW.test(r.id)).map((r) => r.id).sort();
    expect(koRows.length).toBeGreaterThan(0);
    expect(Object.keys(LEVEL_PLAY_BY_KO_ROW).sort()).toEqual(koRows);
    const reached = new Map<string, number>();
    const perKind = new Map<string, number>();
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      for (const as of LEVEL_KINDS_FROM_ROWS) {
        const { id, want, naming } = levelAnswer(key, as);
        expect(naming, `${key} ${as}: two of its rows answer it`).toBeLessThanOrEqual(1);
        for (const stageKind of bracketFinish.stageKinds) {
          const c: BracketCase = { stageKind, sport: key, play: { kind: "level", as }, actions: [], hasLoserLine: true };
          if (want === "ruled-out") expect(() => expectBracketFinish(c), `${key} ${as} ${stageKind}`).toThrow(new RegExp(id));
          else expect(expectBracketFinish(c), `${key} ${as} ${stageKind}`).toEqual(want);
          judged++;
          perKind.set(as, (perKind.get(as) ?? 0) + 1);
        }
        reached.set(`${id} ${as}`, (reached.get(`${id} ${as}`) ?? 0) + 1);
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBe(sports * LEVEL_KINDS_FROM_ROWS.length * bracketFinish.stageKinds.length);
    for (const as of LEVEL_KINDS_FROM_ROWS) expect(perKind.get(as) ?? 0, as).toBe(sports * bracketFinish.stageKinds.length);
    // every (row, level kind) answer was reached by a registered sport, and so was X-BR-2 for every level kind (no row,
    // and no level kind of a row, is dead text)
    const answers = Object.entries(LEVEL_PLAY_BY_KO_ROW).flatMap(([id, byKind]) => Object.keys(byKind ?? {}).map((as) => `${id} ${as}`));
    expect(answers.length).toBeGreaterThan(0);
    for (const k of [...answers, ...LEVEL_KINDS_FROM_ROWS.map((as) => `X-BR-2 ${as}`)]) expect(reached.get(k) ?? 0, k).toBeGreaterThan(0);
  });

  it("X-ST-1 + controller ruling P2-4: settle after a held level result seats the winner and the loser, EVERY method, for every sport and level kind the rows hold (cricket's tie and no-result included)", () => {
    // Which (sport, level kind) pairs are HELD comes from the rows (the sport's own KO row naming the kind, else
    // X-BR-2), not from the family.
    const cricket = rowById(ROWS, "CK-KO-1").file;
    expect(heldByRows(cricket, "tie")).toBe(true); // CK-KO-1: "a … tie …, or a no-result, is held and closed by settle"
    expect(heldByRows(cricket, "no_result")).toBe(true);
    const METHODS_ = ["lot", "higher_seed", "organiser"] as const;
    let pairs = 0;
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      for (const as of LEVEL_KINDS_FROM_ROWS) {
        if (!heldByRows(key, as)) continue;
        pairs++;
        for (const method of METHODS_) {
          for (const winner of ["home", "away"] as const) {
            const e = expectBracketFinish({ ...base, sport: key, play: { kind: "level", as }, hasLoserLine: true, actions: [{ kind: "settle", winner, method, by: "organiser" }] });
            expect(e, `${key} ${as} ${method} ${winner}`).toEqual({ status: "decided", advances: { winner, loser: winner === "home" ? "away" : "home", method: `settled_${method}` }, refused: [] });
            judged++;
          }
        }
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(pairs).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBe(pairs * METHODS_.length * 2);
  });

  it("GN-KO-1 refuses only a DRAW (ruling 79): a generic tie or no_result is held, and the organiser's settle closes it", () => {
    for (const as of ["tie", "no_result"] as const) {
      // single-sport: GN-KO-1 is generic's row
      expect(expectBracketFinish({ ...base, sport: "generic", play: { kind: "level", as } }), as).toEqual(HELD_BY_X_BR_2);
      expect(expectBracketFinish({ ...base, sport: "generic", play: { kind: "level", as }, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).advances, as).toEqual({ winner: "away", loser: null, method: "settled_lot" });
    }
  });

  it("CA-KO-1: a carrom draw or tie is no bracket result (the extra board decides it); a carrom no_result is no score, so X-BR-2 holds it", () => {
    // single-sport: CA-KO-1 is carrom's row
    for (const as of ["draw", "tie"] as const) expect(() => expectBracketFinish({ ...base, sport: "carrom", play: { kind: "level", as } }), as).toThrow(RULED_OUT["carrom-level"]);
    expect(expectBracketFinish({ ...base, sport: "carrom", play: { kind: "level", as: "no_result" } })).toEqual(HELD_BY_X_BR_2);
  });
});

describe("bracket-finish transitions (TEST-STRATEGY rule 1: second call, empty input, after a void, another sport)", () => {
  const football = (actions: readonly Action[], play: PlayResult = DRAW, hasLoserLine = false): BracketExpect =>
    // single-sport: football has no KO row of its own, so it reads X-BR-2/X-ST-1 alone; the registry sweeps above cover every sport
    expectBracketFinish({ ...base, sport: "football", play, actions, hasLoserLine });
  const settle = (winner: "home" | "away", method: "lot" | "higher_seed" | "organiser" = "lot"): Action => ({ kind: "settle", winner, method, by: "organiser" });

  it("X-ST-1: a void of the settle restores needs_decision, and a second settle after it is accepted (a different winner)", () => {
    expect(football([settle("home"), { kind: "void-last" }])).toEqual({ status: "needs_decision", advances: null, refused: [] });
    expect(football([settle("home"), { kind: "void-last" }, settle("away", "organiser")], DRAW, true)).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: "settled_organiser" }, refused: [] });
  });

  it("X-ST-1 / spec §5.1: each settle method records its own method string", () => {
    for (const method of ["lot", "higher_seed", "organiser"] as const) {
      expect(football([settle("away", method)]).advances, method).toEqual({ winner: "away", loser: null, method: `settled_${method}` });
    }
  });

  it("X-ST-1: settle is refused where nothing is level, abandoned or awaiting a tie-break — nothing played, or a generic draw refused (GN-KO-1)", () => {
    expect(football([settle("home")], { kind: "none" })).toEqual({ status: "scheduled", advances: null, refused: [{ index: 0, code: "SETTLE_NOT_APPLICABLE" }] });
    // single-sport: GN-KO-1 is generic's row
    expect(expectBracketFinish({ ...base, sport: "generic", actions: [settle("home")] }).refused).toEqual([{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }, { index: 0, code: "SETTLE_NOT_APPLICABLE" }]);
    // …and the refused draw left nothing behind: an abandon, then a settle, closes it
    // single-sport: GN-KO-1 is generic's row
    expect(expectBracketFinish({ ...base, sport: "generic", hasLoserLine: true, actions: [{ kind: "abandon" }, settle("home")] })).toEqual({ status: "decided", advances: { winner: "home", loser: "away", method: "settled_lot" }, refused: [{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }] });
  });

  it("spec §5.4.2: an abandon outranks a held level result (abandoned), and a settle outranks the abandon (decided); a void of the abandon restores needs_decision", () => {
    expect(football([{ kind: "abandon" }])).toEqual({ status: "abandoned", advances: null, refused: [] });
    expect(football([{ kind: "abandon" }, settle("away")], DRAW, true)).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: "settled_lot" }, refused: [] });
    expect(football([{ kind: "abandon" }, { kind: "void-last" }])).toEqual({ status: "needs_decision", advances: null, refused: [] });
  });

  it("X-ST-1: an abandon before any result, then settle, seats both sides; with no loser line only the winner", () => {
    for (const hasLoserLine of [true, false]) {
      expect(football([{ kind: "abandon" }, settle("away", "higher_seed")], { kind: "none" }, hasLoserLine).advances, String(hasLoserLine)).toEqual({ winner: "away", loser: hasLoserLine ? "home" : null, method: "settled_higher_seed" });
    }
  });

  it("X-BR-1: a win from play is decided and seats both sides on a loser line — the loser is the OTHER side", () => {
    for (const winner of ["home", "away"] as const) {
      expect(football([], { kind: "win", winner }, true), winner).toEqual({ status: "decided", advances: { winner, loser: winner === "home" ? "away" : "home", method: "play" }, refused: [] });
      expect(football([], { kind: "win", winner }, false).advances, winner).toEqual({ winner, loser: null, method: "play" });
    }
  });

  it("spec §5.4.3: finalize of a decided fixture is finalized and keeps who advances; of a held level result it is refused, abandoned or not", () => {
    expect(football([{ kind: "finalize" }], { kind: "win", winner: "away" })).toEqual({ status: "finalized", advances: { winner: "away", loser: null, method: "play" }, refused: [] });
    expect(football([settle("home"), { kind: "finalize" }])).toEqual({ status: "finalized", advances: { winner: "home", loser: null, method: "settled_lot" }, refused: [] });
    expect(football([{ kind: "abandon" }, { kind: "finalize" }])).toEqual({ status: "abandoned", advances: null, refused: [{ index: 1, code: "LEVEL_RESULT_IN_BRACKET" }] });
    // a refused finalize leaves it settleable
    expect(football([{ kind: "finalize" }, settle("away")]).status).toBe("decided");
  });

  it("spec §5.4.3 as amended (controller ruling P2-7): finalize is refused LEVEL_RESULT_IN_BRACKET whenever settle applies — an abandon with no outcome, a chess game awaiting its tie-break, abandoned or not — and accepted once settled", () => {
    expect(football([{ kind: "abandon" }, { kind: "finalize" }], { kind: "none" })).toEqual({ status: "abandoned", advances: null, refused: [{ index: 1, code: "LEVEL_RESULT_IN_BRACKET" }] });
    // single-sport: BG-KO-1 is chess's row (boardgame)
    expect(expectBracketFinish({ ...base, actions: [{ kind: "finalize" }] })).toEqual({ status: "in_play", advances: null, refused: [{ index: 0, code: "LEVEL_RESULT_IN_BRACKET" }] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "abandon" }, { kind: "finalize" }] })).toEqual({ status: "abandoned", advances: null, refused: [{ index: 1, code: "LEVEL_RESULT_IN_BRACKET" }] });
    // single-sport: GN-KO-1 is generic's row — the refused draw wrote nothing, so only the abandon makes settle apply
    expect(expectBracketFinish({ ...base, sport: "generic", actions: [{ kind: "abandon" }, { kind: "finalize" }] }).refused).toEqual([{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }, { index: 1, code: "LEVEL_RESULT_IN_BRACKET" }]);
    // the positive pair: settled first, the same finalize is accepted
    expect(football([{ kind: "abandon" }, settle("away"), { kind: "finalize" }], { kind: "none" })).toEqual({ status: "finalized", advances: { winner: "away", loser: null, method: "settled_lot" }, refused: [] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "blitz", winner: "away" }, { kind: "finalize" }] })).toEqual({ status: "finalized", advances: { winner: "away", loser: null, method: "tiebreak_blitz" }, refused: [] });
  });

  it("BG-KO-1 + controller ruling P2-5: while a chess tie-break is pending, EVERY settle method is accepted (lots is not the only one)", () => {
    for (const method of ["lot", "higher_seed", "organiser"] as const) {
      // single-sport: BG-KO-1 is chess's row (boardgame)
      expect(expectBracketFinish({ ...base, hasLoserLine: true, actions: [{ kind: "settle", winner: "away", method, by: "organiser" }] }), method).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: `settled_${method}` }, refused: [] });
    }
  });

  it("BG-KO-1 + controller ruling P2-6: a tie-break after a settle or after an abandon is refused TIEBREAK_NOT_APPLICABLE, and changes nothing", () => {
    const tb: Action = { kind: "tiebreak", rung: "armageddon", winner: "home" };
    // single-sport: BG-KO-1 is chess's row (boardgame)
    expect(expectBracketFinish({ ...base, actions: [{ kind: "abandon" }, tb] })).toEqual({ status: "abandoned", advances: null, refused: [{ index: 1, code: "TIEBREAK_NOT_APPLICABLE" }] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }, tb] })).toEqual({ status: "decided", advances: { winner: "away", loser: null, method: "settled_lot" }, refused: [{ index: 1, code: "TIEBREAK_NOT_APPLICABLE" }] });
    // a void of the abandon reopens the phase: the same tie-break is then accepted
    expect(expectBracketFinish({ ...base, actions: [{ kind: "abandon" }, { kind: "void-last" }, tb] }).advances).toEqual({ winner: "home", loser: null, method: "tiebreak_armageddon" });
  });

  it("BG-KO-1: a tie-break outside the tie-break phase is refused TIEBREAK_NOT_APPLICABLE — nothing played, a win from play, a second tie-break", () => {
    const tb: Action = { kind: "tiebreak", rung: "blitz", winner: "away" };
    // single-sport: BG-KO-1 is chess's row (boardgame)
    expect(expectBracketFinish({ ...base, play: { kind: "none" }, actions: [tb] })).toEqual({ status: "scheduled", advances: null, refused: [{ index: 0, code: "TIEBREAK_NOT_APPLICABLE" }] });
    expect(expectBracketFinish({ ...base, play: { kind: "win", winner: "home" }, actions: [tb] })).toEqual({ status: "decided", advances: { winner: "home", loser: null, method: "play" }, refused: [{ index: 0, code: "TIEBREAK_NOT_APPLICABLE" }] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "rapid", winner: "home" }, tb] })).toEqual({ status: "decided", advances: { winner: "home", loser: null, method: "tiebreak_rapid" }, refused: [{ index: 1, code: "TIEBREAK_NOT_APPLICABLE" }] });
  });

  it("BG-DW-1 (retires controller ruling T15-R1's hold): a chess double forfeit is a double walkover, not a drawn game — forfeited, nobody seated, a tie-break and a settle on it refused, finalize closes it", () => {
    // single-sport: BG-DW-1 is chess's row (boardgame); the W2b sweep below holds it in every bracket kind
    const dw: BracketCase = { ...base, play: { kind: "double_walkover" }, hasLoserLine: true };
    expect(expectBracketFinish(dw)).toEqual({ status: "forfeited", advances: null, refused: [] });
    let rungs = 0;
    for (const rung of ["rapid", "blitz", "armageddon"] as const) {
      expect(expectBracketFinish({ ...dw, actions: [{ kind: "tiebreak", rung, winner: "home" }] }), rung).toEqual({ status: "forfeited", advances: null, refused: [{ index: 0, code: "TIEBREAK_NOT_APPLICABLE" }] });
      // the positive pair: the same tie-break on a DRAWN game decides it
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung, winner: "home" }] }).advances, rung).toEqual({ winner: "home", loser: null, method: `tiebreak_${rung}` });
      rungs++;
    }
    expect(rungs).toBe(3);
    for (const method of ["lot", "higher_seed", "organiser"] as const) {
      expect(expectBracketFinish({ ...dw, actions: [{ kind: "settle", winner: "away", method, by: "organiser" }] }), method).toEqual({ status: "forfeited", advances: null, refused: [{ index: 0, code: "SETTLE_NOT_APPLICABLE" }] });
    }
    expect(expectBracketFinish({ ...dw, actions: [{ kind: "finalize" }] })).toEqual({ status: "finalized", advances: null, refused: [] });
    // a chess no_result from anywhere else is still a level result X-BR-2 holds (no row sends it elsewhere)
    expect(expectBracketFinish({ ...base, play: { kind: "level", as: "no_result" } })).toEqual({ status: "needs_decision", advances: null, refused: [] });
  });

  it("BG-KO-1: only a DRAWN chess game goes to a tie-break — a chess level result of every other X-BR-1 kind is held by X-BR-2 and its tie-break is refused TIEBREAK_NOT_APPLICABLE, every rung", () => {
    // single-sport: BG-KO-1 is chess's row ("a drawn chess game goes to a tie-break"); the other level kinds are X-BR-1's
    const others = LEVEL_KINDS_FROM_ROWS.filter((as) => as !== DRAWN);
    expect(others.length, "X-BR-1 names level kinds besides a draw").toBeGreaterThan(0);
    let checked = 0;
    for (const as of others) {
      // the row that answers a chess `as` is X-BR-2 (BG-KO-1 names only a draw), so the hold is read from the rows
      expect(levelAnswer(CHESS, as), as).toEqual({ id: "X-BR-2", want: HELD_BY_X_BR_2, naming: 0 });
      for (const rung of ["rapid", "blitz", "armageddon"] as const) {
        const tb: Action = { kind: "tiebreak", rung, winner: "home" };
        expect(expectBracketFinish({ ...base, sport: CHESS, play: { kind: "level", as }, actions: [tb] }), `${as} ${rung}`).toEqual({ ...HELD_BY_X_BR_2, refused: [{ index: 0, code: "TIEBREAK_NOT_APPLICABLE" }] });
        // the positive pair: the same tie-break on a DRAWN game decides it
        expect(expectBracketFinish({ ...base, sport: CHESS, actions: [tb] }).advances, `draw ${rung}`).toEqual({ winner: "home", loser: null, method: `tiebreak_${rung}` });
        checked++;
      }
    }
    expect(checked, `non-draw chess level kinds × rungs checked: ${checked}`).toBe(others.length * 3);
  });

  it("BG-KO-1: a void of the tie-break puts the game back in its tie-break phase — then the organiser's lot, or a new tie-break, decides it", () => {
    const tb: Action = { kind: "tiebreak", rung: "rapid", winner: "home" };
    // single-sport: BG-KO-1 is chess's row (boardgame)
    expect(expectBracketFinish({ ...base, actions: [tb, { kind: "void-last" }] })).toEqual({ status: "in_play", advances: null, refused: [] });
    expect(expectBracketFinish({ ...base, hasLoserLine: true, actions: [tb, { kind: "void-last" }, { kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).advances).toEqual({ winner: "away", loser: "home", method: "settled_lot" });
    expect(expectBracketFinish({ ...base, actions: [tb, { kind: "void-last" }, { kind: "tiebreak", rung: "blitz", winner: "away" }] }).advances).toEqual({ winner: "away", loser: null, method: "tiebreak_blitz" });
  });

  it("BG-KO-1 + X-ST-1: an abandon during the tie-break phase is abandoned, and the abandon clause lets any method settle it", () => {
    // single-sport: BG-KO-1 is chess's row (boardgame)
    expect(expectBracketFinish({ ...base, actions: [{ kind: "abandon" }] })).toEqual({ status: "abandoned", advances: null, refused: [] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }] }).advances).toEqual({ winner: "home", loser: null, method: "settled_organiser" });
  });

  it("CK-KO-1: lot also closes a held cricket knockout tie", () => {
    // single-sport: CK-KO-1 is cricket's row
    expect(expectBracketFinish({ ...base, sport: "cricket", play: { kind: "level", as: "tie" }, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).advances).toEqual({ winner: "away", loser: null, method: "settled_lot" });
  });

  it("X-ST-2: a refused settle writes nothing — it leaves no action for a void to undo, and the organiser's settle after it is accepted", () => {
    expect(football([{ kind: "settle", winner: "home", method: "lot", by: "scorer" }, settle("away")])).toEqual({ status: "decided", advances: { winner: "away", loser: null, method: "settled_lot" }, refused: [{ index: 0, code: "FORBIDDEN" }] });
    expect(() => football([{ kind: "settle", winner: "home", method: "lot", by: "device" }, { kind: "void-last" }])).toThrow(OUT_OF_SCOPE["void-nothing"]);
  });

  it("the family's expect(case) answers one case — what a consumer calls after requireFamily(kind, sport)", () => {
    expect(bracketFinish.expect({ ...base, sport: "football" })).toEqual(HELD_BY_X_BR_2);
    expect(bracketFinish.expect({ ...base, sport: "football", play: { kind: "win", winner: "away" }, hasLoserLine: true }).advances).toEqual({ winner: "away", loser: "home", method: "play" });
  });

  it("a second call answers the same, and expectAll keeps the input order (reversed in, reversed out)", () => {
    const a: BracketCase = { ...base, sport: "football" };
    const b: BracketCase = { ...base, sport: "football", play: { kind: "win", winner: "away" } };
    expect(expectBracketFinish(a)).toEqual(expectBracketFinish(a));
    const ab = bracketFinish.expectAll([a, b]);
    expect(ab.map((e) => e.status)).toEqual(["needs_decision", "decided"]);
    expect(bracketFinish.expectAll([b, a])).toEqual([...ab].reverse());
  });
});

describe("bracket-finish never guesses: OutOfScope names kernel behaviour W2a does not change (controller rulings P2-1/2/3/7/8), RuledOut an input the rows exclude", () => {
  // One case per out-of-scope reason. A reason no case reaches is a dead branch; a case answering is a judgement the
  // controller ruled the family must not make.
  const SCOPE_CASES: Readonly<Record<keyof typeof OUT_OF_SCOPE, BracketCase>> = {
    "after-finalize": { ...base, sport: "football", play: { kind: "win", winner: "home" }, actions: [{ kind: "finalize" }, { kind: "void-last" }] },
    "abandon-decided": { ...base, sport: "football", play: { kind: "win", winner: "home" }, actions: [{ kind: "abandon" }] },
    "abandon-twice": { ...base, sport: "football", actions: [{ kind: "abandon" }, { kind: "abandon" }] },
    "finalize-unplayed": { ...base, sport: "football", play: { kind: "none" }, actions: [{ kind: "finalize" }] },
    "void-nothing": { ...base, sport: "football", actions: [{ kind: "void-last" }] },
    "vacant-title": { ...base, sport: "football", play: { kind: "none" }, hasNextMatch: false, deadSeats: ["home", "away"] },
  };

  it("every OutOfScope reason is reached by its case and names itself; none of them is judged", () => {
    const reasons = Object.keys(OUT_OF_SCOPE) as (keyof typeof OUT_OF_SCOPE)[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(Object.keys(SCOPE_CASES).sort()).toEqual([...reasons].sort());
    let judged = 0;
    for (const r of reasons) {
      let thrown: unknown;
      try { expectBracketFinish(SCOPE_CASES[r]); } catch (e) { thrown = e; }
      expect(thrown, r).toBeInstanceOf(OutOfScope);
      expect((thrown as OutOfScope).reason, r).toBe(r);
      expect((thrown as Error).message, r).toContain(OUT_OF_SCOPE[r]);
      judged++;
    }
    expect(judged).toBe(reasons.length);
  });

  it("each OutOfScope reason cites what put it out of scope (the W2a controller rulings; finalize-unplayed: T15-R4; vacant-title: X-DW-3, W4)", () => {
    const CITES: Readonly<Record<keyof typeof OUT_OF_SCOPE, string>> = { "after-finalize": "controller ruling P2-1)", "abandon-decided": "controller ruling P2-2)", "abandon-twice": "controller ruling P2-3)", "finalize-unplayed": "controller ruling T15-R4)", "void-nothing": "controller ruling P2-8)", "vacant-title": "(X-DW-3: a vacant title is W4)" };
    let cited = 0;
    for (const [r, cite] of Object.entries(CITES) as [keyof typeof OUT_OF_SCOPE, string][]) {
      expect(OUT_OF_SCOPE[r], r).toContain(cite);
      cited++;
    }
    expect(cited).toBe(Object.keys(OUT_OF_SCOPE).length);
  });

  it("controller rulings P2-7 + T15-R4: finalize is out of scope ONLY with nothing to settle — a generic draw refused (GN-KO-1) leaves nothing either", () => {
    // single-sport: GN-KO-1 is generic's row
    expect(() => expectBracketFinish({ ...base, sport: "generic", actions: [{ kind: "finalize" }] })).toThrow(OUT_OF_SCOPE["finalize-unplayed"]);
    // the positive pair: an abandon makes settle apply, so the same finalize is REFUSED instead of out of scope
    expect(expectBracketFinish({ ...base, sport: "football", play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "finalize" }] }).refused).toEqual([{ index: 1, code: "LEVEL_RESULT_IN_BRACKET" }]);
  });

  it("CA-KO-1 / BG-KO-1 / X-BR-1 / BG-DW-1 / X-WD-3: RuledOut names its row — a level carrom bracket match, a tie-break outside chess, a draw kind, a double walkover by play outside chess, a dead seat that played, a dead seat on a ladder", () => {
    const reasons = Object.keys(RULED_OUT);
    expect(reasons.length).toBeGreaterThan(0);
    const cases: Readonly<Record<keyof typeof RULED_OUT, BracketCase>> = {
      "carrom-level": { ...base, sport: "carrom" },
      "tiebreak-not-chess": { ...base, sport: "football", actions: [{ kind: "tiebreak", rung: "rapid", winner: "home" }] },
      "not-bracket": { ...base, stageKind: "league" },
      "double-walkover-play-not-chess": { ...base, sport: "football", play: { kind: "double_walkover" } },
      "dead-seat-played": { ...base, sport: "football", play: { kind: "win", winner: "home" }, deadSeats: ["away"] },
      "ladder-dead-seat": { ...base, sport: "football", stageKind: "ladder", play: { kind: "none" }, deadSeats: ["away"] },
    };
    expect(Object.keys(cases).sort()).toEqual([...reasons].sort());
    for (const r of reasons as (keyof typeof RULED_OUT)[]) {
      let thrown: unknown;
      try { expectBracketFinish(cases[r]); } catch (e) { thrown = e; }
      expect(thrown, r).toBeInstanceOf(RuledOut);
      expect((thrown as RuledOut).reason, r).toBe(r);
      expect((thrown as Error).message, r).toContain(RULED_OUT[r]);
    }
    // a tie-break outside chess is refused whatever else the case holds — every non-chess sport, the input itself
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      if (key === CHESS) return;
      expect(() => expectBracketFinish({ ...base, sport: key, play: { kind: "none" }, actions: [{ kind: "tiebreak", rung: "blitz", winner: "away" }] }), key).toThrow(RULED_OUT["tiebreak-not-chess"]);
      judged++;
    });
    expect(sports).toBeGreaterThan(0);
    expect(judged).toBeGreaterThan(0);
  });
});

// ── Rule 10: every action sequence, invariants after every step ──────────────────────────────────────────────────
// Bounded-EXHAUSTIVE rather than fast-check: packages/reference does not declare fast-check, and adding it changes the
// root lockfile outside lane P2. Every sequence up to DEPTH over ALPHABET is walked (a superset of what a random
// sampler draws at those lengths), and the first failure in walk order is already a shortest one.

/** Nothing played, a win either way, and every X-BR-1 level kind (read from the row). */
const PLAYS: readonly PlayResult[] = [{ kind: "none" }, { kind: "win", winner: "home" }, { kind: "win", winner: "away" }, ...LEVEL_KINDS_FROM_ROWS.map((as): PlayResult => ({ kind: "level", as }))];
const ALPHABET: readonly Action[] = [
  { kind: "abandon" },
  { kind: "settle", winner: "home", method: "lot", by: "organiser" },
  { kind: "settle", winner: "away", method: "higher_seed", by: "organiser" },
  { kind: "settle", winner: "away", method: "organiser", by: "organiser" },
  { kind: "settle", winner: "home", method: "lot", by: "scorer" },
  { kind: "settle", winner: "away", method: "organiser", by: "device" },
  { kind: "tiebreak", rung: "rapid", winner: "home" },
  { kind: "tiebreak", rung: "blitz", winner: "away" },
  { kind: "tiebreak", rung: "armageddon", winner: "away" },
  { kind: "void-last" },
  { kind: "finalize" },
];
const DEPTH = 4;
const SPORT_COUNT = forEachSport(() => undefined);
const NODES_PER_ROOT = Array.from({ length: DEPTH + 1 }, (_, k) => ALPHABET.length ** k).reduce((a, b) => a + b, 0);
const MAX_NODES = SPORT_COUNT * PLAYS.length * 2 * NODES_PER_ROOT;
const PER_NODE_MS = 0.02;
const SWEEP_BUDGET_MS = Math.max(5_000, MAX_NODES * PER_NODE_MS * 5);

/** Spec §7's refusal codes, plus the existing code the server returns to a scorer (X-ST-2). */
const CODES = ["LEVEL_RESULT_IN_BRACKET", "SETTLE_NOT_APPLICABLE", "TIEBREAK_NOT_APPLICABLE", "FORBIDDEN"] as const;
/** X-BR-1's sources of a win, as spec §5.1/§5.2 name their methods; "play" is the oracle's label for a win from play. */
const METHODS = new Set(["play", "tiebreak_rapid", "tiebreak_blitz", "tiebreak_armageddon", "settled_lot", "settled_higher_seed", "settled_organiser"]);
const STATUSES = ["scheduled", "in_play", "decided", "needs_decision", "abandoned", "finalized"] as const;

type Snap = Pick<BracketExpect, "status" | "advances">;
const snap = (e: BracketExpect): Snap => ({ status: e.status, advances: e.advances });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Tally { nodes: number; failures: number; first: string[]; statuses: Set<string>; codes: Set<string>; outOfScope: Set<string>; ruledOut: Set<string>; sticky: number; voids: number; noops: number; settles: number; tiebreaks: number; finalizes: number }

/** Settle applies (X-ST-1: a level outcome, an abandon with no outcome, a chess game awaiting its tie-break), read
 *  off the fixture's OBSERVABLE status by spec §5.4.2's order — never from the family's own predicate. */
const SETTLEABLE: ReadonlySet<string> = new Set(["needs_decision", "abandoned", "in_play"]);

/** Which unanswered outcome a step may have, from the parent's observable state alone: an OutOfScope reason (controller
 *  rulings P2-1/2/3/7/8), a RuledOut reason, or null (the step must be answered). */
function allowedThrow(a: Action, parent: BracketExpect, standing: readonly Snap[], sport: string): readonly string[] | null {
  if (a.kind === "tiebreak" && sport !== CHESS) return ["tiebreak-not-chess"]; // BG-KO-1: an input the rows exclude
  if (parent.status === "finalized") return ["after-finalize"]; // P2-1
  if (a.kind === "abandon" && (parent.status === "abandoned" || parent.status === "decided")) return ["abandon-twice", "abandon-decided"]; // P2-2, P2-3
  if (a.kind === "void-last" && standing.length === 0) return ["void-nothing"]; // P2-8
  if (a.kind === "finalize" && parent.status === "scheduled") return ["finalize-unplayed"]; // P2-7: nothing to settle
  return null;
}

function fail(t: Tally, c: BracketCase, why: string): void {
  t.failures++;
  if (t.first.length < 10) t.first.push(`${c.sport} ${JSON.stringify(c.play)} loser=${c.hasLoserLine} ${JSON.stringify(c.actions)}: ${why}`);
}

/** Each node is ONE call of the API under test; the invariants compare it with its parent (the same sequence less
 *  its last action) and with a stack of the snapshots before each standing action (void semantics, spec §5.1). */
function walk(c: BracketCase, parent: BracketExpect, standing: readonly Snap[], t: Tally): void {
  if (c.actions.length === DEPTH) return;
  for (const a of ALPHABET) {
    const next: BracketCase = { ...c, actions: [...c.actions, a] };
    const i = next.actions.length - 1;
    t.nodes++;
    const allowed = allowedThrow(a, parent, standing, next.sport);
    let n: BracketExpect;
    try {
      n = expectBracketFinish(next);
    } catch (e) {
      let reason: string;
      if (e instanceof OutOfScope) { reason = e.reason; t.outOfScope.add(reason); }
      else if (e instanceof RuledOut) { reason = e.reason; t.ruledOut.add(reason); }
      else { fail(t, next, `threw ${String(e)}`); continue; }
      if (allowed === null || !allowed.includes(reason)) fail(t, next, `unanswered (${reason}) where the parent (${parent.status}) owes an answer${allowed === null ? "" : ` or one of ${allowed.join("/")}`}`);
      // sticky: once unanswered, every extension is unanswered (a left fold cannot recover an answer)
      try { expectBracketFinish({ ...next, actions: [...next.actions, { kind: "abandon" }] }); fail(t, next, "an extension answered"); } catch (e2) { if ((e2 as Error).constructor === (e as Error).constructor) t.sticky++; else fail(t, next, "an extension threw a different error"); }
      continue;
    }
    if (allowed !== null) fail(t, next, `answered where it should be unanswered (${allowed.join("/")})`);
    if (!same(expectBracketFinish(next), n)) fail(t, next, "a second call answered differently");
    // the refusals are a left fold: the parent's list is a prefix, and at most one entry is new — this action's
    if (!same(n.refused.slice(0, parent.refused.length), parent.refused)) fail(t, next, "the refusals are not the parent's plus this step's");
    const added = n.refused.length - parent.refused.length;
    if (added < 0 || added > 1) fail(t, next, `refusals grew by ${added}`);
    let nextStanding = standing;
    if (added === 1) {
      const r = n.refused[n.refused.length - 1];
      if (r?.index !== i) fail(t, next, `the new refusal is at ${r?.index}, not ${i}`);
      if (r !== undefined && !(CODES as readonly string[]).includes(r.code)) fail(t, next, `refusal code ${r.code} is not spec §7's`);
      if (r !== undefined) t.codes.add(r.code);
      if (!same(snap(n), snap(parent))) fail(t, next, "a refused action changed the fixture (a refusal writes nothing)");
      if (a.kind === "void-last") fail(t, next, "a void was refused");
      t.noops++;
    } else if (a.kind === "void-last") {
      const top = standing[standing.length - 1];
      if (top === undefined || !same(snap(n), top)) fail(t, next, "a void did not restore the state before the action it undid");
      nextStanding = standing.slice(0, -1);
      t.voids++;
    } else {
      nextStanding = [...standing, snap(parent)];
    }
    const code = added === 1 ? n.refused[n.refused.length - 1]?.code : undefined;
    // X-ST-2: every non-organiser settle is refused FORBIDDEN
    if (a.kind === "settle" && a.by !== "organiser" && code !== "FORBIDDEN") fail(t, next, "a non-organiser settle was not refused FORBIDDEN");
    // X-ST-1 + P2-4/P2-5: an organiser's settle, ANY method, is accepted iff settle applies; it decides by that method
    if (a.kind === "settle" && a.by === "organiser") {
      t.settles++;
      if (SETTLEABLE.has(parent.status)) {
        if (code !== undefined || n.status !== "decided" || n.advances?.winner !== a.winner || n.advances.method !== `settled_${a.method}`) fail(t, next, `a settle on ${parent.status} did not decide by settled_${a.method}`);
      } else if (code !== "SETTLE_NOT_APPLICABLE") fail(t, next, `a settle on ${parent.status} was not refused SETTLE_NOT_APPLICABLE`);
    }
    // BG-KO-1 + P2-6: a tie-break is accepted only while the drawn game awaits it (in_play), never after an abandon or a settle
    if (a.kind === "tiebreak") {
      t.tiebreaks++;
      if (parent.status === "in_play") {
        if (code !== undefined || n.status !== "decided" || n.advances?.winner !== a.winner || n.advances.method !== `tiebreak_${a.rung}`) fail(t, next, "a pending tie-break did not decide by its rung");
      } else if (code !== "TIEBREAK_NOT_APPLICABLE") fail(t, next, `a tie-break on ${parent.status} was not refused TIEBREAK_NOT_APPLICABLE`);
    }
    // §5.4.3 + P2-7: finalize is refused LEVEL_RESULT_IN_BRACKET whenever settle applies; a decided fixture finalizes
    if (a.kind === "finalize") {
      t.finalizes++;
      if (SETTLEABLE.has(parent.status) && code !== "LEVEL_RESULT_IN_BRACKET") fail(t, next, `a finalize on ${parent.status} was not refused LEVEL_RESULT_IN_BRACKET`);
      if (parent.status === "decided" && n.status !== "finalized") fail(t, next, "a finalize of a decided fixture did not finalize it");
    }
    if (a.kind === "abandon" && n.status !== "abandoned") fail(t, next, `an accepted abandon left ${n.status}`);
    // X-BR-1 / X-BR-2: somebody advances iff the fixture is decided (or finalized) — never from a level result
    const decided = n.status === "decided" || n.status === "finalized";
    if (decided !== (n.advances !== null)) fail(t, next, `status ${n.status} with advances ${JSON.stringify(n.advances)}`);
    if (n.advances !== null) {
      if (!METHODS.has(n.advances.method)) fail(t, next, `method ${n.advances.method} is not a win's`);
      // X-ST-1: winner AND loser are seated, where the bracket has a loser line
      const loser = next.hasLoserLine ? (n.advances.winner === "home" ? "away" : "home") : null;
      if (n.advances.loser !== loser) fail(t, next, `loser ${n.advances.loser}, expected ${loser}`);
    }
    if (n.status === "needs_decision" && next.play.kind !== "level") fail(t, next, "needs_decision without a level play result");
    if (n.status === "in_play" && !(next.sport === CHESS && next.play.kind === "level" && next.play.as === DRAWN)) fail(t, next, "in_play outside a drawn game awaiting its tie-break");
    if (n.status === "needs_decision" && next.sport === CHESS && next.play.kind === "level" && next.play.as === DRAWN) fail(t, next, "a drawn chess game held instead of awaiting its tie-break (BG-KO-1)");
    if (n.status === "finalized" && !(a.kind === "finalize" && parent.status === "decided" && same(n.advances, parent.advances))) fail(t, next, "finalized other than by finalizing a decided fixture");
    if (n.status === "scheduled" && nextStanding.length > 0) fail(t, next, "scheduled with a standing action");
    t.statuses.add(n.status);
    walk(next, n, nextStanding, t);
  }
}

describe("bracket-finish, rule 10: every sequence up to DEPTH actions, every registered sport, every play, with and without a loser line", () => {
  it(`invariants after every step (X-BR-1, X-BR-2, X-ST-1, X-ST-2, BG-KO-1, spec §5.1 void, §5.4.2 order, §5.4.3, §7 codes, controller rulings P2-1..P2-8 and T15-R1) — at most ${MAX_NODES} nodes`, () => {
    const t: Tally = { nodes: 0, failures: 0, first: [], statuses: new Set(), codes: new Set(), outOfScope: new Set(), ruledOut: new Set(), sticky: 0, voids: 0, noops: 0, settles: 0, tiebreaks: 0, finalizes: 0 };
    let roots = 0;
    const rootRuledOut: string[] = [];
    const sports = forEachSport(({ key }) => {
      for (const play of PLAYS) {
        for (const hasLoserLine of [false, true]) {
          const root: BracketCase = { stageKind: "knockout", sport: key, play, actions: [], hasLoserLine };
          roots++;
          t.nodes++;
          let e: BracketExpect;
          try { e = expectBracketFinish(root); } catch (err) {
            if (err instanceof RuledOut) { t.ruledOut.add(err.reason); rootRuledOut.push(`${key} ${play.kind === "level" ? play.as : play.kind} ${hasLoserLine} ${err.reason}`); continue; }
            throw err;
          }
          t.statuses.add(e.status);
          for (const r of e.refused) t.codes.add(r.code);
          walk(root, e, [], t);
        }
      }
    });
    expect(t.first, `${t.failures} invariant failure(s)`).toEqual([]);
    expect(t.failures).toBe(0);
    // anti-vacuity: the walk reached every status, every code, every out-of-scope reason and every exclusion it can
    expect(sports).toBe(SPORT_COUNT);
    expect(roots).toBe(SPORT_COUNT * PLAYS.length * 2);
    expect(t.nodes).toBeGreaterThan(roots);
    expect(t.nodes).toBeLessThanOrEqual(MAX_NODES);
    expect([...t.statuses].sort()).toEqual([...STATUSES].sort());
    expect([...t.codes].sort()).toEqual([...CODES].sort());
    // every W2a out-of-scope reason; vacant-title needs two dead seats, which this walk never roots (the W2b walk does)
    expect([...t.outOfScope].sort()).toEqual(["abandon-decided", "abandon-twice", "after-finalize", "finalize-unplayed", "void-nothing"]);
    expect([...t.ruledOut].sort()).toEqual(["carrom-level", "tiebreak-not-chess"]); // not-bracket: the walk stays in knockout; the scope tests sweep it
    // m2: the ROOTS the rows exclude are exactly the (sport, level kind) pairs a KO row rules out, with and without a
    // loser line — read from the rows table, never from the family — and nothing else
    const wantRootRuledOut: string[] = [];
    forEachSport(({ key }) => {
      for (const as of LEVEL_KINDS_FROM_ROWS) {
        if (levelAnswer(key, as).want === "ruled-out") for (const l of [false, true]) wantRootRuledOut.push(`${key} ${as} ${l} carrom-level`);
      }
    });
    expect(wantRootRuledOut.length).toBe(4); // carrom × {draw, tie} × {no loser line, a loser line} (CA-KO-1)
    expect([...rootRuledOut].sort()).toEqual([...wantRootRuledOut].sort());
    expect(t.sticky).toBeGreaterThan(0);
    expect(t.voids).toBeGreaterThan(0);
    expect(t.noops).toBeGreaterThan(0);
    expect(t.settles).toBeGreaterThan(0);
    expect(t.tiebreaks).toBeGreaterThan(0);
    expect(t.finalizes).toBeGreaterThan(0);
  }, SWEEP_BUDGET_MS);
});

// ══ W2b: forfeits, the double walkover and dead seats ═══════════════════════════════════════════════════════════════
// Appendix A (X-RS-1, X-RS-3, X-DW-1..3, X-AB-4, X-WD-1..5, X-DE-1, BG-DW-1, BG-WO-2, BG-WO-3, X-BR-1 as amended), spec
// §5.3 / §5.4 / §7, and the plan's D3 (phase guard), D4 (abandon guard), D19 (no next match, a server pre-fold guard),
// PF-1 (a withdrawal over a held result) and PF-2 (withdrew is the cascade's alone). Every expected value is typed here.

const NONE: PlayResult = { kind: "none" };
const LIVE: PlayResult = { kind: "in_progress" };
/** Ruling 112: the Start pressed, nothing played. */
const STARTED: PlayResult = { kind: "started" };
const fo = (offender: Side | "both", reason: (typeof FORFEIT_REASONS)[number], by: "organiser" | "scorer" | "device" | "cascade" = "organiser"): Action => ({ kind: "forfeit", offender, reason, by });
const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
const forfeitWin = (winner: Side, method: string): BracketExpect => ({ status: "forfeited", advances: { winner, loser: null, method } as BracketExpect["advances"], refused: [] });
const DOUBLE: BracketExpect = { status: "forfeited", advances: null, refused: [] };
const refusedAt = (e: BracketExpect, index: number): RefusalCode | undefined => e.refused.find((r) => r.index === index)?.code;
/** Each sport's first-forfeit-ready case: carrom cannot be level and generic refuses a draw, so "held" uses no_result. */
const HELD: PlayResult = { kind: "level", as: "no_result" };

describe("bracket-finish W2b: the empty case first", () => {
  it("empty case first: an empty deadSeats list is no dead seat, and nothing written is the W2a answer (scheduled, nobody seated) — with or without a next match", () => {
    for (const hasNextMatch of [true, false]) {
      expect(expectBracketFinish({ ...base, play: NONE, deadSeats: [], hasNextMatch }), String(hasNextMatch)).toEqual({ status: "scheduled", advances: null, refused: [] });
    }
    // a match under way with nothing decided is in play — and so is one whose Start was pressed with nothing played
    expect(expectBracketFinish({ ...base, sport: "football", play: LIVE })).toEqual({ status: "in_play", advances: null, refused: [] });
    expect(expectBracketFinish({ ...base, sport: "football", play: STARTED })).toEqual({ status: "in_play", advances: null, refused: [] });
  });
});

describe("bracket-finish W2b: a forfeit decides by walkover, and its loser is never seated", () => {
  it("X-DE-1: in double elimination any forfeit loser (walkover, withdrew, disqualified, retired) is out — never seated on the losers' bracket edge — and its losers'-bracket opponent advances by walkover; every sport", () => {
    const cases: [PlayResult, Action][] = [
      [NONE, fo("away", "walkover")],
      [NONE, fo("away", "withdrew", "cascade")],
      [LIVE, fo("away", "disqualified")],
      [LIVE, fo("away", "retired")],
    ];
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const [play, a] of cases) {
        const reason = a.kind === "forfeit" ? a.reason : "";
        const wb = expectBracketFinish({ stageKind: "double_elim", sport: key, play, actions: [a], hasLoserLine: true });
        expect(wb, `${key} ${reason}`).toEqual(forfeitWin("home", reason));
        // the losers'-bracket fixture the loser edge feeds: that seat is dead, so its opponent walks over
        const lb = expectBracketFinish({ stageKind: "double_elim", sport: key, play: NONE, actions: [], hasLoserLine: false, deadSeats: wb.advances?.loser === null ? ["home"] : [] });
        expect(lb, `${key} ${reason} losers' bracket`).toEqual(forfeitWin("away", "walkover"));
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(44);
    // the positive pair: a loss from PLAY drops to the losers' bracket
    expect(expectBracketFinish({ stageKind: "double_elim", sport: "football", play: { kind: "win", winner: "home" }, actions: [], hasLoserLine: true }).advances).toEqual({ winner: "home", loser: "away", method: "play" });
  });

  it("X-WD-5: a withdrawn entrant is never seated on a loser edge — a held fixture with a loser line walked over by withdrawal seats the remaining side only", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const stageKind of ["knockout", "double_elim", "page_playoff"] as const) {
        expect(expectBracketFinish({ stageKind, sport: key, play: HELD, actions: [fo("home", "withdrew", "cascade")], hasLoserLine: true }), `${key} ${stageKind}`).toEqual(forfeitWin("away", "withdrew"));
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(33);
  });

  it("X-WD-1 + PF-1: a withdrawal from a held (needs_decision) fixture walks it over to the remaining side, reason withdrew; a walkover, retirement or disqualification over the held result, and a withdrawal once it is settled, stay ALREADY_DECIDED — every held (sport, level kind) the rows hold", () => {
    let pairs = 0;
    const sports = forEachSport(({ key }) => {
      for (const as of LEVEL_KINDS_FROM_ROWS) {
        if (!heldByRows(key, as)) continue;
        const held: BracketCase = { stageKind: "knockout", sport: key, play: { kind: "level", as }, actions: [], hasLoserLine: false };
        expect(expectBracketFinish({ ...held, actions: [fo("away", "withdrew", "cascade")] }), `${key} ${as}`).toEqual(forfeitWin("home", "withdrew"));
        // PF-1: "ONLY when … no settlement is active" — once settled, a withdrawal is ALREADY_DECIDED like any forfeit
        expect(refusedAt(expectBracketFinish({ ...held, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }, fo("away", "withdrew", "cascade")] }), 1), `${key} ${as} settled`).toBe("ALREADY_DECIDED");
        for (const reason of ["walkover", "retired", "disqualified"] as const) {
          expect(expectBracketFinish({ ...held, actions: [fo("away", reason)] }), `${key} ${as} ${reason}`).toEqual({ status: "needs_decision", advances: null, refused: [{ index: 0, code: "ALREADY_DECIDED" }] });
        }
        pairs++;
      }
    });
    expect(sports).toBe(11);
    expect(pairs).toBeGreaterThan(sports); // every sport holds no_result; most hold draw and tie too
  });

  it("X-WD-2: a withdrawal from a page_playoff or ladder fixture walks it over, as knockout does — never a void", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      const ko = expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [fo("home", "withdrew", "cascade")], hasLoserLine: false });
      expect(ko, key).toEqual(forfeitWin("away", "withdrew"));
      for (const stageKind of ["page_playoff", "ladder"] as const) {
        expect(expectBracketFinish({ stageKind, sport: key, play: NONE, actions: [fo("home", "withdrew", "cascade")], hasLoserLine: false }), `${key} ${stageKind}`).toEqual(ko);
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(22);
  });

  it("a forfeit win is final: a settle, a tie-break, a second forfeit and an abandon over it are refused or out of scope; finalize keeps who advanced; a void restores the fixture", () => {
    // single-sport: chess, the one sport where a tie-break is an input at all (BG-KO-1)
    const won: BracketCase = { ...base, play: NONE, actions: [fo("away", "walkover")] };
    const after = (a: Action): BracketExpect => expectBracketFinish({ ...won, actions: [...won.actions, a] });
    expect(after({ kind: "settle", winner: "away", method: "lot", by: "organiser" })).toEqual({ ...forfeitWin("home", "walkover"), refused: [{ index: 1, code: "SETTLE_NOT_APPLICABLE" }] });
    expect(after({ kind: "tiebreak", rung: "rapid", winner: "away" })).toEqual({ ...forfeitWin("home", "walkover"), refused: [{ index: 1, code: "TIEBREAK_NOT_APPLICABLE" }] });
    expect(after(fo("home", "walkover"))).toEqual({ ...forfeitWin("home", "walkover"), refused: [{ index: 1, code: "ALREADY_DECIDED" }] });
    expect(() => after({ kind: "abandon" })).toThrow(OUT_OF_SCOPE["abandon-decided"]);
    expect(after({ kind: "finalize" })).toEqual({ status: "finalized", advances: { winner: "home", loser: null, method: "walkover" }, refused: [] });
    expect(after({ kind: "void-last" })).toEqual({ status: "scheduled", advances: null, refused: [] });
  });
});

describe("bracket-finish W2b: the double walkover (X-DW-1..3, X-WD-4, BG-DW-1, X-BR-1 as amended)", () => {
  it("X-DW-1: a double walkover is its own outcome — both lose, nobody advances (forfeited) — in every bracket kind, with or without a loser line, for every sport (X-DW-2: in double elimination neither side drops to the losers' bracket)", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const stageKind of bracketFinish.stageKinds) {
        for (const hasLoserLine of [false, true]) {
          expect(expectBracketFinish({ stageKind, sport: key, play: NONE, actions: [fo("both", "walkover")], hasLoserLine }), `${key} ${stageKind} ${hasLoserLine}`).toEqual(DOUBLE);
          checked++;
        }
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11 * 5 * 2);
  });

  it("X-DW-2: every seat a double walkover feeds is dead and that seat's opponent advances by walkover — a semi-final double walkover seats nobody, the other semi's winner is champion by walkover, and the third-place match is won by walkover by the other semi's loser", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      // semi 1 feeds the final's home seat (winner edge) and the third-place match's home seat (loser edge)
      const semi1 = expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [fo("both", "walkover")], hasLoserLine: true });
      expect(semi1, `${key} semi 1`).toEqual(DOUBLE);
      const semi2 = expectBracketFinish({ stageKind: "knockout", sport: key, play: { kind: "win", winner: "away" }, actions: [], hasLoserLine: true });
      expect(semi2.advances, `${key} semi 2`).toEqual({ winner: "away", loser: "home", method: "play" });
      // which of the two downstream seats semi 1 left dead: a forfeited fixture that advanced nobody feeds no one
      const deadFromSemi1: Side[] = semi1.status === "forfeited" && semi1.advances === null ? ["home"] : [];
      const final = expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [], hasLoserLine: false, hasNextMatch: false, deadSeats: deadFromSemi1 });
      expect(final, `${key} final`).toEqual(forfeitWin("away", "walkover")); // semi 2's winner is champion by walkover
      const third = expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [], hasLoserLine: false, hasNextMatch: false, deadSeats: deadFromSemi1 });
      expect(third, `${key} third place`).toEqual(forfeitWin("away", "walkover")); // semi 2's loser wins it by walkover
      checked++;
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11);
  });

  it("X-DW-3 (plan D19): a double walkover where the fixture has no next match — a final, a last rung, a third-place match — is refused DOUBLE_WALKOVER_NO_NEXT_MATCH and the fixture stays open; a semi-final, a fixture with a loser line and a ladder challenge accept it", () => {
    let refused = 0;
    let accepted = 0;
    const sports = forEachSport(({ key }) => {
      for (const stageKind of ["knockout", "double_elim", "stepladder", "page_playoff"] as const) {
        const last: BracketCase = { stageKind, sport: key, play: NONE, actions: [fo("both", "walkover")], hasLoserLine: false, hasNextMatch: false };
        expect(expectBracketFinish(last), `${key} ${stageKind} no next match`).toEqual({ status: "scheduled", advances: null, refused: [{ index: 0, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" }] });
        refused++;
        expect(expectBracketFinish({ ...last, hasNextMatch: true }), `${key} ${stageKind} semi`).toEqual(DOUBLE);
        expect(expectBracketFinish({ ...last, hasLoserLine: true }), `${key} ${stageKind} loser line`).toEqual(DOUBLE);
        accepted += 2;
      }
      // D19: a ladder wires no feed edge by design, so a ladder challenge is exempt
      expect(expectBracketFinish({ stageKind: "ladder", sport: key, play: NONE, actions: [fo("both", "walkover")], hasLoserLine: false, hasNextMatch: false }), `${key} ladder`).toEqual(DOUBLE);
      accepted++;
    });
    expect(sports).toBe(11);
    expect(refused).toBe(44);
    expect(accepted).toBe(99);
  });

  it("X-DW-3 (plan D19, a server pre-fold guard): the no-next-match refusal answers before the kernel's — over a held final and over an abandoned one alike; a one-sided walkover on a final is accepted", () => {
    // single-sport: the order is the server's, the same for every sport (football stands for it)
    const finalOf = (play: PlayResult, actions: Action[]): BracketExpect => expectBracketFinish({ stageKind: "knockout", sport: "football", play, actions, hasLoserLine: false, hasNextMatch: false });
    expect(refusedAt(finalOf(DRAW, [fo("both", "walkover")]), 0)).toBe("DOUBLE_WALKOVER_NO_NEXT_MATCH");
    expect(refusedAt(finalOf(NONE, [{ kind: "abandon" }, fo("both", "walkover")]), 1)).toBe("DOUBLE_WALKOVER_NO_NEXT_MATCH");
    expect(finalOf(NONE, [fo("home", "walkover")])).toEqual(forfeitWin("away", "walkover"));
  });

  it("X-WD-4: when both sides of a fixture have withdrawn it is a double walkover — the cascade's two-sided walkover, or two dead seats with a next match; a final stays open (X-DW-3), and two dead seats on a final are a vacant title (W4)", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      expect(expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [fo("both", "walkover", "cascade")], hasLoserLine: false }), key).toEqual(DOUBLE);
      expect(expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [], hasLoserLine: false, deadSeats: ["home", "away"] }), key).toEqual(DOUBLE);
      expect(expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [fo("both", "walkover", "cascade")], hasLoserLine: false, hasNextMatch: false }), key).toEqual({ status: "scheduled", advances: null, refused: [{ index: 0, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" }] });
      expect(() => expectBracketFinish({ stageKind: "knockout", sport: key, play: NONE, actions: [], hasLoserLine: false, hasNextMatch: false, deadSeats: ["home", "away"] }), key).toThrow(OUT_OF_SCOPE["vacant-title"]);
      checked++;
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11);
  });

  it("BG-DW-1: a chess double forfeit folds to the double walkover in every bracket kind — forfeited, nobody advances; a forfeit over it is ALREADY_DECIDED; on a fixture with no next match it is a vacant title (W4); outside chess no play result is a double walkover", () => {
    let checked = 0;
    for (const stageKind of bracketFinish.stageKinds) {
      // single-sport: BG-DW-1 is chess's row (boardgame); the RuledOut sweep below covers every other sport
      expect(expectBracketFinish({ ...base, stageKind, play: { kind: "double_walkover" } }), stageKind).toEqual(DOUBLE);
      expect(expectBracketFinish({ ...base, stageKind, play: { kind: "double_walkover" }, actions: [fo("away", "walkover")] }), stageKind).toEqual({ ...DOUBLE, refused: [{ index: 0, code: "ALREADY_DECIDED" }] });
      checked++;
    }
    expect(checked).toBe(5);
    expect(() => expectBracketFinish({ ...base, play: { kind: "double_walkover" }, hasNextMatch: false })).toThrow(OUT_OF_SCOPE["vacant-title"]);
    let ruledOut = 0;
    const sports = forEachSport(({ key }) => {
      if (key === CHESS) return;
      expect(() => expectBracketFinish({ ...base, sport: key, play: { kind: "double_walkover" } }), key).toThrow(RULED_OUT["double-walkover-play-not-chess"]);
      ruledOut++;
    });
    expect(sports).toBe(11);
    expect(ruledOut).toBe(10);
  });

  it("X-BR-1 (amend): a bracket fixture is decided by a win or a double walkover — a double walkover is never held, never settleable, and finalizes with nobody advancing", () => {
    // single-sport: football has no KO row, so it reads the cross-sport rows alone
    const dw: BracketCase = { ...base, sport: "football", play: NONE, actions: [fo("both", "walkover")] };
    expect(expectBracketFinish(dw).status).toBe("forfeited");
    expect(expectBracketFinish({ ...dw, actions: [...dw.actions, { kind: "settle", winner: "home", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 1, code: "SETTLE_NOT_APPLICABLE" }]);
    expect(expectBracketFinish({ ...dw, actions: [...dw.actions, { kind: "finalize" }] })).toEqual({ status: "finalized", advances: null, refused: [] });
    expect(() => expectBracketFinish({ ...dw, actions: [...dw.actions, { kind: "abandon" }] })).toThrow(OUT_OF_SCOPE["abandon-decided"]);
  });
});

describe("bracket-finish W2b: dead seats (X-WD-3)", () => {
  it("X-WD-3: a withdrawal from a fixture whose opponent is not yet known marks the withdrawn seat dead, so the arriving opponent advances by walkover — every bracket kind but the ladder, either seat, every sport", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const stageKind of ["knockout", "double_elim", "stepladder", "page_playoff"] as const) {
        for (const dead of ["home", "away"] as const) {
          for (const hasLoserLine of [false, true]) {
            expect(expectBracketFinish({ stageKind, sport: key, play: NONE, actions: [], hasLoserLine, deadSeats: [dead] }), `${key} ${stageKind} ${dead} ${hasLoserLine}`).toEqual(forfeitWin(otherSide(dead), "walkover"));
            checked++;
          }
        }
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11 * 4 * 2 * 2);
  });

  it("X-WD-3: the dead seat's walkover is the generator's, not an action — no void undoes it; a settle and a forfeit on it are refused; finalize keeps it", () => {
    // single-sport: the dead seat reads no sport row (football stands for it; the sweep above holds every sport)
    const ds: BracketCase = { ...base, sport: "football", play: NONE, deadSeats: ["home"] };
    expect(() => expectBracketFinish({ ...ds, actions: [{ kind: "void-last" }] })).toThrow(OUT_OF_SCOPE["void-nothing"]);
    expect(expectBracketFinish({ ...ds, actions: [{ kind: "settle", winner: "home", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 0, code: "SETTLE_NOT_APPLICABLE" }]);
    expect(expectBracketFinish({ ...ds, actions: [fo("away", "walkover")] }).refused).toEqual([{ index: 0, code: "ALREADY_DECIDED" }]);
    expect(expectBracketFinish({ ...ds, actions: [{ kind: "finalize" }] })).toEqual({ status: "finalized", advances: { winner: "away", loser: null, method: "walkover" }, refused: [] });
  });

  it("deadSeats is a set of seats: a seat listed twice is refused by name, never read as two dead seats", () => {
    expect(() => expectBracketFinish({ ...base, play: NONE, deadSeats: ["home", "home"] })).toThrow(/deadSeats lists home twice/);
    expect(() => expectBracketFinish({ ...base, play: NONE, deadSeats: ["away", "away"] })).toThrow(/deadSeats lists away twice/);
  });
});

describe("bracket-finish W2b: who may record a forfeit, and when (X-RS-1, X-RS-3, X-AB-4, BG-WO-2, BG-WO-3; plan D3, D4, PF-2)", () => {
  it("X-RS-3: every forfeit a scorer or a device records is refused FORBIDDEN — every reason, either side or both, whatever was played, every sport", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const play of [NONE, LIVE, { kind: "win", winner: "home" } as const]) {
        for (const by of ["scorer", "device"] as const) {
          for (const reason of FORFEIT_REASONS) {
            for (const offender of ["home", "away", "both"] as const) {
              const e = expectBracketFinish({ stageKind: "knockout", sport: key, play, actions: [fo(offender, reason, by)], hasLoserLine: false });
              expect(e.refused, `${key} ${play.kind} ${by} ${reason} ${offender}`).toEqual([{ index: 0, code: "FORBIDDEN" }]);
              checked++;
            }
          }
        }
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11 * 3 * 2 * 4 * 3);
  });

  it("D3 R1 (X-DW-1): a two-sided forfeit is a walkover — any other reason is INVALID_EVENT; PF-2: withdrew from anyone but the withdrawal cascade is INVALID_EVENT", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      for (const reason of ["retired", "disqualified", "withdrew"] as const) {
        for (const by of ["organiser", "cascade"] as const) {
          expect(refusedAt(expectBracketFinish({ ...base, sport: key, play: NONE, actions: [fo("both", reason, by)] }), 0), `${key} both ${reason} ${by}`).toBe("INVALID_EVENT");
          checked++;
        }
      }
      for (const offender of ["home", "away"] as const) {
        expect(refusedAt(expectBracketFinish({ ...base, sport: key, play: NONE, actions: [fo(offender, "withdrew", "organiser")] }), 0), `${key} ${offender} withdrew organiser`).toBe("INVALID_EVENT");
        // the positive pair: the cascade's withdrawal is accepted
        expect(expectBracketFinish({ ...base, sport: key, play: NONE, actions: [fo(offender, "withdrew", "cascade")] }), key).toEqual(forfeitWin(otherSide(offender), "withdrew"));
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11 * 8);
  });

  it("X-RS-1 (rulings 112, 113) + D3 (R2, R4, R5): a walkover until something is played — before the Start and after a bare Start — disqualified once the Start is pressed, retired only once something is played; FORFEIT_REASON_WRONG_PHASE otherwise; withdrew in any phase; every sport but chess", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      if (key === CHESS) return; // BG-WO-2: chess differs, its own test below
      const at = (play: PlayResult, a: Action): RefusalCode | "accepted" => refusedAt(expectBracketFinish({ ...base, sport: key, play, actions: [a] }), 0) ?? "accepted";
      const TABLE: [PlayResult, Action, RefusalCode | "accepted"][] = [
        [NONE, fo("away", "walkover"), "accepted"],
        [NONE, fo("both", "walkover"), "accepted"],
        [NONE, fo("away", "retired"), "FORFEIT_REASON_WRONG_PHASE"],
        [NONE, fo("away", "disqualified"), "FORFEIT_REASON_WRONG_PHASE"],
        [NONE, fo("away", "withdrew", "cascade"), "accepted"],
        [STARTED, fo("away", "walkover"), "accepted"],
        [STARTED, fo("both", "walkover"), "accepted"],
        [STARTED, fo("away", "retired"), "FORFEIT_REASON_WRONG_PHASE"], // ruling 113: nobody retires from a match never played
        [STARTED, fo("away", "disqualified"), "accepted"],
        [STARTED, fo("away", "withdrew", "cascade"), "accepted"],
        [LIVE, fo("away", "walkover"), "FORFEIT_REASON_WRONG_PHASE"],
        [LIVE, fo("both", "walkover"), "FORFEIT_REASON_WRONG_PHASE"],
        [LIVE, fo("away", "retired"), "accepted"],
        [LIVE, fo("away", "disqualified"), "accepted"],
        [LIVE, fo("away", "withdrew", "cascade"), "accepted"],
      ];
      for (const [play, a, want] of TABLE) { expect(at(play, a), `${key} ${play.kind} ${JSON.stringify(a)}`).toBe(want); checked++; }
      // an accepted walkover after a bare Start is the walkover itself: the other side advances by walkover
      expect(expectBracketFinish({ ...base, sport: key, play: STARTED, actions: [fo("away", "walkover")] }), key).toEqual(forfeitWin("home", "walkover"));
    });
    expect(sports).toBe(11);
    expect(checked).toBe(10 * 15);
  });

  it("BG-WO-2 + FIDE 6.7.1 + ruling 118: a chess walkover is recordable before the game starts AND during play (a double forfeit too); retired and disqualified only after the start — from a bare Start, which in chess is play", () => {
    // single-sport: BG-WO-2 is chess's row (boardgame)
    const at = (play: PlayResult, a: Action): BracketExpect => expectBracketFinish({ ...base, play, actions: [a] });
    expect(at(NONE, fo("away", "walkover"))).toEqual(forfeitWin("home", "walkover"));
    expect(at(LIVE, fo("away", "walkover"))).toEqual(forfeitWin("home", "walkover"));
    expect(at(LIVE, fo("both", "walkover"))).toEqual(DOUBLE);
    expect(refusedAt(at(NONE, fo("away", "retired")), 0)).toBe("FORFEIT_REASON_WRONG_PHASE");
    // Ruling 118 (2026-10-12): in chess the Start is play (Seazn records no moves) — after a bare Start the retirement
    // stands beside the disqualification. Ruling 113's refusal stays every other sport's (the sweep above).
    expect(at(STARTED, fo("away", "retired"))).toEqual(forfeitWin("home", "retired"));
    expect(at(STARTED, fo("away", "disqualified"))).toEqual(forfeitWin("home", "disqualified"));
    expect(at(LIVE, fo("away", "retired"))).toEqual(forfeitWin("home", "retired"));
  });

  it("BG-WO-3 + D3 R3: a chess game awaiting its tie-break is walked over to the remaining side when one player withdraws or does not turn up — but a double walkover there is FORFEIT_REASON_WRONG_PHASE (the classical game was played)", () => {
    // single-sport: BG-WO-3 is chess's row (boardgame); `base` is a drawn chess knockout game awaiting its tie-break
    expect(expectBracketFinish({ ...base, actions: [fo("away", "walkover")] })).toEqual(forfeitWin("home", "walkover"));
    expect(expectBracketFinish({ ...base, actions: [fo("home", "withdrew", "cascade")] })).toEqual(forfeitWin("away", "withdrew"));
    expect(expectBracketFinish({ ...base, actions: [fo("away", "retired")] })).toEqual(forfeitWin("home", "retired"));
    expect(expectBracketFinish({ ...base, actions: [fo("both", "walkover")] })).toEqual({ status: "in_play", advances: null, refused: [{ index: 0, code: "FORFEIT_REASON_WRONG_PHASE" }] });
    // after the walkover the tie-break is over: a tie-break is refused
    expect(expectBracketFinish({ ...base, actions: [fo("away", "walkover"), { kind: "tiebreak", rung: "blitz", winner: "away" }] }).refused).toEqual([{ index: 1, code: "TIEBREAK_NOT_APPLICABLE" }]);
  });

  it("X-AB-4 (plan D4): a forfeit while an abandon is active is refused ABANDONED_SETTLE_OR_VOID — even once the abandon is settled, above ALREADY_DECIDED; void the abandon and the forfeit is a retirement (a walkover there is the wrong phase); every sport", () => {
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      const run = (actions: Action[]): BracketExpect => expectBracketFinish({ ...base, sport: key, play: LIVE, actions, hasLoserLine: true });
      expect(run([{ kind: "abandon" }, fo("away", "retired")]), key).toEqual({ status: "abandoned", advances: null, refused: [{ index: 1, code: "ABANDONED_SETTLE_OR_VOID" }] });
      expect(refusedAt(run([{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }, fo("away", "retired")]), 2), key).toBe("ABANDONED_SETTLE_OR_VOID");
      expect(run([{ kind: "abandon" }, { kind: "void-last" }, fo("away", "retired")]), key).toEqual(forfeitWin("home", "retired"));
      expect(refusedAt(run([{ kind: "abandon" }, { kind: "void-last" }, fo("away", "walkover")]), 2), key).toBe(key === CHESS ? undefined : "FORFEIT_REASON_WRONG_PHASE");
      checked++;
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11);
  });
});

describe("bracket-finish W2b transitions (TEST-STRATEGY rule 1: a second call, a void, a refused write, another sport)", () => {
  it("a void of a forfeit restores the fixture, and a different forfeit after it is accepted; a refused forfeit writes nothing", () => {
    // single-sport: football reads the cross-sport rows alone; the W2b walk below holds every sport
    const fb = (play: PlayResult, actions: Action[]): BracketExpect => expectBracketFinish({ ...base, sport: "football", play, actions, hasLoserLine: true });
    expect(fb(NONE, [fo("away", "walkover"), { kind: "void-last" }])).toEqual({ status: "scheduled", advances: null, refused: [] });
    expect(fb(NONE, [fo("away", "walkover"), { kind: "void-last" }, fo("home", "walkover")])).toEqual(forfeitWin("away", "walkover"));
    expect(fb(NONE, [fo("both", "walkover"), { kind: "void-last" }])).toEqual({ status: "scheduled", advances: null, refused: [] });
    // a refused forfeit leaves no action for a void to undo
    expect(() => fb(NONE, [fo("away", "retired"), { kind: "void-last" }])).toThrow(OUT_OF_SCOPE["void-nothing"]);
    expect(fb(NONE, [fo("away", "retired"), fo("away", "walkover")])).toEqual({ ...forfeitWin("home", "walkover"), refused: [{ index: 0, code: "FORFEIT_REASON_WRONG_PHASE" }] });
  });

  it("a second call answers the same", () => {
    const c: BracketCase = { ...base, play: LIVE, actions: [fo("away", "retired"), { kind: "finalize" }], deadSeats: [] };
    expect(expectBracketFinish(c)).toEqual(expectBracketFinish(c));
    expect(expectBracketFinish(c).status).toBe("finalized");
  });
});

// ── W2b: the rows bracket-finish covers, read from Appendix A ─────────────────────────────────────────────────────────

const W2B_ROWS = ["X-RS-1", "X-RS-3", "X-DW-1", "X-DW-2", "X-DW-3", "X-AB-4", "X-WD-1", "X-WD-2", "X-WD-3", "X-WD-4", "X-WD-5", "X-DE-1", "BG-DW-1", "BG-WO-2", "BG-WO-3"];
const OWN_TITLES = (() => {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  return [...text.matchAll(/\b(?:it|describe)\(\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2] ?? "");
})();

describe("bracket-finish W2b rows (Appendix A)", () => {
  it("the family cites each W2b bracket row: every one an Appendix A row, signed, and named in a test title of this file", () => {
    const appendix = new Map(readAppendixA().rows.map((r) => [r.id, r]));
    let cited = 0;
    for (const id of W2B_ROWS) {
      expect(bracketFinish.rows, id).toContain(id);
      expect(appendix.get(id)?.status, `${id} is no Appendix A row`).toMatch(/^signed \d+ \d{4}-\d{2}-\d{2}$/);
      expect(OWN_TITLES.some((t) => new RegExp(`(^|[^A-Z0-9-])${id}([^0-9]|$)`).test(t)), `${id}: no test title names it`).toBe(true);
      cited++;
    }
    expect(cited).toBe(15);
    // and the amendment is answered: X-BR-1's "a win or a double walkover"
    expect(readAppendixA().amendments).toContain("X-BR-1 (amend)");
    expect(OWN_TITLES.some((t) => t.includes("X-BR-1 (amend)"))).toBe(true);
  });
});

// ── W2b rule 10: every forfeit sequence up to W2B_DEPTH, invariants after every step ─────────────────────────────────
// A separate, smaller walk than W2a's (which is unchanged): the W2b actions are forfeits, so its alphabet is the forfeit
// writes plus the W2a actions they interact with, its roots add a match under way, the chess double forfeit, a missing
// next match and the dead seats. Every expected answer is restated from the rows — never read off the family.

const W2B_PLAYS: readonly PlayResult[] = [NONE, STARTED, LIVE, { kind: "win", winner: "away" }, DRAW, HELD, { kind: "double_walkover" }];
const W2B_ALPHABET: readonly Action[] = [
  fo("away", "walkover"),
  fo("home", "retired"),
  fo("home", "withdrew", "cascade"),
  fo("away", "withdrew", "organiser"),
  fo("both", "walkover"),
  fo("both", "retired", "cascade"),
  fo("home", "walkover", "device"),
  { kind: "abandon" },
  { kind: "settle", winner: "away", method: "lot", by: "organiser" },
  { kind: "tiebreak", rung: "rapid", winner: "home" },
  { kind: "void-last" },
  { kind: "finalize" },
];
const W2B_DEPTH = 3;
const W2B_NODES_PER_ROOT = Array.from({ length: W2B_DEPTH + 1 }, (_, k) => W2B_ALPHABET.length ** k).reduce((a, b) => a + b, 0);
const W2B_ROOT_SHAPES = W2B_PLAYS.length * 2 * 2 + 3 * 2 * 2; // plays × loser line × next match, + dead seats {home, away, both} × the same
const W2B_MAX_NODES = SPORT_COUNT * W2B_ROOT_SHAPES * W2B_NODES_PER_ROOT;
const W2B_BUDGET_MS = Math.max(5_000, W2B_MAX_NODES * PER_NODE_MS * 5);
const W2B_CODES = ["SETTLE_NOT_APPLICABLE", "TIEBREAK_NOT_APPLICABLE", "FORBIDDEN", "LEVEL_RESULT_IN_BRACKET", "INVALID_EVENT", "DOUBLE_WALKOVER_NO_NEXT_MATCH", "ABANDONED_SETTLE_OR_VOID", "ALREADY_DECIDED", "FORFEIT_REASON_WRONG_PHASE"] as const;
const FORFEIT_METHODS = new Set<string>(FORFEIT_REASONS);

/** What the rows say a forfeit write gets, from the case and the parent's OBSERVABLE status alone: the code it is
 *  refused with, or "accepted". The order is the server's then the kernel's: the organiser gate (X-RS-3), the strict
 *  schema (D3 R1), the cascade-only reason (PF-2), the feed graph (D19 / X-DW-3); then the abandon guard (D4 / X-AB-4),
 *  guarantee 4 with the withdrawal admission (PF-1 / X-WD-1), the phase guard (D3 R2-R5). */
function forfeitAnswer(c: BracketCase, a: Extract<Action, { kind: "forfeit" }>, parent: BracketExpect, abandonActive: boolean): RefusalCode | "accepted" {
  if (a.by === "scorer" || a.by === "device") return "FORBIDDEN";
  if (a.offender === "both" && a.reason !== "walkover") return "INVALID_EVENT";
  if (a.reason === "withdrew" && a.by !== "cascade") return "INVALID_EVENT";
  if (a.offender === "both" && c.hasNextMatch === false && !c.hasLoserLine && c.stageKind !== "ladder") return "DOUBLE_WALKOVER_NO_NEXT_MATCH";
  if (abandonActive) return "ABANDONED_SETTLE_OR_VOID"; // D4: an unvoided abandon in the ledger, settled or not
  if (parent.status === "decided" || parent.status === "forfeited") return "ALREADY_DECIDED";
  if (parent.status === "needs_decision") return a.reason === "withdrew" && a.offender !== "both" ? "accepted" : "ALREADY_DECIDED";
  const chess = c.sport === CHESS;
  if (parent.status === "in_play") {
    const tiebreakPhase = chess && c.play.kind === "level" && c.play.as === DRAWN;
    if (tiebreakPhase) return a.offender === "both" ? "FORFEIT_REASON_WRONG_PHASE" : "accepted"; // R3; BG-WO-3
    // Ruling 113: a retirement after a bare Start is before play (nobody retires from a match never played) — except in
    // chess, whose Start is play (ruling 118)
    if (a.reason === "retired" && c.play.kind === "started" && !chess) return "FORFEIT_REASON_WRONG_PHASE";
    // R2 (chess: FIDE 6.7.1) — ruling 112: a walkover after a bare Start is still before play; R4/R5 admit
    return a.reason === "walkover" && !chess && c.play.kind !== "started" ? "FORFEIT_REASON_WRONG_PHASE" : "accepted";
  }
  // scheduled: phase pre
  return a.reason === "retired" || a.reason === "disqualified" ? "FORFEIT_REASON_WRONG_PHASE" : "accepted"; // R4; R2/R5 admit
}

/** `ledger` is the standing (accepted, unvoided) actions, parallel to `standing`: D4 reads an active abandon from the
 *  ledger, which the observable status hides once a settle decides the fixture. */
function walkW2b(c: BracketCase, parent: BracketExpect, standing: readonly Snap[], ledger: readonly Action[], t: Tally & { forfeits: number; accepted: number; doubles: number; settledAbandons: number }): void {
  if (c.actions.length === W2B_DEPTH) return;
  for (const a of W2B_ALPHABET) {
    const next: BracketCase = { ...c, actions: [...c.actions, a] };
    const i = next.actions.length - 1;
    const abandonActive = ledger.some((x) => x.kind === "abandon");
    t.nodes++;
    let n: BracketExpect;
    try {
      n = expectBracketFinish(next);
    } catch (e) {
      // unanswered: only the W2a reasons, each from the parent's observable state (the W2a walk proves them in full)
      if (e instanceof OutOfScope) t.outOfScope.add(e.reason);
      else if (e instanceof RuledOut) t.ruledOut.add(e.reason);
      else { fail(t, next, `threw ${String(e)}`); continue; }
      const ok = (e instanceof RuledOut && e.reason === "tiebreak-not-chess" && a.kind === "tiebreak" && c.sport !== CHESS)
        || (e instanceof OutOfScope && ((e.reason === "after-finalize" && parent.status === "finalized")
          || (e.reason === "abandon-decided" && a.kind === "abandon" && !abandonActive && (parent.status === "decided" || parent.status === "forfeited"))
          || (e.reason === "abandon-twice" && a.kind === "abandon" && abandonActive)
          || (e.reason === "void-nothing" && a.kind === "void-last" && standing.length === 0)
          || (e.reason === "finalize-unplayed" && a.kind === "finalize" && (parent.status === "scheduled" || (parent.status === "in_play" && (c.play.kind === "in_progress" || c.play.kind === "started"))))));
      if (!ok) fail(t, next, `unanswered (${e.reason}) where the parent (${parent.status}) owes an answer`);
      continue;
    }
    if (parent.status === "finalized") fail(t, next, "answered after finalize");
    if (!same(expectBracketFinish(next), n)) fail(t, next, "a second call answered differently");
    if (!same(n.refused.slice(0, parent.refused.length), parent.refused)) fail(t, next, "the refusals are not the parent's plus this step's");
    const added = n.refused.length - parent.refused.length;
    if (added < 0 || added > 1) fail(t, next, `refusals grew by ${added}`);
    const code = added === 1 ? n.refused[n.refused.length - 1]?.code : undefined;
    if (added === 1 && n.refused[n.refused.length - 1]?.index !== i) fail(t, next, "the new refusal is not at this step");
    if (code !== undefined) {
      t.codes.add(code);
      if (!(W2B_CODES as readonly string[]).includes(code)) fail(t, next, `refusal code ${code} is not spec §7's`);
      if (!same(snap(n), snap(parent))) fail(t, next, "a refused action changed the fixture (a refusal writes nothing)");
      t.noops++;
    }
    let nextStanding = standing;
    let nextLedger = ledger;
    if (code === undefined && a.kind === "void-last") {
      const top = standing[standing.length - 1];
      if (top === undefined || !same(snap(n), top)) fail(t, next, "a void did not restore the state before the action it undid");
      nextStanding = standing.slice(0, -1);
      nextLedger = ledger.slice(0, -1);
      t.voids++;
    } else if (code === undefined) {
      nextStanding = [...standing, snap(parent)];
      nextLedger = [...ledger, a];
    }
    if (a.kind === "forfeit") {
      t.forfeits++;
      if (abandonActive && parent.status === "decided") t.settledAbandons++;
      const want = forfeitAnswer(next, a, parent, abandonActive);
      if ((code ?? "accepted") !== want) fail(t, next, `a forfeit on ${parent.status} answered ${code ?? "accepted"}, the rows say ${want}`);
      if (want === "accepted") {
        t.accepted++;
        const expected = a.offender === "both" ? { status: "forfeited", advances: null } : { status: "forfeited", advances: { winner: otherSide(a.offender), loser: null, method: a.reason } };
        if (a.offender === "both") t.doubles++;
        if (!same(snap(n), expected)) fail(t, next, `an accepted forfeit gave ${JSON.stringify(snap(n))}`); // X-DE-1: the loser never seated
      }
    }
    // a forfeited fixture is final: a settle, a tie-break and a finalize answer it as decided
    if (parent.status === "forfeited") {
      if (a.kind === "settle" && a.by === "organiser" && code !== "SETTLE_NOT_APPLICABLE") fail(t, next, "a settle on a forfeited fixture was not refused");
      if (a.kind === "tiebreak" && code !== "TIEBREAK_NOT_APPLICABLE") fail(t, next, "a tie-break on a forfeited fixture was not refused");
      if (a.kind === "finalize" && !(n.status === "finalized" && same(n.advances, parent.advances))) fail(t, next, "finalize of a forfeited fixture did not finalize it as it stood");
    }
    // X-BR-1 as amended: somebody advances only from a win (play, a decider, settle or a forfeit), and a forfeit's
    // loser is never seated (X-DE-1); a forfeited fixture advances the forfeit's winner or nobody (a double walkover)
    const byForfeit = n.advances !== null && FORFEIT_METHODS.has(n.advances.method);
    if (n.status === "decided" && (n.advances === null || byForfeit)) fail(t, next, `decided with ${JSON.stringify(n.advances)}`);
    if (n.status === "forfeited" && n.advances !== null && !byForfeit) fail(t, next, `forfeited with ${JSON.stringify(n.advances)}`);
    if (n.advances !== null && !byForfeit && n.status !== "decided" && n.status !== "finalized") fail(t, next, `${n.status} with ${JSON.stringify(n.advances)}`);
    if (byForfeit && n.status !== "forfeited" && n.status !== "finalized") fail(t, next, `${n.status} with a forfeit's ${JSON.stringify(n.advances)}`);
    if (byForfeit && n.advances?.loser !== null) fail(t, next, "a forfeit loser was seated (X-DE-1)");
    t.statuses.add(n.status);
    walkW2b(next, n, nextStanding, nextLedger, t);
  }
}

describe("bracket-finish W2b, rule 10: every forfeit sequence up to W2B_DEPTH actions, every registered sport, every root shape", () => {
  it(`invariants after every step (X-RS-1, X-RS-3, X-DW-1..3, X-AB-4, X-WD-1..5, X-DE-1, BG-DW-1, BG-WO-2, BG-WO-3; plan D3, D4, D19, PF-1, PF-2) — at most ${W2B_MAX_NODES} nodes`, () => {
    const t = { nodes: 0, failures: 0, first: [] as string[], statuses: new Set<string>(), codes: new Set<string>(), outOfScope: new Set<string>(), ruledOut: new Set<string>(), sticky: 0, voids: 0, noops: 0, settles: 0, tiebreaks: 0, finalizes: 0, forfeits: 0, accepted: 0, doubles: 0, settledAbandons: 0 };
    let roots = 0;
    const rootThrows: string[] = [];
    const sports = forEachSport(({ key }) => {
      const shapes: Omit<BracketCase, "actions" | "sport" | "stageKind">[] = [];
      for (const hasLoserLine of [false, true]) {
        for (const hasNextMatch of [true, false]) {
          for (const play of W2B_PLAYS) shapes.push({ play, hasLoserLine, hasNextMatch });
          for (const deadSeats of [["home"], ["away"], ["home", "away"]] as Side[][]) shapes.push({ play: NONE, hasLoserLine, hasNextMatch, deadSeats });
        }
      }
      for (const shape of shapes) {
        const root: BracketCase = { ...shape, stageKind: "knockout", sport: key, actions: [] };
        roots++;
        t.nodes++;
        let e: BracketExpect;
        try { e = expectBracketFinish(root); } catch (err) {
          if (err instanceof RuledOut || err instanceof OutOfScope) { rootThrows.push(`${key} ${JSON.stringify(shape)} ${err.reason}`); continue; }
          throw err;
        }
        t.statuses.add(e.status);
        walkW2b(root, e, [], [], t);
      }
    });
    expect(t.failures, `${t.failures} invariant failure(s), the first:\n${t.first.join("\n")}`).toBe(0);
    expect(sports).toBe(SPORT_COUNT);
    expect(roots).toBe(SPORT_COUNT * W2B_ROOT_SHAPES);
    expect(t.nodes).toBeGreaterThan(roots);
    expect(t.nodes).toBeLessThanOrEqual(W2B_MAX_NODES);
    // anti-vacuity: every status and every code the W2b rows name was reached, and forfeits were both refused and accepted
    expect([...t.statuses].sort()).toEqual([...STATUSES, "forfeited"].sort());
    expect([...t.codes].sort()).toEqual([...W2B_CODES].sort());
    expect(t.forfeits).toBeGreaterThan(0);
    expect(t.accepted).toBeGreaterThan(0);
    expect(t.accepted).toBeLessThan(t.forfeits);
    expect(t.doubles).toBeGreaterThan(0);
    expect(t.settledAbandons).toBeGreaterThan(0); // D4 above guarantee 4: a forfeit over a SETTLED abandon was walked
    expect(t.voids).toBeGreaterThan(0);
    // the roots the rows exclude, typed: every non-chess double walkover by play (BG-DW-1), every carrom draw (CA-KO-1),
    // and every vacant title (X-DW-3 / W4): two dead seats, or a chess double forfeit, with no next match and no loser line
    const want: string[] = [];
    forEachSport(({ key }) => {
      for (const hasLoserLine of [false, true]) for (const hasNextMatch of [true, false]) {
        if (key !== CHESS) want.push(`${key} double-walkover-play-not-chess`);
        if (key === "carrom") want.push(`${key} carrom-level`);
        if (!hasLoserLine && !hasNextMatch) want.push(`${key} vacant-title`);
        if (!hasLoserLine && !hasNextMatch && key === CHESS) want.push(`${key} vacant-title`);
      }
    });
    expect(rootThrows.map((r) => `${r.split(" ")[0]} ${r.split(" ").at(-1)}`).sort()).toEqual(want.sort());
  }, W2B_BUDGET_MS);
});
