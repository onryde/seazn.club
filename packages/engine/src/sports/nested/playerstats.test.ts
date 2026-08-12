// S8/#417 — kernel-level default playerStats for the nested (tennis) family:
// a v1-era stream that names only the point's EntrantId (`by`) must still
// produce person rows, via `PlayerStatsFoldCtx`. Mirrors
// `../setbased/playerstats.test.ts`; every test here deliberately makes the
// old (no entrant fallback) and new behaviour DISAGREE — see
// fixture-choice-is-the-test in agent memory.
import { describe, expect, it } from "vitest";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  type PlayerStatsFoldCtx,
} from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import type { EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { tennis } from "../tennis/tennis.ts";
import { makeNestedModule, type NestedPreset } from "./kernel.ts";

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

const point = (payload: Record<string, unknown>): ModuleEvent => ({
  type: "tennis.point",
  payload,
});

// A love game for `winner`: four points, none to the opponent — 0/15/30/40
// /game, no deuce ever entered.
function loveGame(winner: string): ModuleEvent[] {
  return Array.from({ length: 4 }, () => point({ by: winner }));
}

function ctx(
  entrants: PlayerStatsFoldCtx["entrants"],
  roster: Record<string, readonly string[]>,
  cfg?: unknown,
): PlayerStatsFoldCtx {
  return { entrants, personsOf: (id) => roster[id] ?? [], ...(cfg === undefined ? {} : { cfg }) };
}

// gamesTo:1/winBy:1/tiebreakAt:null makes one love GAME decide a whole SET,
// so a multi-set match replays cheaply while still exercising real
// `bankSet`/`setsWon` logic — never a shortcut through it.
const ONE_GAME_SETS = { set: { gamesTo: 1, winBy: 1, tiebreakAt: null, tiebreakTo: 7 } };

describe("kernel-default playerStats: points_won entrant fallback (S8/#417)", () => {
  it("a v1-era point stream (by only) credits points_won via an individual entrant's roster", () => {
    const events = envelopes([point({ by: "E1" }), point({ by: "E1" }), point({ by: "E2" })]);
    const rows = aggregatePlayerStats(
      events,
      tennis.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "individual" },
          { id: "E2", kind: "individual" },
        ],
        { E1: ["p1"], E2: ["p2"] },
      ),
    );
    expect(rows.find((r) => r.personId === "p1")?.stats.points_won).toBe(2);
    expect(rows.find((r) => r.personId === "p2")?.stats.points_won).toBe(1);
  });

  it("a pair entrant credits BOTH partners with points_won", () => {
    const rows = aggregatePlayerStats(
      envelopes([point({ by: "E1" })]),
      tennis.playerStats!,
      undefined,
      ctx([{ id: "E1", kind: "pair" }], { E1: ["p1a", "p1b"] }),
    );
    expect(rows.find((r) => r.personId === "p1a")?.stats.points_won).toBe(1);
    expect(rows.find((r) => r.personId === "p1b")?.stats.points_won).toBe(1);
  });

  it("a team-kind entrant credits nobody, even though personsOf returns a full roster (engine-side kind guard, same as the set-based kernel)", () => {
    const rows = aggregatePlayerStats(
      envelopes([point({ by: "E1" })]),
      tennis.playerStats!,
      undefined,
      ctx([{ id: "E1", kind: "team" }], { E1: ["a", "b"] }),
    );
    expect(rows).toEqual([]);
  });

  it("CONFLICTING attribution: an explicit scorer wins over the `by` entrant fallback, and the entrant's own person has no row at all", () => {
    const rows = aggregatePlayerStats(
      envelopes([point({ by: "E1", scorer: "P1" })]),
      tennis.playerStats!,
      undefined,
      ctx([{ id: "E1", kind: "individual" }], { E1: ["P2"] }),
    );
    expect(rows).toEqual([{ personId: "P1", stats: { points_won: 1, points: 1 } }]);
    expect(rows.find((r) => r.personId === "P2")).toBeUndefined();
  });
});

describe("kernel-default playerStats: folded match/set/game outcomes (S8/#417)", () => {
  it("matches/sets_won/sets_lost/games_won are correct for a completed multi-set fixture — including the side that never wins a point in a set it plays", () => {
    const cfg = tennis.configSchema.parse({ bestOf: 3, ...ONE_GAME_SETS });
    const events = envelopes([
      ...loveGame("E2"), // set 1 -> E2 (a single love game IS the set here)
      ...loveGame("E1"), // set 2 -> E1
      ...loveGame("E1"), // set 3 (decider) -> E1
    ]);
    const rows = aggregatePlayerStats(
      events,
      tennis.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "individual" },
          { id: "E2", kind: "individual" },
        ],
        { E1: ["p1"], E2: ["p2"] },
        cfg,
      ),
    );
    expect(rows).toEqual([
      { personId: "p1", stats: { points_won: 8, matches: 1, sets_won: 2, sets_lost: 1, games_won: 2 } },
      { personId: "p2", stats: { points_won: 4, matches: 1, sets_won: 1, sets_lost: 2, games_won: 1 } },
    ]);
  });

  it("folded matches/sets_won/sets_lost/games_won credit BOTH partners of a pair entrant identically, and the shut-out side's persons are still credited via ctx.entrants", () => {
    const cfg = tennis.configSchema.parse({ bestOf: 1, ...ONE_GAME_SETS });
    const rows = aggregatePlayerStats(
      envelopes(loveGame("E1")),
      tennis.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "pair" },
          { id: "E2", kind: "pair" },
        ],
        { E1: ["p1a", "p1b"], E2: ["p2a", "p2b"] },
        cfg,
      ),
    );
    expect(rows).toEqual([
      { personId: "p1a", stats: { points_won: 4, matches: 1, sets_won: 1, sets_lost: 0, games_won: 1 } },
      { personId: "p1b", stats: { points_won: 4, matches: 1, sets_won: 1, sets_lost: 0, games_won: 1 } },
      { personId: "p2a", stats: { matches: 1, sets_won: 0, sets_lost: 1, games_won: 0 } },
      { personId: "p2b", stats: { matches: 1, sets_won: 0, sets_lost: 1, games_won: 0 } },
    ]);
  });

  it("ctx supplied but ctx.cfg absent: matches still fires (needs no cfg), but sets_won/sets_lost/games_won do not appear at all (set-boundary detection needs cfg)", () => {
    const rows = aggregatePlayerStats(
      envelopes([point({ by: "E1" })]),
      tennis.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "individual" },
          { id: "E2", kind: "individual" },
        ],
        { E1: ["p1"], E2: ["p2"] },
        // no 4th arg: cfg is genuinely absent, not merely `{}`
      ),
    );
    expect(rows).toEqual([
      { personId: "p1", stats: { points_won: 1, matches: 1 } },
      { personId: "p2", stats: { matches: 1 } },
    ]);
    expect(rows.find((r) => r.personId === "p1")?.stats).not.toHaveProperty("sets_won");
    expect(rows.find((r) => r.personId === "p2")?.stats).not.toHaveProperty("games_won");
  });

  it("a team-kind entrant is credited nothing by the folded path either", () => {
    const cfg = tennis.configSchema.parse({ bestOf: 1, ...ONE_GAME_SETS });
    const rows = aggregatePlayerStats(
      envelopes(loveGame("E1")),
      tennis.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "team" },
          { id: "E2", kind: "team" },
        ],
        { E1: ["a", "b"], E2: ["c", "d"] },
        cfg,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("a core.void over a point reduces the folded sets_won total too, not just points_won", () => {
    const cfg = tennis.configSchema.parse({ bestOf: 1, ...ONE_GAME_SETS });
    const c = ctx(
      [
        { id: "E1", kind: "individual" },
        { id: "E2", kind: "individual" },
      ],
      { E1: ["p1"], E2: ["p2"] },
      cfg,
    );
    const pts = loveGame("E1"); // 4 points, clinches the (one-game) set at the 4th
    const clean = aggregatePlayerStats(envelopes(pts), tennis.playerStats!, undefined, c);
    expect(clean.find((r) => r.personId === "p1")?.stats.sets_won).toBe(1);

    const voided: EventEnvelope[] = [
      makeEnvelope(0, pts[0]!),
      makeEnvelope(1, pts[1]!),
      makeEnvelope(2, pts[2]!),
      makeEnvelope(3, pts[3]!),
      makeEnvelope(4, { type: "core.void", payload: {} }, "e-3"), // voids the clinching 4th point
    ];
    const withVoid = aggregatePlayerStats(voided, tennis.playerStats!, undefined, c);
    expect(withVoid.find((r) => r.personId === "p1")?.stats.sets_won ?? 0).toBe(0);
  });

  it("folding the same stream+ctx twice yields deeply equal rows (determinism)", () => {
    const cfg = tennis.configSchema.parse({ bestOf: 1, ...ONE_GAME_SETS });
    const c = ctx(
      [
        { id: "E1", kind: "individual" },
        { id: "E2", kind: "individual" },
      ],
      { E1: ["p1"], E2: ["p2"] },
      cfg,
    );
    const events = envelopes(loveGame("E1"));
    const first = aggregatePlayerStats(events, tennis.playerStats!, undefined, c);
    const second = aggregatePlayerStats(events, tennis.playerStats!, undefined, c);
    expect(second).toEqual(first);
  });
});

describe("kernel-default playerStats: merge + collisions (S8/#417)", () => {
  it("playerStatsKeyCollisions is empty for tennis", () => {
    expect(playerStatsKeyCollisions(tennis.playerStats!)).toEqual([]);
  });

  it("with no ctx at all: matches/sets_won/sets_lost/games_won never appear, and pre-existing metrics are unchanged (points_won still fires from an explicit scorer)", () => {
    const rows = aggregatePlayerStats(
      envelopes([point({ by: "E1", scorer: "H-p1" })]),
      tennis.playerStats!,
    );
    expect(rows).toEqual([{ personId: "H-p1", stats: { points: 1, points_won: 1 } }]);
  });

  it("a preset-declared metric key wins over a kernel default of the same key (merge precedence)", () => {
    const preset: NestedPreset = {
      key: "precedencetest",
      version: "1.0.0",
      defaults: {
        bestOf: 3,
        set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
        finalSet: "same",
        game: { noAd: false },
        tiebreak: { winBy: 2 },
        points: { win: 2, loss: 0 },
      },
      variants: {},
      positions: { groups: [], lineup: { size: 1, benchMax: 1 } },
      defaultTiebreakers: ["points"],
      officialLabel: { scorer: "Umpire" },
      rallyEntitlement: "scoring.rally_by_rally",
      playerStats: {
        metrics: [
          {
            key: "points_won",
            label: "OVERRIDDEN BY PRESET",
            from: "precedencetest.point",
            field: "custom_person_field",
            agg: "count",
          },
        ],
      },
    };
    const mod = makeNestedModule(preset);
    const metric = mod.playerStats!.metrics.find((m) => m.key === "points_won");
    expect(metric?.label).toBe("OVERRIDDEN BY PRESET");
    expect(metric?.field).toBe("custom_person_field");
    // the kernel default's own shape (entrant fallback) did NOT survive on this key
    expect(metric?.fromEntrant).toBeUndefined();
    expect(metric?.entrantField).toBeUndefined();
    // the kernel default's FOLDED half is untouched by the merge
    expect(mod.playerStats!.folded?.keys).toEqual([
      { key: "matches", label: "Matches" },
      { key: "sets_won", label: "Sets won" },
      { key: "sets_lost", label: "Sets lost" },
      { key: "games_won", label: "Games won" },
    ]);
  });

  // S8/#417 W6 fix 4 — `mergePlayerStats`'s combined `fold` used to declare
  // `(events, ctx) => [...]`, silently dropping the 3rd `lineups` argument
  // `aggregatePlayerStats` always passes through. Dead today because no
  // preset on this kernel declares its OWN `folded` — this preset does,
  // purely to prove the merge forwards `lineups` rather than swallowing it.
  it("mergePlayerStats forwards `lineups` to a preset-declared fold, not just the kernel default", () => {
    let captured: LineupPair | undefined | "never called" = "never called";
    const preset: NestedPreset = {
      key: "lineupforwardtest",
      version: "1.0.0",
      defaults: {
        bestOf: 3,
        set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
        finalSet: "same",
        game: { noAd: false },
        tiebreak: { winBy: 2 },
        points: { win: 2, loss: 0 },
      },
      variants: {},
      positions: { groups: [], lineup: { size: 1, benchMax: 1 } },
      defaultTiebreakers: ["points"],
      officialLabel: { scorer: "Umpire" },
      rallyEntitlement: "scoring.rally_by_rally",
      playerStats: {
        metrics: [],
        folded: {
          keys: [{ key: "preset_folded_k", label: "Preset folded k" }],
          fold: (_events, _ctx, lineups) => {
            captured = lineups;
            return [];
          },
        },
      },
    };
    const mod = makeNestedModule(preset);
    const lineup: LineupPair = {
      home: { entrantId: "E1", slots: [{ personId: "p1", slot: "starting", orderNo: 1 }] },
      away: { entrantId: "E2", slots: [{ personId: "p2", slot: "starting", orderNo: 1 }] },
    };
    const c = ctx(
      [
        { id: "E1", kind: "individual" },
        { id: "E2", kind: "individual" },
      ],
      { E1: ["p1"], E2: ["p2"] },
    );
    // 4-arg call, matching the real production call shape once BOTH lineups
    // and ctx are present, so the merged fold actually runs.
    aggregatePlayerStats([], mod.playerStats!, lineup, c);
    expect(captured).toEqual(lineup);
  });
});
