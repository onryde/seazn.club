// The board's time axis is the SOLVER'S lattice, not a display rule of its own
// (#datetime-ux prompt 05).
//
// THE BUG. `schedule-board.tsx` segmented the day by `matchMinutes +
// gapMinutes` while `buildGrid` searched a `gcd(matchMinutes, gapMinutes)`
// lattice. On a 30/10 board that is a 40-minute row over a 10-minute slot. The
// solver is free to place at 09:10 and 09:20; the board files both under the
// 09:00 row and draws them stacked in one cell, so two matches ten minutes
// apart are indistinguishable and dropping a card on a row means something
// different to each side.
//
// WHY THIS SHAPE OF TEST. Placer-versus-display drift is this repo's recurring
// scheduling defect, and the reason it recurs is that each side gets a test
// asserting its own number against a literal. Both stay green when a call site
// quietly stops importing the shared helper. So every assertion here compares
// THE TWO SIDES TO EACH OTHER: the step the board actually handed `BoardGrid`,
// against the spacing of the slots `buildGrid` actually emitted for the same
// config. Nothing here would survive `schedule-board.tsx` reverting to the sum.
//
// WHY A NEW FILE. `schedule-board-polish.test.tsx` and
// `schedule-board-day-tab.test.tsx` both configure `gapMinutes: 0` — the ONE
// shape where the sum and the gcd coincide — so neither could have caught this
// and neither needed changing for it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGrid } from "@seazn/engine/scheduling";
import { gridStepMinutes } from "@seazn/engine/scheduling/grid-step";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import { dayKey } from "@/lib/schedule-board";
import { timeLabel } from "@/lib/day-label";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/c/champs/d/u12/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale` THROWS outside a DictProvider and the island harness has no
// provider tree; `useMsg` already falls back to the real English catalog,
// which is the production path.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: () => Promise.resolve({ conflicts: [] }) };
});

import { ScheduleBoard } from "../schedule-board";
import { BoardGrid } from "../board/board-grid";

const dict = en as unknown as Dict;
const MIN = 60_000;
const DAY_ISO = "2026-08-01T12:00:00.000Z";
const DAY = dayKey(DAY_ISO);

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s-d1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];

const fixture = (id: string, scheduledAt: string | null): BoardFixture =>
  ({
    id,
    stage_id: "s-d1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: scheduledAt,
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "auto",
    schedule_locked: false,
    outcome: null,
  }) as unknown as BoardFixture;

/** The board config AND the solver config, built from ONE pair of numbers so a
 *  test can never accidentally compare two different boards. */
function boards(matchMinutes: number, gapMinutes: number) {
  const engineConfig = {
    startAt: Date.parse(DAY_ISO),
    matchMinutes,
    gapMinutes,
    courts: ["Court 1"],
    perEntrantMinRest: 0,
    window: { from: Date.parse(DAY_ISO), to: Date.parse(DAY_ISO) + 6 * 60 * MIN },
  };
  const settings = {
    division_id: "d1",
    tz: "UTC",
    config: {
      startAt: DAY_ISO,
      matchMinutes,
      gapMinutes,
      courts: ["Court 1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  } as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];
  return { engineConfig, settings };
}

function baseProps(
  settings: Parameters<typeof ScheduleBoard>[0]["settings"],
): Parameters<typeof ScheduleBoard>[0] {
  return {
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: [fixture("f1", DAY_ISO)],
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 4 },
    feedLabels: {},
    settings,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: false,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-12-31",
    officialsWithBlackout: 0,
  } as Parameters<typeof ScheduleBoard>[0];
}

const localStore = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

const gridOf = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((node) => node.type === BoardGrid);
  if (!el) throw new Error("the board rendered no BoardGrid");
  return el;
};

/** The step the BOARD actually rendered with — read off the props it handed
 *  `BoardGrid`, not recomputed here. */
function renderedBoard(matchMinutes: number, gapMinutes: number) {
  const { settings } = boards(matchMinutes, gapMinutes);
  const props = propsOf(gridOf(renderIsland(ScheduleBoard, baseProps(settings)).tree()));
  return {
    boardStep: props.slotMinutes as number,
    boardRows: props.slots as number[],
    boardMatchMinutes: props.matchMinutes as number,
  };
}

/** The step the SOLVER actually stepped by — measured off the slots `buildGrid`
 *  emitted, never off the `stepMinutes` it reports about itself. */
function latticeStep(matchMinutes: number, gapMinutes: number): number {
  const grid = buildGrid({ config: boards(matchMinutes, gapMinutes).engineConfig });
  const starts = grid.byCourt.get("Court 1")!.map((i) => grid.slots[i]!.startAt);
  return (starts[1]! - starts[0]!) / MIN;
}

beforeEach(() => {
  localStore.clear();
  nav.search = "";
});

describe("the board segments the day on the solver's own lattice", () => {
  it("hands BoardGrid the step buildGrid actually stepped by, not the sum", () => {
    // 30/10: the sum is 40, the gcd is 10. A board that never learned the
    // difference reports 40 here.
    const { boardStep } = renderedBoard(30, 10);
    expect(boardStep).toBe(latticeStep(30, 10));
    // The fixture can tell the two rules apart — without this the assertion
    // above passes on a `gapMinutes: 0` board under either rule.
    expect(30 + 10).not.toBe(latticeStep(30, 10));
  });

  it("spaces the rendered rows at that same lattice, not merely reports it", () => {
    // `slotMinutes` is the board's claim about itself; `slots` is what it drew.
    // A board that reported the gcd and still stepped the rows by the sum —
    // the exact half-fix — fails here and passes the test above.
    const { boardRows } = renderedBoard(30, 10);
    expect(boardRows.length).toBeGreaterThan(2);
    expect((boardRows[1]! - boardRows[0]!) / MIN).toBe(latticeStep(30, 10));
    const spacings = new Set(boardRows.slice(1).map((t, i) => t - boardRows[i]!));
    expect([...spacings]).toEqual([latticeStep(30, 10) * MIN]);
  });

  it("agrees with the solver across every shape the two rules disagree on", () => {
    // One fixture proves one point. `gapMinutes: 0` is the single shape where
    // the sum and the gcd coincide, and it is what both pre-existing board
    // suites happen to use — so it is included here as the control, not as
    // the evidence.
    for (const [matchMinutes, gapMinutes] of [
      [30, 10],
      [45, 15],
      [60, 20],
      [30, 0],
    ] as const) {
      const { boardStep } = renderedBoard(matchMinutes, gapMinutes);
      expect({ matchMinutes, gapMinutes, boardStep }).toEqual({
        matchMinutes,
        gapMinutes,
        boardStep: latticeStep(matchMinutes, gapMinutes),
      });
    }
  });

  it("hands BoardGrid the match's real duration for matchMinutes, not the display step (2026-08-10 board redesign)", () => {
    // BoardGrid's own blackout check needs the match's REAL span, not
    // slotMinutes (the display lattice — see this file's own header comment
    // on why the two diverge whenever gapMinutes > 0). schedule-board.tsx
    // wires `matchMinutes={matchMinutes}` (the file's own NaN-guarded local,
    // not the raw possibly-missing `cfg.matchMinutes`) into <BoardGrid> —
    // every OTHER test of that wiring uses gapMinutes: 0, where slotMinutes
    // and matchMinutes are numerically identical, so a reverted or typo'd
    // prop would pass unnoticed everywhere else. This is the one test that
    // can tell the two apart.
    const { boardStep, boardMatchMinutes } = renderedBoard(30, 10);
    expect(boardMatchMinutes).toBe(30);
    expect(boardStep).toBe(10);
    expect(boardMatchMinutes).not.toBe(boardStep);
  });

  it("keeps drawing a board when the stored config holds a malformed number", () => {
    // `matchMinutes` comes out of a JSONB blob. Before the shared helper, the
    // sum of a NaN was NaN, `daySlots` looped on a NaN step and returned zero
    // rows — an empty grid over a scheduled board, with no error anywhere.
    const { boardStep, boardRows } = renderedBoard(Number.NaN, 10);
    expect(boardStep).toBe(gridStepMinutes(Number.NaN, 10));
    expect(Number.isFinite(boardStep)).toBe(true);
    expect(boardRows.length).toBeGreaterThan(0);
  });
});

describe("BoardGrid stays readable as the step gets finer", () => {
  const render = (slotMinutes: number, rows: number, fixtures: BoardFixture[] = []) =>
    renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <BoardGrid
          day={DAY}
          slots={Array.from({ length: rows }, (_, i) => Date.parse(DAY_ISO) + i * slotMinutes * MIN)}
          slotMinutes={slotMinutes}
          courts={["Court 1"]}
          fixtures={fixtures}
          divisionNames={{ d1: "Under 12s" }}
          entrantNames={{ e1: "Alpha", e2: "Bravo" }}
          feedLabels={{}}
          conflictsByFixture={{}}
          canEdit
          multi={false}
          pickedId={null}
          onPick={() => {}}
          onPlace={() => {}}
          onDropCard={() => {}}
          onTogglePin={() => {}}
          venueCap="Court"
          highlightId={null}
        />
      </DictProvider>,
    );

  it("shortens BOTH the cell and its place target on a fine board", () => {
    // MEASURED, and the reason this asserts two classes rather than one: an
    // empty row's height is set by the place-target BUTTON's min-height, not by
    // the cell's `h-*`. Changing the cell alone is completely inert — it
    // screenshots pixel-identical at 41px — so a test that pinned only the cell
    // would certify a no-op as the fix.
    const coarse = render(60, 6);
    expect(coarse).toContain("h-10 border-b");
    expect(coarse).toContain("h-full min-h-8 w-full");

    const fine = render(10, 24);
    expect(fine).toContain("h-7 border-b");
    expect(fine).toContain("h-full min-h-6 w-full");
    expect(fine).not.toContain("h-10 border-b");
    expect(fine).not.toContain("min-h-8");
  });

  it("keeps the coarse board exactly as it was", () => {
    // A 30-minute step is the common case and must not regress: the threshold
    // is `< 30`, so 30 itself stays on the roomy row.
    expect(render(30, 12)).toContain("h-10 border-b");
    expect(render(30, 12)).toContain("h-full min-h-8 w-full");
  });

  it("bounds the grid's height and pins the header inside it", () => {
    // 14 hours at a 10-minute step is 84 rows — ~2900px. Unbounded, the page
    // itself grows and the court headers scroll off the top, which is the one
    // thing a courts x time grid cannot afford.
    const fine = render(10, 36);
    expect(fine).toContain("overflow-y-auto");
    expect(fine).toContain("max-h-[70vh]");
    expect(fine).toContain("sticky top-0");
  });

  it("mutes the between-times but never a row holding a match", () => {
    // At a 10-minute step every row carries a label, which buries the anchors
    // — so the off-half-hour ones recede. The row an organiser is actually
    // reading a card against must not be one of them.
    const at = Date.parse(DAY_ISO) + 10 * MIN;
    const fine = render(10, 12, [fixture("f9", new Date(at).toISOString())]);
    // The occupied row is dark despite being 10 minutes past the hour...
    expect(fine).toContain(`text-slate-500">${timeLabel(at)}`);
    // ...while its empty neighbour, equally off the half-hour, is muted.
    expect(fine).toContain(`text-slate-300">${timeLabel(at + 10 * MIN)}`);
    // And the anchor itself is always dark.
    expect(fine).toContain(`text-slate-500">${timeLabel(Date.parse(DAY_ISO))}`);
  });
});
