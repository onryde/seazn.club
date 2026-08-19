// #pins-ui (owner ruling 2026-08-12) — the auto-schedule APPLY never sent
// `expected_seq`, so `assertFreshSeq` no-oped on it (schedule.ts: `if
// (expectedSeq === undefined) return;`). A lock toggled WHILE the multi-second
// solve was running was silently overwritten by the stale proposal, because
// nothing told the server the board had moved on. `moveFixture` bumps the
// division watermark on every lock toggle, so `expected_seq` is exactly the
// right instrument — the joint apply already requires it.
//
// This file pins the three guarantees the fix adds:
//   1. the apply now carries `expected_seq`, keyed on the DIVISION the run is
//      for (the second argument), not the stage or the first division in the
//      list — a wrong key would silently validate against the wrong board;
//   2. a 409 on that apply triggers exactly ONE silent re-solve against the
//      fresh board, and applies THAT proposal (never the stale one — the board
//      changed, so the old assignment set may no longer be legal) using the
//      fresh seq the 409 itself carries;
//   3. a SECOND 409 is not retried again — it surfaces through the ordinary
//      `fail()` path, same as any other SEQ_CONFLICT.
//
// Driven through the shared hook dispatcher harness (vitest `environment:
// "node"`, no jsdom) — same pattern as result-strip-wiring.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; json?: unknown }[],
  autoQueue: [] as Record<string, unknown>[],
  applyQueue: [] as (() => Promise<unknown>)[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      if (url.endsWith("/schedule/auto")) {
        const next = net.autoQueue.shift();
        return Promise.resolve(next ?? { assignments: [], conflicts: [] });
      }
      if (url.endsWith("/schedule/apply")) {
        const next = net.applyQueue.shift();
        return next ? next() : Promise.resolve({ applied: 1, conflicts: [] });
      }
      return Promise.resolve({ conflicts: [] });
    },
  };
});

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: nav.push }) }));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import en from "@/dictionaries/en/ui.json";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

// TWO divisions with DISTINCT seqs: a test that reads the wrong one (e.g. the
// stage id, or always the first division) is caught by a mismatched number.
const DIV_A = { id: "d1", name: "Under 12s", seq: 3 } as unknown as BoardDivision;
const DIV_B = { id: "d2", name: "Under 14s", seq: 20 } as unknown as BoardDivision;
const FIXTURE = {
  id: "f1",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: null,
  court_label: null,
  schedule_locked: false,
} as unknown as BoardFixture;

const DIVISIONS = [DIV_A, DIV_B];
const FIXTURES = [FIXTURE];

function driveHook() {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, {}, {}, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

const solveOk = (fixtureId: string, at: string, court: string) => ({
  // P9: /schedule/auto returns `court_id` (schedule.ts), not the frozen label.
  assignments: [{ fixture_id: fixtureId, scheduled_at: at, court_id: court }],
  conflicts: [],
});
const applyOk = () => Promise.resolve({ applied: 1, conflicts: [] });
const applyConflict = (currentSeq: number) => () =>
  Promise.reject(
    new ApiV1Error("schedule changed since you loaded it", 409, "SEQ_CONFLICT", {
      current_seq: currentSeq,
    }),
  );

const applyBodies = () =>
  net.calls.filter((c) => c.url.endsWith("/schedule/apply")).map((c) => c.json) as Record<
    string,
    unknown
  >[];
const autoCalls = () => net.calls.filter((c) => c.url.endsWith("/schedule/auto"));

beforeEach(() => {
  net.calls = [];
  net.autoQueue = [];
  net.applyQueue = [];
  nav.refresh.mockClear();
});

describe("autoRun — the apply carries expected_seq", () => {
  it("sends the SECOND argument's division seq, not the first division's", async () => {
    net.autoQueue = [solveOk("f1", "2026-08-05T10:00:00.000Z", "1")];
    net.applyQueue = [applyOk];
    const actions = driveHook();

    await actions().autoRun("s1", "d2", false);

    expect(applyBodies()).toEqual([expect.objectContaining({ expected_seq: 20 })]);
  });
});

describe("autoRun — a 409 on apply re-solves ONCE against the fresh board", () => {
  it("re-solves and applies the FRESH proposal with the FRESH seq, never the stale one", async () => {
    net.autoQueue = [
      solveOk("f1", "2026-08-05T10:00:00.000Z", "1"), // proposal that is about to go stale
      solveOk("f1", "2026-08-05T11:00:00.000Z", "2"), // fresh proposal, post-conflict
    ];
    net.applyQueue = [applyConflict(9), applyOk];
    const actions = driveHook();

    await actions().autoRun("s1", "d1", false);

    expect(autoCalls()).toHaveLength(2); // exactly one silent re-solve
    const bodies = applyBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ expected_seq: 3 }); // DIV_A's original rendered seq
    expect(bodies[1]).toMatchObject({
      expected_seq: 9, // the 409's current_seq, not seqRef's stale value
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-05T11:00:00.000Z", court_id: "2" }],
    });
    // Silent, per the owner ruling: no red error, and the friendly
    // SEQ_CONFLICT notice never fires — this conflict resolved itself.
    expect(actions().error).toBeNull();
    expect(actions().notice).not.toBe(en["board.stale"]);
  });

  it("a SECOND 409 is not retried again — it surfaces the same way any other SEQ_CONFLICT does", async () => {
    net.autoQueue = [
      solveOk("f1", "2026-08-05T10:00:00.000Z", "1"),
      solveOk("f1", "2026-08-05T11:00:00.000Z", "2"),
    ];
    net.applyQueue = [applyConflict(9), applyConflict(15)];
    const actions = driveHook();

    await actions().autoRun("s1", "d1", false);

    expect(autoCalls()).toHaveLength(2); // still only ONE re-solve — no third attempt
    expect(applyBodies()).toHaveLength(2); // still only ONE retry — no second retry
    expect(actions().notice).toBe(en["board.stale"]); // the ordinary SEQ_CONFLICT path (`fail`)
    expect(actions().error).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
  });
});
