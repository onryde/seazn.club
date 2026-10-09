// W2a (controller ruling T15-R3): the harness judges every bracket match it drives against the reference family
// `bracket-finish` (@seazn/reference). The oracle's answers here are the rulebook's (X-BR-1, X-BR-2, X-ST-1, X-ST-2,
// BG-KO-1, CA-KO-1); the products are hand-built or a fake made wrong on purpose. Needs the reference lane merged
// into this one (the family's exports): red until then.
import { StageKind } from "@seazn/engine/core";
import { LEVEL_KINDS, NoReferenceFamily, type LevelKind } from "@seazn/reference";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedOutcome, ObservedRun } from "../lib/observed.ts";
import { Recorder, decideFixture, setUpDivision } from "../lib/scenarios/common.ts";
import { referenceBracketFinish } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { LevelKindUnread, bracketCaseOf, judgeDrive, levelKindOf, loserSeatOf, oracleMethod, type BracketDrive } from "../lib/reference-bracket.ts";
import { drawsAllowed, resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream, levelReachable } from "../lib/streams/index.ts";
import type { FixtureRow } from "../lib/driver/types.ts";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder } from "@seazn/engine/scheduling";
import type { RequestedOutcome } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

/** The level kind a hand-built drive plays when a test does not say: its request's own, a drawn game for a `level`
 *  request, a tie-break and a settle (a chess game and football both END level as a draw). The cases that depend on
 *  the kind (generic, cricket) say it. */
const defaultLevel = (a: RequestedOutcome): LevelKind | null =>
  a.kind === "tie" ? "tie" : a.kind === "draw" || a.kind === "level" || a.kind === "tiebreak" || (a.kind === "settle" && a.after === "level") ? "draw" : null;
const drive = (over: Partial<BracketDrive> & { asked: RequestedOutcome }): BracketDrive =>
  ({ fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", levelAs: defaultLevel(over.asked), status: "decided", outcome: null, loser: { line: "none" }, ...over });
const win = (winner: string, method?: string): ObservedOutcome => ({ kind: "win", winner, ...(method === undefined ? {} : { method }) });

describe("oracleMethod — the product's method as the oracle names it", () => {
  it("settled_* and tiebreak_* keep their names; every play win, named or not, is `play`", () => {
    for (const m of ["settled_lot", "settled_higher_seed", "settled_organiser", "tiebreak_rapid", "tiebreak_blitz", "tiebreak_armageddon"]) expect(oracleMethod(m), m).toBe(m);
    for (const m of [undefined, "checkmate", "resign", "points", "walkover", "settled", "tiebreak"]) expect(oracleMethod(m), String(m)).toBe("play");
  });
});

describe("bracketCaseOf — the harness's drive, in the rulebook's terms", () => {
  it("each request kind maps to its play result and actions, and a walkover has no oracle vocabulary", () => {
    const of = (asked: RequestedOutcome, over: Partial<BracketDrive> = {}) => bracketCaseOf(drive({ asked, ...over }));
    expect(of({ kind: "win", winner: "away" })).toMatchObject({ play: { kind: "win", winner: "away" }, actions: [] });
    for (const kind of ["level", "draw", "tie"] as const) expect(of({ kind }, { levelAs: kind === "tie" ? "tie" : "draw" }), kind).toMatchObject({ play: { kind: "level" }, actions: [] });
    expect(of({ kind: "settle", then: "home", method: "lot", after: "level" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "settle", winner: "home", method: "lot", by: "organiser" }] });
    expect(of({ kind: "settle", then: "away", method: "organiser", after: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "away", method: "organiser", by: "organiser" }] });
    expect(of({ kind: "tiebreak", rung: "blitz", winner: "home" }, { sport: "boardgame" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "tiebreak", rung: "blitz", winner: "home" }] });
    expect(of({ kind: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }] });
    expect(of({ kind: "forfeit", by: "home", reason: "walkover" })).toEqual({ notJudged: expect.stringMatching(/walkover is not one of the oracle's actions/) });
    // The stage kind and the sport go through as the drive's own.
    expect(of({ kind: "win", winner: "home" }, { stageKind: "double_elim", sport: "carrom" })).toMatchObject({ stageKind: "double_elim", sport: "carrom" });
  });
});

describe("judgeDrive — the product agrees with the oracle on every way a bracket match can finish (positive), and each field wrong on its own reds (negative)", () => {
  /** [label, the drive with the product's CORRECT answer by the rulebook]. */
  const AGREE: readonly [string, BracketDrive][] = [
    ["a play win (X-BR-1)", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a", "points") })],
    ["a play win, the away side, no method", drive({ asked: { kind: "win", winner: "away" }, status: "decided", outcome: win("b") })],
    ["a level result is HELD (X-BR-2)", drive({ asked: { kind: "level" }, status: "needs_decision", outcome: { kind: "draw" } })],
    ["a held level result, settled by lot (X-ST-1)", drive({ asked: { kind: "settle", then: "away", method: "lot", after: "level" }, status: "decided", outcome: win("b", "settled_lot") })],
    ["an abandon at score, settled by the organiser", drive({ asked: { kind: "settle", then: "home", method: "organiser", after: "abandon" }, status: "decided", outcome: win("a", "settled_organiser") })],
    ["an abandon alone stays abandoned (X-BR-2)", drive({ asked: { kind: "abandon" }, status: "abandoned", outcome: null })],
    ["a drawn chess game decided by its tie-break (BG-KO-1)", drive({ asked: { kind: "tiebreak", rung: "armageddon", winner: "away" }, sport: "boardgame", status: "decided", outcome: win("b", "tiebreak_armageddon") })],
    ["the same level result in a ladder", drive({ asked: { kind: "level" }, stageKind: "ladder", status: "needs_decision", outcome: { kind: "tie" } })],
  ];
  it("positive: every rulebook-correct product answer agrees, counted", () => {
    let judged = 0;
    for (const [label, d] of AGREE) {
      const j = judgeDrive(d);
      expect(j, label).toMatchObject({ judged: true, ok: true });
      judged++;
    }
    expect(judged).toBe(AGREE.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("negative: a deliberately wrong product reds on exactly the field that is wrong — status, who advances, the method, or an advance the oracle withholds", () => {
    const wrong: readonly [string, BracketDrive, RegExp][] = [
      ["a level result decided instead of held", drive({ asked: { kind: "level" }, status: "decided", outcome: { kind: "draw" } }), /status: oracle needs_decision, product decided/],
      ["a held match that advanced somebody", drive({ asked: { kind: "level" }, status: "needs_decision", outcome: win("a") }), /oracle says nobody advances, product advanced a/],
      ["a settle that left the match abandoned", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "abandon" }, status: "abandoned", outcome: win("a", "settled_lot") }), /status: oracle decided, product abandoned/],
      ["a settle that advanced the other side", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("b", "settled_lot") }), /oracle says home advances, product advanced away/],
      ["a settle recorded with a different method", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("a", "settled_organiser") }), /method: oracle settled_lot, product settled_organiser/],
      ["a settle recorded as an ordinary win", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("a") }), /method: oracle settled_lot, product play/],
      ["a plain win recorded as a settle", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a", "settled_lot") }), /method: oracle play, product settled_lot/],
      ["a settled match that advanced nobody", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: null }), /product advanced nobody/],
      ["an abandoned match that decided", drive({ asked: { kind: "abandon" }, status: "decided", outcome: win("a") }), /status: oracle abandoned, product decided/],
      ["a tie-break recorded on the wrong rung", drive({ asked: { kind: "tiebreak", rung: "rapid", winner: "home" }, sport: "boardgame", status: "decided", outcome: win("a", "tiebreak_blitz") }), /method: oracle tiebreak_rapid, product tiebreak_blitz/],
      // GN-KO-1: generic refuses a level result in a bracket, so the oracle refuses the play AND the settle after it; a
      // product that sat at "scheduled" with nobody advancing agrees on every other field — only the refusals differ.
      ["a driven sequence the rules refuse (generic level, then settle)", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, sport: "generic", status: "scheduled", outcome: null }), /the oracle refuses action -1 with LEVEL_RESULT_IN_BRACKET, which the harness drove as legal/],
      ["a winner who is not in the match", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("zz") }), /a stranger \(zz\)/],
    ];
    let reds = 0;
    for (const [label, d, why] of wrong) {
      const j = judgeDrive(d);
      expect(j, label).toMatchObject({ judged: true, ok: false });
      expect(j.judged ? j.note : "", label).toMatch(why);
      reds++;
    }
    expect(reds).toBe(wrong.length);
    expect(reds).toBeGreaterThan(0);
  });

  it("not judged, named: a walkover, a driver that answered no status, and the oracle's own RuledOut; a stage kind with no family is the LOUD NoReferenceFamily", () => {
    expect(judgeDrive(drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") }))).toEqual({ judged: false, why: expect.stringMatching(/forfeit/) });
    expect(judgeDrive(drive({ asked: { kind: "win", winner: "home" }, status: null }))).toEqual({ judged: false, why: expect.stringMatching(/no status/) });
    // CA-KO-1: a carrom bracket match never ends level; BG-KO-1: only chess records a tie-break.
    expect(judgeDrive(drive({ asked: { kind: "level" }, sport: "carrom", status: "needs_decision", outcome: { kind: "draw" } }))).toEqual({ judged: false, why: expect.stringMatching(/rules it out \(carrom-level\)/) });
    expect(judgeDrive(drive({ asked: { kind: "tiebreak", rung: "rapid", winner: "home" }, sport: "football", status: "decided", outcome: win("a", "tiebreak_rapid") }))).toEqual({ judged: false, why: expect.stringMatching(/rules it out \(tiebreak-not-chess\)/) });
    // Not a bracket kind: no family, and that is an error, not a skip.
    expect(() => judgeDrive(drive({ asked: { kind: "win", winner: "home" }, stageKind: "league" }))).toThrow(NoReferenceFamily);
  });

  it("every bracket kind has the family and answers the same way (swept over StageKind.options)", () => {
    let judged = 0;
    let noFamily = 0;
    for (const kind of StageKind.options) {
      const d = drive({ asked: { kind: "level" }, stageKind: kind, status: "needs_decision", outcome: { kind: "draw" } });
      try {
        expect(judgeDrive(d), kind).toMatchObject({ judged: true, ok: true });
        judged++;
      } catch (e) {
        expect(e, kind).toBeInstanceOf(NoReferenceFamily);
        noFamily++;
      }
    }
    expect(judged + noFamily).toBe(StageKind.options.length);
    expect(judged).toBeGreaterThan(0);
    expect(noFamily).toBeGreaterThan(0); // league, group, swiss and americano are the draw kinds: no bracket family
  });
});

describe("level kinds — each one reaches the oracle as ITSELF (X-BR-1: draw, tie and no_result are different rows)", () => {
  /** The oracle's answer for a held-or-not result of each kind, from the rule rows (the family's own report table):
   *  [sport, kind, status the product must show, what the product shows]. GN-KO-1 refuses a generic DRAW (and only a
   *  draw), BG-KO-1 holds a drawn chess game for its tie-break (in_play), everything else is held (X-BR-2). */
  const HELD: readonly [string, LevelKind, string][] = [
    ["generic", "draw", "scheduled"], ["generic", "tie", "needs_decision"], ["generic", "no_result", "needs_decision"],
    ["boardgame", "draw", "in_play"], ["boardgame", "tie", "needs_decision"], ["boardgame", "no_result", "needs_decision"],
    ["football", "draw", "needs_decision"], ["football", "tie", "needs_decision"], ["football", "no_result", "needs_decision"],
    ["cricket", "draw", "needs_decision"], ["cricket", "tie", "needs_decision"], ["cricket", "no_result", "needs_decision"],
  ];

  it("the drive's level kind is the case's `as`, whichever request played it (level, settle after level, tie-break), counted over every kind", () => {
    let checked = 0;
    for (const kind of LEVEL_KINDS) {
      for (const asked of [{ kind: "level" }, { kind: "settle", then: "home", method: "lot", after: "level" }, { kind: "tiebreak", rung: "rapid", winner: "home" }] as const satisfies readonly RequestedOutcome[]) {
        const c = bracketCaseOf(drive({ asked, levelAs: kind, sport: asked.kind === "tiebreak" ? "boardgame" : "football" }));
        expect("notJudged" in c, `${kind}/${asked.kind}`).toBe(false);
        expect("play" in c && c.play, `${kind}/${asked.kind}`).toEqual({ kind: "level", as: kind });
        checked++;
      }
    }
    expect(checked).toBe(LEVEL_KINDS.length * 3);
    expect(LEVEL_KINDS.length).toBeGreaterThan(1);
  });

  it("a drive that played a level result but recorded no kind is a harness defect, named — never a default", () => {
    expect(() => bracketCaseOf(drive({ asked: { kind: "level" }, levelAs: null }))).toThrow(LevelKindUnread);
    expect(() => bracketCaseOf(drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, levelAs: null }))).toThrow(LevelKindUnread);
    // and a request that plays none needs none: its positive pair
    expect(bracketCaseOf(drive({ asked: { kind: "win", winner: "home" }, levelAs: null }))).toMatchObject({ play: { kind: "win" } });
  });

  it("the oracle tells the kinds apart: the SAME held answer agrees for one kind and disagrees for another (generic draw vs tie, chess draw vs tie), over the whole table", () => {
    let agreed = 0;
    let disagreed = 0;
    for (const [sport, kind, status] of HELD) {
      const held = judgeDrive(drive({ asked: { kind: "level" }, sport, levelAs: kind, status: "needs_decision", outcome: { kind: kind === "no_result" ? "no_result" : kind } as ObservedOutcome }));
      const ok = status === "needs_decision";
      expect(held, `${sport}/${kind}`).toMatchObject({ judged: true, ok });
      if (ok) agreed++; else disagreed++;
      // The product that shows the status the oracle names agrees (the pair of the line above).
      const right = judgeDrive(drive({ asked: { kind: "level" }, sport, levelAs: kind, status, outcome: status === "needs_decision" ? { kind: kind === "no_result" ? "no_result" : kind } as ObservedOutcome : null }));
      // generic draw is refused (index -1): the harness drove it as legal, so the check reds by the refusal either way.
      expect(right, `${sport}/${kind}`).toMatchObject({ judged: true, ok: sport === "generic" && kind === "draw" ? false : true });
    }
    expect(agreed + disagreed).toBe(HELD.length);
    expect(disagreed).toBe(2); // generic draw (refused) and chess draw (awaits its tie-break): the two rows where a held answer is wrong
    expect(agreed).toBeGreaterThan(0);
  });

  it("levelKindOf: a draw or tie request is that kind; a level request is what the ENGINE's fold of its stream says — a draw where the sport ends level as one (drawsAllowed), else a tie — over every sport that reaches a level result; requests that play none are null", () => {
    let judged = 0;
    let draws = 0;
    let ties = 0;
    const kindOf = new Map<string, string | null>();
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "knockout");
      if (!levelReachable(sport, cfg, "knockout")) continue;
      const events = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "level" } });
      const got = levelKindOf(sport, cfg, "h", "a", { kind: "level" }, events);
      expect(got, sport).toBe(drawsAllowed(sport, cfg, "league") ? "draw" : "tie");
      if (got === "draw") draws++; else ties++;
      kindOf.set(sport, got);
      // A settle after the level result reads the same kind from the same events (the settle itself is not played).
      const settled = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "settle", then: "home", method: "lot", after: "level" } });
      expect(levelKindOf(sport, cfg, "h", "a", { kind: "settle", then: "home", method: "lot", after: "level" }, settled), sport).toBe(got);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
    expect(draws).toBeGreaterThan(0);
    expect(ties).toBeGreaterThan(0);
    expect(draws + ties).toBe(judged);
    // Per sport (the counts above are totals): generic contributes NOTHING — GN-KO-1 refuses its draw in a bracket and
    // it has no tie, so it never reaches a level result there — and cricket is the registry's one sport that ends
    // level as a TIE (single-sport pin: the rulebook's X-BR-1 tie row is cricket's).
    expect(kindOf.has("generic"), "GN-KO-1: a generic bracket game cannot end level").toBe(false);
    expect([...kindOf].filter(([, k]) => k === "tie").map(([sport]) => sport)).toEqual(["cricket"]);
    expect(levelKindOf("football", {}, "h", "a", { kind: "draw" }, [])).toBe("draw");
    expect(levelKindOf("football", {}, "h", "a", { kind: "tie" }, [])).toBe("tie");
    for (const asked of [{ kind: "win", winner: "home" }, { kind: "abandon" }, { kind: "settle", then: "home", method: "lot", after: "abandon" }, { kind: "forfeit", by: "home", reason: "walkover" }] as const) {
      expect(levelKindOf("football", {}, "h", "a", asked, []), asked.kind).toBeNull();
    }
  });

  it("levelKindOf reads a chess tie-break as a DRAWN game, from the stream's own result; a stream that folds to a win is refused by name", () => {
    const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout");
    const tb = generateStream({ sportKey: "boardgame", cfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "tiebreak", rung: "rapid", winner: "home" } });
    expect(levelKindOf("boardgame", cfg, "h", "a", { kind: "tiebreak", rung: "rapid", winner: "home" }, tb)).toBe("draw");
    const win = generateStream({ sportKey: "football", cfg: resolveSportCfg("football", offlineBuilderDefault("football")), stageKind: "knockout", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
    expect(() => levelKindOf("football", resolveSportCfg("football", offlineBuilderDefault("football")), "h", "a", { kind: "level" }, win)).toThrow(LevelKindUnread);
    expect(() => levelKindOf("boardgame", cfg, "h", "a", { kind: "tiebreak", rung: "rapid", winner: "home" }, [])).toThrow(LevelKindUnread);
  });
});

describe("the loser line — where the ENGINE's bracket wires a loser, and who the product seated there", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
  /** Rows of an engine bracket as the product stores them: ext_key = the generator's fixture id, seats from its round 1. */
  const rowsOf = (gen: { fixtures: readonly { id: string; home?: string; away?: string }[] }, over: Record<string, Partial<FixtureRow>> = {}): FixtureRow[] =>
    gen.fixtures.map((g, i) => ({ id: `row-${g.id}`, stage_id: "s", pool_id: null, round_no: 1, fixture_no: i + 1, home_entrant_id: g.home ?? null, away_entrant_id: g.away ?? null, status: "scheduled", outcome: null, ext_key: g.id, ...over[g.id] }));
  const seatOf = (kind: string, rows: readonly FixtureRow[], extKey: string, config: Record<string, unknown> = {}) => loserSeatOf(kind, config, rows.find((r) => r.ext_key === extKey)!, rows);

  it("a page playoff wires ONE loser line: the first qualifier's loser into the second qualifier's home (pp-q1 → pp-q2); no other match has one", () => {
    const rows = rowsOf(generatePagePlayoff({ entrants: ids(4) }));
    const lines = rows.map((r) => [r.ext_key, loserSeatOf("page_playoff", {}, r, rows).line] as const);
    expect(lines.filter(([, l]) => l === "seat").map(([k]) => k)).toEqual(["pp-q1"]);
    expect(lines.filter(([, l]) => l === "none")).toHaveLength(3);
    expect(seatOf("page_playoff", rows, "pp-q1")).toEqual({ line: "seat", target: "pp-q2", slot: "home", seated: null });
    // who sits there is read from the product's row, not assumed
    const seated = rowsOf(generatePagePlayoff({ entrants: ids(4) }), { "pp-q2": { home_entrant_id: "e2" } });
    expect(seatOf("page_playoff", seated, "pp-q1")).toMatchObject({ seated: "e2" });
  });

  it("a stepladder has none, a knockout has one only with a third-place match (the two semis' losers), a four-team double elim has one from each winners'-bracket match", () => {
    const step = rowsOf(generateStepladder({ entrants: ids(4) }));
    expect(step.filter((r) => loserSeatOf("stepladder", {}, r, step).line === "seat")).toEqual([]);
    expect(step).toHaveLength(3);
    const plain = rowsOf(generateSingleElim({ entrants: ids(4), thirdPlace: false }));
    expect(plain.filter((r) => loserSeatOf("knockout", {}, r, plain).line === "seat")).toEqual([]);
    const third = rowsOf(generateSingleElim({ entrants: ids(4), thirdPlace: true }));
    const semis = third.filter((r) => loserSeatOf("knockout", { thirdPlace: true }, r, third).line === "seat");
    expect(semis).toHaveLength(2); // the two semi-finals, whoever the engine names them
    expect(new Set(semis.map((r) => (loserSeatOf("knockout", { thirdPlace: true }, r, third) as { target: string }).target)).size).toBe(1); // one third-place match
    const de = rowsOf(generateDoubleElim({ entrants: ids(4) }));
    // Four teams: two WB round-1 matches and the WB final drop their losers into the LB; the LB and the grand final do not.
    expect(de.filter((r) => loserSeatOf("double_elim", {}, r, de).line === "seat")).toHaveLength(3);
    expect(de.length).toBeGreaterThan(3);
  });

  it("unresolved, by name, never guessed: no ext_key, a stage with no generator, an engine layout the product's rows do not match, a size the engine refuses", () => {
    const rows = rowsOf(generatePagePlayoff({ entrants: ids(4) }));
    const noKey = rows.map((r) => ({ ...r, ext_key: undefined }));
    expect(loserSeatOf("page_playoff", {}, noKey[0]!, noKey)).toEqual({ line: "unresolved", why: expect.stringMatching(/carries no ext_key/) });
    expect(loserSeatOf("league", {}, rows[0]!, rows)).toEqual({ line: "unresolved", why: expect.stringMatching(/no bracket generator for 'league'/) });
    expect(loserSeatOf("page_playoff", {}, rows[0]!, rows.filter((r) => r.ext_key !== "pp-final"))).toEqual({ line: "unresolved", why: expect.stringMatching(/is not the stage the product stored/) });
    const five = rowsOf(generateSingleElim({ entrants: ids(5), thirdPlace: false }));
    expect(loserSeatOf("page_playoff", {}, five[0]!, five)).toEqual({ line: "unresolved", why: expect.stringMatching(/lays out no page_playoff for 5 entrants \(CONFIG_INVALID\)/) });
  });

  it("an engine that wired two loser lines out of one match, or a loser line into a fixture the product never stored, is unresolved by name (a guard, reached with an injected layout)", () => {
    const rows = rowsOf(generatePagePlayoff({ entrants: ids(4) }));
    const doubled = { page_playoff: () => ({ rounds: 3, fixtures: [
      { id: "pp-q1", round: 0, home: "e1", away: "e2" }, { id: "pp-elim", round: 0, home: "e3", away: "e4" },
      { id: "pp-q2", round: 1, homeFrom: { fixtureId: "pp-q1", side: "loser" as const }, awayFrom: { fixtureId: "pp-q1", side: "loser" as const } },
      { id: "pp-final", round: 2, isFinal: true },
    ] }) } as unknown as Parameters<typeof loserSeatOf>[4];
    expect(loserSeatOf("page_playoff", {}, rows[0]!, rows, doubled)).toEqual({ line: "unresolved", why: expect.stringMatching(/wires 2 loser lines out of pp-q1/) });
    // the engine's own layout is the positive pair: one line
    expect(loserSeatOf("page_playoff", {}, rows[0]!, rows)).toMatchObject({ line: "seat" });
  });

  /** A drive on a page playoff's first qualifier (4 entrants a b c d: a v b, then the loser into pp-q2 home). */
  const q1 = (over: Partial<BracketDrive> & { seated: string | null }): BracketDrive => {
    const { seated, ...rest } = over;
    return drive({ stageKind: "page_playoff", asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a"), loser: { line: "seat", target: "pp-q2", slot: "home", seated }, ...rest });
  };

  it("the loser is judged: the loser seated where the engine wires it agrees; the WINNER there, nobody there, or a stranger there each red on their own", () => {
    expect(judgeDrive(q1({ seated: "b" }))).toMatchObject({ judged: true, ok: true });
    const wrong: readonly [string, string | null, RegExp][] = [
      ["the winner seated on the loser line", "a", /loser: oracle seats away \(b\) in pp-q2 home, product seated a/],
      ["nobody seated", null, /product seated nobody/],
      ["a stranger seated", "zz", /product seated zz/],
    ];
    let reds = 0;
    for (const [label, seated, why] of wrong) {
      const j = judgeDrive(q1({ seated }));
      expect(j, label).toMatchObject({ judged: true, ok: false });
      expect(j.judged ? j.note : "", label).toMatch(why);
      reds++;
    }
    expect(reds).toBe(wrong.length);
  });

  it("a HELD match seats nobody on its loser line either: the loser (or the winner) already there reds, an empty slot agrees; a match with no engine line is not compared", () => {
    const held = (seated: string | null) => q1({ asked: { kind: "level" }, status: "needs_decision", outcome: { kind: "draw" }, seated });
    expect(judgeDrive(held(null))).toMatchObject({ judged: true, ok: true });
    expect(judgeDrive(held("b"))).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/nobody advances, yet the product seated b in pp-q2 home/) });
    expect(judgeDrive(held("a"))).toMatchObject({ judged: true, ok: false });
    // line none: whoever sits elsewhere is not this check's business (the bracket invariants own it)
    expect(judgeDrive(drive({ stageKind: "page_playoff", asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a"), loser: { line: "none" } }))).toMatchObject({ judged: true, ok: true });
  });

  it("an unresolved loser line judges everything else, and says it did not judge the loser; the assertion counts and names it", () => {
    const d = drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a"), loser: { line: "unresolved", why: "fixture f1 carries no ext_key" } });
    expect(judgeDrive(d)).toMatchObject({ judged: true, ok: true, loserNotJudged: "fixture f1 carries no ext_key" });
    expect(judgeDrive(drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a") }))).toMatchObject({ loserNotJudged: null });
    const rec = new Recorder();
    rec.bracketDrives.push(d, { ...d, fixtureId: "f2" });
    const out = referenceBracketFinish(rec, { caseId: "c", facts: [], withdrawal: null, configEdit: null, stages: [{ id: "s1", seq: 1, kind: "knockout", config: {}, field: ["a", "b"], fieldSource: "division", fixtures: [], standings: [], generates: [], pairRounds: [], complete: null }] });
    expect(out).toMatchObject({ verdict: "pass", checked: 2 });
    expect(out.reason).toMatch(/loser seat not judged on 2 drive\(s\) \(fixture f1 carries no ext_key\)/);
  });

  it("through a driver: LIFECYCLE on the page-playoff fake judges the loser line against the engine's wiring (and the plain knockout fake, which keeps no ext_key, says it could not)", async () => {
    const sport = "football";
    const variant = offlineBuilderDefault(sport);
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    const spec: CaseSpec = { caseId: "page_playoff_only|football|LIFECYCLE", row: "page_playoff_only", sport, variant, scenario: "LIFECYCLE", canary: false };
    const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    await driver.start();
    const q1Row = driver.fixtures.find((f) => f.ext_key === "pp-q1")!;
    await decideFixture(ctx, rec, setup, q1Row, { kind: "win", winner: "home" }, setup.stage);
    expect(rec.bracketDrives).toHaveLength(1);
    const d = rec.bracketDrives[0]!;
    const loser = q1Row.away_entrant_id!;
    expect(d.loser).toEqual({ line: "seat", target: "pp-q2", slot: "home", seated: loser });
    expect(judgeDrive(d)).toMatchObject({ judged: true, ok: true, loserNotJudged: null });
    // The same drive with nobody on the loser line reds on exactly the loser.
    const dropped: BracketDrive = { ...d, loser: { ...(d.loser as Extract<BracketDrive["loser"], { line: "seat" }>), seated: null } };
    expect(judgeDrive(dropped)).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/product seated nobody/) });
    const check = (await (async () => {
      const out = await SCENARIOS.LIFECYCLE.run({ driver: new FakeKnockoutDriver({ pagePlayoff: true }), spec: { ...spec, variant: "win_loss", sport: "generic" }, orgSlug: "o", cfg: resolveSportCfg("generic", "win_loss"), tag: "t", denied: [] });
      return out.assertions.find((c) => c.id === "life-reference-bracket-finish")!;
    })());
    expect(check).toMatchObject({ verdict: "pass" });
    expect(check.checked).toBeGreaterThan(0);
    expect(check.reason).not.toMatch(/loser seat not judged/);
  });
});

describe("life-reference-bracket-finish — the counted assertion", () => {
  const run = (kind: string): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind, config: {}, field: ["a", "b"], fieldSource: "division", fixtures: [] as ObservedFixture[], standings: [], generates: [], pairRounds: [], complete: null }],
  });
  const recWith = (...drives: BracketDrive[]): Recorder => {
    const rec = new Recorder();
    rec.bracketDrives.push(...drives);
    return rec;
  };
  const good = drive({ asked: { kind: "win", winner: "home" }, outcome: win("a") });

  it("empty case first: no bracket stage abstains BY NAME; a bracket stage with nothing judged FAILS (R25), even with drives that were all not judged", () => {
    expect(referenceBracketFinish(new Recorder(), run("league"))).toMatchObject({ id: "life-reference-bracket-finish", verdict: "abstain", checked: 0 });
    expect(referenceBracketFinish(new Recorder(), run("knockout"))).toMatchObject({ verdict: "fail", checked: 0 });
    const walkover = drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") });
    expect(referenceBracketFinish(recWith(walkover), run("knockout"))).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("agreement passes with the judged count; the not-judged drives are counted and named in the reason; one disagreement fails with its note", () => {
    expect(referenceBracketFinish(recWith(good, { ...good, fixtureId: "f2" }), run("knockout"))).toMatchObject({ verdict: "pass", checked: 2 });
    const walkover = drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") });
    const mixed = referenceBracketFinish(recWith(good, walkover), run("knockout"));
    expect(mixed).toMatchObject({ verdict: "pass", checked: 1 });
    expect(mixed.reason).toMatch(/1 drive\(s\) not judged \(forfeit: a walkover/);
    const bad = referenceBracketFinish(recWith(good, drive({ fixtureId: "f9", asked: { kind: "level" }, status: "decided", outcome: { kind: "draw" } })), run("knockout"));
    expect(bad).toMatchObject({ verdict: "fail", checked: 2 });
    expect(bad.evidence[0]).toMatch(/^f9 \(knockout x football, asked level\): status: oracle needs_decision, product decided/);
  });
});

describe("LIFECYCLE on the knockout fake — the oracle agrees with every sport's bracket, and a wrong product reds the check", () => {
  async function life(sport: string, driver: FakeKnockoutDriver) {
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|LIFECYCLE`, row: "knockout", sport, variant, scenario: "LIFECYCLE", canary: false };
    const out = await SCENARIOS.LIFECYCLE.run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    return [...evaluateInvariants(out.observed), ...out.assertions];
  }

  it("positive: every sport's bracket is judged and agrees, with a counted item and the deciders among them", async () => {
    let sports = 0;
    let items = 0;
    for (const sport of SPORT_KEYS) {
      const check = (await life(sport, new FakeKnockoutDriver())).find((c) => c.id === "life-reference-bracket-finish")!;
      expect(check, sport).toMatchObject({ verdict: "pass" });
      expect(check.checked, sport).toBeGreaterThan(0);
      items += check.checked;
      sports++;
    }
    expect(sports).toBe(SPORT_KEYS.length);
    expect(items).toBeGreaterThanOrEqual(sports);
  });

  it("negative: a product that leaves every settled match ABANDONED reds the reference check on its status (and the positive pair above passes)", async () => {
    class SettleLeavesAbandoned extends FakeKnockoutDriver {
      override async postStream(id: string, events: Parameters<FakeKnockoutDriver["postStream"]>[1], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        if (events.at(-1)?.type !== "core.settle") return out;
        const f = this.fixtures.find((x) => x.id === id)!;
        f.status = "abandoned";
        return out.map((p, i) => (i === out.length - 1 ? { ...p, status: "abandoned" } : p));
      }
    }
    const checks = await life("football", new SettleLeavesAbandoned());
    const check = checks.find((c) => c.id === "life-reference-bracket-finish")!;
    expect(check.verdict).toBe("fail");
    expect(check.evidence.join("\n")).toMatch(/status: oracle decided, product abandoned/);
  });
});
