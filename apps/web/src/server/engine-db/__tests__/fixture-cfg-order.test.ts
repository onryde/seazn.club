// P3 order differential (spec §9): snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override).
// W2c Task 10 (spec §4.4, D4). Pure: the DB proof that every caller hands the resolver its fixture's override is
// bracket-overlay-callers.test.ts. Expected values come from the engine's declarations (`bracketDeciders`,
// `configSchema`, `variants`) and from the literals the case itself writes, never from the resolver.
import { describe, expect, it } from "vitest";
import { EngineError, foldMatch } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { resolveFixtureCfg } from "../fixture-cfg";

const mod = (key: string) => builtinModules.find((m) => m.key === key)!;
const none = { config_snapshot: null, rules_override: null };

describe("P3 resolveFixtureCfg order", () => {
  it("empty case first: no snapshot and no override is the stage-scoped cfg itself, nothing added", () => {
    const division = { bestOf: 5 };
    expect(resolveFixtureCfg(none, division, null, mod("badminton"))).toBe(division);
  });
  it("X-SR-2: override beats stage beats division (badminton bestOf: 5 / 3 / 1)", () => {
    const division = { bestOf: 5 }, stage = { kind: "league" as const, config: { rules: { bestOf: 3 } } };
    expect(resolveFixtureCfg(none, division, null, mod("badminton"))).toMatchObject({ bestOf: 5 });
    expect(resolveFixtureCfg(none, division, stage, mod("badminton"))).toMatchObject({ bestOf: 3 });
    expect(resolveFixtureCfg({ config_snapshot: null, rules_override: { bestOf: 1 } }, division, stage, mod("badminton"))).toMatchObject({ bestOf: 1 });
  });
  it("CA-KO-1: a bracket decider beats the stage (carrom KO tieBoard)", () => {
    const carrom = mod("carrom");
    const deciders = carrom.bracketDeciders(carrom.configSchema.parse({})) as { tieBoard: string };
    const r = resolveFixtureCfg(none, { tieBoard: "none" }, { kind: "knockout", config: { rules: { tieBoard: "none" } } }, carrom) as { tieBoard: string };
    expect(r.tieBoard).toBe(deciders.tieBoard);
    expect(deciders.tieBoard).not.toBe("none");
  });
  it("X-SR-2: the override lands after the deciders (football KO: extra time switched off for one match)", () => {
    const r = resolveFixtureCfg({ config_snapshot: null, rules_override: { extraTime: { enabled: false, halfMinutes: 15 } } },
      {}, { kind: "knockout", config: { rules: { extraTime: { enabled: true, halfMinutes: 15 } } } }, mod("football")) as { extraTime: { enabled: boolean } };
    expect(r.extraTime.enabled).toBe(false);
  });
  it("X-SR-2: the override lands after a NON-EMPTY decider overlay (boardgame KO: the declared tie-break switched off for one match)", () => {
    // Boardgame rather than football: football declares no decider today (`bracketDeciders` → {}), so the case above
    // cannot tell "override after deciders" from "override before deciders". Boardgame declares one, so the right
    // answer (the override's value) differs from the wrong one (the decider's).
    const boardgame = mod("boardgame");
    const live = boardgame.configSchema.parse({});
    const declared = boardgame.bracketDeciders(live) as { tiebreak?: unknown };
    expect(declared.tiebreak, "the premise: boardgame's bracket overlay sets tiebreak").toBe(true);
    const r = resolveFixtureCfg({ config_snapshot: null, rules_override: { tiebreak: false } }, live, { kind: "knockout", config: null }, boardgame) as { tiebreak?: unknown };
    expect(r.tiebreak).toBe(false);
  });
  it("a frozen snapshot wins over everything, override included", () => {
    expect(resolveFixtureCfg({ config_snapshot: { bestOf: 3 }, rules_override: { bestOf: 1 } }, { bestOf: 5 }, null, mod("badminton"))).toEqual({ bestOf: 3 });
  });
  it("a non-object override is ignored (null, array, string)", () => {
    // `toBe` the division object, not `toMatchObject`: a spread of `[]`, `["x"]` or `"x"` copies (and, for the last two,
    // adds index keys), so only identity tells "ignored" from "merged". Undefined is a column the caller never selected.
    const division = { bestOf: 5 };
    let checked = 0;
    for (const ov of [null, [], "x", ["x"], undefined, 0, true]) {
      expect(resolveFixtureCfg({ config_snapshot: null, rules_override: ov }, division, null, mod("badminton")), JSON.stringify(ov) ?? "undefined").toBe(division);
      checked++;
    }
    expect(checked).toBe(7);
  });
  it("X-SR-2 Review Focus 2: a stage edit after an override keeps the override and moves the rest", () => {
    const fixture = { config_snapshot: null, rules_override: { bestOf: 1 } };
    const before = resolveFixtureCfg(fixture, { bestOf: 5, setTo: 21 }, { kind: "league", config: { rules: { setTo: 21 } } }, mod("badminton"));
    const after = resolveFixtureCfg(fixture, { bestOf: 5, setTo: 21 }, { kind: "league", config: { rules: { setTo: 15 } } }, mod("badminton"));
    expect(before).toMatchObject({ bestOf: 1, setTo: 21 });
    expect(after).toMatchObject({ bestOf: 1, setTo: 15 });
  });
  it("the override is merged into a copy: the caller's division, stage and override objects are never written", () => {
    // Stage null first: there the stage-scoped cfg IS the division object, so an in-place merge would write the
    // division row's own config (every later fixture of the division would then read this match's override).
    const division = { bestOf: 5 };
    const override = { bestOf: 1 };
    expect(resolveFixtureCfg({ config_snapshot: null, rules_override: override }, division, null, mod("badminton"))).toEqual({ bestOf: 1 });
    expect(division).toEqual({ bestOf: 5 });
    const rules = { setTo: 15 };
    const out = resolveFixtureCfg({ config_snapshot: null, rules_override: override }, division, { kind: "league", config: { rules } }, mod("badminton"));
    expect(out).toEqual({ bestOf: 1, setTo: 15 });
    expect(division).toEqual({ bestOf: 5 });
    expect(rules).toEqual({ setTo: 15 });
    expect(override).toEqual({ bestOf: 1 });
  });
});

// W2c Task 8 (BG-KO-3, G1): the stage's tie-break rung list is written by the STAGE and the bracket overlay lands after
// it, so the overlay must never overwrite it (`bracketDeciders` forces `tiebreak: true` and nothing else). Driven through
// the real resolver and the real boardgame fold: a list the overlay clobbered would reopen a tie-break the organiser
// switched off, or reorder the rungs they chose.
describe("BG-KO-3 (G1): the stage's tie-break rungs survive the bracket overlay", () => {
  const boardgame = mod("boardgame");
  const lineups = defaultLineupPair(boardgame.positions);
  const H = lineups.home.entrantId;
  const A = lineups.away.entrantId;
  const division = boardgame.configSchema.parse({});
  const knockout = (rungs?: readonly string[]) => ({ kind: "knockout" as const, config: { rules: rungs === undefined ? {} : { tiebreakRungs: rungs } } });
  const resolved = (fixture: { config_snapshot: unknown; rules_override: unknown }, rungs?: readonly string[]) => resolveFixtureCfg(fixture, division, knockout(rungs), boardgame) as { tiebreak?: boolean; tiebreakRungs?: string[] };
  const ev = (seq: number, type: string, payload: unknown = {}) => makeEnvelope(seq, { type, payload });
  const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
  const fold = (cfg: unknown, events = drawn) => foldMatch(boardgame, boardgame.configSchema.parse(cfg) as never, lineups, events);
  const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };

  it("an EMPTY list is still empty after the overlay (the overlay still forces tiebreak: true), and a drawn game is then held, not sent to a tie-break (ruling 79)", () => {
    const cfg = resolved(none, []);
    expect(cfg.tiebreakRungs).toEqual([]);
    expect(cfg.tiebreak, "the overlay still ran: it forces the decider on").toBe(true);
    const s = fold(cfg);
    expect(s.phase, "a drawn game with no tie-break to play stays a draw").toBe("done");
    expect(boardgame.outcome(s)).toEqual({ kind: "draw" });
  });
  it("a reordered, shortened list keeps the organiser's order, and only its rungs are played", () => {
    const cfg = resolved(none, ["blitz", "armageddon"]);
    expect(cfg.tiebreakRungs).toEqual(["blitz", "armageddon"]);
    expect(fold(cfg).phase).toBe("tiebreak");
    expect(codeOf(() => fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })])), "rapid is not in the list").toBe("TIEBREAK_NOT_APPLICABLE");
    expect(fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "blitz", winner: A })]).outcome, "a listed rung is played").toMatchObject({ kind: "win", winner: A });
  });
  it("BG-KO-1: the rung list IS the decider - [] holds a drawn game, ['rapid'] plays rapid and only rapid", () => {
    const rapidOnly = resolved(none, ["rapid"]);
    expect(rapidOnly.tiebreakRungs).toEqual(["rapid"]);
    expect(fold(rapidOnly).phase, "a drawn game with a rung to play awaits it").toBe("tiebreak");
    expect(fold(rapidOnly, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A })]).outcome).toMatchObject({ kind: "win", winner: A, method: "tiebreak_rapid" });
    for (const body of [{ rung: "blitz", winner: A }, { rung: "armageddon", black: A, result: "black" }])
      expect(codeOf(() => fold(rapidOnly, [...drawn, ev(3, "boardgame.tiebreak", body)])), body.rung).toBe("TIEBREAK_NOT_APPLICABLE");
    // The pair, through the same resolver: the empty list is held (the other half of the decider).
    const held = fold(resolved(none, []));
    expect(held.phase).toBe("done");
    expect(boardgame.outcome(held)).toEqual({ kind: "draw" });
  });
  it("the positive pair: a stage that sets no list adds none (the key stays absent) and every rung is played", () => {
    const cfg = resolved(none);
    expect(Object.hasOwn(cfg, "tiebreakRungs")).toBe(false);
    expect(cfg.tiebreak).toBe(true);
    expect(fold(cfg).phase).toBe("tiebreak");
    let played = 0;
    for (const body of [{ rung: "rapid", winner: H }, { rung: "blitz", winner: A }, { rung: "armageddon", black: H, result: "draw" }]) {
      expect(fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", body)]).outcome, body.rung).toMatchObject({ kind: "win" });
      played++;
    }
    expect(played).toBe(3);
  });
  it("X-SR-2: a match's own override lands after the stage's list (an empty list restored to a rung, and a list emptied)", () => {
    expect(resolved({ config_snapshot: null, rules_override: { tiebreakRungs: ["rapid"] } }, []).tiebreakRungs).toEqual(["rapid"]);
    expect(resolved({ config_snapshot: null, rules_override: { tiebreakRungs: [] } }, ["blitz", "rapid"]).tiebreakRungs).toEqual([]);
  });
});
