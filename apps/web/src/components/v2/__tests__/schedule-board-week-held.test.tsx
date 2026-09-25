// Review 4 of #857. The week view's cross-day drag gated on `scheduled` alone,
// so a start taken back — still `scheduled`, holding its scoring — could be
// dragged to another day, and the server refused it. A `held` card is not
// draggable there, and a drop of one moves nothing.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// The harness has no provider tree; `useLocale` throws outside one.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLocale: () => "en",
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { dayKey } from "@/lib/schedule-board";
import { WeekView } from "../schedule-board";
import type { BoardFixture } from "../board/types";

const AT = "2026-08-05T10:00:00.000Z";
const DAY = dayKey(AT);
const NEXT = dayKey("2026-08-06T10:00:00.000Z");
const card = (id: string, held?: true) =>
  ({
    id,
    division_id: "d1",
    status: "scheduled",
    scheduled_at: AT,
    court_label: null,
    court_id: "crt-a",
    schedule_locked: false,
    home_entrant_id: null,
    away_entrant_id: null,
    ...(held ? { held } : {}),
  }) as unknown as BoardFixture;

function week(onMove: (id: string, at: string, court: string | null) => void) {
  return renderIsland(WeekView, {
    weekDays: [DAY, NEXT],
    scheduled: [card("free"), card("held", true)],
    cfgStartAt: null,
    courts: ["crt-a"],
    divisionNames: {},
    entrantNames: {},
    feedLabels: {},
    canEdit: true,
    multi: false,
    onMove,
  });
}

const dropOn = (tree: ReactElement[], fixtureId: string) => {
  const columns = tree.filter((el) => typeof propsOf(el).onDrop === "function");
  expect(columns).toHaveLength(2);
  (propsOf(columns[1]!).onDrop as (e: unknown) => void)({
    preventDefault: () => undefined,
    dataTransfer: { getData: () => fixtureId },
  });
};

describe("WeekView — a card that holds a result stays on its day", () => {
  it("is not draggable, while an ordinary card is", () => {
    const view = week(vi.fn());
    const draggable = Object.fromEntries(
      view
        .tree()
        .filter((el) => el.type === "li" && propsOf(el)["data-fixture-id"] !== undefined)
        .map((el) => [propsOf(el)["data-fixture-id"], propsOf(el).draggable]),
    );
    expect(draggable).toEqual({ free: true, held: false });
  });

  it("a drop of it on another day moves nothing; a drop of an ordinary card moves it", () => {
    const onMove = vi.fn();
    const view = week(onMove);
    dropOn(view.tree(), "held");
    expect(onMove).not.toHaveBeenCalled();
    dropOn(view.tree(), "free");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]![0]).toBe("free");
  });
});
