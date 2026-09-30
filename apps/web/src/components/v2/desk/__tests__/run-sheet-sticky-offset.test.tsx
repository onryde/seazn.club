import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";

// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

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
//
// W4, review finding m2. The mechanism changed and these tests changed with
// it. The offset was `top-[86px]`, where the 30 in that 86 was the day
// header's height ASSUMED at one line; `DayHeading` prints date + venue +
// count, so at 320 with a real venue name it wraps and the bracket header
// then overlapped the header it was supposed to stack under. The height is
// now MEASURED into `--desk-day-h` on the sheet root and consumed by one
// `calc()` on the header. Nothing here can see the measurement — this is a
// node environment and `useEffect` never runs — so what these tests pin is
// the STATIC half: the root publishes a day-dependent fallback, and the
// header's offset is derived from it rather than hardcoded. The measurement
// itself is driven at 320 in `run-sheet.spec.ts` ("a wrapped day header
// pushes the bracket header down with it"), which is the case that had
// never been scrolled at any width before this finding.
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

/** The sheet root's inline style — where the measured day-header height is
 *  published for the header's `calc()` to read. */
function rootStyle(html: string): string {
  const m = /<div style="([^"]*)"[^>]*class="space-y-6/.exec(html);
  expect(m, "sheet root (the space-y-6 block wrapper) not found").not.toBeNull();
  return m![1]!;
}

/** The first bracket round header, split into its style and class halves —
 *  the offset now lives in the former and the positioning in the latter. */
function bracketHeader(html: string): { style: string; cls: string } {
  const m = /<header style="([^"]*)" class="([^"]*)"/.exec(html);
  expect(m, "bracket round header not found").not.toBeNull();
  return { style: m![1]!, cls: m![2]! };
}

describe("run sheet — sticky header offsets stack deliberately when a day block coexists (controller ruling C-3)", () => {
  it("guards the guard: the mixed scenario really does produce one day block and one bracket block", () => {
    const blocks = buildRunSheet({ fixtures: MIXED_FIXTURES, stages: MIXED_STAGES, tz: TZ, nowMs: NOW_MS });
    expect(blocks.map((b) => b.kind)).toEqual(["day", "bracket"]);
  });

  it("with a day block present, the sheet publishes the day header's height for the offset to stack on", () => {
    const html = sheetHtml(MIXED_FIXTURES, MIXED_STAGES);
    // The pre-hydration / no-JS fallback is deliberately the OLD constant, so
    // a sheet whose effect has not run yet behaves exactly as it shipped
    // rather than collapsing both headers onto one slot.
    expect(rootStyle(html), "sheet root must publish --desk-day-h").toContain("--desk-day-h:30px");
  });

  it("the bracket round header derives its offset from that value instead of hardcoding one", () => {
    const html = sheetHtml(MIXED_FIXTURES, MIXED_STAGES);
    const header = bracketHeader(html);
    expect(header.style, "offset must be a calc over the measured height").toContain(
      "calc(3.5rem + var(--desk-day-h, 0px))",
    );
    // The regression this replaces: any literal pixel offset is the bug.
    expect(header.style, "the assumed-height literal must not come back").not.toContain("86px");
    expect(header.cls, "the offset is no longer a class at all").not.toMatch(/\btop-/);
  });

  it("the day header itself is untouched — still top-14, the offset everything else stacks against", () => {
    const html = sheetHtml(MIXED_FIXTURES, MIXED_STAGES);
    const dayHeader = /<h3[^>]*data-run-sheet-day[^>]*class="([^"]*)"/.exec(html);
    expect(dayHeader, "day header not found").not.toBeNull();
    expect(dayHeader![1]).toMatch(/\btop-14\b/);
  });

  it("a bracket-only sheet (no day block anywhere) resolves to the ordinary 56px — no unearned gap under nav", () => {
    const blocks = buildRunSheet({ fixtures: BRACKET_ONLY_FIXTURES, stages: BRACKET_ONLY_STAGES, tz: TZ, nowMs: NOW_MS });
    expect(blocks.map((b) => b.kind), "guards the guard — this scenario has no day block").toEqual(["bracket"]);

    const html = sheetHtml(BRACKET_ONLY_FIXTURES, BRACKET_ONLY_STAGES);
    // Same expression on the header either way — the DIFFERENCE lives in the
    // root's published value, and 0px makes the calc collapse to 3.5rem.
    expect(bracketHeader(html).style).toContain("calc(3.5rem + var(--desk-day-h, 0px))");
    expect(rootStyle(html), "no day block exists — must reserve nothing").toContain("--desk-day-h:0px");
  });

  it("the two scenarios actually DIFFER — the published height is what carries the differentiation", () => {
    // Without this the four tests above are each satisfiable by a sheet that
    // publishes the same value in both states, which is the whole defect
    // ruling C-3 exists to prevent.
    const mixed = rootStyle(sheetHtml(MIXED_FIXTURES, MIXED_STAGES));
    const solo = rootStyle(sheetHtml(BRACKET_ONLY_FIXTURES, BRACKET_ONLY_STAGES));
    expect(mixed).not.toBe(solo);
  });

  it("both offset variants keep sticky + z-10 — the fix changes only the offset, never the positioning scheme or stacking order", () => {
    const mixedHeader = bracketHeader(sheetHtml(MIXED_FIXTURES, MIXED_STAGES)).cls;
    const soloHeader = bracketHeader(sheetHtml(BRACKET_ONLY_FIXTURES, BRACKET_ONLY_STAGES)).cls;
    for (const cls of [mixedHeader, soloHeader]) {
      expect(cls).toMatch(/\bsticky\b/);
      expect(cls).toMatch(/\bz-10\b/);
    }
  });
});
