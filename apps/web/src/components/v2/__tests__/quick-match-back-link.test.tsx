// Quick match plan 1 Task 9 fix round 1 (controller ruling 2026-11-08; spec §4 step 4, C12): the pad's way back must
// never strand the point the guest just tapped. A v3 tap with dock chips soft-commits (queue.ts `enqueueHeld`, HOLD_MS),
// and a page that unloads inside that window leaves the tap in IndexedDB, unsent, while the home the guest lands on
// shows the score without it. So the back link asks every mounted pad to release what it holds and drain, then
// navigates; capped (PAD_FLUSH_CAP_MS), because a held tap is durable and the guest must never be stuck.
//
// The sequence is driven through the REAL pipeline hook (the producer of the hold and the drain), through the link's
// own click handler (the consumer), with a scripted transport as the server: tap, click within HOLD_MS, the event is
// committed BEFORE the navigation. No DOM here (vitest is node): the hook runs under the repo's `_hook-harness`, the
// link is a hook-free component whose element's onClick is called with a click-shaped event.
//
// Sport: generic only. The flush is the chassis queue's, sport-blind (HOLD_MS is a chassis constant, R1 ruling); which
// sport soft-commits is the skin's dock, not this seam.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent, ReactElement } from "react";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { QuickMatchBackLink, leaveForHome } from "@/components/v2/quick-match-back-link";
import { resolveModuleClient } from "@/components/v2/scorepad/module-client";
import { drainForNavigation, flushMountedPads, PAD_FLUSH_CAP_MS, registerPadFlush } from "@/components/v2/scorepad/pad-flush";
import type { AppendCallResult, AppendEventBody } from "@/components/v2/scorepad/pipeline";
import { enqueueHeld, HOLD_MS } from "@/components/v2/scorepad/queue";
import { memoryQueueStore } from "@/components/v2/scorepad/queue-store";
import type { FixtureStateResult, PadTransport } from "@/components/v2/scorepad/transport";
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "@/components/v2/scorepad/types";
import type { RealtimeConnector } from "@/components/v2/scorepad/use-fixture-stream";
import { usePadPipeline, type UsePadPipelineParams, type UsePadPipelineResult } from "@/components/v2/scorepad/use-pad-pipeline";

const HREF = "/q/qm_home";
const ME: OwnIdentity = { recordedBy: "user-1", deviceLinkId: "dl-1" };

const success = (seq: number): AppendCallResult => ({
  kind: "ok",
  data: { seq, state_summary: { seq }, outcome: null, status: "in_play" },
});

/** The server: answers appends in call order from a script; or never (a hung network); or "race-lost": every append is
 *  a 409 whose slot another device holds, so each drain pass renegotiates, resends once, conflicts again and spends one
 *  of the queue's conflict passes (pipeline.ts `sendOne`, CONFLICT_PASS_CEILING). */
function fakeTransport(script: AppendCallResult[] | "hang" | "race-lost") {
  const appendCalls: { body: AppendEventBody }[] = [];
  const transport: PadTransport = {
    async appendEvent(_fixtureId, body) {
      appendCalls.push({ body });
      if (script === "hang") return new Promise<AppendCallResult>(() => {});
      if (script === "race-lost") return { kind: "conflict", currentSeq: body.expected_seq + 1, message: "SEQ_CONFLICT" };
      const next = script[appendCalls.length - 1];
      if (!next) throw new Error(`fakeTransport: no scripted append left (call #${appendCalls.length})`);
      return next;
    },
    async listEventsSince(_fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
      if (script !== "race-lost") return [];
      // The slot the pad asked for, held by ANOTHER device: a race lost, never this pad's own write.
      return [{ seq: sinceSeq + 1, type: "generic.score", payload: { by: "A", points: 9 }, recorded_by: "user-2", device_link_id: "dl-2" }];
    },
    async getLastSeq(): Promise<number> {
      throw new Error("fakeTransport: getLastSeq is not used by the pipeline hook");
    },
    async fetchState(): Promise<FixtureStateResult> {
      return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
    },
  };
  return { transport, appendCalls };
}

/** Confirms at once, so mounting arms no polling interval (use-pad-pipeline.test.tsx's own default). */
const autoConfirm: RealtimeConnector = {
  connect(params) {
    params.onStatus(true);
    return { unsubscribe() {} };
  },
};
const streamFetchFn = (async () =>
  ({ ok: true, status: 200, json: async () => ({ ok: true, data: { token: "t", channel: "c" } }) }) as Response) as unknown as typeof fetch;

function params(transport: PadTransport, fixtureId = "fx-qm"): UsePadPipelineParams {
  const generic = resolveModuleClient("generic", "1.0.0");
  return {
    fixtureId,
    module: generic,
    cfg: { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    lineups: defaultLineupPair(generic.positions),
    identity: ME,
    transport,
    auth: { kind: "session" },
    streamFetchFn,
    streamConnector: autoConfirm,
  };
}

/** Every pad a case mounted, unmounted in afterEach even when the case fails: a pad left registered would make the
 *  next case's "no pad" read as a hung flush. */
const live = new Set<() => void>();

function mountPipeline(p: UsePadPipelineParams) {
  let latest!: UsePadPipelineResult;
  function Probe(props: { p: UsePadPipelineParams; onReady: (r: UsePadPipelineResult) => void }) {
    const result = usePadPipeline(props.p);
    props.onReady(result);
    return null;
  }
  const island = renderIsland(Probe, { p, onReady: (r) => (latest = r) });
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    live.delete(unmount);
    island.unmount();
  };
  live.add(unmount);
  return {
    get current() {
      return latest;
    },
    unmount,
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A left click, or a modified one. */
function click(mods: Partial<Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...mods,
  };
}

/** The link's own element and its click handler, as React would wire them. */
function linkOnClick(): (e: ReturnType<typeof click>) => void {
  const el = QuickMatchBackLink({ href: HREF, label: "Back to the quick match" }) as ReactElement<{
    href: string;
    onClick: (e: unknown) => void;
  }>;
  expect(el.props.href, "precondition: the anchor keeps its real href").toBe(HREF);
  return el.props.onClick;
}

/** Stand in for the browser's location: every navigation recorded with what the server had received by then. */
function stubNavigation(sentSoFar: () => number) {
  const went: { href: string; sentBefore: number }[] = [];
  vi.stubGlobal("window", { location: { assign: (href: string) => went.push({ href, sentBefore: sentSoFar() }) } });
  return went;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const unmount of [...live]) unmount();
});

describe("the quick match back link sends the held point before it leaves (spec §4 step 4)", () => {
  it("tap, then the back link inside HOLD_MS: the event reaches the server BEFORE the page navigates", async () => {
    const { transport, appendCalls } = fakeTransport([success(1)]);
    const pad = mountPipeline(params(transport));
    await settle();
    // pad-host.tsx's own onDue for a held tap: close the dock, drain.
    const onDue = vi.fn(() => {
      void pad.current.retryDrain();
    });
    // The window is the caller's argument (pad-host passes HOLD_MS, 10s); a one-second one lets this case wait PAST it
    // in real time and see whether the natural tick fires a second time after the early release.
    const hold = 1_000;
    const held = await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, hold, onDue);
    expect(held, "precondition: the tap is held").not.toBeNull();
    expect(appendCalls, "precondition: a held tap has not been sent").toHaveLength(0);
    const start = Date.now();
    const went = stubNavigation(() => appendCalls.length);
    const e = click();
    linkOnClick()(e);

    await vi.waitFor(() => expect(went).toHaveLength(1), { timeout: PAD_FLUSH_CAP_MS + 1_000 });
    const took = Date.now() - start;
    // Well under the cap: the flush stops the moment the queue is empty, it does not wait the cap out.
    expect(took, "navigates as soon as the queue is empty").toBeLessThan(500);
    expect(took, "inside the hold window: the release, not the window, sent it").toBeLessThan(hold);
    expect(e.preventDefault, "the browser's own navigation is held back until the pad is drained").toHaveBeenCalledTimes(1);
    expect(went[0]).toEqual({ href: HREF, sentBefore: 1 });
    expect(appendCalls[0]!.body.payload).toEqual({ by: "H", points: 1 });
    // Past the window: a natural tick that was not cancelled would fire onDue (and a send) a second time now.
    await new Promise((r) => setTimeout(r, hold + 300));
    expect(onDue, "released early, exactly once: the natural tick never also fires").toHaveBeenCalledTimes(1);
    expect(appendCalls, "one tap, one send, even past the window").toHaveLength(1);
    expect(pad.current.queueDepth).toBe(0);
    vi.unstubAllGlobals();
    pad.unmount();
  });

  it("a second click while leaving sends the point once", async () => {
    const { transport, appendCalls } = fakeTransport([success(1)]);
    const pad = mountPipeline(params(transport));
    await settle();
    await pad.current.submitHeld("generic.score", { by: "A", points: 1 }, HOLD_MS, () => void pad.current.retryDrain());
    const went = stubNavigation(() => appendCalls.length);
    const onClick = linkOnClick();
    onClick(click());
    onClick(click());
    await vi.waitFor(() => expect(went.length).toBeGreaterThanOrEqual(1), { timeout: PAD_FLUSH_CAP_MS + 1_000 });
    await settle();
    expect(appendCalls, "one tap, one event on the server").toHaveLength(1);
    expect(went.every((w) => w.href === HREF && w.sentBefore === 1)).toBe(true);
    vi.unstubAllGlobals();
    pad.unmount();
  });

  it("a server that never answers: the link still leaves at the cap, and the point stays queued (durable)", async () => {
    const { transport, appendCalls } = fakeTransport("hang");
    const pad = mountPipeline(params(transport));
    await settle();
    await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, () => void pad.current.retryDrain());
    const went: string[] = [];
    const start = Date.now();
    const outcome = await leaveForHome(HREF, { capMs: 150, go: (href) => went.push(href) });
    expect(outcome).toBe("timed-out");
    expect(went).toEqual([HREF]);
    expect(Date.now() - start).toBeLessThan(HOLD_MS);
    expect(appendCalls.length, "the release did try to send").toBeGreaterThanOrEqual(1);
    expect(pad.current.queueDepth, "unsent, so still in the durable queue").toBe(1);
    pad.unmount();
  });

  it("a modified click (new tab, new window) is the browser's: no flush, no navigation of this page", async () => {
    let flushed = 0;
    const off = registerPadFlush(async () => {
      flushed++;
    });
    try {
      const went = stubNavigation(() => 0);
      const onClick = linkOnClick();
      const mods = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }];
      for (const m of mods) {
        const e = click(m);
        onClick(e);
        expect(e.preventDefault, JSON.stringify(m)).not.toHaveBeenCalled();
      }
      await settle();
      expect(flushed).toBe(0);
      expect(went).toEqual([]);
      expect(mods).toHaveLength(5);
    } finally {
      off();
    }
  });

  it("an unmounted pad is no longer asked: after unmount the link leaves at once", async () => {
    // A pad that, if it were still asked, could never finish: a held tap and a server that never answers. Only the
    // mount effect's cleanup keeps its flush out of the registry, so a missing cleanup makes THIS case time out.
    const { transport, appendCalls } = fakeTransport("hang");
    const pad = mountPipeline(params(transport));
    await settle();
    const held = await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, 200, vi.fn());
    expect(held, "precondition: a held tap").not.toBeNull();
    pad.unmount();
    const went: string[] = [];
    expect(await leaveForHome(HREF, { capMs: 2_000, go: (href) => went.push(href) })).toBe("drained");
    expect(went).toEqual([HREF]);
    expect(appendCalls, "the unmounted pad was not asked to send").toHaveLength(0);
  });

  it("a race lost during the flush: ONE drain pass, then leave; the point stays queued, never dead-lettered", async () => {
    // Ruling 2026-11-08: the flush's re-drain loop must not spend the queue's conflict passes (CONFLICT_PASS_CEILING,
    // 2) and dead-letter the guest's point. One pass is what any drain does; after it the point waits in IndexedDB for
    // the pad's next mount, where the ordinary pipeline resolves the race.
    const { transport, appendCalls } = fakeTransport("race-lost");
    const pad = mountPipeline(params(transport));
    await settle();
    await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, () => void pad.current.retryDrain());
    const went: string[] = [];
    const start = Date.now();
    expect(await leaveForHome(HREF, { capMs: PAD_FLUSH_CAP_MS, go: (href) => went.push(href) })).toBe("drained");
    expect(went).toEqual([HREF]);
    expect(Date.now() - start, "it stopped on the conflict, it did not re-drain until the cap").toBeLessThan(1_000);
    const queued = await pad.current.queueStore.list();
    expect(queued, "the point is still queued, not dropped").toHaveLength(1);
    expect(queued[0]!.conflictPasses, "one pass spent, below the ceiling of 2").toBe(1);
    expect(appendCalls, "one pass: the send and its one renegotiated resend").toHaveLength(2);
    expect(pad.current.lastRejection, "nothing was dead-lettered (QUEUE_STALLED)").toBeNull();
  });
});

describe("pad-flush: the registry and one pad's drain", () => {
  it("no pad on the page (the waiting screen): drained at once, nothing to wait for", async () => {
    const start = Date.now();
    expect(await flushMountedPads(PAD_FLUSH_CAP_MS)).toBe("drained");
    expect(Date.now() - start).toBeLessThan(PAD_FLUSH_CAP_MS);
  });

  it("asks EVERY mounted pad, and waits for the slowest", async () => {
    const done: string[] = [];
    const offs = [
      registerPadFlush(async () => {
        done.push("a");
      }),
      registerPadFlush(async () => {
        await new Promise((r) => setTimeout(r, 30));
        done.push("b");
      }),
    ];
    try {
      expect(await flushMountedPads(2_000)).toBe("drained");
      expect(done.sort()).toEqual(["a", "b"]);
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("a pad whose flush throws counts as done: leaving is never blocked by it", async () => {
    const off = registerPadFlush(async () => {
      throw new Error("boom");
    });
    try {
      const went: string[] = [];
      expect(await leaveForHome(HREF, { capMs: 2_000, go: (h) => went.push(h) })).toBe("drained");
      expect(went).toEqual([HREF]);
    } finally {
      off();
    }
  });

  it("the cap: a pad that never finishes is given up on at capMs", async () => {
    const off = registerPadFlush(() => new Promise<void>(() => {}));
    try {
      const start = Date.now();
      expect(await flushMountedPads(80)).toBe("timed-out");
      const took = Date.now() - start;
      expect(took).toBeGreaterThanOrEqual(70);
      expect(took).toBeLessThan(1_000);
    } finally {
      off();
    }
  });

  it("one pad's drain releases EVERY held tap at once and drains until the queue is empty", async () => {
    const store = memoryQueueStore();
    const event = (key: string): PendingEvent =>
      ({ idempotencyKey: key, type: "generic.score", payload: {}, expectedSeq: 0, attempts: 0 }) as unknown as PendingEvent;
    const onDue = vi.fn();
    await enqueueHeld(store, event("k1"), HOLD_MS, onDue);
    let drains = 0;
    // The drain: sends whatever is no longer held, the way runDrain does (a held front entry stops it).
    const drain = async () => {
      drains++;
      for (const e of await store.list()) {
        if (e.heldUntil !== undefined) return;
        await store.delete(e.idempotencyKey);
      }
    };
    await drainForNavigation(store, drain, Date.now() + 1_000);
    expect(onDue, "the held tap was released, its own onDue fired once").toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
    expect(drains).toBeGreaterThanOrEqual(1);
  });

  it("one pad's drain stops at the deadline when the queue will not empty", async () => {
    const store = memoryQueueStore();
    await store.put({ idempotencyKey: "stuck", type: "generic.score", payload: {}, expectedSeq: 0, attempts: 0 } as unknown as PendingEvent);
    let drains = 0;
    const start = Date.now();
    await drainForNavigation(store, async () => void drains++, Date.now() + 250);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(drains, "it kept trying until the deadline").toBeGreaterThan(1);
    expect(await store.list()).toHaveLength(1);
  });
});
