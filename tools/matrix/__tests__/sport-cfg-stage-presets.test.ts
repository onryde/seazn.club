// W2c Task 12, fix round 1 (R-T12-3) — the harness's `stageCfg` folds a fixture under the cfg the PRODUCT folds it
// under: since Task 12 a new stage is written with its sport's preset rules (`stageDefaults` for its kind and the
// division's variant), under any rules the create sent, and the product's resolver lays them over the division through
// ONE mapping (apps/web lib/stage-decider-off.ts `stageRulesOverlay`). So every knockout of football, hockey, ice hockey
// and limited-overs cricket plays its decider; a cell whose premise is a HELD level knockout posts its bracket stages
// with every decider off (X-SR-6's held arm, `HOLD_PATH_SCENARIOS`), and both arms are proved here.
//
// Expected values are the engine's own (`stageDefaultsFor`, `deciderKeysFor`, the variants' parsed cfg, the fold's
// `isLevelOutcome`, the sport's `configSchema`), never typed here. Swept over the registry.
import { forbidsLevelResult, isLevelOutcome, StageKind } from "@seazn/engine/core";
import { deciderKeysFor, stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { describe, expect, it } from "vitest";
import { foldStream } from "../lib/fold.ts";
import type { StagePostBody } from "../lib/catalogue.ts";
import type { StageRef } from "../lib/driver/types.ts";
import { newModelState } from "../lib/model/commands.ts";
import { builtAsPosted } from "../lib/scenarios/assertions.ts";
import { Recorder, caseStageCfg, postedStageRules, setUpDivision, type BuiltReadback } from "../lib/scenarios/common.ts";
import { HOLD_PATH_SCENARIOS, type CaseSpec } from "../lib/scenarios/types.ts";
import { decidersOffRulesFor, resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream, levelReachable } from "../lib/streams/index.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const MODULES = builtinModules as readonly AnySportModule[];
const phaseOf = (state: unknown): unknown => (state as { phase?: unknown } | null)?.phase;

describe("R-T12-3 stageCfg layers the stage's rules the product stores: its preset, then the rules it was posted", () => {
  it("X-SR-6 every preset key reaches the folded cfg; a kind with no preset and no bracket is untouched (registry sweep, counted)", () => {
    let presetKeys = 0;
    let untouched = 0;
    for (const m of MODULES) {
      for (const variant of Object.keys(m.variants)) {
        const cfg = resolveSportCfg(m.key, variant);
        for (const kind of StageKind.options) {
          const out = stageCfg(m.key, cfg, kind, variant) as Record<string, unknown>;
          const preset = stageDefaultsFor(m, kind, variant);
          for (const [k, v] of Object.entries(preset)) {
            expect(out[k], `${m.key}/${variant}/${kind}: ${k}`).toEqual(v);
            presetKeys++;
          }
          if (Object.keys(preset).length === 0 && !forbidsLevelResult(kind)) {
            expect(out, `${m.key}/${variant}/${kind}: the cfg as it came`).toBe(cfg);
            untouched++;
          }
        }
      }
    }
    expect(presetKeys, "anti-vacuity: the engine declares knockout presets").toBeGreaterThan(0);
    expect(untouched, "anti-vacuity: table stages swept too").toBeGreaterThan(0);
  });

  // The ruling's positive pairs: per affected sport, the same level regulation, folded under both arms. With every
  // decider off it is a level RESULT (held for the organiser); with the presets on the engine plays on into the decider
  // the preset switched on: no result, the match in another phase, the decider keys at the preset's values.
  const RULING_SPORTS = ["football", "hockey", "icehockey", "cricket"]; // the ruling names these four
  it("positive pairs: with the presets ON a level knockout goes to its decider; with every decider off the same level regulation is a held result (every affected sport and variant, counted)", () => {
    const pairs = new Map<string, number>();
    for (const m of MODULES) {
      for (const variant of Object.keys(m.variants)) {
        const preset = stageDefaultsFor(m, "knockout", variant);
        if (Object.keys(preset).length === 0) continue;
        const division = resolveSportCfg(m.key, variant);
        const held = stageCfg(m.key, division, "knockout", variant, decidersOffRulesFor(m.key, variant, "knockout"));
        if (!levelReachable(m.key, held, "knockout")) continue; // a sport whose preset is no level decider
        const on = stageCfg(m.key, division, "knockout", variant) as Record<string, unknown>;
        const where = `${m.key}/${variant}`;
        const level = generateStream({ sportKey: m.key, cfg: held, stageKind: "knockout", home: "H", away: "A", outcome: { kind: "level" } });
        const heldFold = foldStream(m, held, "H", "A", level);
        expect(heldFold.outcome !== null && isLevelOutcome(heldFold.outcome), `${where}: every decider off, a level result (held)`).toBe(true);
        // The other arm: the presets the product stores, and the engine's own answer to the same events.
        for (const k of deciderKeysFor(m, "knockout", variant).filter((key) => Object.hasOwn(preset, key))) {
          expect(on[k], `${where}: ${k} is the preset's`).toEqual(preset[k]);
        }
        expect(levelReachable(m.key, on, "knockout"), `${where}: no level result with the presets on`).toBe(false);
        const onFold = foldStream(m, on, "H", "A", level);
        expect(onFold.outcome, `${where}: level regulation decides nothing, the decider is owed`).toBeNull();
        expect(phaseOf(onFold.state), `${where}: the match moved on into the decider`).not.toEqual(phaseOf(heldFold.state));
        pairs.set(m.key, (pairs.get(m.key) ?? 0) + 1);
      }
    }
    expect([...pairs.keys()].sort(), "the sports a preset decider plays on are exactly the ruling's").toEqual([...RULING_SPORTS].sort());
    for (const sport of RULING_SPORTS) expect(pairs.get(sport) ?? 0, `${sport}: no pair`).toBeGreaterThan(0);
    expect([...pairs.values()].reduce((a, b) => a + b, 0), "anti-vacuity").toBeGreaterThan(0);
  });

  it("the held arm goes through the product's ONE mapping: a period sport's `false` reaches the engine as its off, never as `false`; every held cfg is one the sport's schema takes (counted)", () => {
    let parsed = 0;
    let mapped = 0;
    for (const m of MODULES) {
      for (const variant of Object.keys(m.variants)) {
        const rules = decidersOffRulesFor(m.key, variant, "knockout") ?? {};
        if (Object.keys(rules).length === 0) continue;
        const held = stageCfg(m.key, resolveSportCfg(m.key, variant), "knockout", variant, rules) as Record<string, unknown>;
        expect(m.configSchema.safeParse(held).success, `${m.key}/${variant}: the engine takes the held cfg`).toBe(true);
        parsed++;
        for (const [k, v] of Object.entries(rules)) {
          if (v !== false) continue;
          // `false` is either the engine's own value at k (a boolean decider) or the stage encoding the mapping turns
          // into the engine's null; never a `false` the schema refuses.
          const asSent = m.configSchema.safeParse({ ...resolveSportCfg(m.key, variant) as object, [k]: false }).success;
          expect(held[k], `${m.key}/${variant}: ${k}`).toBe(asSent ? false : null);
          if (!asSent) mapped++;
        }
      }
    }
    expect(parsed, "anti-vacuity: some sport has deciders to switch off").toBeGreaterThan(0);
    expect(mapped, "anti-vacuity: a period sport's false was mapped").toBeGreaterThan(0);
  });

  it("posted rules win over the preset key by key, and a posted null removes a preset key (the stage inherits the division's value)", () => {
    const m = sportModule("football"); // single-sport: the merge is key by key and sport-blind; football has a multi-key preset
    const division = resolveSportCfg("football", "11-a-side") as Record<string, unknown>;
    const preset = stageDefaultsFor(m, "knockout", "11-a-side");
    const keys = Object.keys(preset);
    expect(keys.length, "the premise: a preset with keys to override").toBeGreaterThan(1);
    const [first, second] = keys as [string, string];
    const removed = stageCfg("football", division, "knockout", "11-a-side", { [first]: null }) as Record<string, unknown>;
    expect(removed[first], `${first}: inherited`).toEqual(division[first]);
    expect(removed[second], `${second}: still the preset's`).toEqual(preset[second]);
    expect(division[first], "the right answer differs from the preset's").not.toEqual(preset[first]);
  });
});

describe("R-T12-3 the hold-path cases post every decider off, through setUpDivision, and no other case posts any rules", () => {
  it("BRACKET_SETTLE_LEVEL posts the knockout with every decider off and plays it; LIFECYCLE posts none and plays the presets", async () => {
    let checked = 0;
    for (const scenario of ["BRACKET_SETTLE_LEVEL", "LIFECYCLE"] as const) {
      const variant = "11-a-side";
      const driver = new FakeKnockoutDriver();
      const spec: CaseSpec = { caseId: `knockout|football|${scenario}`, row: "knockout", sport: "football", variant, scenario, canary: false };
      const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg("football", variant), tag: "t", denied: [] };
      await setUpDivision(ctx, new Recorder(), 4);
      const stored = driver.stage?.config.rules;
      const want = HOLD_PATH_SCENARIOS.has(scenario) ? decidersOffRulesFor("football", variant, "knockout") : undefined;
      expect(stored, scenario).toEqual(want);
      expect(postedStageRules(spec, "knockout"), scenario).toEqual(want);
      expect(postedStageRules(spec, "league"), `${scenario}: a table stage posts none`).toBeUndefined();
      expect(caseStageCfg(ctx, "knockout"), scenario).toEqual(stageCfg("football", ctx.cfg, "knockout", variant, want));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a hold-path case on a template is refused by name before any driver call (its stages are never posted)", async () => {
    const driver = new FakeKnockoutDriver();
    const spec: CaseSpec = { caseId: "t", row: "knockout", sport: "football", variant: "11-a-side", scenario: "BRACKET_SETTLE_LEVEL", canary: false, template: "any" };
    const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg("football", "11-a-side"), tag: "t", denied: [] };
    await expect(setUpDivision(ctx, new Recorder(), 4)).rejects.toThrow(/hold-path case posts its bracket stages with every decider off/);
    expect(driver.stage, "nothing was posted").toBeNull();
  });

  it("the model posts its bracket stage with every decider off (its Settle drives the hold path) and its table stage with none, and folds under what it posted", async () => {
    // The model fake builds a league or swiss stage only, so it is handed the body as a league and the POSTED body kept.
    class Recording extends ModelFakeDriver {
      posted: StagePostBody[] = [];
      override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
        this.posted.push(...stages);
        return super.postStages(d, stages.map((b) => ({ ...b, kind: "league" })));
      }
    }
    let checked = 0;
    for (const row of ["knockout", "league"] as const) {
      const d = new Recording({});
      const m = await newModelState({ driver: d, row, sport: "football", variant: "11-a-side", entrants: 4, tag: "t" });
      const want = decidersOffRulesFor("football", "11-a-side", d.posted[0]!.kind as StageKind);
      expect(want === undefined, `${row}: the premise, a bracket and a table`).toBe(row === "league");
      expect(d.posted[0]!.config.rules, `${row}: posted`).toEqual(want);
      expect(m.stageRules, `${row}: the model's own record of it`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("life-built-as-posted judges a posted `rules` key by key over the preset the product stores with it: a value as sent, a null as no value", () => {
    const variant = "11-a-side";
    const rules = { ...decidersOffRulesFor("football", variant, "knockout"), shootoutAttempts: null };
    const body = { kind: "knockout", name: "KO", config: { rules }, progression: null, seq: 1 };
    const posted = { sport: "football", variant, stages: [body], entrants: [], config: {} };
    // What the product stores: the preset, the posted keys over it, the posted null removing its key.
    const stored = { ...stageDefaultsFor(sportModule("football"), "knockout", variant), ...rules } as Record<string, unknown>;
    delete stored.shootoutAttempts;
    expect(Object.keys(stored).length, "the premise: the posted rules are not the whole stored object").toBeGreaterThanOrEqual(Object.keys(rules).length - 1);
    const good: BuiltReadback = {
      posted,
      division: { id: "d1", slug: "d", sportKey: "football", variantKey: variant, config: {} },
      stages: [{ id: "s1", seq: 1, kind: "knockout", config: { rules: stored }, status: "active" }],
      entrants: [],
      echo: [],
    };
    const observed = { stages: [] } as never;
    // 2 division + 1 stage count + 1 kind + one per posted rules key + 1 third place + 2 entrant counts.
    expect(builtAsPosted(good, observed)).toMatchObject({ verdict: "pass", checked: 7 + Object.keys(rules).length });
    const withStored = (r: Record<string, unknown>) => builtAsPosted({ ...good, stages: [{ ...good.stages[0]!, config: { rules: r } }] }, observed);
    expect(withStored({ ...stored, shootout: true }), "a decider stored on that was posted off").toMatchObject({ verdict: "fail", evidence: ["stage 1 config.rules.shootout: built true, posted false"] });
    expect(withStored({ ...stored, shootoutAttempts: 5 }), "a posted null stored as a value").toMatchObject({ verdict: "fail", evidence: ["stage 1 config.rules.shootoutAttempts: built 5, posted null"] });
  });
});
