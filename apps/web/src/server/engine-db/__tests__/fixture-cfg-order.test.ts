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
  it("resolver precedence: a stored override lands after a NON-EMPTY decider overlay (boardgame KO: tiebreak false over the declared tie-break)", () => {
    // Resolver mechanics only, not X-SR-2 (batch-3 M3): boardgame's bare `tiebreak` is no organiser rule key (its
    // `ruleKeys`; the writer answers UNKNOWN_RULE_KEY), so no organiser stores this override; the case pins the
    // resolver's ORDER over a stored value.
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
  it("resolver precedence: a stored override lands after the stage's list (an empty list restored to a rung, and a list emptied)", () => {
    // Resolver mechanics only, not X-SR-2 (batch-3 M3): `tiebreakRungs` is a stage-scoped key the writer refuses per
    // match (RULE_NOT_SETTABLE); the case pins the resolver's ORDER over a stored value.
    expect(resolved({ config_snapshot: null, rules_override: { tiebreakRungs: ["rapid"] } }, []).tiebreakRungs).toEqual(["rapid"]);
    expect(resolved({ config_snapshot: null, rules_override: { tiebreakRungs: [] } }, ["blitz", "rapid"]).tiebreakRungs).toEqual([]);
  });
});

// W2c Task 14 — the override is a LEAF diff (the one writer stores only what the match changed, carry (c)), so the
// resolver merges it leaf by leaf; and a null is inherit (Task 10 M2), as in a stage's own `rules`.
describe("W2c Task 14 resolveFixtureCfg: the override's leaf merge and null = inherit", () => {
  const ov = (rules_override: unknown) => ({ config_snapshot: null, rules_override });

  it("M2 empty case: an override of only nulls (or undefined) leaves the stage's values — never blanks them", () => {
    const badminton = mod("badminton");
    const stage = badminton.configSchema.parse(badminton.variants.short) as { cap: number | null; bestOf: number };
    expect(stage.cap, "the premise: the short preset has a cap to blank").not.toBeNull();
    let checked = 0;
    for (const nothing of [null, undefined]) {
      const r = resolveFixtureCfg(ov({ cap: nothing, bestOf: nothing }), badminton.variants.short, null, badminton) as Record<string, unknown>;
      expect(r.cap, String(nothing)).toBe(stage.cap);
      expect(Object.hasOwn(r, "bestOf") ? r.bestOf : stage.bestOf, String(nothing)).toBe(stage.bestOf);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("carry (c): a nested override of one leaf keeps the stage's other leaves (ice hockey overtime.minutes), and a later stage edit to another leaf reaches the match", () => {
    const ice = mod("icehockey");
    const ot = (ice.configSchema.parse(ice.variants.iihf) as { overtime: { kind: string; minutes: number; skaters: number } }).overtime;
    const stage = (skaters: number) => ({ kind: "knockout" as const, config: { rules: { overtime: { ...ot, skaters } } } });
    const fixture = ov({ overtime: { minutes: ot.minutes - 1 } });
    const before = resolveFixtureCfg(fixture, ice.variants.iihf, stage(ot.skaters), ice) as { overtime: unknown };
    expect(before.overtime).toEqual({ ...ot, minutes: ot.minutes - 1 });
    expect(ice.configSchema.safeParse(before).success).toBe(true);
    const after = resolveFixtureCfg(fixture, ice.variants.iihf, stage(ot.skaters + 1), ice) as { overtime: unknown };
    expect(after.overtime).toEqual({ ...ot, minutes: ot.minutes - 1, skaters: ot.skaters + 1 });
  });

  it("a nested override naming a key the stage's object lacks is a different shape and REPLACES it (tennis finalSet: games-level tie-break → match tie-break)", () => {
    const tennis = mod("tennis");
    // Both shapes are the engine's own presets: the slam's deciding-set tie-break and the doubles match tie-break.
    const slam = tennis.variants["grand-slam"] as { finalSet: Record<string, unknown> };
    const mtb = tennis.variants["doubles-noad-mtb10"] as { finalSet: Record<string, unknown> };
    expect(Object.keys(mtb.finalSet).some((k) => !Object.hasOwn(slam.finalSet, k)), "the premise: two different shapes").toBe(true);
    const r = resolveFixtureCfg(ov({ finalSet: mtb.finalSet }), slam, null, tennis) as { finalSet: unknown };
    expect(r.finalSet).toEqual(mtb.finalSet);
    expect(tennis.configSchema.safeParse(r).success, "a leaf merge of the two would be refused by the strict union").toBe(true);
  });

  it("the leaf merge writes neither input, at any depth", () => {
    const ice = mod("icehockey");
    const overtime = { kind: "sudden_death", minutes: 5, skaters: 3 };
    const division = { overtime };
    const override = { overtime: { minutes: 4 } };
    resolveFixtureCfg(ov(override), division, null, ice);
    expect(division).toEqual({ overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } });
    expect(overtime).toEqual({ kind: "sudden_death", minutes: 5, skaters: 3 });
    expect(override).toEqual({ overtime: { minutes: 4 } });
  });

  it("a `__proto__` key from JSON is an own property of the result, never its prototype", () => {
    const r = resolveFixtureCfg(ov(JSON.parse('{"__proto__": {"polluted": 1}, "bestOf": 1}')), { bestOf: 3 }, null, mod("badminton")) as Record<string, unknown>;
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect((r as { polluted?: unknown }).polluted).toBeUndefined();
    expect(r.bestOf).toBe(1);
  });
});
