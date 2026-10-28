// W2e Task 8c (owner D19; rule row CK-BO-2) - the overs field in each editor that mounts it, driven through that editor's
// REAL pure producer, with the Hundred's stored config in and the config the engine accepts out.
//
// `cricket-overs.test.ts` (lib/match-rules) proves the field converts by the over length it is handed. This file proves the
// editors HAND it one (class 1, the inert seam: a field that reads `inherited` is worth nothing if a door never sends it):
//   - the division Settings tab (`divisionFormatPatch`, the saved config as the base),
//   - the stage row's editor (`stageFormatEditorValues` / `stageFormatSaveFragment`, the stage FRAGMENT over the division),
//   - the fixture console's match form (`hydrateMatchValues` / `matchFragment`, over the stage's resolved cfg).
// The division builder's own wiring is in `division-builder-cricket-overs.test.tsx`.
//
// Expected values come from the engine: the variants' own presets (`cricket.variants`) and `cricket.configSchema`, which
// is also what judges the config each door produces. Single-sport: overs and over lengths exist only in cricket.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { StageKind } from "@seazn/engine/core";
import { hydrateRuleValues } from "@/lib/match-rules";
import { moduleFor } from "@/lib/rule-scope";
import { stageFormatEditorValues } from "../stages-panel";
import { stageFormatSaveFragment } from "../stage-rules/stage-row-model";
import { divisionFormatPatch } from "../division-format-patch";
import { hydrateMatchValues, matchFragment, type MatchFormCtx, type MatchFormLabels } from "../match-rules-block-model";

type Cfg = { ballsPerInnings: number; ballsPerOver: number; maxOversPerBowler: number };
const VARIANTS = cricket.variants as Record<string, Record<string, unknown>>;
const parsed = (variant: string, over: Record<string, unknown> = {}): Cfg => cricket.configSchema.parse({ ...VARIANTS[variant], ...over }) as Cfg;
/** The variants a limited innings is cut into overs for, with the over length each declares (the engine's, not typed). */
const LIMITED = Object.keys(VARIANTS).filter((v) => typeof parsed(v).ballsPerInnings === "number");
const HUNDRED = "hundred";
const LABELS: MatchFormLabels = { off: "Off", halfMinutes: (n) => `${n}` };
const ctxFor = (variant: string): MatchFormCtx => ({ sportKey: "cricket", module: moduleFor("cricket")!, stageKind: StageKind.parse("league"), variant });
/** What the division stores: the preset merged with the organiser's overrides (`divisions.ts`: `{...variant.config, ...config}`). */
const stored = (variant: string): Record<string, unknown> => ({ ...VARIANTS[variant] });

/** The overs the ENGINE reads a config as: its own innings over its own over length. */
const engineOvers = (cfg: Record<string, unknown>): number => {
  const p = cricket.configSchema.parse(cfg) as Cfg;
  return p.ballsPerInnings / p.ballsPerOver;
};

describe("CK-BO-2 the division Settings tab (divisionFormatPatch)", () => {
  it("CK-BO-2 a stored Hundred opens on 20 overs; 10 overs saves 50 balls, which the engine reads back as 10 overs of five", () => {
    const config = stored(HUNDRED);
    const opened = hydrateRuleValues("cricket", config);
    expect(opened.overs, "reopens on the overs the engine reads").toBe(String(engineOvers(config)));
    const patch = divisionFormatPatch({
      sportKey: "cricket", divisionConfig: config, savedVariantKey: HUNDRED, variantKey: HUNDRED,
      ruleValues: { ...opened, overs: "10" }, pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
    });
    expect(patch.ballsPerInnings).toBe(10 * parsed(HUNDRED).ballsPerOver);
    expect(patch.ballsPerInnings, "not the six-ball answer").not.toBe(10 * 6);
    expect(patch.ballsPerOver, "the over length rides along untouched").toBe(parsed(HUNDRED).ballsPerOver);
    expect(engineOvers(patch), "judged by the engine's own schema").toBe(10);
  });

  it("CK-BO-2 every limited variant: untouched, the Settings save keeps its innings; editing to the same overs changes nothing", () => {
    let judged = 0;
    for (const v of LIMITED) {
      const config = stored(v);
      const opened = hydrateRuleValues("cricket", config);
      expect(opened.overs, `${v}: opens on overs`).toBe(String(engineOvers(config)));
      const patch = divisionFormatPatch({
        sportKey: "cricket", divisionConfig: config, savedVariantKey: v, variantKey: v,
        ruleValues: opened, pointsFieldKeys: [], pointsValues: {}, savedPoints: undefined, advanced: null,
      });
      expect(patch.ballsPerInnings, `${v}: the innings survives a save`).toBe(parsed(v).ballsPerInnings);
      judged++;
    }
    expect(judged, "variants judged").toBe(LIMITED.length);
    expect(LIMITED.length).toBeGreaterThan(2);
  });
});

describe("CK-BO-2 the stage row's editor (stageFormatEditorValues / stageFormatSaveFragment)", () => {
  const division = stored(HUNDRED);

  it("CK-BO-2 a Hundred stage with 60 balls opens on 12 overs (the division's over length), and 8 overs saves 40", () => {
    const bpo = parsed(HUNDRED).ballsPerOver;
    const fragment = { ballsPerInnings: 12 * bpo };
    const opened = stageFormatEditorValues("cricket", { rules: fragment }, division);
    expect(opened.overs).toBe("12");
    expect(opened.overs, "read in sixes it would be 10").not.toBe(String(fragment.ballsPerInnings / 6));
    const save = stageFormatSaveFragment("cricket", fragment, opened, { ...opened, overs: "8" }, division);
    expect(save).toEqual({ ballsPerInnings: 8 * bpo });
    expect(engineOvers({ ...division, ...save }), "the stage plays 8 overs").toBe(8);
  });

  it("CK-BO-2 a stage that names no innings opens blank on a Hundred division too (the division's innings is not borrowed)", () => {
    expect(stageFormatEditorValues("cricket", { rules: {} }, division).overs).toBeUndefined();
    expect(stageFormatEditorValues("cricket", {}, division).overs).toBeUndefined();
  });

  it("CK-BO-2 an untouched save re-sends the stored fragment, and the six-ball division still counts in sixes", () => {
    const bpo = parsed(HUNDRED).ballsPerOver;
    const fragment = { ballsPerInnings: 12 * bpo };
    const opened = stageFormatEditorValues("cricket", { rules: fragment }, division);
    expect(stageFormatSaveFragment("cricket", fragment, opened, opened, division)).toEqual(fragment);
    const t20 = stored("t20");
    const six = parsed("t20").ballsPerOver;
    const openedT20 = stageFormatEditorValues("cricket", { rules: { ballsPerInnings: 12 * six } }, t20);
    expect(openedT20.overs).toBe("12");
    expect(stageFormatSaveFragment("cricket", { ballsPerInnings: 12 * six }, openedT20, { ...openedT20, overs: "8" }, t20)).toEqual({ ballsPerInnings: 8 * six });
  });
});

describe("CK-BO-2 the stage row hands its editor the division's config when it OPENS", () => {
  // The editor hydrates on a click, and apps/web vitest has no DOM to click (class 2): `StageFormatRow.openEditor` is not
  // reachable from a node test, and the browser half is CI's e2e. What a node test CAN pin is the call itself - the one
  // line that carries the division's config into `stageFormatEditorValues`. A source scan is the weak witness, named as one.
  it("CK-BO-2 openEditor passes divisionConfig to stageFormatEditorValues (a call that drops it reads a Hundred stage in sixes)", () => {
    const panel = readFileSync(new URL("../stages-panel.tsx", import.meta.url), "utf8");
    const calls = panel.match(/stageFormatEditorValues\(sportKey, \{ \.\.\.stageConfig, rules \}[^)]*\)/g) ?? [];
    expect(calls, "the editor opens through exactly one call").toHaveLength(1);
    expect(calls[0]).toContain(", divisionConfig)");
  });
});

describe("CK-BO-2 the fixture console's match form (hydrateMatchValues / matchFragment)", () => {
  const stage = parsed(HUNDRED) as unknown as Record<string, unknown>;

  it("CK-BO-2 the form opens on the stage's 20 overs, and a match cut to 10 overs sends 50 balls", () => {
    const ctx = ctxFor(HUNDRED);
    const opened = hydrateMatchValues(ctx, stage, stage, LABELS);
    expect(opened.overs, "premise: overs is a match field of the Hundred").toBe(String(engineOvers(stage)));
    const sent = matchFragment(ctx, { ...opened, overs: "10" }, opened, stage);
    expect(sent).toEqual({ ballsPerInnings: 10 * parsed(HUNDRED).ballsPerOver });
    expect(engineOvers({ ...stage, ...sent }), "the match plays 10 overs").toBe(10);
  });

  it("CK-BO-2 a match already cut (an override) reads back in the stage's over length", () => {
    const ctx = ctxFor(HUNDRED);
    const effective = { ...stage, ballsPerInnings: 7 * parsed(HUNDRED).ballsPerOver };
    expect(hydrateMatchValues(ctx, stage, effective, LABELS).overs).toBe("7");
  });

  it("CK-BO-2 a match override that is only a FRAGMENT (no over length of its own) reads in the stage's over length", () => {
    // The console passes the merged effective cfg, which carries the over length, so this is the contract rather than today's
    // call; the reader must not depend on it (a fragment is what the PUT stores).
    const ctx = ctxFor(HUNDRED);
    const bpo = parsed(HUNDRED).ballsPerOver;
    const fragment = { ballsPerInnings: 7 * bpo };
    expect(hydrateMatchValues(ctx, stage, fragment, LABELS).overs).toBe("7");
    expect(hydrateMatchValues(ctx, stage, fragment, LABELS).overs, "read in sixes it is blank").not.toBe(undefined);
  });

  it("CK-BO-2 on a six-ball variant the same form counts in sixes (the positive pair)", () => {
    const t20 = parsed("t20") as unknown as Record<string, unknown>;
    const ctx = ctxFor("t20");
    const opened = hydrateMatchValues(ctx, t20, t20, LABELS);
    expect(opened.overs).toBe(String(engineOvers(t20)));
    expect(matchFragment(ctx, { ...opened, overs: "10" }, opened, t20)).toEqual({ ballsPerInnings: 10 * parsed("t20").ballsPerOver });
  });
});
