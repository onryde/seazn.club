// W2a (controller ruling T15-R3): the harness judges every bracket match it drives against the reference family
// `bracket-finish` (@seazn/reference). The oracle's answers here are the rulebook's (X-BR-1, X-BR-2, X-ST-1, X-ST-2,
// BG-KO-1, CA-KO-1); the products are hand-built or a fake made wrong on purpose. Needs the reference lane merged
// into this one (the family's exports): red until then.
import { StageKind } from "@seazn/engine/core";
import { FORFEIT_REASONS as REFERENCE_FORFEIT_REASONS, LEVEL_KINDS, NoReferenceFamily, type LevelKind, type PlayResult } from "@seazn/reference";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedOutcome, ObservedRun } from "../lib/observed.ts";
import { Recorder, decideFixture, setUpDivision } from "../lib/scenarios/common.ts";
import { referenceBracketFinish } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { ForfeitPlayUnread, LevelKindUnread, SanctionEndUnjudged, bracketCaseOf, forfeitPlayOf, judgeDrive, levelKindOf, loserSeatOf, nextLineOf, oracleMethod, type BracketDrive } from "../lib/reference-bracket.ts";
import { decidersOffRulesFor, drawsAllowed, resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream, levelReachable } from "../lib/streams/index.ts";
import { RefusedCall, type FixtureRow } from "../lib/driver/types.ts";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder } from "@seazn/engine/scheduling";
import { endingReasonOf } from "../lib/streams/sanction.ts";
import { GeneratorUnsupported, OutcomeUnreachable, type RequestedOutcome } from "../lib/streams/types.ts";
import { w2bCells } from "../lib/w2b-cells.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

/** The level kind a hand-built drive plays when a test does not say: its request's own, a drawn game for a `level`
 *  request, a tie-break and a settle (a chess game and football both END level as a draw). The cases that depend on
 *  the kind (generic, cricket) say it. */
const defaultLevel = (a: RequestedOutcome): LevelKind | null =>
  a.kind === "tie" ? "tie" : a.kind === "draw" || a.kind === "level" || a.kind === "tiebreak" || (a.kind === "settle" && a.after === "level") ? "draw" : null;
/** The play a hand-built forfeit drive was recorded on when a test does not say: a walkover and a double walkover
 *  bare, before START; a forfeit `after_start` on a match under way (forfeitPlayOf reads it from a real stream). */
const defaultForfeitPlay = (a: RequestedOutcome): PlayResult | null =>
  a.kind === "double_walkover" ? { kind: "none" } : a.kind === "forfeit" ? (a.at === "before_start" ? { kind: "none" } : { kind: "in_progress" }) : a.kind === "sanctionEnd" ? { kind: "in_progress" } : null;
const drive = (over: Partial<BracketDrive> & { asked: RequestedOutcome }): BracketDrive =>
  ({ fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", levelAs: defaultLevel(over.asked), status: "decided", outcome: null, loser: { line: "none" }, next: { line: "next", target: "f-next" }, forfeitPlay: defaultForfeitPlay(over.asked), refusal: null, ...over });
const award = (winner: string, loser: string, reason: string): ObservedOutcome => ({ kind: "award", winner, loser, reason });
const win = (winner: string, method?: string): ObservedOutcome => ({ kind: "win", winner, ...(method === undefined ? {} : { method }) });

describe("oracleMethod — the product's method as the oracle names it", () => {
  it("settled_* and tiebreak_* keep their names; every play win, named or not, is `play`", () => {
    for (const m of ["settled_lot", "settled_higher_seed", "settled_organiser", "tiebreak_rapid", "tiebreak_blitz", "tiebreak_armageddon"]) expect(oracleMethod(m), m).toBe(m);
    for (const m of [undefined, "checkmate", "resign", "points", "forfeit", "settled", "tiebreak", "bye"]) expect(oracleMethod(m), String(m)).toBe("play");
  });

  it("I-3: every X-RS-1 forfeit reason keeps its name (the oracle's forfeit method IS the reason), counted over the rulebook's list", () => {
    let checked = 0;
    for (const reason of REFERENCE_FORFEIT_REASONS) {
      expect(oracleMethod(reason), reason).toBe(reason);
      checked++;
    }
    expect(checked).toBe(4); // X-RS-1: walkover, retired, disqualified, withdrew
  });
});

describe("bracketCaseOf — the harness's drive, in the rulebook's terms", () => {
  it("each request kind maps to its play result and actions", () => {
    const of = (asked: RequestedOutcome, over: Partial<BracketDrive> = {}) => bracketCaseOf(drive({ asked, ...over }));
    expect(of({ kind: "win", winner: "away" })).toMatchObject({ play: { kind: "win", winner: "away" }, actions: [] });
    for (const kind of ["level", "draw", "tie"] as const) expect(of({ kind }, { levelAs: kind === "tie" ? "tie" : "draw" }), kind).toMatchObject({ play: { kind: "level" }, actions: [] });
    expect(of({ kind: "settle", then: "home", method: "lot", after: "level" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "settle", winner: "home", method: "lot", by: "organiser" }] });
    expect(of({ kind: "settle", then: "away", method: "organiser", after: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "away", method: "organiser", by: "organiser" }] });
    expect(of({ kind: "tiebreak", rung: "blitz", winner: "home" }, { sport: "boardgame" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "tiebreak", rung: "blitz", winner: "home" }] });
    expect(of({ kind: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }] });
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

  it("not judged, named: a double walkover whose next-match line could not be read, a driver that answered no status, and the oracle's own RuledOut; a stage kind with no family is the LOUD NoReferenceFamily", () => {
    expect(judgeDrive(drive({ asked: { kind: "double_walkover" }, next: { line: "unresolved", why: "fixture f1 carries no ext_key" }, status: "forfeited", outcome: { kind: "double_walkover" } }))).toEqual({ judged: false, why: expect.stringMatching(/double_walkover: whether f1 feeds a next match could not be read \(fixture f1 carries no ext_key\)/) });
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
      // The held arm (R-T12-3): a level result is reachable in a knockout only with every decider off, as a hold-path
      // cell posts it.
      const variant = offlineBuilderDefault(sport);
      const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant, decidersOffRulesFor(sport, variant, "knockout"));
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
    for (const asked of [{ kind: "win", winner: "home" }, { kind: "abandon" }, { kind: "settle", then: "home", method: "lot", after: "abandon" }, { kind: "forfeit", by: "home", reason: "walkover", at: "before_start" }] as const) {
      expect(levelKindOf("football", {}, "h", "a", asked, []), asked.kind).toBeNull();
    }
  });

  it("levelKindOf reads a chess tie-break as a DRAWN game, from the stream's own result; a stream that folds to a win is refused by name", () => {
    const cfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
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

  /** A double walkover the oracle cannot judge (its next-match line is unread): counted and named, never judged. */
  const unreadDw = drive({ fixtureId: "f7", asked: { kind: "double_walkover" }, next: { line: "unresolved", why: "fixture f7 carries no ext_key" }, status: "forfeited", outcome: { kind: "double_walkover" } });
  const walkover = drive({ fixtureId: "f8", asked: { kind: "forfeit", by: "home", reason: "walkover", at: "before_start" }, status: "forfeited", outcome: award("b", "a", "walkover") });

  it("empty case first: no bracket stage abstains BY NAME; a bracket stage with nothing judged FAILS (R25), even with drives that were all not judged", () => {
    expect(referenceBracketFinish(new Recorder(), run("league"))).toMatchObject({ id: "life-reference-bracket-finish", verdict: "abstain", checked: 0 });
    expect(referenceBracketFinish(new Recorder(), run("knockout"))).toMatchObject({ verdict: "fail", checked: 0 });
    expect(referenceBracketFinish(recWith(unreadDw), run("knockout"))).toMatchObject({ verdict: "fail" });
  });

  it("agreement passes with the judged count; the not-judged drives are counted and named in the reason; one disagreement fails with its note", () => {
    expect(referenceBracketFinish(recWith(good, { ...good, fixtureId: "f2" }), run("knockout"))).toMatchObject({ verdict: "pass", checked: 2 });
    const mixed = referenceBracketFinish(recWith(good, walkover, unreadDw, { ...unreadDw, fixtureId: "f6", next: { line: "next", target: "f-next" } }), run("knockout"));
    expect(mixed).toMatchObject({ verdict: "pass", checked: 3 });
    expect(mixed.reason).toMatch(/1 drive\(s\) not judged \(double_walkover: whether f7 feeds a next match could not be read/);
    const bad = referenceBracketFinish(recWith(good, drive({ fixtureId: "f9", asked: { kind: "level" }, status: "decided", outcome: { kind: "draw" } })), run("knockout"));
    expect(bad).toMatchObject({ verdict: "fail", checked: 2 });
    expect(bad.evidence[0]).toMatch(/^f9 \(knockout x football, asked level\): status: oracle needs_decision, product decided/);
  });
});

// Task 24 (G12): a sanction that ends the match reaches the oracle as the SAME forfeit action - the sanctioned side the offender, the
// reason the engine's ending rule gives the level - on a match under way. Expected values: the rulebook's (BD-SE-1 and TN-SE-1
// disqualified; VB-SE-1 / VB-RT-1 the incomplete-team `retired`), typed once; the ledger's sports are the modules' declarations.
describe("G12 (Task 24): a sanction ending is the oracle's forfeit action, in the reason the level calls for", () => {
  const SE = SPORT_KEYS.filter((s) => sportModule(s).sanctionEnding !== undefined);
  const levels = (sport: string): string[] => [...sportModule(sport).sanctionEnding!.endLevels, ...sportModule(sport).sanctionEnding!.promptLevels];
  const RULEBOOK: Readonly<Record<string, "disqualified" | "retired">> = { badminton: "disqualified", tennis: "disqualified", volleyball: "retired" };
  const se = (by: "home" | "away", level: string): RequestedOutcome => ({ kind: "sanctionEnd", by, level });

  it("the case is the forfeit action with the sanctioned side as offender and the level's reason, over every sanction sport, level and side - counted; and the awards agree with the oracle (the credited side advances by the reason)", () => {
    let checked = 0;
    for (const sport of SE) {
      for (const level of levels(sport)) for (const by of ["home", "away"] as const) {
        const reason = RULEBOOK[sport]!;
        expect(endingReasonOf(sport, level), `${sport} ${level}`).toBe(reason);
        const c = bracketCaseOf(drive({ sport, asked: se(by, level) }));
        expect(c, `${sport} ${level} ${by}`).toMatchObject({ play: { kind: "in_progress" }, actions: [{ kind: "forfeit", offender: by, reason, by: "organiser" }], hasNextMatch: true });
        const winner = by === "home" ? "b" : "a";
        const loser = by === "home" ? "a" : "b";
        expect(judgeDrive(drive({ sport, asked: se(by, level), status: "forfeited", outcome: award(winner, loser, reason) })), `${sport} ${level} ${by} right answer`).toMatchObject({ judged: true, ok: true });
        // The wrong answers: the award to the sanctioned side, and the other reason (the right one differs from the wrong one's constant).
        const wrongReason = reason === "retired" ? "disqualified" : "retired";
        expect(judgeDrive(drive({ sport, asked: se(by, level), status: "forfeited", outcome: award(loser, winner, reason) })), `${sport} ${level} ${by} award to the offender`).toMatchObject({ judged: true, ok: false });
        expect(judgeDrive(drive({ sport, asked: se(by, level), status: "forfeited", outcome: award(winner, loser, wrongReason) })), `${sport} ${level} ${by} ${wrongReason}`).toMatchObject({ judged: true, ok: false });
        expect(judgeDrive(drive({ sport, asked: se(by, level), status: "decided", outcome: win(winner) })), `${sport} ${level} ${by} a plain win`).toMatchObject({ judged: true, ok: false });
        checked++;
      }
    }
    expect(SE.length).toBeGreaterThan(0);
    expect(checked).toBe(SE.reduce((n, s) => n + levels(s).length * 2, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("refused by name, never judged as some other case: a level that ends nothing, a drive that recorded no play, and a drive whose match was not under way", () => {
    expect(() => bracketCaseOf(drive({ sport: "badminton", asked: se("home", "warning") }))).toThrow(SanctionEndUnjudged);
    expect(() => bracketCaseOf(drive({ sport: "badminton", asked: se("home", "warning") }))).toThrow(/ends nothing/);
    expect(() => bracketCaseOf(drive({ sport: "football", asked: se("home", "red") }))).toThrow(SanctionEndUnjudged);
    expect(() => bracketCaseOf(drive({ sport: "badminton", asked: se("home", "disqualification"), forfeitPlay: null }))).toThrow(ForfeitPlayUnread);
    for (const play of [{ kind: "none" }, { kind: "started" }] as const) {
      expect(() => bracketCaseOf(drive({ sport: "badminton", asked: se("home", "disqualification"), forfeitPlay: play })), play.kind).toThrow(SanctionEndUnjudged);
      expect(() => bracketCaseOf(drive({ sport: "badminton", asked: se("home", "disqualification"), forfeitPlay: play })), play.kind).toThrow(/not under way/);
    }
  });
});

// I-3 (Task 15 review): the W2b forfeit is one of the oracle's actions. Every expected answer below is the rulebook's
// (X-RS-1 reasons and phases, X-RS-3 / PF-2 writers, X-DW-1 / X-DW-3 double walkovers, X-DE-1 the forfeit loser,
// BG-WO-2 chess, plan D3 R2-R4 and D19), never the family's code.
describe("I-3: a W2b forfeit and a double walkover reach the oracle as its forfeit action, and the comparison counts them", () => {
  const fw = (by: "home" | "away", reason: (typeof REFERENCE_FORFEIT_REASONS)[number], at: "before_start" | "after_start"): RequestedOutcome => ({ kind: "forfeit", by, reason, at });

  it("a forfeit is the forfeit action — offender, reason and writer (the harness posts as the organiser) — on the play the drive recorded; a double walkover is offender `both`, a walkover; the next-match line goes through", () => {
    const of = (asked: RequestedOutcome, over: Partial<BracketDrive> = {}) => bracketCaseOf(drive({ asked, ...over }));
    let checked = 0;
    for (const reason of REFERENCE_FORFEIT_REASONS) {
      for (const by of ["home", "away"] as const) {
        expect(of(fw(by, reason, "after_start")), `${by} ${reason}`).toMatchObject({ play: { kind: "in_progress" }, actions: [{ kind: "forfeit", offender: by, reason, by: "organiser" }], hasNextMatch: true });
        checked++;
      }
    }
    expect(checked).toBe(REFERENCE_FORFEIT_REASONS.length * 2);
    expect(of(fw("away", "walkover", "before_start"))).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "forfeit", offender: "away", reason: "walkover", by: "organiser" }] });
    expect(of({ kind: "double_walkover" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "forfeit", offender: "both", reason: "walkover", by: "organiser" }], hasNextMatch: true });
    expect(of({ kind: "double_walkover" }, { next: { line: "none" } })).toMatchObject({ hasNextMatch: false });
    // X-DW-3's line is a double walkover's alone: a one-sided forfeit whose line is unread is still judged.
    expect(of(fw("home", "walkover", "before_start"), { next: { line: "unresolved", why: "x" } })).toMatchObject({ actions: [{ kind: "forfeit", offender: "home" }] });
    // The play is the drive's own record, never a default.
    expect(() => of(fw("home", "retired", "after_start"), { forfeitPlay: null })).toThrow(ForfeitPlayUnread);
    expect(() => of({ kind: "double_walkover" }, { forfeitPlay: null })).toThrow(ForfeitPlayUnread);
  });

  const page = (seated: string | null): Partial<BracketDrive> => ({ stageKind: "page_playoff", loser: { line: "seat", target: "pp-q2", slot: "home", seated } });
  const AGREE: readonly [string, BracketDrive][] = [
    ["a walkover before play (X-RS-1, X-WO-1): forfeited, the opponent advances by walkover", drive({ asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("a", "b", "walkover") })],
    ["a retirement in play (X-RT-1)", drive({ asked: fw("home", "retired", "after_start"), status: "forfeited", outcome: award("b", "a", "retired") })],
    ["a disqualification in play (X-RS-1)", drive({ asked: fw("away", "disqualified", "after_start"), status: "forfeited", outcome: award("a", "b", "disqualified") })],
    ["a chess walkover with the game under way (BG-WO-2)", drive({ sport: "boardgame", asked: fw("home", "walkover", "after_start"), status: "forfeited", outcome: award("b", "a", "walkover") })],
    ["a double walkover with a next match (X-DW-1): forfeited, nobody advances", drive({ asked: { kind: "double_walkover" }, status: "forfeited", outcome: { kind: "double_walkover" } })],
    ["a ladder double walkover (D19: a ladder wires no feed edge)", drive({ stageKind: "ladder", asked: { kind: "double_walkover" }, next: { line: "none" }, status: "forfeited", outcome: { kind: "double_walkover" } })],
    ["a forfeit's loser is not seated on the loser line (X-DE-1)", drive({ ...page(null), asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("a", "b", "walkover") })],
    ["a double walkover seats nobody on the loser line (X-DW-1)", drive({ ...page(null), asked: { kind: "double_walkover" }, status: "forfeited", outcome: { kind: "double_walkover" } })],
  ];

  it("positive: every rulebook-correct forfeit answer agrees, counted (a forfeit's method is its reason, so the old `play` reading reds every row here)", () => {
    let judged = 0;
    for (const [label, d] of AGREE) {
      expect(judgeDrive(d), label).toMatchObject({ judged: true, ok: true });
      judged++;
    }
    expect(judged).toBe(AGREE.length);
  });

  it("negative: a wrong product, or a forfeit the rules refuse, reds on exactly what is wrong", () => {
    const wrong: readonly [string, BracketDrive, RegExp][] = [
      ["a walkover left decided", drive({ asked: fw("away", "walkover", "before_start"), status: "decided", outcome: award("a", "b", "walkover") }), /status: oracle forfeited, product decided/],
      ["the award to the offender", drive({ asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("b", "a", "walkover") }), /oracle says home advances, product advanced away/],
      ["a walkover recorded as a retirement", drive({ asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("a", "b", "retired") }), /method: oracle walkover, product retired/],
      ["a walkover recorded as a play win", drive({ asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: win("a") }), /method: oracle walkover, product play/],
      ["a forfeit that advanced nobody", drive({ asked: fw("home", "retired", "after_start"), status: "forfeited", outcome: null }), /product advanced nobody/],
      ["a double walkover that advanced somebody", drive({ asked: { kind: "double_walkover" }, status: "forfeited", outcome: win("a") }), /oracle says nobody advances, product advanced a/],
      ["a double walkover accepted on a final (X-DW-3)", drive({ asked: { kind: "double_walkover" }, next: { line: "none" }, status: "forfeited", outcome: { kind: "double_walkover" } }), /refuses action 0 with DOUBLE_WALKOVER_NO_NEXT_MATCH/],
      ["a retirement accepted before play (D3 R4)", drive({ asked: fw("home", "retired", "before_start"), status: "forfeited", outcome: award("b", "a", "retired") }), /refuses action 0 with FORFEIT_REASON_WRONG_PHASE/],
      ["a football walkover accepted with the match under way (D3 R2)", drive({ asked: fw("home", "walkover", "after_start"), status: "forfeited", outcome: award("b", "a", "walkover") }), /refuses action 0 with FORFEIT_REASON_WRONG_PHASE/],
      ["`withdrew` accepted from the organiser (PF-2)", drive({ asked: fw("home", "withdrew", "before_start"), status: "forfeited", outcome: award("b", "a", "withdrew") }), /refuses action 0 with INVALID_EVENT/],
      ["a forfeit's loser seated on the loser line (X-DE-1)", drive({ ...page("b"), asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("a", "b", "walkover") }), /loser: oracle seats nobody on pp-q2 home \(a forfeit's loser\), product seated b/],
    ];
    let reds = 0;
    for (const [label, d, why] of wrong) {
      const j = judgeDrive(d);
      expect(j, label).toMatchObject({ judged: true, ok: false });
      expect(j.judged ? j.note : "", label).toMatch(why);
      reds++;
    }
    expect(reds).toBe(wrong.length);
  });

  it("forfeitPlayOf reads the play from the stream the harness posted, over every sport: a walkover is bare (none), a retirement follows START (in_progress once a sport event is played, started on a bare START — ruling 112); a stream that is not a forfeit, or follows a result, is refused by name", () => {
    let walkovers = 0;
    let retirements = 0;
    let unbuilt = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "knockout", offlineBuilderDefault(sport));
      const gen = (outcome: RequestedOutcome) => generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "h", away: "a", outcome });
      expect(forfeitPlayOf(sport, cfg, "h", "a", gen(fw("away", "walkover", "before_start"))), sport).toEqual({ kind: "none" });
      expect(forfeitPlayOf(sport, cfg, "h", "a", gen({ kind: "double_walkover" })), sport).toEqual({ kind: "none" });
      walkovers++;
      let retired: ReturnType<typeof gen>;
      try {
        retired = gen(fw("home", "retired", "after_start"));
      } catch (e) {
        if (!(e instanceof OutcomeUnreachable) && !(e instanceof GeneratorUnsupported)) throw e;
        unbuilt++;
        continue;
      }
      const playedAny = retired.slice(retired.findIndex((e) => e.type === "core.start") + 1, -1).some((e) => !e.type.startsWith("core."));
      expect(forfeitPlayOf(sport, cfg, "h", "a", retired), sport).toEqual({ kind: playedAny ? "in_progress" : "started" });
      // Ruling 112: the same forfeit on a bare START — nothing played — reads as started.
      expect(forfeitPlayOf(sport, cfg, "h", "a", [{ type: "core.start", payload: {} }, retired.at(-1)!]), `${sport} bare start`).toEqual({ kind: "started" });
      retirements++;
    }
    expect(walkovers).toBe(SPORT_KEYS.length);
    expect(retirements).toBeGreaterThan(0);
    expect(retirements + unbuilt).toBe(SPORT_KEYS.length);
    const fcfg = resolveSportCfg("football", offlineBuilderDefault("football"));
    const won = generateStream({ sportKey: "football", cfg: fcfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
    expect(() => forfeitPlayOf("football", fcfg, "h", "a", won)).toThrow(/not its core\.forfeit/);
    expect(() => forfeitPlayOf("football", fcfg, "h", "a", [...won, { type: "core.forfeit", payload: { by: "a", reason: "retired" } }])).toThrow(ForfeitPlayUnread);
    const ccfg = stageCfg("boardgame", resolveSportCfg("boardgame", offlineBuilderDefault("boardgame")), "knockout", offlineBuilderDefault("boardgame"));
    const drawn = generateStream({ sportKey: "boardgame", cfg: ccfg, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "tiebreak", rung: "rapid", winner: "home" } }).slice(0, 2);
    expect(() => forfeitPlayOf("boardgame", ccfg, "h", "a", [...drawn, { type: "core.forfeit", payload: { by: "a", reason: "walkover" } }])).toThrow(/drawn chess game/);
  });

  it("nextLineOf: a final (both grand finals of a reset), a last rung, a third-place match and a match whose two sides meet again in one fixture feed no next match (X-DW-3, loop F I-5), every other bracket match does — read from the engine's wiring, swept over every bracket generator; a ladder feeds none (D19); an unreadable layout is unresolved by name", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
    const rowsOf = (gen: { fixtures: readonly { id: string; home?: string; away?: string }[] }): FixtureRow[] =>
      gen.fixtures.map((g, i) => ({ id: `row-${g.id}`, stage_id: "s", pool_id: null, round_no: 1, fixture_no: i + 1, home_entrant_id: g.home ?? null, away_entrant_id: g.away ?? null, status: "scheduled", outcome: null, ext_key: g.id }));
    const shapes: readonly [string, Record<string, unknown>, ReturnType<typeof generateSingleElim>][] = [
      ["knockout", { thirdPlace: true }, generateSingleElim({ entrants: ids(8), thirdPlace: true })],
      ["knockout", {}, generateSingleElim({ entrants: ids(8), thirdPlace: false })],
      ["page_playoff", {}, generatePagePlayoff({ entrants: ids(4) })],
      ["stepladder", {}, generateStepladder({ entrants: ids(4) })],
      ["double_elim", {}, generateDoubleElim({ entrants: ids(4) })],
      ["double_elim", { bracketReset: true }, generateDoubleElim({ entrants: ids(4), bracketReset: true })],
      ["double_elim", {}, generateDoubleElim({ entrants: ids(2) })],
      ["double_elim", { bracketReset: true }, generateDoubleElim({ entrants: ids(2), bracketReset: true })],
    ];
    // The product's rule (apps/web bracket-next-match.ts, loop F I-5), read off the engine's own declarations: its isFinal
    // and thirdPlace flags (both grand finals of a reset are isFinal), and a fixture fed from BOTH sides of one match —
    // that match only replays its own two entrants (a reset's grand final, a two-entrant double elim's winners' match).
    let none = 0;
    let next = 0;
    let rematches = 0;
    for (const [kind, config, gen] of shapes) {
      const rows = rowsOf(gen);
      const fixtures = gen.fixtures as readonly { id: string; isFinal?: boolean; thirdPlace?: boolean; homeFrom?: { fixtureId: string }; awayFrom?: { fixtureId: string } }[];
      const rematch = (id: string) => fixtures.some((h) => h.homeFrom?.fixtureId === id && h.awayFrom?.fixtureId === id);
      for (const g of fixtures) {
        const terminal = g.isFinal === true || g.thirdPlace === true || rematch(g.id);
        const line = nextLineOf(kind, config, rows.find((r) => r.ext_key === g.id)!, rows);
        expect(line.line, `${kind} ${JSON.stringify(config)} of ${gen.fixtures.length} ${g.id}`).toBe(terminal ? "none" : "next");
        if (terminal) none++; else next++;
        if (rematch(g.id)) rematches++;
      }
    }
    // A reset's grand final at 4 and at 2, and the 2-entrant winners' match with and without a reset: four rematches.
    expect(rematches).toBe(4);
    expect(none).toBeGreaterThanOrEqual(shapes.length); // every shape has at least its final
    expect(next).toBeGreaterThan(0);
    const ko = rowsOf(generateSingleElim({ entrants: ids(4), thirdPlace: false }));
    expect(nextLineOf("ladder", {}, ko[0]!, ko)).toEqual({ line: "none" });
    expect(nextLineOf("knockout", {}, { ...ko[0]!, ext_key: null }, ko)).toEqual({ line: "unresolved", why: expect.stringMatching(/carries no ext_key/) });
    expect(nextLineOf("league", {}, ko[0]!, ko)).toEqual({ line: "unresolved", why: expect.stringMatching(/no bracket generator for 'league'/) });
    // The one-line-per-side guards, reached with an injected layout (loserSeatOf's rule): pp-q1's winner, then its
    // loser, wired into two different fixtures is unresolved by name; the engine's own layout is the positive pair, and
    // names the WINNER line's target (pp-final), not the loser's (pp-q2).
    const pp = rowsOf(generatePagePlayoff({ entrants: ids(4) }));
    const twice = (side: "winner" | "loser") => ({ page_playoff: () => ({ rounds: 3, fixtures: [
      { id: "pp-q1", round: 0, home: "e1", away: "e2" }, { id: "pp-elim", round: 0, home: "e3", away: "e4" },
      { id: "pp-q2", round: 1, homeFrom: { fixtureId: "pp-q1", side }, awayFrom: { fixtureId: "pp-elim", side: "winner" as const } },
      { id: "pp-final", round: 2, isFinal: true, homeFrom: { fixtureId: "pp-q1", side }, awayFrom: { fixtureId: "pp-q2", side: "winner" as const } },
    ] }) }) as unknown as Parameters<typeof nextLineOf>[4];
    for (const side of ["winner", "loser"] as const) {
      expect(nextLineOf("page_playoff", {}, pp[0]!, pp, twice(side)), side).toEqual({ line: "unresolved", why: expect.stringMatching(new RegExp(`wires 2 ${side} lines out of pp-q1`)) });
    }
    expect(nextLineOf("page_playoff", {}, pp[0]!, pp)).toEqual({ line: "next", target: "pp-final" });
  });

  it("the comparison counts the W2b forfeits it judged: N of M in its reason; forfeits driven and none judged FAILS, and so does a run that owed them and drove none (zero judged, R25)", () => {
    const st: ObservedRun = { caseId: "c", facts: [], withdrawal: null, configEdit: null, stages: [{ id: "s1", seq: 1, kind: "knockout", config: {}, field: ["a", "b"], fieldSource: "division", fixtures: [], standings: [], generates: [], pairRounds: [], complete: null }] };
    const rec = (...ds: BracketDrive[]) => { const r = new Recorder(); r.bracketDrives.push(...ds); return r; };
    const good = drive({ asked: { kind: "win", winner: "home" }, outcome: win("a") });
    const dw = drive({ fixtureId: "f3", asked: { kind: "double_walkover" }, status: "forfeited", outcome: { kind: "double_walkover" } });
    const wo = drive({ fixtureId: "f4", asked: fw("away", "walkover", "before_start"), status: "forfeited", outcome: award("a", "b", "walkover") });
    const unread = drive({ fixtureId: "f5", asked: { kind: "double_walkover" }, next: { line: "unresolved", why: "fixture f5 carries no ext_key" }, status: "forfeited", outcome: { kind: "double_walkover" } });
    const both = referenceBracketFinish(rec(good, dw, wo), st);
    expect(both).toMatchObject({ verdict: "pass", checked: 3 });
    expect(both.reason).toMatch(/forfeits and double walkovers: 2 of 2 judged/);
    const none = referenceBracketFinish(rec(good, unread), st);
    expect(none.verdict).toBe("fail");
    expect(none.evidence.join("\n")).toMatch(/forfeits and double walkovers: 0 of 1 judged/);
    // Owed: the scenario's own forfeits land on this bracket — zero driven is zero judged, a failure.
    const owed = referenceBracketFinish(rec(good), st, { forfeitsOwed: true });
    expect(owed.verdict).toBe("fail");
    expect(owed.evidence.join("\n")).toMatch(/0 of 0 judged/);
    // The positive pairs: owed and judged passes; not owed and none driven says nothing about forfeits.
    expect(referenceBracketFinish(rec(good, wo), st, { forfeitsOwed: true })).toMatchObject({ verdict: "pass", checked: 2 });
    const plain = referenceBracketFinish(rec(good), st);
    expect(plain).toMatchObject({ verdict: "pass", checked: 1 });
    expect(plain.reason).not.toMatch(/forfeits and double walkovers/);
  });

  it("through a driver: WO-PRE and RT-PART on the knockout fake judge every forfeit they drove, over every sport, and the count is reported", async () => {
    let cases = 0;
    let judged = 0;
    for (const key of ["WO-PRE", "RT-PART"] as const) {
      for (const cell of w2bCells(key).filter((c) => c.row === "knockout")) {
        const variant = offlineBuilderDefault(cell.sport);
        const spec: CaseSpec = { caseId: `knockout|${cell.sport}|${variant}|${key}`, row: "knockout", sport: cell.sport, variant, scenario: key, canary: false };
        const out = await SCENARIOS[key].run({ driver: new FakeKnockoutDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(cell.sport, variant), tag: "t", denied: [] });
        const check = out.assertions.find((c) => c.id === "life-reference-bracket-finish");
        expect(check, `${key} ${cell.sport}`).toBeDefined();
        expect(`${check!.verdict}: ${check!.reason}`, `${key} ${cell.sport}`).toMatch(/^pass/);
        const m = /forfeits and double walkovers: (\d+) of (\d+) judged/.exec(check!.reason);
        expect(m, `${key} ${cell.sport}: ${check!.reason}`).not.toBeNull();
        expect(Number(m![1]), `${key} ${cell.sport}`).toBe(Number(m![2]));
        expect(Number(m![1]), `${key} ${cell.sport}`).toBeGreaterThan(0);
        judged += Number(m![1]);
        cases++;
      }
    }
    expect(cases).toBeGreaterThan(SPORT_KEYS.length); // WO-PRE on every sport, RT-PART on those that build a retirement
    expect(judged).toBeGreaterThanOrEqual(cases);
    process.stderr.write(`I-3 judged: ${judged} W2b forfeit drive(s) over ${cases} knockout case(s)\n`);
  });

  it("through a driver: a product that refuses every walkover has each refusal JUDGED against the oracle (review I-1: a refused bare forfeit is a drive, never dropped) — the check fails by name, every walkover counted (the sweep above is its positive pair)", async () => {
    class RefusesForfeits extends FakeKnockoutDriver {
      override forfeit(id: string): Promise<never> { return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "FORFEIT_REASON_WRONG_PHASE", "refused on purpose")); }
    }
    const sport = "football";
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|WO-PRE`, row: "knockout", sport, variant, scenario: "WO-PRE", canary: false };
    const out = await SCENARIOS["WO-PRE"].run({ driver: new RefusesForfeits(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const check = out.assertions.find((c) => c.id === "life-reference-bracket-finish")!;
    expect(check.verdict).toBe("fail");
    const refused = check.evidence.filter((e) => /refusal: the product refused it 409 FORFEIT_REASON_WRONG_PHASE, the oracle accepts it/.test(e));
    expect(refused.length, check.evidence.join("\n")).toBeGreaterThan(0);
    // Every walkover the scenario asked for is among them: one a round of the knockout of 8 (three rounds).
    expect(refused.length).toBe(3);
  });

  it("through a driver: a W2b scenario on a bracket OWES its forfeits — a product whose fixtures are already under way when the hook looks leaves it nothing to forfeit, and the check fails by name '0 of 0 judged' (the sweep above is its positive pair)", async () => {
    // Since review I-1 a refused BARE forfeit is a drive, so refusing walkovers no longer empties the count, and a
    // refused retirement throws out of RT-PART by name. Zero forfeit drives is now the hook finding no scheduled fixture
    // in any round. The play loop still decides every match, so the run looks whole, and only the owed rule reds.
    class StartsUnderWay extends FakeKnockoutDriver {
      override rows() { return super.rows().map((r) => (r.status === "scheduled" ? { ...r, status: "in_play" } : r)); }
    }
    const sport = "football";
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|WO-PRE`, row: "knockout", sport, variant, scenario: "WO-PRE", canary: false };
    const out = await SCENARIOS["WO-PRE"].run({ driver: new StartsUnderWay(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const check = out.assertions.find((c) => c.id === "life-reference-bracket-finish")!;
    expect(`${check.verdict}: ${check.evidence.join(" | ")}`).toMatch(/^fail: .*0 of 0 judged/);
    // It is the forfeits that are missing, not the bracket: every decided match was still judged.
    expect(check.checked).toBeGreaterThan(1);
  });

  it("judgeDrive (review I-1): a refused drive is judged against the oracle's refusal — the same code passes, another code or a refusal the oracle does not make fails by name, and an accepted write the oracle refuses still fails", () => {
    const dwFinal = { asked: { kind: "double_walkover" } as const, next: { line: "none" } as const, status: "scheduled", outcome: null };
    const agree = judgeDrive(drive({ ...dwFinal, refusal: { status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" } }));
    expect(agree).toMatchObject({ judged: true, ok: true });
    const other = judgeDrive(drive({ ...dwFinal, refusal: { status: 422, code: "FORFEIT_REASON_WRONG_PHASE" } }));
    expect(other).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/refusal: the oracle refuses action 0 with DOUBLE_WALKOVER_NO_NEXT_MATCH, the product 422 FORFEIT_REASON_WRONG_PHASE/) });
    const uncoded = judgeDrive(drive({ ...dwFinal, refusal: { status: 500, code: null } }));
    expect(uncoded).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/the product 500 \(no code\)/) });
    // A walkover the oracle accepts, refused by the product, the fixture left scheduled.
    const wo = judgeDrive(drive({ asked: fw("away", "walkover", "before_start"), status: "scheduled", outcome: null, refusal: { status: 409, code: "FORFEIT_REASON_WRONG_PHASE" } }));
    expect(wo).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/refusal: the product refused it 409 FORFEIT_REASON_WRONG_PHASE, the oracle accepts it/) });
    // Accepted where the oracle refuses: the existing line, unchanged.
    expect(judgeDrive(drive({ ...dwFinal, status: "forfeited", outcome: { kind: "double_walkover" } }))).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/the oracle refuses action 0 with DOUBLE_WALKOVER_NO_NEXT_MATCH, which the harness drove as legal/) });
  });

  it("through a driver: a double walkover decided on the page-playoff fake carries the ENGINE's next line — pp-elim feeds pp-q2 and agrees; pp-final feeds nothing, so a product that accepted it there reds by X-DW-3", async () => {
    const sport = "football";
    const variant = offlineBuilderDefault(sport);
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    const spec: CaseSpec = { caseId: "page_playoff_only|football|DW-ALL", row: "page_playoff_only", sport, variant, scenario: "DW-ALL", canary: false };
    const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    await driver.start();
    const row = (key: string) => driver.fixtures.find((f) => f.ext_key === key)!;
    await decideFixture(ctx, rec, setup, row("pp-elim"), { kind: "double_walkover" }, setup.stage);
    const elim = rec.bracketDrives.at(-1)!;
    expect(elim.next).toEqual({ line: "next", target: "pp-q2" });
    expect(elim.forfeitPlay).toEqual({ kind: "none" });
    expect(judgeDrive(elim)).toMatchObject({ judged: true, ok: true });
    // The final, seated by hand so it can be driven: a product that accepts a double walkover there is wrong (X-DW-3).
    // The fake refuses one there, as the server does — so the wrong product is this fake with the rule switched off.
    driver.feeds.set(row("pp-final").id, { to: "nowhere", slot: "home_entrant_id" });
    const final = row("pp-final");
    const [h, a] = setup.entrants.slice(0, 2).map((e) => e.id);
    Object.assign(final, { home_entrant_id: h, away_entrant_id: a });
    await decideFixture(ctx, rec, setup, final, { kind: "double_walkover" }, setup.stage);
    const fin = rec.bracketDrives.at(-1)!;
    expect(fin.next).toEqual({ line: "none" });
    expect(judgeDrive(fin)).toMatchObject({ judged: true, ok: false, note: expect.stringMatching(/refuses action 0 with DOUBLE_WALKOVER_NO_NEXT_MATCH/) });
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
