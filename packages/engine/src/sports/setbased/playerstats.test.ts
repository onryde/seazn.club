// S8/#417 — kernel-level default playerStats for the set-based family
// (volleyball/badminton/tabletennis): a v1-era stream that names only the
// rally's EntrantId (`wonBy`) must still produce person rows, via
// `PlayerStatsFoldCtx`. Companion to `attribution.test.ts` (which covers the
// pre-existing optional-person-field mechanism); this file is the NEW
// entrant-fallback + folded match/set outcomes mechanism only.
//
// Every test here deliberately makes the old (no entrant fallback) and new
// behaviour DISAGREE — see fixture-choice-is-the-test in agent memory — never
// an input both would answer the same way.
import { describe, expect, it } from "vitest";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  type PlayerStatsFoldCtx,
} from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import type { EventEnvelope } from "../../core/events.ts";
import { badminton } from "./badminton.ts";
import { makeSetBasedModule, type SetBasedPreset } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

type Mod = typeof volleyball;
const MODS: Mod[] = [volleyball, badminton, tabletennis];

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

const rally = (mod: Mod, payload: Record<string, unknown>): ModuleEvent => ({
  type: `${mod.key}.rally`,
  payload,
});

// Builds a legal rally sequence for ONE set: the loser's points all come
// first, then a run of the winner's — so the set predicate is satisfied only
// on the LAST rally, never early on a leading run of the eventual winner
// (which would also parse under a broken "first N rallies decide it" fold).
function setRallies(
  mod: Mod,
  winner: string,
  loser: string,
  winnerScore: number,
  loserScore: number,
): ModuleEvent[] {
  const out: ModuleEvent[] = [];
  for (let i = 0; i < loserScore; i++) out.push(rally(mod, { wonBy: loser }));
  for (let i = 0; i < winnerScore; i++) out.push(rally(mod, { wonBy: winner }));
  return out;
}

function ctx(
  entrants: PlayerStatsFoldCtx["entrants"],
  roster: Record<string, readonly string[]>,
  cfg?: unknown,
): PlayerStatsFoldCtx {
  return { entrants, personsOf: (id) => roster[id] ?? [], ...(cfg === undefined ? {} : { cfg }) };
}

describe("kernel-default playerStats: points_won entrant fallback (S8/#417)", () => {
  it("a v1-era rally stream (wonBy only) credits points_won via an individual entrant's roster — all three set-based sports", () => {
    for (const mod of MODS) {
      const events = envelopes([
        rally(mod, { wonBy: "E1" }),
        rally(mod, { wonBy: "E1" }),
        rally(mod, { wonBy: "E2" }),
      ]);
      const rows = aggregatePlayerStats(
        events,
        mod.playerStats!,
        undefined,
        ctx(
          [
            { id: "E1", kind: "individual" },
            { id: "E2", kind: "individual" },
          ],
          { E1: ["p1"], E2: ["p2"] },
        ),
      );
      expect(rows.find((r) => r.personId === "p1")?.stats.points_won, mod.key).toBe(2);
      expect(rows.find((r) => r.personId === "p2")?.stats.points_won, mod.key).toBe(1);
    }
  });

  it("a pair entrant credits BOTH partners with points_won — all three set-based sports", () => {
    for (const mod of MODS) {
      const rows = aggregatePlayerStats(
        envelopes([rally(mod, { wonBy: "E1" })]),
        mod.playerStats!,
        undefined,
        ctx([{ id: "E1", kind: "pair" }], { E1: ["p1a", "p1b"] }),
      );
      expect(rows.find((r) => r.personId === "p1a")?.stats.points_won, mod.key).toBe(1);
      expect(rows.find((r) => r.personId === "p1b")?.stats.points_won, mod.key).toBe(1);
    }
  });

  it("a team entrant (volleyball's real case) credits nobody, even though personsOf returns a full squad", () => {
    const fatRoster = Array.from({ length: 6 }, (_, i) => `v${i}`);
    const rows = aggregatePlayerStats(
      envelopes([rally(volleyball, { wonBy: "E1" })]),
      volleyball.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "team" },
          { id: "E2", kind: "team" },
        ],
        { E1: fatRoster, E2: fatRoster },
      ),
    );
    expect(rows).toEqual([]);
  });

  it("CONFLICTING attribution: an explicit scorer wins over the wonBy entrant fallback, and the entrant's own person has no row at all", () => {
    for (const mod of MODS) {
      // E1's roster answers P2 — a DIFFERENT person than the explicit scorer
      // P1. If the entrant path fired at all, P2 would show up; it must not.
      const rows = aggregatePlayerStats(
        envelopes([rally(mod, { wonBy: "E1", scorer: "P1" })]),
        mod.playerStats!,
        undefined,
        ctx([{ id: "E1", kind: "individual" }], { E1: ["P2"] }),
      );
      expect(rows, mod.key).toEqual([{ personId: "P1", stats: { points_won: 1, points: 1 } }]);
      expect(rows.find((r) => r.personId === "P2"), mod.key).toBeUndefined();
    }
  });
});

describe("kernel-default playerStats: folded match/set outcomes (S8/#417)", () => {
  it("matches/sets_won/sets_lost are correct for a completed multi-set fixture — including the side that never wins a rally in the deciding set", () => {
    const cfg = volleyball.configSchema.parse({ bestOf: 3, setTo: 3, finalSetTo: 3, winBy: 2 });
    const events = envelopes([
      ...setRallies(volleyball, "E1", "E2", 3, 1), // set 1 -> E1, 3-1
      ...setRallies(volleyball, "E2", "E1", 3, 0), // set 2 -> E2, 3-0
      ...setRallies(volleyball, "E1", "E2", 4, 2), // set 3 (decider) -> E1, 4-2
    ]);
    const rows = aggregatePlayerStats(
      events,
      volleyball.playerStats!,
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
      { personId: "p1", stats: { points_won: 7, matches: 1, sets_won: 2, sets_lost: 1 } },
      { personId: "p2", stats: { points_won: 6, matches: 1, sets_won: 1, sets_lost: 2 } },
    ]);
  });

  it("folded matches/sets_won/sets_lost credit BOTH partners of a pair entrant identically, and the shut-out side's persons are still credited via ctx.entrants even though that entrant never wins a rally", () => {
    const cfg = volleyball.configSchema.parse({ bestOf: 1, setTo: 3, finalSetTo: 3, winBy: 2 });
    const rows = aggregatePlayerStats(
      envelopes(setRallies(volleyball, "E1", "E2", 3, 0)),
      volleyball.playerStats!,
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
      { personId: "p1a", stats: { points_won: 3, matches: 1, sets_won: 1, sets_lost: 0 } },
      { personId: "p1b", stats: { points_won: 3, matches: 1, sets_won: 1, sets_lost: 0 } },
      { personId: "p2a", stats: { matches: 1, sets_won: 0, sets_lost: 1 } },
      { personId: "p2b", stats: { matches: 1, sets_won: 0, sets_lost: 1 } },
    ]);
  });

  it("ctx supplied but ctx.cfg absent: matches still fires (needs no cfg), but sets_won/sets_lost do not appear at all (set-boundary detection needs cfg)", () => {
    const rows = aggregatePlayerStats(
      envelopes([rally(volleyball, { wonBy: "E1" })]),
      volleyball.playerStats!,
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
    expect(rows.find((r) => r.personId === "p2")?.stats).not.toHaveProperty("sets_lost");
  });

  it("a team entrant is credited nothing by the folded path either — the requires_detailed_scoring posture is designed, not a gap to fix", () => {
    const cfg = volleyball.configSchema.parse({ bestOf: 1, setTo: 3, finalSetTo: 3, winBy: 2 });
    const fatRoster = Array.from({ length: 6 }, (_, i) => `v${i}`);
    const rows = aggregatePlayerStats(
      envelopes(setRallies(volleyball, "E1", "E2", 3, 0)),
      volleyball.playerStats!,
      undefined,
      ctx(
        [
          { id: "E1", kind: "team" },
          { id: "E2", kind: "team" },
        ],
        { E1: fatRoster, E2: fatRoster },
        cfg,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("a core.void over a rally reduces the folded sets_won total too, not just points_won", () => {
    const cfg = volleyball.configSchema.parse({ bestOf: 1, setTo: 3, finalSetTo: 3, winBy: 2 });
    const c = ctx(
      [
        { id: "E1", kind: "individual" },
        { id: "E2", kind: "individual" },
      ],
      { E1: ["p1"], E2: ["p2"] },
      cfg,
    );
    const rallies = setRallies(volleyball, "E1", "E2", 3, 0); // 3 straight E1 rallies, clinches at the 3rd
    const clean = aggregatePlayerStats(envelopes(rallies), volleyball.playerStats!, undefined, c);
    expect(clean.find((r) => r.personId === "p1")?.stats.sets_won).toBe(1);

    const voided: EventEnvelope[] = [
      makeEnvelope(0, rallies[0]!),
      makeEnvelope(1, rallies[1]!),
      makeEnvelope(2, rallies[2]!),
      makeEnvelope(3, { type: "core.void", payload: {} }, "e-2"), // voids the clinching 3rd rally
    ];
    const withVoid = aggregatePlayerStats(voided, volleyball.playerStats!, undefined, c);
    expect(withVoid.find((r) => r.personId === "p1")?.stats.sets_won ?? 0).toBe(0);
  });

  it("folding the same stream+ctx twice yields deeply equal rows (determinism)", () => {
    const cfg = volleyball.configSchema.parse({ bestOf: 1, setTo: 3, finalSetTo: 3, winBy: 2 });
    const c = ctx(
      [
        { id: "E1", kind: "individual" },
        { id: "E2", kind: "individual" },
      ],
      { E1: ["p1"], E2: ["p2"] },
      cfg,
    );
    const events = envelopes(setRallies(volleyball, "E1", "E2", 3, 1));
    const first = aggregatePlayerStats(events, volleyball.playerStats!, undefined, c);
    const second = aggregatePlayerStats(events, volleyball.playerStats!, undefined, c);
    expect(second).toEqual(first);
  });
});

describe("kernel-default playerStats: merge + collisions (S8/#417)", () => {
  it("playerStatsKeyCollisions is empty for every module on this kernel", () => {
    for (const mod of MODS) {
      expect(playerStatsKeyCollisions(mod.playerStats!), mod.key).toEqual([]);
    }
  });

  it("with no ctx at all: matches/sets_won/sets_lost never appear, and pre-existing metrics are unchanged (points_won still fires from an explicit scorer)", () => {
    const rows = aggregatePlayerStats(
      envelopes([rally(volleyball, { wonBy: "E1", scorer: "H-p1" })]),
      volleyball.playerStats!,
    );
    expect(rows).toEqual([{ personId: "H-p1", stats: { points: 1, points_won: 1 } }]);
  });

  it("a preset-declared metric key wins over a kernel default of the same key (merge precedence)", () => {
    const preset: SetBasedPreset = {
      key: "precedencetest",
      version: "1.0.0",
      defaults: {
        bestOf: 3,
        setTo: 3,
        finalSetTo: 3,
        winBy: 2,
        cap: null,
        pointsMap: { "*": [2, 0] },
        records: { timeouts: false, sanctions: false, substitutions: false, expedite: false },
      },
      variants: {},
      positions: { groups: [], lineup: { size: 1, benchMax: 1 } },
      unitLabel: { one: "Set", many: "Sets" },
      defaultTiebreakers: ["points"],
      officialLabel: { scorer: "Umpire" },
      coarseEventType: "set.summary",
      rallyEntitlement: "scoring.rally_by_rally",
      sanctionLevels: ["warning"],
      playerStats: {
        metrics: [
          {
            key: "points_won",
            label: "OVERRIDDEN BY PRESET",
            from: "precedencetest.rally",
            field: "custom_person_field",
            agg: "count",
          },
        ],
      },
    };
    const mod = makeSetBasedModule(preset);
    const metric = mod.playerStats!.metrics.find((m) => m.key === "points_won");
    expect(metric?.label).toBe("OVERRIDDEN BY PRESET");
    expect(metric?.field).toBe("custom_person_field");
    // the kernel default's own shape (entrant fallback) did NOT survive on this key
    expect(metric?.fromEntrant).toBeUndefined();
    expect(metric?.entrantField).toBeUndefined();
    // the kernel default's FOLDED half is untouched by the merge — this fake
    // preset declares no `folded` of its own, so `matches`/`sets_won`/
    // `sets_lost` still come from the kernel default, not lost alongside the
    // overridden metric.
    expect(mod.playerStats!.folded?.keys).toEqual(["matches", "sets_won", "sets_lost"]);
  });
});
