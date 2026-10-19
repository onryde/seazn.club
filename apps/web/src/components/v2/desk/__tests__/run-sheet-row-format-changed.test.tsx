// W2c Task 19 (S4) - the run sheet tags a match whose format was changed: a "Format changed" chip in the row's meta strip,
// shown exactly when the loader says so (`format_changed`, `rules_override is not null`) - in BOTH directions, and at every
// fixture status (a changed format is a fact about the match, not about its phase). The decision is `formatChangedTag`
// (`desk/run-sheet-tags.ts`); this test reaches it through the REAL row, so a tag nothing renders would fail here.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { messages } from "@/lib/messages";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { Fixture } from "@/server/api-v1/schemas";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const HREF = "/o/a/c/b/d/c/f/7";
const STATUSES: readonly string[] = Fixture.shape.status.options;

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1", stage_id: "s1", fixture_no: 7, round_no: 1, seq_in_round: 1,
    scheduled_at: "2026-09-10T14:00:00.000Z", status: "scheduled", court_name: null, court_id: null, venue_name: null,
    officials: [], outcome: null, home_entrant_id: "e1", away_entrant_id: "e2", home_slot_label: null, away_slot_label: null,
    lane: null, is_final: false, third_place: false, conditional: false, ext_key: null,
    ...o,
  };
}
const row = (fixture: RunSheetFixture): ReactElement[] =>
  renderIsland(RunSheetRow, {
    fixture, href: HREF, tz: "Europe/London", orgTz: "UTC", nowMs: Date.UTC(2026, 8, 10, 12, 0, 0),
    canEdit: true, entrantNames: { e1: "Alpha", e2: "Bravo" },
  }).tree();
const chip = (tree: ReactElement[]): ReactElement | undefined => tree.find((el) => propsOf(el)["data-testid"] === "run-sheet-format-changed");
const rendered = (tree: ReactElement[]): boolean => tree.some((el) => propsOf(el).href === HREF);

describe("the run sheet's 'Format changed' chip", () => {
  it("shows when the match's format was changed - its words from the dictionary, at every status (counted)", () => {
    let checked = 0;
    for (const status of STATUSES) {
      const tree = row(fx({ status, format_changed: true }));
      expect(rendered(tree), `${status}: the row rendered`).toBe(true);
      const c = chip(tree);
      expect(c, `${status}: no chip`).toBeDefined();
      expect(textOf(c!).trim(), status).toBe(messages["runSheet.formatChanged"]);
      expect(String(propsOf(c!).className).split(/\s+/), `${status}: the phone tap floor / desktop order`).toContain("md:order-first");
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(STATUSES.length);
    expect(STATUSES.length).toBeGreaterThan(3);
  });

  it("is absent when it was not (false, null, absent) - with the row rendered, so absence is not a blank render", () => {
    let checked = 0;
    for (const format_changed of [false, null, undefined]) {
      // null is not on the wire type, but a hand-built or stale row can carry it: the tag must read it as no change.
      const tree = row(fx(format_changed === undefined ? {} : ({ format_changed } as Partial<RunSheetFixture>)));
      expect(rendered(tree), `${String(format_changed)}: the row rendered`).toBe(true);
      expect(chip(tree), String(format_changed)).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the sequence: tagged, then not (a reset), then tagged again - the chip follows the flag each time", () => {
    const seq = [true, false, true].map((format_changed) => chip(row(fx({ format_changed }))) !== undefined);
    expect(seq).toEqual([true, false, true]);
  });
});
