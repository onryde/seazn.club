// R1 chassis soft-commit (task 4, spec §2.3): enqueueHeld / mutateHeld /
// releaseHeld / dropHeld / flushHeldBefore. A tap enters the durable queue
// IMMEDIATELY — `peekInOrder` sees it right away, same as a plain
// `enqueue()` — but its SEND is deferred `holdMs`. No transport/hook
// involved here, same "no network in this file" posture as queue.test.ts:
// the `onDue` callback each function invokes stands in for "the pipeline
// would drain now" (use-pad-pipeline.ts's `runDrain` is the real, later
// caller — see queue.ts's own header for why THIS task leaves that wiring
// unbuilt: no production skin calls `enqueueHeld` yet this wave).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingEvent } from "../types";
import { memoryQueueStore } from "../queue-store";
import {
  HOLD_MS,
  HOLD_MS_DEFAULT,
  HOLD_MS_ENV_VAR,
  dropHeld,
  enqueueHeld,
  flushHeldBefore,
  mutateHeld,
  peekInOrder,
  releaseHeld,
  resolveHoldMs,
} from "../queue";

function event(idempotencyKey: string, overrides: Partial<PendingEvent> = {}): PendingEvent {
  return {
    localId: `local-${idempotencyKey}`,
    idempotencyKey,
    type: "core.note",
    payload: { text: idempotencyKey },
    expectedSeq: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

describe("soft-commit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("held event is visible immediately but not sent until the window closes", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    const id = await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);

    expect(id).toBe("a");
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["a"]);
    expect(sendSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  // R6 W-4, owner-ruled 2026-08-31. Every other test in this file is
  // HOLD_MS-RELATIVE, which is right for behaviour and means none of them can
  // see the window's VALUE change — reverting 12000 to 6000 left this whole
  // file green. So the window needs a floor of its own, stated as the product
  // requirement rather than as the number: the dock asks "who was this?" over
  // a chip row, and the scorer has to read it, find one name among a full
  // side's worth, and tap it, on a phone, mid-match.
  //
  // A FLOOR, not an equality: raising the window later is a product decision
  // that should not have to re-baseline a test, but dropping back below what
  // a roster scan costs is the regression this guards. Lost attribution is
  // permanent — nothing later can recover who was carded — while a chip row
  // that lingers is tidied by the very next tap.
  //
  // Pinned on HOLD_MS_DEFAULT, NOT on HOLD_MS. Since the window became
  // env-overridable (so e2e can run the shipped bundle at a short window), a
  // floor on HOLD_MS would pass or fail according to how the RUNNER was
  // configured — and would fail outright in the e2e-configured process, which
  // is the one place the low value is correct. The requirement above is a
  // requirement about what SHIPS, and HOLD_MS_DEFAULT is what ships.
  it("the shipped attribution window is at least five seconds — long enough to tap a name", () => {
    // 12000 -> 5000 (owner-ruled 2026-09-13): the previous twelve-second
    // window left the stream overlay a full soft-commit behind every six /
    // goal / card. 5000 -> 10000 (PR #782 review, 2026-09-14): the 5s cut
    // landed under the 6s the 12s ruling itself said was too short to read
    // eleven names on a phone — 10s restores headroom above that floor. e2e
    // keeps its own shorter override via NEXT_PUBLIC_SCOREPAD_HOLD_MS. A
    // FLOOR per the comment above, so this asserts the floor, not the
    // current literal — a later raise should not have to re-baseline this.
    expect(HOLD_MS_DEFAULT).toBeGreaterThanOrEqual(5_000);
  });

  // The override is a testing affordance, so its failure modes matter more
  // than its success one: anything unusable must fall back to the SHIPPED
  // window rather than to zero, or a typo'd CI variable turns the hold off
  // everywhere and every spec still passes (faster), with nothing red.
  describe("resolveHoldMs", () => {
    it("falls back to the shipped default when nothing is set", () => {
      expect(resolveHoldMs(undefined)).toBe(HOLD_MS_DEFAULT);
      expect(resolveHoldMs("")).toBe(HOLD_MS_DEFAULT);
      expect(resolveHoldMs("   ")).toBe(HOLD_MS_DEFAULT);
    });

    it("falls back to the shipped default for a value that is not a usable window", () => {
      for (const bad of ["abc", "3s", "NaN", "-1", "0", "499", "Infinity"]) {
        expect(resolveHoldMs(bad), `"${bad}" must not become the live window`).toBe(HOLD_MS_DEFAULT);
      }
    });

    it("honours a usable override, including one far below the shipped floor", () => {
      // 3000 is the value e2e runs at, and it is deliberately BELOW the shipped
      // product default asserted above — that is the whole point of separating
      // the two symbols. Asserted as a value distinct from HOLD_MS_DEFAULT so
      // a resolver that ignored its argument entirely could not pass.
      expect(resolveHoldMs("3000")).toBe(3000);
      expect(resolveHoldMs("3000")).not.toBe(HOLD_MS_DEFAULT);
      expect(resolveHoldMs("500")).toBe(500); // exactly at MIN_HOLD_MS, inclusive
      expect(resolveHoldMs("60000")).toBe(60000); // a LONG window is a choice, not an error
    });

    it("queue.ts spells the env read out literally, as Next's substitution requires", () => {
      // The one failure this knob cannot survive: a DYNAMIC read
      // (`process.env[HOLD_MS_ENV_VAR]`) compiles to `undefined` in the client
      // bundle, so the pad silently always holds for the default while the
      // Node-side specs — which read the real env — shorten their waits to
      // match a window the browser is not using. Every spec would still pass,
      // just by racing. Nothing in TypeScript can catch that, so read the
      // SOURCE and require the literal member expression Next substitutes.
      //
      // Resolved off this file's own URL rather than cwd: `git grep` and bare
      // relative paths both resolve against the runner's working directory
      // here, which is not reliably the workspace root.
      const source = readFileSync(new URL("../queue.ts", import.meta.url), "utf8");
      expect(source).toContain(`process.env.${HOLD_MS_ENV_VAR}`);
      expect(HOLD_MS_ENV_VAR).toBe("NEXT_PUBLIC_SCOREPAD_HOLD_MS");
    });

    it("the live window is the resolver's own answer for this process", () => {
      // Ties the exported constant to the resolver rather than to a literal:
      // green at 12000 in a normal run AND at 3000 under the e2e env, and red
      // if HOLD_MS were ever wired to something else.
      expect(HOLD_MS).toBe(resolveHoldMs(process.env.NEXT_PUBLIC_SCOREPAD_HOLD_MS));
    });
  });

  it("a new tap flushes the previous held event first", async () => {
    const store = memoryQueueStore();
    const sendSpyA = vi.fn();
    const sendSpyB = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpyA); // A's own deadline: t=HOLD_MS
    await vi.advanceTimersByTimeAsync(1000); // t=1000, well inside A's window
    expect(vi.getTimerCount()).toBe(1); // just A's own release tick pending

    await enqueueHeld(store, event("b"), HOLD_MS, sendSpyB); // flushes A first; B's deadline: HOLD_MS+1000

    expect(sendSpyA).toHaveBeenCalledTimes(1); // A released (sent) by B's arrival
    expect(sendSpyB).not.toHaveBeenCalled(); // B still holding its own window

    const list = await peekInOrder(store);
    expect(list.find((e) => e.idempotencyKey === "a")?.heldUntil).toBeUndefined();
    expect(list.find((e) => e.idempotencyKey === "b")?.heldUntil).toBeDefined();

    // The flush must actually CANCEL A's own timer (queue.ts's cancelTick),
    // not merely leave it dangling — exactly one fake timer pending now
    // (B's), never A's-plus-B's. Asserted directly on vitest's own timer
    // count rather than on queue.ts's internal tick registry (not exported,
    // and shouldn't be just for this).
    expect(vi.getTimerCount()).toBe(1);

    // Separately, and NOT what the assertion above is proving: even if that
    // cancellation somehow failed and A's stale timer fired anyway, a
    // SECOND onDue call is independently guarded by clearHeldFlag's own
    // idempotency (an already-unheld entry's second clear attempt is a
    // no-op, `cleared === false` — see queue.ts). That point is past A's
    // original schedule (t=HOLD_MS) but still short of B's real one (+1000).
    // Expressed in HOLD_MS, not the literal it used to be: from t=1000 this
    // lands at HOLD_MS+500 — past A's original schedule, 500ms short of B's.
    await vi.advanceTimersByTimeAsync(HOLD_MS - 500);
    expect(sendSpyA).toHaveBeenCalledTimes(1); // still just once
    expect(sendSpyB).not.toHaveBeenCalled(); // B's own window hasn't closed yet

    await vi.advanceTimersByTimeAsync(500); // t=HOLD_MS+1000 — B's real deadline
    expect(sendSpyB).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // nothing left pending
  });

  it("mutateHeld lands in the sent payload", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a", { payload: { runs: 1 } }), HOLD_MS, sendSpy);
    const applied = await mutateHeld(store, "a", (e) => ({ ...e, payload: { runs: 4 } }));
    expect(applied).toBe(true);

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = (await peekInOrder(store)).find((e) => e.idempotencyKey === "a");
    expect(sent?.payload).toEqual({ runs: 4 });
  });

  it("mutateHeld is a no-op once the entry is no longer held", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await releaseHeld(store, "a"); // released early — no longer held

    const applied = await mutateHeld(store, "a", (e) => ({ ...e, payload: { runs: 99 } }));
    expect(applied).toBe(false);
    expect((await peekInOrder(store)).find((e) => e.idempotencyKey === "a")?.payload).toEqual({ text: "a" });
  });

  it("dropHeld removes without send and without core.void", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    const dropped = await dropHeld(store, "a");
    expect(dropped).toBe(true);

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    const list = await peekInOrder(store);
    expect(list).toEqual([]);
    expect(list.some((e) => e.type === "core.void")).toBe(false);
  });

  it("dropHeld returns false for an id that names no currently-held entry", async () => {
    const store = memoryQueueStore();
    expect(await dropHeld(store, "ghost")).toBe(false);
  });

  it("releaseHeld sends immediately without waiting out the rest of the window", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await releaseHeld(store, "a");

    expect(sendSpy).toHaveBeenCalledTimes(1); // sent right away, not after HOLD_MS
    expect((await peekInOrder(store)).find((e) => e.idempotencyKey === "a")?.heldUntil).toBeUndefined();

    // The now-cancelled natural tick must never ALSO fire.
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("flushHeldBefore is a no-op when nothing is held", async () => {
    const store = memoryQueueStore();
    await expect(flushHeldBefore(store, Date.now())).resolves.toBeUndefined();
  });

  it("reload durability: held event survives store rehydrate with its remaining window intact", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await vi.advanceTimersByTimeAsync(2000); // 2s elapsed, 4s of the window remain

    // Simulate the reload boundary queue-store.ts's persistence already
    // crosses: a plain JSON round-trip is the same structured-clone-shaped
    // boundary IndexedDB's real put()/list() cross for a field this
    // ordinary (a number — no Map/Set/class instance). queue-store.ts
    // itself needed NO code change for `heldUntil` to survive this: put()
    // persists whatever fields PendingEvent carries, generically.
    const persisted = JSON.parse(JSON.stringify(await peekInOrder(store))) as PendingEvent[];
    const rehydrated = memoryQueueStore();
    for (const entry of persisted) await rehydrated.put(entry);

    const found = (await rehydrated.list()).find((e) => e.idempotencyKey === "a");
    expect(found?.heldUntil).toBeDefined();
    // Remaining window intact — an ABSOLUTE deadline, not reset to a fresh
    // HOLD_MS by the reload.
    expect(found!.heldUntil! - Date.now()).toBe(HOLD_MS - 2000);
  });

  it("a plain enqueue (no hold) is untouched: peekInOrder returns the SAME event either way", async () => {
    // R1 ruling: enqueue() without a hold must keep today's exact
    // behaviour — this suite imports it fresh (not re-exported wrapped)
    // to prove queue.ts's own pre-existing export is untouched.
    const { enqueue } = await import("../queue");
    const store = memoryQueueStore();
    await enqueue(store, event("plain"));
    const [only] = await peekInOrder(store);
    expect(only).toEqual(event("plain"));
    expect(only?.heldUntil).toBeUndefined();
  });
});
