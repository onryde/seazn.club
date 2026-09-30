import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";

// `RunSheetRow` reaches for `useRouter` (its inline Set-time editor
// refreshes on save) — same mock `run-sheet-filters.test.tsx` needs.
// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Owner-approved "Option 2" (competition desk W3, on top of Option B) — a
// SECOND, orthogonal filter dimension on the run sheet: which stage to show,
// set from a stage card's own "View N fixtures" control
// (stages-panel.tsx). `RunSheetFilter` itself is untouched — still exactly
// "today" | "needs_result" | "unscheduled" | "all" — `stageId` is a NEW prop
// a row must ALSO satisfy, never folded into that union.
//
// Two ordinary (day-grouped, non-bracket) stages, deliberately: day groups
// MERGE fixtures across every non-bracket stage (run-sheet.tsx:4-5), so
// putting two stages' fixtures on the SAME calendar day is what actually
// witnesses the stage filter doing real work — splitting a merged block
// apart — rather than a scenario the stages were already visually separate
// in. (Bracket-stage redundancy, the OTHER half of the same finding, is
// analysed in the task report — each bracket stage is already its own
// block, so filtering to it changes what surrounds it on the page, not
// which rows that block itself shows.)
const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0); // 2026-09-05T12:00Z, mid-day UTC
const SAME_DAY = "2026-09-05T09:00:00.000Z"; // lands on today, both stages

function fx(no: number, stageId: string, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: stageId,
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: null,
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

const STAGES = [
  { id: "s1", seq: 1, kind: "league", name: "Group Stage" },
  { id: "s2", seq: 2, kind: "league", name: "Consolation" },
];

// s1: one timed fixture today (merges into the shared day block), one
// unscheduled. s2: one timed fixture the SAME day (same block as s1's row
// 1), one unscheduled. Four fixtures total, two per stage, one of each
// stage's pair unscheduled — enough to prove both row MEMBERSHIP and the
// chip COUNTS narrow to the selected stage.
const FIXTURES: RunSheetFixture[] = [
  fx(1, "s1", { scheduled_at: SAME_DAY }),
  fx(2, "s1"),
  fx(3, "s2", { scheduled_at: SAME_DAY }),
  fx(4, "s2"),
];

function sheetHtml(
  stageId: string | null,
  filter: RunSheetFilter = "all",
  onStageFilter: (id: string | null) => void = () => {},
): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures: FIXTURES, stages: STAGES, tz: TZ, nowMs: NOW_MS })}
      stages={STAGES}
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      matchMinutes={60}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      canEdit
      hrefFor={(f) => `/f/${f.fixture_no}`}
      filter={filter}
      onFilter={() => {}}
      stageId={stageId}
      onStageFilter={onStageFilter}
    />,
  );
}

function renderedRows(html: string): number[] {
  return [...html.matchAll(/data-fixture-no="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

function chipCount(html: string, filter: "needs_result" | "unscheduled"): number | null {
  const chip = new RegExp(`<button[^>]*data-filter="${filter}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  expect(chip, `no "${filter}" chip in the rendered sheet`).not.toBeNull();
  const count = /<span[^>]*>(\d+)<\/span>\s*$/.exec(chip![1]!);
  return count ? Number(count[1]) : null;
}

describe("run sheet stage filter — an orthogonal dimension, not a RunSheetFilter value", () => {
  it("guards the guard: both stages really do share one calendar day block, unfiltered", () => {
    // If a later edit moved these onto different days, every membership
    // assertion below would pass for the wrong reason (already-separate
    // blocks, not a real filter).
    const html = sheetHtml(null);
    expect(renderedRows(html)).toEqual([1, 2, 3, 4]);
  });

  it("stageId=null renders every stage's fixtures — the baseline", () => {
    expect(renderedRows(sheetHtml(null))).toEqual([1, 2, 3, 4]);
  });

  it("stageId narrows row membership to that stage only, splitting the merged day block apart", () => {
    expect(renderedRows(sheetHtml("s1"))).toEqual([1, 2]);
    expect(renderedRows(sheetHtml("s2"))).toEqual([3, 4]);
  });

  it("combines with the existing type filter (AND, not OR)", () => {
    // unscheduled ∩ s1 = {2} only, never s2's own unscheduled row (4).
    expect(renderedRows(sheetHtml("s1", "unscheduled"))).toEqual([2]);
    expect(renderedRows(sheetHtml("s2", "unscheduled"))).toEqual([4]);
  });

  it("the type-filter chip counts narrow to the selected stage", () => {
    const all = sheetHtml(null);
    expect(chipCount(all, "unscheduled")).toBe(2); // f2 + f4, division-wide
    const s1Only = sheetHtml("s1");
    expect(chipCount(s1Only, "unscheduled")).toBe(1); // f2 only
  });

  it("renders the stage-filter chip, legible in the SAME chip row, only while a stage filter is active", () => {
    const unfiltered = sheetHtml(null);
    expect(unfiltered).not.toContain('data-testid="run-sheet-stage-filter"');

    const filtered = sheetHtml("s1");
    expect(filtered).toContain('data-testid="run-sheet-stage-filter"');
    // Its own visible text carries the stage's name — the accessible name
    // a screen reader announces, no separate aria-label needed.
    expect(filtered).toMatch(/data-testid="run-sheet-stage-filter"[^>]*>[\s\S]*?Group Stage/);
    // Both chips share one row (`data-testid="run-sheet-filter"`), per
    // owner ruling — not a second, easier-to-miss control elsewhere.
    const filterRow = /<div data-testid="run-sheet-filter"[^>]*>([\s\S]*?)<\/div>\s*<div class="flex-1"/.exec(filtered);
    expect(filterRow, "no run-sheet-filter row found").not.toBeNull();
    expect(filterRow![1]).toContain('data-testid="run-sheet-stage-filter"');
  });

  it("every rendered control stays >= 44px tall (min-h-11), the stage chip included", () => {
    const html = sheetHtml("s1");
    const chipTag = /<button[^>]*data-testid="run-sheet-stage-filter"[^>]*>/.exec(html);
    expect(chipTag, "stage-filter chip not found").not.toBeNull();
    expect(chipTag![0]).toContain("min-h-11");
  });
});
