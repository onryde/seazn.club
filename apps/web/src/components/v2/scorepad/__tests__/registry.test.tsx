// S12/#421 W10 — the drift guard over registry.tsx's `resolveScorePad` table.
// S11's skins/registry.ts only names the 8 skinned sports (an unlisted sport
// resolves to `null` = universal, which is fine for PadRenderer's own
// question); THIS table must name all 11 `builtinModules` keys explicitly,
// because "universal" here is meant to be a WRITTEN decision, not a
// fallthrough — a new engine sport shipping with no row must fail CI, not
// silently render on the universal path with nobody having decided that was
// right. See registry.tsx's own header for the full reasoning.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { skinFor } from "../skins/registry";
import { RESOLUTION_KIND, resolveScorePad } from "../registry";

describe("resolveScorePad — drift guard over every builtinModules key", () => {
  it("assertion 1: every builtinModules key has a table row", () => {
    const missing = builtinModules.map((m) => m.key).filter((key) => !(key in RESOLUTION_KIND));
    expect(missing, "a new engine sport shipped with no registry decision").toEqual([]);
  });

  it("assertion 2: every table row is a real module key (no dead rows)", () => {
    const real = new Set(builtinModules.map((m) => m.key));
    const dead = Object.keys(RESOLUTION_KIND).filter((key) => !real.has(key));
    expect(dead, "a table row names a sport the engine does not ship").toEqual([]);
  });

  it("assertion 3: the table agrees with skinFor in BOTH directions", () => {
    for (const m of builtinModules) {
      const row = RESOLUTION_KIND[m.key];
      const hasSkin = skinFor(m.key) !== null;
      if (row === "skin") {
        expect(hasSkin, `"${m.key}" is marked "skin" in registry.tsx but skinFor("${m.key}") is null`).toBe(true);
      } else {
        expect(hasSkin, `"${m.key}" is marked "universal" in registry.tsx but skinFor("${m.key}") returns a skin`).toBe(
          false,
        );
      }
    }
  });

  it("assertion 4: resolveScorePad(key) returns an actual SkinDef for every 'skin' row", () => {
    for (const m of builtinModules) {
      if (RESOLUTION_KIND[m.key] !== "skin") continue;
      const resolution = resolveScorePad(m.key);
      expect(resolution.kind, `resolveScorePad("${m.key}")`).toBe("skin");
      if (resolution.kind === "skin") {
        expect(resolution.skin).toBeTruthy();
        expect(resolution.skin.sports).toContain(m.key);
      }
    }
  });

  it("every 'universal' row resolves to {kind:'universal'}, with no skin attached", () => {
    for (const m of builtinModules) {
      if (RESOLUTION_KIND[m.key] !== "universal") continue;
      expect(resolveScorePad(m.key)).toEqual({ kind: "universal" });
    }
  });

  it("an unknown sport key resolves to universal, without throwing", () => {
    expect(() => resolveScorePad("totally-unknown-sport")).not.toThrow();
    expect(resolveScorePad("totally-unknown-sport")).toEqual({ kind: "universal" });
  });

  it("the table names exactly the 11 shipped sports — 8 skinned, 3 universal (pins the known-good shape)", () => {
    expect(builtinModules.length).toBe(11);
    expect(Object.keys(RESOLUTION_KIND).length).toBe(11);
    const byKind = Object.values(RESOLUTION_KIND).reduce<Record<string, number>>((acc, kind) => {
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toEqual({ skin: 8, universal: 3 });
  });
});
