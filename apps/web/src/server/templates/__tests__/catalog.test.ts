// Catalog loader (D1a design doc): loaded + zod-parsed at module init, so a
// broken catalog entry fails EVERY test that imports it, not just this file
// — this file additionally pins the exact launch set and re-asserts the
// StageKind guard explicitly (belt-and-suspenders against a future catalog
// entry reintroducing the API-vs-engine StageKind divergence even if the
// loader's own parse were ever loosened).
import { describe, expect, it } from "vitest";
import { StageKind } from "@/server/api-v1/schemas";
import { TEMPLATE_CATALOG, getTemplate } from "../catalog";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// The full 8-template design-doc catalog: P4's 5 + P7's 3 (euro24/
// t20-super8/league-playoff), the ones that needed D4's StageSeeding.
const CATALOG_KEYS = [
  "slam128",
  "swiss11",
  "wc32",
  "americano-night",
  "box-league",
  "euro24",
  "t20-super8",
  "league-playoff",
];

describe("template catalog", () => {
  it("ships exactly the 8 design-doc templates, each parsed and unique by key", () => {
    expect(TEMPLATE_CATALOG.map((t) => t.key).sort()).toEqual([...CATALOG_KEYS].sort());
  });

  it("getTemplate resolves a known key and returns null for an unknown one", () => {
    expect(getTemplate("slam128")?.key).toBe("slam128");
    expect(getTemplate("does-not-exist")).toBeNull();
  });

  it("every catalog entry's stage kinds are admitted by the API StageKind enum (the 9-vs-6 divergence guard)", () => {
    for (const template of TEMPLATE_CATALOG) {
      for (const division of template.divisions) {
        for (const stage of division.stages) {
          expect(
            StageKind.safeParse(stage.kind).success,
            `${template.key}: stage kind '${stage.kind}' must be a DB-checked StageKind`,
          ).toBe(true);
        }
      }
    }
  });

  it("every i18n key referenced by the catalog is a dotted templates.* key, never literal English", () => {
    for (const template of TEMPLATE_CATALOG) {
      expect(template.i18n.nameKey).toMatch(/^templates\./);
      expect(template.i18n.descriptionKey).toMatch(/^templates\./);
      for (const division of template.divisions) {
        expect(division.i18nNameKey).toMatch(/^templates\./);
        for (const stage of division.stages) {
          expect(stage.i18nNameKey).toMatch(/^templates\./);
        }
      }
    }
  });

  it("wc32 (P4-era, byte-stable) still carries no seeding wiring on its knockout stage — P7 did not retrofit it", () => {
    const wc32 = getTemplate("wc32")!;
    expect(wc32.divisions[0]!.stages).toHaveLength(2);
    expect(wc32.divisions[0]!.stages.map((s) => s.kind)).toEqual(["group", "knockout"]);
    expect(wc32.divisions[0]!.stages[1]!.seeding).toBeUndefined();
  });

  // P7/D1b — the 3 entries StageSeeding unlocked. Each pins `take`,
  // `placement`, and the map's slot count on the actual catalog object (not
  // a hand-copy), so a future catalog edit that silently reshapes the
  // seeding rules fails here.
  describe("euro24 — R16 seeded from the group stage", () => {
    it("R16's seeding pins take/placement/map: 2 group qualifiers x 6 groups + 4 best-thirds = 16 slots", () => {
      const euro24 = getTemplate("euro24")!;
      const stages = euro24.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["group", "knockout"]);
      expect(stages[0]!.groups).toBe(6);
      expect(stages[0]!.seeding).toBeUndefined(); // nothing precedes the group stage

      const r16 = stages[1]!;
      expect(r16.size).toBe(16); // 12 group qualifiers (topNPerGroup n=2 x 6 groups) + 4 best-thirds
      expect(r16.seeding?.source).toBe("previous");
      expect(r16.seeding?.take).toEqual([
        { kind: "topNPerGroup", n: 2 },
        { kind: "bestNth", nth: 3, count: 4 },
      ]);
      expect(r16.seeding?.placement).toBe("seeded_map");
      // Exactly the 4 best-third sources are explicitly mapped — the 12
      // group qualifiers fall into the remaining seats in natural order
      // (placeDescriptors' documented "remaining" fallback, stage-seeding.ts).
      expect(r16.seeding?.map).toHaveLength(4);
      expect(r16.seeding?.map).toEqual([
        { slot: "13", source: "best:1" },
        { slot: "14", source: "best:2" },
        { slot: "15", source: "best:3" },
        { slot: "16", source: "best:4" },
      ]);
    });

    it("documents the UEFA best-thirds simplification in its own description copy, in all 4 locales (deliberate, not silent)", () => {
      // The real UEFA best-thirds rule is a which-4-groups-qualified lookup
      // table (15 permutations) that a static {slot,source}[] map cannot
      // express — ranked-by-record is the documented simplification. Proven
      // by reading the ACTUAL dictionary string a reader would see (review
      // finding: asserting only the key's NAME stays green if the caveat
      // sentence is deleted from every locale — this reads the text).
      // Each assertion is that locale's OWN translated marker, not a
      // pasted-English check: a locale that ships the sentence in English
      // (or drops it) fails on ITS OWN row, not just en's.
      const euro24 = getTemplate("euro24")!;
      const key = euro24.i18n.descriptionKey;
      expect(key).toBe("templates.euro24.desc");
      const dicts: Record<string, Record<string, string>> = {
        en: uiEn as Record<string, string>,
        es: uiEs as Record<string, string>,
        fr: uiFr as Record<string, string>,
        nl: uiNl as Record<string, string>,
      };
      expect(dicts.en![key]).toContain("ranked by record, not the official slot-swap table");
      expect(dicts.es![key]).toContain("no por la tabla oficial de cruces");
      expect(dicts.fr![key]).toContain("pas selon le tableau officiel de tirage");
      expect(dicts.nl![key]).toContain("niet op het officiële loting-schema");
    });
  });

  describe("t20-super8 — a two-link seeding chain (group -> Super 8 -> SF/F)", () => {
    it("pins both seeding stages' take/placement, and that the first stage has none", () => {
      const t20 = getTemplate("t20-super8")!;
      const stages = t20.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["group", "group", "knockout"]);
      expect(stages[0]!.groups).toBe(4);
      expect(stages[0]!.seeding).toBeUndefined();

      const super8 = stages[1]!;
      expect(super8.groups).toBe(2);
      expect(super8.seeding?.source).toBe("previous");
      expect(super8.seeding?.take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
      expect(super8.seeding?.placement).toBe("snake");
      expect(super8.seeding?.map).toBeUndefined();

      const sfAndFinal = stages[2]!;
      expect(sfAndFinal.size).toBe(4);
      expect(sfAndFinal.seeding?.source).toBe("previous");
      expect(sfAndFinal.seeding?.take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
      expect(sfAndFinal.seeding?.placement).toBe("rank_order");
    });
  });

  describe("league-playoff — league table into a page_playoff", () => {
    it("pins the page_playoff stage's seeding: rankRange 1..4, rank_order", () => {
      const lp = getTemplate("league-playoff")!;
      const stages = lp.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["league", "page_playoff"]);
      expect(stages[0]!.seeding).toBeUndefined();

      const playoff = stages[1]!;
      expect(playoff.size).toBe(4);
      expect(playoff.seeding?.source).toBe("previous");
      expect(playoff.seeding?.take).toEqual([{ kind: "rankRange", from: 1, to: 4 }]);
      expect(playoff.seeding?.placement).toBe("rank_order");
    });
  });
});
