// P3 (D7 news enrichment + weekly digest) — pure helpers, no DB. Every
// function here is called from the DB-backed assembly in org-posts.ts, but
// none of them touch the database themselves, so their math is tested
// directly against synthetic inputs.
import { describe, expect, it } from "vitest";
import {
  biggestClimber,
  biggestMargin,
  computeLeaderboardMoves,
  computeStreak,
  digestWindow,
  groupUpcomingByDay,
} from "../enrichment";

describe("digestWindow", () => {
  it("is a plain 7x24h window when no DST transition falls inside it", () => {
    // 2026-06-15 is deep in BST with no transition nearby.
    const w = digestWindow(Date.parse("2026-06-15T09:00:00.000Z"), "Europe/London");
    expect(w.end).toBe("2026-06-15T09:00:00.000Z");
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(7 * 24 * 3600_000);
  });

  it("spring-forward: the window straddling the transition is 167h, not 168h", () => {
    // UK clocks go forward 2026-03-29 01:00 UTC. "Now" is a week after, so the
    // window [now-7d, now) crosses it.
    const w = digestWindow(Date.parse("2026-04-02T09:00:00.000Z"), "Europe/London");
    expect(w.start).toBe("2026-03-26T10:00:00.000Z"); // verified against @seazn/engine/scheduling/tz directly
    expect(w.end).toBe("2026-04-02T09:00:00.000Z");
    expect((Date.parse(w.end) - Date.parse(w.start)) / 3600_000).toBe(167);
    // A flat 168h subtraction would have landed an hour earlier — the whole
    // point of computing the window in calendar terms rather than ms terms.
    expect(w.start).not.toBe(new Date(Date.parse(w.end) - 7 * 24 * 3600_000).toISOString());
  });

  it("fall-back: the window straddling the transition is 169h, not 168h", () => {
    // UK clocks go back 2026-10-25 01:00 UTC.
    const w = digestWindow(Date.parse("2026-10-29T09:00:00.000Z"), "Europe/London");
    expect(w.start).toBe("2026-10-22T08:00:00.000Z");
    expect((Date.parse(w.end) - Date.parse(w.start)) / 3600_000).toBe(169);
  });

  it("weekOfYmd is the org-local calendar date the window starts on", () => {
    const w = digestWindow(Date.parse("2026-04-02T09:00:00.000Z"), "Europe/London");
    expect(w.weekOfYmd).toBe("2026-03-26");
  });
});

describe("groupUpcomingByDay", () => {
  const fx = (id: string, iso: string) => ({
    id,
    homeName: "A",
    awayName: "B",
    scheduledAt: iso,
    competitionName: "Cup",
    divisionName: "Div",
  });

  it("groups by the ORG-LOCAL calendar day, not the UTC day", () => {
    // 23:30 UTC on the day after the UK spring-forward transition is already
    // the NEXT calendar day in Europe/London (BST +1) — a UTC-string slice
    // would wrongly keep it on the earlier day.
    const { groups } = groupUpcomingByDay(
      [fx("f1", "2026-03-29T23:30:00.000Z"), fx("f2", "2026-03-30T05:00:00.000Z")],
      "Europe/London",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.dayYmd).toBe("2026-03-30");
    expect(groups[0]!.fixtures.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("sorts chronologically, caps at N, and reports the overflow count", () => {
    const fixtures = Array.from({ length: 13 }, (_, i) =>
      fx(`f${i}`, `2026-08-${String(10 + i).padStart(2, "0")}T09:00:00.000Z`),
    ).reverse(); // shuffle: feed newest-first
    const { groups, overflow } = groupUpcomingByDay(fixtures, "UTC", 10);
    const flat = groups.flatMap((g) => g.fixtures);
    expect(flat).toHaveLength(10);
    expect(flat[0]!.id).toBe("f0"); // earliest first despite input order
    expect(overflow).toBe(3);
  });

  it("empty input yields no groups and zero overflow", () => {
    expect(groupUpcomingByDay([], "UTC")).toEqual({ groups: [], overflow: 0 });
  });
});

describe("biggestClimber", () => {
  const row = (entrantId: string, rank: number, points: number) => ({ entrantId, rank, points });

  it("picks the largest positive rank delta", () => {
    const previous = [row("a", 3, 4), row("b", 1, 9), row("c", 2, 6)];
    const current = [row("a", 1, 10), row("b", 2, 9), row("c", 3, 6)]; // a: 3->1 (+2), c: 2->3 (-1)
    expect(biggestClimber(current, previous)).toEqual({ entrantId: "a", from: 3, to: 1 });
  });

  it("ties on rank delta break by points gained", () => {
    // Both a and c climb by exactly 1 rank; c gained more points.
    const previous = [row("a", 3, 4), row("b", 1, 9), row("c", 3, 4)];
    const current = [row("a", 2, 5), row("b", 1, 9), row("c", 2, 8)];
    expect(biggestClimber(current, previous)?.entrantId).toBe("c");
  });

  it("still tied after both tiebreaks skips the climber line entirely", () => {
    const previous = [row("a", 3, 4), row("c", 3, 4)];
    const current = [row("a", 2, 6), row("c", 2, 6)]; // identical delta AND identical points gained
    expect(biggestClimber(current, previous)).toBeNull();
  });

  it("no previous snapshot (first-ever computation) yields no climber", () => {
    expect(biggestClimber([row("a", 1, 3)], null)).toBeNull();
    expect(biggestClimber([row("a", 1, 3)], undefined)).toBeNull();
    expect(biggestClimber([row("a", 1, 3)], [])).toBeNull();
  });

  it("nobody climbed (everyone held or fell) yields null", () => {
    const previous = [row("a", 1, 9), row("b", 2, 6)];
    const current = [row("a", 1, 12), row("b", 2, 9)]; // same ranks, more points, no rank movement
    expect(biggestClimber(current, previous)).toBeNull();
  });

  it("an entrant absent from the previous snapshot (new entrant) is excluded, not crashed on", () => {
    const previous = [row("a", 1, 9)];
    const current = [row("a", 2, 9), row("new", 1, 12)];
    expect(biggestClimber(current, previous)).toBeNull();
  });
});

describe("computeLeaderboardMoves — leaderboard diff math", () => {
  it("a scorer whose credit pushed them past another player reports the rank move", () => {
    // After this fixture: alice=10 (rank 1), bob=8 (rank 2). Alice scored 3 in
    // THIS fixture, so before it she had 7 — which would have ranked her
    // BELOW bob (8), i.e. rank 2. 2 -> 1 is a real move.
    const after = [
      { personId: "alice", personName: "Alice", value: 10 },
      { personId: "bob", personName: "Bob", value: 8 },
    ];
    const moves = computeLeaderboardMoves(
      after,
      [{ personId: "alice", personName: "Alice", credit: 3 }],
      "goals",
    );
    expect(moves).toEqual([{ personName: "Alice", metric: "goals", from: 2, to: 1 }]);
  });

  it("a scorer whose rank is unchanged before/after produces no move", () => {
    // Alice already led by a wide margin before this fixture's 1-goal credit.
    const after = [
      { personId: "alice", personName: "Alice", value: 20 },
      { personId: "bob", personName: "Bob", value: 5 },
    ];
    const moves = computeLeaderboardMoves(
      after,
      [{ personId: "alice", personName: "Alice", credit: 1 }],
      "goals",
    );
    expect(moves).toEqual([]);
  });

  it("zero-credit contributions (e.g. an assist-only row with no goal) are skipped", () => {
    const after = [{ personId: "alice", personName: "Alice", value: 5 }];
    const moves = computeLeaderboardMoves(
      after,
      [{ personId: "alice", personName: "Alice", credit: 0 }],
      "goals",
    );
    expect(moves).toEqual([]);
  });

  it("a scorer not present in the after-leaderboard is skipped rather than crashing", () => {
    const after = [{ personId: "bob", personName: "Bob", value: 5 }];
    const moves = computeLeaderboardMoves(
      after,
      [{ personId: "ghost", personName: "Ghost", credit: 2 }],
      "goals",
    );
    expect(moves).toEqual([]);
  });

  // REGRESSION (review finding 1): every earlier test above passes a
  // single-element `contributions` array, which is why this bug survived —
  // org-posts.ts always passes the FULL scorer list for a fixture, never
  // one scorer, and football/hockey routinely have 2+.
  it("REGRESSION: rolls back ALL same-fixture contributors at once, not just the one being described", () => {
    // Reviewer's repro. after={A:7,B:7}, credits={A:2,B:3}. True before is
    // {A:5,B:4} — A already led and nothing about A moved. The bug held
    // every OTHER contributor at their POST-fixture value while rolling
    // back only the contributor currently being ranked: for Alice, that
    // reads "before" as {A:5, B:7 (still inflated)} — B's un-rolled-back 7
    // outranks Alice's 5, so the buggy code reported Alice moving from #2
    // to #1, a statement that would have published false into a real draft.
    const after = [
      { personId: "A", personName: "Alice", value: 7 },
      { personId: "B", personName: "Bob", value: 7 },
    ];
    const contributions = [
      { personId: "A", personName: "Alice", credit: 2 },
      { personId: "B", personName: "Bob", credit: 3 },
    ];
    const moves = computeLeaderboardMoves(after, contributions, "goals");
    expect(moves.find((m) => m.personName === "Alice")).toBeUndefined();
  });

  it("a genuine multi-scorer move still reports correctly once every contributor is rolled back together", () => {
    // Same fixture as above. True before {A:5,B:4} -> Alice leads. True
    // after {A:7,B:7} -> tied for #1. Bob genuinely climbed #2 -> #1; Alice
    // did not move at all (covered by the regression case above).
    const after = [
      { personId: "A", personName: "Alice", value: 7 },
      { personId: "B", personName: "Bob", value: 7 },
    ];
    const contributions = [
      { personId: "A", personName: "Alice", credit: 2 },
      { personId: "B", personName: "Bob", credit: 3 },
    ];
    const moves = computeLeaderboardMoves(after, contributions, "goals");
    expect(moves).toEqual([{ personName: "Bob", metric: "goals", from: 2, to: 1 }]);
  });
});

describe("computeStreak", () => {
  it("reports a win streak of 3", () => {
    expect(computeStreak(["win", "win", "win", "loss"])).toEqual({ kind: "win", length: 3 });
  });

  it("a single win is not a streak", () => {
    expect(computeStreak(["win", "loss"])).toBeNull();
  });

  it("prefers the longer unbeaten run over a shorter win run", () => {
    expect(computeStreak(["draw", "win", "win", "loss"])).toEqual({ kind: "unbeaten", length: 3 });
  });

  it("a loss immediately breaks both streaks", () => {
    expect(computeStreak(["loss", "win", "win"])).toBeNull();
  });

  it("empty history yields no streak", () => {
    expect(computeStreak([])).toBeNull();
  });
});

describe("biggestMargin", () => {
  it("picks the largest-margin numeric result", () => {
    const results = [
      { homeName: "A", homeScore: "3", awayName: "B", awayScore: "1" },
      { homeName: "C", homeScore: "5", awayName: "D", awayScore: "0" },
    ];
    expect(biggestMargin(results)).toEqual({ label: "C 5–0 D" });
  });

  it("non-numeric score lines (e.g. cricket's '252/8 (50)') are excluded, not mis-parsed", () => {
    const results = [{ homeName: "A", homeScore: "252/8 (50)", awayName: "B", awayScore: "210 (48.2)" }];
    expect(biggestMargin(results)).toBeNull();
  });

  it("a draw (zero margin) is never the biggest result", () => {
    expect(
      biggestMargin([{ homeName: "A", homeScore: "1", awayName: "B", awayScore: "1" }]),
    ).toBeNull();
  });

  it("empty round yields null", () => {
    expect(biggestMargin([])).toBeNull();
  });
});
