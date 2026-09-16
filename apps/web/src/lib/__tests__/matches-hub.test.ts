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
// Mutation sweep — every mutant below was applied one at a time and restored,
// and the total test count was compared against the run immediately before it,
// so a mutant that failed to parse could not read as a survivor. (The count
// itself is deliberately NOT written down here: a number in a comment cannot
// fail, so it silently rots the moment a later task extends this file. Read it
// from the run.) Each line names the mutant and the test that caught it:
//    1 filter: swap live/upcoming rungs ....... "live wins over upcoming…"
//    2 filter: delete the empty rung .......... "EMPTY: no matches at all"
//    3 bucketFixture: always "upcoming" ....... the status-map case
//    4 bucketFixture: drop the in_play rung ... the status-map case
//    5 dayKeyInZone: drop the zone fallback ... "unknown zone falls back to UTC"
//    6 dayKeyInZone: fall back to the RUNTIME LOCAL zone .. the same case
//    7 dayKeyInZone: drop the NaN guard ....... "an unparseable instant is null"
//    8 groupByDay: unscheduled FIRST .......... both grouping-order cases
//    9 groupByDay: group in UTC, not the item's zone .. the Kolkata/London case
//   10 sort: drop the completed descending branch ..... both completed cases
//   11 sort: naive +Infinity sentinel ......... 2 cases
//   12 sort: drop the bucket RANK ordering .... the main ordering case
//   13 sort: sort in place .................... "does not mutate its input"
//   14 sort: drop `instantOf`'s NaN guard ..... "an unparseable scheduledAt…"
//   15 tabs: emit the reserved "gallery" ...... 3 cases
//   16 tabs: swap table and stats ............. the full-order case
//   17 tabs: stats unconditional .............. EMPTY + the zero-rows case
//   18 tabs: `matches > 1` .................... "exactly ONE fixture…"
//   19 tabs: `tables > 1` ..................... "exactly ONE table…"
//   20 tabs: `leaderRows > 1` ................. "exactly ONE leader row…"
//   21 tabs: `teams > 1` ...................... "exactly ONE team…"
//   22 landing: test `next` BEFORE `live` ..... "live outranks a nearer upcoming"
//   23 landing: delete the empty rung ......... both EMPTY cases
//   24 landing: drop the `ahead of now` filter  "next = the EARLIEST…" + overdue
//   25 landing: `at <= nowMs` (exclusive boundary) ... "starting at EXACTLY now"
//   26 landing: drop `matches.length > 0` from `finished` .... both dates cases
//   27 landing: hard-code the live count to 1 . "live counts every live fixture"
//   28 landing: delete the match_day rung ..... 4 cases
//   29 landing: match_day ABOVE next .......... "order-differential vs next"
//   30 landing: match_day BELOW finished ...... "order-differential vs finished"
//   31 landing: `now` side computed in UTC, not the fixture's zone .. case 1
//   32 landing: FIXTURE side computed in UTC, not its own zone ...... case 2
//   33 landing: drop the `nowIso` NaN guard ... "an unusable `now`…" (it throws)
//   34 landing: hoist `finished` above `live` (and so above next/match_day)
//      ................................ "order-differential vs finished"
//   35 drift: rename an id in HUB_TAB_IDS ..... the tab drift case
//   36 drift: rename a bucket in MatchBucketSchema ... the bucket drift case
//   37 drift: rename an id in CompetitionHubTabId .... the tab drift case
//   38 probe: drop a status from STATUSES below ..... the schemas.ts drift guard
//      (38 is what proves that guard is not decoration — it really does read
//      the enum out of `server/api-v1/schemas.ts` and compare.)
//
// ONE mutant is EQUIVALENT — it cannot be killed by any test, here or anywhere,
// and recording it is cheaper than having the next reader re-derive it:
//
//   • "`return 0` → `return Number.NaN` in the both-undated branch of
//     `sortHubMatches`". ECMA-262 SortCompare says: "Let v be ToNumber(...). If
//     v is NaN, return +0" — so returning NaN there is *defined* to mean
//     "equal", exactly what `return 0` means. Verified empirically as well as
//     from the spec, and independently reproduced in review. NaN is only
//     dangerous when it reaches the SUBTRACTION from a real value, which is
//     mutant 14 and is killed.
//
// A SECOND was recorded here as equivalent and NO LONGER IS — corrected rather
// than deleted, because the way it went stale is the useful part. It read:
// "hoisting the `finished` rung above `live` carries no behaviour, because
// `finished` requires `every(bucket === "completed")`, which is false whenever
// a live fixture exists."
//
// The statement about those two PREDICATES is still true. The conclusion drawn
// from it is not, and was already false by the time it was written: `finished`
// and `live` are not adjacent rungs — `next` and `match_day` sit between them —
// so no code change can swap only that pair. Every mutant that lifts `finished`
// past `live` necessarily lifts it past the other two, and mutant 34 is killed.
// Attempting to isolate the pair (a `finished` clause guarded to fire only when
// nothing is live, inserted above `live`) is killed too, for the same reason.
//
// The lesson, which is why this stays in the file: an equivalence argument is
// scoped to the two rungs it names, and it stops justifying a MUTANT the moment
// a rung is inserted between them. Re-run every "unkillable" mutant after any
// change to the ladder it sits in — this one was verified equivalent in review,
// and then falsified by the very commit that added `match_day`.
import { execFileSync } from "node:child_process";
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
  it("null in → null out", () => {
    expect(dayKeyInZone(null, "Europe/London")).toBeNull();
  });

  it("an unknown zone falls back to UTC — NOT to the runner's own zone", () => {
    // This case has to hold its own zone down, or it is vacuous on CI. "Falls
    // back to UTC" and "falls back to the RUNTIME LOCAL zone" are the same
    // behaviour on a UTC runner, and `.github/workflows/ci.yml`'s sharded unit
    // job runs on a default-UTC GitHub runner — so an assertion made against
    // the ambient zone passes in both states there, forever. It killed the
    // "fall back to local" mutant on this machine only because this machine is
    // Europe/London, which is luck, not coverage.
    //
    // The zone cannot be changed from inside the test: vitest runs with
    // `pool: "threads"`, and in a worker thread setting `process.env.TZ`
    // (or `vi.stubEnv`) updates the variable but NOT ICU's cached default —
    // measured, `resolvedOptions().timeZone` stays put. So the discrimination
    // happens in a child process, where TZ is fixed at spawn. `matches-hub.ts`
    // imports nothing and uses only erasable syntax, so node loads the module
    // directly under its default type-stripping.
    const probe = `
      const { dayKeyInZone } = await import(${JSON.stringify(new URL("../matches-hub.ts", import.meta.url).href)});
      const iso = "2026-10-24T20:00:00.000Z";
      console.log(JSON.stringify({
        ambientKey: new Intl.DateTimeFormat("en-CA").format(new Date(iso)),
        unknownZoneKey: dayKeyInZone(iso, "Mars/Olympus"),
      }));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      // UTC+05:30, no DST — differs from UTC on every runner, including a UTC one.
      env: { ...process.env, TZ: "Asia/Kolkata" },
      encoding: "utf8",
    });
    const seen = JSON.parse(out.trim().split("\n").pop()!) as {
      ambientKey: string;
      unknownZoneKey: string;
    };
    // 20:00Z on the 24th is 01:30 on the 25th in Kolkata. The positive pair
    // FIRST: it proves the child really is in a non-UTC zone, so the assertion
    // under it is actually discriminating rather than quietly vacuous.
    expect(seen.ambientKey).toBe("2026-10-25");
    expect(seen.unknownZoneKey).toBe("2026-10-24");
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

  it("SEVERAL undated matches interleaved with dated ones: dated first in order, undated after in input order", () => {
    // Deliberately four elements, interleaved, in the DESCENDING bucket. The
    // two-element version of this case that shipped first was vacuous: with two
    // items, a stable sort produces input order whatever the comparator says,
    // so it passed under every defect it was written to catch.
    const sorted = sortHubMatches([
      m("u1", "completed", null),
      m("d-old", "completed", "2026-09-01T10:00:00Z"),
      m("u2", "completed", null),
      m("d-new", "completed", "2026-09-04T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["d-new", "d-old", "u1", "u2"]);
  });

  it("an unparseable scheduledAt is treated as undated rather than poisoning the sort", () => {
    // THIS is the case that witnesses "no NaN in the comparator". Drop the
    // `Number.isNaN` guard inside `instantOf` and NaN reaches the subtraction:
    // every comparison against it is false, ECMA-262 SortCompare normalises the
    // NaN result to +0 ("equal"), and the stable sort hands back input order —
    // so `bad` stays in front of `good` and this reds. See the adjudication in
    // the sweep notes at the top of this file for the mutant that CANNOT be
    // caught here, and why.
    const sorted = sortHubMatches([
      m("bad", "upcoming", "not-a-date"),
      m("good", "upcoming", "2026-09-06T10:00:00Z"),
    ]);
    expect(sorted.map((x) => x.fixtureId)).toEqual(["good", "bad"]);
  });
});

describe("deriveHubTabs — tabs by PRESENCE, gallery never (W4's slot)", () => {
  it("EMPTY: nothing → overview + info only", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 0, knockouts: 0, leaderRows: 0, teams: 0 }),
    ).toEqual(["overview", "info"]);
  });
  it("full: every tab in the spec's order, gallery absent", () => {
    expect(
      deriveHubTabs({ matches: 3, tables: 1, knockouts: 2, leaderRows: 2, teams: 4 }),
    ).toEqual(["overview", "matches", "table", "knockout", "stats", "teams", "info"]);
  });
  it("a board list with zero rows does not earn a Stats tab", () => {
    expect(
      deriveHubTabs({ matches: 1, tables: 0, knockouts: 0, leaderRows: 0, teams: 2 }),
    ).toEqual(["overview", "matches", "teams", "info"]);
  });
  // ONE of a thing is the boundary each of these gates is really about, and it
  // is the value that never appears in the cases above. `> 0` mutated to `> 1`
  // survives every count of 0, 2, 3, 4 or 9 — so a competition with a single
  // leader row, a single entrant, a single fixture, a single table or a single
  // bracket would silently lose its tab. One case per gate, each with
  // everything else at zero so nothing can cover for it.
  it("exactly ONE leader row earns the Stats tab", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 0, knockouts: 0, leaderRows: 1, teams: 0 }),
    ).toEqual(["overview", "stats", "info"]);
  });
  it("exactly ONE team earns the Teams tab", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 0, knockouts: 0, leaderRows: 0, teams: 1 }),
    ).toEqual(["overview", "teams", "info"]);
  });
  it("exactly ONE fixture earns the Matches tab", () => {
    expect(
      deriveHubTabs({ matches: 1, tables: 0, knockouts: 0, leaderRows: 0, teams: 0 }),
    ).toEqual(["overview", "matches", "info"]);
  });
  it("exactly ONE table earns the Table tab", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 1, knockouts: 0, leaderRows: 0, teams: 0 }),
    ).toEqual(["overview", "table", "info"]);
  });
  it("exactly ONE knockout view earns the Knockout tab", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 0, knockouts: 1, leaderRows: 0, teams: 0 }),
    ).toEqual(["overview", "knockout", "info"]);
  });
  // ORDER, not membership (hub Knockout tab plan, R1/R2): Knockout sits
  // directly after Table and before Stats. The "full" case above holds every
  // tab at once; this one isolates the two neighbours so a push moved one slot
  // either way reds on its own.
  it("Knockout sits between Table and Stats — both neighbours present, nothing else", () => {
    expect(
      deriveHubTabs({ matches: 0, tables: 1, knockouts: 1, leaderRows: 1, teams: 0 }),
    ).toEqual(["overview", "table", "knockout", "stats", "info"]);
  });
  it("a league-only competition has NO Knockout tab (the negative pair)", () => {
    expect(
      deriveHubTabs({ matches: 4, tables: 1, knockouts: 0, leaderRows: 0, teams: 4 }),
    ).toEqual(["overview", "matches", "table", "teams", "info"]);
  });
  it("gallery is a RESERVED id — in the union, never derived (positive pair for the negative)", () => {
    expect(HUB_TAB_IDS).toContain("gallery");
    expect(
      deriveHubTabs({ matches: 9, tables: 9, knockouts: 9, leaderRows: 9, teams: 9 }),
    ).not.toContain("gallery");
  });
  it("everything it emits is a declared tab id", () => {
    for (const id of deriveHubTabs({
      matches: 1,
      tables: 1,
      knockouts: 1,
      leaderRows: 1,
      teams: 1,
    })) {
      expect(HUB_TAB_IDS).toContain(id);
    }
  });
});

describe("landingStatus — the Overview status line ladder (empty → live → next → match_day → finished → dates)", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const base = { divisions: 2, startsOn: "2026-09-01", endsOn: "2026-10-31", now };
  // Every fixture in this block is in Europe/London and every date is 2026-09-0x,
  // so a fixture dated 2026-09-05 is TODAY and any other date is not. `now` is
  // 12:00Z = 13:00 BST, comfortably inside that day at both ends.
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
  it("a fixture starting at EXACTLY now is still 'next' — the boundary is inclusive", () => {
    // Decided deliberately, and stated in `landingStatus`'s own doc comment: a
    // fixture whose start instant equals `now` has not started, so it is next
    // rather than overdue. An exclusive boundary would open a hole in which the
    // page has nothing to say about a match that is about to begin — here it
    // would drop straight to "Match day".
    expect(landingStatus({ ...base, matches: [m("upcoming", "2026-09-05T12:00:00Z")] })).toEqual({
      kind: "next",
      at: "2026-09-05T12:00:00Z",
      tz: "Europe/London",
    });
  });
  it("one millisecond earlier is overdue, not next (the other side of the same boundary)", () => {
    expect(
      landingStatus({ ...base, matches: [m("upcoming", "2026-09-05T11:59:59.999Z")] }),
    ).toEqual({ kind: "match_day" });
  });
  it("an OVERDUE upcoming fixture on ANOTHER day is not 'finished' — it falls to dates", () => {
    expect(
      landingStatus({
        ...base,
        matches: [m("completed", "2026-09-01T10:00:00Z"), m("upcoming", "2026-09-04T10:00:00Z")],
      }),
    ).toEqual({ kind: "dates", startsOn: "2026-09-01", endsOn: "2026-10-31" });
  });
  it("an undated fixture is neither 'next' nor a match day — there is no instant to read", () => {
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

  // ---- match_day: below `next`, above `finished` -------------------------
  it("THE HOLE THIS RUNG CLOSES: a fixture earlier today, not in play → match_day, not a date range", () => {
    // Before this rung existed the ladder answered "1 Sep – 31 Oct" here — a
    // date range, on the afternoon of the one day a spectator came to watch.
    expect(landingStatus({ ...base, matches: [m("upcoming", "2026-09-05T09:00:00Z")] })).toEqual({
      kind: "match_day",
    });
  });
  it("order-differential vs next: a fixture LATER today is 'next', not 'match_day'", () => {
    // Both rungs are satisfied by this input — the fixture is today AND ahead
    // of now. A ladder with match_day above next would answer match_day; the
    // specific time is the better answer, so next wins.
    expect(landingStatus({ ...base, matches: [m("upcoming", "2026-09-05T15:00:00Z")] })).toEqual({
      kind: "next",
      at: "2026-09-05T15:00:00Z",
      tz: "Europe/London",
    });
  });
  it("order-differential vs finished: everything played, but played TODAY → match_day", () => {
    // Both rungs are satisfied — every fixture is completed AND one is today.
    // A ladder with finished above match_day would answer finished.
    expect(landingStatus({ ...base, matches: [m("completed", "2026-09-05T10:00:00Z")] })).toEqual({
      kind: "match_day",
    });
  });
  it("order-differential vs live: a live fixture today is 'live', not 'match_day'", () => {
    expect(
      landingStatus({
        ...base,
        matches: [m("live", "2026-09-05T10:00:00Z"), m("upcoming", "2026-09-05T09:00:00Z")],
      }),
    ).toEqual({ kind: "live", n: 1 });
  });
  // The rung's whole point is that a fixture's day is its VENUE's day. That is
  // TWO readings of the zone — `now`'s and the fixture's — and each needs its
  // own witness, because an input where the fixture's local day happens to equal
  // its UTC day cannot see the fixture side at all. The first case below pins
  // the `now` side and the second pins the fixture side; neither covers for the
  // other. (Round 1 shipped only the first, and its comment claimed it covered
  // both. Mutating the fixture side to `dayKeyInZone(m.scheduledAt, "UTC")`
  // survived the whole suite.)
  it("the `now` side is read in the FIXTURE's zone, not UTC", () => {
    // Same two instants in both rows; only the zone changes. The fixture is
    // 18:00Z and `now` is 23:00Z, so in UTC they share a day (both the 5th),
    // and in Kolkata (+05:30) they do not — the fixture is 23:30 on the 5th and
    // `now` is 04:30 on the 6th. Reading `now` in UTC would make row 2 agree
    // with row 1 and answer match_day; only row 2 witnesses that. Note the
    // FIXTURE side is invisible here: its Kolkata day and its UTC day are both
    // 2026-09-05, which is exactly why the second case exists.
    const at = "2026-09-05T18:00:00Z";
    const late = new Date("2026-09-05T23:00:00Z");
    expect(
      landingStatus({
        ...base,
        now: late,
        matches: [{ bucket: "upcoming", scheduledAt: at, tz: "UTC" }],
      }),
    ).toEqual({ kind: "match_day" });
    expect(
      landingStatus({
        ...base,
        now: late,
        matches: [{ bucket: "upcoming", scheduledAt: at, tz: "Asia/Kolkata" }],
      }),
    ).toEqual({ kind: "dates", startsOn: "2026-09-01", endsOn: "2026-10-31" });
  });

  it("the FIXTURE side is read in its own zone too — a late-evening match belongs to the venue's tomorrow", () => {
    // A 23:00Z fixture in Kolkata is 04:30 the NEXT morning locally, so its
    // venue day is the 6th; `now` at 02:00Z is 07:30 on the 6th there. Same
    // day at the venue, different days in UTC — so reading the fixture side in
    // UTC drops the match and the page answers "Finished" on a morning when a
    // match was played hours earlier. That is the exact user-visible wrong
    // answer this rung exists to prevent.
    const at = "2026-09-05T23:00:00Z";
    const morningAfter = new Date("2026-09-06T02:00:00Z");
    expect(
      landingStatus({
        ...base,
        now: morningAfter,
        matches: [{ bucket: "completed", scheduledAt: at, tz: "Asia/Kolkata" }],
      }),
    ).toEqual({ kind: "match_day" });
    // The contrast row: the same instants at a UTC venue really are two
    // different days, so there the answer is finished — the zone is what moved
    // the answer, not the instants.
    expect(
      landingStatus({
        ...base,
        now: morningAfter,
        matches: [{ bucket: "completed", scheduledAt: at, tz: "UTC" }],
      }),
    ).toEqual({ kind: "finished" });
  });
  it("an unusable `now` yields no match day rather than throwing out of a pure helper", () => {
    // `Date#toISOString` throws on an Invalid Date, so the match-day rung has to
    // reach for it only after `now` has proved itself an instant.
    expect(
      landingStatus({
        ...base,
        now: new Date("not-a-date"),
        matches: [m("completed", "2026-09-04T10:00:00Z")],
      }),
    ).toEqual({ kind: "finished" });
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
  it("both put `knockout` DIRECTLY after `table` (R1) — the rail reads in this order", () => {
    // The equality above holds for any order the two agree on; this pins the
    // one the plan rules, on both declarations.
    for (const ids of [[...HUB_TAB_IDS], CompetitionHubTabId.options] as string[][]) {
      expect(ids.indexOf("knockout")).toBeGreaterThan(0);
      expect(ids.indexOf("knockout")).toBe(ids.indexOf("table") + 1);
    }
  });
  it("MATCH_BUCKETS and MatchBucketSchema declare the same buckets in the same order", () => {
    expect([...MATCH_BUCKETS]).toEqual(MatchBucketSchema.options);
  });
});
