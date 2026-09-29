import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { forEachSport } from "@seazn/engine/testkit";
import { FAMILIES, NoReferenceFamily, familiesFor, requireFamily } from "./index.ts";

describe("reference skeleton (design §7.2: ships empty of families)", () => {
  it("empty case first: no family exists yet", () => {
    expect(FAMILIES).toEqual([]);
  });
  it("familiesFor answers [] for any stage kind and sport while empty", () => {
    expect(familiesFor("league", "generic")).toEqual([]); // single-sport: one named pair; the registry sweep below covers every sport
  });
  it("requireFamily is a named refusal, never an undefined oracle", () => {
    expect(() => requireFamily("knockout", "tennis")).toThrow(NoReferenceFamily); // single-sport: pins the message shape; the sweep below covers every sport
    expect(() => requireFamily("knockout", "tennis")).toThrow(/no reference family for knockout × tennis/);
  });
  it("FAMILIES is frozen: a wave adds families in source, never at run time", () => {
    expect(Object.isFrozen(FAMILIES)).toBe(true);
  });
  it("every stage kind the engine declares × every registered sport: no family, and a refusal naming that pair", () => {
    // The domain comes from the engine's own declarations (StageKind, the sport
    // registry), never from this package — so a new kind or sport is swept
    // the day it lands.
    const kinds = StageKind.options;
    expect(kinds.length).toBeGreaterThan(0);
    let judged = 0;
    const sports = forEachSport(({ key }) => {
      for (const kind of kinds) {
        expect(familiesFor(kind, key)).toEqual([]);
        expect(() => requireFamily(kind, key)).toThrow(NoReferenceFamily);
        expect(() => requireFamily(kind, key)).toThrow(`no reference family for ${kind} × ${key}`);
        judged++;
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(judged).toBe(sports * kinds.length);
  });
});
