// S3/W4b (#426) — the kernel-owned squad model. One implementation for all
// eleven sports; the point of the file is that no sport ever reimplements it.
//
// The three owner rulings this suite pins (decision log, 2026-08-09):
//  1. a squad MAY grow mid-fixture, gated per variant in cfg, default OFF, and
//     a grown entry is provenance `added` so a career rollup can tell it apart;
//  2. re-entry after leaving the field is a cfg knob `none | once | unlimited`
//     plus FIVB's position lock — and a violation is a REJECTION, never a
//     throw, because a cfg-derived throw inside a fold bricks recorded
//     fixtures (found 6× in W4a);
//  3. `LineupSlot.role` defaults to `player`, and squad/stat projections keep
//     only players, so a card to a coach never enters a playing record.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEUP_POLICY,
  initSquads,
  memberOf,
  onFieldPersons,
  personsAtPosition,
  playingSquad,
  reduceLineupEvent,
  sideOf,
  type LineupEventInput,
  type LineupPolicy,
  type LineupReduceResult,
  type SquadState,
} from "./lineup.ts";
import type { LineupPair } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixture: a football-shaped pair, deliberately asymmetric so a first-side-wins
// or a home/away mix-up cannot pass by coincidence.
// ---------------------------------------------------------------------------

const lineups: LineupPair = {
  home: {
    entrantId: "H",
    slots: [
      { personId: "h-gk", positionKey: "GK", slot: "starting", orderNo: 1 },
      { personId: "h-df", positionKey: "DF", slot: "starting", orderNo: 2 },
      { personId: "h-fw", positionKey: "FW", slot: "starting", orderNo: 3, squadNumber: 9 },
      { personId: "h-sub-gk", positionKey: "GK", slot: "bench", orderNo: 4 },
      { personId: "h-sub-mf", positionKey: "MF", slot: "bench", orderNo: 5 },
      { personId: "h-coach", slot: "bench", orderNo: 6, role: "coach" },
    ],
  },
  away: {
    entrantId: "A",
    slots: [
      { personId: "a-gk", positionKey: "GK", slot: "starting", orderNo: 1 },
      { personId: "a-fw", positionKey: "FW", slot: "starting", orderNo: 2 },
      { personId: "a-sub", slot: "bench", orderNo: 3 },
    ],
  },
};

/** A declared doubles pair — tennis/table tennis need the order in pass B. */
const pairLineups: LineupPair = {
  home: {
    entrantId: "H",
    slots: [
      { personId: "h-1", slot: "starting", orderNo: 1, pairOrder: 1 },
      { personId: "h-2", slot: "starting", orderNo: 2, pairOrder: 2 },
    ],
  },
  away: {
    entrantId: "A",
    slots: [{ personId: "a-1", slot: "starting", orderNo: 1, pairOrder: 1 }],
  },
};

const policy = (over: Partial<LineupPolicy> = {}): LineupPolicy => ({
  ...DEFAULT_LINEUP_POLICY,
  ...over,
});

const substitution = (side: string, off: string, on: unknown): LineupEventInput => ({
  type: "core.lineup.substitution",
  payload: { side, off, on },
});
const replacement = (
  side: string,
  off: string,
  on: unknown,
  exemption: string,
): LineupEventInput => ({
  type: "core.lineup.replacement",
  payload: { side, off, on, exemption },
});
const entry = (side: string, on: unknown): LineupEventInput => ({
  type: "core.lineup.entry",
  payload: { side, on },
});
const retirement = (side: string, personId: string): LineupEventInput => ({
  type: "core.lineup.retirement",
  payload: { side, personId },
});
const positionChange = (side: string, personId: string, positionKey: string): LineupEventInput => ({
  type: "core.lineup.position",
  payload: { side, personId, positionKey },
});

/** Unwrap an expected-accept, loudly naming the reason when it refused. */
function accept(result: LineupReduceResult): SquadState {
  if (!result.ok) throw new Error(`expected accept, refused: ${result.reason} — ${result.message}`);
  return result.squads;
}

/** Fold a run of lineup events under one policy, asserting every step accepts. */
function run(start: SquadState, p: LineupPolicy, events: readonly LineupEventInput[]): SquadState {
  return events.reduce((squads, ev) => accept(reduceLineupEvent(squads, ev, p)), start);
}

// ---------------------------------------------------------------------------
// initSquads — the fix that makes the keeper nameable
// ---------------------------------------------------------------------------

describe("initSquads", () => {
  it("names the keeper by identity from the starting lineup", () => {
    const squads = initSquads(lineups);
    // BY IDENTITY, not by field presence: `football.squadFromLineup` dropped
    // positionKey one line after reading it, so "who is in goal" was
    // unanswerable from any folded state in any sport.
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-gk"]);
    expect(personsAtPosition(squads.away, "GK")).toEqual(["a-gk"]);
    expect(personsAtPosition(squads.home, "FW")).toEqual(["h-fw"]);
  });

  it("puts starting slots on the field and bench slots off it", () => {
    const squads = initSquads(lineups);
    expect(onFieldPersons(squads.home)).toEqual(["h-gk", "h-df", "h-fw"]);
    expect(memberOf(squads.home, "h-sub-gk")?.onField).toBe(false);
    expect(memberOf(squads.home, "h-sub-gk")?.started).toBe(false);
    expect(memberOf(squads.home, "h-gk")?.started).toBe(true);
  });

  it("does not give a benched player a live position", () => {
    // h-sub-gk declares GK on the team sheet, but he is not in goal — the
    // position index answers "who is there NOW".
    expect(personsAtPosition(initSquads(lineups).home, "GK")).not.toContain("h-sub-gk");
  });

  it("defaults role to player and keeps a declared coach out of the playing squad", () => {
    const squads = initSquads(lineups);
    expect(memberOf(squads.home, "h-gk")?.role).toBe("player");
    expect(memberOf(squads.home, "h-coach")?.role).toBe("coach");
    // Ruling 3: the coach IS in the squad (a card can be shown to him) but
    // never in a playing projection.
    expect(playingSquad(squads.home).map((m) => m.personId)).not.toContain("h-coach");
    expect(squads.home.members.map((m) => m.personId)).toContain("h-coach");
  });

  it("marks every team-sheet member provenance `named`", () => {
    expect(initSquads(lineups).home.members.every((m) => m.provenance === "named")).toBe(true);
  });

  it("carries squadNumber and the declared pair order", () => {
    expect(memberOf(initSquads(lineups).home, "h-fw")?.squadNumber).toBe(9);
    const pairs = initSquads(pairLineups).home;
    expect(pairs.members.map((m) => m.pairOrder)).toEqual([1, 2]);
  });

  it("starts both sides with no substitutions used", () => {
    const squads = initSquads(lineups);
    expect(squads.home.subsUsed).toBe(0);
    expect(squads.home.exemptUsed).toEqual({});
    expect(sideOf(squads, "A")).toBe("away");
    expect(sideOf(squads, "nobody")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// substitution — the ordinary path
// ---------------------------------------------------------------------------

describe("reduceLineupEvent — substitution", () => {
  it("swaps the players and counts one substitution against the side", () => {
    const after = accept(
      reduceLineupEvent(
        initSquads(lineups),
        substitution("H", "h-fw", { personId: "h-sub-mf", positionKey: "MF", slot: "starting", orderNo: 5 }),
        policy(),
      ),
    );
    expect(onFieldPersons(after.home)).toEqual(["h-gk", "h-df", "h-sub-mf"]);
    expect(personsAtPosition(after.home, "MF")).toEqual(["h-sub-mf"]);
    expect(after.home.subsUsed).toBe(1);
    // The other side never moves.
    expect(after.away.subsUsed).toBe(0);
    expect(onFieldPersons(after.away)).toEqual(["a-gk", "a-fw"]);
  });

  it("does not mutate the squads it was given", () => {
    const before = initSquads(lineups);
    const snapshot = JSON.stringify(before);
    reduceLineupEvent(
      before,
      substitution("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }),
      policy(),
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("refuses a substitution beyond the declared cap", () => {
    const capped = policy({ maxSubs: 1, reentry: "unlimited" });
    const after = run(initSquads(lineups), capped, [
      substitution("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }),
    ]);
    const second = reduceLineupEvent(
      after,
      substitution("H", "h-df", { personId: "h-sub-gk", slot: "starting", orderNo: 4 }),
      capped,
    );
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("sub-cap-reached");
  });

  it("refuses taking a player off who is not on the field", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("H", "h-sub-gk", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }),
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("not-on-field");
  });

  it("refuses bringing on a player who is already on the field", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("H", "h-fw", { personId: "h-df", slot: "starting", orderNo: 2 }),
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("already-on-field");
  });

  it("refuses an unknown side", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("Z", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }),
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("unknown-entrant");
  });

  it("refuses putting a coach on the field", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("H", "h-fw", { personId: "h-coach", slot: "starting", orderNo: 6 }),
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("not-a-player");
  });

  it("refuses to substitute a coach OFF, not only to bring one on (ruling 3)", () => {
    // The mirror of the test above. Both directions matter: `role` is only an
    // enforced rule if it is checked on the way off as well as on the way on,
    // and a coach who could be substituted off would acquire `timesOff` — a
    // playing-record fact — which is exactly what ruling 3 forbids.
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("H", "h-coach", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }),
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("not-a-player");
  });

  it("refuses to GROW the squad with a non-player, even where growth is allowed", () => {
    // Growth and role are independent gates. A variant that permits a
    // mid-fixture addition must not thereby permit adding a coach to the field:
    // the addition path builds its own member and would otherwise bypass the
    // role check that the substitute path applies to team-sheet members.
    const r = reduceLineupEvent(
      initSquads(lineups),
      substitution("H", "h-fw", {
        personId: "h-new-coach",
        slot: "bench",
        orderNo: 24,
        role: "coach",
      }),
      policy({ allowSquadGrowth: true }),
    );
    expect(r.ok === false && r.reason).toBe("not-a-player");
  });
});

// ---------------------------------------------------------------------------
// RULING 2 — re-entry is a cfg knob, and both directions are driven by cfg
// alone: the same events, the same squads, a different policy.
// ---------------------------------------------------------------------------

describe("reduceLineupEvent — re-entry (ruling 2)", () => {
  const off: LineupEventInput = substitution("H", "h-fw", {
    personId: "h-sub-mf",
    positionKey: "FW",
    slot: "starting",
    orderNo: 5,
  });
  const back: LineupEventInput = substitution("H", "h-df", {
    personId: "h-fw",
    positionKey: "FW",
    slot: "starting",
    orderNo: 3,
  });

  it("refuses a return when the variant says `none` (football Law 3.3)", () => {
    const p = policy({ reentry: "none", maxSubs: 5 });
    const after = run(initSquads(lineups), p, [off]);
    const r = reduceLineupEvent(after, back, p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("reentry-forbidden");
    // and the refusal changed nothing
    expect(onFieldPersons(after.home)).not.toContain("h-fw");
  });

  it("allows the SAME return when the variant says `unlimited` (rolling substitution)", () => {
    const p = policy({ reentry: "unlimited", maxSubs: 5 });
    const after = run(initSquads(lineups), p, [off, back]);
    expect(onFieldPersons(after.home)).toContain("h-fw");
    expect(memberOf(after.home, "h-fw")?.timesOff).toBe(1);
    expect(memberOf(after.home, "h-fw")?.timesOn).toBe(1);
  });

  it("allows exactly one return when the variant says `once` (FIVB 15.6)", () => {
    const p = policy({ reentry: "once", maxSubs: 9 });
    const twice = run(initSquads(lineups), p, [
      off,
      back,
      // h-fw goes off a second time…
      substitution("H", "h-fw", { personId: "h-sub-gk", positionKey: "FW", slot: "starting", orderNo: 4 }),
    ]);
    // …and may not come back again.
    const r = reduceLineupEvent(
      twice,
      substitution("H", "h-gk", { personId: "h-fw", positionKey: "FW", slot: "starting", orderNo: 3 }),
      p,
    );
    expect(r.ok === false && r.reason).toBe("reentry-limit");
  });

  it("locks a return to the position left when the variant says so (FIVB 15.6)", () => {
    const p = policy({ reentry: "once", reentryPositionLock: true, maxSubs: 9 });
    const after = run(initSquads(lineups), p, [off]);
    const elsewhere = reduceLineupEvent(
      after,
      substitution("H", "h-df", { personId: "h-fw", positionKey: "MF", slot: "starting", orderNo: 3 }),
      p,
    );
    expect(elsewhere.ok === false && elsewhere.reason).toBe("reentry-position");
    // the same return INTO THE POSITION LEFT is accepted
    expect(accept(reduceLineupEvent(after, back, p))).toBeDefined();
  });

  it("does not apply the position lock when the variant does not ask for it", () => {
    const p = policy({ reentry: "once", reentryPositionLock: false, maxSubs: 9 });
    const after = run(initSquads(lineups), p, [off]);
    const elsewhere = reduceLineupEvent(
      after,
      substitution("H", "h-df", { personId: "h-fw", positionKey: "MF", slot: "starting", orderNo: 3 }),
      p,
    );
    expect(elsewhere.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RULING 1 — a squad may grow, gated in cfg, default off, provenance recorded
// ---------------------------------------------------------------------------

describe("reduceLineupEvent — squad growth (ruling 1)", () => {
  const outsider = entry("H", {
    personId: "h-new",
    positionKey: "MF",
    slot: "starting",
    orderNo: 12,
    squadNumber: 23,
  });

  it("refuses a person off the team sheet by default", () => {
    const r = reduceLineupEvent(initSquads(lineups), outsider, policy());
    expect(DEFAULT_LINEUP_POLICY.allowSquadGrowth).toBe(false);
    expect(r.ok === false && r.reason).toBe("squad-growth-forbidden");
  });

  it("admits one when the variant permits it, recording provenance `added`", () => {
    const after = accept(
      reduceLineupEvent(initSquads(lineups), outsider, policy({ allowSquadGrowth: true })),
    );
    const added = memberOf(after.home, "h-new");
    expect(added?.provenance).toBe("added");
    expect(added?.started).toBe(false);
    expect(added?.squadNumber).toBe(23);
    expect(personsAtPosition(after.home, "MF")).toEqual(["h-new"]);
    // A grown entry is distinguishable from every team-sheet member.
    expect(
      after.home.members.filter((m) => m.provenance === "named").map((m) => m.personId),
    ).not.toContain("h-new");
  });

  it("does not treat a first appearance as a re-entry", () => {
    // `reentry: none` must not refuse someone who has never been on the field.
    const after = accept(
      reduceLineupEvent(
        initSquads(lineups),
        outsider,
        policy({ allowSquadGrowth: true, reentry: "none" }),
      ),
    );
    expect(onFieldPersons(after.home)).toContain("h-new");
  });
});

// ---------------------------------------------------------------------------
// replacement — the exemption channel (concussion, blood, FIVB libero)
// ---------------------------------------------------------------------------

describe("reduceLineupEvent — replacement exemptions", () => {
  it("holds a named exemption outside the substitution cap", () => {
    const p = policy({ maxSubs: 0, exemptions: { concussion: {} } });
    const after = accept(
      reduceLineupEvent(
        initSquads(lineups),
        replacement("H", "h-fw", { personId: "h-sub-mf", positionKey: "FW", slot: "starting", orderNo: 5 }, "concussion"),
        p,
      ),
    );
    // The cap is exhausted (0) and the replacement still went through.
    expect(after.home.subsUsed).toBe(0);
    expect(after.home.exemptUsed).toEqual({ concussion: 1 });
    expect(onFieldPersons(after.home)).toContain("h-sub-mf");
  });

  it("refuses an exemption the variant does not declare", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      replacement("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }, "concussion"),
      policy({ exemptions: {} }),
    );
    expect(r.ok === false && r.reason).toBe("exemption-not-declared");
  });

  it("counts each exemption against its own cap", () => {
    const p = policy({ maxSubs: 5, exemptions: { concussion: { max: 1 } }, reentry: "unlimited" });
    const after = run(initSquads(lineups), p, [
      replacement("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }, "concussion"),
    ]);
    const second = reduceLineupEvent(
      after,
      replacement("H", "h-df", { personId: "h-sub-gk", slot: "starting", orderNo: 4 }, "concussion"),
      p,
    );
    expect(second.ok === false && second.reason).toBe("exemption-cap-reached");
    // …while an ordinary substitution is still available.
    expect(
      reduceLineupEvent(
        after,
        substitution("H", "h-df", { personId: "h-sub-gk", slot: "starting", orderNo: 4 }),
        p,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// position change, retirement, entry
// ---------------------------------------------------------------------------

describe("reduceLineupEvent — position, retirement, entry", () => {
  it("renames the keeper on a position change, by identity", () => {
    const after = accept(
      reduceLineupEvent(initSquads(lineups), positionChange("H", "h-df", "GK"), policy()),
    );
    // h-df takes the gloves; the position index answers with HIM.
    expect(personsAtPosition(after.home, "GK")).toContain("h-df");
    expect(personsAtPosition(after.home, "DF")).toEqual([]);
  });

  it("refuses a position change for someone off the field", () => {
    const r = reduceLineupEvent(initSquads(lineups), positionChange("H", "h-sub-mf", "GK"), policy());
    expect(r.ok === false && r.reason).toBe("not-on-field");
  });

  it("refuses a position change for a person who is not in the squad at all", () => {
    // Distinct from the branch above: `not-on-field` says "known, benched",
    // `unknown-person` says "never named". Collapsing them would let a typo in
    // a personId read as a benched player and refuse for the wrong reason.
    const r = reduceLineupEvent(initSquads(lineups), positionChange("H", "h-ghost", "GK"), policy());
    expect(r.ok === false && r.reason).toBe("unknown-person");
  });

  it("refuses to move a coach into a position (ruling 3)", () => {
    // A coach is on the team sheet and has no `onField` of their own, so the
    // role check must come BEFORE the on-field check or this refuses as
    // `not-on-field` and the ruling reads as an accident of ordering.
    const r = reduceLineupEvent(initSquads(lineups), positionChange("H", "h-coach", "GK"), policy());
    expect(r.ok === false && r.reason).toBe("not-a-player");
  });

  it("takes a retiring player off with nobody coming on", () => {
    const after = accept(reduceLineupEvent(initSquads(lineups), retirement("H", "h-fw"), policy()));
    expect(onFieldPersons(after.home)).toEqual(["h-gk", "h-df"]);
    expect(memberOf(after.home, "h-fw")?.timesOff).toBe(1);
    // A retirement is not a substitution and must not consume the cap.
    expect(after.home.subsUsed).toBe(0);
  });

  it("lets a retired-hurt player resume where the variant allows a return", () => {
    // Cricket: a retired-hurt batter may resume. Same model, cfg knob only.
    const p = policy({ reentry: "once" });
    const after = run(initSquads(lineups), p, [
      retirement("H", "h-fw"),
      entry("H", { personId: "h-fw", positionKey: "FW", slot: "starting", orderNo: 3 }),
    ]);
    expect(onFieldPersons(after.home)).toContain("h-fw");
    expect(memberOf(after.home, "h-fw")?.timesOn).toBe(1);
  });

  it("refuses that resume where the variant forbids a return", () => {
    const p = policy({ reentry: "none" });
    const after = run(initSquads(lineups), p, [retirement("H", "h-fw")]);
    const r = reduceLineupEvent(
      after,
      entry("H", { personId: "h-fw", slot: "starting", orderNo: 3 }),
      p,
    );
    expect(r.ok === false && r.reason).toBe("reentry-forbidden");
  });

  it("refuses an unknown event type rather than silently accepting it", () => {
    const r = reduceLineupEvent(
      initSquads(lineups),
      { type: "core.lineup.teleport", payload: {} },
      policy(),
    );
    expect(r.ok === false && r.reason).toBe("unknown-lineup-event");
  });
});

// ---------------------------------------------------------------------------
// The non-negotiable: no cfg-derived condition may THROW inside the reducer.
// A throw here is a fold throw, and a fold throw on replay permanently bricks
// every recorded fixture in the division (W4a, 6×).
// ---------------------------------------------------------------------------

describe("reduceLineupEvent never throws", () => {
  const cases: readonly [string, LineupPolicy, LineupEventInput][] = [
    [
      "forbidden re-entry",
      policy({ reentry: "none" }),
      substitution("H", "h-df", { personId: "h-fw", slot: "starting", orderNo: 3 }),
    ],
    [
      "forbidden growth",
      policy({ allowSquadGrowth: false }),
      entry("H", { personId: "stranger", slot: "starting", orderNo: 9 }),
    ],
    ["exhausted cap", policy({ maxSubs: 0 }), substitution("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 })],
    [
      "undeclared exemption",
      policy({ exemptions: {} }),
      replacement("H", "h-fw", { personId: "h-sub-mf", slot: "starting", orderNo: 5 }, "blood"),
    ],
    ["unknown side", policy(), substitution("Z", "x", { personId: "y", slot: "starting", orderNo: 1 })],
    ["unknown person", policy(), retirement("H", "ghost")],
    ["malformed payload", policy(), { type: "core.lineup.substitution", payload: { nope: true } }],
    ["null payload", policy(), { type: "core.lineup.retirement", payload: null }],
  ];

  it.each(cases)("refuses %s without throwing", (_name, p, event) => {
    const squads = initSquads(lineups);
    let result: LineupReduceResult | undefined;
    expect(() => {
      result = reduceLineupEvent(squads, event, p);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });
});
