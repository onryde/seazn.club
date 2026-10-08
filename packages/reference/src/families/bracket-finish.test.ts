// The bracket-finish family's tests. Every expected value is read from a signed rule row (packages/engine/rules/*.md),
// spec 2026-10-08-format-matrix-w2a-design.md (§5.1, §5.4.2, §5.4.3, §7) or a CONTROLLER ruling P2-1..P2-8 on T15's
// questions (2026-10-08; controller rulings, not owner rulings) — never from engine source (R8). The engine is touched
// only for its DECLARED domain at test time: StageKind.options and the sport registry.
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { forEachSport } from "@seazn/engine/testkit";
import {
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
} from "./bracket-finish.ts";
import { bracketKindsFromRows, drawKindsFromXDR1, levelKindsFromXBR1, readRuleRows, rowById } from "../../test/rule-rows.ts";

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
  // "a drawn chess game goes to a tie-break" + ruling C12 (in_play). A double forfeit (no_result) is NOT a drawn game
  // (spec §5.2 as amended, controller ruling T15-R1): X-BR-2 holds it.
  "BG-KO-1": { draw: { status: "in_play", advances: null, refused: [] } },
  "BG-KO-2": null, // the armageddon winner — about the tie-break, not the play
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

  it("the rows the family cites are rules-directory rows, every one signed, and every X-BR, X-ST, X-DR and KO row is cited (none stale, none unanswered; a later wave's other row is not this family's)", () => {
    expect(ROWS.length).toBeGreaterThan(0);
    const ids = ROWS.map((r) => r.id);
    expect(new Set(bracketFinish.rows).size).toBe(bracketFinish.rows.length); // no row cited twice
    for (const id of bracketFinish.rows) expect(ids, `${id} is cited but is no rules row (stale)`).toContain(id);
    for (const id of bracketFinish.rows) expect(rowById(ROWS, id).status, id).toMatch(/^signed \d+ \d{4}-\d{2}-\d{2}$/);
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

  it("BG-KO-1 + spec §5.2 as amended (controller ruling T15-R1): a chess double forfeit (no_result) is not a drawn game — held needs_decision, a tie-break on it is refused, finalize is refused, any settle closes it", () => {
    // single-sport: BG-KO-1 is chess's row (boardgame); the registry sweep above holds every other sport's no_result
    const nr: BracketCase = { ...base, play: { kind: "level", as: "no_result" } };
    expect(expectBracketFinish(nr)).toEqual({ status: "needs_decision", advances: null, refused: [] });
    let rungs = 0;
    for (const rung of ["rapid", "blitz", "armageddon"] as const) {
      expect(expectBracketFinish({ ...nr, actions: [{ kind: "tiebreak", rung, winner: "home" }] }), rung).toEqual({ status: "needs_decision", advances: null, refused: [{ index: 0, code: "TIEBREAK_NOT_APPLICABLE" }] });
      // the positive pair: the same tie-break on a DRAWN game decides it
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung, winner: "home" }] }).advances, rung).toEqual({ winner: "home", loser: null, method: `tiebreak_${rung}` });
      rungs++;
    }
    expect(rungs).toBe(3);
    expect(expectBracketFinish({ ...nr, actions: [{ kind: "finalize" }] })).toEqual({ status: "needs_decision", advances: null, refused: [{ index: 0, code: "LEVEL_RESULT_IN_BRACKET" }] });
    for (const method of ["lot", "higher_seed", "organiser"] as const) {
      expect(expectBracketFinish({ ...nr, hasLoserLine: true, actions: [{ kind: "settle", winner: "away", method, by: "organiser" }] }), method).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: `settled_${method}` }, refused: [] });
    }
    // a void of the settle restores the hold — and a tie-break is still refused after it
    expect(expectBracketFinish({ ...nr, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }, { kind: "void-last" }, { kind: "tiebreak", rung: "rapid", winner: "home" }] })).toEqual({ status: "needs_decision", advances: null, refused: [{ index: 2, code: "TIEBREAK_NOT_APPLICABLE" }] });
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

  it("each OutOfScope reason cites the controller ruling that put it out of scope (finalize-unplayed: T15-R4)", () => {
    const RULING: Readonly<Record<keyof typeof OUT_OF_SCOPE, string>> = { "after-finalize": "P2-1", "abandon-decided": "P2-2", "abandon-twice": "P2-3", "finalize-unplayed": "T15-R4", "void-nothing": "P2-8" };
    let cited = 0;
    for (const [r, ruling] of Object.entries(RULING) as [keyof typeof OUT_OF_SCOPE, string][]) {
      expect(OUT_OF_SCOPE[r], r).toContain(`controller ruling ${ruling})`);
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

  it("CA-KO-1 / BG-KO-1 / X-BR-1: RuledOut names its row — a level carrom bracket match, a tie-break outside chess, a draw kind", () => {
    const reasons = Object.keys(RULED_OUT);
    expect(reasons.length).toBeGreaterThan(0);
    const cases: Readonly<Record<keyof typeof RULED_OUT, BracketCase>> = {
      "carrom-level": { ...base, sport: "carrom" },
      "tiebreak-not-chess": { ...base, sport: "football", actions: [{ kind: "tiebreak", rung: "rapid", winner: "home" }] },
      "not-bracket": { ...base, stageKind: "league" },
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
    expect([...t.outOfScope].sort()).toEqual(Object.keys(OUT_OF_SCOPE).sort());
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
