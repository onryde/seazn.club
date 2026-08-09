// S3/W4b (#426) — cricket on the kernel-owned squad model (`core/lineup.ts`),
// and the concussion / COVID replacement row that model exists to close.
//
// The row's own words, before this pass: "Lineups reach the module through
// `init(cfg, lineups)`, not through the event stream; making a squad mutable
// mid-fixture is an architecture decision above this module." That architecture
// is now `core/lineup.ts`, so this file is the proof that cricket consumes it
// rather than growing a fourth private copy of a squad.
//
// FOUR THINGS THAT ARE EASY TO GET WRONG AND ARE PINNED HERE:
//
//  1. The cap and the exemption must DISAGREE in the same fixture. A test where
//     both channels succeed proves nothing — it passes just as well against a
//     module that never declared a cap.
//  2. `cricket.retire` and `core.lineup.replacement` are DIFFERENT ACTS on
//     different axes. Retirement is the CREASE (cricket's own state); a
//     replacement is the FIELD (the kernel's squad). Collapsing them is the
//     bug this file exists to prevent, so several tests assert that one act
//     leaves the other axis untouched.
//  3. Re-entry has two answers in this one sport, and they are not in tension
//     because they act on those two different axes: a retired-hurt batter
//     resumes at the crease with the field policy still at `none`, while a
//     concussion-replaced player is refused the field. Both are asserted under
//     the SAME cfg.
//  4. `state.orders` is a batting order AND `fine.nextBatterIndex` is a cursor
//     into it. Growth is therefore APPEND-ONLY; inserting would silently
//     re-point the cursor at a different batter.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import {
  foldMatch,
  foldMatchWithStoppage,
  type EventEnvelope,
} from "../../core/events.ts";
import { memberOf, onFieldPersons, type SquadState } from "../../core/lineup.ts";
import type { LineupPair } from "../../core/types.ts";
import { makeEnvelope } from "../../testkit/index.ts";
import { cricket, type CricketCfg } from "./cricket.ts";

// Every fold here is PAD-SHAPED — building a stream event by event, which is
// the write path — so the whole stream is strict and a cfg-derived refusal is
// reachable. A READ-path fold runs REPLAY_LINEUP_POLICY and refuses nothing.
const STRICT_ALL = { strictFromSeq: 0 } as const;

const SIDE = 11;

/** Eleven starting (batting order = orderNo) plus an optional bench. */
function lineup(prefix: string, bench = 0): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: [
      ...Array.from({ length: SIDE }, (_, i) => ({
        personId: `${prefix}-${i + 1}`,
        slot: "starting" as const,
        orderNo: i + 1,
        ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
      })),
      ...Array.from({ length: bench }, (_, i) => ({
        personId: `${prefix}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: SIDE + i + 1,
      })),
    ],
  };
}

const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const benched: LineupPair = { home: lineup("H", 2), away: lineup("A", 2) };

const parse = (raw: unknown): CricketCfg => cricket.configSchema.parse(raw);
const t20 = parse(cricket.variants.t20);

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

function foldSquads(
  cfg: CricketCfg,
  events: EventEnvelope[],
  pair: LineupPair = lineups,
): SquadState {
  return foldMatchWithStoppage(cricket, cfg, pair, events, STRICT_ALL).squads;
}

/** The rejection reason the kernel attached, or `null` if the fold accepted. */
function refusalOf(cfg: CricketCfg, events: EventEnvelope[], pair: LineupPair = lineups): string | null {
  try {
    foldMatch(cricket, cfg, pair, events, STRICT_ALL);
    return null;
  } catch (error) {
    if (!EngineError.is(error, "LINEUP_INVALID")) throw error;
    return (error.data as { reason: string }).reason;
  }
}

/** A like-for-like concussion replacement: `on` is a person the team sheet
 *  never named, which is precisely why ruling 1 had to exist. */
const concussion = (off: string, on: string, orderNo: number) =>
  [
    "core.lineup.replacement",
    { side: "H", off, on: { personId: on, slot: "bench", orderNo }, exemption: "concussion" },
  ] as [string, unknown];

const substitution = (off: string, on: string, orderNo: number) =>
  ["core.lineup.substitution", { side: "H", off, on: { personId: on, slot: "bench", orderNo } }] as [
    string,
    unknown,
  ];

// ---------------------------------------------------------------------------
// 1. The policy cricket declares, and the exemption that closes the row
// ---------------------------------------------------------------------------

describe("cricket.lineupPolicy — declared per variant, never a module constant", () => {
  it("declares the concussion exemption for the ICC-conditions variants", () => {
    for (const key of ["t20", "odi", "test"]) {
      const policy = cricket.lineupPolicy?.(parse(cricket.variants[key]));
      expect(policy?.exemptions?.concussion).toEqual({ max: 1 });
      expect(policy?.allowSquadGrowth).toBe(true);
    }
  });

  it("does NOT declare it for the variants ICC conditions do not cover", () => {
    for (const key of ["hundred", "pairs-6-a-side"]) {
      const policy = cricket.lineupPolicy?.(parse(cricket.variants[key]));
      expect(policy?.exemptions?.concussion).toBeUndefined();
      // Ruling 1's default: a squad that may not grow is the pre-wave squad.
      expect(policy?.allowSquadGrowth).toBe(false);
    }
  });

  it("permits no ordinary substitution by default — Law 24's substitute fields only", () => {
    expect(cricket.lineupPolicy?.(t20).maxSubs).toBe(0);
  });
});

describe("concussion replacement — the deferred row", () => {
  it("admits a person the team sheet never named, marked `added`", () => {
    const squads = foldSquads(t20, stream(concussion("H-3", "H-12", 12)));
    const replacement = memberOf(squads.home, "H-12");
    expect(replacement?.provenance).toBe("added");
    expect(replacement?.onField).toBe(true);
    // Ruling 1's whole point: a career rollup can tell a mid-fixture addition
    // from a team-sheet member.
    expect(memberOf(squads.home, "H-3")?.provenance).toBe("named");
    expect(memberOf(squads.home, "H-3")?.onField).toBe(false);
    expect(onFieldPersons(squads.home)).toHaveLength(SIDE);
  });

  it("charges the exemption, not the substitution cap", () => {
    const squads = foldSquads(t20, stream(concussion("H-3", "H-12", 12)));
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
    expect(squads.home.subsUsed).toBe(0);
  });

  it("bounds the exemption at the configured allowance", () => {
    const events = stream(concussion("H-3", "H-12", 12), concussion("H-4", "H-13", 13));
    expect(refusalOf(t20, events)).toBe("exemption-cap-reached");
  });

  it("refuses it in a variant that does not declare it", () => {
    expect(refusalOf(parse(cricket.variants.hundred), stream(concussion("H-3", "H-12", 12)))).toBe(
      "exemption-not-declared",
    );
  });

  it("refuses an invented exemption key, so the cap cannot be evaded", () => {
    const events = stream([
      "core.lineup.replacement",
      {
        side: "H",
        off: "H-3",
        on: { personId: "H-12", slot: "bench", orderNo: 12 },
        exemption: "tactical",
      },
    ]);
    expect(refusalOf(t20, events)).toBe("exemption-not-declared");
  });
});

// ---------------------------------------------------------------------------
// 2. The cap and the exemption DISAGREE, in one fixture
// ---------------------------------------------------------------------------

describe("the substitution cap and the concussion exemption disagree", () => {
  it("a shipped variant refuses an ordinary substitution and accepts the replacement", () => {
    // t20 caps ordinary substitutions at 0, so the squad is at the cap from
    // the first ball — and the exempt channel is still open.
    expect(refusalOf(t20, stream(substitution("H-3", "H-b1", 12)), benched)).toBe(
      "sub-cap-reached",
    );
    const squads = foldSquads(t20, stream(concussion("H-3", "H-12", 12)), benched);
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
  });

  it("a squad already AT a non-zero cap still takes a concussion replacement", () => {
    const cfg = parse({
      ...cricket.variants.t20,
      lineupChanges: { maxSubs: 1, concussionReplacements: 1 },
    });
    // One ordinary substitution is allowed, and exhausts the cap.
    const first = stream(substitution("H-3", "H-b1", 12));
    expect(refusalOf(cfg, first, benched)).toBeNull();

    // The second is refused — the cap is real…
    const second = stream(substitution("H-3", "H-b1", 12), substitution("H-4", "H-b2", 13));
    expect(refusalOf(cfg, second, benched)).toBe("sub-cap-reached");

    // …and in the SAME fixture the exempt replacement is still accepted.
    const exempt = stream(
      substitution("H-3", "H-b1", 12),
      substitution("H-4", "H-b2", 13),
      concussion("H-5", "H-12", 14),
    );
    // The refused ordinary substitution is dropped from the stream, not the
    // exempt one that follows it.
    const accepted = stream(substitution("H-3", "H-b1", 12), concussion("H-5", "H-12", 14));
    expect(refusalOf(cfg, exempt, benched)).toBe("sub-cap-reached");
    expect(refusalOf(cfg, accepted, benched)).toBeNull();
    const squads = foldSquads(cfg, accepted, benched);
    expect(squads.home.subsUsed).toBe(1);
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
  });
});

// ---------------------------------------------------------------------------
// 3. Re-entry — two answers in one sport, on two different axes
// ---------------------------------------------------------------------------

/** A ball at legal-delivery index `n`, so over/ballInOver match what the fold
 *  derives. Runs default to a dot so the strike never rotates and the crease
 *  stays where the test put it. */
function ball(
  n: number,
  striker: string,
  nonStriker: string,
  extra: Record<string, unknown> = {},
): [string, unknown] {
  return [
    "cricket.ball",
    {
      over: Math.floor(n / 6),
      ballInOver: (n % 6) + 1,
      striker,
      nonStriker,
      bowler: "A-1",
      runs: { bat: 0 },
      ...extra,
    },
  ];
}

const bowled = (out: string, incoming?: string) => ({
  wicket: {
    kind: "bowled",
    out,
    bowlerCredited: true,
    ...(incoming === undefined ? {} : { incoming }),
  },
});

/** The crease as cricket records it, for the fixture's open innings. */
function crease(cfg: CricketCfg, events: EventEnvelope[], pair: LineupPair = lineups) {
  const state = foldMatch(cricket, cfg, pair, events, STRICT_ALL);
  const fine = state.innings[0]?.fine;
  return {
    striker: fine?.striker,
    nonStriker: fine?.nonStriker,
    retiredNotOut: fine?.retiredNotOut ?? [],
    dismissed: fine?.dismissed ?? [],
    orders: state.orders,
  };
}

const entry = (personId: string, orderNo: number) =>
  ["core.lineup.entry", { side: "H", on: { personId, slot: "starting", orderNo } }] as [
    string,
    unknown,
  ];

describe("re-entry — the field axis (ruling 2)", () => {
  it("refuses the concussion-replaced player the field again: ICC permanence", () => {
    const events = stream(concussion("H-3", "H-12", 12), entry("H-3", 3));
    expect(cricket.lineupPolicy?.(t20).reentry).toBe("none");
    expect(refusalOf(t20, events)).toBe("reentry-forbidden");
  });

  it("admits him when the variant says returns are allowed", () => {
    const cfg = parse({
      ...cricket.variants.t20,
      lineupChanges: { concussionReplacements: 1, reentry: "unlimited" },
    });
    const events = stream(concussion("H-3", "H-12", 12), entry("H-3", 3));
    expect(refusalOf(cfg, events)).toBeNull();
    const squads = foldSquads(cfg, events);
    expect(memberOf(squads.home, "H-3")?.onField).toBe(true);
    expect(memberOf(squads.home, "H-3")?.timesOn).toBe(1);
  });

  it("`once` bounds it at one return, `unlimited` does not", () => {
    const twice = stream(
      concussion("H-3", "H-12", 12),
      entry("H-3", 3),
      ["core.lineup.retirement", { side: "H", personId: "H-3" }],
      entry("H-3", 3),
    );
    const once = parse({
      ...cricket.variants.t20,
      lineupChanges: { concussionReplacements: 1, reentry: "once" },
    });
    const unlimited = parse({
      ...cricket.variants.t20,
      lineupChanges: { concussionReplacements: 1, reentry: "unlimited" },
    });
    expect(refusalOf(once, twice)).toBe("reentry-limit");
    expect(refusalOf(unlimited, twice)).toBeNull();
  });
});

describe("re-entry — the CREASE axis is a different axis", () => {
  // The two answers cricket needs are not in tension, and this is why: a batter
  // who retires hurt never leaves the FIELD, so the `reentry` knob is never
  // asked about him. Both assertions below run under t20, whose field policy is
  // `none` — the strictest setting there is.
  it("a retired-hurt batter resumes at the crease with the field policy at `none`", () => {
    const events = stream(
      ["core.start"],
      ball(0, "H-1", "H-2"),
      ["cricket.retire", { person: "H-1", reason: "hurt" }],
      // H-3 walked in for the retired H-1; now H-3 is bowled and the captain
      // sends the recovered H-1 back out (Law 25.4.2).
      ball(1, "H-3", "H-2", bowled("H-3", "H-1")),
    );
    const after = crease(t20, events);
    expect(after.striker).toBe("H-1");
    expect(after.retiredNotOut).toEqual([]);
    // And nothing about the SQUAD moved: he never left the field.
    const squads = foldSquads(t20, events);
    expect(memberOf(squads.home, "H-1")?.onField).toBe(true);
    expect(memberOf(squads.home, "H-1")?.timesOff).toBe(0);
    expect(squads.home.exemptUsed).toEqual({});
  });

  it("…while the concussion-replaced player is refused the field under the same cfg", () => {
    expect(refusalOf(t20, stream(concussion("H-3", "H-12", 12), entry("H-3", 3)))).toBe(
      "reentry-forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. `cricket.retire` and `core.lineup.replacement` are different acts
// ---------------------------------------------------------------------------

describe("a retirement and a replacement never collapse into one another", () => {
  const live = [["core.start"], ball(0, "H-1", "H-2")] as Array<[string, unknown?]>;

  it("a retirement moves the crease and leaves the squad alone", () => {
    const events = stream(...live, ["cricket.retire", { person: "H-1", reason: "hurt" }]);
    const after = crease(t20, events);
    expect(after.striker).toBe("H-3"); // the next batter walked in
    expect(after.retiredNotOut).toEqual(["H-1"]);

    const squads = foldSquads(t20, events);
    expect(squads.home.exemptUsed).toEqual({});
    expect(squads.home.subsUsed).toBe(0);
    expect(onFieldPersons(squads.home)).toContain("H-1");
    expect(squads.home.members.every((m) => m.provenance === "named")).toBe(true);
  });

  it("a replacement moves the squad and leaves the crease alone", () => {
    const events = stream(...live, concussion("H-1", "H-12", 12));
    const after = crease(t20, events);
    // H-1 is still the striker: a concussion replacement does not walk to the
    // wicket in the replaced batter's place. The scorer records BOTH acts —
    // `cricket.retire` for the crease, the replacement for the squad.
    expect(after.striker).toBe("H-1");
    expect(after.nonStriker).toBe("H-2");
    expect(after.retiredNotOut).toEqual([]);
    expect(after.dismissed).toEqual([]);

    const squads = foldSquads(t20, events);
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
    expect(memberOf(squads.home, "H-1")?.onField).toBe(false);
  });

  it("both acts on one batter are two independent records, not a double count", () => {
    const events = stream(
      ...live,
      ["cricket.retire", { person: "H-1", reason: "hurt" }],
      concussion("H-1", "H-12", 12),
    );
    const after = crease(t20, events);
    const squads = foldSquads(t20, events);
    // Crease: retired not out, replaced at the wicket by the next batter.
    expect(after.striker).toBe("H-3");
    expect(after.retiredNotOut).toEqual(["H-1"]);
    // Squad: one exemption charged, exactly one — the retirement charged none.
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
    expect(squads.home.subsUsed).toBe(0);
    // And the innings took no wicket for either act (`reason: "hurt"`).
    expect(foldMatch(cricket, t20, lineups, events, STRICT_ALL).innings[0]?.wickets).toBe(0);
  });
});
