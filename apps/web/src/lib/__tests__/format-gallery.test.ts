// Format gallery gates (v3/06 §4):
//  1. enumeration — every engine stage kind has an explainer family, so a
//     new format cannot ship undocumented;
//  2. the canned stage graphs actually run through the real engine preview;
//  3. the recommendation function's golden ranking for 16 entrants /
//     2 courts / 4 hours.
import { describe, expect, it } from "vitest";
import { StageKind, ProgressionSchema } from "@/server/api-v1/schemas";
import { FORMAT_FAMILIES, FormatDiagram, familyForKind, formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures } from "@/server/usecases/stages";
import { recommendFormats } from "@/lib/format-recommend";
import { helpUrl } from "@/lib/help";

describe("format gallery enumeration", () => {
  it("every engine stage kind has an explainer family", () => {
    for (const kind of StageKind.options) {
      expect(familyForKind(kind), `stage kind '${kind}' has no gallery family`).toBeTruthy();
    }
  });

  it("every family resolves through helpUrl (picker + tips deep-links)", () => {
    for (const f of FORMAT_FAMILIES) {
      expect(helpUrl(`formats/${f.slug}`)).toBe(`/help/formats/${f.slug}`);
    }
    expect(helpUrl("formats/overview")).toBe("/help/formats");
  });

  // The scout finding this closes: DIAGRAMS is a slug→SVG lookup and
  // FormatDiagram renders `null` for a slug it does not know — so a family
  // added without one ships a blank panel on /help/formats and
  // /help/formats/<slug> with every other suite green. Nothing enumerated it
  // before.
  it("every family has a hand-authored diagram (a missing one renders blank, silently)", () => {
    const missing = FORMAT_FAMILIES.filter((f) => FormatDiagram({ slug: f.slug }) === null).map(
      (f) => f.slug,
    );
    expect(missing).toEqual([]);
  });

  it("every family's canned stage graph runs through the real engine", () => {
    for (const f of FORMAT_FAMILIES) {
      const phases = previewDivisionFixtures(f.cannedStages, 8);
      expect(phases.length, f.slug).toBe(f.cannedStages.length);
      for (const phase of phases) {
        // Either concrete fixtures or an honest live-draw note — never blank.
        expect(
          phase.sections.length > 0 || (phase.note ?? "").length > 10,
          `${f.slug} / ${phase.title} rendered empty`,
        ).toBe(true);
      }
    }
  });
});

// F2 (unified progression field): cannedStages' `qualification:` sites
// (":289" stepladder, ":298" page_playoff, plus groups-knockout's `take`)
// were NOT decorative — they feed the real engine through
// previewDivisionFixtures (dispatch note). Converted onto `progression`
// (rankRange collapses topN).
//
// F3 (day-one fixtures, owner ruling R1/R4): timing flipped to "setup" —
// same as format-templates.ts's equivalent templates, matching R4's scope
// (picker's six plus this gallery's three). groups-knockout's `take` also
// moved off the hand-rolled `picks` A/B interleave onto `topNPerGroup`
// (owner ruling R5). Placement is `rank_order`, not `snake` (owner ruling
// 11): `snake` belongs to a group/pool TARGET, not a knockout one —
// see format-templates.ts's groups_ko for the full citation — and this
// canned entry feeds the identical knockout target format-templates.ts's
// groups_ko does.
describe("cannedStages emit progression, not qualification (F2)", () => {
  it("groups-knockout's knockout stage carries a topNPerGroup TakeRule, rank_order, setup", () => {
    const family = formatFamily("groups-knockout")!;
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("stepladder's finals stage carries rankRange(1,4), setup — the topN:4 replacement", () => {
    const family = formatFamily("stepladder")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("page_playoff's playoffs stage carries rankRange(1,4), setup — the topN:4 replacement", () => {
    const family = formatFamily("page_playoff")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("swiss_playoff's canned graph is a rank-adjacent swiss feeding rankRange(1,4), setup", () => {
    const family = formatFamily("swiss_playoff")!;
    expect(family.cannedStages.map((s) => s.kind)).toEqual(["swiss", "page_playoff"]);
    // The pairing model is the format. A canned graph that dropped it would
    // preview (and document) a format the picker does not actually build.
    expect(family.cannedStages[0]!.config).toMatchObject({ pairing: "rank_adjacent" });
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
    // Pro, like the page_playoff family it composes — and the server gate
    // (usecases/format-gates.ts) already refuses a page_playoff stage without
    // `formats.double_elim`, so the badge and the enforcement agree.
    expect(family.pro).toBe(true);
  });

  it("swiss_knockout's canned graph is a rank-adjacent swiss feeding a plain knockout", () => {
    const family = formatFamily("swiss_knockout")!;
    expect(family.cannedStages.map((s) => s.kind)).toEqual(["swiss", "knockout"]);
    expect(family.cannedStages[0]!.config).toMatchObject({ pairing: "rank_adjacent" });
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.config).toEqual({});
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  // Product decision, not an oversight: both halves are free kinds, so the
  // badge must not claim otherwise. `league_ko` is the precedent — the
  // server gate (usecases/format-gates.ts) refuses nothing here, and a
  // `pro: true` badge over an ungated format is a paywall that does not
  // exist. Asserted as an explicit `undefined` rather than a falsy check so
  // that a later `pro: false` (which reads the same to a user and different
  // to every `f.pro` consumer) has to be a deliberate edit to this line.
  it("swiss_knockout is NOT Pro — unlike swiss_playoff, neither half is a gated kind", () => {
    expect(formatFamily("swiss_knockout")!.pro).toBeUndefined();
    expect(formatFamily("swiss_playoff")!.pro).toBe(true);
  });

  it("every family's cannedStages progression is either null or a schema-valid ProgressionSpec", () => {
    for (const f of FORMAT_FAMILIES) {
      for (const stage of f.cannedStages) {
        expect(stage).not.toHaveProperty("qualification");
        if (stage.progression === null) continue;
        const parsed = ProgressionSchema.safeParse(stage.progression);
        expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
      }
    }
  });
});

describe("recommendFormats golden — 16 entrants, 2 courts, 4 hours", () => {
  it("ranks knockout first (only bracket that fits 16 court-slots)", () => {
    const picks = recommendFormats({ entrants: 16, courts: 2, hours: 4 });
    expect(picks).toHaveLength(3);
    // Capacity = 2 courts × 8 slots = 16 matches; knockout (15) is the only
    // model that fits, so it must lead; the rest are least-overrun first.
    expect(picks[0]!.slug).toBe("knockout");
    expect(picks[0]!.matches).toBe(15);
    expect(picks.map((p) => p.slug)).toEqual(["knockout", "double_elim", "groups-knockout"]);
    for (const p of picks) {
      expect(p.reason).toMatch(/matches/);
      expect(p.reason.length).toBeLessThan(160); // one sentence, not an essay
    }
  });

  it("with a full weekend the league leads (most play per entrant)", () => {
    const picks = recommendFormats({ entrants: 8, courts: 2, hours: 12 });
    expect(picks[0]!.slug).toBe("league"); // 28 matches fit 48 slots
  });
});
