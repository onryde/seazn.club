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

import { fetchCompetitionHub } from "../competition-hub-data";
import {
  HUB_IDLE_POLL_MS,
  HUB_POLL_MS,
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
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function matchWith(bucket: MatchBucketSchemaT, live: string, divisionId = "d1"): HubMatchT {
  return {
    fixtureId: "f1",
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
  opts: { live?: string; pts?: string; bucket?: MatchBucketSchemaT; divisionId?: string } = {},
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
    matches: [matchWith(opts.bucket ?? "live", opts.live ?? "1-0", opts.divisionId)],
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
            cells: [opts.pts ?? "3"],
            tieBreakText: null,
            champion: false,
          },
        ],
        updatedAt: "2026-09-05T12:00:00.000Z",
        fullHref: "/riverside/autumn-cup/div-a?tab=table",
      },
    ],
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
  vi.clearAllMocks();
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
});
