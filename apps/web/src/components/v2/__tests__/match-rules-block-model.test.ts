// W2c Task 19 (S2, X-SR-2) - the match rules form's decisions, as pure functions. The form opens AT the value the match
// plays (stage, then its own override), offers a decider only off or shorter, and sends only what differs from the stage.
//
// Expected verdicts come from the ENGINE: `checkFixtureOverride` (the writer's own check), `fixtureKeysFor` and
// `ruleKeyOwning` (the declared scope and bound of each key), and the module's `configSchema` - never from the model, and
// never from a table typed here. AGENTS.md failure class 19: a reachable control is not a correctly seeded one - the
// extra-time field must open at the stage's value, not at the field's own default (15).
import { describe, expect, it } from "vitest";
import {
  checkFixtureOverride,
  fixtureKeysFor,
  ruleKeyOwning,
  type AnySportModule,
} from "@seazn/engine/sport";
import { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { mergeRulesOverride } from "@/server/engine-db/fixture-cfg";
import { SINGLE_SET_POINTS_LABEL, setRuleValue } from "@/lib/match-rules";
import { BEST_OF_ONE_PAIR } from "@/lib/match-rules/best-of-one";
import { matchFieldsFor, moduleFor, type RuleContext } from "@/lib/rule-scope";
import {
  blockSeedKey,
  hydrateMatchValues,
  matchFormDirty,
  matchFormFields,
  matchFragment,
  matchRulesBlockProps,
  matchSource,
  type MatchFormCtx,
  type MatchFormLabels,
} from "../match-rules-block-model";

const LABELS: MatchFormLabels = { off: "Off", halfMinutes: (n) => `${n} min each half` };
const mod = (key: string): AnySportModule => {
  const m = moduleFor(key);
  if (m === null) throw new Error(`no builtin ${key}`);
  return m;
};
const ctxOf = (sportKey: string, stageKind: StageKind | null, variant: string | null): MatchFormCtx => ({ sportKey, module: mod(sportKey), stageKind, variant });
/** The sport's own variant config, parsed (defaults in) - the stage's format when the stage writes no rules. */
const variantCfg = (sport: string, variant: string): Record<string, unknown> =>
  mod(sport).configSchema.parse(mod(sport).variants[variant]) as Record<string, unknown>;
/** A knockout stage's football format with extra time 2 x `half`. */
const footballWithEt = (half: number, enabled = true): Record<string, unknown> => ({
  ...variantCfg("football", "11-a-side"),
  extraTime: { enabled, halfMinutes: half },
  shootout: true,
});

describe("football extra time (the Task 5 carry): opens at the stage's value, offers off or shorter only", () => {
  const ctx = ctxOf("football", "knockout", "11-a-side");

  it("a stage with extra time 2 x 10: the field opens at 10, and 15 (the field's own default) is not offered", () => {
    const stage = footballWithEt(10);
    const fields = matchFormFields(ctx, stage, hydrateMatchValues(ctx, stage, stage, LABELS), LABELS);
    const et = fields.find((f) => f.field.key === "extraTime")!;
    expect(et, "football's extra time is a match field").toBeDefined();
    expect(et.bound).toBe("off_or_shorter");
    expect(et.held).toBe(false);
    const values = hydrateMatchValues(ctx, stage, stage, LABELS);
    expect(values.extraTime, "opens AT the stage's resolved half length").toBe("10");
    const offered = et.field.options!.map((o) => o.value);
    expect(offered, "the field's old default (15) is longer than the stage's and is not offered").not.toContain("15");
    expect(offered).toContain("off");
    expect(offered).toContain("10");
    expect(offered).toContain("1");
    expect(Math.max(...offered.filter((v) => v !== "off").map(Number)), "nothing offered is longer than the stage's").toBe(10);
  });

  it("every offered option is accepted by the engine's own check, and the next length up is refused (derived from the bound)", () => {
    const m = mod("football");
    let accepted = 0;
    for (const half of [5, 10, 15, 20]) {
      const stage = footballWithEt(half);
      const values0 = hydrateMatchValues(ctx, stage, stage, LABELS);
      const et = matchFormFields(ctx, stage, values0, LABELS).find((f) => f.field.key === "extraTime")!;
      const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
      for (const o of et.field.options!) {
        const fragment = matchFragment(ctx, { ...values0, extraTime: o.value }, stageValues, stage);
        const verdict = checkFixtureOverride(m, "knockout", "11-a-side", stage, fragment);
        expect(verdict.ok, `stage ${half}: offered "${o.value}" -> ${JSON.stringify(fragment)}`).toBe(true);
        accepted++;
      }
      // The control the old field would have written ("On", 15 minutes) - and the next length up from the stage - are refused.
      for (const longer of [half + 1, 15 === half ? 16 : 15]) {
        const verdict = checkFixtureOverride(m, "knockout", "11-a-side", stage, { extraTime: { enabled: true, halfMinutes: longer } });
        if (longer > half) expect(verdict.ok, `stage ${half}: ${longer} is refused`).toBe(false);
      }
    }
    expect(accepted, "the sweep checked offered options").toBeGreaterThan(20);
  });

  it("choosing 'Off' sends extra time off with the stage's own length; choosing a shorter length sends it on at that length", () => {
    const stage = footballWithEt(10);
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const send = (extraTime: string) => {
      const values = { ...stageValues, extraTime };
      return matchFragment(ctx, values, stageValues, stage);
    };
    expect(send("off")).toEqual({ extraTime: { enabled: false, halfMinutes: 10 } });
    expect(send("7")).toEqual({ extraTime: { enabled: true, halfMinutes: 7 } });
    expect(send("10"), "the stage's own value is no change: nothing is sent").toEqual({});
    expect(send(""), "blank is 'use the stage's': nothing is sent").toEqual({});
  });

  it("a stage with extra time OFF: the field is held at Off and offers only Off - a match cannot switch it on", () => {
    const stage = footballWithEt(15, false);
    const values = hydrateMatchValues(ctx, stage, stage, LABELS);
    expect(values.extraTime).toBe("off");
    const et = matchFormFields(ctx, stage, values, LABELS).find((f) => f.field.key === "extraTime")!;
    expect(et.held).toBe(true);
    expect(et.field.options!.map((o) => o.value)).toEqual(["off"]);
    // Held fields send nothing, even if a value were forced into the form.
    expect(matchFragment(ctx, { ...values, extraTime: "9" }, values, stage)).toEqual({});
    // ...and the engine agrees that it would refuse that very override.
    expect(checkFixtureOverride(mod("football"), "knockout", "11-a-side", stage, { extraTime: { enabled: true, halfMinutes: 9 } }).ok).toBe(false);
  });

  it("an override already in force opens at ITS value, labelled 'this match', and the stage's value stays the 'stage' one", () => {
    const stage = footballWithEt(10);
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const effective = mergeRulesOverride(stage, { extraTime: { enabled: true, halfMinutes: 5 } }) as Record<string, unknown>;
    const values = hydrateMatchValues(ctx, stage, effective, LABELS);
    expect(values.extraTime).toBe("5");
    expect(matchSource("extraTime", values, stageValues)).toBe("match");
    expect(matchSource("extraTime", stageValues, stageValues)).toBe("stage");
    expect(matchSource("extraTime", { ...values, extraTime: "" }, stageValues), "blank is the stage's").toBe("stage");
  });
});

describe("the other bounded keys: a number a match may only shorten opens at its value with a max of the stage's", () => {
  it("football shoot-out kicks: max is the stage's value, or the engine's declared default when the stage writes none", () => {
    const ctx = ctxOf("football", "knockout", "11-a-side");
    const fact = ruleKeyOwning(mod("football"), ["shootoutAttempts"])!.fact;
    expect(fact.matchBound).toBe("shorter");
    // The stage writes 3 kicks: a match may use 1-3.
    const three = { ...footballWithEt(10), shootoutAttempts: 3 };
    const f3 = matchFormFields(ctx, three, hydrateMatchValues(ctx, three, three, LABELS), LABELS).find((f) => f.field.key === "shootoutAttempts")!;
    expect(f3.bound).toBe("shorter");
    expect(f3.field.max).toBe(3);
    // The stage writes none: the bound is the engine's own `whenAbsent` (5), declared, not typed here.
    const none = footballWithEt(10);
    const fN = matchFormFields(ctx, none, hydrateMatchValues(ctx, none, none, LABELS), LABELS).find((f) => f.field.key === "shootoutAttempts")!;
    expect(fact.whenAbsent, "the engine declares a default").toBeGreaterThan(0);
    expect(fN.field.max).toBe(fact.whenAbsent);
  });

  it("the extremes the field offers (its min and its max) are accepted by the engine; one past the max is refused", () => {
    const ctx = ctxOf("football", "knockout", "11-a-side");
    const stage = { ...footballWithEt(10), shootoutAttempts: 4 };
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const f = matchFormFields(ctx, stage, stageValues, LABELS).find((x) => x.field.key === "shootoutAttempts")!;
    for (const n of [f.field.min!, f.field.max!]) {
      const values = { ...stageValues, shootoutAttempts: String(n) };
      const fragment = matchFragment(ctx, values, stageValues, stage);
      expect(checkFixtureOverride(mod("football"), "knockout", "11-a-side", stage, fragment).ok, `kicks ${n}`).toBe(true);
    }
    expect(checkFixtureOverride(mod("football"), "knockout", "11-a-side", stage, { shootoutAttempts: f.field.max! + 1 }).ok).toBe(false);
  });

  it("a shoot-out the stage does not play holds its kicks - a match cannot add one (the detail follows its decider)", () => {
    const ctx = ctxOf("football", "knockout", "11-a-side");
    const on = { ...footballWithEt(10), shootout: true };
    const off = { ...footballWithEt(10), shootout: false };
    const kicks = (stage: Record<string, unknown>) =>
      matchFormFields(ctx, stage, hydrateMatchValues(ctx, stage, stage, LABELS), LABELS).find((f) => f.field.key === "shootoutAttempts")!;
    expect(kicks(on).held, "premise: played shoot-out, editable kicks").toBe(false);
    expect(kicks(off).held, "no shoot-out in the stage: its kicks are held").toBe(true);
    // And a held field sends nothing, whatever the form holds.
    const values = { ...hydrateMatchValues(ctx, off, off, LABELS), shootoutAttempts: "3" };
    expect(matchFragment(ctx, values, hydrateMatchValues(ctx, off, off, LABELS), off)).toEqual({});
  });

  it("a stage value below the field's own minimum lowers the minimum to it - the field never offers a floor above its ceiling", () => {
    const ctx = ctxOf("icehockey", "knockout", null);
    const m = mod("icehockey");
    const fact = ruleKeyOwning(m, ["shootout", "attempts"])!.fact;
    expect(fact.matchBound).toBe("shorter");
    const base = variantCfg("icehockey", Object.keys(m.variants)[0]!);
    const shootout = base.shootout as { attempts: number };
    const probe = matchFormFields(ctx, base, hydrateMatchValues(ctx, base, base, LABELS), LABELS).find((f) => f.field.key === "shootoutAttempts")!;
    const floor = probe.field.min!;
    expect(floor, "premise: the curated field has a floor above 1").toBeGreaterThan(1);
    const stage = { ...base, shootout: { ...shootout, attempts: floor - 1 } };
    const f = matchFormFields(ctx, stage, hydrateMatchValues(ctx, stage, stage, LABELS), LABELS).find((x) => x.field.key === "shootoutAttempts")!;
    expect(f.field.max).toBe(floor - 1);
    expect(f.field.min, "min follows the ceiling down").toBe(floor - 1);
  });

  it("ice hockey overtime minutes (a nested key) opens at the stage's value; held when the stage plays no overtime", () => {
    const ctx = ctxOf("icehockey", "knockout", null);
    const m = mod("icehockey");
    const base = variantCfg("icehockey", Object.keys(m.variants)[0]!);
    const withOt = { ...base, overtime: { kind: "sudden_death", minutes: 8, skaters: 3 } };
    const v = hydrateMatchValues(ctx, withOt, withOt, LABELS);
    const f = matchFormFields(ctx, withOt, v, LABELS).find((x) => x.field.key === "overtimeMinutes")!;
    expect(v.overtimeMinutes).toBe("8");
    expect(f.bound).toBe("shorter");
    expect(f.held).toBe(false);
    expect(f.field.max).toBe(8);
    const values = { ...v, overtimeMinutes: "5" };
    const fragment = matchFragment(ctx, values, v, withOt);
    expect(fragment, "the stage's whole overtime object with one number changed").toEqual({ overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } });
    expect(checkFixtureOverride(m, "knockout", null, withOt, fragment).ok).toBe(true);

    const noOt = { ...base, overtime: null };
    const g = matchFormFields(ctx, noOt, hydrateMatchValues(ctx, noOt, noOt, LABELS), LABELS).find((x) => x.field.key === "overtimeMinutes")!;
    expect(g.held, "no overtime in the stage: the minutes mean nothing, and a match cannot add one").toBe(true);
  });
});

describe("the fragment is what differs from the stage - and nothing else", () => {
  it("badminton: untouched sends nothing; one changed field sends just that key; changing it back sends nothing again", () => {
    const ctx = ctxOf("badminton", "league", "short");
    const stage = variantCfg("badminton", "short");
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const fields = (v: Record<string, string>) => matchFormFields(ctx, stage, v, LABELS);
    expect(matchFragment(ctx, stageValues, stageValues, stage), "untouched").toEqual({});
    const bestOf = fields(stageValues).find((f) => f.field.key === "bestOf")!.field;
    const other = bestOf.options!.map((o) => o.value).find((v) => v !== stageValues.bestOf)!;
    const changed = { ...stageValues, bestOf: other };
    const frag = matchFragment(ctx, changed, stageValues, stage);
    expect(frag, "just the changed key").toEqual({ bestOf: Number(other) });
    expect(checkFixtureOverride(mod("badminton"), "league", "short", stage, frag).ok).toBe(true);
    expect(matchFragment(ctx, stageValues, stageValues, stage), "changed back").toEqual({});
  });

  it("a key the override carries that no match field edits is kept, not dropped, by a whole-fragment replace", () => {
    const ctx = ctxOf("badminton", "league", "short");
    const stage = variantCfg("badminton", "short");
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const frag = matchFragment(ctx, stageValues, stageValues, stage, { someKeyNoFieldEdits: 7 });
    expect(frag).toEqual({ someKeyNoFieldEdits: 7 });
  });

  it("best of 1: ONE 'Points to win' field (the shadow key is hidden) and a change writes BOTH keys, as the stage editor does", () => {
    const ctx = ctxOf("badminton", "league", "bwf");
    const stage = variantCfg("badminton", "bwf");
    expect(stage.bestOf as number, "premise: the stage plays more than one set").toBeGreaterThan(1);
    const keysOf = (v: Record<string, string>) => matchFormFields(ctx, stage, v, LABELS).map((f) => f.field.key);
    const open = hydrateMatchValues(ctx, stage, stage, LABELS);
    expect(keysOf(open), "best of 3: both points fields").toEqual(expect.arrayContaining([BEST_OF_ONE_PAIR.shown, BEST_OF_ONE_PAIR.shadow]));

    const one = setRuleValue("badminton", open, "bestOf", "1", stage);
    const edited = setRuleValue("badminton", one, BEST_OF_ONE_PAIR.shown, "15", stage);
    expect(keysOf(edited), "best of 1: the shadow key is hidden").not.toContain(BEST_OF_ONE_PAIR.shadow);
    expect(keysOf(edited), "...and the shown one stays").toContain(BEST_OF_ONE_PAIR.shown);
    const shownField = matchFormFields(ctx, stage, edited, LABELS).find((f) => f.field.key === BEST_OF_ONE_PAIR.shown)!;
    expect(shownField.field.label).toBe(SINGLE_SET_POINTS_LABEL);

    const frag = matchFragment(ctx, edited, open, stage);
    expect(frag, "the hidden key is written too, to the same number").toEqual({ bestOf: 1, [BEST_OF_ONE_PAIR.shown]: 15, [BEST_OF_ONE_PAIR.shadow]: 15 });
    expect(checkFixtureOverride(mod("badminton"), "league", "bwf", stage, frag).ok).toBe(true);
  });

  it("a stored override's key that a match field edits is the form's to say: set back to the stage's, it leaves the fragment", () => {
    const ctx = ctxOf("badminton", "league", "short");
    const stage = variantCfg("badminton", "short");
    const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
    const frag = matchFragment(ctx, stageValues, stageValues, stage, { bestOf: 1, someKeyNoFieldEdits: 7 });
    expect(frag).toEqual({ someKeyNoFieldEdits: 7 });
    expect("bestOf" in frag, "the edited key is not carried over from the stored override").toBe(false);
  });

  it("the block re-seeds when the page's facts change, and only then", () => {
    const stage = variantCfg("badminton", "short");
    const base = { override: null, state: "unstarted" as const, effective: stage, stageResolved: stage };
    const key = blockSeedKey(base);
    expect(blockSeedKey({ ...base })).toBe(key);
    expect(blockSeedKey({ ...base, override: { bestOf: 1 } }), "override").not.toBe(key);
    expect(blockSeedKey({ ...base, state: "live" }), "state").not.toBe(key);
    expect(blockSeedKey({ ...base, effective: { ...stage, bestOf: 1 } }), "effective").not.toBe(key);
    expect(blockSeedKey({ ...base, stageResolved: { ...stage, bestOf: 5 } }), "stage").not.toBe(key);
  });

  it("dirty: equal value sets are clean, a changed value is dirty, a key order difference is not a change", () => {
    expect(matchFormDirty({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(false);
    expect(matchFormDirty({ a: "1" }, { a: "2" })).toBe(true);
    expect(matchFormDirty({ a: "1" }, { a: "1", b: "x" })).toBe(true);
    expect(matchFormDirty({ a: "1", b: "" }, { a: "1" }), "an absent value and a blank are the same").toBe(false);
  });
});

describe("every sport and stage kind: what the form offers, the engine accepts (counted)", () => {
  it("each match field's offered options and number extremes, fed through checkFixtureOverride, are never refused", () => {
    let cells = 0;
    let offeredChecked = 0;
    let withFields = 0;
    for (const m of builtinModules) {
      for (const kind of StageKind.options) {
        for (const variant of Object.keys(m.variants)) {
          const ctx: RuleContext & { sportKey: string } = { sportKey: m.key, module: m, stageKind: kind, variant };
          // The stage plays the variant's own format; a knockout also plays the sport's preset deciders.
          const preset = (m.stageDefaults?.(kind, variant) ?? {}) as Record<string, unknown>;
          const stage = m.configSchema.parse({ ...(m.variants[variant] as object), ...preset }) as Record<string, unknown>;
          const stageValues = hydrateMatchValues(ctx, stage, stage, LABELS);
          const fields = matchFormFields(ctx, stage, stageValues, LABELS);
          cells++;
          if (fields.length > 0) withFields++;
          // Every field belongs to the match scope the engine declares for this cell.
          const matchKeys = new Set(fixtureKeysFor(m, kind, variant));
          for (const f of fields) for (const k of f.field.edits) expect(matchKeys.has(k), `${m.key}/${kind}/${variant} ${f.field.key} edits ${k}`).toBe(true);
          for (const f of fields) {
            if (f.held) continue;
            const candidates: string[] =
              f.field.kind === "number" ? [f.field.min, f.field.max].filter((n): n is number => n !== undefined).map(String)
              : f.field.kind === "bool" ? ["on", "off"]
              : (f.field.options ?? []).map((o) => o.value);
            for (const c of candidates) {
              const values = { ...stageValues, [f.field.key]: c };
              const frag = matchFragment(ctx, values, stageValues, stage);
              if (Object.keys(frag).length === 0) { offeredChecked++; continue; }
              // The writer parses the corrected format first (a refusal there is CONFIG_INVALID, the schema's, not the bound's):
              // only a corrected format the schema takes is asked of the bound.
              const merged = mergeRulesOverride(stage, frag);
              if (!m.configSchema.safeParse(merged).success) { offeredChecked++; continue; }
              const parsedStage = m.configSchema.parse(stage) as Record<string, unknown>;
              const whole = Object.fromEntries(Object.keys(frag).map((k) => [k, (m.configSchema.parse(merged) as Record<string, unknown>)[k]]));
              const verdict = checkFixtureOverride(m, kind, variant, parsedStage, whole);
              expect(verdict.ok, `${m.key}/${kind}/${variant}: ${f.field.key}=${c} -> ${JSON.stringify(frag)}`).toBe(true);
              offeredChecked++;
            }
          }
        }
      }
    }
    expect(cells, "the whole registry was swept").toBe(builtinModules.reduce((n, m) => n + StageKind.options.length * Object.keys(m.variants).length, 0));
    expect(withFields, "some cells have match fields").toBeGreaterThan(0);
    expect(offeredChecked, "options were checked").toBeGreaterThan(50);
  });
});

describe("the page seam: a sport with nothing to change for one match gets no block", () => {
  it("every sport x stage kind x variant: the block is offered exactly when the engine declares a match key the form has a field for (counted)", () => {
    let cells = 0;
    let offered = 0;
    let withheld = 0;
    for (const m of builtinModules)
      for (const kind of StageKind.options)
        for (const variant of Object.keys(m.variants)) {
          const ctx = ctxOf(m.key, kind, variant);
          const stage = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
          const fields = matchFieldsFor(ctx).map((f) => f);
          const props = matchRulesBlockProps("f", {
            sportKey: m.key, stageKind: kind, variant, stageLine: "", stageResolved: stage, effective: stage, override: null, state: "unstarted", fields,
          });
          cells++;
          if (fixtureKeysFor(m, kind, variant).length === 0) expect(props, `${m.key}/${kind}/${variant}: no match key, no block`).toBeUndefined();
          if (fields.length === 0) { expect(props, `${m.key}/${kind}/${variant}: no field, no block`).toBeUndefined(); withheld++; }
          else { expect(props, `${m.key}/${kind}/${variant}: has fields, block offered`).toBeDefined(); offered++; }
        }
    expect(cells).toBe(builtinModules.reduce((n, m) => n + StageKind.options.length * Object.keys(m.variants).length, 0));
    expect(offered, "some cells offer the block").toBeGreaterThan(0);
    expect(withheld, "some cells (a sport with no match key) withhold it").toBeGreaterThan(0);
  });

  it("a finished match with no override is still offered where the sport has fields (the lock sentence is the content)", () => {
    const stage = variantCfg("badminton", "short");
    const props = matchRulesBlockProps("f", {
      sportKey: "badminton", stageKind: "league", variant: "short", stageLine: "", stageResolved: stage, effective: stage, override: null, state: "locked",
      fields: matchFieldsFor(ctxOf("badminton", "league", "short")),
    });
    expect(props?.state).toBe("locked");
  });
});

describe("the page seam: what crosses from the server page to the console is JSON, and only the named facts", () => {
  it("the mapper keeps the nine facts, drops anything else the loader grows (a function-valued `fields`), and survives a JSON round trip", () => {
    const stage = variantCfg("badminton", "short");
    const loaded = {
      sportKey: "badminton",
      stageKind: "league" as StageKind,
      variant: "short",
      stageLine: "Best of 3 to 21",
      stageResolved: stage,
      effective: stage,
      override: null,
      state: "unstarted" as const,
      // What the real loader also returns: function-valued rule fields, which an RSC payload cannot carry.
      fields: matchFormFields(ctxOf("badminton", "league", "short"), stage, {}, LABELS).map((f) => f.field),
    };
    const props = matchRulesBlockProps("fx-1", loaded);
    expect(props, "the sport has fields, so the block is offered").toBeDefined();
    if (props === undefined) return;
    expect(Object.keys(props).sort()).toEqual(["effective", "fixtureId", "override", "sportKey", "stageKind", "stageLine", "stageResolved", "state", "variant"]);
    const facts = Object.fromEntries(Object.entries(loaded).filter(([k]) => k !== "fields"));
    expect(props, "each fact arrives as the loader gave it").toEqual({ fixtureId: "fx-1", ...facts });
    expect(props.fixtureId).toBe("fx-1");
    expect("fields" in props).toBe(false);
    expect(JSON.parse(JSON.stringify(props))).toEqual(props);
    expect(loaded.fields.length, "premise: the loader's fields are function-valued, so a leak would not survive JSON").toBeGreaterThan(0);
    expect(typeof loaded.fields[0]!.build).toBe("function");
  });
});
