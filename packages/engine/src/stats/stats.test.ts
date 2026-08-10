// Player-stats fold tests (Jul3/07, PROMPT-27 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { aggregatePlayerStats, resolvePayloadPath, sumPlayerStats } from "./stats.ts";
import { football } from "../sports/football/football.ts";
import type { PlayerStatMetric, PlayerStatsModel } from "./stats.ts";
import type { EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";

const MODEL = football.playerStats!;

function env(seq: number, type: string, payload: Record<string, unknown>, voids?: string): EventEnvelope {
  return {
    id: `e${seq}`, seq, type, payload,
    recordedAt: "2026-07-20T09:00:00Z",
    ...(voids !== undefined ? { voids } : {}),
  } as EventEnvelope;
}

const goal = (seq: number, scorer?: string, assist?: string, ownGoal = false) =>
  env(seq, "football.goal", {
    by: "H",
    ...(scorer !== undefined ? { scorer } : {}),
    ...(assist !== undefined ? { assist } : {}),
    ...(ownGoal ? { ownGoal: true } : {}),
  });

// One-metric models over a throwaway event type — the path resolver is a
// property of the stat model, not of any one sport's schema.
const oneMetric = (m: Omit<PlayerStatMetric, "key" | "label" | "from">): PlayerStatsModel => ({
  metrics: [{ key: "k", label: "K", from: "x.ball", ...m }],
});
const countBy = (field: string) => oneMetric({ field, agg: "count" });
const sumBy = (field: string, sumField: string) => oneMetric({ field, agg: "sum", sumField });

describe("aggregatePlayerStats (Jul3/07)", () => {
  it("golden: football ledger → goals/assists table with points = goals + assists (16 Apr)", () => {
    const rows = aggregatePlayerStats(
      [
        goal(1, "p7", "p10"),
        goal(2, "p7"),
        goal(3, "p10", "p7"),
        env(4, "football.card", { by: "H", person: "p7", color: "yellow" }),
        env(5, "core.award", { person: "p7", key: "motm" }),
      ],
      MODEL,
    );
    expect(rows).toEqual([
      { personId: "p10", stats: { goals: 1, assists: 1, points: 2 } },
      { personId: "p7", stats: { goals: 2, assists: 1, yellow_cards: 1, motm_awards: 1, points: 3 } },
    ]);
  });

  it("a core.void on a goal drops the goal AND its assist (§8)", () => {
    const rows = aggregatePlayerStats(
      [goal(1, "p7", "p10"), env(2, "core.void", {}, "e1")],
      MODEL,
    );
    expect(rows).toEqual([]);
  });

  it("own goals never credit the striker; assist-less goals count only present fields", () => {
    // Closed set on purpose: every metric football declares that this ledger
    // touches must appear here, so a new one cannot be added unnoticed.
    const rows = aggregatePlayerStats([goal(1, "p9", undefined, true), goal(2, "p9")], MODEL);
    expect(rows).toEqual([{ personId: "p9", stats: { goals: 1, own_goals: 1, points: 1 } }]);
  });

  it("stats are a pure order-independent fold: refold(events) == snapshot", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            scorer: fc.constantFrom("p1", "p2", "p3"),
            assist: fc.option(fc.constantFrom("p1", "p2", "p3"), { nil: undefined }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (goals) => {
          const fixtures = [
            goals.slice(0, Math.ceil(goals.length / 2)),
            goals.slice(Math.ceil(goals.length / 2)),
          ].map((gs, fi) =>
            aggregatePlayerStats(gs.map((g, i) => goal(fi * 100 + i + 1, g.scorer, g.assist)), MODEL),
          );
          const total = sumPlayerStats(fixtures, MODEL);
          const reversed = sumPlayerStats([...fixtures].reverse(), MODEL);
          expect(reversed).toEqual(total);
          // per-division isolation: summing only fixture 0 differs from total
          // unless fixture 1 is empty — tables never bleed
          const only0 = sumPlayerStats([fixtures[0]!], MODEL);
          const f1HasGoals = fixtures[1]!.length > 0;
          if (f1HasGoals) expect(only0).not.toEqual(total);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("a dotted `field` credits a nested person (cricket's `wicket.fielder`)", () => {
    const rows = aggregatePlayerStats(
      [
        env(1, "x.ball", { striker: "p1", wicket: { kind: "caught", fielder: "p3" } }),
        env(2, "x.ball", { striker: "p1", wicket: { kind: "caught", fielder: "p3" } }),
        env(3, "x.ball", { striker: "p1" }),
      ],
      countBy("wicket.fielder"),
    );
    expect(rows).toEqual([{ personId: "p3", stats: { k: 2 } }]);
  });

  it("a dotted `sumField` sums a nested value (cricket's `runs.bat`)", () => {
    const rows = aggregatePlayerStats(
      [
        env(1, "x.ball", { striker: "p1", runs: { bat: 4 } }),
        env(2, "x.ball", { striker: "p1", runs: { bat: 2 } }),
        env(3, "x.ball", { striker: "p2", runs: { bat: 6 } }),
      ],
      sumBy("striker", "runs.bat"),
    );
    expect(rows).toEqual([
      { personId: "p1", stats: { k: 6 } },
      { personId: "p2", stats: { k: 6 } },
    ]);
  });

  it("an unresolvable path is silently no credit, never a throw (heterogeneous payloads)", () => {
    // Every shape here is a real cricket ball: no wicket, a wicket with no
    // named fielder, a path that runs into a number, a null branch, a null
    // leaf, and a person that is not a string. None may credit anyone.
    const events = [
      env(1, "x.ball", {}),
      env(2, "x.ball", { wicket: { kind: "bowled" } }),
      env(3, "x.ball", { wicket: 7 }),
      env(4, "x.ball", { wicket: null }),
      env(5, "x.ball", { wicket: { fielder: null } }),
      env(6, "x.ball", { wicket: { fielder: 0 } }),
      env(7, "x.ball", { wicket: { fielder: "" } }),
    ];
    expect(() => aggregatePlayerStats(events, countBy("wicket.fielder"))).not.toThrow();
    expect(aggregatePlayerStats(events, countBy("wicket.fielder"))).toEqual([]);
    // …and the same for a path that walks THROUGH a non-object.
    expect(aggregatePlayerStats([env(1, "x.ball", { runs: { bat: 4 } })], countBy("runs.bat.deep")))
      .toEqual([]);
  });

  it("an empty path segment resolves to nothing — it never steps into an empty key", () => {
    const ev = [env(1, "x.ball", { wicket: { fielder: "p3" } })];
    expect(aggregatePlayerStats(ev, countBy("wicket..fielder"))).toEqual([]);
    expect(aggregatePlayerStats(ev, countBy(".fielder"))).toEqual([]);
    expect(aggregatePlayerStats(ev, countBy("wicket.fielder."))).toEqual([]);
    expect(aggregatePlayerStats(ev, countBy(""))).toEqual([]);
    // A payload that really does carry an "" key must stay unreachable by a
    // leading/doubled dot — otherwise a typo'd path silently credits someone.
    const emptyKey = [env(1, "x.ball", { "": { fielder: "p3" }, wicket: { "": { fielder: "p4" } } })];
    expect(aggregatePlayerStats(emptyKey, countBy(".fielder"))).toEqual([]);
    expect(aggregatePlayerStats(emptyKey, countBy("wicket..fielder"))).toEqual([]);
  });

  it("a payload key that literally contains a dot wins over the walk", () => {
    const rows = aggregatePlayerStats(
      [env(1, "x.ball", { "wicket.fielder": "p9", wicket: { fielder: "p3" } })],
      countBy("wicket.fielder"),
    );
    expect(rows).toEqual([{ personId: "p9", stats: { k: 1 } }]);
  });

  it("paths walk objects only — arrays are a leaf, not a step", () => {
    // A resolved array still credits every listed person (ice hockey's two
    // assists), but a path may not index INTO one.
    expect(aggregatePlayerStats([env(1, "x.ball", { on: ["p1", "p2"] })], countBy("on"))).toEqual([
      { personId: "p1", stats: { k: 1 } },
      { personId: "p2", stats: { k: 1 } },
    ]);
    const arr = [env(1, "x.ball", { on: [{ person: "p1" }, { person: "p2" }] })];
    expect(aggregatePlayerStats(arr, countBy("on.person"))).toEqual([]);
    // No index syntax either — `on.0.person` must not reach into the array.
    expect(aggregatePlayerStats(arr, countBy("on.0.person"))).toEqual([]);
    expect(aggregatePlayerStats([env(1, "x.ball", { on: ["p1", "p2"] })], countBy("on.0"))).toEqual(
      [],
    );
  });

  it("a dotted sumField that lands on a non-number credits nothing", () => {
    const rows = aggregatePlayerStats(
      [env(1, "x.ball", { striker: "p1", runs: { bat: { total: 4 } } })],
      sumBy("striker", "runs.bat"),
    );
    expect(rows).toEqual([]);
  });

  it("resolvePayloadPath: single-segment lookups are unchanged", () => {
    expect(resolvePayloadPath({ person: "p7" }, "person")).toBe("p7");
    expect(resolvePayloadPath({ person: "p7" }, "missing")).toBeUndefined();
  });

  it("MOTM award aggregates into the leaderboard; unknown award keys ignored", () => {
    const rows = aggregatePlayerStats(
      [
        env(1, "core.award", { person: "p7", key: "motm" }),
        env(2, "core.award", { person: "p7", key: "not_declared" }),
      ],
      MODEL,
    );
    expect(rows).toEqual([{ personId: "p7", stats: { motm_awards: 1, points: 0 } }]);
  });
});

// S4 (#428) — THE bug: a card or a goal-shaped payload naming a coach's
// personId earned a playing-stat row, because this fold reads the payload's
// person id directly with zero cross-check against LineupSlot.role (S3/#426
// ruling 3: role defaults "player", and every PLAYING projection —
// core/lineup.ts's playingSquad/onFieldPersons/personsAtPosition — already
// filters on it; this fold is not one of those callers). Enforced HERE, at
// the aggregation boundary itself, not by trusting each sport's `when`
// predicate to remember a check — a coach who never plays should never be
// findable in ANY sport's leaderboard, and the fold has no per-sport hook a
// forgetful metric declaration could skip.
describe("role discriminator (S4/#428) — a non-player never earns a playing stat", () => {
  const lineupWithCoach: LineupPair = {
    home: {
      entrantId: "H",
      slots: [
        { personId: "p7", slot: "starting", orderNo: 1 },
        // Absent `role` ⇒ player (S3 ruling 3's default) — p10 must still count.
        { personId: "p10", slot: "starting", orderNo: 2 },
        { personId: "coach1", slot: "bench", orderNo: 90, role: "coach" },
        { personId: "physio1", slot: "bench", orderNo: 91, role: "staff" },
      ],
    },
    away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
  };

  it("a coach's card produces NO row in the aggregate output — the leaderboard, not just the field", () => {
    const rows = aggregatePlayerStats(
      [env(1, "football.card", { by: "H", person: "coach1", color: "yellow" })],
      MODEL,
      lineupWithCoach,
    );
    expect(rows).toEqual([]);
    expect(rows.find((r) => r.personId === "coach1")).toBeUndefined();
  });

  it("team staff (physio, kit manager, …) is excluded the same way a coach is", () => {
    const rows = aggregatePlayerStats(
      [env(1, "football.card", { by: "H", person: "physio1", color: "red" })],
      MODEL,
      lineupWithCoach,
    );
    expect(rows).toEqual([]);
  });

  it("a real player on the SAME team sheet as the excluded coach still earns his row", () => {
    const rows = aggregatePlayerStats([goal(1, "p7")], MODEL, lineupWithCoach);
    expect(rows).toEqual([{ personId: "p7", stats: { goals: 1, points: 1 } }]);
  });

  it("a player with no declared role (default player, S3 ruling 3) still counts", () => {
    const rows = aggregatePlayerStats([goal(1, "p10")], MODEL, lineupWithCoach);
    expect(rows).toEqual([{ personId: "p10", stats: { goals: 1, points: 1 } }]);
  });

  it("mixed ledger: the coach's card is dropped, the player's goal is kept, in ONE fold", () => {
    const rows = aggregatePlayerStats(
      [
        goal(1, "p7"),
        env(2, "football.card", { by: "H", person: "coach1", color: "yellow" }),
      ],
      MODEL,
      lineupWithCoach,
    );
    expect(rows).toEqual([{ personId: "p7", stats: { goals: 1, points: 1 } }]);
  });

  it("with no lineup argument at all, behaviour is byte-identical to before (back-compat)", () => {
    // Every existing call site that does not yet pass a roster (the DB has no
    // column to carry role into one today — see the PR body) must keep
    // aggregating every personId it sees, exactly as it always has.
    const rows = aggregatePlayerStats(
      [env(1, "football.card", { by: "H", person: "coach1", color: "yellow" })],
      MODEL,
    );
    // `points` is football's derived stat (goals + assists), always computed
    // for every row the main loop produces — unrelated to this test's point,
    // present here only because MODEL is the real football model.
    expect(rows).toEqual([{ personId: "coach1", stats: { yellow_cards: 1, points: 0 } }]);
  });
});
