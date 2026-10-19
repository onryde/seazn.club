// W2c Task 17 (review I9) - the decisions the stage format row makes live in a pure helper with a unit killer, never in a
// browser. Expected values come from the engine's own declarations (`ruleKeys`, `bracketDeciders`, `canEndLevel`,
// `abandonOptions`, `configSchema`), never from a table typed here; every sweep reports how many items it checked.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { bracketMayEndLevel, deciderKeysFor, stageDefaultsFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { declaredCfgs } from "@seazn/engine/testkit";
import { SPORT_RULES } from "@/lib/match-rules";
import { describeDeciders } from "@/server/public-site/describe-rules";
import { decidersOffRules } from "@/lib/stage-decider-off";
import {
  abandonOptionStates,
  decidersAllOff,
  decidersMayEndLevel,
  deciderNotice,
  resolvedStageCfg,
  stageFieldsShown,
  stageSections,
} from "../stage-row-model";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const football = sport("football");
const chess = sport("boardgame");
const BRACKETS = [...BRACKET_KINDS] as StageKind[];
const NOT_BRACKET = StageKind.options.filter((k) => !BRACKET_KINDS.has(k));

describe("stage row model (I9 killers for t17)", () => {
  it("football KO with both deciders off holds; one on does not; a league never shows the notice (empty case)", () => {
    expect(decidersAllOff(football, "knockout", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(true);
    expect(decidersAllOff(football, "knockout", { extraTime: { enabled: true, halfMinutes: 15 }, shootout: false })).toBe(false);
    expect(decidersAllOff(football, "league", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(false);
  });

  it("P-5: generic share is unavailable, with the reason, while draws are off; available when on; carrom only under the drawn-game house rule", () => {
    const generic = sport("generic");
    const carrom = sport("carrom");
    const share = (m: AnySportModule, v: Record<string, unknown>) => abandonOptionStates(m, v).find((o) => o.value === "share")!;
    expect(share(generic, { allowDraws: false })).toEqual({ value: "share", disabled: true, reasonKey: "stageRules.abandon.shareNeedsDraws" });
    expect(share(generic, { allowDraws: true }).disabled).toBe(false);
    // Carrom takes a draw only under tieBoard "draw"; every shipped variant defaults to "extra", so the bare cfg refuses
    // (the plan's `false` for `share(carrom, {})` was wrong: the engine refuses it, naming the tie-board setting).
    expect(share(carrom, {})).toEqual({ value: "share", disabled: true, reasonKey: "rules.err.shareNeedsDrawnGame" });
    expect(share(carrom, { tieBoard: "draw" })).toEqual({ value: "share", disabled: false, reasonKey: null });
  });

  // The brief's version of this case asserted that EVERY declared stage key is edited by a shown field. That is a false
  // premise: five stage keys have no curated field at all (below), so the case is split into what is true. First, each
  // sport's shown fields are exactly the curated fields whose every key the engine declares for the stage - recomputed
  // here from `ruleKeys` and the field table, not read back from `stageFieldsShown` - and then the keys no field edits are
  // pinned as a ratchet: the day one gains a field, this list shrinks on purpose.
  it("every sport shows its stage fields: exactly the curated fields the engine's stage keys allow (counted)", () => {
    let cells = 0;
    let fields = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as const) {
        const allowed = new Set(stageKeysFor(m, kind, null));
        const expected = (SPORT_RULES[m.key] ?? []).filter((f) => f.edits.length > 0 && f.edits.every((e) => allowed.has(e))).map((f) => f.key);
        const shown = stageFieldsShown(m, kind, null).map((f) => f.key);
        expect(shown, `${m.key}/${kind}`).toEqual(expected);
        cells++;
        fields += shown.length;
      }
    expect(cells).toBe(builtinModules.length * (1 + BRACKET_KINDS.size));
    expect(fields).toBeGreaterThan(builtinModules.length * 2);
    // Every sport offers at least one stage field in at least one stage kind, so no sport is a silent blank row.
    for (const m of builtinModules)
      expect(["league", ...BRACKET_KINDS].some((k) => stageFieldsShown(m, k as StageKind, null).length > 0), m.key).toBe(true);
  });

  it("the stage keys no curated field edits are exactly the five known gaps (a ratchet: it shrinks when a field is added)", () => {
    const uncurated = new Set<string>();
    let keys = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as const)
        for (const key of stageKeysFor(m, kind, null)) {
          keys++;
          const top = key.split(".")[0];
          if (!stageFieldsShown(m, kind, null).some((f) => f.edits.some((e) => e.split(".")[0] === top))) uncurated.add(`${m.key}:${key}`);
        }
    expect(keys).toBeGreaterThan(300);
    expect([...uncurated].sort()).toEqual([
      "carrom:pointsPerCoin", "cricket:minOversForResult", "cricket:superOverStillTied", "football:concussionSubs", "football:rollingSubs",
    ]);
  });
});

describe("the deciders notice reads the RESOLVED cfg (carry G1) and treats chess's list as off ONLY when it is empty (carry 13b)", () => {
  const chessDivision = chess.configSchema.parse(chess.variants.classical ?? Object.values(chess.variants)[0]) as Record<string, unknown>;
  const resolved = (rules: Record<string, unknown>) => resolvedStageCfg(chess, chessDivision, "knockout", rules)!;

  it("a chess knockout stage with its list empty is held; absent, one rung or all three is not", () => {
    expect(resolved({ tiebreakRungs: [] })).not.toBeNull();
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: [] })), "[] is off").toBe(true);
    expect(decidersAllOff(chess, "knockout", resolved({})), "absent plays every rung").toBe(false);
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: ["rapid"] })), "one rung").toBe(false);
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: ["rapid", "blitz", "armageddon"] })), "every rung").toBe(false);
    // Not by truthiness: `[]` is truthy and absent is falsy, and both answers above are the opposite of a `!v` read.
    expect(Boolean([])).toBe(true);
    expect(decidersAllOff(chess, "league", resolved({ tiebreakRungs: [] })), "a table stage never shows it").toBe(false);
  });

  it("the RAW division cfg is not the resolved one: chess's bracket overlay turns its tie-break on (G1)", () => {
    // The unresolved read: the division has tie-breaks off, and a notice reading `stage.rules` + division alone would say
    // so. The resolved cfg (after `bracketDeciders`) plays them, so a stage with the DEFAULT list is not held.
    const raw = { ...chessDivision, tiebreak: false } as Record<string, unknown>;
    expect(decidersAllOff(chess, "knockout", resolvedStageCfg(chess, raw, "knockout", {})!)).toBe(false);
    expect(chess.bracketDeciders(raw as never)).toMatchObject({ tiebreak: true });
  });

  it("resolvedStageCfg refuses a cfg the schema refuses, so a half-typed edit shows no notice", () => {
    expect(resolvedStageCfg(chess, chessDivision, "knockout", { tiebreakRungs: ["no-such-rung"] })).toBeNull();
  });
});

describe("the notice and the public line agree, and the engine's declaration says when a level match can remain (M-3)", () => {
  it("over every declared cfg, bracket kind and the every-decider-off setup: allOff <=> the public line says none; level <=> the engine says so (counted)", () => {
    let checked = 0;
    let allOff = 0;
    let level = 0;
    for (const m of builtinModules) {
      if (deciderKeysFor(m, null, null).length === 0) continue;
      const setups: { name: string; division: Record<string, unknown>; rules: Record<string, unknown> }[] = [];
      for (const { name, cfg } of declaredCfgs(m)) {
        setups.push({ name: `${name}`, division: cfg as Record<string, unknown>, rules: {} });
        const variant = Object.hasOwn(m.variants, name) ? name : Object.keys(m.variants)[0]!;
        for (const kind of BRACKETS) {
          setups.push({ name: `${name} / all off (${kind})`, division: cfg as Record<string, unknown>, rules: decidersOffRules(m, variant, kind) });
          // The knockout preset (every decider on, the engine's own `stageDefaults`), and the preset with ONE decider
          // switched off at a time, each off value the engine's (`decidersOffRules`): the setups where one decider is
          // left and a level match may or may not remain behind it.
          const preset = stageDefaultsFor(m, kind, variant);
          setups.push({ name: `${name} / preset (${kind})`, division: cfg as Record<string, unknown>, rules: preset });
          const off = decidersOffRules(m, variant, kind);
          for (const key of deciderKeysFor(m, kind, variant))
            setups.push({ name: `${name} / preset without ${key} (${kind})`, division: cfg as Record<string, unknown>, rules: { ...preset, [key]: off[key] } });
        }
      }
      for (const { name, division, rules } of setups) {
        for (const kind of BRACKETS) {
          const cfg = resolvedStageCfg(m, division, kind, rules);
          if (cfg === null) continue;
          const off = decidersAllOff(m, kind, cfg);
          const says = describeDeciders(m, kind, cfg).some((c) => c.key === "format.rules.decider.none");
          expect(off, `${m.key} ${name} ${kind}: the notice and the public line disagree on "no decider"`).toBe(says);
          const may = decidersMayEndLevel(m, kind, cfg);
          // The engine's own declaration is the oracle: a level match remains exactly when a decider is on and it says so.
          expect(may, `${m.key} ${name} ${kind}`).toBe(!off && bracketMayEndLevel(m, kind, cfg));
          // Whatever the notice calls "off", the engine must agree a level match can then stand.
          if (off) expect(bracketMayEndLevel(m, kind, cfg), `${m.key} ${name} ${kind}: held, but the engine says it cannot end level`).toBe(true);
          expect(deciderNotice(m, kind, cfg)).toBe(off ? "off" : may ? "level" : null);
          if (off) allOff++;
          if (may) level++;
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(builtinModules.length);
    expect(allOff, "some setup is held").toBeGreaterThan(0);
    expect(level, "some setup leaves a level match behind a decider").toBeGreaterThan(0);
  });

  it("football: extra time alone can still end level; penalties cannot; extra time then penalties cannot", () => {
    const base = football.configSchema.parse(football.variants["11-a-side"] ?? Object.values(football.variants)[0]) as Record<string, unknown>;
    const notice = (rules: Record<string, unknown>) => deciderNotice(football, "knockout", resolvedStageCfg(football, base, "knockout", rules)!);
    expect(notice({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: false })).toBe("level");
    expect(notice({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: true })).toBeNull();
    expect(notice({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true })).toBeNull();
    expect(notice({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe("off");
  });

  it("a table stage and a sport with no decider say nothing, whatever the cfg (empty case)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const { cfg } of declaredCfgs(m))
        for (const kind of [...NOT_BRACKET, ...DRAW_KINDS]) {
          expect(deciderNotice(m, kind as StageKind, cfg as Record<string, unknown>), `${m.key}/${kind}`).toBeNull();
          checked++;
        }
    expect(checked).toBeGreaterThan(builtinModules.length);
    const badminton = sport("badminton");
    expect(deciderNotice(badminton, "knockout", badminton.configSchema.parse(Object.values(badminton.variants)[0]) as Record<string, unknown>)).toBeNull();
  });
});

describe("abandonOptionStates (owner P-5)", () => {
  it("lists exactly the module's own abandon options, in its order, for every sport (counted)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const base = (declaredCfgs(m)[0]!.cfg ?? {}) as Record<string, unknown>;
      expect(abandonOptionStates(m, base).map((o) => o.value), m.key).toEqual(m.abandonOptions ?? []);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });

  it("only `share` is ever unavailable, and only with a reason; every other option is offered with none", () => {
    let unavailable = 0;
    for (const m of builtinModules)
      for (const { cfg } of declaredCfgs(m))
        for (const o of abandonOptionStates(m, cfg as Record<string, unknown>)) {
          if (o.disabled) {
            expect(o.value, m.key).toBe("share");
            expect(o.reasonKey, m.key).not.toBeNull();
            unavailable++;
          } else expect(o.reasonKey, `${m.key}/${o.value}`).toBeNull();
        }
    expect(unavailable, "carrom's shipped variants refuse share").toBeGreaterThan(0);
  });
});

describe("the stage sections: every shown field is in exactly one section (counted)", () => {
  it("format, deciders and abandon partition the shown fields, and the abandon field is the abandon section's", () => {
    let fields = 0;
    let withDeciders = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as StageKind[]) {
        const shown = stageFieldsShown(m, kind, null);
        const sections = stageSections(m, kind, null);
        const placed = sections.flatMap((s) => s.fields.map((f) => f.key));
        expect(placed.sort(), `${m.key}/${kind}`).toEqual(shown.map((f) => f.key).sort());
        for (const s of sections) expect(s.fields.length, `${m.key}/${kind}/${s.id} is empty`).toBeGreaterThan(0);
        for (const f of sections.find((s) => s.id === "abandon")?.fields ?? []) expect(f.edits[0]!.split(".")[0]).toBe("abandonPolicy");
        const decidersTop = new Set(deciderKeysFor(m, kind, null));
        for (const f of sections.find((s) => s.id === "deciders")?.fields ?? []) {
          // A deciders field edits a decider key, or a bounded detail of one (`matchBound`: the kicks of a shoot-out).
          const tops = f.edits.map((e) => e.split(".")[0]!);
          expect(tops.every((t) => decidersTop.has(t) || m.ruleKeys?.[t]?.matchBound !== undefined), `${m.key}/${kind}: ${f.key}`).toBe(true);
          withDeciders++;
        }
        fields += shown.length;
      }
    expect(fields).toBeGreaterThan(builtinModules.length);
    expect(withDeciders, "some bracket stage has deciders to show").toBeGreaterThan(0);
  });
});
