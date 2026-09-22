// The Swiss shape legend (owner-approved 2026-09-22, option B):
//
//   3 rounds · 5 matches + 1 bye per round · 11 fixtures
//
// WHY it exists, and why these tests are shaped the way they are. A live
// defect: a Swiss stage's later rounds kept shells minted for an OLD field
// size after entrants were added and one deleted, so rounds 2 and 3 offered 4
// matches when the field needed 5 and the new players had nowhere to sit. It
// was invisible until the organiser opened the fixture list and found a
// `TBD vs <name>` row. The legend puts the number that was silently wrong ON
// THE SCREEN.
//
// So the middle figure MUST come from the CURRENT active field, never from a
// count of the fixture rows that exist — printing the stale row count as if it
// were correct is precisely the failure this feature exists to make visible.
// `swiss-legend-derives-matches-from-field` below is the test that says so,
// and it is deliberately built on a stage whose row count DISAGREES with
// rounds × matches, so a "count the rows" implementation cannot pass it.
import { describe, expect, it } from "vitest";
import {
  swissActiveFieldSize,
  swissStageLegend,
  swissLegendText,
} from "@/lib/swiss-legend";
import { swissBoardsForField } from "@/lib/swiss-shell";
import { DEPARTED_STATUSES } from "@/server/usecases/entrants";
import { EntrantStatus } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

/** The real English catalog through the real runtime — never a stub. A stub on
 *  both ends would prove the stub. */
const enI18n = {
  t: (key: string, vars?: Record<string, string | number>) => tRuntime(en, key, vars),
  plural: (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(en, key, count, "en", vars),
};

describe("swissActiveFieldSize", () => {
  it("counts every active entrant when the stage has no qualified list", () => {
    expect(swissActiveFieldSize({}, ids(11))).toBe(11);
  });

  it("intersects config.qualified with the active field (a departed qualifier is expunged)", () => {
    // Mirrors generateStageFixturesWrite's non-bracket arm:
    //   entrants = qualified.filter((id) => activeIds.has(id))
    expect(swissActiveFieldSize({ qualified: ["e1", "e2", "gone", "e3"] }, ids(3))).toBe(3);
  });

  it("ignores a non-array config.qualified rather than trusting it", () => {
    expect(swissActiveFieldSize({ qualified: "e1,e2" }, ids(6))).toBe(6);
  });
});

describe("swissStageLegend", () => {
  it("renders nothing for a stage that is not swiss", () => {
    expect(
      swissStageLegend({ kind: "league", config: { rounds: 3 }, activeEntrantIds: ids(10), fixtureCount: 45 }),
    ).toBeNull();
  });

  it("renders nothing when the stage declares no usable round count", () => {
    expect(
      swissStageLegend({ kind: "swiss", config: {}, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
    expect(
      swissStageLegend({ kind: "swiss", config: { rounds: 0 }, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
    expect(
      swissStageLegend({ kind: "swiss", config: { rounds: 2.5 }, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
  });

  it("renders nothing when the active field is unknown — never a number it cannot stand behind", () => {
    expect(
      swissStageLegend({ kind: "swiss", config: { rounds: 3 }, activeEntrantIds: undefined, fixtureCount: 12 }),
    ).toBeNull();
  });

  it("ODD field: floor(n/2) matches plus a bye", () => {
    expect(
      swissStageLegend({ kind: "swiss", config: { rounds: 3 }, activeEntrantIds: ids(11), fixtureCount: 18 }),
    ).toEqual({ rounds: 3, matches: 5, bye: true, fixtures: 18 });
  });

  it("EVEN field: n/2 matches and NO bye", () => {
    expect(
      swissStageLegend({ kind: "swiss", config: { rounds: 3 }, activeEntrantIds: ids(10), fixtureCount: 15 }),
    ).toEqual({ rounds: 3, matches: 5, bye: false, fixtures: 15 });
  });

  it("swiss-legend-derives-matches-from-field: a stale stage prints the FIELD number, not the row count", () => {
    // The live defect, reproduced: 3 rounds were minted for a field of 8
    // (4 matches × 3 = 12 rows), then the field grew to 11. The rows still
    // say 4 matches a round; the field says 5 + a bye. The legend must print
    // the FIELD's answer, and the fixture total must stay the row count — the
    // disagreement between them IS the signal.
    const legend = swissStageLegend({
      kind: "swiss",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 12,
    });
    expect(legend).not.toBeNull();
    expect(legend!.matches).toBe(5);
    expect(legend!.bye).toBe(true);
    expect(legend!.fixtures).toBe(12);
    // rounds × (matches + bye) = 18 ≠ 12 — the legend does NOT reconcile them.
    expect(legend!.rounds * (legend!.matches + 1)).not.toBe(legend!.fixtures);
  });

  it("agrees with swissBoardsForField across the whole small-field table, not one lucky sample", () => {
    for (let n = 0; n <= 24; n++) {
      const { boards, bye } = swissBoardsForField(n);
      const legend = swissStageLegend({
        kind: "swiss",
        config: { rounds: 4 },
        activeEntrantIds: ids(n),
        fixtureCount: 0,
      });
      expect(legend, `field ${n}`).toEqual({ rounds: 4, matches: boards, bye, fixtures: 0 });
    }
  });
});

describe("swissLegendText (English catalog, real i18n runtime)", () => {
  it("prints the owner-approved sentence for an odd field", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 11,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("3 rounds · 5 matches + 1 bye per round · 11 fixtures");
  });

  it("DROPS the bye clause entirely on an even field", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      config: { rounds: 3 },
      activeEntrantIds: ids(10),
      fixtureCount: 15,
    })!;
    const text = swissLegendText(legend, enI18n);
    expect(text).toBe("3 rounds · 5 matches per round · 15 fixtures");
    expect(text).not.toContain("bye");
  });

  it("singularises all three counts", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      config: { rounds: 1 },
      activeEntrantIds: ids(2),
      fixtureCount: 1,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("1 round · 1 match per round · 1 fixture");
  });

  it("singularises the match clause while the bye clause is present", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      config: { rounds: 2 },
      activeEntrantIds: ids(3),
      fixtureCount: 4,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("2 rounds · 1 match + 1 bye per round · 4 fixtures");
  });

  it("never says 'board' — chess heritage stays in the code, out of the copy", () => {
    for (const n of [3, 10, 11]) {
      const legend = swissStageLegend({
        kind: "swiss",
        config: { rounds: 3 },
        activeEntrantIds: ids(n),
        fixtureCount: n,
      })!;
      expect(swissLegendText(legend, enI18n).toLowerCase()).not.toContain("board");
    }
  });
});

describe("the legend's definition of 'active field'", () => {
  // The page derives the active field as the COMPLEMENT of DEPARTED_STATUSES
  // (the one place that vocabulary is spelled — `departed-entrants-wiring`
  // reds a page that restates it). The generate path the legend must agree
  // with spells the POSITIVE predicate instead:
  //     status in ('registered','confirmed')
  // They are the same set today. This pins that, so the day `EntrantStatus`
  // grows a fifth value the legend's field definition is revisited rather
  // than silently counting a waitlisted entrant into the match count.
  it("the complement of DEPARTED_STATUSES is exactly the server's field predicate", () => {
    expect(EntrantStatus.options.filter((s) => !DEPARTED_STATUSES.has(s))).toEqual([
      "registered",
      "confirmed",
    ]);
  });
});
