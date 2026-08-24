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
import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DetailDock, dockController, makeDockStore, revealDock, type DockStore } from "../detail-dock";
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

// ---------------------------------------------------------------------------
// R3/football — `DockChip.labelText`, the pre-localised chip label.
//
// Every dock shipped before this one labelled its chips with a static i18n
// KEY ("4 runs", "Wide"), which the renderer resolves through `t(chip.label)`.
// Football's goal dock is the first whose chips name PEOPLE, and a person's
// display name is not a dictionary key: routing one through `t()` fires
// `[i18n] missing key: A. Mensah` on every render and only renders correctly
// by accident (the runtime's own missing-key fallback returns the key it was
// handed). types.ts already calls that exact shape a defect for `sublabel`,
// and already ships the remedy three times over — `TileSpec.labelText`,
// `ContextSlot.message`, `WhoLine.servingLabel` — so this is that same pair,
// not a new convention.
//
// Rendered rather than asserted on a pure helper: a helper's own green tick
// cannot prove the RENDERER calls it, which is the "fix ships inert" shape
// this wave has already found twice. `DetailDock` runs in the node harness
// once `requestAnimationFrame` exists (its depletion bar's one effect) —
// shimmed here, test-locally, exactly as much as that one line needs.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};
g.requestAnimationFrame ??= (cb) => {
  cb();
  return 0;
};
g.cancelAnimationFrame ??= () => {};

function renderDock(chips: DockChip[]) {
  return renderIsland(DetailDock, {
    spec: { title: "Who scored?", chips },
    heldId: "held-1",
    store: { mutateHeld: async () => true, releaseHeld: async () => undefined },
    heldUntil: 6000,
    t: (key: string) => (key === "pad.dock.clears" ? "clears" : `T:${key}`),
    now: () => 0,
  });
}

function chipButtonLabels(island: ReturnType<typeof renderDock>): string[] {
  return island
    .tree()
    .filter((el) => el.type === "button")
    .map((el) => textOf(el))
    .filter((text) => text.length > 0);
}

describe("DetailDock chip labels — DockChip.labelText (R3/football)", () => {
  it("renders labelText VERBATIM, never through t() — a person's name is not a dictionary key", () => {
    const island = renderDock([chip({ id: "scorer:p1", label: "pad.football.dock.scorer", labelText: "A. Mensah" })]);
    const labels = chipButtonLabels(island);
    expect(labels).toContain("A. Mensah");
    expect(labels).not.toContain("T:pad.football.dock.scorer");
  });

  it("still resolves `label` through t() for every chip that declares no labelText — every pre-R3 dock is unchanged", () => {
    const island = renderDock([chip({ id: "batRun4", label: "pad.cricket.dock.batRun4", labelText: undefined })]);
    expect(chipButtonLabels(island)).toContain("T:pad.cricket.dock.batRun4");
  });

  it("labelText WINS when both are present — never concatenated, never merged", () => {
    const island = renderDock([chip({ id: "assist:p2", label: "pad.football.dock.assist", labelText: "Assist L. Costa" })]);
    const labels = chipButtonLabels(island);
    expect(labels).toContain("Assist L. Costa");
    expect(labels.join(" ")).not.toContain("pad.football.dock.assist");
  });
});

// ---------------------------------------------------------------------------
// R3/F (F4) — THE DOCK HAS TO BE ON SCREEN WHEN IT OPENS.
//
// The dock renders AFTER the tile grid, and the grid is tall enough at every
// width that the dock lands below the fold. Measured against the real prod
// server, football's nine-tile board, tapping Goal · Home:
//
//   width  viewport h   dock h   pixels of the dock visible after the tap
//   1280   720          213       88   (125px below the fold)
//    768  1024          213      -16   (entirely below the fold — and the
//                                       scorer did not even have to scroll to
//                                       reach the tile)
//    320   568          369       12
//
// A soft-commit window the scorer cannot see always expires, which silently
// defeats the "tap commits, dock enriches" model the whole v3 design rests on.
//
// `revealDock` is the whole fix: `scrollIntoView({ block: "nearest" })`, which
// is a NO-OP when the element is already fully in view (so nothing moves at a
// width where the dock already fits) and otherwise scrolls the MINIMUM. It is
// exported and takes its node as a parameter purely so this contract is
// assertable — apps/web vitest is environment:"node" and `DetailDock`'s JSX
// has no harness, so the WIRING is proved in a browser, not here.
// ---------------------------------------------------------------------------

describe("revealDock (R3/F, F4)", () => {
  it("scrolls the node the MINIMUM needed, in both axes", () => {
    const calls: unknown[] = [];
    const node = { scrollIntoView: (opts: unknown) => calls.push(opts) };
    expect(revealDock(node)).toBe(true);
    // `nearest` on both axes: `start`/`center` would move a dock that is
    // already fully visible, which at 1280 is a page that jumps for nothing.
    expect(calls).toEqual([{ block: "nearest", inline: "nearest" }]);
  });

  it("is a no-op with no node, and where scrollIntoView does not exist", () => {
    // Both are real: the dock renders `null` until there is a held entry, and
    // jsdom-less/SSR environments have no such method. Neither may throw —
    // this runs inside a commit, so a throw here would blank the pad.
    expect(revealDock(null)).toBe(false);
    expect(revealDock({} as { scrollIntoView?: (o: unknown) => void })).toBe(false);
  });
});
