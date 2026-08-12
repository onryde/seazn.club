// The division-filter legend used to render once, above the grid — invisible
// again the moment a tall board scrolled it past the top of the viewport
// (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md). It now
// repeats below the grid too, sharing the same filter state. Mounted through
// the shared hook harness, same pattern as schedule-board-polish.test.tsx —
// this workspace has no jsdom.
import { describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";
import { BoardLegend } from "../board/board-legend";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/competitions/c1/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `usePlural` (#pins-ui) THROWS outside a DictProvider like `useLocale`
// already did — mirror `useMsg`'s real-catalog fallback rather than a stub.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural: pluralRuntime } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    useLocale: () => "en" as const,
    usePlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>) =>
        pluralRuntime(messages, key, count, "en", vars),
  };
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

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
  { id: "d2", name: "Under 14s", slug: "u14", status: "active", seq: 5, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
  { id: "s2", division_id: "d2", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];
const FIXTURES: BoardFixture[] = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture,
];

const SETTINGS = {
  tz: "Europe/London",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [{ court: "Court 2", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

const baseProps = (): BoardProps =>
  ({
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: FIXTURES,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2, d2: 0 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: { d1: SETTINGS, d2: SETTINGS } },
  }) as unknown as BoardProps;

vi.stubGlobal("window", {
  localStorage: { getItem: () => null, setItem: () => {} },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

describe("board legend + blackout wiring", () => {
  it("renders the legend once above the grid and once below it, same divisions", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const legends = island.tree().filter((el) => el.type === BoardLegend);
    expect(legends).toHaveLength(2);
    for (const legend of legends) {
      expect(legend.props).toMatchObject({ divisions: DIVISIONS });
    }
  });
});
