// Spectator surface W2, Task 7 — `useLiveCompetition`'s own transport
// contract. Lifted from W1's `useLiveFixture`
// (`match-centre/use-live-fixture.ts`, and its own
// `match-centre/__tests__/use-live-fixture.test.ts`, which this test's shape
// follows) with three differences (dispatch ruling 4 / brief step 3):
//   - the poll refresh is `fetchCompetitionHub`, not a single-fixture fetch;
//   - the interval cadence depends on whether ANY match on the document is
//     live (HUB_POLL_MS / HUB_IDLE_POLL_MS) and is re-armed when that flips —
//     unlike a single fixture, the hub's poll is never switched off entirely,
//     because an UPCOMING match can start between ticks;
//   - realtime subscribes one channel PER DIVISION with a live match
//     (`division:{id}`, no token) — the slideshow's shape
//     (`v2/slideshow.tsx:105-140`), not W1's private per-fixture channel.
//
// Driven the same way `use-live-fixture.test.ts` drives its hook: the shared
// `_hook-harness` (`renderIsland`) with fake timers and the data module
// mocked. `fetchCompetitionHub`'s own URL/unwrap contract is pinned
// separately in `competition-hub-data.test.ts` (ruling 3) — mocking it here
// would make an assertion on fetch's call shape pass with the URL spelled any
// way at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type {
  CompetitionHubDocT,
  HubMatchT,
  MatchBucketSchemaT,
} from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";

vi.mock("../competition-hub-data", () => ({
  fetchCompetitionHub: vi.fn(),
}));

// One fake Supabase client for the realtime branch. `channel()` records the
// name it was asked for and hands back a chainable stub whose `on()` calls
// capture the handlers, so a test can FIRE a broadcast rather than assert that
// a listener was merely registered — registering a handler nothing ever calls
// is the shape this repo keeps shipping.
const rt = vi.hoisted(() => {
  interface FakeChannel {
    name: string;
    handlers: Record<string, (message?: unknown) => void>;
    unsubscribed: number;
    on: (kind: string, opts: { event: string }, fn: (message?: unknown) => void) => FakeChannel;
    subscribe: (cb: (status: string) => void) => FakeChannel;
    unsubscribe: () => void;
  }
  const channels: FakeChannel[] = [];
  let status = "SUBSCRIBED";
  // PER-NAME overrides. A single module-level `status` can only make every
  // channel succeed or every channel fail together, which is precisely the
  // fixture the mixed-outcome defect (one division up, one down) hid behind.
  let statusByName: Record<string, string> = {};
  const channel = (name: string): FakeChannel => {
    const ch: FakeChannel = {
      name,
      handlers: {},
      unsubscribed: 0,
      on(_kind, opts, fn) {
        ch.handlers[opts.event] = fn;
        return ch;
      },
      subscribe(cb) {
        cb(statusByName[name] ?? status);
        return ch;
      },
      unsubscribe() {
        ch.unsubscribed += 1;
      },
    };
    channels.push(ch);
    return ch;
  };
  return {
    channels,
    channel,
    reset: (nextStatus = "SUBSCRIBED") => {
      channels.length = 0;
      status = nextStatus;
      statusByName = {};
    },
    /** One channel's status, by channel name — the rest keep the default. */
    setStatusFor: (name: string, s: string) => {
      statusByName[name] = s;
    },
  };
});

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({ channel: rt.channel }),
}));

import { fetchCompetitionHub } from "../competition-hub-data";
import {
  HUB_IDLE_POLL_MS,
  HUB_POLL_MS,
  HUB_PUSH_RETRY_MS,
  useLiveCompetition,
  type UseLiveCompetitionResult,
} from "../use-live-competition";

function baseHeader(overrides: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: true,
    status: "in_play",
    sides: [
      { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
      { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
    ],
    scoreLines: ["1-0", null],
    subLines: [null, null],
    battingIndex: null,
    statusLine: null,
    rateLine: null,
    phase: null,
    strength: null,
    pillNote: null,
    metaLine: null,
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function matchWith(
  bucket: MatchBucketSchemaT,
  live: string,
  divisionId = "d1",
  fixtureId = "f1",
): HubMatchT {
  return {
    fixtureId,
    divisionId,
    divisionSlug: "div-a",
    divisionName: "Division A",
    sportKey: "cricket",
    stageName: "League",
    roundNo: 1,
    roundLabel: null,
    bucket,
    tz: "Europe/London",
    scheduledAt: null,
    venueName: null,
    courtName: null,
    href: "/riverside/autumn-cup/div-a/fixtures/f1",
    header: baseHeader({ scoreLines: [live, null] }),
    winnerIndex: null,
    resultLine: null,
  };
}

function docWith(
  opts: {
    live?: string;
    pts?: string;
    bucket?: MatchBucketSchemaT;
    divisionId?: string;
    /** Whole-list override, for the multi-division realtime cases. */
    matches?: HubMatchT[];
  } = {},
): CompetitionHubDocT {
  return {
    competitionId: "c1",
    orgSlug: "riverside",
    competitionSlug: "autumn-cup",
    name: "Autumn Cup",
    orgName: "Riverside SC",
    branded: false,
    realtime: true,
    locale: "en",
    generatedAt: "2026-09-05T12:00:00.000Z",
    divisions: [],
    matches: opts.matches ?? [matchWith(opts.bucket ?? "live", opts.live ?? "1-0", opts.divisionId)],
    tables: [
      {
        id: "t1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        caption: "League table",
        columns: [{ key: "pts", abbr: "Pts", title: "Points", compact: true }],
        rows: [
          {
            rank: 1,
            entrantId: "e1",
            name: "Blue Blazers",
            badgeUrl: null,
            colour: null,
            cells: [opts.pts ?? "3"],
            tieBreakText: null,
            champion: false,
          },
        ],
        updatedAt: "2026-09-05T12:00:00.000Z",
        fullHref: "/riverside/autumn-cup/div-a?tab=table",
      },
    ],
    knockouts: [],
    leaders: [],
    teams: [],
    info: {
      startsOn: null,
      endsOn: null,
      venues: [],
      registrationOpen: false,
      registerHref: "/riverside/autumn-cup/register",
      calendars: [],
      presentHref: "/riverside/autumn-cup/present",
    },
    tabs: ["overview", "matches", "table", "info"],
  };
}

function mount(orgSlug: string, competitionSlug: string, initial: CompetitionHubDocT, realtime: boolean) {
  let latest!: UseLiveCompetitionResult;
  function Probe(props: {
    orgSlug: string;
    competitionSlug: string;
    initial: CompetitionHubDocT;
    realtime: boolean;
    onReady: (r: UseLiveCompetitionResult) => void;
  }) {
    const result = useLiveCompetition(props);
    props.onReady(result);
    return `${result.doc.matches[0]?.header.scoreLines[0] ?? ""} ${
      result.doc.tables[0]?.rows[0]?.cells.at(-1) ?? ""
    }`;
  }
  const island = renderIsland(Probe, { orgSlug, competitionSlug, initial, realtime, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
    },
    text: () => island.text(),
    unmount: () => island.unmount(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  // `resetAllMocks`, not `clearAllMocks`. `clearAllMocks` runs `mockClear()`
  // — calls and results only — so a persistent `mockResolvedValue(...)` set
  // inside one test survived into every later test in the file. Nothing
  // depended on it today, but that is a property of the current ORDER: moving
  // a test, or inserting one between two others, would have changed
  // behaviour with nothing to say so. Resetting the implementations too makes
  // each test state its own.
  vi.resetAllMocks();
});

describe("useLiveCompetition", () => {
  it("polls the hub endpoint and replaces the WHOLE document on each tick (a card's score and a table row both move)", async () => {
    const initial = docWith({ live: "1-0", pts: "3" });
    vi.mocked(fetchCompetitionHub).mockResolvedValueOnce(docWith({ live: "2-0", pts: "6" }));
    const hook = mount("o", "c", initial, false);
    expect(hook.text()).toContain("1-0");
    expect(hook.text()).toContain("3"); // positive pair: unchanged before the tick

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchCompetitionHub).toHaveBeenCalledWith("o", "c");
    expect(hook.text()).toContain("2-0");
    expect(hook.text()).toContain("6");
  });

  it("a failed poll keeps the last document (never throws to the UI)", async () => {
    const initial = docWith({ live: "1-0", pts: "3" });
    vi.mocked(fetchCompetitionHub).mockRejectedValueOnce(new Error("offline"));
    const hook = mount("o", "c", initial, false);

    await expect(vi.advanceTimersByTimeAsync(HUB_POLL_MS)).resolves.not.toThrow();
    expect(hook.text()).toContain("1-0");
    expect(hook.text()).toContain("3");
  });

  it("with a live match the interval is HUB_POLL_MS; with none it is HUB_IDLE_POLL_MS (positive pair)", () => {
    const spy = vi.spyOn(global, "setInterval");

    mount("o", "c", docWith({ bucket: "live" }), false);
    expect(spy.mock.calls.some(([, ms]) => ms === HUB_POLL_MS)).toBe(true);
    expect(spy.mock.calls.some(([, ms]) => ms === HUB_IDLE_POLL_MS)).toBe(false);

    spy.mockClear();
    mount("o", "c", docWith({ bucket: "completed" }), false);
    expect(spy.mock.calls.some(([, ms]) => ms === HUB_IDLE_POLL_MS)).toBe(true);
    expect(spy.mock.calls.some(([, ms]) => ms === HUB_POLL_MS)).toBe(false);

    spy.mockRestore();
  });

  it("HUB_POLL_MS equals W1's POLL_MS — one poll cadence for the whole surface", async () => {
    const { POLL_MS } = await import("../match-centre/use-live-fixture");
    expect(HUB_POLL_MS).toBe(POLL_MS);
  });

  // The cadence test above mounts two SEPARATE hooks, one per state, so it can
  // only witness the delay each was BORN with. Dropping `hasLive` from the
  // poll effect's dependency list left it green: an instance that starts live
  // and goes idle would have kept polling every 15s forever, and nothing said
  // so. A transition needs ONE instance driven across the boundary.
  it("re-arms the interval when the live set flips on a live instance (both directions)", async () => {
    const spy = vi.spyOn(global, "setInterval");

    // live → idle
    vi.mocked(fetchCompetitionHub).mockResolvedValueOnce(docWith({ bucket: "completed" }));
    mount("o", "c", docWith({ bucket: "live" }), false);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_POLL_MS);
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_IDLE_POLL_MS);

    // idle → live, the direction a spectator actually cares about: a fixture
    // starts between ticks and the page must speed up on its own.
    spy.mockClear();
    vi.mocked(fetchCompetitionHub).mockResolvedValueOnce(docWith({ bucket: "live" }));
    mount("o", "c", docWith({ bucket: "completed" }), false);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_IDLE_POLL_MS);
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_POLL_MS);

    spy.mockRestore();
  });

  // R10 C1: a refetch response never replaces a NEWER document. Refetches
  // overlap: the safety poll, a push's refetch and its H3 retries each fetch on
  // their own clock. Whichever response lands LAST used to win, so a slow
  // response built before a faster one put the older scores back on the page.
  describe("a refetch never replaces a NEWER document (R10 C1)", () => {
    const HELD_AT = "2026-09-05T12:00:00.000Z"; // docWith's own generatedAt
    const OLDER_AT = "2026-09-05T12:00:10.000Z";
    const NEWER_AT = "2026-09-05T12:00:20.000Z";
    const BEFORE_HELD_AT = "2026-09-05T11:59:59.999Z";

    const builtAt = (generatedAt: string, live: string): CompetitionHubDocT => ({
      ...docWith({ live }),
      generatedAt,
    });

    function deferred() {
      let resolve!: (doc: CompetitionHubDocT) => void;
      const promise = new Promise<CompetitionHubDocT>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    /** Two poll ticks whose fetches are both still in flight: they overlap. */
    async function twoOverlappingRefetches() {
      const first = deferred();
      const second = deferred();
      vi.mocked(fetchCompetitionHub)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValue(new Promise<CompetitionHubDocT>(() => {}));
      const hook = mount("o", "c", builtAt(HELD_AT, "1-0"), false);
      await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
      await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
      expect(fetchCompetitionHub, "two refetches in flight at once").toHaveBeenCalledTimes(2);
      return { hook, first, second };
    }

    it("the OLDER response landing LAST is dropped: the page keeps the newer document", async () => {
      const { hook, first, second } = await twoOverlappingRefetches();

      second.resolve(builtAt(NEWER_AT, "3-0"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.text()).toContain("3-0");

      first.resolve(builtAt(OLDER_AT, "2-0"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.text(), "an older response replaced the newer document").toContain("3-0");
      expect(hook.text()).not.toContain("2-0");
      expect(hook.current.doc.generatedAt).toBe(NEWER_AT);
    });

    it("positive pair: the NEWER response landing LAST is applied", async () => {
      const { hook, first, second } = await twoOverlappingRefetches();

      first.resolve(builtAt(OLDER_AT, "2-0"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.text(), "a response newer than the held document was dropped").toContain("2-0");

      second.resolve(builtAt(NEWER_AT, "3-0"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.text()).toContain("3-0");
      expect(hook.current.doc.generatedAt).toBe(NEWER_AT);
    });

    it("a document built at the SAME instant as the one held is applied; one built before the SERVER-RENDERED document is not", async () => {
      vi.mocked(fetchCompetitionHub)
        .mockResolvedValueOnce(builtAt(HELD_AT, "4-4"))
        .mockResolvedValueOnce(builtAt(BEFORE_HELD_AT, "0-9"));
      const hook = mount("o", "c", builtAt(HELD_AT, "1-0"), false);

      await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
      expect(hook.text(), "an equally new document was dropped").toContain("4-4");

      await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
      expect(hook.text(), "a document older than the page's own replaced it").toContain("4-4");
      expect(hook.text()).not.toContain("0-9");
    });
  });
});

// The realtime branch had NO test at all: deleting the unsubscribe in the
// cleanup left the suite green. It is the half of the transport a spectator
// notices most — a score that lands in under a second instead of within
// fifteen — and the half nothing else covers.
describe("useLiveCompetition realtime", () => {
  const ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    rt.reset();
  });
  afterEach(() => {
    if (ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV;
  });

  const twoLiveDivisions = () =>
    docWith({
      matches: [
        matchWith("live", "1-0", "d1", "f1"),
        matchWith("live", "0-0", "d2", "f2"),
        matchWith("upcoming", "", "d3", "f3"),
      ],
    });

  it("subscribes ONE channel per division that has a live match, and none for a division that does not", async () => {
    mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0); // the client is imported dynamically

    expect(rt.channels.map((c) => c.name).sort()).toEqual(["division:d1", "division:d2"]);
    // d3 has only an upcoming match — a channel for it would be a subscription
    // nothing can ever push to.
    expect(rt.channels.some((c) => c.name === "division:d3")).toBe(false);
  });

  it("both broadcast events reach the debounced refresh, and rapid pushes collapse into ONE fetch", async () => {
    mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetchCompetitionHub).mockResolvedValue(twoLiveDivisions());

    const ch = rt.channels[0]!;
    expect(Object.keys(ch.handlers).sort()).toEqual(["schedule_changed", "state_changed"]);

    ch.handlers.state_changed!();
    ch.handlers.schedule_changed!();
    ch.handlers.state_changed!();
    expect(fetchCompetitionHub).not.toHaveBeenCalled(); // still inside the 250ms window

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchCompetitionHub).toHaveBeenCalledTimes(1);
  });

  it("every channel is unsubscribed on unmount", async () => {
    const hook = mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    expect(rt.channels.every((c) => c.unsubscribed === 0)).toBe(true);

    hook.unmount();
    expect(rt.channels.every((c) => c.unsubscribed === 1)).toBe(true);
  });

  // Driven by a BROADCAST, not a poll tick. Once a channel reports SUBSCRIBED
  // the polling effect returns early, so there is no interval to advance —
  // the first version of this test drove the change through a tick that never
  // fires and read the resulting no-op as a missing unsubscribe.
  async function pushAndSettle(ch: (typeof rt.channels)[number]) {
    ch.handlers.state_changed!();
    await vi.advanceTimersByTimeAsync(250); // the debounce, then the refresh
    await vi.advanceTimersByTimeAsync(0); // the new effect's dynamic import
  }

  it("when the live division set CHANGES the old channels are torn down and the new set subscribed", async () => {
    vi.mocked(fetchCompetitionHub).mockResolvedValueOnce(
      docWith({ matches: [matchWith("live", "2-0", "d2", "f2")] }),
    );
    mount("o", "c", docWith({ matches: [matchWith("live", "1-0", "d1", "f1")] }), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels.map((c) => c.name)).toEqual(["division:d1"]);

    await pushAndSettle(rt.channels[0]!);

    expect(rt.channels[0]!.unsubscribed).toBe(1); // d1 let go
    expect(rt.channels.map((c) => c.name)).toEqual(["division:d1", "division:d2"]);
    expect(rt.channels[1]!.unsubscribed).toBe(0); // d2 still open
  });

  it("an unchanged live set across a refresh does NOT resubscribe (the string key, not the array)", async () => {
    vi.mocked(fetchCompetitionHub).mockResolvedValue(twoLiveDivisions());
    mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);

    // `doc.matches` gets a fresh array identity on every refresh. Keying the
    // effect on it would tear down and resubscribe both channels each time,
    // which on a busy division is a websocket churning once a second.
    await pushAndSettle(rt.channels[0]!);
    expect(rt.channels).toHaveLength(2);
    expect(rt.channels.every((c) => c.unsubscribed === 0)).toBe(true);
  });

  it("realtime={false} subscribes nothing and the transport stays 'poll' (positive pair with the cases above)", async () => {
    const hook = mount("o", "c", twoLiveDivisions(), false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(0);
    expect(hook.current.transport).toBe("poll");
  });

  it("a channel that never reaches SUBSCRIBED leaves the transport polling", async () => {
    rt.reset("CHANNEL_ERROR");
    const hook = mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    expect(hook.current.transport).toBe("poll");
  });

  // The POSITIVE pair for the two `toBe("poll")` assertions above. Without it
  // `transport` could be the string literal "poll" and this whole suite stays
  // green — and `transport` is the value a consumer draws the Live/Updating
  // indicator from, so the indicator could never be proven to appear at all.
  it("every channel SUBSCRIBED reports transport 'realtime'", async () => {
    const hook = mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    expect(hook.current.transport).toBe("realtime");
  });

  // The cadence once realtime is up. It used to STOP polling here
  // (`if (subscribed) return`). R10 H2 keeps a safety-net poll at
  // HUB_IDLE_POLL_MS instead: a subscribed channel that misses ONE push, or
  // whose refetch reads a stale copy (measured on spectw2), otherwise leaves the
  // page frozen until the spectator reloads. `use-live-fixture.ts` learned the
  // same lesson in PR #782.
  //
  // Both halves are pinned, because each kills a different mutant:
  // - nothing at HUB_POLL_MS: the live 15s cadence must not run ON TOP of
  //   realtime, which is double load on `/hub` for every spectator on a busy
  //   competition;
  // - exactly one fetch by HUB_IDLE_POLL_MS: the poll has not stopped.
  // The document HAS live matches, so the slower cadence comes from the
  // subscription, not from `hasLive`.
  it("keeps a SAFETY-NET poll: no fetch at HUB_POLL_MS, exactly one by HUB_IDLE_POLL_MS", async () => {
    vi.mocked(fetchCompetitionHub).mockResolvedValue(twoLiveDivisions());
    const hook = mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.current.transport).toBe("realtime");
    expect(fetchCompetitionHub).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchCompetitionHub, "the live cadence ran on top of realtime").not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - HUB_POLL_MS);
    expect(fetchCompetitionHub, "no safety-net poll while subscribed").toHaveBeenCalledTimes(1);
    expect(fetchCompetitionHub).toHaveBeenCalledWith("o", "c");
  });

  // MIXED outcomes — the case a single shared `subscribed` boolean cannot
  // represent. All N channels wrote it and the last writer won, so on a hub
  // with live matches in two divisions the hook reported whichever callback
  // fired last. Both orders are wrong and only ONE of them is fatal, which is
  // why both are here: with `division:d1` failing, `division:d2`'s SUBSCRIBED
  // landed last, `subscribed` went true, the poll effect returned early — and
  // d1 has no channel pushing to it, so its live scores froze on the page
  // until the spectator reloaded. (With `division:d2` failing instead, the
  // last writer said false, so the poll survived and only the indicator lied;
  // the old code passes that row, which is exactly why a single-order fixture
  // would not have caught this.)
  //
  // Supabase re-invokes the status callback on a later CHANNEL_ERROR /
  // TIMED_OUT / CLOSED as well, so this is a mid-match failure mode, not only
  // a startup race.
  for (const failing of ["division:d1", "division:d2"] as const) {
    it(`${failing} CHANNEL_ERROR with the other SUBSCRIBED stays on 'poll', and keeps polling`, async () => {
      rt.setStatusFor(failing, "CHANNEL_ERROR");
      vi.mocked(fetchCompetitionHub).mockResolvedValue(twoLiveDivisions());
      const hook = mount("o", "c", twoLiveDivisions(), true);
      await vi.advanceTimersByTimeAsync(0);

      // Both were attempted — this is a mixed outcome, not a missing channel.
      expect(rt.channels.map((c) => c.name).sort()).toEqual(["division:d1", "division:d2"]);
      expect(hook.current.transport).toBe("poll");

      // The half that actually matters to a spectator: the poll is the only
      // thing left covering the division whose channel is down.
      expect(fetchCompetitionHub).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
      expect(fetchCompetitionHub).toHaveBeenCalledWith("o", "c");
    });
  }

  // R10 H3: a push is not satisfied by an OLDER document. Each division
  // broadcast carries `at`, the server's clock at publish (`lib/realtime.ts`
  // `publishDivisionUpdate`), and the hub document carries `generatedAt`.
  // Measured on spectw2: the push arrived, its one debounced refetch came back
  // with a `generatedAt` from BEFORE the write, and the Knockout tab never
  // moved. `no-store` (H1) removes the browser's copy. A Redis or CDN copy that
  // outlives the write is an ordering no local test can produce, so the hook
  // itself refuses to treat such a document as the answer.
  describe("a push is not satisfied by an OLDER document (R10 H3)", () => {
    const SEEDED_AT = "2026-09-05T12:00:00.000Z";
    const PUSH_AT = "2026-09-05T12:00:05.000Z";
    const BEFORE_PUSH = "2026-09-05T12:00:04.999Z";
    const AFTER_PUSH = "2026-09-05T12:00:05.001Z";
    const LATER_PUSH = "2026-09-05T12:00:06.000Z";
    const AFTER_LATER_PUSH = "2026-09-05T12:00:06.001Z";

    /** What supabase-js hands an `on("broadcast")` callback: the whole
     *  broadcast, with the producer's own fields under `payload` (phoenix
     *  `bind.callback(handledPayload)`; realtime-js passes a broadcast through
     *  its payload transform unchanged). */
    const broadcast = (payload: Record<string, unknown>) => ({ type: "broadcast", event: "state_changed", payload });
    const pushAt = (at: string) => broadcast({ v: 1, reason: "score", at });

    /** The same two live divisions every time (so the channels never churn),
     *  built at `generatedAt`, with d1's score line set to `score`. */
    const builtAt = (generatedAt: string, score = "1-0"): CompetitionHubDocT => ({
      ...docWith({
        matches: [
          matchWith("live", score, "d1", "f1"),
          matchWith("live", "0-0", "d2", "f2"),
          matchWith("upcoming", "", "d3", "f3"),
        ],
      }),
      generatedAt,
    });

    const fetches = () => vi.mocked(fetchCompetitionHub).mock.calls.length;

    /** Run the clock to 1ms short of the safety-net poll, which is armed at
     *  subscription (t=0, H2) and is a fetch of its own. `elapsed` is the time
     *  the test has already advanced since subscribing. */
    const toJustBeforeSafetyPoll = (elapsed: number) => vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - elapsed - 1);

    async function subscribedHub() {
      const hook = mount("o", "c", builtAt(SEEDED_AT), true);
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.current.transport).toBe("realtime");
      expect(fetches()).toBe(0);
      return { hook, channel: rt.channels[0]! };
    }

    it("the retry delays are the ruling's: 1s, then 3s", () => {
      expect(HUB_PUSH_RETRY_MS).toEqual([1_000, 3_000]);
    });

    it("an older document refetches after 1s, then 3s after that, then STOPS: two retries at most", async () => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(BEFORE_PUSH));
      const { channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches(), "the debounced refetch").toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetches(), "retried before 1s had passed").toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetches(), "no first retry 1s after the refetch").toBe(2);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetches(), "retried again before 3s had passed").toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetches(), "no second retry 3s after the first").toBe(3);

      await toJustBeforeSafetyPoll(4_250);
      expect(fetches(), "a third retry").toBe(3);
    });

    it("the retry's NEWER document is what the page shows, and it ends the sequence", async () => {
      vi.mocked(fetchCompetitionHub)
        .mockResolvedValueOnce(builtAt(BEFORE_PUSH, "1-0"))
        .mockResolvedValueOnce(builtAt(AFTER_PUSH, "2-0"))
        .mockResolvedValue(builtAt(AFTER_PUSH, "9-9"));
      const { hook, channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches()).toBe(1);
      expect(hook.text()).not.toContain("2-0");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetches()).toBe(2);
      expect(hook.text()).toContain("2-0");

      await toJustBeforeSafetyPoll(1_250);
      expect(fetches(), "retried after a document as new as the push").toBe(2);
      expect(hook.text()).toContain("2-0");
    });

    it.each([
      ["built AFTER the push", AFTER_PUSH],
      ["built AT the push's own instant", PUSH_AT],
    ])("a document %s satisfies it: one refetch, no retry", async (_label, generatedAt) => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(generatedAt));
      const { channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches()).toBe(1);
      await toJustBeforeSafetyPoll(250);
      expect(fetches()).toBe(1);
    });

    it.each([
      ["no message at all", undefined],
      ["a payload with no `at`", broadcast({ v: 1, reason: "score" })],
      ["an unparseable `at`", broadcast({ v: 1, reason: "score", at: "not a date" })],
      ["an `at` that is not an ISO string", broadcast({ v: 1, reason: "score", at: Date.parse(PUSH_AT) })],
    ])("%s: today's single refetch, even though the document is older than the push", async (_label, message) => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(BEFORE_PUSH));
      const { channel } = await subscribedHub();

      channel.handlers.state_changed!(message);
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches()).toBe(1);
      await toJustBeforeSafetyPoll(250);
      expect(fetches()).toBe(1);
    });

    it("unmount cancels a pending retry", async () => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(BEFORE_PUSH));
      const { hook, channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches()).toBe(1);

      hook.unmount();
      await vi.advanceTimersByTimeAsync(HUB_PUSH_RETRY_MS[0] + HUB_PUSH_RETRY_MS[1] + 1_000);
      expect(fetches(), "a retry fired after unmount").toBe(1);
    });

    it("unmount inside the debounce window fetches nothing", async () => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(BEFORE_PUSH));
      const { hook, channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      hook.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetches(), "the debounced refetch fired after unmount").toBe(0);
    });

    it("a newer push restarts the sequence: the earlier push's pending retry never fires", async () => {
      vi.mocked(fetchCompetitionHub).mockResolvedValue(builtAt(BEFORE_PUSH));
      const { channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT)); // t=0
      await vi.advanceTimersByTimeAsync(250); // t=250
      expect(fetches(), "the first push's refetch; its retry is due at t=1250").toBe(1);

      await vi.advanceTimersByTimeAsync(500); // t=750
      channel.handlers.state_changed!(pushAt(LATER_PUSH));
      await vi.advanceTimersByTimeAsync(250); // t=1000
      expect(fetches(), "the newer push's own refetch").toBe(2);

      await vi.advanceTimersByTimeAsync(250); // t=1250
      expect(fetches(), "the FIRST push's retry still fired").toBe(2);

      await vi.advanceTimersByTimeAsync(750); // t=2000
      expect(fetches(), "the newer push's first retry").toBe(3);
      await vi.advanceTimersByTimeAsync(3_000); // t=5000
      expect(fetches(), "the newer push's second retry").toBe(4);

      await toJustBeforeSafetyPoll(5_000);
      expect(fetches()).toBe(4);
    });

    it("a newer push while the previous refetch is IN FLIGHT: that response, older when it lands, schedules no retry", async () => {
      let answerFirst: ((doc: CompetitionHubDocT) => void) | undefined;
      vi.mocked(fetchCompetitionHub)
        .mockImplementationOnce(
          () =>
            new Promise<CompetitionHubDocT>((resolve) => {
              answerFirst = resolve;
            }),
        )
        .mockResolvedValue(builtAt(AFTER_LATER_PUSH));
      const { channel } = await subscribedHub();

      channel.handlers.state_changed!(pushAt(PUSH_AT));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches(), "the first refetch, still in flight").toBe(1);

      channel.handlers.state_changed!(pushAt(LATER_PUSH));
      await vi.advanceTimersByTimeAsync(250);
      expect(fetches(), "the newer push's refetch, which satisfies it").toBe(2);

      // The superseded answer lands last, older than the push it was fetched for.
      answerFirst!(builtAt(BEFORE_PUSH));
      await toJustBeforeSafetyPoll(500);
      expect(fetches(), "the superseded refetch scheduled a retry").toBe(2);
    });
  });

  // W1's `use-live-fixture.ts:23-28` rules that freshness derives from the
  // DOCUMENT's own timestamp, never a hook-side clock: a `Date.now()`
  // re-stamped on every successful poll reports the FETCH as freshness, so a
  // hub whose scores had not moved for an hour reads "Updated 0s ago" — and
  // seeding it from `Date.now()` hydration-mismatches, because SSR and the
  // client run that initialiser separately. This hook shipped exactly that
  // field with zero assertions anywhere. Pinning the whole return shape,
  // rather than only the absence of one name, so a future clock cannot arrive
  // under a different one either.
  it("the hook returns NO clock of its own — { doc, transport } and nothing else", async () => {
    const hook = mount("o", "c", twoLiveDivisions(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(hook.current).sort()).toEqual(["doc", "transport"]);
  });
});
