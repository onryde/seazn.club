// The schedule board's "Esc cancels the pick" listener is subscribed by an
// effect that announced "Pick cancelled." through `msg` but re-subscribed only
// when `pickedId` changed. So a copy-catalog change while a card was picked
// left the OLD catalog's listener on `window`: Esc then told a screen reader
// "Pick cancelled." in the previous language, on a board whose every other
// string had moved. `msg` is now in that effect's deps.
//
// Board props/mocks follow schedule-board-day-tab.test.tsx (same reasons).
// The props object is ONE constant, re-rendered as-is: the catalog change is
// the only thing that moves between the two renders.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { msgFor } from "@/lib/messages-i18n";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "es",
  router: { refresh: () => {}, replace: () => {}, push: () => {} },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => h.router,
  usePathname: () => "/o/acme/c/champs/d/u12/schedule",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural: pluralRuntime } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  const { msgFor: lookup } = await import("@/lib/messages-i18n");
  type Key = Parameters<typeof lookup>[1];
  const bound = {
    en: (k: Key, v?: Record<string, string | number>) => lookup("en", k, v),
    es: (k: Key, v?: Record<string, string | number>) => lookup("es", k, v),
  };
  return {
    ...actual,
    useMsg: () => bound[h.locale],
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
import { BoardTray } from "../board/board-tray";

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s-d1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];
const FIXTURES: BoardFixture[] = [
  {
    id: "f1",
    stage_id: "s-d1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: null,
    venue: null,
    court_label: null,
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture,
];

type BoardProps = Parameters<typeof ScheduleBoard>[0];
const PROPS = {
  divisions: DIVISIONS,
  stages: STAGES,
  fixtures: FIXTURES,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  activeEntrantCounts: { d1: 2 },
  feedLabels: {},
  settings: {
    division_id: "d1",
    tz: "UTC",
    config: {
      startAt: "2026-08-01T12:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  },
  canEdit: true,
  constraintsAllowed: true,
  canManage: true,
  aiAllowed: false,
  currency: "usd",
  competitionStart: "2026-08-01",
  competitionEnd: "2026-12-31",
  officialsWithBlackout: 0,
  viewerPlan: "community",
} as unknown as BoardProps;

const keydown = new Set<(e: { key: string }) => void>();
vi.stubGlobal("window", {
  localStorage: { getItem: () => null, setItem: () => {} },
  matchMedia: () => ({ matches: false }),
  location: { search: "" },
  addEventListener: (type: string, fn: (e: { key: string }) => void) => {
    if (type === "keydown") keydown.add(fn);
  },
  removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
    if (type === "keydown") keydown.delete(fn);
  },
});

const announced = (tree: ReactElement[]) => {
  const live = tree.filter((e) => e.type === "p" && propsOf(e)["aria-live"] === "polite");
  expect(live).toHaveLength(1);
  return textOf(propsOf(live[0]!).children as never).trim();
};

beforeEach(() => {
  h.locale = "en";
  keydown.clear();
});

describe("schedule board — Esc cancels a pick in the catalog the board has NOW", () => {
  it("a catalog change while a card is picked: Esc announces the cancel in the new catalog", () => {
    expect(msgFor("es", "board.announce.cancelled")).not.toBe(msgFor("en", "board.announce.cancelled"));
    const board = renderIsland(ScheduleBoard, PROPS);
    const tray = board.tree().find((e) => e.type === BoardTray);
    if (!tray) throw new Error("the board rendered no BoardTray");
    (propsOf(tray).onPick as (id: string) => void)("f1");
    // Non-vacuous: the pick landed, so the Esc listener is live.
    expect(announced(board.tree())).toContain("Alpha");
    expect(keydown.size).toBe(1);

    h.locale = "es";
    board.rerender(PROPS);
    expect(keydown.size).toBe(1);
    for (const fn of [...keydown]) fn({ key: "Escape" }); // snapshot: Esc re-renders

    expect(announced(board.tree())).toBe(msgFor("es", "board.announce.cancelled"));
  });
});
