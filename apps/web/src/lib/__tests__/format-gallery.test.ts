// Format gallery gates (v3/06 §4):
//  1. enumeration — every engine stage kind has an explainer family, so a
//     new format cannot ship undocumented;
//  2. the canned stage graphs actually run through the real engine preview;
//  3. the recommendation function's golden ranking for 16 entrants /
//     2 courts / 4 hours.
import { describe, expect, it } from "vitest";
import { StageKind } from "@/server/api-v1/schemas";
import { FORMAT_FAMILIES, familyForKind, formatFamily } from "@/config/format-gallery";
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
// (rankRange collapses topN, picks is unchanged), timing: "on_complete" —
// same auto-seed-on-complete behaviour as format-templates.ts's equivalent
// templates (Decision 1: no default timing changes this session).
describe("cannedStages emit progression, not qualification (F2)", () => {
  it("groups-knockout's knockout stage carries a picks TakeRule, on_complete", () => {
    const family = formatFamily("groups-knockout")!;
    expect(family.cannedStages[0]!.progression).toBeNull();
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            {
              kind: "picks",
              picks: [
                { pool: "A", rank: 1 },
                { pool: "B", rank: 1 },
                { pool: "A", rank: 2 },
                { pool: "B", rank: 2 },
              ],
            },
          ],
        },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("stepladder's finals stage carries rankRange(1,4), on_complete — the topN:4 replacement", () => {
    const family = formatFamily("stepladder")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("page_playoff's playoffs stage carries rankRange(1,4), on_complete — the topN:4 replacement", () => {
    const family = formatFamily("page_playoff")!;
    expect(family.cannedStages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("no family's cannedStages carries the old qualification key", () => {
    for (const f of FORMAT_FAMILIES) {
      for (const stage of f.cannedStages) {
        expect(stage).not.toHaveProperty("qualification");
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
