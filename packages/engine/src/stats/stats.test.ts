// Player-stats fold tests (Jul3/07, PROMPT-27 acceptance).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  resolvePayloadPath,
  sumPlayerStats,
} from "./stats.ts";
import { football } from "../sports/football/football.ts";
import type { PlayerStatMetric, PlayerStatsFoldCtx, PlayerStatsModel } from "./stats.ts";
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

// ---------------------------------------------------------------------------
// S8/#417 — entrant→person attribution, computed values, folded models.
//
// THE PROBLEM: setbased/nested payloads carry a REQUIRED EntrantId (`wonBy`,
// `by`) and only OPTIONAL person fields (`scorer`, `server`). A v1-era stream
// that never populated the optional person fields folds to zero rows today.
// `PlayerStatsFoldCtx` supplies what the fold cannot derive on its own: which
// entrants exist this fixture, their kind, and an entrant's member persons.
//
// Every test that exercises the entrant fallback deliberately makes the
// explicit-field answer and the entrant-fallback answer DISAGREE where the
// acceptance criterion calls for it — an input where both paths agree proves
// nothing (see fixture-choice-is-the-test in agent memory).
// ---------------------------------------------------------------------------
describe("entrant fallback attribution (S8/#417)", () => {
  it("an explicit person field beats the entrant fallback when BOTH resolve, on a deliberately conflicting fixture", () => {
    const model: PlayerStatsModel = {
      metrics: [
        {
          key: "k",
          label: "K",
          from: "x.rally",
          agg: "count",
          field: "scorer",
          entrantField: "wonBy",
          fromEntrant: true,
        },
      ],
    };
    // wonBy resolves (via personsOf) to p2 — a DIFFERENT person than the
    // explicit scorer, p1. If the entrant path fired at all, p2 would show
    // up in the output; it must not, and p1 must.
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E1", kind: "individual" }],
      personsOf: (id) => (id === "E1" ? ["p2"] : []),
    };
    const rows = aggregatePlayerStats(
      [env(1, "x.rally", { wonBy: "E1", scorer: "p1" })],
      model,
      undefined,
      ctx,
    );
    expect(rows).toEqual([{ personId: "p1", stats: { k: 1 } }]);
    expect(rows.find((r) => r.personId === "p2")).toBeUndefined();
  });

  it("a v1-era payload with no person fields falls back to an individual entrant's person", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E1", kind: "individual" }],
      personsOf: (id) => (id === "E1" ? ["p9"] : []),
    };
    const rows = aggregatePlayerStats([env(1, "x.rally", { wonBy: "E1" })], model, undefined, ctx);
    expect(rows).toEqual([{ personId: "p9", stats: { k: 1 } }]);
  });

  it("a pair entrant credits BOTH persons", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E2", kind: "pair" }],
      personsOf: (id) => (id === "E2" ? ["p1", "p2"] : []),
    };
    const rows = aggregatePlayerStats([env(1, "x.rally", { wonBy: "E2" })], model, undefined, ctx);
    expect(rows).toEqual([
      { personId: "p1", stats: { k: 1 } },
      { personId: "p2", stats: { k: 1 } },
    ]);
  });

  it("a team entrant credits NOBODY, even when personsOf hands back a full roster (engine-side kind guard)", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    // personsOf deliberately returns 11 ids — a caller that forgot to make a
    // team entrant answer [] must still be caught HERE, at the engine
    // boundary, not trusted to have done it upstream.
    const fatRoster = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E3", kind: "team" }],
      personsOf: (id) => (id === "E3" ? fatRoster : []),
    };
    const rows = aggregatePlayerStats([env(1, "x.rally", { wonBy: "E3" })], model, undefined, ctx);
    expect(rows).toEqual([]);
  });

  it("an entrant id absent from ctx.entrants credits nobody, even when personsOf answers for it anyway", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [], // E9 is never declared this fixture
      personsOf: (id) => (id === "E9" ? ["p1", "p2"] : []),
    };
    const rows = aggregatePlayerStats([env(1, "x.rally", { wonBy: "E9" })], model, undefined, ctx);
    expect(rows).toEqual([]);
  });

  it("with no ctx at all, fromEntrant metrics are inert — every pre-existing caller keeps working unchanged", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const rows = aggregatePlayerStats([env(1, "x.rally", { wonBy: "E1" })], model);
    expect(rows).toEqual([]);
  });

  it("a voided event un-counts an entrant-fallback credit too, not just an explicit-field one", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E1", kind: "individual" }],
      personsOf: (id) => (id === "E1" ? ["p9"] : []),
    };
    const rows = aggregatePlayerStats(
      [env(1, "x.rally", { wonBy: "E1" }), env(2, "core.void", {}, "e1")],
      model,
      undefined,
      ctx,
    );
    expect(rows).toEqual([]);
  });
});

describe("computed sum values via PlayerStatMetric.value (S8/#417)", () => {
  it("value() returning undefined contributes NOTHING (row absent); returning 0 records a real 0 (row present)", () => {
    const model: PlayerStatsModel = {
      metrics: [
        {
          key: "k",
          label: "K",
          from: "x.ball",
          field: "striker",
          agg: "sum",
          value: (p) => (p.made === true ? (p.pts as number) : undefined),
        },
      ],
    };
    const rows = aggregatePlayerStats(
      [
        env(1, "x.ball", { striker: "p1", made: false }), // value() → undefined
        env(2, "x.ball", { striker: "p2", made: true, pts: 0 }), // value() → 0
      ],
      model,
    );
    // p1 has NO row at all — distinguishable from a row carrying k:0.
    expect(rows).toEqual([{ personId: "p2", stats: { k: 0 } }]);
    expect(rows.find((r) => r.personId === "p1")).toBeUndefined();
  });

  it("value takes precedence over sumField when both are declared", () => {
    const model: PlayerStatsModel = {
      metrics: [
        {
          key: "k",
          label: "K",
          from: "x.ball",
          field: "striker",
          agg: "sum",
          sumField: "runs.bat",
          value: () => 99,
        },
      ],
    };
    const rows = aggregatePlayerStats([env(1, "x.ball", { striker: "p1", runs: { bat: 4 } })], model);
    expect(rows).toEqual([{ personId: "p1", stats: { k: 99 } }]);
  });
});

describe("folded models (S8/#417)", () => {
  it("folded.fold receives the VOID-RESOLVED event list — a voided rally un-counts, a live one still counts", () => {
    // Two rallies, one voided: if `fold` saw the RAW list (bug) both would
    // count (folded_k: 2); if it never ran at all (pre-feature) neither
    // would (no row); only the correct behaviour lands on exactly 1.
    const model: PlayerStatsModel = {
      metrics: [],
      folded: {
        keys: ["folded_k"],
        fold: (events, ctx) => {
          const counts = new Map<string, number>();
          for (const e of events) {
            if (e.type !== "x.rally") continue;
            const entrantId = (e.payload as Record<string, unknown>).wonBy;
            const entrant = ctx.entrants.find((x) => x.id === entrantId);
            if (entrant === undefined || entrant.kind === "team") continue;
            for (const p of ctx.personsOf(entrant.id)) counts.set(p, (counts.get(p) ?? 0) + 1);
          }
          return [...counts.entries()].map(([personId, v]) => ({ personId, stats: { folded_k: v } }));
        },
      },
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: "E1", kind: "individual" }],
      personsOf: (id) => (id === "E1" ? ["p5"] : []),
    };
    const rows = aggregatePlayerStats(
      [
        env(1, "x.rally", { wonBy: "E1" }),
        env(2, "core.void", {}, "e1"), // voids event 1 — must not count
        env(3, "x.rally", { wonBy: "E1" }), // NOT voided — must count
      ],
      model,
      undefined,
      ctx,
    );
    expect(rows).toEqual([{ personId: "p5", stats: { folded_k: 1 } }]);
  });

  it("folded rows merge with metric rows by ADDITION (not overwrite), and derived sees the merged totals", () => {
    const model: PlayerStatsModel = {
      metrics: [{ key: "goals", label: "Goals", from: "x.goal", field: "scorer", agg: "count" }],
      derived: [{ key: "total", label: "Total", derive: (s) => (s.goals ?? 0) + (s.assists_folded ?? 0) }],
      folded: {
        keys: ["assists_folded"],
        // Deliberately TWO rows for the same person under the SAME key —
        // addition gives 2, a last-write-wins merge would give 1.
        fold: () => [
          { personId: "p1", stats: { assists_folded: 1 } },
          { personId: "p1", stats: { assists_folded: 1 } },
        ],
      },
    };
    const ctx: PlayerStatsFoldCtx = { entrants: [], personsOf: () => [] };
    const rows = aggregatePlayerStats([env(1, "x.goal", { scorer: "p1" })], model, undefined, ctx);
    expect(rows).toEqual([{ personId: "p1", stats: { goals: 1, assists_folded: 2, total: 3 } }]);
  });

  it("folded is a no-op when ctx is omitted, even when the model declares it (runs only when ctx is supplied)", () => {
    const model: PlayerStatsModel = {
      metrics: [{ key: "goals", label: "Goals", from: "x.goal", field: "scorer", agg: "count" }],
      folded: {
        keys: ["assists_folded"],
        fold: () => [{ personId: "p1", stats: { assists_folded: 5 } }],
      },
    };
    const rows = aggregatePlayerStats([env(1, "x.goal", { scorer: "p1" })], model);
    expect(rows).toEqual([{ personId: "p1", stats: { goals: 1 } }]);
  });

  it("folded rows are excluded for a non-player exactly like metric rows (S4/#428 discipline extended)", () => {
    const lineup: LineupPair = {
      home: {
        entrantId: "H",
        slots: [
          { personId: "p7", slot: "starting", orderNo: 1 },
          { personId: "coach1", slot: "bench", orderNo: 90, role: "coach" },
        ],
      },
      away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
    };
    const model: PlayerStatsModel = {
      metrics: [],
      folded: {
        keys: ["assists_folded"],
        fold: () => [
          { personId: "coach1", stats: { assists_folded: 3 } },
          { personId: "p7", stats: { assists_folded: 1 } },
        ],
      },
    };
    const ctx: PlayerStatsFoldCtx = { entrants: [], personsOf: () => [] };
    const rows = aggregatePlayerStats([], model, lineup, ctx);
    expect(rows).toEqual([{ personId: "p7", stats: { assists_folded: 1 } }]);
  });

  it("folding the same events+ctx twice yields deeply equal rows in stable order (determinism)", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "k", label: "K", from: "x.rally", agg: "count", entrantField: "wonBy", fromEntrant: true },
      ],
    };
    const ctx: PlayerStatsFoldCtx = {
      entrants: [
        { id: "E1", kind: "pair" },
        { id: "E2", kind: "individual" },
      ],
      personsOf: (id) => (id === "E1" ? ["p2", "p1"] : id === "E2" ? ["p9"] : []),
    };
    const events = [
      env(1, "x.rally", { wonBy: "E1" }),
      env(2, "x.rally", { wonBy: "E2" }),
      env(3, "x.rally", { wonBy: "E1" }),
    ];
    const first = aggregatePlayerStats(events, model, undefined, ctx);
    const second = aggregatePlayerStats(events, model, undefined, ctx);
    expect(second).toEqual(first);
    expect(second.map((r) => r.personId)).toEqual(first.map((r) => r.personId));
  });
});

describe("playerStatsKeyCollisions (S8/#417)", () => {
  it("flags a folded key that collides with a metric key, and stays clean otherwise", () => {
    const colliding: PlayerStatsModel = {
      metrics: [{ key: "goals", label: "Goals", from: "x.goal", agg: "count" }],
      folded: { keys: ["goals", "assists_folded"], fold: () => [] },
    };
    expect(playerStatsKeyCollisions(colliding)).toEqual(["goals"]);

    const clean: PlayerStatsModel = {
      metrics: [{ key: "goals", label: "Goals", from: "x.goal", agg: "count" }],
      folded: { keys: ["assists_folded"], fold: () => [] },
    };
    expect(playerStatsKeyCollisions(clean)).toEqual([]);

    // No `folded` declared at all — trivially clean, not a crash.
    expect(playerStatsKeyCollisions({ metrics: [] })).toEqual([]);
  });
});

describe("sumPlayerStats handles a folded-origin key like a metric key (S8/#417)", () => {
  it("a folded-origin key sums across fixtures, and derived recomputes on the combined total", () => {
    const model: PlayerStatsModel = {
      metrics: [{ key: "goals", label: "Goals", from: "x.goal", agg: "count" }],
      derived: [{ key: "total", label: "Total", derive: (s) => (s.goals ?? 0) + (s.assists_folded ?? 0) }],
      folded: { keys: ["assists_folded"], fold: () => [] }, // shape only — rows below mirror its output
    };
    // Rows shaped as `aggregatePlayerStats` would hand back after merging a
    // folded contribution in — by the time `sumPlayerStats` sees them, a
    // folded-origin key is just a number under `.stats`, indistinguishable
    // from a metric-origin one, so it is exercised directly on that shape.
    const fixture1 = [{ personId: "p1", stats: { goals: 1, assists_folded: 2, total: 3 } }];
    const fixture2 = [{ personId: "p1", stats: { goals: 3, assists_folded: 1, total: 4 } }];
    const summed = sumPlayerStats([fixture1, fixture2], model);
    expect(summed).toEqual([{ personId: "p1", stats: { goals: 4, assists_folded: 3, total: 7 } }]);
  });
});
