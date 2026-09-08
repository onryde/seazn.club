// Spectator surface W2, Task 1 — the pure Matches-hub ladders and the landing
// status line. Everything under test here is pure and client-safe, so this file
// is the whole story for these functions: `apps/web` vitest is
// `environment: "node"`, and the surfaces that RENDER them are covered by the
// later W2 tasks' own e2e.
//
// Two habits this file keeps deliberately, both from the programme rules:
//   • EVERY ladder states its EMPTY case first. An empty input satisfies a
//     contains-style ladder vacuously — "no fixtures" must be asserted to land
//     somewhere on purpose, not to fall through to the default by accident.
//   • Every ordering test is ORDER-DIFFERENTIAL: the expected output differs
//     from what the wrong rung order would produce. A ladder whose cases each
//     supply exactly one candidate proves nothing about the order.
//
// Mutation sweep, 2026-09-08 — 24 mutants applied one at a time and restored;
// 24 killed, 0 survivors, with `numTotalTests` pinned at 41 for every run so a
// mutant that failed to parse could not read as a survivor. Each line names the
// mutant and the test that caught it:
//    1 filter: swap live/upcoming rungs ....... "live wins over upcoming…"
//    2 filter: delete the empty rung .......... "EMPTY: no matches at all"
//    3 bucketFixture: always "upcoming" ....... the status-map case
//    4 bucketFixture: drop the in_play rung ... the status-map case
//    5 dayKeyInZone: drop the zone fallback ... "unknown zone falls back to UTC"
//    6 dayKeyInZone: drop the NaN guard ....... "an unparseable instant is null"
//    7 groupByDay: unscheduled FIRST .......... both grouping-order cases
//    8 groupByDay: group in UTC, not the item's zone .. the Kolkata/London case
//    9 sort: drop the completed descending branch ..... both completed cases
//   10 sort: naive +Infinity sentinel ......... "unscheduled COMPLETED last"
//   11 sort: drop the bucket RANK ordering .... the main ordering case
//   12 sort: sort in place .................... "does not mutate its input"
//   13 tabs: emit the reserved "gallery" ...... 3 cases
//   14 tabs: swap table and stats ............. the full-order case
//   15 tabs: stats unconditional .............. EMPTY + the zero-rows case
//   16 landing: test `next` BEFORE `live` ..... "live outranks a nearer upcoming"
//   17 landing: delete the empty rung ......... both EMPTY cases
//   18 landing: drop the `ahead of now` filter  "next = the EARLIEST…" + overdue
//   19 landing: drop `matches.length > 0` from `finished` .... both dates cases
//   20 landing: hard-code the live count to 1 . "live counts every live fixture"
//   21 drift: rename an id in HUB_TAB_IDS ..... the tab drift case
//   22 drift: rename a bucket in MatchBucketSchema ... the bucket drift case
//   23 drift: rename an id in CompetitionHubTabId .... the tab drift case
//   24 probe: drop a status from STATUSES below ..... the schemas.ts drift guard
//      (24 is what proves that guard is not decoration — it really does read
//      the enum out of `server/api-v1/schemas.ts` and compare.)
//
// One mutant was DROPPED after being written down and tried: "hoist the
// `finished` rung above `live`". It survives, and correctly — a set holding a
// live fixture is not `every(completed)`, so those two rungs cannot see each
// other and their order carries no meaning. The live/next crossing (16) is the
// one that does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bucketFixture,
  dayKeyInZone,
  defaultMatchesFilter,
  deriveHubTabs,
  groupByDay,
  HUB_TAB_IDS,
  landingStatus,
  MATCH_BUCKETS,
  sortHubMatches,
  UNSCHEDULED_KEY,
  type MatchBucket,
} from "@/lib/matches-hub";
import {
  CompetitionHubTabId,
  MatchBucketSchema,
} from "@/server/public-site/competition-hub-schema";

// The v1 wire vocabulary for a fixture's status — `Fixture.status`,
// `server/api-v1/schemas.ts:1195` (inside `export const Fixture`, line 1161).
// It is an INLINE `z.enum`, not a named export, so it cannot be imported; the
// guard below reads it out of the source text instead, which is what makes
// this hand-written list a real drift alarm rather than a copy that rots.
const STATUSES = [
  "scheduled",
  "in_play",
  "decided",
  "finalized",
  "abandoned",
  "forfeited",
  "cancelled",
] as const;

describe("bucketFixture — every status the wire schema declares has a bucket", () => {
  it("the hand-written STATUSES list still matches the enum in server/api-v1/schemas.ts", () => {
    // Anchored on "forfeited", which occurs exactly once in that file (verified
    // 2026-09-08). Reading the source rather than importing keeps this pure
    // lib test free of `schemas.ts`'s engine import graph.
    const src = readFileSync(new URL("../../server/api-v1/schemas.ts", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => /status: z\.enum\(\[.*"forfeited".*\]\)/.test(l));
    expect(line, 'no `status: z.enum([… "forfeited" …])` line found in schemas.ts').toBeDefined();
    const declared = [...line!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(declared.sort()).toEqual([...STATUSES].sort());
  });

  it("in_play is the ONLY live status; terminal statuses are completed; the rest are upcoming", () => {
    const buckets = Object.fromEntries(STATUSES.map((s) => [s, bucketFixture(s)]));
    expect(buckets).toEqual({
      scheduled: "upcoming",
      in_play: "live",
      decided: "completed",
      finalized: "completed",
      abandoned: "completed",
      forfeited: "completed",
      cancelled: "completed",
    });
  });

  it("an unknown status is LISTED, never dropped — it buckets as upcoming", () => {
    expect(bucketFixture("postponed")).toBe("upcoming");
    expect(bucketFixture("")).toBe("upcoming");
  });

  it("every bucket it can return is a member of MATCH_BUCKETS", () => {
    const produced = new Set(STATUSES.map((s) => bucketFixture(s)));
    for (const b of produced) expect(MATCH_BUCKETS).toContain(b);
  });
});

describe("defaultMatchesFilter — the filter ladder", () => {
  it("EMPTY: no matches at all → null (nothing is selected, the tab renders its empty state)", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 0, completed: 0 })).toBeNull();
  });
  it("live wins over upcoming and completed (order-differential: a set with all three picks live)", () => {
    expect(defaultMatchesFilter({ live: 1, upcoming: 4, completed: 9 })).toBe("live");
  });
  it("upcoming wins over completed when nothing is live (order-differential: more completed than upcoming)", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 1, completed: 9 })).toBe("upcoming");
  });
  it("completed only → completed", () => {
    expect(defaultMatchesFilter({ live: 0, upcoming: 0, completed: 3 })).toBe("completed");
  });
});

describe("dayKeyInZone — the venue day across a DST boundary", () => {
  // Europe/London leaves BST at 01:00 UTC on Sunday 2026-10-25.
  it("23:30Z on the 24th is 00:30 BST on the 25th; 23:30Z on the 25th is 23:30 GMT on the 25th — SAME venue day", () => {
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "Europe/London")).toBe("2026-10-25");
    expect(dayKeyInZone("2026-10-25T23:30:00.000Z", "Europe/London")).toBe("2026-10-25");
  });
  it("positive pair: the same two instants fall on DIFFERENT days in UTC", () => {
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "UTC")).toBe("2026-10-24");
    expect(dayKeyInZone("2026-10-25T23:30:00.000Z", "UTC")).toBe("2026-10-25");
  });
  it("null in → null out; an unknown zone falls back to UTC rather than throwing", () => {
    expect(dayKeyInZone(null, "Europe/London")).toBeNull();
    expect(dayKeyInZone("2026-10-24T23:30:00.000Z", "Mars/Olympus")).toBe("2026-10-24");
  });
  it("an unparseable instant is null, not a bogus key — it groups as unscheduled", () => {
    expect(dayKeyInZone("not-a-date", "Europe/London")).toBeNull();
  });
});

describe("groupByDay", () => {
  const m = (
    id: string,
    bucket: MatchBucket,
    at: string | null,
    tz = "Europe/London",
  ) => ({ fixtureId: id, bucket, scheduledAt: at, tz });

  it("EMPTY → []", () => {
    expect(groupByDay([])).toEqual([]);
  });

  it("groups by the venue day, unscheduled LAST under the 'unscheduled' key", () => {
    const groups = groupByDay([
      m("a", "upcoming", "2026-09-06T13:00:00Z"),
      m("b", "upcoming", null),
      m("c", "upcoming", "2026-09-06T15:00:00Z"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-06", UNSCHEDULED_KEY]);
    expect(groups[0]!.items.map((x) => x.fixtureId)).toEqual(["a", "c"]);
    expect(groups[1]!.items.map((x) => x.fixtureId)).toEqual(["b"]);
  });

  it("order-differential: days come out ASCENDING even when the input is descending, unscheduled still last", () => {
    const groups = groupByDay([
      m("late", "upcoming", "2026-09-07T13:00:00Z"),
      m("tbd", "upcoming", null),
      m("early", "upcoming", "2026-09-06T13:00:00Z"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-06", "2026-09-07", UNSCHEDULED_KEY]);
  });

  it("carries the zone of the group's first item, so a caller need not re-derive it", () => {
    const groups = groupByDay([m("a", "upcoming", "2026-09-06T13:00:00Z", "Asia/Kolkata")]);
    expect(groups[0]!.tz).toBe("Asia/Kolkata");
  });

  it("the venue day is the ITEM's zone: 21:00Z is the 7th in Kolkata and the 6th in London", () => {
    const groups = groupByDay([
      m("kol", "upcoming", "2026-09-06T21:00:00Z", "Asia/Kolkata"),
      m("lon", "upcoming", "2026-09-06T21:00:00Z", "Europe/London"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-06", "2026-09-07"]);
    expect(groups[0]!.items.map((x) => x.fixtureId)).toEqual(["lon"]);
  });
});

describe("sortHubMatches", () => {
  const m = (id: string, bucket: MatchBucket, at: string | null) => ({
    fixtureId: id,
    bucket,
    scheduledAt: at,
  });

  it("EMPTY → []", () => {
    expect(sortHubMatches([])).toEqual([]);
  });

  it("live first, then upcoming by time ascending (unscheduled last), then completed most-recent first", () => {
    const sorted = sortHubMatches([
      m("done-old", "completed", "2026-09-01T10:00:00Z"),
      m("up-late", "upcoming", "2026-09-08T10:00:00Z"),
      m("live", "live", "2026-09-05T10:00:00Z"),
      m("up-tbd", "upcoming", null),
      m("up-soon", "upcoming", "2026-09-06T10:00:00Z"),
      m("done-new", "completed", "2026-09-04T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual([
      "live",
      "up-soon",
      "up-late",
      "up-tbd",
      "done-new",
      "done-old",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [m("b", "completed", "2026-09-01T10:00:00Z"), m("a", "live", null)];
    sortHubMatches(input);
    expect(input.map((x) => x.fixtureId)).toEqual(["b", "a"]);
  });

  it("an unscheduled COMPLETED match sorts last within its bucket, not first", () => {
    // The descending branch is what makes this worth pinning: a naive
    // "missing → +Infinity" sentinel inverts under `b - a` and floats an
    // undated result to the top of the results list.
    const sorted = sortHubMatches([
      m("no-date", "completed", null),
      m("old", "completed", "2026-09-01T10:00:00Z"),
      m("new", "completed", "2026-09-04T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["new", "old", "no-date"]);
  });

  it("two undated matches in one bucket keep their input order (no NaN comparator)", () => {
    const sorted = sortHubMatches([
      m("first", "completed", null),
      m("second", "completed", null),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["first", "second"]);
  });

  it("an unparseable scheduledAt is treated as undated rather than poisoning the sort", () => {
    const sorted = sortHubMatches([
      m("bad", "upcoming", "not-a-date"),
      m("good", "upcoming", "2026-09-06T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["good", "bad"]);
  });
});

describe("deriveHubTabs — tabs by PRESENCE, gallery never (W4's slot)", () => {
  it("EMPTY: nothing → overview + info only", () => {
    expect(deriveHubTabs({ matches: 0, tables: 0, leaderRows: 0, teams: 0 })).toEqual([
      "overview",
      "info",
    ]);
  });
  it("full: every tab in the spec's order, gallery absent", () => {
    expect(deriveHubTabs({ matches: 3, tables: 1, leaderRows: 2, teams: 4 })).toEqual([
      "overview",
      "matches",
      "table",
      "stats",
      "teams",
      "info",
    ]);
  });
  it("a board list with zero rows does not earn a Stats tab", () => {
    expect(deriveHubTabs({ matches: 1, tables: 0, leaderRows: 0, teams: 2 })).toEqual([
      "overview",
      "matches",
      "teams",
      "info",
    ]);
  });
  it("gallery is a RESERVED id — in the union, never derived (positive pair for the negative)", () => {
    expect(HUB_TAB_IDS).toContain("gallery");
    expect(deriveHubTabs({ matches: 9, tables: 9, leaderRows: 9, teams: 9 })).not.toContain(
      "gallery",
    );
  });
  it("everything it emits is a declared tab id", () => {
    for (const id of deriveHubTabs({ matches: 1, tables: 1, leaderRows: 1, teams: 1 })) {
      expect(HUB_TAB_IDS).toContain(id);
    }
  });
});

describe("landingStatus — the Overview status line ladder (empty → live → next → finished → dates)", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const base = { divisions: 2, startsOn: "2026-09-01", endsOn: "2026-10-31", now };
  const m = (bucket: MatchBucket, at: string | null) => ({
    bucket,
    scheduledAt: at,
    tz: "Europe/London",
  });

  it("EMPTY: a competition with no divisions is 'empty', never finished (competition-desk amendment 3)", () => {
    expect(landingStatus({ ...base, divisions: 0, matches: [] })).toEqual({ kind: "empty" });
  });
  it("EMPTY outranks everything: no divisions is 'empty' even with a live fixture somehow present", () => {
    expect(
      landingStatus({ ...base, divisions: 0, matches: [m("live", "2026-09-05T11:00:00Z")] }),
    ).toEqual({ kind: "empty" });
  });
  it("live outranks a nearer upcoming fixture (order-differential)", () => {
    expect(
      landingStatus({
        ...base,
        matches: [m("upcoming", "2026-09-05T12:30:00Z"), m("live", "2026-09-05T11:00:00Z")],
      }),
    ).toEqual({ kind: "live", n: 1 });
  });
  it("live counts every live fixture, not just the first", () => {
    expect(
      landingStatus({
        ...base,
        matches: [m("live", null), m("completed", "2026-09-01T10:00:00Z"), m("live", null)],
      }),
    ).toEqual({ kind: "live", n: 2 });
  });
  it("next = the EARLIEST upcoming fixture still ahead of now, carrying its zone", () => {
    expect(
      landingStatus({
        ...base,
        matches: [
          m("upcoming", "2026-09-07T13:00:00Z"),
          m("upcoming", "2026-09-06T13:00:00Z"),
          m("upcoming", "2026-09-05T09:00:00Z"),
        ],
      }),
    ).toEqual({ kind: "next", at: "2026-09-06T13:00:00Z", tz: "Europe/London" });
  });
  it("next carries the FIXTURE's zone, not the competition's", () => {
    expect(
      landingStatus({
        ...base,
        matches: [
          { bucket: "upcoming", scheduledAt: "2026-09-06T13:00:00Z", tz: "Asia/Kolkata" },
        ],
      }),
    ).toEqual({ kind: "next", at: "2026-09-06T13:00:00Z", tz: "Asia/Kolkata" });
  });
  it("all played → finished, even though the competition's end date is still ahead (order-differential vs dates)", () => {
    expect(landingStatus({ ...base, matches: [m("completed", "2026-09-04T10:00:00Z")] })).toEqual({
      kind: "finished",
    });
  });
  it("an OVERDUE upcoming fixture is not 'finished' — a competition with unplayed matches falls to dates", () => {
    expect(
      landingStatus({
        ...base,
        matches: [m("completed", "2026-09-01T10:00:00Z"), m("upcoming", "2026-09-04T10:00:00Z")],
      }),
    ).toEqual({ kind: "dates", startsOn: "2026-09-01", endsOn: "2026-10-31" });
  });
  it("an upcoming fixture with no time at all is not 'next' — there is nothing to print", () => {
    expect(landingStatus({ ...base, matches: [m("upcoming", null)] })).toEqual({
      kind: "dates",
      startsOn: "2026-09-01",
      endsOn: "2026-10-31",
    });
  });
  it("divisions but no fixtures yet → dates", () => {
    expect(landingStatus({ ...base, matches: [] })).toEqual({
      kind: "dates",
      startsOn: "2026-09-01",
      endsOn: "2026-10-31",
    });
  });
  it("dates carries nulls through when the competition has no declared dates", () => {
    expect(
      landingStatus({ ...base, startsOn: null, endsOn: null, matches: [] }),
    ).toEqual({ kind: "dates", startsOn: null, endsOn: null });
  });
});

// The tab-id union and the bucket union are each declared TWICE on purpose:
// `lib/matches-hub.ts` is client-safe and exports VALUES, while every client
// import of `@/server/public-site/*` in this tree is `import type` (erased at
// compile) — pulling a zod value across that boundary is what the split avoids.
// Two declarations need one alarm, or they drift silently.
describe("the client-safe union and the zod enum cannot drift apart", () => {
  it("HUB_TAB_IDS and CompetitionHubTabId declare the same ids in the same order", () => {
    expect([...HUB_TAB_IDS]).toEqual(CompetitionHubTabId.options);
  });
  it("MATCH_BUCKETS and MatchBucketSchema declare the same buckets in the same order", () => {
    expect([...MATCH_BUCKETS]).toEqual(MatchBucketSchema.options);
  });
});
