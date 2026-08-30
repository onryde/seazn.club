// S3/W4b (#426) pass B — the set-based kernel adopting `core/lineup.ts` for
// volleyball, badminton and table tennis. Two deferred dossier rows:
//
//   * `DOMAIN.volleyball.md` — LIBERO REPLACEMENTS. The role already existed in
//     the catalog, so a sheet could NAME a libero; what was missing is the
//     replacement itself, and FIVB 15.6's two conditions on it — the replaced
//     player may come back ONCE, and only to the position they left.
//   * `DOMAIN.tabletennis.md` — DOUBLES SERVE AND RECEIVE ORDER. The dossier
//     said the ITTF rotation is derivable "from the pair's declared order plus
//     the service history"; the declared order had nowhere to live. It does
//     now, it survives `init` into State, and `expectedDoublesServer` reads it.
//
// The three sports share one kernel, so a policy that is a kernel constant
// rather than a per-preset answer is indistinguishable from a correct one on
// volleyball alone. Table tennis is asserted to REFUSE what volleyball permits.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { memberOf, personsAtPosition } from "../../core/lineup.ts";
import type { Lineup, LineupPair, LineupSlot } from "../../core/types.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";
import { expectedDoublesServer, type SetBasedCfg, type SetBasedState } from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

// FIVB: six on court (S/OH/MB/OPP/L), plus a bench carrying the second libero.
const COURT = ["S", "OH", "MB", "OPP", "OH", "MB"] as const;

function volleyballSide(entrantId: string): Lineup {
  const starters: LineupSlot[] = COURT.map((positionKey, i) => ({
    personId: `${entrantId}-p${i + 1}`,
    positionKey,
    slot: "starting" as const,
    orderNo: i + 1,
  }));
  const bench: LineupSlot[] = [
    {
      personId: `${entrantId}-lib`,
      slot: "bench" as const,
      orderNo: 7,
      roles: ["libero"],
    },
    { personId: `${entrantId}-b2`, slot: "bench" as const, orderNo: 8 },
  ];
  return { entrantId, slots: [...starters, ...bench] };
}

const volleyballLineups: LineupPair = {
  home: volleyballSide("H"),
  away: volleyballSide("A"),
};

/** A doubles team sheet: two named players, first-named first. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: first, slot: "starting", orderNo: 1, pairOrder: 1 },
      { personId: second, slot: "starting", orderNo: 2, pairOrder: 2 },
    ],
  };
}

const doublesLineups: LineupPair = {
  home: pairSide("H", "H-a", "H-b"),
  away: pairSide("A", "A-a", "A-b"),
};

function fold(
  module: typeof volleyball,
  cfg: SetBasedCfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): SetBasedState {
  return foldMatch(module, cfg, lineups, events, STRICT_ALL);
}

// ---------------------------------------------------------------------------
// Volleyball — FIVB 15.6
// ---------------------------------------------------------------------------

describe("volleyball — the libero replacement is recorded and folded", () => {
  const cfg = volleyball.configSchema.parse({});
  const start = ev(1, "core.start", {});
  // The libero comes on for the middle blocker and takes his position.
  const liberoOn = ev(2, "core.lineup.replacement", {
    side: "H",
    off: "H-p3",
    on: {
      personId: "H-lib",
      positionKey: "MB",
      slot: "starting",
      orderNo: 7,
      roles: ["libero"],
    },
    exemption: "libero",
  });

  it("charges the replacement to the libero exemption, never to the substitution cap", () => {
    // The separation is the whole reason the exemption channel exists: FIVB
    // allows six substitutions a set AND unlimited libero replacements, and a
    // libero swap that consumed one of the six would be a rule the sheet does
    // not have.
    const state = fold(volleyball, cfg, volleyballLineups, [start, liberoOn]);
    expect(state.squads!.home.exemptUsed).toEqual({ libero: 1 });
    expect(state.squads!.home.subsUsed).toBe(0);
    expect(personsAtPosition(state.squads!.home, "MB")).toEqual(["H-p6", "H-lib"]);
    expect(memberOf(state.squads!.home, "H-p3")?.lastPositionKey).toBe("MB");
  });

  it("takes the replaced player back to the position he left", () => {
    const state = fold(volleyball, cfg, volleyballLineups, [
      start,
      liberoOn,
      ev(3, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }),
    ]);
    // Squad order, i.e. team-sheet order: H-p3 is back in his own slot rather
    // than appended, which is what makes the return a return.
    expect(personsAtPosition(state.squads!.home, "MB")).toEqual(["H-p3", "H-p6"]);
    expect(memberOf(state.squads!.home, "H-p3")?.timesOn).toBe(1);
  });

  it("REFUSES a return to any other position (FIVB 15.6, the position lock)", () => {
    // Mutation proof: flip `reentryPositionLock` to false in volleyball.ts and
    // this is the assertion that stops holding. The two events differ ONLY in
    // `positionKey`, so nothing else can be what refuses it.
    const wrongPosition = [
      start,
      liberoOn,
      ev(3, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "OPP", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }),
    ];
    expect(() => fold(volleyball, cfg, volleyballLineups, wrongPosition)).toThrow(
      /must return to MB/,
    );
  });

  it("permits an unlimited libero cycle — FIVB 19.3.2.1, not the substitution re-entry allowance", () => {
    // Formerly named "REFUSES a second return — re-entry is `once`", and
    // asserted `toThrow(/already returned once/)` on exactly this cycle
    // (through the 4th replacement below). That assertion encoded a defect,
    // not a rule: FIVB 19.3.2.1 makes libero replacements UNLIMITED.
    // `reentry: "once"` is volleyball's ordinary SUBSTITUTION re-entry
    // allowance (FIVB 15.6) — a `core.lineup.replacement` carrying a declared
    // exemption is not a substitution (19.3.2.1) and must not be measured
    // against it. THIS IS A DELIBERATE REVERSAL: revert the `bringOn`
    // exemption bypass in `core/lineup.ts` and this test reds again, at the
    // same 4th replacement that used to throw.
    //
    // Driven past the old 4-replacement cutoff into FIVB-realistic
    // repetition — a libero rotates in and out roughly every rotation — six
    // replacements alternating libero-on / replaced-player-back.
    const events = [
      start,
      liberoOn, // 1st replacement — libero on for p3
      ev(3, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }), // 2nd — p3 back
      ev(4, "core.lineup.replacement", {
        side: "H",
        off: "H-p3",
        on: { personId: "H-lib", positionKey: "MB", slot: "starting", orderNo: 7 },
        exemption: "libero",
      }), // 3rd — libero back
      ev(5, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }), // 4th — p3's SECOND return: the old test refused exactly here
      ev(6, "core.lineup.replacement", {
        side: "H",
        off: "H-p3",
        on: { personId: "H-lib", positionKey: "MB", slot: "starting", orderNo: 7 },
        exemption: "libero",
      }), // 5th — libero's second return
      ev(7, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "MB", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }), // 6th — p3's third return
    ];
    const state = fold(volleyball, cfg, volleyballLineups, events);
    expect(state.squads!.home.exemptUsed).toEqual({ libero: 6 });
    expect(state.squads!.home.subsUsed).toBe(0);
    // FIVB 15.6's position lock still held at every leg — the count never
    // gated it, and the lock is not gated by the exemption bypass at all.
    expect(personsAtPosition(state.squads!.home, "MB")).toEqual(["H-p3", "H-p6"]);
  });

  it("refuses an exemption key this sport never declared", () => {
    expect(() =>
      fold(volleyball, cfg, volleyballLineups, [
        start,
        ev(2, "core.lineup.replacement", {
          side: "H",
          off: "H-p3",
          on: { personId: "H-lib", positionKey: "MB", slot: "starting", orderNo: 7 },
          exemption: "concussion",
        }),
      ]),
    ).toThrow(/does not recognise the "concussion" replacement exemption/);
  });

  it("absorbs a recorded replacement on REPLAY rather than bricking the fixture", () => {
    // §3.3: an organiser cannot retroactively make a scored fixture unreadable.
    const events = [
      start,
      liberoOn,
      ev(3, "core.lineup.replacement", {
        side: "H",
        off: "H-lib",
        on: { personId: "H-p3", positionKey: "OPP", slot: "starting", orderNo: 3 },
        exemption: "libero",
      }),
    ];
    expect(() => foldMatch(volleyball, cfg, volleyballLineups, events)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The policy is the PRESET's, not the kernel's
// ---------------------------------------------------------------------------

describe("one kernel, three answers", () => {
  it("table tennis and badminton permit no return at all — ITTF/BWF have no substitutes", () => {
    for (const module of [tabletennis, badminton]) {
      const cfg = module.configSchema.parse({});
      const lineups: LineupPair = {
        home: { entrantId: "H", slots: [{ personId: "H-a", slot: "starting", orderNo: 1 }] },
        away: { entrantId: "A", slots: [{ personId: "A-a", slot: "starting", orderNo: 1 }] },
      };
      const events = [
        ev(1, "core.start", {}),
        ev(2, "core.lineup.retirement", { side: "H", personId: "H-a" }),
        ev(3, "core.lineup.entry", {
          side: "H",
          on: { personId: "H-a", slot: "starting", orderNo: 1 },
        }),
      ];
      expect(() => foldMatch(module, cfg, lineups, events, STRICT_ALL)).toThrow(EngineError);
    }
  });

  it("and no sport on this kernel admits a person off the team sheet", () => {
    const cfg = volleyball.configSchema.parse({});
    expect(() =>
      fold(volleyball, cfg, volleyballLineups, [
        ev(1, "core.start", {}),
        ev(2, "core.lineup.entry", {
          side: "H",
          on: { personId: "H-ghost", positionKey: "OH", slot: "starting", orderNo: 9 },
        }),
      ]),
    ).toThrow(/not on the team sheet/);
  });
});

// ---------------------------------------------------------------------------
// Table tennis — the doubles order
// ---------------------------------------------------------------------------

describe("table tennis — the declared doubles order reaches State", () => {
  const cfg = tabletennis.configSchema.parse({});

  it("carries the pair order into State at init, first-named first", () => {
    const state = foldMatch(tabletennis, cfg, doublesLineups, [ev(1, "core.start", {})], STRICT_ALL);
    expect(state.squads!.home.members.map((m) => [m.personId, m.pairOrder])).toEqual([
      ["H-a", 1],
      ["H-b", 2],
    ]);
  });

  it("answers the ITTF rotation by personId, for both sides", () => {
    const state = foldMatch(tabletennis, cfg, doublesLineups, [ev(1, "core.start", {})], STRICT_ALL);
    expect(expectedDoublesServer(state, "home", 0)).toBe("H-a");
    expect(expectedDoublesServer(state, "home", 1)).toBe("H-b");
    expect(expectedDoublesServer(state, "home", 2)).toBe("H-a");
    expect(expectedDoublesServer(state, "away", 1)).toBe("A-b");
  });

  it("declares a singles fixture unrotatable rather than guessing one", () => {
    const singles: LineupPair = {
      home: { entrantId: "H", slots: [{ personId: "H-a", slot: "starting", orderNo: 1 }] },
      away: { entrantId: "A", slots: [{ personId: "A-a", slot: "starting", orderNo: 1 }] },
    };
    const state = foldMatch(tabletennis, cfg, singles, [ev(1, "core.start", {})], STRICT_ALL);
    expect(expectedDoublesServer(state, "home", 0)).toBeNull();
    // …and nothing is written into State for a sheet that declares nothing.
    expect(JSON.stringify(state)).not.toContain('"squads"');
  });
});
