// Catalog loader (D1a design doc): loaded + zod-parsed at module init, so a
// broken catalog entry fails EVERY test that imports it, not just this file
// — this file additionally pins the exact launch set and re-asserts the
// StageKind guard explicitly (belt-and-suspenders against a future catalog
// entry reintroducing the API-vs-engine StageKind divergence even if the
// loader's own parse were ever loosened).
import { describe, expect, it } from "vitest";
import { StageKind } from "@/server/api-v1/schemas";
import { TEMPLATE_CATALOG, getTemplate } from "../catalog";

// P4 launch set (design doc's 8-template catalog minus the 3 that need P7's
// StageSeeding: euro24, t20-super8, league-playoff).
const P4_KEYS = ["slam128", "swiss11", "wc32", "americano-night", "box-league"];

describe("template catalog", () => {
  it("ships exactly the 5 P4 launch templates, each parsed and unique by key", () => {
    expect(TEMPLATE_CATALOG.map((t) => t.key).sort()).toEqual([...P4_KEYS].sort());
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

  it("wc32 is the one multi-stage template, and its knockout stage carries no qualification wiring (P7's job)", () => {
    const wc32 = getTemplate("wc32")!;
    expect(wc32.divisions[0]!.stages).toHaveLength(2);
    expect(wc32.divisions[0]!.stages.map((s) => s.kind)).toEqual(["group", "knockout"]);
  });
});
