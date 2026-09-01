import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cricket } from "@seazn/engine/sports/cricket";
import { football } from "@seazn/engine/sports/football";
import { hockey } from "@seazn/engine/sports/hockey";
import type { AnySportModule } from "@seazn/engine/sport";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";

// R7 Task B2 — the `resolvePositions` read path.
//
// `resolvePositions` (packages/engine/src/sport/catalog.ts) shipped in W4
// (#407) with ZERO production callers: every caller was testkit or a unit
// test. The three page bootstraps below each read `sportModule.positions.*`
// directly, so the per-config half of the catalog — the ONLY half a
// competition can move — never ran in the product:
//
//   * football's small-sided codes field fewer than eleven (`Cfg.teamSize`),
//   * cricket's `playersPerSide` moves the starting count,
//   * hockey/ice hockey drop the keeper group's `min` to 0 when the
//     competition declares `goalkeeper: "optional"` (FIH Rule 4).
//
// The behaviour half of this fix — what the person filling in the sheet
// actually sees — is asserted against the rendered editor in
// components/v2/__tests__/lineup-editor-resolved-positions.test.tsx. What
// THIS file adds is the half that file cannot see: that the three real page
// bootstraps go through the resolver at all. There is no jsdom here and a
// Next server page cannot be rendered without a database, so the wiring is
// guarded at the source level — the same shape as
// fixture-console-no-native-prompt.test.ts.

const repoWeb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAPS = [
  "app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx",
  "app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
  "app/score/[token]/page.tsx",
];

describe("lineupCatalogFor resolves the catalog per competition config", () => {
  it("hockey: goalkeeper \"optional\" relaxes the keeper minimum, absent does not", () => {
    const relaxed = lineupCatalogFor(hockey as AnySportModule, { goalkeeper: "optional" });
    const strict = lineupCatalogFor(hockey as AnySportModule, {});
    expect(relaxed.groups.find((g) => g.key === "GK")?.min).toBe(0);
    expect(strict.groups.find((g) => g.key === "GK")?.min).toBe(1);
  });

  it("football: the small-sided variant fields fewer than eleven", () => {
    const small = lineupCatalogFor(football as AnySportModule, football.variants["small-sided"]);
    expect(small.lineup.size).toBe(7);
    expect(lineupCatalogFor(football as AnySportModule, {}).lineup.size).toBe(11);
  });

  it("cricket: playersPerSide moves the starting count", () => {
    expect(lineupCatalogFor(cricket as AnySportModule, { playersPerSide: 6 }).lineup.size).toBe(6);
    expect(lineupCatalogFor(cricket as AnySportModule, {}).lineup.size).toBe(11);
  });

  it("falls back to the static catalog rather than throwing on an unparseable config", () => {
    // A page must not 500 because a division's stored config is stale —
    // resolveScorePadBootstrap takes the same stance for the pad bootstrap.
    expect(lineupCatalogFor(hockey as AnySportModule, { goalkeeper: "sometimes" })).toBe(
      hockey.positions,
    );
    expect(lineupCatalogFor(hockey as AnySportModule, null)).toBe(hockey.positions);
  });
});

describe("every page bootstrap reads the RESOLVED catalog, never the module's static one", () => {
  for (const rel of BOOTSTRAPS) {
    const source = readFileSync(path.join(repoWeb, rel), "utf8");

    it(`${rel} goes through lineupCatalogFor`, () => {
      expect(source).toContain("lineupCatalogFor(");
    });

    it(`${rel} never reads .positions.groups / .roles / .lineup directly`, () => {
      expect(source).not.toMatch(/\.positions\.groups/);
      expect(source).not.toMatch(/\.positions\.roles/);
      expect(source).not.toMatch(/\.positions\.lineup/);
    });
  }
});
