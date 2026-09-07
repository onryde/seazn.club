import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";

// `RunSheetRow` reaches for `useRouter` (its inline Set-time editor
// refreshes on save) — same mock every other run-sheet unit test needs.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Owner request (on top of Option B / ruling C-1): the sheet's internal
// blocks (day groups, bracket sections, unscheduled, settled) get real 24px
// separation instead of sitting edge to edge — the SAME `space-y-6` rhythm
// the stage cards above already use (run-sheet.tsx's own comment at the
// wrapper). This is a static, source-level check: `apps/web` vitest is
// `environment: "node"` (component-ui-i18n memory) so it cannot measure a
// real 24px gap — that was verified live instead (Playwright, scroll swept
// at both 100px and 10px granularity against a real day-block-then-bracket
// division; see the task report for the geometry). What a node-environment
// test CAN pin, and mutation-check: that the wrapper carrying every block
// really does carry `space-y-6`, and that it wraps MULTIPLE distinct block
// kinds when multiple exist — not just a single block where the class would
// have nothing to space.
const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0); // 2026-09-05T12:00Z

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

// One day-grouped (league) stage and one bracket (knockout) stage, so
// `buildRunSheet` produces TWO block kinds — a "day" block and a "bracket"
// block — the exact adjacency ruling C-1's own fix and this spacing change
// both touch (sticky day header directly followed by a sticky bracket round
// header).
const STAGES = [
  { id: "s1", seq: 1, kind: "league", name: "Group" },
  { id: "s2", seq: 2, kind: "knockout", name: "Playoffs" },
];
const DAY_ISO = "2026-09-05T09:00:00.000Z";
const BRACKET_ISO = "2026-09-05T15:00:00.000Z";
const FIXTURES: RunSheetFixture[] = [
  fx(1, "s1", { scheduled_at: DAY_ISO }),
  fx(2, "s2", { scheduled_at: BRACKET_ISO }),
];

function sheetHtml(fixtures: RunSheetFixture[]): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures, stages: STAGES, tz: TZ, nowMs: NOW_MS })}
      stages={STAGES}
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      matchMinutes={60}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      canEdit
      hrefFor={(f) => `/f/${f.fixture_no}`}
      filter="all"
      onFilter={() => {}}
      stageId={null}
      onStageFilter={() => {}}
    />,
  );
}

describe("run sheet — internal block spacing", () => {
  it("guards the guard: this scenario really does produce two DIFFERENT block kinds (day, then bracket)", () => {
    expect(FIXTURES.length).toBe(2);
    const blocks = buildRunSheet({ fixtures: FIXTURES, stages: STAGES, tz: TZ, nowMs: NOW_MS });
    expect(blocks.map((b) => b.kind)).toEqual(["day", "bracket"]);
  });

  it("wraps the rendered blocks in a space-y-6 container — the same 24px rhythm the stage cards use", () => {
    const html = sheetHtml(FIXTURES);
    // The wrapper sits directly after the filter/tz-caption row (the last
    // element of which is the `tz-caption` <p>, closing its own filter-row
    // div) and directly before the first block's own content — anchored on
    // both sides so this cannot pass by matching some unrelated
    // `space-y-6` div elsewhere on the page (`stages-panel.tsx` uses the
    // same class for its own card list).
    const afterCaption = html.slice(html.indexOf('data-testid="tz-caption"'));
    expect(afterCaption).toMatch(/^[^<]*<\/p><\/div><div class="space-y-6">/);
  });

  it("a single-block sheet still renders inside the space-y-6 wrapper (harmless with one child)", () => {
    const oneBlockFixtures = [fx(1, "s1", { scheduled_at: DAY_ISO })];
    const html = sheetHtml(oneBlockFixtures);
    const afterCaption = html.slice(html.indexOf('data-testid="tz-caption"'));
    expect(afterCaption).toMatch(/^[^<]*<\/p><\/div><div class="space-y-6">/);
  });

  it("the empty-filter state does NOT get the space-y-6 treatment — that div is a single centered message, not a block list", () => {
    // Filtering every row away renders `run-sheet-empty` instead of the
    // blocks — asserting this stays that way (never wrapped the same way)
    // guards against a future edit accidentally merging the two branches.
    // "unscheduled" is guaranteed empty here regardless of NOW_MS/grace
    // math — every fixture in FIXTURES has a `scheduled_at`, so none of
    // them can ever be in the unscheduled pile.
    const html = renderToStaticMarkup(
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
        filter="unscheduled"
        onFilter={() => {}}
        stageId={null}
        onStageFilter={() => {}}
      />,
    );
    expect(html).toContain('data-testid="run-sheet-empty"');
    expect(html).not.toContain('<div class="space-y-6">');
  });
});
