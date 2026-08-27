// R5-1 (owner ruling, R5 dispatch) — `setBasedServeContext`, the reader v3/09
// defect D-17 was open for: the v2 pad rendered "—" for who is serving on
// badminton, table tennis AND volleyball, because this kernel folded no
// serving fact and three per-skin derivations were rejected outright.
//
// EVERY FIXTURE HERE IS A REAL FOLD. `foldMatch(module, cfg, lineups, events)`
// is the product's own read path; nothing below hand-builds a `SetBasedState`
// literal, because a state literal shaped like the implementation proves the
// literal. The expectations are written from the law (BWF 8.1/10.1, ITTF
// 2.13.3/2.13.5/2.13.6/2.15.3, FIVB 7.1/7.6.2/12.2.2/19.3.2.4) as explicit
// tables, not recomputed with the kernel's own arithmetic.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";
import {
  setBasedServeContext,
  type SetBasedCfg,
  type SetBasedModule,
  type SetBasedServeContext,
  type SetBasedState,
} from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => ev(i, type, payload ?? {}));
}

/** A one-per-side sheet — singles, no declared order. */
function singlesSide(entrantId: string): Lineup {
  return { entrantId, slots: [{ personId: `${entrantId}-p1`, slot: "starting", orderNo: 1 }] };
}
const SINGLES: LineupPair = { home: singlesSide("H"), away: singlesSide("A") };

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
const DOUBLES: LineupPair = { home: pairSide("H", "H-a", "H-b"), away: pairSide("A", "A-a", "A-b") };

/**
 * Six on court plus a coach. The coach is what makes `state.squads` PERSIST —
 * `declaresSquadDetail` keeps the snapshot only when it says something the
 * team sheet does not, and a non-`player` role is one of the two ways it can
 * (sports/squad-state.ts). Without it an indoor volleyball fold carries no
 * squad at all and the rotation number has nothing to check its size against.
 */
function sixSide(entrantId: string): Lineup {
  return {
    entrantId,
    slots: [
      ...["S", "OH", "MB", "OPP", "OH", "MB"].map((positionKey, i) => ({
        personId: `${entrantId}-p${i + 1}`,
        positionKey,
        slot: "starting" as const,
        orderNo: i + 1,
      })),
      { personId: `${entrantId}-coach`, slot: "bench" as const, orderNo: 7, role: "coach" as const },
    ],
  };
}
const SIX: LineupPair = { home: sixSide("H"), away: sixSide("A") };

function ctx(
  mod: SetBasedModule,
  cfg: SetBasedCfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): SetBasedServeContext {
  const state: SetBasedState = foldMatch(mod, cfg, lineups, events, STRICT_ALL);
  const before = JSON.stringify(state);
  const answer = setBasedServeContext(mod, state, events);
  // A pure reader: no fold effect, ever. The whole design rests on this — a
  // reader that touched the state would move eleven frozen corpora.
  expect(JSON.stringify(state)).toBe(before);
  // The contract every caller renders against: a side is named exactly when
  // the order is known, and a reason is given exactly when it is not.
  expect(answer.serveOrderKnown).toBe(answer.servingSide !== null);
  expect(answer.serveOrderKnown).toBe(answer.unknownBecause === undefined);
  if (!answer.serveOrderKnown) expect(answer.serverPersonId).toBeNull();
  return answer;
}

/** The reader after the first `n` events of a stream. */
function ctxAfter(
  mod: SetBasedModule,
  cfg: SetBasedCfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  n: number,
): SetBasedServeContext {
  return ctx(mod, cfg, lineups, events.slice(0, n));
}

const rally = (mod: SetBasedModule, payload: unknown): [string, unknown] => [
  `${mod.key}.rally`,
  payload,
];
const summary = (mod: SetBasedModule, payload: unknown): [string, unknown] => [
  `${mod.key}.${mod.coarseEventType}`,
  payload,
];

// ---------------------------------------------------------------------------
// Badminton — BWF Laws 8.1 and 10.1 (side-out, previous game's winner opens)
// ---------------------------------------------------------------------------

describe("badminton — side-out", () => {
  const cfg = badminton.configSchema.parse({});

  it("names nobody before the first rally: the one datum the ledger cannot supply", () => {
    const answer = ctx(badminton, cfg, SINGLES, stream(["core.start"]));
    expect(answer).toEqual({
      servingSide: null,
      side: null,
      serverPersonId: null,
      serveOrderKnown: false,
      unknownBecause: "undeclared",
    });
  });

  it("takes the first rally's declared `serving` as the anchor and then follows the rally winners", () => {
    // BWF 10.1 — the side winning a rally serves the next one. Expectation
    // written as the law reads, not recomputed.
    const winners = ["H", "H", "A", "A", "H", "A", "H", "H"] as const;
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      ...winners.slice(1).map((wonBy) => rally(badminton, { wonBy })),
    );
    expect(ctxAfter(badminton, cfg, SINGLES, events, 1).servingSide).toBeNull();
    for (let played = 1; played <= winners.length; played += 1) {
      const answer = ctxAfter(badminton, cfg, SINGLES, events, played + 1);
      expect({ played, side: answer.servingSide }).toEqual({
        played,
        side: winners[played - 1],
      });
    }
  });

  it("answers from the ledger alone once one rally has been played — no declaration at all", () => {
    // The consequence of side-out that makes the anchor a ONE-datum problem:
    // with no `serving` anywhere, the winner of the last rally still serves.
    const events = stream(["core.start"], rally(badminton, { wonBy: "A" }));
    const answer = ctx(badminton, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serveOrderKnown).toBe(true);
    // The set's opener is still unknown, so the turn count is absent rather
    // than guessed — an omitted fact, never a fabricated one.
    expect(answer.serviceTurn).toBeUndefined();
  });

  it("opens game 2 with the winner of game 1 (Law 8.1) — derivable with no declaration", () => {
    const events = stream(["core.start"], summary(badminton, { home: 21, away: 15 }));
    const answer = ctx(badminton, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("H");
    expect(answer.serviceTurn).toBe(0);
  });

  it("counts the serving side's own service turns across side-outs", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }), // H's turn 0, H holds
      rally(badminton, { wonBy: "H" }), // still H's turn 0
      rally(badminton, { wonBy: "A" }), // A takes the serve: A's turn 0
      rally(badminton, { wonBy: "H" }), // H takes it back: H's turn 1
    );
    expect(ctxAfter(badminton, cfg, SINGLES, events, 3).serviceTurn).toBe(0);
    expect(ctxAfter(badminton, cfg, SINGLES, events, 4).serviceTurn).toBe(0);
    expect(ctxAfter(badminton, cfg, SINGLES, events, 5).serviceTurn).toBe(1);
  });

  it("never names a PERSON, even off a full doubles sheet (Law 10.5 is a service COURT rule)", () => {
    const events = stream(["core.start"], rally(badminton, { wonBy: "H", serving: "H" }));
    const answer = ctx(badminton, cfg, DOUBLES, events);
    expect(answer.servingSide).toBe("H");
    expect(answer.serverPersonId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two drift detectors (R4-7) and the narrowness of each refusal (D-24)
// ---------------------------------------------------------------------------

describe("drift detection stays as narrow as the fact justifies", () => {
  const cfg = badminton.configSchema.parse({});
  // A legal competition config with short games, so a game can be played out
  // rally by rally in a readable stream. `applySummary` refuses a completed
  // summary for a set that is being scored rally-by-rally (dual fidelity is
  // per set), so a cross-set case cannot mix the two fidelities.
  const short = badminton.configSchema.parse({ setTo: 3, finalSetTo: 3, cap: 5 });

  it("a rally whose `serving` AGREES with the fold changes nothing", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      rally(badminton, { wonBy: "A", serving: "H" }), // H served, A won it
      rally(badminton, { wonBy: "A", serving: "A" }), // so A serves — agreed
    );
    const answer = ctx(badminton, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serviceTurn).toBe(0);
  });

  it("reports unknown when a recorded `serving` contradicts the fold, rather than patching either", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }), // H wins, so H serves next
      rally(badminton, { wonBy: "A", serving: "A" }), // …but the pad says A did
    );
    expect(ctx(badminton, cfg, SINGLES, events).unknownBecause).toBe("recorded-disagrees");
  });

  it("and the NEXT game still names a server — the refusal is set-scoped, not match-scoped", () => {
    // D-24: R4 shipped a guard that killed the feature for the rest of any
    // match containing one summary, and its own test agreed with it. This is
    // the case that must still WORK.
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      rally(badminton, { wonBy: "A", serving: "A" }), // contradiction, game 1
      rally(badminton, { wonBy: "A" }),
      rally(badminton, { wonBy: "A" }), // game 1 to A, 3-1
    );
    expect(ctxAfter(badminton, short, SINGLES, events, 3).unknownBecause).toBe("recorded-disagrees");
    const next = ctx(badminton, short, SINGLES, events);
    expect(next.servingSide).toBe("A"); // Law 8.1: the game's winner opens
    expect(next.serviceTurn).toBe(0);
  });

  it("a partial summary breaks a side-out chain — the rallies it swallowed ARE the rotation", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      summary(badminton, { by: "H", forBy: 6, forOpp: 3, partial: true }),
    );
    expect(ctx(badminton, cfg, SINGLES, events).unknownBecause).toBe("score-jumped");
  });

  it("and the very next rally names the side again, though the turn count stays absent", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      summary(badminton, { by: "H", forBy: 6, forOpp: 3, partial: true }),
      rally(badminton, { wonBy: "A" }),
    );
    const answer = ctx(badminton, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serviceTurn).toBeUndefined();
  });

  it("reports `ledger-mismatch` rather than a confident answer when the ledger is not this state's", () => {
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      rally(badminton, { wonBy: "H" }),
      rally(badminton, { wonBy: "A" }),
    );
    const state = foldMatch(badminton, cfg, SINGLES, events, STRICT_ALL);
    const truncated = events.slice(0, 3);
    expect(setBasedServeContext(badminton, state, truncated)).toEqual({
      servingSide: null,
      side: null,
      serverPersonId: null,
      serveOrderKnown: false,
      unknownBecause: "ledger-mismatch",
    });
  });

  it("names nobody once the match is over", () => {
    const events = stream(
      ["core.start"],
      summary(badminton, { home: 21, away: 15 }),
      summary(badminton, { home: 21, away: 17 }),
    );
    expect(ctx(badminton, cfg, SINGLES, events).unknownBecause).toBe("match-over");
  });

  it("ignores a voided rally, exactly as the fold does", () => {
    const events = [
      ...stream(
        ["core.start"],
        rally(badminton, { wonBy: "H", serving: "H" }),
        rally(badminton, { wonBy: "A" }),
      ),
      makeEnvelope(3, { type: "core.void", payload: {} }, "e-2"),
    ];
    // `e-2` is the second rally (helpers.ts ids events `e-${seq}`); voiding it
    // puts the serve back with H, who won the rally that still stands.
    expect(ctx(badminton, cfg, SINGLES, events).servingSide).toBe("H");
  });
});

// ---------------------------------------------------------------------------
// Table tennis — ITTF 2.13.3 (two each), 2.13.5 (deuce), 2.13.6 (alternate)
// ---------------------------------------------------------------------------

describe("table tennis — two serves each, one each at deuce", () => {
  const cfg = tabletennis.configSchema.parse({});

  /** ITTF 2.13.3/2.13.5, written out. `H` serves the first point of the game;
   *  index = points already played. Ten turns of two, then one each. */
  const ITTF_SERVER = [
    "H", "H", "A", "A", "H", "H", "A", "A", "H", "H",
    "A", "A", "H", "H", "A", "A", "H", "H", "A", "A",
    "H", "A", "H", "A", "H",
  ] as const;
  const ITTF_SERVE_NUMBER = [
    1, 2, 1, 2, 1, 2, 1, 2, 1, 2,
    1, 2, 1, 2, 1, 2, 1, 2, 1, 2,
    1, 1, 1, 1, 1,
  ] as const;

  // Strictly alternating winners never reach a two-point lead, so the game
  // runs past 10-all and into the one-serve-each endgame (2.13.5) — the range
  // the boundary actually lives in, rather than one lucky score.
  const alternating = stream(
    ["core.start"],
    rally(tabletennis, { wonBy: "H", serving: "H" }),
    ...Array.from({ length: ITTF_SERVER.length - 1 }, (_unused, i) =>
      rally(tabletennis, { wonBy: i % 2 === 0 ? "A" : "H" }),
    ),
  );

  it("follows the ITTF rotation at every point through 10-all and beyond", () => {
    // From 1: index 0 is the anchor rally itself, and before it is recorded
    // there is nothing to know (asserted separately).
    for (let played = 1; played < ITTF_SERVER.length; played += 1) {
      const answer = ctxAfter(tabletennis, cfg, SINGLES, alternating, played + 1);
      expect({ played, side: answer.servingSide, serve: answer.serveNumber }).toEqual({
        played,
        side: ITTF_SERVER[played],
        serve: ITTF_SERVE_NUMBER[played],
      });
    }
  });

  it("counts each side's own service turns", () => {
    const turns = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
    for (let played = 1; played < turns.length; played += 1) {
      expect({
        played,
        turn: ctxAfter(tabletennis, cfg, SINGLES, alternating, played + 1).serviceTurn,
      }).toEqual({ played, turn: turns[played] });
    }
  });

  it("alternates the opening serve between games (2.13.6)", () => {
    const short = tabletennis.configSchema.parse({ setTo: 3, finalSetTo: 3 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }),
      rally(tabletennis, { wonBy: "H" }),
      rally(tabletennis, { wonBy: "H" }), // game 1 to H, 3-0
    );
    expect(ctx(tabletennis, short, SINGLES, events).servingSide).toBe("A");
  });

  it("a partial summary costs the rotation NOTHING — the score is the whole input", () => {
    // The mirror image of badminton's `score-jumped`: the same event, the same
    // kernel, opposite answers, because the two federations rotate on
    // different facts. A guard that refused both would be over-refusing.
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }),
      summary(tabletennis, { by: "H", forBy: 3, forOpp: 1, partial: true }),
    );
    // Four points played (1 rallied + the snapshot's 3-1) → service turn 2 →
    // the game's opener again, first serve of the turn.
    const answer = ctx(tabletennis, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("H");
    expect(answer.serveNumber).toBe(1);
    expect(answer.serviceTurn).toBe(1);
  });

  it("back-derives the game's opener from a declaration made in the middle of it", () => {
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H" }),
      rally(tabletennis, { wonBy: "A" }),
      rally(tabletennis, { wonBy: "H", serving: "A" }), // point 2 → A's turn
    );
    expect(ctxAfter(tabletennis, cfg, SINGLES, events, 3).unknownBecause).toBe("undeclared");
    const answer = ctx(tabletennis, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("A"); // point 3 is still A's turn
    expect(answer.serveNumber).toBe(2);
    expect(answer.serviceTurn).toBe(0);
  });

  it("accelerates at the variant's OWN deuce, not a hardcoded 10-all", () => {
    // `hardbat-21` plays to 21, so 2.13.5 bites at 20-all. At 11-11 (22 points)
    // the standard game is long over and the legacy one is still two-each.
    const hardbat = tabletennis.configSchema.parse(tabletennis.variants["hardbat-21"]);
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }),
      ...Array.from({ length: 21 }, (_unused, i) =>
        rally(tabletennis, { wonBy: i % 2 === 0 ? "A" : "H" }),
      ),
    );
    // 22 points played: 11 turns of two → turn 11 → the opponent of the opener.
    const answer = ctx(tabletennis, hardbat, SINGLES, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serveNumber).toBe(1);
  });

  it("gives each serve its own turn from the moment expedite is introduced (2.15.3)", () => {
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }), // p0 H
      rally(tabletennis, { wonBy: "A" }), // p1 H
      rally(tabletennis, { wonBy: "H" }), // p2 A
      rally(tabletennis, { wonBy: "A" }), // p3 A
      rally(tabletennis, { wonBy: "H" }), // p4 H  → 5 points played
      [`${tabletennis.key}.expedite.start`, {}],
      rally(tabletennis, { wonBy: "A" }), // p5 — the cut-short turn ends here
      rally(tabletennis, { wonBy: "H" }), // p6
      rally(tabletennis, { wonBy: "A" }), // p7
    );
    // Before expedite the fifth point is still in H's turn; after it every
    // point is its own turn, so the sides alternate one for one.
    expect(ctxAfter(tabletennis, cfg, SINGLES, events, 6).servingSide).toBe("H");
    const after = ["A", "H", "A"];
    for (let i = 0; i < after.length; i += 1) {
      const answer = ctxAfter(tabletennis, cfg, SINGLES, events, 7 + i);
      expect({ i, side: answer.servingSide, serve: answer.serveNumber }).toEqual({
        i,
        side: after[i],
        serve: 1,
      });
    }
  });

  it("names the doubles server down the sheet's declared pair order (2.13.4)", () => {
    // ITTF 2.13.4's A-X-B-Y cycle, by points already played (index 0 is the
    // anchor rally itself). Each side's own turns walk down its declared order.
    const expected = [null, "H-a", "A-a", "A-a", "H-b", "H-b", "A-b", "A-b", "H-a"];
    for (let played = 1; played < expected.length; played += 1) {
      const answer = ctxAfter(tabletennis, cfg, DOUBLES, alternating, played + 1);
      expect({ played, person: answer.serverPersonId }).toEqual({
        played,
        person: expected[played],
      });
    }
  });

  it("names no person for a singles sheet that declares no order", () => {
    expect(ctxAfter(tabletennis, cfg, SINGLES, alternating, 2).serverPersonId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Volleyball — FIVB 7.1 (the deciding set is tossed), 7.6.2, 19.3.2.4
// ---------------------------------------------------------------------------

describe("volleyball", () => {
  const cfg = volleyball.configSchema.parse({});
  const beach = volleyball.configSchema.parse(volleyball.variants["beach"]);
  // Short sets, so set one can be RALLIED out (the anchor has to ride a rally)
  // and the later ones summarised — the two fidelities may not be mixed inside
  // one set, only between sets.
  const short = volleyball.configSchema.parse({ setTo: 3, finalSetTo: 3 });

  /** Set one, opened by a declared serve and played out three-nil. */
  const setOneToHome = [
    ["core.start"] as [string, unknown],
    rally(volleyball, { wonBy: "H", serving: "H" }),
    rally(volleyball, { wonBy: "H" }),
    rally(volleyball, { wonBy: "H" }),
  ];

  it("alternates the opening serve for sets 2-4", () => {
    const events = stream(...setOneToHome);
    expect(ctx(volleyball, short, SIX, events).servingSide).toBe("A");
  });

  it("stops at the deciding set's door — FIVB 7.1 tosses for it afresh", () => {
    const events = stream(
      ...setOneToHome,
      summary(volleyball, { home: 0, away: 3 }), // set 2 to A
      summary(volleyball, { home: 3, away: 0 }), // set 3 to H
      summary(volleyball, { home: 0, away: 3 }), // set 4 to A — 2-2
    );
    // Set four opened with A (H, A, H, A down the alternation).
    expect(ctxAfter(volleyball, short, SIX, events, 6).servingSide).toBe("A");
    expect(ctx(volleyball, short, SIX, events).unknownBecause).toBe("deciding-set-toss");
  });

  it("and recovers after ONE rally of it — side-out answers for itself", () => {
    // The D-24 counter-test for the toss refusal: it must not swallow the
    // whole deciding set.
    const events = stream(
      ...setOneToHome,
      summary(volleyball, { home: 0, away: 3 }),
      summary(volleyball, { home: 3, away: 0 }),
      summary(volleyball, { home: 0, away: 3 }),
      rally(volleyball, { wonBy: "A" }),
    );
    const answer = ctx(volleyball, short, SIX, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serviceTurn).toBeUndefined(); // the set's opener is still untold
  });

  it("numbers the rotation off the lineup the side started the set with (7.6.2)", () => {
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }), // H opened, holds serve
      rally(volleyball, { wonBy: "A" }), // A takes it: A rotates once
      rally(volleyball, { wonBy: "H" }), // H takes it back: H rotates once
    );
    expect(ctxAfter(volleyball, cfg, SIX, events, 2).rotation).toBe(1);
    expect(ctxAfter(volleyball, cfg, SIX, events, 3).rotation).toBe(2);
    expect(ctxAfter(volleyball, cfg, SIX, events, 4).rotation).toBe(2);
  });

  it("gives a beach PAIR no six-position rotation number, but does name its server", () => {
    const events = stream(["core.start"], rally(volleyball, { wonBy: "H", serving: "H" }));
    const answer = ctx(volleyball, beach, DOUBLES, events);
    expect(answer.servingSide).toBe("H");
    expect(answer.rotation).toBeUndefined();
    expect(answer.serverPersonId).toBe("H-a");
  });

  it("names no person off a six-long 'order' — a pair is two people", () => {
    const sixWithOrder = (entrantId: string): Lineup => ({
      entrantId,
      slots: ["S", "OH", "MB", "OPP", "OH", "MB"].map((positionKey, i) => ({
        personId: `${entrantId}-p${i + 1}`,
        positionKey,
        slot: "starting" as const,
        orderNo: i + 1,
        pairOrder: i + 1,
      })),
    });
    const events = stream(["core.start"], rally(volleyball, { wonBy: "H", serving: "H" }));
    const answer = ctx(
      volleyball,
      cfg,
      { home: sixWithOrder("H"), away: sixWithOrder("A") },
      events,
    );
    expect(answer.servingSide).toBe("H");
    expect(answer.serverPersonId).toBeNull();
  });

  it("never names a LIBERO as server (19.3.2.4), and still names their partner", () => {
    const liberoFirst = (entrantId: string): Lineup => ({
      entrantId,
      slots: [
        {
          personId: `${entrantId}-lib`,
          slot: "starting",
          orderNo: 1,
          pairOrder: 1,
          roles: ["libero"],
        },
        { personId: `${entrantId}-b`, slot: "starting", orderNo: 2, pairOrder: 2 },
      ],
    });
    const lineups = { home: liberoFirst("H"), away: liberoFirst("A") };
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }), // H's turn 0 → the libero
      rally(volleyball, { wonBy: "A" }), // A's turn 0 → their libero
      rally(volleyball, { wonBy: "H" }), // H's turn 1 → the partner
    );
    const barred = ctxAfter(volleyball, beach, lineups, events, 2);
    expect(barred.servingSide).toBe("H"); // the SIDE is not in doubt
    expect(barred.serverPersonId).toBeNull();
    const partner = ctx(volleyball, beach, lineups, events);
    expect(partner.serverPersonId).toBe("H-b");
  });
});
