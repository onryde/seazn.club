import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

// Controller ruling C-3 (real-data reproduction, on top of ruling C-1): the
// day header and a bracket round header both stuck at the SAME `top: 56px`
// (`top-14`) offset. Live scroll-sweeping (own isolated env, real browser —
// see the task report) across four day/bracket size ratios never produced a
// literal box-on-box overlap between the two — each header's sticky
// containing block is verifiably its own immediate `<section>`, so a day
// header always finishes releasing before the next section's header ever
// reaches 56px — but the owner's own diagnosis and explicit ruling stand
// regardless of that structural guarantee: stack the two offsets
// deliberately (day pins first at 56px/30px tall, bracket gets pushed to
// 56+30=86px) rather than merely reasoning about non-collision. This file
// pins that offset differentiation, source-level (`environment: "node"`,
// no DOM — the live scroll geometry itself is verified in a real browser,
// not here).
const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);

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

function sheetHtml(fixtures: RunSheetFixture[], stages: { id: string; seq: number; kind: string; name: string }[]): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS })}
      stages={stages}
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

const MIXED_STAGES = [
  { id: "s1", seq: 1, kind: "league", name: "Group" },
  { id: "s2", seq: 2, kind: "knockout", name: "Playoffs" },
];
const MIXED_FIXTURES: RunSheetFixture[] = [
  fx(1, "s1", { scheduled_at: "2026-09-05T09:00:00.000Z" }),
  fx(2, "s2", { scheduled_at: "2026-09-05T15:00:00.000Z" }),
];

const BRACKET_ONLY_STAGES = [{ id: "s2", seq: 1, kind: "knockout", name: "Cup" }];
const BRACKET_ONLY_FIXTURES: RunSheetFixture[] = [fx(1, "s2", { scheduled_at: "2026-09-05T15:00:00.000Z" })];

describe("run sheet — sticky header offsets stack deliberately when a day block coexists (controller ruling C-3)", () => {
  it("guards the guard: the mixed scenario really does produce one day block and one bracket block", () => {
    const blocks = buildRunSheet({ fixtures: MIXED_FIXTURES, stages: MIXED_STAGES, tz: TZ, nowMs: NOW_MS });
    expect(blocks.map((b) => b.kind)).toEqual(["day", "bracket"]);
  });

  it("with a day block present, the bracket round header is pushed to top-[86px] (56 + the day header's own 30px)", () => {
    const html = sheetHtml(MIXED_FIXTURES, MIXED_STAGES);
    const bracketHeader = /<header class="([^"]*)"/.exec(html);
    expect(bracketHeader, "bracket round header not found").not.toBeNull();
    expect(bracketHeader![1]).toContain("top-[86px]");
    expect(bracketHeader![1], "must not ALSO carry top-14 — exactly one offset class").not.toMatch(/\btop-14\b/);
  });

  it("the day header itself is untouched — still top-14, the offset everything else stacks against", () => {
    const html = sheetHtml(MIXED_FIXTURES, MIXED_STAGES);
    const dayHeader = /<h3[^>]*data-run-sheet-day[^>]*class="([^"]*)"/.exec(html);
    expect(dayHeader, "day header not found").not.toBeNull();
    expect(dayHeader![1]).toMatch(/\btop-14\b/);
  });

  it("a bracket-only sheet (no day block anywhere) keeps the ordinary top-14 — no unearned gap under nav", () => {
    const blocks = buildRunSheet({ fixtures: BRACKET_ONLY_FIXTURES, stages: BRACKET_ONLY_STAGES, tz: TZ, nowMs: NOW_MS });
    expect(blocks.map((b) => b.kind), "guards the guard — this scenario has no day block").toEqual(["bracket"]);

    const html = sheetHtml(BRACKET_ONLY_FIXTURES, BRACKET_ONLY_STAGES);
    const bracketHeader = /<header class="([^"]*)"/.exec(html);
    expect(bracketHeader, "bracket round header not found").not.toBeNull();
    expect(bracketHeader![1]).toMatch(/\btop-14\b/);
    expect(bracketHeader![1], "no day block exists — must not reserve the extra 30px").not.toContain("top-[86px]");
  });

  it("both offset variants keep sticky + z-10 — the fix changes only the offset, never the positioning scheme or stacking order", () => {
    const mixedHeader = /<header class="([^"]*)"/.exec(sheetHtml(MIXED_FIXTURES, MIXED_STAGES))![1]!;
    const soloHeader = /<header class="([^"]*)"/.exec(sheetHtml(BRACKET_ONLY_FIXTURES, BRACKET_ONLY_STAGES))![1]!;
    for (const cls of [mixedHeader, soloHeader]) {
      expect(cls).toMatch(/\bsticky\b/);
      expect(cls).toMatch(/\bz-10\b/);
    }
  });
});
