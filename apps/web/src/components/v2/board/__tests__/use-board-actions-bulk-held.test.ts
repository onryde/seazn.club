// Review 4 of #857 (Major). The board's bulk tools — shift a day ±15m, swap
// two courts — run one PATCH per card. A start taken back leaves its card
// `scheduled`, so the loop sent it too; the server refuses it as played
// (schedule.ts `moveFixture`), and the loop ended right there: the cards
// before it moved (each its own ledger step), the ones after it did not, the
// board was never re-read, and all it said was the refusal.
//
// Now a `held` card is never sent, a played refusal that arrives anyway (the
// start taken back after the board was read) is passed over, both are counted
// and said, and the board is re-read however the run ended.
import { describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; json: Record<string, unknown> }[],
  refuse: new Map<string, () => Error>(),
  answers: new Map<string, unknown>(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: Record<string, unknown> }) => {
      if (options?.method !== "PATCH") {
        for (const [pat, answer] of net.answers) if (url.endsWith(pat)) return Promise.resolve(answer);
        return Promise.resolve({ conflicts: [] });
      }
      net.calls.push({ url, json: options.json ?? {} });
      const refuse = net.refuse.get(url);
      return refuse ? Promise.reject(refuse()) : Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: net.refresh, push: () => undefined }),
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { dayKey } from "@/lib/schedule-board";
import en from "@/dictionaries/en/ui.json";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const EN = en as unknown as Record<string, string>;
const KEPT_ONE = EN["history.danger.keptPlayed.one"]!.replace("{count}", "1");
const DIVISIONS = [{ id: "d1", name: "Open", seq: 3 } as unknown as BoardDivision];
const AT = (h: number) => `2026-08-05T${String(h).padStart(2, "0")}:00:00.000Z`;
const DAY = dayKey(AT(10));

const card = (id: string, h: number, court: string, extra: Partial<BoardFixture> = {}) =>
  ({
    id,
    division_id: "d1",
    status: "scheduled",
    scheduled_at: AT(h),
    court_label: null,
    court_id: court,
    schedule_locked: false,
    ...extra,
  }) as unknown as BoardFixture;

const played = () =>
  new ApiV1Error("this match has a result or scoring recorded, so it can't be moved or locked", 422, PLAYED_REFUSAL_CODE);

function driveHook(fixtures: BoardFixture[]) {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, fixtures, {}, {}, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

function reset(refused: string[] = []) {
  net.calls.length = 0;
  net.refuse.clear();
  net.answers.clear();
  for (const id of refused) net.refuse.set(`/api/v1/fixtures/${id}`, played);
  net.refresh.mockClear();
}

const patched = () => net.calls.map((c) => c.url.replace("/api/v1/fixtures/", ""));

// Stable references: the hook resets its overrides on a new `fixtures` array.
const THREE = [card("f1", 10, "crt-a"), card("f2", 11, "crt-a"), card("f3", 12, "crt-a")];
const THREE_HELD_MIDDLE = [card("f1", 10, "crt-a"), card("f2", 11, "crt-a", { held: true }), card("f3", 12, "crt-a")];
const SWAP = [card("f1", 10, "crt-a"), card("f2", 11, "crt-b"), card("f3", 12, "crt-a")];
const SWAP_HELD_MIDDLE = [card("f1", 10, "crt-a"), card("f2", 11, "crt-b", { held: true }), card("f3", 12, "crt-a")];

describe("useBoardActions — a bulk tool passes over a match that holds a result", () => {
  it("+15m: a played refusal mid-run is passed over, the later cards still move, and the kept one is said", async () => {
    reset(["f2"]);
    const actions = driveHook(THREE);
    await actions().shiftDay(DAY, 15);

    expect(patched()).toEqual(["f1", "f2", "f3"]);
    expect(net.calls.map((c) => c.json.scheduled_at)).toEqual([
      "2026-08-05T10:15:00.000Z",
      "2026-08-05T11:15:00.000Z",
      "2026-08-05T12:15:00.000Z",
    ]);
    // The refused move wrote no ledger step, so the token does not advance.
    expect(net.calls.map((c) => c.json.expected_seq)).toEqual([3, 4, 4]);
    expect(actions().error).toBeNull();
    expect(actions().notice).toBe(KEPT_ONE);
    expect(net.refresh).toHaveBeenCalledTimes(1);
  });

  it("+15m: a held card is never sent, and is counted as kept", async () => {
    reset();
    const actions = driveHook(THREE_HELD_MIDDLE);
    await actions().shiftDay(DAY, 15);

    expect(patched()).toEqual(["f1", "f3"]);
    expect(actions().notice).toBe(KEPT_ONE);
  });

  it("+15m with nothing held says nothing about kept matches", async () => {
    reset();
    const actions = driveHook(THREE);
    await actions().shiftDay(DAY, 15);

    expect(patched()).toEqual(["f1", "f2", "f3"]);
    expect(actions().notice).toBeNull();
  });

  it("A↔B: a played refusal mid-run is passed over and the later card still swaps; a held card is never sent", async () => {
    reset(["f2"]);
    const refused = driveHook(SWAP);
    await refused().swapCourts(DAY, "crt-a", "crt-b");
    expect(patched()).toEqual(["f1", "f2", "f3"]);
    expect(net.calls.map((c) => c.json.court_id)).toEqual(["crt-b", "crt-a", "crt-b"]);
    expect(refused().notice).toBe(KEPT_ONE);

    reset();
    const held = driveHook(SWAP_HELD_MIDDLE);
    await held().swapCourts(DAY, "crt-a", "crt-b");
    expect(patched()).toEqual(["f1", "f3"]);
    expect(held().notice).toBe(KEPT_ONE);
  });

  it("two kept matches read the plural line", async () => {
    reset(["f1"]);
    const actions = driveHook(THREE_HELD_MIDDLE);
    await actions().shiftDay(DAY, -15);
    expect(patched()).toEqual(["f1", "f3"]);
    expect(actions().notice).toBe(EN["history.danger.keptPlayed.other"]!.replace("{count}", "2"));
  });

  it("a drag of a held card sends nothing", async () => {
    reset();
    const actions = driveHook(THREE_HELD_MIDDLE);
    expect(await actions().moveCard("f2", AT(14), "crt-b")).toBe(false);
    expect(await actions().moveCard("f1", AT(14), "crt-b")).toBe(true);
    expect(patched()).toEqual(["f1"]);
  });

  // Review 5 of #857, U6. Each run says what IT kept: one that keeps nothing
  // clears the line the run before it left.
  it("a run that keeps nothing clears the previous run's kept line", async () => {
    reset(["f2"]);
    const actions = driveHook(THREE);
    await actions().shiftDay(DAY, 15);
    expect(actions().notice).toBe(KEPT_ONE);

    reset();
    await actions().shiftDay(DAY, -15);
    expect(patched()).toEqual(["f1", "f2", "f3"]);
    expect(actions().notice).toBeNull();
  });

  it("any OTHER refusal still ends the run, and the board is re-read anyway", async () => {
    reset();
    // A court clash: `fail` paints it and, unlike a stale seq, does not re-read
    // the board itself — so only the run's own re-read can be counted here.
    net.refuse.set("/api/v1/fixtures/f2", () => new ApiV1Error("clash", 409, "SCHEDULE_CONFLICT", { conflicts: [] }));
    const actions = driveHook(THREE);
    await actions().shiftDay(DAY, 15);

    expect(patched()).toEqual(["f1", "f2"]);
    expect(actions().error).not.toBeNull();
    expect(net.refresh).toHaveBeenCalledTimes(1);
  });
});

// Review 4 of #857, Minor 1. An Auto-schedule apply whose every fixture holds a
// result moves nothing and leaves the seq where it was; the board assumed +1,
// so the organiser's next edit was refused as stale.
describe("useBoardActions — the board adopts the apply's own seq", () => {
  it("after an apply that moved nothing, the next write carries the seq the server answered", async () => {
    reset();
    net.answers.set("/schedule/auto", {
      assignments: [{ fixture_id: "f2", scheduled_at: AT(15), court_id: "crt-b" }],
      conflicts: [],
    });
    net.answers.set("/schedule/apply", { applied: 0, skipped: 1, conflicts: [], seq: 3 });
    const actions = driveHook(THREE);
    await actions().autoRun("st-1", "d1", true);
    expect(actions().error).toBeNull();

    await actions().togglePin(THREE[0]!);
    expect(net.calls.map((c) => c.json.expected_seq)).toEqual([3]);
  });

  // Review 5 of #857, U1. The case above cannot tell "adopt the answer" from
  // "never adopt": both leave 3. An apply that moved something answers a NEW
  // seq, and the next write must carry it.
  it("after an apply that moved something, the next write carries the new seq the server answered", async () => {
    reset();
    net.answers.set("/schedule/auto", {
      assignments: [{ fixture_id: "f2", scheduled_at: AT(15), court_id: "crt-b" }],
      conflicts: [],
    });
    net.answers.set("/schedule/apply", { applied: 1, skipped: 0, conflicts: [], seq: 4 });
    const actions = driveHook(THREE);
    await actions().autoRun("st-1", "d1", true);
    expect(actions().error).toBeNull();

    await actions().togglePin(THREE[0]!);
    expect(net.calls.map((c) => c.json.expected_seq)).toEqual([4]);
  });
});
