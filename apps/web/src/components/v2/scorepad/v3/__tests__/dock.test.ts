// Task 7 (R1 chassis): the Detail Dock's pure controller. apps/web vitest is
// environment:"node" (no jsdom) — see task-7-brief.md — so the testable
// logic lives in dockController(spec, heldId, store), never in the
// component's own JSX; ../detail-dock.tsx's DetailDock renderer is a thin
// mapping over this, same split as tile-grid.tsx/tilesForPhase and
// scorebug.tsx's assertScorebugSpec vs their own components.
//
// `store` here is the DockStore shape (payload-level: `mutateHeld(id,
// fn(payload))`), NOT queue.ts's raw PendingEvent-level
// `mutateHeld(store, id, fn(event))` — see ../detail-dock.tsx's own header
// for why: it lets a DockChip's `mutate` (types.ts: `(payload) => payload`)
// pass straight through to `store.mutateHeld` with no adapter at the call
// site, exactly as the brief's own acceptance criterion states it
// ("store.mutateHeld(heldId, chip.mutate)"). The `makeDockStore` describe
// block below proves the bridge to the REAL queue.ts primitives separately,
// against memoryQueueStore — dockController's own tests never construct a
// QueueStore/PendingEvent at all.
import { describe, expect, it, vi } from "vitest";
import { dockController, makeDockStore, type DockStore } from "../detail-dock";
import type { DockChip, DockSpec } from "../types";
import { enqueueHeld, peekInOrder } from "../../queue";
import { memoryQueueStore } from "../../queue-store";
import type { PendingEvent } from "../../types";

function chip(over: Partial<DockChip> = {}): DockChip {
  return {
    id: "scorer",
    label: "pad.dock.chip.scorer",
    mutate: (payload) => ({ ...payload, scorer: "Kannan" }),
    ...over,
  };
}

function spec(over: Partial<DockSpec> = {}): DockSpec {
  return { title: "4 runs", chips: [chip()], ...over };
}

function pendingEvent(idempotencyKey: string, over: Partial<PendingEvent> = {}): PendingEvent {
  return {
    localId: `local-${idempotencyKey}`,
    idempotencyKey,
    type: "cricket.ball",
    payload: { runs: 4 },
    expectedSeq: 0,
    createdAt: "2026-08-16T00:00:00.000Z",
    attempts: 0,
    ...over,
  };
}

/** A minimal DockStore test double — vi.fn()s only, no QueueStore/
 *  PendingEvent involved (see file header). Defaults both calls to a
 *  successful outcome; individual tests override via `overrides`. */
function fakeStore(
  overrides: Partial<{ mutateHeld: DockStore["mutateHeld"]; releaseHeld: DockStore["releaseHeld"] }> = {},
): DockStore & { mutateHeld: ReturnType<typeof vi.fn>; releaseHeld: ReturnType<typeof vi.fn> } {
  return {
    mutateHeld: vi.fn(async () => true),
    releaseHeld: vi.fn(async () => undefined),
    ...overrides,
  } as DockStore & { mutateHeld: ReturnType<typeof vi.fn>; releaseHeld: ReturnType<typeof vi.fn> };
}

describe("dockController", () => {
  it("is null for a null spec — no dock rendered", () => {
    expect(dockController(null, "held-1", fakeStore())).toBeNull();
  });

  it("exposes the spec's title and every chip, initially unselected", () => {
    const s = spec({ title: "4 runs", chips: [chip({ id: "a" }), chip({ id: "b" })] });
    const c = dockController(s, "held-1", fakeStore());
    expect(c?.title).toBe("4 runs");
    expect(c?.chips).toEqual([
      { chip: s.chips[0], selected: false },
      { chip: s.chips[1], selected: false },
    ]);
  });

  it("a chip tap calls store.mutateHeld(heldId, chip.mutate) exactly once, forwarding chip.mutate unwrapped", async () => {
    const s = spec();
    const store = fakeStore();
    const c = dockController(s, "held-1", store)!;
    await c.tapChip("scorer");
    expect(store.mutateHeld).toHaveBeenCalledTimes(1);
    expect(store.mutateHeld).toHaveBeenCalledWith("held-1", s.chips[0].mutate);
  });

  it("marks the tapped chip selected once the store confirms the mutation applied", async () => {
    const s = spec();
    const c = dockController(s, "held-1", fakeStore())!;
    await c.tapChip("scorer");
    expect(c.chips).toEqual([{ chip: s.chips[0], selected: true }]);
  });

  it("does NOT mark a chip selected when the store reports it could not apply (window already gone)", async () => {
    const s = spec();
    const store = fakeStore({ mutateHeld: vi.fn(async () => false) });
    const c = dockController(s, "held-1", store)!;
    await c.tapChip("scorer");
    expect(c.chips).toEqual([{ chip: s.chips[0], selected: false }]);
  });

  it("tapping an unknown chip id is a no-op — no store call, no throw", async () => {
    const store = fakeStore();
    const c = dockController(spec(), "held-1", store)!;
    await expect(c.tapChip("ghost")).resolves.toBeUndefined();
    expect(store.mutateHeld).not.toHaveBeenCalled();
  });

  describe("a second tap on an already-selected chip", () => {
    // RULING (see ../detail-dock.tsx DockController.tapChip's own doc): a
    // repeat tap is a no-op, never a re-apply and never an automatic
    // deselect+revert. DockChip declares no inverse of `mutate` (types.ts),
    // and reconstructing one by snapshotting "the payload right before this
    // chip's own mutate" is unsound the instant a SECOND, unrelated chip is
    // selected afterward — reverting chip A would also discard chip B's
    // mutation. "At most once, never auto-undone" is the only behaviour
    // that cannot corrupt the payload regardless of what else gets tapped
    // in between.
    it("does not call store.mutateHeld again — 'at most once' cannot double-apply a mutation", async () => {
      const s = spec();
      const store = fakeStore();
      const c = dockController(s, "held-1", store)!;
      await c.tapChip("scorer");
      await c.tapChip("scorer");
      expect(store.mutateHeld).toHaveBeenCalledTimes(1);
    });

    it("leaves the chip selected — it does not silently deselect either", async () => {
      const s = spec();
      const c = dockController(s, "held-1", fakeStore())!;
      await c.tapChip("scorer");
      await c.tapChip("scorer");
      expect(c.chips).toEqual([{ chip: s.chips[0], selected: true }]);
    });
  });

  it("FIX ROUND 1 finding 2 — two taps fired before the first resolves still call mutateHeld exactly once (no race)", async () => {
    // The original guard (`if (selectedIds.has(chipId)) return`) only
    // blocked a REPEAT tap once the FIRST tap's own store.mutateHeld had
    // already resolved and added the id — between a tap starting and its
    // await resolving, selectedIds does not have the id yet, so a second
    // tap fired in that window sailed past the guard too. This test
    // controls the store's own resolution explicitly (a manually-resolved
    // gate promise) so both taps are GUARANTEED to overlap, deterministically
    // — no reliance on incidental microtask timing.
    const s = spec();
    let resolveFirst: (applied: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const store = fakeStore({ mutateHeld: vi.fn(() => gate) });
    const c = dockController(s, "held-1", store)!;
    const p1 = c.tapChip("scorer"); // starts; suspends awaiting the still-pending `gate`
    const p2 = c.tapChip("scorer"); // fired before `gate` has resolved — must not also call through
    resolveFirst!(true);
    await Promise.all([p1, p2]);
    expect(store.mutateHeld).toHaveBeenCalledTimes(1);
  });

  it("chips are selected independently — tapping a second chip does not affect the first", async () => {
    const s = spec({ chips: [chip({ id: "a" }), chip({ id: "b" })] });
    const store = fakeStore();
    const c = dockController(s, "held-1", store)!;
    await c.tapChip("a");
    await c.tapChip("b");
    expect(store.mutateHeld).toHaveBeenCalledTimes(2);
    expect(c.chips).toEqual([
      { chip: s.chips[0], selected: true },
      { chip: s.chips[1], selected: true },
    ]);
  });

  it("dismiss calls store.releaseHeld(heldId) — send now", async () => {
    const store = fakeStore();
    const c = dockController(spec(), "held-42", store)!;
    await c.dismiss();
    expect(store.releaseHeld).toHaveBeenCalledTimes(1);
    expect(store.releaseHeld).toHaveBeenCalledWith("held-42");
  });
});

describe("makeDockStore", () => {
  it("mutateHeld applies fn to the held entry's payload only, leaving every other field untouched", async () => {
    const store = memoryQueueStore();
    const onDue = vi.fn();
    await enqueueHeld(store, pendingEvent("h1", { payload: { runs: 4 }, attempts: 2 }), 6000, onDue);
    const dockStore = makeDockStore(store);
    const applied = await dockStore.mutateHeld("h1", (payload) => ({ ...payload, scorer: "Kannan" }));
    expect(applied).toBe(true);
    const [entry] = await peekInOrder(store);
    expect(entry.payload).toEqual({ runs: 4, scorer: "Kannan" });
    expect(entry.type).toBe("cricket.ball");
    expect(entry.attempts).toBe(2);
  });

  it("mutateHeld resolves false for an id that is not currently held", async () => {
    const dockStore = makeDockStore(memoryQueueStore());
    expect(await dockStore.mutateHeld("ghost", (p) => p)).toBe(false);
  });

  it("releaseHeld clears the hold and fires the SAME onDue enqueueHeld was given", async () => {
    const store = memoryQueueStore();
    const onDue = vi.fn();
    await enqueueHeld(store, pendingEvent("h1"), 6000, onDue);
    const dockStore = makeDockStore(store);
    await dockStore.releaseHeld("h1");
    expect(onDue).toHaveBeenCalledTimes(1);
    const [entry] = await peekInOrder(store);
    expect(entry.heldUntil).toBeUndefined();
  });
});
