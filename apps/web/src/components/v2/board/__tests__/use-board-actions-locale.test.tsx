// use-board-actions.ts's `fail()` — the SCHEDULE_CONFLICT reason list — calls
// cardTitle() via `titleOf()` but left `msg` (useMsg()) off the 4th arg, so
// an unfilled slot's title fell through to cardTitle's client-safe English
// default (board/types.ts) regardless of this org's real locale (fix round
// 3, Important 3).
//
// The shared hook harness's `useContext` always reads the context's DEFAULT
// value — there is no provider tree to mount here (_hook-harness.tsx's own
// doc comment) — so real locale threading can only be proven by replacing
// `useMsg()` itself, the same technique schedule-gate-dialog.test.tsx uses
// for useLocale/usePlural.
import { describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  reject: null as null | (() => Promise<never>),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: () => (net.reject ? net.reject() : Promise.resolve({ conflicts: [] })),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Same trick schedule-gate-dialog.test.tsx uses: keep every OTHER export of
// the real module, replace only useMsg with a Spanish-bound lookup, so any
// text the hook renders through `msg(...)` — cardTitle's 4th arg included,
// once the fix threads it — comes out in a locale the client-safe English
// default could never produce.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { msgFor } = await import("@/lib/messages-i18n");
  return {
    ...actual,
    useMsg:
      () =>
      (key: Parameters<typeof msgFor>[1], vars?: Record<string, string | number>) =>
        msgFor("es", key, vars),
  };
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const DIV = { id: "d1", name: "Open", seq: 1 } as unknown as BoardDivision;

// A real-shaped UUID. It used to be shaped this way so a
// `[0-9a-f]{8}-[0-9a-f-]{27}` regex inside fail()'s SCHEDULE_CONFLICT branch
// could scrape it back out of the English prose; C3 deleted that scrape (it
// took the FIRST id in the string, which for the overlap kinds is an entrant
// or person rather than the counterparty fixture, so the lookup missed and
// the enrichment silently degraded to "another match"). The id now travels
// in the structured `details.other_fixture_id` instead, and the shape here
// is merely realistic rather than load-bearing.
const TBD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TBD_FIXTURE = {
  id: TBD_ID,
  division_id: "d1",
  status: "scheduled",
  scheduled_at: null,
  court_label: null,
  schedule_locked: false,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
  away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
} as unknown as BoardFixture;

// Stable, module-level array references (mirrors auto-run-seq.test.tsx) —
// `useBoardActions` clears its optimistic overrides via a render-phase
// `if (seenFixtures !== fixtures)` reference check, so a FRESH `[TBD_FIXTURE]`
// literal built inline on every render would never converge (the harness's
// own "too many re-renders" guard, _hook-harness.tsx).
const DIVISIONS = [DIV];
const FIXTURES = [TBD_FIXTURE];

function driveHook() {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, {}, {}, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

describe("useBoardActions — fail()'s SCHEDULE_CONFLICT reason list", () => {
  it("fix round 3 (Important 3): names an unfilled slot in this org's REAL locale, not cardTitle's client-safe English default", async () => {
    // Conflicts with itself for simplicity — titleOf()'s lookup and the
    // locale it resolves through are what this test proves, not a realistic
    // pair of colliding fixtures.
    net.reject = () =>
      Promise.reject(
        new ApiV1Error("refused", 422, "SCHEDULE_CONFLICT", {
          // C3: the counterparty travels in the STRUCTURED `details`, not in
          // the deprecated prose. `detail` is kept alongside it exactly as the
          // wire still sends it, so this fixture stays realistic — but it is
          // no longer what `fail()` reads, and a test that supplied only the
          // prose would silently stop exercising `titleOf()` at all.
          conflicts: [
            {
              fixture_id: TBD_ID,
              code: "conflict.court",
              blocking: true,
              detail: `clash with ${TBD_ID}`,
              details: { kind: "court_double_booking", court: "Court 1", other_fixture_id: TBD_ID },
            },
          ],
        }),
      );

    const actions = driveHook();
    await actions().moveCard(TBD_ID, "2026-09-01T10:00:00.000Z", "Court 1");

    expect(actions().error).toContain("Ganador del Grupo A");
    expect(actions().error).not.toContain("Winner of Group A");
  });
});
