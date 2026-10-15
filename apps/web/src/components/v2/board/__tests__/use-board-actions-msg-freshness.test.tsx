// `useBoardActions`' `fail` and `autoRun` write translated sentences into the
// board's notice/error, through `msg`. Neither listed `msg` in its
// `useCallback` deps, so each kept the copy catalog of whichever render last
// changed its OTHER deps: switch the catalog (a new `dict`) with the board's
// own inputs unchanged, and a refusal was reported in the old language.
//
// The inputs below are module-level constants on purpose: `useBoardActions`
// takes `entrantNames`/`feedLabels` as deps of `fail`, and an inline `{}` per
// render would refresh `fail` on every render whatever its dep list said —
// the test would pass against the bug. Same for the router: Next's is stable.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { msgFor } from "@/lib/messages-i18n";

type Respond = (url: string, init?: { method?: string }) => Promise<unknown>;
const quiet: Respond = () => Promise.resolve({ conflicts: [] });
const h = vi.hoisted(() => ({
  locale: "en" as "en" | "es",
  /** Every apiV1 call lands here; set per test. */
  respond: null as unknown as Respond,
  router: { refresh: () => {}, push: () => {} },
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (url: string, init?: { method?: string }) => h.respond(url, init) };
});

vi.mock("next/navigation", () => ({ useRouter: () => h.router }));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { msgFor: lookup } = await import("@/lib/messages-i18n");
  type Key = Parameters<typeof lookup>[1];
  const bound = {
    en: (k: Key, v?: Record<string, string | number>) => lookup("en", k, v),
    es: (k: Key, v?: Record<string, string | number>) => lookup("es", k, v),
  };
  return { ...actual, useMsg: () => bound[h.locale] };
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const FIXTURE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DIVISIONS = [{ id: "d1", name: "Open", seq: 1 } as unknown as BoardDivision];
const FIXTURES = [
  {
    id: FIXTURE_ID,
    division_id: "d1",
    status: "scheduled",
    scheduled_at: null,
    court_label: null,
    schedule_locked: false,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
  } as unknown as BoardFixture,
];
const NAMES: Record<string, string> = { e1: "Alpha", e2: "Bravo" };
const LABELS = {};

function driveHook() {
  let latest: BoardActions | null = null;
  const island = renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, NAMES, LABELS, true);
    return null;
  }, {});
  // Same (empty) props: the catalog switch is the only thing that moves.
  return { actions: () => latest as BoardActions, rerender: () => island.rerender({}) };
}

describe("useBoardActions reports in the copy catalog it has NOW", () => {
  beforeEach(() => {
    h.locale = "en";
    h.respond = quiet;
  });

  it("fail(): a stale-board refusal after a catalog change reads in the new catalog", async () => {
    // Non-vacuous: the two catalogs really say different things.
    expect(msgFor("es", "board.stale")).not.toBe(msgFor("en", "board.stale"));
    const board = driveHook();

    h.locale = "es";
    board.rerender();
    h.respond = (_url, init) =>
      init?.method === "PATCH"
        ? Promise.reject(new ApiV1Error("stale", 409, "SEQ_CONFLICT"))
        : Promise.resolve({ conflicts: [] });
    await board.actions().moveCard(FIXTURE_ID, "2026-09-01T10:00:00.000Z", null);

    expect(board.actions().notice).toBe(msgFor("es", "board.stale"));
  });

  // Witnesses the PAIR, not autoRun alone: autoRun lists `fail`, which now
  // carries `msg`, so autoRun dropping its OWN `msg` dep would stay green here.
  // It reds only when neither callback is refreshed by a catalog change.
  it("autoRun() + fail(): an empty proposal after a catalog change reads in the new catalog", async () => {
    expect(msgFor("es", "board.action.nothingStage")).not.toBe(msgFor("en", "board.action.nothingStage"));
    const board = driveHook();

    h.locale = "es";
    board.rerender();
    h.respond = (url) =>
      url.endsWith("/schedule/auto")
        ? Promise.resolve({ assignments: [], conflicts: [] })
        : Promise.resolve({ conflicts: [] });
    await board.actions().autoRun("s1", "d1", false);

    expect(board.actions().notice).toBe(msgFor("es", "board.action.nothingStage"));
  });

  it("with no catalog change the refusal reads in the catalog it mounted with", async () => {
    const board = driveHook();
    h.respond = (_url, init) =>
      init?.method === "PATCH"
        ? Promise.reject(new ApiV1Error("stale", 409, "SEQ_CONFLICT"))
        : Promise.resolve({ conflicts: [] });
    await board.actions().moveCard(FIXTURE_ID, "2026-09-01T10:00:00.000Z", null);

    expect(board.actions().notice).toBe(msgFor("en", "board.stale"));
  });
});
