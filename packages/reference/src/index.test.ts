import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { forEachSport } from "@seazn/engine/testkit";
import { FAMILIES, NoReferenceFamily, familiesFor, requireFamily } from "./index.ts";
import { bracketKindsFromRows, readRuleRows } from "../test/rule-rows.ts";

// The bracket kinds come from the rules directory (X-DR-1's draw allow-list, subtracted from the engine's declared
// kinds), never from the family under test — so a family listing a kind it should not, or missing one, reds here.
const KINDS: readonly string[] = StageKind.options;
const BRACKET = bracketKindsFromRows(readRuleRows(), KINDS);

describe("reference families (design §7.2; W2a adds bracket-finish, rule rows X-BR-1 and X-DR-1)", () => {
  it("empty case first: a draw kind (X-DR-1) has no family, and the refusal names the pair", () => {
    expect(familiesFor("league", "generic")).toEqual([]); // single-sport: one named pair; the registry sweep below covers every sport
    expect(() => requireFamily("league", "tennis")).toThrow(NoReferenceFamily); // single-sport: pins the message shape; the sweep below covers every sport
    expect(() => requireFamily("league", "tennis")).toThrow(/no reference family for league × tennis/);
  });
  it("FAMILIES holds exactly one family, bracket-finish, and a bracket pair resolves to it", () => {
    expect(FAMILIES.map((f) => f.id)).toEqual(["bracket-finish"]);
    expect(requireFamily("knockout", "tennis").id).toBe("bracket-finish"); // single-sport: pins the positive pair's shape; the sweep below covers every sport
  });
  it("FAMILIES is frozen: a wave adds families in source, never at run time", () => {
    expect(Object.isFrozen(FAMILIES)).toBe(true);
  });
  it("every stage kind the engine declares × every registered sport: exactly the bracket kinds resolve to bracket-finish; every other pair still refuses, naming the pair", () => {
    // The domain comes from the engine's own declarations (StageKind, the sport registry), never from this package —
    // so a new kind or sport is swept the day it lands. Both sides of the split must be non-empty.
    expect(BRACKET.length).toBeGreaterThan(0);
    expect(BRACKET.length).toBeLessThan(KINDS.length);
    let resolved = 0;
    let refused = 0;
    const sports = forEachSport(({ key }) => {
      for (const kind of StageKind.options) {
        if (BRACKET.includes(kind)) {
          expect(familiesFor(kind, key).map((f) => f.id), `${kind} × ${key}`).toEqual(["bracket-finish"]);
          expect(requireFamily(kind, key).id, `${kind} × ${key}`).toBe("bracket-finish");
          resolved++;
        } else {
          expect(familiesFor(kind, key), `${kind} × ${key}`).toEqual([]);
          expect(() => requireFamily(kind, key)).toThrow(NoReferenceFamily);
          expect(() => requireFamily(kind, key)).toThrow(`no reference family for ${kind} × ${key}`);
          refused++;
        }
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(resolved).toBe(sports * BRACKET.length);
    expect(refused).toBe(sports * (KINDS.length - BRACKET.length));
  });
});
