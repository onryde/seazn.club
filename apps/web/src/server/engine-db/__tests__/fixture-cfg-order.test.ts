// P3 order differential (spec §9): snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override).
// W2c Task 10 (spec §4.4, D4). Pure: the DB proof that every caller hands the resolver its fixture's override is
// bracket-overlay-callers.test.ts. Expected values come from the engine's declarations (`bracketDeciders`,
// `configSchema`, `variants`) and from the literals the case itself writes, never from the resolver.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
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
