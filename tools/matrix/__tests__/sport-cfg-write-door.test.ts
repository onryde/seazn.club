// W2e Task 24 (carry from T13/T23 reviews, precedent beed06ac4c): `resolveSportCfg` is the cfg a division could be WRITTEN with, so it
// applies the write door (`writeConfigIssues`: TN-CF-1 a tennis best of 1 with a match tie-break, VB-CF-1 / TT-CF-1 a set target
// below the engine's floor) after the schema. A combination the door refuses is no case: the variants generator (variants.ts) cannot
// build it, so it is never planned, and a pair that exists ONLY there is listed uncoverable naming the rule row.
//
// Expected values: the sports and floors are the ENGINE's declarations (`configWriteIssues`, found by asking the door), the rule rows
// are the rulebook's (typed once, below), the refused counts are the engine door's own answers over the generator's input - never
// read back from sport-cfg.ts or variants.ts.
import { writeConfigIssues, BO1_MATCH_TIEBREAK, setTargetBelowFloor } from "@seazn/engine/sport";
import { describe, expect, it } from "vitest";
import { buildRuleOverride, visibleRuleFields } from "../../../apps/web/src/lib/match-rules/index.ts";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { CfgInvalid, WRITE_DOOR_ROW, WriteDoorRowUnnamed, writeDoorRefusal, resolveSchemaCfg, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { buildSportVariants, buildVariant, factorsFor, offlineBuilderDefault } from "../lib/variants.ts";

/** The rulebook's row for each sport that declares a write door (VB-CF-1, TT-CF-1, TN-CF-1: docs/rules rows named in the engine). */
const RULEBOOK_ROW: Readonly<Record<string, string>> = { volleyball: "VB-CF-1", tabletennis: "TT-CF-1", tennis: "TN-CF-1" };
const DOOR_SPORTS = SPORT_KEYS.filter((s) => sportModule(s).configWriteIssues !== undefined);
/** The smallest `setTo = finalSetTo` the engine's door accepts, FOUND by asking it (1 = no floor). */
function floorOf(sport: string, variant: string): number {
  for (let n = 1; n <= 40; n++) if (writeConfigIssues(sportModule(sport), resolveSchemaCfg(sport, variant, { setTo: n, finalSetTo: n })).length === 0) return n;
  throw new Error(`${sport}/${variant}: no set target up to 40 passes the door`);
}

describe("the write door in resolveSportCfg", () => {
  it("empty case first: the sports that declare a door are exactly the rulebook's three (counted), and each has its row", () => {
    expect([...DOOR_SPORTS].sort(), "the engine's declarations").toEqual(Object.keys(RULEBOOK_ROW).sort());
    expect(DOOR_SPORTS.length).toBe(3);
    expect(WRITE_DOOR_ROW).toEqual(RULEBOOK_ROW);
  });

  it("every SHIPPED variant passes the door (registry sweep, counted), so no preset is itself a refusal", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const v of variantKeys(s)) { expect(() => resolveSportCfg(s, v), `${s}/${v}`).not.toThrow(); n++; }
    expect(n).toBe(SPORT_KEYS.reduce((m, s) => m + variantKeys(s).length, 0));
    expect(n).toBeGreaterThan(SPORT_KEYS.length);
  });

  it("refuses what the door refuses, naming the rule row and the engine's sentence; the schema-only resolver does not; the floor itself passes", () => {
    // TN-CF-1: a best of 1 whose final set is a match tie-break.
    const bo1 = { bestOf: 1, finalSet: { matchTiebreakTo: 10 } };
    const err = (() => { try { resolveSportCfg("tennis", "tour", bo1); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(CfgInvalid);
    expect((err as Error).message).toContain("TN-CF-1");
    expect((err as Error).message).toContain(BO1_MATCH_TIEBREAK);
    expect(resolveSchemaCfg("tennis", "tour", bo1), "the schema alone accepts it (E15: a stored one still loads)").toMatchObject({ bestOf: 1 });
    expect(() => resolveSportCfg("tennis", "tour", { bestOf: 1, finalSet: { tiebreakTo: 10 } }), "a best of 1 with a final-set TIE-BREAK is a set, lawful").not.toThrow();
    // VB-CF-1 / TT-CF-1: a set target below the floor.
    for (const [sport, variant] of [["volleyball", "indoor"], ["tabletennis", "bo5"]] as const) {
      const floor = floorOf(sport, variant);
      expect(floor, `${sport}: the engine declares a floor above 1`).toBeGreaterThan(1);
      const below = { setTo: floor - 1, finalSetTo: floor - 1 };
      let thrown: unknown = null;
      try { resolveSportCfg(sport, variant, below); } catch (e) { thrown = e; }
      expect(thrown, sport).toBeInstanceOf(CfgInvalid);
      expect((thrown as Error).message, sport).toContain(RULEBOOK_ROW[sport]!);
      expect((thrown as Error).message, sport).toContain(setTargetBelowFloor(floor));
      expect(resolveSchemaCfg(sport, variant, below), `${sport}: schema-only accepts it`).toMatchObject(below);
      expect(() => resolveSportCfg(sport, variant, { setTo: floor, finalSetTo: floor }), `${sport}: the floor itself is lawful`).not.toThrow();
    }
  });

  it("fails closed: a sport that declares a door but has no rulebook row is refused by name, not by a row-less sentence", () => {
    expect(() => writeDoorRefusal("football", ["an invented sentence"])).toThrow(WriteDoorRowUnnamed);
    expect(() => writeDoorRefusal("football", ["an invented sentence"])).toThrow(/football/);
    expect(writeDoorRefusal("tennis", [BO1_MATCH_TIEBREAK])).toContain("TN-CF-1");
  });
});

describe("the generator plans no case the door refuses (variants.json input)", () => {
  /** The generator's input for `sport`: every pair of factor levels with the rest at their defaults (the rows factor aside, which
   *  cannot change a cfg), as the editor would send it. The ENGINE door's verdict on the schema-parsed cfg, independent of buildVariant. */
  function pairInput(sport: string): { total: number; doorRefused: number; harnessRefusedByRow: number } {
    const fs = factorsFor(sport);
    const defaultPreset = offlineBuilderDefault(sport);
    const preset = (l: { raw: string }) => l.raw;
    let total = 0;
    let doorRefused = 0;
    let harnessRefusedByRow = 0;
    for (let i = 1; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) for (const a of fs[i]!.levels) for (const b of fs[j]!.levels) {
      const picks = new Map<string, string>([[fs[i]!.name, preset(a)], [fs[j]!.name, preset(b)]]);
      const presetKey = picks.get("preset") ?? defaultPreset;
      const values: Record<string, string> = {};
      for (const [k, v] of picks) if (k !== "preset" && v !== "") values[k] = v;
      total++;
      const built = buildVariant(sport, presetKey, values);
      // The engine's verdict, independent of buildVariant: the schema-parsed cfg of the same override, asked of the door.
      const inherited = ((sportModule(sport).variants as Record<string, unknown>)[presetKey] ?? {}) as Record<string, unknown>;
      const shown = new Set(visibleRuleFields(sport, values, inherited).map((f) => f.key));
      if (Object.keys(values).some((k) => !shown.has(k))) continue;
      let cfg: unknown;
      try { cfg = resolveSchemaCfg(sport, presetKey, JSON.parse(JSON.stringify(buildRuleOverride(sport, values, inherited))) as Record<string, unknown>); } catch (e) { if (e instanceof CfgInvalid) continue; throw e; }
      const refused = writeConfigIssues(sportModule(sport), cfg).length > 0;
      if (refused) doorRefused++;
      if (!built.ok && built.reason.includes(RULEBOOK_ROW[sport]!)) harnessRefusedByRow++;
      expect(built.ok, `${sport} ${JSON.stringify(values)} on ${presetKey}: the door ${refused ? "refuses" : "accepts"} it`).toBe(!refused);
    }
    return { total, doorRefused, harnessRefusedByRow };
  }

  it("per door sport: the pairs the engine door refuses are exactly the ones buildVariant refuses naming the row (counted, non-zero)", () => {
    const seen: string[] = [];
    for (const sport of DOOR_SPORTS) {
      const r = pairInput(sport);
      seen.push(`${sport}: ${r.doorRefused}/${r.total}`);
      expect(r.total, sport).toBeGreaterThan(0);
      expect(r.doorRefused, `${sport}: the door refuses some pair of the generator's input`).toBeGreaterThan(0);
      expect(r.harnessRefusedByRow, sport).toBe(r.doorRefused);
    }
    console.info(`write-door: pairs the engine door refuses, over the generator's input - ${seen.join("; ")}`);
  });

  it("no generated case of a door sport is one the door refuses, and a pair only the refused combination could cover is uncoverable naming the row (counted)", () => {
    let cases = 0;
    const named: string[] = [];
    for (const sport of DOOR_SPORTS) {
      const v = buildSportVariants(sport);
      for (const c of v.cases) {
        expect(writeConfigIssues(sportModule(sport), resolveSchemaCfg(sport, c.preset, c.overrides)), `${c.id}`).toEqual([]);
        cases++;
      }
      for (const u of v.uncoverable) if (u.reason.includes(RULEBOOK_ROW[sport]!)) named.push(`${sport}: ${u.a} x ${u.b}`);
    }
    expect(cases, "some case was checked").toBeGreaterThan(0);
    console.info(`write-door: ${cases} generated case(s) checked; uncoverable naming a row: ${named.length}`);
    expect(named.length, "at least one pair exists only inside a refused combination").toBeGreaterThan(0);
  });
});
