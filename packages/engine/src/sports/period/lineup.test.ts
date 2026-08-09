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
