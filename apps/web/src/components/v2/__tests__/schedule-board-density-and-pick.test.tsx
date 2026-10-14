// The board's density (Board / Agenda / By division) and its pick-then-place
// pick (ESLint L3). Density used to be copied out of localStorage + matchMedia
// into state by an effect; it is now derived from a pick, the saved value
// (useLocalStorageItem) and the viewport (useMediaQuery). The stale pick used
// to be dropped by an effect; it is now dropped during render. Pinned in
// sequence: server render, after hydration (saved / phone / ≥8 divisions /
// junk), a pick (remembered; still switches when storage refuses), and a
// picked card that leaves the board. Setup mirrors
// schedule-board-esc-locale.test.tsx. Expected densities are the v3/04 §2 rule
// (Agenda on a phone and for ≥8 divisions), never read back from the board.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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


const store = new Map<string, string>();
let narrow = false;
let refuseWrites = false;
const keydown = new Set<(e: { key: string }) => void>();
beforeEach(() => {
  store.clear();
  narrow = false;
  refuseWrites = false;
  keydown.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuseWrites) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
    },
    matchMedia: (q: string) => ({
      matches: narrow && q === "(max-width: 640px)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    location: { search: "" },
    addEventListener: (type: string, fn: (e: { key: string }) => void) => {
      if (type === "keydown") keydown.add(fn);
    },
    removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
      if (type === "keydown") keydown.delete(fn);
    },
  });
});
// Every island is unmounted BEFORE the globals go: the board's own async
// validate round-trip re-renders after a test's last assertion, and a hydrated
// re-render reads `window.matchMedia` — on an unstubbed `window` that is an
// unhandled rejection in whatever test runs next.
const islands: { unmount: () => void }[] = [];
afterEach(() => {
  for (const island of islands.splice(0)) island.unmount();
  vi.unstubAllGlobals();
});

const KEY = "seazn:board:density";
const LABEL = {
  board: msgFor("en", "board.density.board"),
  agenda: msgFor("en", "board.density.agenda"),
  lanes: msgFor("en", "board.density.lanes"),
} as const;
type D = keyof typeof LABEL;

const densityOf = (tree: ReactElement[]): D => {
  const on = tree.filter(
    (e) => e.type === "button" && propsOf(e)["aria-pressed"] === true && Object.values(LABEL).includes(textOf(e)),
  );
  expect(on, "exactly one density pressed").toHaveLength(1);
  return (Object.keys(LABEL) as D[]).find((d) => LABEL[d] === textOf(on[0]!))!;
};
const pressDensity = (tree: ReactElement[], d: D) => {
  const b = tree.find((e) => e.type === "button" && textOf(e) === LABEL[d]);
  expect(b, `${d} button`).toBeDefined();
  (propsOf(b!).onClick as () => void)();
};
const hydrated = (props: BoardProps = PROPS) => {
  const island = renderIsland(ScheduleBoard, props, undefined, { hydrate: true });
  islands.push(island);
  return island;
};
const manyDivisions = (n: number): BoardProps =>
  ({
    ...PROPS,
    divisions: Array.from({ length: n }, (_, i) => ({ ...DIVISIONS[0]!, id: i === 0 ? "d1" : `d${i + 1}`, seq: i })),
  }) as BoardProps;

describe("schedule board density", () => {
  it("anti-vacuity: the three density labels are distinct real words", () => {
    expect(new Set(Object.values(LABEL)).size).toBe(3);
  });

  it("server render is the Board even with a saved density (no hydration mismatch)", () => {
    store.set(KEY, "lanes");
    const server = renderIsland(ScheduleBoard, PROPS);
    islands.push(server);
    expect(densityOf(server.tree())).toBe("board");
  });

  it("after hydration: the saved density; empty case and junk fall to the default", () => {
    store.set(KEY, "lanes");
    expect(densityOf(hydrated().tree())).toBe("lanes");
    store.clear();
    expect(densityOf(hydrated().tree()), "nothing saved, wide, 1 division").toBe("board");
    store.set(KEY, "grid-of-doom");
    expect(densityOf(hydrated().tree())).toBe("board");
  });

  it("the default is Agenda on a phone and for ≥8 divisions, Board for 7 on a wide screen", () => {
    narrow = true;
    expect(densityOf(hydrated().tree())).toBe("agenda");
    narrow = false;
    expect(densityOf(hydrated(manyDivisions(8)).tree())).toBe("agenda");
    expect(densityOf(hydrated(manyDivisions(7)).tree())).toBe("board");
  });

  it("the default is decided once, not live: a window narrowed after mount keeps the Board; ≥8 divisions arriving moves it to Agenda, and dropping back keeps Agenda", () => {
    const island = hydrated();
    expect(densityOf(island.tree())).toBe("board");
    narrow = true; // the window narrows past 640px with the board on screen
    island.rerender({ ...PROPS });
    expect(densityOf(island.tree()), "no live flip on resize (e2e: schedule-datetime-ux)").toBe("board");

    narrow = false;
    island.rerender(manyDivisions(8));
    expect(densityOf(island.tree())).toBe("agenda");
    island.rerender(manyDivisions(3));
    expect(densityOf(island.tree()), "only ever moves TO Agenda, as before").toBe("agenda");
  });

  it("a saved density beats the phone default", () => {
    narrow = true;
    store.set(KEY, "board");
    expect(densityOf(hydrated().tree())).toBe("board");
  });

  it("a pick switches and is remembered; a second pick switches back; a refused write still switches", () => {
    const island = hydrated();
    pressDensity(island.tree(), "agenda");
    expect(densityOf(island.tree())).toBe("agenda");
    expect(store.get(KEY)).toBe("agenda");
    pressDensity(island.tree(), "board");
    expect(densityOf(island.tree())).toBe("board");
    expect(store.get(KEY)).toBe("board");

    refuseWrites = true;
    pressDensity(island.tree(), "lanes");
    expect(densityOf(island.tree())).toBe("lanes");
  });
});

describe("schedule board pick-then-place — a picked card that leaves the board", () => {
  it("drops the pick (and its Esc listener) when the fixture is gone; empty case: no pick, nothing listens", () => {
    const board = hydrated();
    expect(keydown.size, "nothing picked — no Esc listener").toBe(0);
    const tray = () => board.tree().find((e) => e.type === BoardTray)!;
    (propsOf(tray()).onPick as (id: string) => void)("f1");
    expect(propsOf(tray()).pickedId).toBe("f1");
    expect(keydown.size).toBe(1);

    board.rerender({ ...PROPS, fixtures: [] } as BoardProps);
    expect(propsOf(tray()).pickedId).toBeNull();
    expect(keydown.size).toBe(0);
  });
});
