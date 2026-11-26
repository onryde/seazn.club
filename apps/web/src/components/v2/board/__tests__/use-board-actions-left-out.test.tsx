// An auto run says why it left a match out: the proposal's own conflicts on the matches it does not list.
// Apply never sees those rows, and the check that follows a refresh does not repeat them, so the run's own
// message is where they are read. Driven through the real hook (vitest here has no DOM).
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  applied: 0,
  autoQueue: [] as Record<string, unknown>[],
  applyQueue: [] as (() => Promise<unknown>)[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      if (url.endsWith("/schedule/auto")) return Promise.resolve(net.autoQueue.shift());
      if (url.endsWith("/schedule/apply")) {
        net.applied++;
        return net.applyQueue.shift()!();
      }
      return Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const DIVISIONS = [{ id: "d1", name: "Open", seq: 3 } as unknown as BoardDivision];
const PLAYED = {
  id: "played",
  division_id: "d1",
  status: "decided",
  scheduled_at: "2026-08-05T10:00:00.000Z",
  court_id: "c1",
  schedule_locked: false,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
} as unknown as BoardFixture;
const FIXTURES = [PLAYED];
const NAMES = { e1: "Alpha", e2: "Bravo" };
const LABELS = {};

function driveHook() {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, NAMES, LABELS, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

const row = (id: string) => ({ fixture_id: id, scheduled_at: "2026-08-06T10:00:00.000Z", court_id: "c1" });
const proposal = (listed: string[], conflicts: unknown[]) => ({ assignments: listed.map(row), conflicts });
const applied = (n: number) => () => Promise.resolve({ applied: n, conflicts: [], seq: 4 });

const outOfOrder = (fixtureId: string) => ({
  fixture_id: fixtureId,
  code: "warn.order",
  blocking: true,
  details: { kind: "round_order_same_day", round_no: 2, other_round_no: 1, day: "2026-08-05", other_fixture_id: "played" },
});
const ORDER_SENTENCE = "Round 2 starts before round 1 on 2026-08-05 (with Alpha vs Bravo)";
const clash = (fixtureId: string) => ({ fixture_id: fixtureId, code: "conflict.court", blocking: true });

beforeEach(() => {
  net.applied = 0;
  net.autoQueue = [];
  net.applyQueue = [];
});

describe("autoRun says why matches were left out", () => {
  it("a proposal that places nothing gives its reasons, not 'nothing to schedule'", async () => {
    net.autoQueue = [proposal([], [outOfOrder("f1"), outOfOrder("f2")])];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    expect(actions().error).toBe(`2 matches were left out of this run. ${ORDER_SENTENCE}`);
    expect(actions().notice).toBeNull();
    expect(net.applied).toBe(0);
  });

  it("with nothing left out and nothing to place, it still says there is nothing to schedule", async () => {
    net.autoQueue = [proposal([], [])];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    expect(actions().notice).toBe("Nothing to schedule for this stage.");
    expect(actions().error).toBeNull();
  });

  // A held-only proposal applies and moves nothing; a partial one moves some. Both left matches out.
  it.each([0, 5])("a proposal that places only some (apply moved %i) reports the others beside the count", async (n) => {
    net.autoQueue = [proposal(["held"], [outOfOrder("f1"), clash("held")])];
    net.applyQueue = [applied(n)];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    expect(actions().notice).toBe(`Placed ${n} fixture(s).`);
    // The listed row's own warning is not a left-out match.
    expect(actions().error).toBe(`1 match was left out of this run. ${ORDER_SENTENCE}`);
  });

  it("a proposal that lists every match it speaks of raises no error", async () => {
    net.autoQueue = [proposal(["f1"], [clash("f1")])];
    net.applyQueue = [applied(1)];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    expect(actions().error).toBeNull();
  });

  it("counts matches rather than refusals, and quotes at most three different reasons", async () => {
    const codes = ["conflict.court", "warn.rest", "warn.person_overlap", "warn.window", "warn.blackout"];
    net.autoQueue = [
      proposal(
        [],
        codes.flatMap((code) => [
          { fixture_id: code, code, blocking: true },
          { fixture_id: code, code, blocking: true },
        ]),
      ),
    ];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    const { default: en } = await import("@/dictionaries/en/ui.json");
    const said = (code: string) => (en as Record<string, string>)[`board.conflictHelp.${code}`]!;
    expect(codes.slice(0, 4).map(said).every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    expect(actions().error).toBe(`5 matches were left out of this run. ${codes.slice(0, 3).map(said).join(" ")}`);
  });

  it("after a stale apply, reports what the proposal that was applied left out", async () => {
    net.autoQueue = [proposal(["held"], [outOfOrder("f1")]), proposal(["held", "f1"], [])];
    net.applyQueue = [
      () => Promise.reject(new ApiV1Error("stale", 409, "SEQ_CONFLICT", { current_seq: 9 })),
      applied(1),
    ];
    const actions = driveHook();
    await actions().autoRun("s1", "d1", false);
    expect(net.applied).toBe(2);
    expect(actions().error).toBeNull();
  });
});
