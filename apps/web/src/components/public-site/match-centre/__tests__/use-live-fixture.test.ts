// Spectator surface W1, Task 10 — `useLiveFixture`'s own transport contract:
// the initial document renders immediately, a poll tick after POLL_MS
// replaces the WHOLE document with the fresh fetch, and a failed fetch keeps
// the last known data (never throws to the UI). This workspace's vitest runs
// `environment: "node"` (no jsdom), so the hook is driven through the shared
// `_hook-harness` (`renderIsland`) with fake timers + a module-mocked
// `fetchLiveFixture` — the same convention `use-fixture-stream.test.ts` uses
// for this exact shape of transport hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { LiveFixtureData } from "../../live-score-data";
import type { UseLiveFixtureOptions, UseLiveFixtureResult } from "../use-live-fixture";

// The browser Supabase client, faked at its module boundary for the channel-lifetime test at the bottom of this file.
// Only a NON-stub Supabase URL ever reaches it (the hook returns before the import on the stub host every other test
// here configures), so it is inert for them.
const rt = vi.hoisted(() => ({ subscribes: 0, unsubscribes: 0 }));
/** Captured before any test fakes the clock. */
const realSetTimeout = globalThis.setTimeout;
vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({
    realtime: { setAuth: async () => {} },
    channel: () => {
      const ch = {
        on: () => ch,
        subscribe: (cb: (status: string) => void) => {
          rt.subscribes++;
          cb("SUBSCRIBED");
          return ch;
        },
        unsubscribe: () => {
          rt.unsubscribes++;
        },
      };
      return ch;
    },
  }),
}));

vi.mock("../../live-score-data", async () => {
  const actual = await vi.importActual<typeof import("../../live-score-data")>("../../live-score-data");
  return {
    ...actual,
    fetchLiveFixture: vi.fn(),
    fetchPublicRealtimeToken: vi.fn(async () => {
      throw new Error("not entitled");
    }),
  };
});

import { fetchLiveFixture, fetchPublicRealtimeToken, OVERLAY_REALTIME_PURPOSE } from "../../live-score-data";
import {
  DRAIN_MS,
  POLL_MS,
  SETTLED_LISTEN_MS,
  SETTLED_POLL_MS,
  SUBSCRIBED_POLL_MS,
  useLiveFixture,
} from "../use-live-fixture";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";

function mount(
  fixtureId: string,
  initial: LiveFixtureData,
  realtime: boolean,
  options?: UseLiveFixtureOptions<LiveFixtureData>,
) {
  let latest!: UseLiveFixtureResult;
  function Probe(props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean; options?: UseLiveFixtureOptions<LiveFixtureData>; onReady: (r: UseLiveFixtureResult) => void }) {
    const result = useLiveFixture(props.fixtureId, props.initial, props.realtime, props.options);
    props.onReady(result);
    return null;
  }
  const onReady = (r: UseLiveFixtureResult) => (latest = r);
  const island = renderIsland(Probe, { fixtureId, initial, realtime, options, onReady });
  return {
    get current() {
      return latest;
    },
    /** Re-render with a DIFFERENT options object — what a caller that mints its
     *  `fetcher` inline does on every one of its own renders. Everything else
     *  about the island is held identical, so the only thing that moved is the
     *  option. */
    rerender: (next?: UseLiveFixtureOptions<LiveFixtureData>) =>
      island.rerender({ fixtureId, initial, realtime, options: next, onReady }),
    unmount: () => island.unmount(),
  };
}

const scheduled: LiveFixtureData = {
  status: "scheduled",
  summary: null,
  outcome: null,
} as LiveFixtureData;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useLiveFixture", () => {
  it("renders the initial data immediately", () => {
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.data).toBe(scheduled);
    expect(hook.current.transport).toBe("poll");
  });

  it("undelayed live mount refreshes once immediately, then again on POLL_MS", async () => {
    const next: LiveFixtureData = {
      status: "in_play",
      summary: { headline: "1 – 0" },
      outcome: null,
    } as LiveFixtureData;
    vi.mocked(fetchLiveFixture).mockResolvedValue(next);
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.data).toBe(scheduled);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLiveFixture).toHaveBeenCalledTimes(1);
    expect(hook.current.data).toBe(next);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchLiveFixture).toHaveBeenCalledTimes(2);
    expect(fetchLiveFixture).toHaveBeenCalledWith("fx-1");
  });

  it("a failed poll fetch keeps the last known data — never throws to the UI", async () => {
    vi.mocked(fetchLiveFixture).mockRejectedValue(new Error("offline"));
    const hook = mount("fx-1", scheduled, false);

    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(POLL_MS)).resolves.not.toThrow();
    expect(hook.current.data).toBe(scheduled); // unchanged, not undefined/null
  });

  // Was "…already DECIDED at mount" — which froze the owner's 2026-10-15 bug as its expected value: a decided fixture
  // is NOT terminal (an undo reopens it). FINALIZED is: the ledger refuses every write, so nothing can move it.
  it("never arms a poll timer when the fixture is already finalized at mount", async () => {
    const finalized: LiveFixtureData = { status: "finalized", summary: null, outcome: null } as LiveFixtureData;
    mount("fx-1", finalized, false);

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetchLiveFixture).not.toHaveBeenCalled();
  });

  // Review fix round 1 (MINOR 10) — a poll in flight when the component
  // unmounts must not apply its result once it lands.
  it("a poll fetch that resolves AFTER unmount does not update state (no crash, no stale write)", async () => {
    let resolveFetch!: (v: LiveFixtureData) => void;
    vi.mocked(fetchLiveFixture).mockImplementation(
      () =>
        new Promise<LiveFixtureData>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const hook = mount("fx-1", scheduled, false);
    await vi.advanceTimersByTimeAsync(0); // immediate refresh in flight
    hook.unmount();

    const late: LiveFixtureData = { status: "in_play", summary: null, outcome: null } as LiveFixtureData;
    expect(() => resolveFetch(late)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0); // flush the now-resolved promise's continuation
    expect(hook.current.data).toBe(scheduled); // unchanged — the guarded setState never applied
  });

  // ---- Stream overlay W1 (design §3.3): generic fetcher + presentation delay ----

  it("polls the public fixture URL by default — every existing caller is byte-identical", async () => {
    // The default fetcher IS `fetchLiveFixture` (mocked here), called with the id.
    vi.mocked(fetchLiveFixture).mockResolvedValue({ ...scheduled, status: "in_play" } as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.presentationNowOffsetMs, "no delay → offset 0, by value").toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLiveFixture).toHaveBeenCalledWith("fx-1");
    expect(hook.current.data.status).toBe("in_play");
  });

  it("uses the fetcher it is given, and then never calls fetchLiveFixture (one transport, two payloads)", async () => {
    const own = vi.fn(async (id: string) => ({ ...scheduled, status: "in_play", summary: { headline: `own:${id}` } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher: own });
    await vi.advanceTimersByTimeAsync(0);
    expect(own).toHaveBeenCalledWith("fx-1");
    expect(fetchLiveFixture).not.toHaveBeenCalled();
    expect(hook.current.data.summary?.headline).toBe("own:fx-1");
  });

  // Review fix round 1 (Important) — `fetcher` referential stability was
  // DOCUMENTED and unenforced. `refresh` used to list it as a `useCallback`
  // dependency, so a caller minting an inline arrow handed the poll effect a
  // new `refresh` every render, which cleared and re-armed the 15 s interval
  // every render — a poll that can starve for ever, silently. It is held in a
  // ref now, re-pointed in the render body. This is the case that pins both
  // halves; without `hook.rerender` no test in this file could see it at all,
  // because `renderIsland` holds ONE props object for the island's life.
  it("a fetcher whose identity changes every render does NOT re-arm the poll — the newest one is called on the ORIGINAL schedule", async () => {
    const a = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "a" } }) as LiveFixtureData);
    const b = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "b" } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher: a });
    await vi.advanceTimersByTimeAsync(0); // immediate → a
    expect(a).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_MS - 1000); // t = 14 000 — no interval tick yet
    hook.rerender({ fetcher: b }); // a new options object AND a new fetcher identity
    await vi.advanceTimersByTimeAsync(1000); // t = 15 000 — the ORIGINAL interval's first tick

    expect(b, "the interval was never cleared, so it fired on its own schedule").toHaveBeenCalledWith("fx-1");
    expect(a, "after the ref re-point, the interval does not call the stale fetcher").toHaveBeenCalledTimes(1);
    expect(hook.current.data.summary?.headline).toBe("b");
  });

  it("without options arms ONLY the poll timer — no drain timer (the positive pair for the delay cases)", () => {
    mount("fx-1", scheduled, false);
    // One pending timer: the POLL_MS interval. A drain interval would make it two.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("delayMs: a snapshot received at t is presented at t + delayMs, on the 1 s drain, and the offset is exposed by value", async () => {
    const fetcher = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "1 — 1" } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 3000 });
    expect(hook.current.presentationNowOffsetMs).toBe(3000);
    expect(vi.getTimerCount(), "poll + drain").toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);              // received at POLL_MS
    expect(hook.current.data.summary?.headline, "not yet — 3 s have not passed").toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);                 // drains at +1 s, +2 s: still held
    expect(hook.current.data.summary?.headline).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);                 // +3 s: presented
    expect(hook.current.data.summary?.headline).toBe("1 — 1");
  });

  it("delayMs: successive snapshots present in order, each one delayMs after ITS OWN receipt", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: `s${++n}` } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 2000 });
    // The poll interval ticks at fixed POLL_MS boundaries, so the two receipts
    // are POLL_MS apart: s1 at t = 15 000, s2 at t = 30 000. The 1 s drain
    // presents each 2 s after ITS OWN receipt — s1 at t = 17 000, s2 at
    // t = 32 000 — so at t = 30 500 the presented snapshot is still s1.
    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 15 000: s1 received
    await vi.advanceTimersByTimeAsync(500);                  // t = 15 500: s1 presented at 17 000 (below)
    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 30 500: s1 long presented, s2 received at 30 000
    expect(hook.current.data.summary?.headline).toBe("s1");
    await vi.advanceTimersByTimeAsync(2000);                 // t = 32 500: s2 became due at 32 000
    expect(hook.current.data.summary?.headline).toBe("s2");
  });

  // Mutation finding (task 1, step 5): deleting `refresh`'s try/catch leaves
  // every case in this file GREEN and SILENT — the interval never awaits
  // `refresh()`, so a rejection just escapes and nothing observes it. "Never
  // throws to the UI" was therefore untested. The overlay polls an endpoint
  // that is allowed to die (design §3.1, step 2b), so this pins it: catch a
  // process-level unhandled rejection, which is exactly what escapes.
  it("a rejected fetch is swallowed INSIDE refresh — no unhandled rejection escapes the poll interval", async () => {
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const fetcher = vi.fn(async (): Promise<LiveFixtureData> => {
        throw new Error("overlay endpoint is dead");
      });
      const hook = mount("fx-1", scheduled, false, { fetcher });
      await vi.advanceTimersByTimeAsync(0); // immediate
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(hook.current.data).toBe(scheduled);
      // The rejection is created under fake timers; node only reports an
      // unhandled one on a later REAL turn, so hand the loop one.
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(escaped, "refresh's own catch is the only thing keeping this empty").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("delayMs: two snapshots BOTH due at one drain tick — the newest wins and the older is never painted", async () => {
    // The case above never puts two snapshots in the buffer at once, so it
    // cannot witness WHICH due snapshot the drain picks. Here the first fetch
    // is held in flight until t = 29 500 and the second poll lands at
    // t = 30 000, so at the t = 32 000 tick (due = 30 000) BOTH are due.
    let releaseFirst!: (v: LiveFixtureData) => void;
    const s1 = { ...scheduled, status: "in_play", summary: { headline: "s1" } } as LiveFixtureData;
    const s2 = { ...scheduled, status: "in_play", summary: { headline: "s2" } } as LiveFixtureData;
    const fetcher = vi
      .fn(async () => s2)
      .mockImplementationOnce(
        () =>
          new Promise<LiveFixtureData>((resolve) => {
            releaseFirst = resolve;
          }),
      );
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 2000 });

    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 15 000: poll 1 fires, held in flight
    await vi.advanceTimersByTimeAsync(14_500);               // t = 29 500: still nothing received
    expect(hook.current.data.summary?.headline, "nothing received yet").toBeUndefined();
    releaseFirst(s1);
    await vi.advanceTimersByTimeAsync(0);                    // s1 RECEIVED at t = 29 500
    await vi.advanceTimersByTimeAsync(500);                  // t = 30 000: poll 2 → s2 RECEIVED at 30 000
    await vi.advanceTimersByTimeAsync(1000);                 // t = 31 000, due = 29 000: neither yet
    expect(hook.current.data.summary?.headline, "s1 is not due until 31 500").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);                 // t = 32 000, due = 30 000: BOTH due
    expect(hook.current.data.summary?.headline, "the newest DUE snapshot, never s1").toBe("s2");
  });

  // ---- Fix round I1 (2026-09-10): the INITIAL snapshot is a snapshot too ----
  //
  // Everything above exercises POLLED snapshots. `initial` went straight into
  // `useState` and was painted at once, so `?delay=30000` delayed the clock and
  // not the score for the first delayMs after every load — and OBS reloads a
  // browser source on every scene change. `initial` is now the buffer's first
  // entry, received at mount, presented by the same drain as everything else.
  //
  // `awaitingDelay` is what a consumer must gate on: while it is true the hook
  // has presented NOTHING and `data` is still the un-presented seed. It is
  // permanently false for a caller that passes no `delayMs`.

  const scored = (headline: string): LiveFixtureData =>
    ({ ...scheduled, status: "in_play", summary: { headline } }) as LiveFixtureData;

  it("delayMs: does NOT refresh immediately — the seed must mature before any polled tip", async () => {
    const fetcher = vi.fn(async () => scored("3 — 1"));
    mount("fx-1", scored("2 — 1"), false, { fetcher, delayMs: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher, "immediate refresh would race the delayed seed (I1)").not.toHaveBeenCalled();
  });

  it("no delayMs: awaitingDelay is false at mount and the initial document is presented immediately", () => {
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.awaitingDelay, "nothing to wait for").toBe(false);
    expect(hook.current.data).toBe(scheduled);
  });

  it("delayMs: the INITIAL snapshot is held too — nothing is presented at t=0", () => {
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher: vi.fn(async () => scored("3 — 1")), delayMs: 3000 });
    expect(hook.current.awaitingDelay, "a snapshot taken now is not evidence about 3 s ago").toBe(true);
    expect(vi.getTimerCount(), "poll + drain — seeding the buffer adds no third timer").toBe(2);
  });

  it("delayMs: the hold ends at exactly delayMs, and what it presents is INITIAL's score, not the poll's", async () => {
    const fetcher = vi.fn(async () => scored("3 — 1"));
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher, delayMs: 3000 });

    await vi.advanceTimersByTimeAsync(2999); // drains at 1 000 and 2 000 — neither is due
    expect(hook.current.awaitingDelay, "2 s < 3 s").toBe(true);

    await vi.advanceTimersByTimeAsync(1); // t = 3 000: the seed's own due instant
    expect(hook.current.awaitingDelay).toBe(false);
    // The right answer differs from the wrong one's constant: a hook that
    // started its buffer at the first poll would present nothing here (POLL_MS
    // is 15 s), and one that presented eagerly would already be showing 3 — 1.
    expect(hook.current.data.summary?.headline).toBe("2 — 1");
    expect(fetcher, "no poll has fired yet at t = 3 000").not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_MS); // t = 18 000: poll at 15 000, due at 18 000
    expect(hook.current.data.summary?.headline, "polled snapshots still mature on their own receipt").toBe("3 — 1");
    expect(hook.current.awaitingDelay, "once presenting, never awaiting again").toBe(false);
  });

  it("delayMs: awaitingDelay stays true for the whole hold even with polls landing (no early release)", async () => {
    const fetcher = vi.fn(async () => scored("3 — 1"));
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher, delayMs: 60_000 });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3); // t = 45 000: three polls buffered
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(hook.current.awaitingDelay, "45 s < 60 s — a poll arriving is not a snapshot maturing").toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); // t = 60 000
    expect(hook.current.awaitingDelay).toBe(false);
    expect(hook.current.data.summary?.headline, "the seed matures first, in receipt order").toBe("2 — 1");
  });

  it("delayMs: seeding happens ONCE — a later delayMs does not re-queue the mount-time document", async () => {
    // `?delay=` is parsed once server-side, so nothing in production moves it
    // mid-life. But the drain effect is keyed on `delayMs`, so without the
    // once-guard a change would push the mount-time document back into the
    // buffer and present it again `delayMs` later — winding the overlay BACK
    // to the score at page load, long after it had moved on.
    const fetcher = vi.fn(async () => scored("3 — 1"));
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher, delayMs: 3000 });
    await vi.advanceTimersByTimeAsync(18_000); // seed at 3 000, poll received 15 000 → presented 18 000
    expect(hook.current.data.summary?.headline).toBe("3 — 1");

    hook.rerender({ fetcher, delayMs: 10_000 }); // re-arms the drain
    await vi.advanceTimersByTimeAsync(10_000); // t = 28 000 — when a re-seed would land
    expect(hook.current.data.summary?.headline, "never winds back to the load-time score").toBe("3 — 1");
  });

  // ---- Review MINOR 4/MINOR 1 (2026-09-10): the 0 → N transition ----
  //
  // The once-guard above only covers N → M, because the drain effect returned
  // at its `delayMs <= 0` line BEFORE `seededRef` was set. A hook that mounted
  // undelayed and later received a non-zero `delayMs` therefore seeded the
  // MOUNT-TIME document and presented it `delayMs` later — the very wind-back
  // the guard's own comment names, through the one door it left open.
  //
  // Unreachable in production today (`?delay=` is resolved server-side and
  // `fixture-stream-panel.tsx` remounts the island by `key`), so this is a
  // latent trap rather than a live defect — and a latent trap in a hook that
  // is now shared with the public match centre.
  it("delayMs 0 → N: the undelayed pass counts as seeded — no wind-back to the mount-time score", async () => {
    const fetcher = vi.fn(async () => scored("3 — 1"));
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher }); // no delay: live
    await vi.advanceTimersByTimeAsync(0); // immediate refresh presents the poll tip
    expect(hook.current.data.summary?.headline, "undelayed: the immediate refresh paints at once").toBe("3 — 1");

    hook.rerender({ fetcher, delayMs: 10_000 }); // arms the drain for the first time
    await vi.advanceTimersByTimeAsync(10_000); // when a seed would mature
    expect(
      hook.current.data.summary?.headline,
      "the mount-time document was presented earlier and must not come back",
    ).toBe("3 — 1");
  });

  // ---- Review MINOR 2: the cold start is NOT "exactly delayMs" ----
  //
  // The drain runs on a fixed DRAIN_MS interval, so a snapshot received at t is
  // presented at the first tick at or after t + delayMs: the bound is
  // [delayMs, delayMs + DRAIN_MS), not delayMs. `resolveDelayMs` accepts any
  // whole millisecond value in 0..300 000, so `?delay=250` really does hold for
  // a full second — four times what the operator asked for, and an OBS
  // operator times scene changes against that number.
  //
  // The expected instants below are LITERAL, not `ceil(delayMs / DRAIN_MS)`:
  // a formula derived from the constant moves with a mutant and proves nothing.
  it.each([
    [250, 1000, "a sub-second delay waits out a whole drain tick — 4x what was asked"],
    [1000, 1000, "one whole tick: due and drained at the same instant"],
    [1500, 2000, "rounded UP to the next tick, never down"],
    [3000, 3000, "a multiple of the tick is the only case that IS exactly delayMs"],
  ])("delayMs %i is presented at %i ms — %s", async (delayMs, presentedAt) => {
    const fetcher = vi.fn(async () => scored("3 — 1"));
    const hook = mount("fx-1", scored("2 — 1"), false, { fetcher, delayMs });
    await vi.advanceTimersByTimeAsync(presentedAt - 1);
    expect(hook.current.awaitingDelay, `nothing is presented before ${presentedAt}`).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.current.awaitingDelay, `presented at ${presentedAt}`).toBe(false);
    expect(hook.current.data.summary?.headline).toBe("2 — 1");
  });

  it("the drain interval is 1 000 ms — the number the bound above is stated in", () => {
    // Pinned by VALUE, once. Everything above is stated in literal instants, so
    // this is the only place the constant is asserted — moving it moves four
    // expectations and this line, which is the point.
    expect(DRAIN_MS).toBe(1000);
  });
});

// RT (lane-close fix, ruled 2026-09-29): the OBS overlay DECLARES its purpose and sends its signed key when it asks for a
// realtime token, and asks even when the org's plan has no `realtime` — the token route decides (a community org's
// overlay is granted on a key that verifies). A refusal leaves it on the poll, exactly as today. The
// hook only dials when the Supabase URL is configured, so each case sets one: the CI stub host, on which the hook
// still MINTS (the e2e asserts the token) but never dials — the token request is the whole seam under test here.
describe("useLiveFixture — the overlay's declared realtime purpose and signed key (RT)", () => {
  const inPlay = { status: "in_play", summary: null, outcome: null } as LiveFixtureData;
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.co");
    vi.mocked(fetchLiveFixture).mockResolvedValue(inPlay);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a hook declaring the overlay purpose WITH its key asks for a token without `realtime`, sending both — and a refusal leaves it polling", async () => {
    const hook = mount("fx-1", inPlay, false, { realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey: "KEY" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetchPublicRealtimeToken).mock.calls).toEqual([["fx-1", OVERLAY_REALTIME_PURPOSE, "KEY"]]);
    // The mock refuses (403 "not entitled"): the transport stays the poll, which keeps its 15 s cadence.
    expect(hook.current.transport).toBe("poll");
    const polls = vi.mocked(fetchLiveFixture).mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(vi.mocked(fetchLiveFixture).mock.calls.length).toBe(polls + 1);
  });

  it("the negative pair — a spectator hook (no purpose, no `realtime`) never asks, exactly as before", async () => {
    mount("fx-1", inPlay, false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchPublicRealtimeToken).not.toHaveBeenCalled();
  });

  it("RT: a purpose WITHOUT its key (or a key without its purpose) never asks — the route would refuse it, so the request is never made", async () => {
    let checked = 0;
    const cases: UseLiveFixtureOptions<LiveFixtureData>[] = [
      { realtimePurpose: OVERLAY_REALTIME_PURPOSE },
      { overlayKey: "KEY" },
      { realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey: "" },
    ];
    for (const options of cases) {
      vi.mocked(fetchPublicRealtimeToken).mockClear();
      mount("fx-1", inPlay, false, options);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetchPublicRealtimeToken, JSON.stringify(options)).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an entitled hook with no purpose asks as it always has — no purpose on the request", async () => {
    mount("fx-1", inPlay, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetchPublicRealtimeToken).mock.calls).toEqual([["fx-1", undefined, undefined]]);
  });

  it("a caller that re-mints its options object every render does NOT re-ask — the purpose is a value, not an object identity", async () => {
    const hook = mount("fx-1", inPlay, false, { realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey: "KEY" });
    await vi.advanceTimersByTimeAsync(0);
    let renders = 0;
    for (let i = 0; i < 3; i++) {
      hook.rerender({ realtimePurpose: OVERLAY_REALTIME_PURPOSE, overlayKey: "KEY" });
      await vi.advanceTimersByTimeAsync(0);
      renders++;
    }
    expect(renders).toBe(3);
    expect(fetchPublicRealtimeToken).toHaveBeenCalledTimes(1);
  });
});

// Owner bug, 2026-10-15: the stream overlay's end card stayed on air after the scorer undid the deciding point. The
// server had reopened the fixture; this hook had stopped listening the moment a poll brought `decided`, so the undo
// never reached the page. The fix listens in THREE tiers, and the expected tier of each status comes from the
// declarations the write path itself reads — LOCKED_FIXTURE_STATUSES (append refuses every write) and
// SETTLED_FIXTURE_STATUSES (settled, not locked: `carried-forward.test.ts` derives it from the fixtures CHECK constraint)
// — never from this hook. Every interval and window below is read from the hook's exported constants, so moving one
// moves its test with it.
//  - open (anything else): listen without limit, at POLL_MS.
//  - settled: listen for SETTLED_LISTEN_MS after the hook first sees it settled, at SETTLED_POLL_MS — a settled ledger
//    still takes an undo, but `decided` is where most matches stay forever (finalizing is manual), so the listen is
//    bounded rather than paid for as long as a result page is open.
//  - locked: never.
type Tier = "open" | "settled" | "locked";
const expectedTier = (status: string): Tier =>
  LOCKED_FIXTURE_STATUSES.has(status) ? "locked" : SETTLED_FIXTURE_STATUSES.has(status) ? "settled" : "open";
const doc = (status: string, headline: string | null = null) =>
  ({ status, summary: headline ? { headline } : null, outcome: status === "decided" ? { kind: "win" } : null }) as LiveFixtureData;
const fetches = () => vi.mocked(fetchLiveFixture).mock.calls.length;
/** The fetches the poll makes across a settled window that started with the hook's own immediate refresh at t=0:
 *  that refresh, plus one per SETTLED_POLL_MS tick that falls strictly INSIDE the window — the tick landing on the
 *  window's last instant is not owed (the window timer was armed first, so it fires first). */
const WINDOW_FETCHES = 1 + Math.ceil(SETTLED_LISTEN_MS / SETTLED_POLL_MS) - 1;

describe("useLiveFixture — listens open, settled-for-a-window, or never (owner bug 2026-10-15 + its load fix)", () => {
  beforeEach(() => {
    // The realtime effect only asks for a token when a Supabase URL is configured (the CI stub host: mints, never dials).
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.co");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("premises: the constants this suite reads are the ones the brief names, and the settled poll is slower than the live one", () => {
    expect(SETTLED_LISTEN_MS, "15 minutes").toBe(15 * 60 * 1000);
    expect(SETTLED_POLL_MS, "60 s").toBe(60 * 1000);
    // Without these the interval tests below cannot tell the two rates apart (a differential needs a difference).
    expect(SETTLED_POLL_MS).toBeGreaterThan(POLL_MS);
    expect(SETTLED_LISTEN_MS).toBeGreaterThan(2 * SETTLED_POLL_MS);
    for (const s of [...LOCKED_FIXTURE_STATUSES, ...SETTLED_FIXTURE_STATUSES]) {
      expect(FIXTURE_STATUSES, `${s} is a fixtures.status`).toContain(s);
    }
    for (const s of LOCKED_FIXTURE_STATUSES) expect(SETTLED_FIXTURE_STATUSES.has(s), `${s}: one tier only`).toBe(false);
  });

  it("every fixture status at mount: open polls at POLL_MS without end, settled at SETTLED_POLL_MS for SETTLED_LISTEN_MS, locked never", async () => {
    const seen: Record<Tier, number> = { open: 0, settled: 0, locked: 0 };
    for (const status of FIXTURE_STATUSES) {
      vi.mocked(fetchLiveFixture).mockReset();
      vi.mocked(fetchPublicRealtimeToken).mockClear();
      vi.mocked(fetchLiveFixture).mockResolvedValue(doc(status));
      const tier = expectedTier(status);
      const hook = mount("fx-1", doc(status), true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetches(), `${status} (${tier}): the mount refresh`).toBe(tier === "locked" ? 0 : 1);
      expect(vi.mocked(fetchPublicRealtimeToken).mock.calls.length, `${status} (${tier}): asks for realtime`).toBe(
        tier === "locked" ? 0 : 1,
      );

      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetches(), `${status} (${tier}): one POLL_MS later`).toBe(tier === "open" ? 2 : tier === "settled" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS - POLL_MS);
      expect(fetches(), `${status} (${tier}): one SETTLED_POLL_MS after mount`).toBe(
        tier === "open" ? 1 + Math.floor(SETTLED_POLL_MS / POLL_MS) : tier === "settled" ? 2 : 0,
      );

      // Past the window, by a margin of several of either interval.
      await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS + 3 * SETTLED_POLL_MS - SETTLED_POLL_MS);
      const atEnd = fetches();
      await vi.advanceTimersByTimeAsync(10 * SETTLED_LISTEN_MS);
      if (tier === "open") {
        expect(fetches() - atEnd, `${status}: an open fixture is still polled at POLL_MS`).toBe((10 * SETTLED_LISTEN_MS) / POLL_MS);
      } else {
        expect(atEnd, `${status} (${tier}): requests over the whole life of the page`).toBe(tier === "settled" ? WINDOW_FETCHES : 0);
        expect(fetches(), `${status} (${tier}): nothing after the window`).toBe(atEnd);
      }
      hook.unmount();
      seen[tier]++;
    }
    // Anti-vacuity: every status was checked, and every tier occurred.
    expect(seen.open + seen.settled + seen.locked).toBe(FIXTURE_STATUSES.length);
    for (const t of ["open", "settled", "locked"] as const) expect(seen[t], `statuses in tier ${t}`).toBeGreaterThan(0);
  });

  it("the sequence: a poll that brings `decided` keeps listening at SETTLED_POLL_MS, so the undo that reopens it is presented", async () => {
    const inPlay = doc("in_play", "10 — 10");
    const decided = doc("decided", "11 — 10");
    const reopened = doc("in_play", "10 — 10");
    vi.mocked(fetchLiveFixture).mockResolvedValue(decided).mockResolvedValueOnce(inPlay).mockResolvedValueOnce(decided);
    const hook = mount("fx-1", inPlay, false);
    await vi.advanceTimersByTimeAsync(0); // mount refresh: in_play
    await vi.advanceTimersByTimeAsync(POLL_MS); // the deciding point arrives
    expect(hook.current.data.status).toBe("decided");
    // The transition re-arms the poll at the settled rate (and refreshes once on re-arming).
    await vi.advanceTimersByTimeAsync(0);
    const afterDecided = fetches();

    vi.mocked(fetchLiveFixture).mockResolvedValue(reopened); // the scorer undoes the deciding point
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetches(), "no poll at the live rate once settled").toBe(afterDecided);
    expect(hook.current.data.status).toBe("decided");
    await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS - POLL_MS);
    // The settled tick brings the undo; reopening re-arms the poll at POLL_MS, which refreshes once on re-arming.
    expect(fetches(), "the settled poll ran, then the reopened re-arm").toBe(afterDecided + 2);
    expect(hook.current.data).toBe(reopened);
  });

  it("an undo INSIDE the window reopens: the poll returns to POLL_MS, with no window, long past where it would have closed", async () => {
    vi.mocked(fetchLiveFixture).mockResolvedValue(doc("decided"));
    const hook = mount("fx-1", doc("decided"), false);
    await vi.advanceTimersByTimeAsync(0);
    // Most of the window gone, then the undo lands on a settled tick.
    const ticksBeforeUndo = Math.floor(SETTLED_LISTEN_MS / SETTLED_POLL_MS) - 2;
    await vi.advanceTimersByTimeAsync((ticksBeforeUndo - 1) * SETTLED_POLL_MS);
    vi.mocked(fetchLiveFixture).mockResolvedValue(doc("in_play"));
    await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS);
    expect(hook.current.data.status, "the undo reached the page").toBe("in_play");

    // Well past where the settled window would have closed: still polled, at the live rate.
    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS);
    const before = fetches();
    await vi.advanceTimersByTimeAsync(4 * POLL_MS);
    expect(fetches() - before, "reopened: polled at POLL_MS with no window").toBe(4);
  });

  it("re-deciding after an undo starts a NEW window, measured from the re-decision", async () => {
    vi.mocked(fetchLiveFixture).mockResolvedValue(doc("decided"));
    const hook = mount("fx-1", doc("decided"), false);
    await vi.advanceTimersByTimeAsync(0);
    const ticks = Math.floor(SETTLED_LISTEN_MS / SETTLED_POLL_MS);
    // The undo, late in the first window.
    await vi.advanceTimersByTimeAsync((ticks - 3) * SETTLED_POLL_MS - SETTLED_POLL_MS);
    vi.mocked(fetchLiveFixture).mockResolvedValue(doc("in_play"));
    await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS);
    expect(hook.current.data.status).toBe("in_play");
    // The re-decision, on the next live tick.
    vi.mocked(fetchLiveFixture).mockResolvedValue(doc("decided"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(hook.current.data.status).toBe("decided");
    await vi.advanceTimersByTimeAsync(0);
    const windowStart = fetches();

    // The FIRST window would have closed by now; the second has not.
    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS - 2 * SETTLED_POLL_MS);
    expect(fetches(), "still listening inside the new window").toBe(windowStart + Math.floor(SETTLED_LISTEN_MS / SETTLED_POLL_MS) - 2);
    // And it closes on its own schedule.
    await vi.advanceTimersByTimeAsync(2 * SETTLED_POLL_MS + 10 * SETTLED_LISTEN_MS);
    const closed = fetches();
    expect(closed - windowStart, "the new window's own polls").toBe(WINDOW_FETCHES - 1);
    await vi.advanceTimersByTimeAsync(10 * SETTLED_LISTEN_MS);
    expect(fetches(), "nothing after the new window").toBe(closed);
  });

  it("a DELAYED overlay: an undo received inside the window but presented after it closes reopens, and the next settle gets a fresh window", async () => {
    // `?delay=` presents what was received delayMs ago, so the tier follows the PRESENTED snapshot and can change after
    // the window has closed. The delay must exceed one settled interval for a received-inside/presented-after undo.
    const delayMs = 2 * SETTLED_POLL_MS;
    expect(delayMs, "premise: a delay the overlay accepts (lib/overlay-delay.ts caps it at 300 000)").toBeLessThanOrEqual(300_000);
    let current = doc("decided");
    vi.mocked(fetchLiveFixture).mockImplementation(async () => current);
    const hook = mount("fx-1", doc("decided"), false, { delayMs });
    // The last settled tick inside the window carries the undo.
    const lastTick = (Math.ceil(SETTLED_LISTEN_MS / SETTLED_POLL_MS) - 1) * SETTLED_POLL_MS;
    await vi.advanceTimersByTimeAsync(lastTick - 1);
    current = doc("in_play");
    await vi.advanceTimersByTimeAsync(1);
    current = doc("decided"); // and every poll after it re-decides
    expect(hook.current.data.status, "received, not yet presented").toBe("decided");

    // The window closes (still presenting `decided`), then the undo is presented: the page listens again.
    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS - lastTick);
    const atClose = fetches();
    const presentedAt = lastTick + delayMs; // a whole number of DRAIN_MS ticks, so presented exactly then
    expect(presentedAt, "premise: presented AFTER the window closed").toBeGreaterThan(SETTLED_LISTEN_MS);
    await vi.advanceTimersByTimeAsync(presentedAt - SETTLED_LISTEN_MS - 1);
    expect(hook.current.data.status).toBe("decided");
    expect(fetches(), "nothing polled between the window closing and the undo presenting").toBe(atClose);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.current.data.status, "the undo, presented after the window closed").toBe("in_play");

    // The re-decision is polled, presented delayMs later, and opens a FRESH window — not the closed one's expiry.
    await vi.advanceTimersByTimeAsync(POLL_MS + delayMs + DRAIN_MS);
    expect(hook.current.data.status).toBe("decided");
    const resettled = fetches();
    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS / 2);
    expect(fetches() - resettled, "a fresh window polls at SETTLED_POLL_MS").toBe(Math.floor(SETTLED_LISTEN_MS / 2 / SETTLED_POLL_MS));
    await vi.advanceTimersByTimeAsync(10 * SETTLED_LISTEN_MS);
    const closed = fetches();
    await vi.advanceTimersByTimeAsync(10 * SETTLED_LISTEN_MS);
    expect(fetches(), "and it closes too").toBe(closed);
  });

  it("the negative pair: a poll that brings `finalized` stops the poll at once — a locked fixture costs nothing", async () => {
    const inPlay = doc("in_play");
    vi.mocked(fetchLiveFixture).mockResolvedValueOnce(doc("finalized")).mockResolvedValue(inPlay);
    const hook = mount("fx-1", inPlay, false);
    await vi.advanceTimersByTimeAsync(0); // mount refresh brings `finalized`
    expect(hook.current.data.status).toBe("finalized");
    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS * 2);
    expect(fetches(), "no poll after `finalized`").toBe(1);
  });

  it("an UNKNOWN status fails open — listened to like an open fixture — and is logged once, not per poll", async () => {
    const odd = "postponed_by_a_newer_server";
    expect(FIXTURE_STATUSES as readonly string[], "premise: really unknown").not.toContain(odd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(fetchLiveFixture).mockResolvedValue(doc(odd));
      const hook = mount("fx-1", doc(odd), false);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS * 2);
      expect(fetches(), "polled at POLL_MS, past any settled window").toBe(1 + (SETTLED_LISTEN_MS * 2) / POLL_MS);
      hook.unmount();
      mount("fx-2", doc(odd), false);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      const mentions = warn.mock.calls.filter((c) => String(c[0]).includes(odd));
      expect(mentions.length, "one warning for the status, however many renders and hooks saw it").toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// The realtime half of the window: a SUBSCRIBED channel is a Realtime connection held against the plan's quota, so it
// must survive the settled transition (an undo must still arrive at once) and close when the window does. The browser
// client is faked at its module boundary; everything above it — the token, the subscribe status, the teardown — is the
// hook's own code.
describe("useLiveFixture — a subscribed channel lives through the settled window and closes with it", () => {
  beforeEach(() => {
    rt.subscribes = 0;
    rt.unsubscribes = 0;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.mocked(fetchPublicRealtimeToken).mockResolvedValue({ token: "t", channel: "fixture:fx-1" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(fetchPublicRealtimeToken).mockRejectedValue(new Error("not entitled"));
  });

  it("open → settled keeps ONE channel (no re-mint, no re-subscribe); the window's end unsubscribes and stops the poll", async () => {
    let current = doc("in_play");
    vi.mocked(fetchLiveFixture).mockImplementation(async () => current);
    const hook = mount("fx-1", doc("in_play"), true);
    // The token and the client import resolve on REAL turns (module loading is not on the fake clock).
    for (let i = 0; i < 100 && rt.subscribes === 0; i++) await new Promise((r) => realSetTimeout(r, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.subscribes, "subscribed at mount").toBe(1);
    expect(hook.current.transport).toBe("realtime");

    current = doc("decided");
    await vi.advanceTimersByTimeAsync(SUBSCRIBED_POLL_MS); // the safety-net poll brings `decided`
    expect(hook.current.data.status).toBe("decided");
    expect(hook.current.transport, "still on realtime while settled").toBe("realtime");
    expect(rt.subscribes, "the settled transition does not re-subscribe").toBe(1);
    expect(rt.unsubscribes).toBe(0);
    expect(vi.mocked(fetchPublicRealtimeToken).mock.calls.length, "no second token mint").toBe(1);

    await vi.advanceTimersByTimeAsync(SETTLED_LISTEN_MS);
    expect(rt.unsubscribes, "the window's end closes the channel").toBe(1);
    expect(hook.current.transport).toBe("poll");
    const closed = fetches();
    await vi.advanceTimersByTimeAsync(10 * SETTLED_LISTEN_MS);
    expect(fetches(), "and nothing polls after it").toBe(closed);
    expect(rt.subscribes, "nor re-subscribes").toBe(1);
  });
});
