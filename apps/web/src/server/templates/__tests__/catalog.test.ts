// Catalog loader (D1a design doc): loaded + zod-parsed at module init, so a
// broken catalog entry fails EVERY test that imports it, not just this file
// — this file additionally pins the exact launch set and re-asserts the
// StageKind guard explicitly (belt-and-suspenders against a future catalog
// entry reintroducing the API-vs-engine StageKind divergence even if the
// loader's own parse were ever loosened).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StageKind } from "@/server/api-v1/schemas";
import { TEMPLATE_CATALOG, getTemplate } from "../catalog";
import { resolveTemplate } from "../resolve";
import { sportRefusesStageKind } from "@/lib/chess-individual-only";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// The 8-template design-doc catalog: P4's 5 + P7's 3 (euro24/
// t20-super8/league-playoff), the ones that needed D4's StageSeeding; plus W5's
// sport-agnostic super-groups (X-BD-3, NEW-W1d-5).
const CATALOG_KEYS = [
  "slam128",
  "swiss11",
  "wc32",
  "americano-night",
  "box-league",
  "euro24",
  "t20-super8",
  "league-playoff",
  "super-groups",
];

describe("template catalog", () => {
  it("ships exactly the 9 catalog templates, each parsed and unique by key", () => {
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

  // createFromTemplate writes a template's stages straight into `stages` (usecases/templates.ts), past the stage batch
  // gates, so the catalog itself owes the stage-kind rule: chess is individual-only (owner ruling 2026-10-26, follow-up
  // to #1027) and no catalog division may seat chess in an americano/mexicano stage. Counted, so an empty walk fails.
  it("no catalog division seats a stage kind its own sport refuses (chess: no americano or mexicano)", () => {
    let stages = 0;
    let chessDivisions = 0;
    for (const template of TEMPLATE_CATALOG) {
      for (const division of template.divisions) {
        if (division.sportKey === "boardgame") chessDivisions++;
        for (const stage of division.stages) {
          stages++;
          expect(sportRefusesStageKind(division.sportKey, stage.kind), `${template.key}/${division.sportKey}/${stage.kind}`).toBe(false);
        }
      }
    }
    expect(stages).toBeGreaterThanOrEqual(CATALOG_KEYS.length);
    // The rule has a chess division to bite on (swiss11), and americano-night is the americano the rule must leave to tennis.
    expect(chessDivisions).toBeGreaterThan(0);
    expect(sportRefusesStageKind("boardgame", "americano")).toBe(true);
    expect(getTemplate("americano-night")!.divisions.some((d) => d.sportKey !== "boardgame" && d.stages.some((st) => st.kind === "americano"))).toBe(true);
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
    expect(wc32.divisions[0]!.stages[1]!.progression).toBeUndefined();
  });

  // P7/D1b — the 3 entries StageSeeding unlocked. Each pins `take`,
  // `placement`, and the map's slot count on the actual catalog object (not
  // a hand-copy), so a future catalog edit that silently reshapes the
  // seeding rules fails here.
  describe("euro24 — R16 seeded from the group stage", () => {
    it("R16's progression pins sources/take/placement/map/timing: 2 group qualifiers x 6 groups + 4 best-thirds = 16 slots", () => {
      const euro24 = getTemplate("euro24")!;
      const stages = euro24.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["group", "knockout"]);
      expect(stages[0]!.groups).toBe(6);
      expect(stages[0]!.progression).toBeUndefined(); // nothing precedes the group stage

      const r16 = stages[1]!;
      expect(r16.size).toBe(16); // 12 group qualifiers (topNPerGroup n=2 x 6 groups) + 4 best-thirds
      expect(r16.progression?.sources).toHaveLength(1); // one prior stage feeds this one
      expect(r16.progression?.sources[0]?.stage).toBe("previous");
      expect(r16.progression?.sources[0]?.take).toEqual([
        { kind: "topNPerGroup", n: 2 },
        { kind: "bestNth", nth: 3, count: 4 },
      ]);
      expect(r16.progression?.placement).toBe("seeded_map");
      expect(r16.progression?.timing).toBe("setup"); // fixtures exist from setup, not TBD-on-complete
      // Exactly the 4 best-third sources are explicitly mapped — the 12
      // group qualifiers fall into the remaining seats in natural order
      // (placeDescriptors' documented "remaining" fallback, stage-seeding.ts).
      expect(r16.progression?.map).toHaveLength(4);
      expect(r16.progression?.map).toEqual([
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

  describe("t20-super8 — a two-link progression chain (group -> Super 8 -> SF/F)", () => {
    it("pins both progression stages' sources/take/placement/timing, and that the first stage has none", () => {
      const t20 = getTemplate("t20-super8")!;
      const stages = t20.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["group", "group", "knockout"]);
      expect(stages[0]!.groups).toBe(4);
      expect(stages[0]!.progression).toBeUndefined();

      const super8 = stages[1]!;
      expect(super8.groups).toBe(2);
      expect(super8.progression?.sources).toHaveLength(1);
      expect(super8.progression?.sources[0]?.stage).toBe("previous");
      expect(super8.progression?.sources[0]?.take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
      expect(super8.progression?.placement).toBe("snake");
      expect(super8.progression?.timing).toBe("setup");
      expect(super8.progression?.map).toBeUndefined();

      const sfAndFinal = stages[2]!;
      expect(sfAndFinal.size).toBe(4);
      expect(sfAndFinal.progression?.sources).toHaveLength(1);
      expect(sfAndFinal.progression?.sources[0]?.stage).toBe("previous");
      expect(sfAndFinal.progression?.sources[0]?.take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
      expect(sfAndFinal.progression?.placement).toBe("rank_order");
      expect(sfAndFinal.progression?.timing).toBe("setup");
    });
  });

  // D2a, review 2026-09-18 — `TemplateStage.config` is an untyped record that
  // `effectiveStageConfig` spreads verbatim into `stages.config`, so a `rules`
  // key declared here would reach the column with no sport gate, no allowlist
  // and no merged parse, for any sport. `effectiveStageConfig` now refuses one
  // at runtime; this is the half that fails in CI instead of in production,
  // where a catalog author would otherwise ship a template that 400s on every
  // instantiation. Per-stage rules are set through PUT /stages/{id}/rules.
  it("declares no per-stage match rules on any template stage", () => {
    const offenders: string[] = [];
    for (const template of TEMPLATE_CATALOG)
      for (const division of template.divisions)
        for (const [i, stage] of division.stages.entries())
          if (stage.config && "rules" in stage.config)
            offenders.push(`${template.key}/${division.i18nNameKey}/stage[${i}]`);
    expect(offenders).toEqual([]);
    // Non-vacuous: the catalog really does have stages to scan.
    expect(TEMPLATE_CATALOG.flatMap((t) => t.divisions.flatMap((d) => d.stages)).length)
      .toBeGreaterThan(0);
  });

  describe("league-playoff — league table into a page_playoff", () => {
    it("pins the page_playoff stage's progression: rankRange 1..4, rank_order, setup timing", () => {
      const lp = getTemplate("league-playoff")!;
      const stages = lp.divisions[0]!.stages;
      expect(stages.map((s) => s.kind)).toEqual(["league", "page_playoff"]);
      expect(stages[0]!.progression).toBeUndefined();

      const playoff = stages[1]!;
      expect(playoff.size).toBe(4);
      expect(playoff.progression?.sources).toHaveLength(1);
      expect(playoff.progression?.sources[0]?.stage).toBe("previous");
      expect(playoff.progression?.sources[0]?.take).toEqual([{ kind: "rankRange", from: 1, to: 4 }]);
      expect(playoff.progression?.placement).toBe("rank_order");
      expect(playoff.progression?.timing).toBe("setup");
    });
  });

  // W5 X-BD-3 (rulebook RB5-S2; owner S1, 2026-11-06): the "T20 Super 8" shape generalised to any sport and any field
  // that divides cleanly, so every group_group_ko cell has an organiser path.
  describe("super-groups — the sport-agnostic two-tier groups template (X-BD-3)", () => {
    // The rule's own numbers (brief, Task 15): pools of 4, and the field sizes the card offers.
    const POOL_SIZE = 4;
    const COUNT_OPTIONS = [12, 16, 24, 32];

    it("X-BD-3 super-groups is t20-super8's shape (group, group, knockout) with no sport, variant or kind of its own", () => {
      // differential: today no such template
      const t = getTemplate("super-groups");
      expect(t).not.toBeNull();
      const d = t!.divisions[0]!;
      expect([d.sportKey, d.variantKey, d.entrantKind]).toEqual(["any", "any", "any"]);
      expect(d.stages.map((s) => s.kind)).toEqual(getTemplate("t20-super8")!.divisions[0]!.stages.map((s) => s.kind));
      expect(d.entrantCount).toBe(16);
      expect(d.entrantCountOptions).toEqual(COUNT_OPTIONS);
      expect(d.cfgOverrides).toBeUndefined(); // a sport's rule would be a rule for every sport
      expect(d.tiebreakers).toBeUndefined();
    });

    it("X-BD-3 every count option divides into pools of 4, and its second tier into whole groups", () => {
      const t = getTemplate("super-groups")!;
      let checked = 0;
      for (const count of COUNT_OPTIONS) {
        const r = resolveTemplate(t, { sportKey: "football", variantKey: "11-a-side", entrantKind: "team", entrantCount: count });
        expect(r.ok, String(count)).toBe(true);
        if (!r.ok) continue;
        const [first, second, knockout] = r.template.divisions[0]!.stages;
        expect(count % POOL_SIZE, `${count} entrants`).toBe(0);
        expect(first!.groups, `${count} entrants`).toBe(count / POOL_SIZE);
        // The top 2 of every first-tier pool feed the second tier, two groups of count/4 each (t20-super8's own shape).
        const fed = first!.groups! * 2;
        expect(fed % second!.groups!, `${count} entrants`).toBe(0);
        expect(fed / second!.groups!).toBe(count / POOL_SIZE);
        expect(knockout!.size).toBe(4);
        checked++;
      }
      expect(checked).toBe(COUNT_OPTIONS.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("X-BD-3 a count outside the offered options is refused by name", () => {
      const t = getTemplate("super-groups")!;
      let refused = 0;
      for (const count of [0, 1, 4, 7, 8, 10, 15, 17, 20, 33, 64]) {
        const r = resolveTemplate(t, { sportKey: "football", variantKey: "11-a-side", entrantKind: "team", entrantCount: count });
        expect(r, String(count)).toMatchObject({ ok: false, code: "TEMPLATE_COUNT_NOT_OFFERED" });
        refused++;
      }
      expect(refused).toBe(11);
    });

    it("X-BD-3 every offered count leaves the second tier's pools larger than the take, so the second tier eliminates someone (8 was dropped for this)", () => {
      // The options and the take are read from the catalog entry itself, never typed here: a change to either moves this test.
      const d = getTemplate("super-groups")!.divisions[0]!;
      const take = d.stages[1]!.progression!.sources[0]!.take[0] as { kind: string; n: number };
      expect(take.kind).toBe("topNPerGroup");
      const options = d.entrantCountOptions!;
      const poolSize = d.stages[0]!.poolSize!;
      const secondGroups = d.stages[1]!.groups!;
      expect(poolSize, "the first tier is sized by its pools").toBeGreaterThan(0);
      expect(secondGroups, "the second tier has a group count").toBeGreaterThan(0);
      // Each second-tier pool holds (first-tier pools x take) / second-tier groups entrants.
      const tierTwoPool = (count: number) => ((count / poolSize) * take.n) / secondGroups;
      let checked = 0;
      for (const count of options) {
        const secondTierPool = tierTwoPool(count);
        expect(secondTierPool, `${count} entrants: a pool of ${secondTierPool} with a take of ${take.n} cuts nobody`).toBeGreaterThan(take.n);
        checked++;
      }
      expect(checked).toBe(options.length);
      expect(checked).toBeGreaterThan(0);
      // The default is offered, and the smallest option is the smallest field that passes (12 -> pools of 3 > 2).
      expect(options).toContain(d.entrantCount);
      expect(tierTwoPool(Math.min(...options))).toBeGreaterThan(take.n);
    });

    it("X-BD-3 t20-super8 is byte-identical", () => {
      // pin, no defect expected: the file as committed before W5 touched the catalog.
      const bytes = readFileSync(join(__dirname, "..", "catalog", "t20-super8.json"));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe("f2f599f2a73b0f3a0a77a4b1ac7319e2cfa49959d41745449054481b208f744c");
      // And with no choice a fixed template resolves to itself: the very object, so every existing create is unchanged.
      const t20 = getTemplate("t20-super8")!;
      const r = resolveTemplate(t20, undefined);
      expect(r.ok && r.template === t20).toBe(true);
    });
  });
});
