// S3/W4b (#426) pass B — the period kernel adopting the kernel-owned squad
// model (`core/lineup.ts`) for field hockey and ice hockey.
//
// Two deferred dossier rows are settled here and both are about ON-FIELD
// PERSONNEL, which no period State could express before:
//
//   * `hockey/DOMAIN.md` — "goalkeeper, field player with goalkeeping
//     privileges, or no keeper at all". The catalog half was already solved
//     (`positionsFor(cfg)` drops the GK minimum to 0 when a competition sets
//     `goalkeeper: "optional"`); what was missing is that the fold could not
//     say WHO is in goal at any point after the team sheet.
//   * `icehockey/DOMAIN.md` — "goalkeeper changes; pulled goalie". Note the
//     row is NOT closed by `Ev.PeriodGoal.emptyNet`: that is a property of one
//     GOAL, recorded by the scorer, and it says nothing about who is on the
//     ice a minute earlier. The two facts are asserted apart below.
//
// Every assertion names a personId. "the squad has a GK key" is satisfied by a
// fold that never moved anyone.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import { memberOf, personsAtPosition } from "../../core/lineup.ts";
import type { Lineup, LineupPair, LineupSlot } from "../../core/types.ts";
import { resolvePositions, validateLineup } from "../../sport/catalog.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { aggregatePlayerStats, playerStatsKeyCollisions } from "../../stats/stats.ts";
import { hockey } from "../hockey/hockey.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import type { PeriodCfg, PeriodState } from "./kernel.ts";

// Every event is treated as NOT YET in the ledger, so the variant's own
// `lineupPolicy` applies. Without it the fold runs REPLAY_LINEUP_POLICY —
// every knob at its most permissive — and a policy test asserts nothing.
const STRICT_ALL = { strictFromSeq: 0 } as const;

interface SideSpec {
  entrantId: string;
  keeper: string | null; // the group key, or null for a keeperless sheet
  outfield: string;
  size: number;
  bench: number;
}

function sheet(spec: SideSpec): Lineup {
  const { entrantId, keeper, outfield, size, bench } = spec;
  const starters: LineupSlot[] = Array.from({ length: size }, (_, i) => ({
    personId: `${entrantId}-p${i + 1}`,
    positionKey: i === 0 && keeper !== null ? keeper : outfield,
    slot: "starting" as const,
    orderNo: i + 1,
  }));
  const subs: LineupSlot[] = Array.from({ length: bench }, (_, i) => ({
    personId: `${entrantId}-b${i + 1}`,
    slot: "bench" as const,
    orderNo: size + i + 1,
  }));
  return { entrantId, slots: [...starters, ...subs] };
}

function pair(keeper: string | null, outfield: string, size: number): LineupPair {
  return {
    home: sheet({ entrantId: "H", keeper, outfield, size, bench: 5 }),
    away: sheet({ entrantId: "A", keeper, outfield, size, bench: 5 }),
  };
}

function fold(
  module: typeof hockey,
  cfg: PeriodCfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): PeriodState {
  return foldMatch(module, cfg, lineups, events, STRICT_ALL);
}

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

// ---------------------------------------------------------------------------
// hockey — FIH
// ---------------------------------------------------------------------------

describe("hockey — the keeper is nameable by identity for the whole fixture", () => {
  const cfg = hockey.configSchema.parse({});
  const lineups = pair("GK", "DF", 11);

  it("names the declared keeper from the kernel snapshot, by personId", () => {
    const { state, squads } = foldMatchWithStoppage(
      hockey,
      cfg,
      lineups,
      [ev(1, "core.start", {})],
      STRICT_ALL,
    );
    expect(personsAtPosition(squads.home, "GK")).toEqual(["H-p1"]);
    // …and the module keeps no copy of a sheet nobody has touched.
    expect(state.squads).toBeUndefined();
  });

  it("names the REPLACEMENT keeper after a substitution, by personId", () => {
    const state = fold(hockey, cfg, lineups, [
      ev(1, "core.start", {}),
      ev(2, "core.lineup.substitution", {
        side: "H",
        off: "H-p1",
        on: { personId: "H-b1", positionKey: "GK", slot: "starting", orderNo: 12 },
      }),
    ]);
    expect(personsAtPosition(state.squads!.home, "GK")).toEqual(["H-b1"]);
    expect(state.squads!.home.subsUsed).toBe(1);
  });

  it("permits the substituted keeper back on — FIH substitution is rolling", () => {
    // The rule under test: `lineupPolicy(cfg).reentry === "unlimited"`. Under
    // DEFAULT_LINEUP_POLICY (`reentry: "none"`) the fold throws LINEUP_INVALID
    // on the second event, which is the pre-change behaviour.
    const state = fold(hockey, cfg, lineups, [
      ev(1, "core.start", {}),
      ev(2, "core.lineup.substitution", {
        side: "H",
        off: "H-p1",
        on: { personId: "H-b1", positionKey: "GK", slot: "starting", orderNo: 12 },
      }),
      ev(3, "core.lineup.substitution", {
        side: "H",
        off: "H-b1",
        on: { personId: "H-p1", positionKey: "GK", slot: "starting", orderNo: 1 },
      }),
    ]);
    expect(personsAtPosition(state.squads!.home, "GK")).toEqual(["H-p1"]);
    expect(memberOf(state.squads!.home, "H-p1")?.timesOn).toBe(1);
  });

  it("lets a field player take the gloves without anyone leaving the pitch", () => {
    // FIH's "field player with goalkeeping privileges": a pure position move.
    // It bumps no counter anywhere in SquadState, so a module that decided
    // whether to persist by inspecting the squad for departures would silently
    // keep reporting H-p1 in goal.
    const state = fold(hockey, cfg, lineups, [
      ev(1, "core.start", {}),
      ev(2, "core.lineup.position", { side: "H", personId: "H-p2", positionKey: "GK" }),
    ]);
    expect(personsAtPosition(state.squads!.home, "GK")).toEqual(["H-p1", "H-p2"]);
  });

  it("records a keeperless side, and lets one of them take the gloves mid-match", () => {
    // The dossier row's third state: no keeper at all. `positionsFor(cfg)`
    // makes the TEAM SHEET legal; this is the fold half — the side is
    // keeperless as a folded fact, and a field player can acquire goalkeeping
    // privileges later without anyone leaving the pitch.
    const optional = hockey.configSchema.parse({ goalkeeper: "optional" });
    const keeperless = pair(null, "DF", 11);

    // The catalog half, asserted here rather than only in
    // `sport/positions-resolve.test.ts`, because the row is closed by BOTH
    // halves together and a reader of this file should be able to see that a
    // keeperless sheet is legal before watching it fold. Note the default
    // config still refuses it — the relaxation is the competition's to declare.
    expect(validateLineup(resolvePositions(hockey, cfg), keeperless.home)).toContainEqual({
      kind: "group_min",
      groupKey: "GK",
      min: 1,
      actual: 0,
    });
    expect(validateLineup(resolvePositions(hockey, optional), keeperless.home)).toEqual([]);

    const { squads } = foldMatchWithStoppage(
      hockey,
      optional,
      keeperless,
      [ev(1, "core.start", {})],
      STRICT_ALL,
    );
    expect(personsAtPosition(squads.home, "GK")).toEqual([]);

    const state = fold(hockey, optional, keeperless, [
      ev(1, "core.start", {}),
      ev(2, "core.lineup.position", { side: "H", personId: "H-p2", positionKey: "GK" }),
    ]);
    expect(personsAtPosition(state.squads!.home, "GK")).toEqual(["H-p2"]);
    expect(memberOf(state.squads!.home, "H-p1")?.positionKey).toBe("DF");
  });
});

describe("hockey — the adoption is additive", () => {
  const cfg = hockey.configSchema.parse({});

  it("writes no squad key at all for a team sheet nothing has touched", () => {
    // The eleven frozen corpora compare `JSON.stringify(state)` per event and
    // record no `core.lineup.*` event, so a snapshot written at init would
    // rebaseline six of them for a copy of the team sheet the caller already
    // holds. Absent-until-it-says-something is the contract.
    const state = fold(hockey, cfg, pair("GK", "DF", 11), [ev(1, "core.start", {})]);
    expect(JSON.stringify(state)).not.toContain('"squads"');
  });
});

// ---------------------------------------------------------------------------
// icehockey — IIHF
// ---------------------------------------------------------------------------

describe("icehockey — a pulled goalie is on-ice personnel, not a goal flag", () => {
  const cfg = icehockey.configSchema.parse({});
  const lineups = pair("G", "D", 6);

  const pulled = (seq: number): EventEnvelope =>
    ev(seq, "core.lineup.retirement", { side: "H", personId: "H-p1", reason: "goalie pulled" });

  it("leaves the net empty, and names the goalie who left", () => {
    const state = fold(icehockey, cfg, lineups, [ev(1, "core.start", {}), pulled(2)]);
    expect(personsAtPosition(state.squads!.home, "G")).toEqual([]);
    const goalie = memberOf(state.squads!.home, "H-p1");
    expect(goalie?.onField).toBe(false);
    // Recorded at the moment of leaving — the live `positionKey` is gone by
    // then, so nothing downstream could otherwise say the net is what emptied.
    expect(goalie?.lastPositionKey).toBe("G");
  });

  it("takes the goalie back — IIHF substitution is unlimited", () => {
    const state = fold(icehockey, cfg, lineups, [
      ev(1, "core.start", {}),
      pulled(2),
      ev(3, "core.lineup.entry", {
        side: "H",
        on: { personId: "H-p1", positionKey: "G", slot: "starting", orderNo: 1 },
      }),
    ]);
    expect(personsAtPosition(state.squads!.home, "G")).toEqual(["H-p1"]);
  });

  it("is a DIFFERENT fact from `emptyNet` on a goal", () => {
    // `emptyNet` is the scorer's note on one goal; it neither empties the net
    // nor refills it, and a pulled goalie sets it on nothing. A pass that
    // pointed at `emptyNet` and called the dossier row closed closed nothing.
    const withGoal = foldMatchWithStoppage(
      icehockey,
      cfg,
      lineups,
      [ev(1, "core.start", {}), ev(2, "icehockey.goal", { by: "A", emptyNet: true })],
      STRICT_ALL,
    );
    expect(withGoal.state.goalLog?.at(0)?.emptyNet).toBe(true);
    // The home goalie is still on the ice: the flag said nothing about him.
    expect(personsAtPosition(withGoal.squads.home, "G")).toEqual(["H-p1"]);

    const withPull = fold(icehockey, cfg, lineups, [ev(1, "core.start", {}), pulled(2)]);
    expect(withPull.goalLog).toBeUndefined();
    expect(personsAtPosition(withPull.squads!.home, "G")).toEqual([]);
  });
});

describe("both period codes reject nothing a lineup event can be recorded with", () => {
  it("a refusal on REPLAY is a no-op, never a throw", () => {
    // §3.3: cfg is read live and the stream replays on every read, so a fold
    // that threw on a cfg-derived condition would brick recorded fixtures.
    const cfg = hockey.configSchema.parse({});
    const lineups = pair("GK", "DF", 11);
    const events = [
      ev(1, "core.start", {}),
      // Nobody named `H-x1` is on the team sheet: structural, and even this is
      // absorbed on replay rather than thrown.
      ev(2, "core.lineup.entry", {
        side: "H",
        on: { personId: "H-x1", positionKey: "DF", slot: "starting", orderNo: 20 },
      }),
    ];
    expect(() => foldMatch(hockey, cfg, lineups, events)).not.toThrow();
    // …and IS refused on the write path.
    expect(() => foldMatch(hockey, cfg, lineups, events, STRICT_ALL)).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// S8/#417 — goalkeeper stats (`goals_conceded`, `clean_sheets`), fed by the
// SAME `core/lineup.ts` fold this file already pins for squad identity.
// `periodKeeperStatsFold` (`kernel.ts`) is the ONE implementation both codes
// share, so every scenario below runs against both `hockey` and `icehockey`
// — a change gated for one must not silently alter the other.
// ---------------------------------------------------------------------------
describe("S8/#417 — goalkeeper stats read the FOLD of core.lineup.*, never a kickoff snapshot", () => {
  interface KeeperSport {
    key: "hockey" | "icehockey";
    // `typeof hockey` and `typeof icehockey` are the SAME structural type
    // (both `makePeriodModule(...)`'s return), so a union of the two is a
    // lint error (`no-duplicate-type-constituents`) — one name covers both
    // runtime values.
    module: typeof hockey;
    keeperGroup: string;
    outfield: string;
    size: number;
  }
  const SPORTS: KeeperSport[] = [
    { key: "hockey", module: hockey, keeperGroup: "GK", outfield: "DF", size: 11 },
    { key: "icehockey", module: icehockey, keeperGroup: "G", outfield: "D", size: 6 },
  ];

  for (const sport of SPORTS) {
    describe(sport.key, () => {
      // `pair` (above) always assigns slot 1 the `keeper` group key — every
      // OTHER test in this file avoids that slot for scorer/assist ids for
      // exactly this reason; these tests deliberately use it.
      const lineups = pair(sport.keeperGroup, sport.outfield, sport.size);
      const model = sport.module.playerStats!;
      const goalType = `${sport.key}.goal`;
      const H = lineups.home.entrantId; // "H"
      const A = lineups.away.entrantId; // "A"
      const homeKeeper = lineups.home.slots[0]!.personId; // "H-p1"
      const awayKeeper = lineups.away.slots[0]!.personId; // "A-p1"
      const homeSub1 = "H-b1"; // first home bench player

      const start = ev(0, "core.start", {});
      const goal = (seq: number, by: string, extra?: Record<string, unknown>): EventEnvelope =>
        ev(seq, goalType, { by, ...(extra ?? {}) });
      const subKeeper = (seq: number, off: string, on: string): EventEnvelope =>
        ev(seq, "core.lineup.substitution", {
          side: H,
          off,
          on: { personId: on, positionKey: sport.keeperGroup, slot: "starting", orderNo: 90 },
        });
      // S8/#417 W6 — shots on goal + save percentage.
      const shotType = `${sport.key}.shot`;
      const shot = (seq: number, by: string, extra?: Record<string, unknown>): EventEnvelope =>
        ev(seq, shotType, { by, outcome: "saved", ...(extra ?? {}) });
      // `voids` (the id of the event being cancelled) travels on the
      // ENVELOPE, not the payload (`CoreVoid` is `z.strictObject({})`) — so
      // this bypasses the local `ev` wrapper and calls `makeEnvelope` with
      // its 3rd argument directly.
      const voidEv = (seq: number, targetSeq: number): EventEnvelope =>
        makeEnvelope(seq, { type: "core.void", payload: {} }, `e-${targetSeq}`);

      it("simple case: one keeper concedes twice, earns no clean sheet", () => {
        const rows = aggregatePlayerStats([start, goal(1, A), goal(2, A)], model, lineups);
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.goals_conceded).toBe(2);
        expect(row?.stats.clean_sheets).toBeUndefined();
      });

      it("simple clean sheet: a keeper who concedes nothing earns one", () => {
        const rows = aggregatePlayerStats([start, goal(1, H)], model, lineups); // away concedes
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.clean_sheets).toBe(1);
        expect(row?.stats.goals_conceded).toBeUndefined();
      });

      it("HEADLINE: a mid-match keeper change splits goals_conceded across two different people", () => {
        const rows = aggregatePlayerStats(
          [
            start,
            goal(1, A), // conceded by the ORIGINAL keeper
            subKeeper(2, homeKeeper, homeSub1),
            goal(3, A), // conceded by the REPLACEMENT keeper
          ],
          model,
          lineups,
        );
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBe(1);
        expect(rows.find((r) => r.personId === homeSub1)?.stats.goals_conceded).toBe(1);
        // Neither earns a clean sheet — each conceded during their own spell.
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.clean_sheets).toBeUndefined();
        expect(rows.find((r) => r.personId === homeSub1)?.stats.clean_sheets).toBeUndefined();
      });

      it("a keeper subbed ON at 0-0 who then concedes gets it; the one who came off does not", () => {
        const rows = aggregatePlayerStats(
          [start, subKeeper(1, homeKeeper, homeSub1), goal(2, A)],
          model,
          lineups,
        );
        expect(rows.find((r) => r.personId === homeSub1)?.stats.goals_conceded).toBe(1);
        // The outgoing keeper legitimately earns a clean sheet for his own
        // brief, unbroken spell — the claim under test is that he is never
        // charged the concession that happened after he left.
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBeUndefined();
      });

      it("clean sheet split: two keepers, zero goals conceded throughout, BOTH earn one", () => {
        const rows = aggregatePlayerStats([start, subKeeper(1, homeKeeper, homeSub1)], model, lineups);
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.clean_sheets).toBe(1);
        expect(rows.find((r) => r.personId === homeSub1)?.stats.clean_sheets).toBe(1);
      });

      it("an empty-net goal charges no keeper, but still breaks the clean sheet", () => {
        const rows = aggregatePlayerStats([start, goal(1, A, { emptyNet: true })], model, lineups);
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBeUndefined();
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.clean_sheets).toBeUndefined();
      });

      it("shoot-out attempts never move goals_conceded, even though the payload names a goalkeeper", () => {
        const rows = aggregatePlayerStats(
          [
            start,
            ev(1, `${sport.key}.shootout.attempt`, {
              by: A,
              person: `${A}-p2`,
              goalkeeper: homeKeeper,
              scored: true,
            }),
          ],
          model,
          lineups,
        );
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBeUndefined();
      });

      it("an own goal is charged to the CREDITED side's opponent's keeper, not the naive opponent(by)", () => {
        // by = A (away's player put it into their own net) => credited = H
        // (home benefits) => conceding side = opponent(credited) = A, so it
        // is AWAY's OWN keeper who concedes — the naive `opponent(by)`
        // formula (opponent(A) = H) would wrongly charge HOME's keeper.
        const rows = aggregatePlayerStats([start, goal(1, A, { kind: "og" })], model, lineups);
        expect(rows.find((r) => r.personId === awayKeeper)?.stats.goals_conceded).toBe(1);
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBeUndefined();
      });

      it("determinism: folding the same stream twice produces deeply equal rows", () => {
        const events = [
          start,
          goal(1, A, { person: `${A}-p2` }),
          subKeeper(2, homeKeeper, homeSub1),
          goal(3, A, { person: `${A}-p2` }),
        ];
        expect(aggregatePlayerStats(events, model, lineups)).toEqual(
          aggregatePlayerStats(events, model, lineups),
        );
      });

      it("coexists with metric-based stats in one fold — a scorer's own goals metric is untouched", () => {
        const scorer = `${A}-p2`;
        const rows = aggregatePlayerStats([start, goal(1, A, { person: scorer })], model, lineups);
        expect(rows.find((r) => r.personId === scorer)?.stats.goals).toBe(1);
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.goals_conceded).toBe(1);
      });

      it("ctx/lineups both omitted leaves the folded path inert — existing metrics unaffected", () => {
        const scorer = "solo-scorer";
        const rows = aggregatePlayerStats([start, goal(1, "H", { person: scorer })], model); // no lineups
        expect(rows.find((r) => r.personId === scorer)?.stats.goals).toBe(1);
        expect(rows.find((r) => r.personId === scorer)?.stats.goals_conceded).toBeUndefined();
      });

      // -----------------------------------------------------------------
      // S8/#417 W6 — shots on goal, saves, save percentage. Same fold
      // (`periodKeeperStatsFold`), same spell mechanism, same SPORTS loop —
      // every test below runs for BOTH hockey and icehockey with no
      // sport-specific branching, which is the proof that a mechanism
      // gated for one did not silently alter the other.
      // -----------------------------------------------------------------

      it("a save credits the on-ice keeper and counts toward shots_faced", () => {
        const rows = aggregatePlayerStats([start, shot(1, A, { outcome: "saved" })], model, lineups);
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.saves).toBe(1);
        expect(row?.stats.shots_faced).toBe(1);
      });

      it("missed/blocked shots touch neither saves nor shots_faced", () => {
        const rows = aggregatePlayerStats(
          [start, shot(1, A, { outcome: "missed" }), shot(2, A, { outcome: "blocked" })],
          model,
          lineups,
        );
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.saves).toBeUndefined();
        expect(row?.stats.shots_faced).toBeUndefined();
      });

      it("HEADLINE: a mid-match keeper change splits saves across two different people", () => {
        const rows = aggregatePlayerStats(
          [
            start,
            shot(1, A, { outcome: "saved" }), // saved by the ORIGINAL keeper
            subKeeper(2, homeKeeper, homeSub1),
            shot(3, A, { outcome: "saved" }), // saved by the REPLACEMENT keeper
          ],
          model,
          lineups,
        );
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.saves).toBe(1);
        expect(rows.find((r) => r.personId === homeSub1)?.stats.saves).toBe(1);
      });

      it("an explicit payload goalkeeper BEATS the spell-derived keeper when they disagree", () => {
        // homeKeeper is who the spell fold would credit (never subbed off);
        // the payload deliberately names homeSub1 instead — someone who
        // never touched the pitch, so a fixture where the two AGREE could
        // not tell the two resolution paths apart (fixture-choice-is-the-
        // test).
        const rows = aggregatePlayerStats(
          [start, shot(1, A, { outcome: "saved", goalkeeper: homeSub1 })],
          model,
          lineups,
        );
        expect(rows.find((r) => r.personId === homeSub1)?.stats.saves).toBe(1);
        expect(rows.find((r) => r.personId === homeKeeper)?.stats.saves).toBeUndefined();
      });

      it("a shot with outcome scored does not double-charge goals_conceded or shots_faced", () => {
        const rows = aggregatePlayerStats(
          [start, goal(1, A), shot(2, A, { outcome: "scored" })],
          model,
          lineups,
        );
        const row = rows.find((r) => r.personId === homeKeeper);
        // ONE real goal + one outcome:"scored" shot describing the SAME
        // event on the ice — both must count it exactly once, not twice.
        expect(row?.stats.goals_conceded).toBe(1);
        expect(row?.stats.shots_faced).toBe(1);
      });

      it("save percentage is correct on a fully-covered match", () => {
        const rows = aggregatePlayerStats(
          [
            start,
            shot(1, A, { outcome: "saved" }),
            shot(2, A, { outcome: "missed" }),
            shot(3, A, { outcome: "blocked" }),
            goal(4, A), // conceded — shots_faced 1 -> 2
            shot(5, A, { outcome: "scored" }), // matching coverage evidence
          ],
          model,
          lineups,
        );
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.saves).toBe(1);
        expect(row?.stats.shots_faced).toBe(2);
        expect(row?.stats.save_percentage).toBe(50);
      });

      it("save percentage is absent entirely on a partially-covered match", () => {
        const rows = aggregatePlayerStats(
          [
            start,
            shot(1, A, { outcome: "saved" }),
            goal(2, A), // conceded, but NEVER also logged as an outcome:"scored" shot
          ],
          model,
          lineups,
        );
        const row = rows.find((r) => r.personId === homeKeeper);
        expect(row?.stats.saves).toBe(1);
        expect(row?.stats.shots_faced).toBe(2);
        expect(row?.stats.save_percentage).toBeUndefined();
      });

      it("void un-counts a save (folded path) and a shot (metric path)", () => {
        const events = [start, shot(1, A, { outcome: "saved", person: `${A}-p6` })];
        const before = aggregatePlayerStats(events, model, lineups);
        const after = aggregatePlayerStats([...events, voidEv(2, 1)], model, lineups);
        expect(before.find((r) => r.personId === homeKeeper)?.stats.saves).toBe(1);
        expect(after.find((r) => r.personId === homeKeeper)?.stats.saves).toBeUndefined();
        expect(after.find((r) => r.personId === homeKeeper)?.stats.shots_faced).toBeUndefined();
        // The shooter-side declarative `shots` metric un-counts too — a
        // different code path (metric+field walk, not `folded`), reading
        // the SAME void-resolved list `aggregatePlayerStatsWithDiagnostics`
        // builds once for both.
        expect(before.find((r) => r.personId === `${A}-p6`)?.stats.shots).toBe(1);
        expect(after.find((r) => r.personId === `${A}-p6`)?.stats.shots).toBeUndefined();
      });
    });
  }

  // S8/#417 W6 — the event TYPE STRING is the whole isolation boundary
  // between the two sports on this shared kernel: `icehockey.shot` is
  // simply not `event.type === "hockey.shot"`, so folding it through
  // hockey's OWN model credits nobody. Outside the SPORTS loop on purpose —
  // this specifically needs TWO DIFFERENT modules reading ONE stream.
  it("a change gated for one period-kernel sport does not leak into the other", () => {
    const lineups = pair("GK", "DF", 11);
    const start = ev(0, "core.start", {});
    const wrongTypeShot = ev(1, "icehockey.shot", {
      by: lineups.away.entrantId,
      outcome: "saved",
    });
    const rows = aggregatePlayerStats([start, wrongTypeShot], hockey.playerStats!, lineups);
    const keeper = lineups.home.slots[0]!.personId;
    expect(rows.find((r) => r.personId === keeper)?.stats.saves).toBeUndefined();
  });

  it("playerStatsKeyCollisions is empty for hockey and icehockey", () => {
    expect(playerStatsKeyCollisions(hockey.playerStats!)).toEqual([]);
    expect(playerStatsKeyCollisions(icehockey.playerStats!)).toEqual([]);
  });
});
