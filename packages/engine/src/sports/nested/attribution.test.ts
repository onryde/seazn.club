// W4 domain audit (#407) — person attribution + code violations for the nested
// (tennis) kernel. Additive: a point that names nobody folds exactly as it did
// before W4, which the frozen tennis golden corpus proves independently.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "../tennis/tennis.ts";
import { NestedEv, type NestedState } from "./kernel.ts";

const lineups = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function fold(events: ModuleEvent[], raw: unknown = {}): NestedState {
  return foldMatch(
    tennis,
    tennis.configSchema.parse(raw),
    lineups,
    envelopes([{ type: "core.start", payload: {} }, ...events]),
  );
}

const point = (payload: Record<string, unknown>): ModuleEvent => ({
  type: "tennis.point",
  payload,
});

// ---------------------------------------------------------------------------
// The chair umpire's card records who served every point and (in doubles) who
// won it — the entrant-only point could express neither.
// ---------------------------------------------------------------------------
describe("tennis point: optional person attribution", () => {
  // W4 review item 4 — the person credited with a point is `scorer` in every
  // module that names one (football's goal has carried it since before this
  // wave, and set-based rallies adopted it). Tennis called him `winner`, which
  // is already an EntrantId across the whole engine (`MatchOutcome.winner`):
  // one key, two meanings, on the same fixture.
  it("names the point's person `scorer`, and refuses the old `winner` key", () => {
    const state = fold([point({ by: H, server: "H-p1", scorer: "H-p1" })]);
    expect(state.persons?.["H-p1"]).toEqual({ points: 1, serves: 1, aces: 0, doubleFaults: 0 });
    expect(() => fold([point({ by: H, server: "H-p1", winner: "H-p1" })])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  // The SHOT TYPE `winner` is a different fact on a different level and keeps
  // its own name — a tennis scorer would not recognise anything else.
  it("keeps `winner` as a shot type, where tennis actually uses the word", () => {
    const state = fold([point({ by: H, server: "H-p1", scorer: "H-p1", meta: { kind: "winner" } })]);
    expect(state.persons?.["H-p1"]?.points).toBe(1);
  });

  it("credits the point winner and the server", () => {
    const state = fold([
      point({ by: H, server: "H-p1", scorer: "H-p1" }),
      point({ by: A, server: "H-p1", scorer: "A-p1" }),
      point({ by: H, server: "H-p1", scorer: "H-p1" }),
    ]);
    expect(state.persons).toEqual({
      "H-p1": { points: 2, serves: 3, aces: 0, doubleFaults: 0 },
      "A-p1": { points: 1, serves: 0, aces: 0, doubleFaults: 0 },
    });
    // The entrant-level game score is untouched by attribution.
    expect(state.points).toMatchObject({ kind: "standard", home: 2, away: 1 });
  });

  it("credits an ace and a double fault to the SERVER, whoever won the point", () => {
    const state = fold([
      point({ by: H, server: "H-p1", scorer: "H-p1", meta: { kind: "ace" } }),
      point({ by: A, server: "H-p1", scorer: "A-p1", meta: { kind: "double_fault" } }),
    ]);
    expect(state.persons?.["H-p1"]).toEqual({ points: 1, serves: 2, aces: 1, doubleFaults: 1 });
    expect(state.persons?.["A-p1"]).toEqual({ points: 1, serves: 0, aces: 0, doubleFaults: 0 });
  });

  it("attributes tie-break points too", () => {
    const events: ModuleEvent[] = [];
    // 6-6: twelve games, alternating, each won to love.
    for (let game = 0; game < 12; game++) {
      const by = game % 2 === 0 ? H : A;
      for (let i = 0; i < 4; i++) events.push(point({ by }));
    }
    events.push(point({ by: H, server: "H-p1", scorer: "H-p1", meta: { kind: "ace" } }));
    const state = fold(events);
    expect(state.points.kind).toBe("tiebreak");
    expect(state.persons?.["H-p1"]).toEqual({ points: 1, serves: 1, aces: 1, doubleFaults: 0 });
  });

  it("leaves `persons` absent when no point names anyone", () => {
    const state = fold([point({ by: H }), point({ by: A })]);
    expect(state.persons).toBeUndefined();
    expect(Object.keys(state)).not.toContain("persons");
  });

  it("surfaces attribution in the summary detail (tennis has no coarsen hook)", () => {
    const state = fold([point({ by: H, server: "H-p1", scorer: "H-p1" })]);
    expect(tennis.summary(state).detail).toMatchObject({
      persons: { "H-p1": { points: 1, serves: 1, aces: 0, doubleFaults: 0 } },
    });
    expect(tennis.summary(fold([point({ by: H })])).detail).not.toHaveProperty("persons");
  });
});

// ---------------------------------------------------------------------------
// Code violations — the ITF penalty ladder (warning → point penalty → game
// penalty → default). The score consequence is entered as points; this row is
// the record of the violation, as on the chair's card.
// ---------------------------------------------------------------------------
describe("tennis code violations", () => {
  it("appends sanctions in order with the person when named", () => {
    const state = fold([
      { type: "tennis.sanction", payload: { by: H, level: "warning", person: "H-p1" } },
      { type: "tennis.sanction", payload: { by: H, level: "point_penalty" } },
    ]);
    expect(state.sanctions).toEqual([
      { by: "home", level: "warning", person: "H-p1" },
      { by: "home", level: "point_penalty" },
    ]);
    expect(tennis.summary(state).detail).toMatchObject({
      sanctions: [
        { by: "home", level: "warning", person: "H-p1" },
        { by: "home", level: "point_penalty" },
      ],
    });
  });

  it("accepts every step of the ITF ladder and no other", () => {
    for (const level of ["warning", "point_penalty", "game_penalty", "default"] as const) {
      expect(fold([{ type: "tennis.sanction", payload: { by: A, level } }]).sanctions?.[0]?.level)
        .toBe(level);
    }
    expect(() =>
      fold([{ type: "tennis.sanction", payload: { by: A, level: "red_card" } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("does not touch the score", () => {
    const state = fold([
      point({ by: H }),
      { type: "tennis.sanction", payload: { by: A, level: "warning" } },
    ]);
    expect(state.points).toMatchObject({ kind: "standard", home: 1, away: 0 });
    expect(state.games).toEqual({ home: 0, away: 0 });
  });

  it("leaves `sanctions` absent until one is issued", () => {
    expect(fold([point({ by: H })]).sanctions).toBeUndefined();
  });

  // W4 review — the branch could not say WHICH violation. The ITF ladder is
  // cumulative on the offence as much as on the step, and the whole rationale
  // for `DisciplineCard.reason` (core/types.ts) is an accumulation rule keyed
  // on it. The chair writes the offence on the card; the ledger could not.
  it("carries the chair's offence without moving the fold", () => {
    const withReason = fold([
      { type: "tennis.sanction", payload: { by: H, level: "warning", reason: "racquet abuse" } },
    ]);
    const without = fold([{ type: "tennis.sanction", payload: { by: H, level: "warning" } }]);
    // A discipline fact, not a scoring one: `reason` reaches the projection,
    // never the state record (which is what the frozen corpus pins).
    expect(withReason.sanctions).toEqual(without.sanctions);
    expect(
      tennis.discipline!.extractCards([
        makeEnvelope(0, {
          type: "tennis.sanction",
          payload: { by: H, person: "H-p1", level: "warning", reason: "racquet abuse" },
        }),
      ]),
    ).toEqual([
      {
        personId: "H-p1",
        entrantSide: H,
        color: "warning",
        eventId: "e-0",
        reason: "racquet abuse",
      },
    ]);
  });

  it("rejects an empty offence", () => {
    expect(() =>
      fold([{ type: "tennis.sanction", payload: { by: H, level: "warning", reason: "" } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation — widening the point branch must not let it swallow the
// set summary or the sanction (z.union takes the first branch that parses).
// ---------------------------------------------------------------------------
describe("nested event union stays unambiguous", () => {
  const canonical: Array<[label: string, payload: Record<string, unknown>]> = [
    ["bare point", { by: H }],
    ["attributed point", { by: H, server: "H-p1", scorer: "H-p1" }],
    ["point with meta", { by: H, meta: { kind: "ace" } }],
    ["set summary", { home: 6, away: 4 }],
    ["tie-break set summary", { home: 7, away: 6, tb: { home: 7, away: 5 } }],
    ["sanction", { by: H, level: "warning", person: "H-p1" }],
    // W4 review — the WIDENED sanction branch, fully attributed. `NestedPoint`
    // comes FIRST in the union and zod strips silently, so only an equality
    // round-trip can prove `reason` landed on the branch that declares it.
    ["sanction with an offence", { by: H, level: "warning", person: "H-p1", reason: "coaching" }],
  ];

  for (const [label, payload] of canonical) {
    it(`${label} parses against eventSchema and round-trips`, () => {
      const parsed = NestedEv.safeParse(payload);
      expect(parsed.success, label).toBe(true);
      expect(parsed.success && parsed.data).toEqual(payload);
    });
  }

  it("each canonical payload still folds to its own effect", () => {
    expect(fold([point({ by: H })]).points).toMatchObject({ home: 1, away: 0 });
    expect(
      fold([{ type: "tennis.set_summary", payload: { home: 6, away: 4 } }]).setsWon,
    ).toEqual({ home: 1, away: 0 });
    expect(
      fold([
        { type: "tennis.set_summary", payload: { home: 7, away: 6, tb: { home: 7, away: 5 } } },
      ]).sets[0],
    ).toMatchObject({ home: 7, away: 6, tb: { home: 7, away: 5 } });
    expect(
      fold([{ type: "tennis.sanction", payload: { by: H, level: "warning" } }]).sanctions,
    ).toHaveLength(1);
  });

  it("branches stay strict", () => {
    expect(NestedEv.safeParse({ by: H, bogus: 1 }).success).toBe(false);
    expect(NestedEv.safeParse({ home: 6, away: 4, bogus: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// playerStats + fidelity ladder.
// ---------------------------------------------------------------------------
describe("tennis playerStats", () => {
  it("aggregates points, service points, aces, double faults and violations", () => {
    const rows = aggregatePlayerStats(
      envelopes([
        { type: "core.start", payload: {} },
        point({ by: H, server: "H-p1", scorer: "H-p1", meta: { kind: "ace" } }),
        point({ by: H, server: "H-p1", scorer: "H-p1" }),
        point({ by: A, server: "H-p1", scorer: "A-p1", meta: { kind: "double_fault" } }),
        { type: "tennis.sanction", payload: { by: A, level: "warning", person: "A-p1" } },
      ]),
      tennis.playerStats!,
    );
    // S8/#417 — `points_won` is the kernel-default canonical metric (field:
    // "scorer" + entrant fallback); every point here already names an
    // explicit `scorer`, so it fires identically to "points" alongside it.
    // No ctx was supplied, so matches/sets_won/sets_lost/games_won (the
    // `folded` half) never appear — see playerstats.test.ts for that
    // mechanism on its own.
    expect(rows).toEqual([
      { personId: "A-p1", stats: { points: 1, violations: 1, points_won: 1 } },
      {
        personId: "H-p1",
        stats: { points: 2, service_points: 3, aces: 1, double_faults: 1, points_won: 2 },
      },
    ]);
  });

  it("the point sits at the max-detail band; the sanction sits at the admin band, never the bare score", () => {
    // W1: formerly asserted BOTH types were named in tier 3's array (the old
    // cumulative-list model lumped the admin-level sanction in with the
    // attributed-scoring tiers) and sanction was absent from tier 0.
    // padSpec.fidelity separates them: sanction is a band-1 admin record
    // (same band as interruption), point is band 3 (the kernel's max
    // detail) — see kernel.ts's own note. Neither is ever band 0.
    const spec = tennis.padSpec!(tennis.configSchema.parse({}));
    expect(spec.fidelity["tennis.point"]).toBe(3);
    expect(spec.fidelity["tennis.sanction"]).toBe(1);
    expect(spec.fidelity["tennis.sanction"]).not.toBe(0);
  });
});
