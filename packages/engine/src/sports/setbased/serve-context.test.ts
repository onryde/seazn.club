// R5-1 (owner ruling, R5 dispatch) — `setBasedServeContext`, the reader v3/09
// defect D-17 was open for: the v2 pad rendered "—" for who is serving on
// badminton, table tennis AND volleyball, because this kernel folded no
// serving fact and three per-skin derivations were rejected outright.
//
// EVERY FIXTURE HERE IS A REAL FOLD. `foldMatch(module, cfg, lineups, events)`
// is the product's own read path; nothing below hand-builds a `SetBasedState`
// literal, because a state literal shaped like the implementation proves the
// literal. The expectations are written from the law (BWF 7.6/10.3/11, ITTF
// 2.13.3/2.13.6/2.15.3, FIVB 7.6.2/12.1.1/12.1.2/12.2.2/19.3.2.4) as explicit
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

/** The sheet a referee actually files: six starters, positions, and NOTHING
 *  the pre-wave lineup model could not already hold — so `declaresSquadDetail`
 *  keeps no snapshot and `state.squads` is absent. */
function sixPlainSide(entrantId: string): Lineup {
  return {
    entrantId,
    slots: ["S", "OH", "MB", "OPP", "OH", "MB"].map((positionKey, i) => ({
      personId: `${entrantId}-p${i + 1}`,
      positionKey,
      slot: "starting" as const,
      orderNo: i + 1,
    })),
  };
}
const SIX_PLAIN: LineupPair = { home: sixPlainSide("H"), away: sixPlainSide("A") };

/** A pair whose sheet declares no order at all — two starters, nothing else. */
function barePairSide(entrantId: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: `${entrantId}-a`, slot: "starting", orderNo: 1 },
      { personId: `${entrantId}-b`, slot: "starting", orderNo: 2 },
    ],
  };
}

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
// Badminton — BWF Laws 7.6 and 10.3 (side-out, previous game's winner opens)
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
    // BWF 10.3 — the side winning a rally serves the next one. Expectation
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

  it("opens game 2 with the winner of game 1 (Law 7.6) — derivable with no declaration", () => {
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

  it("never names a PERSON, even off a full doubles sheet (Law 11 is a service COURT rule)", () => {
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
    expect(next.servingSide).toBe("A"); // Law 7.6: the game's winner opens
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

  it("a partial summary that RESTATES the score costs the chain nothing", () => {
    // `score-jumped` exists because the rallies a snapshot swallowed ARE the
    // side-out rotation. A snapshot that swallowed none has taken nothing
    // away, so the refusal is conditioned on the score actually MOVING —
    // untested until now, and a guard nothing tests is a guard nothing keeps.
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      summary(badminton, { by: "H", forBy: 1, forOpp: 0, partial: true }), // 1-0, again
    );
    const answer = ctx(badminton, cfg, SINGLES, events);
    expect(answer.servingSide).toBe("H");
    expect(answer.serviceTurn).toBe(0); // the chain is whole, not merely the side
  });

  it("names nobody once the ledger is FINALISED, or the match was abandoned", () => {
    // `match-over` has three phases and only `done` was covered. A finalised
    // ledger and an abandoned fixture would both otherwise answer with the
    // side the last event left serving.
    const finalised = stream(
      ["core.start"],
      summary(badminton, { home: 21, away: 15 }),
      summary(badminton, { home: 21, away: 17 }),
      ["core.finalize", {}],
    );
    expect(ctx(badminton, cfg, SINGLES, finalised).unknownBecause).toBe("match-over");
    const abandoned = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      ["core.abandon", { reason: "hall flooded" }],
    );
    expect(ctx(badminton, cfg, SINGLES, abandoned).unknownBecause).toBe("match-over");
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

  it("degrades to `ledger-mismatch` rather than throwing on a void with no legal target", () => {
    // `resolveVoids` throws `INVALID_EVENT` for a `core.void` whose target is
    // unknown, later, or itself a void (core/events.ts). This reader is read
    // synchronously during render by a v3 skin with no try/catch of its own,
    // so it must degrade exactly like every other refusal `setBasedServeWalk`
    // produces, not crash the caller — see that function's doc comment in
    // kernel.ts.
    const events = stream(
      ["core.start"],
      rally(badminton, { wonBy: "H", serving: "H" }),
      rally(badminton, { wonBy: "A" }),
    );
    const state = foldMatch(badminton, cfg, SINGLES, events, STRICT_ALL);
    const danglingVoid = [
      ...events,
      makeEnvelope(3, { type: "core.void", payload: {} }, "no-such-event-id"),
    ];
    expect(() => setBasedServeContext(badminton, state, danglingVoid)).not.toThrow();
    expect(setBasedServeContext(badminton, state, danglingVoid)).toEqual({
      servingSide: null,
      side: null,
      serverPersonId: null,
      serveOrderKnown: false,
      unknownBecause: "ledger-mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// Table tennis — ITTF 2.13.3 (two each, one each at deuce), 2.13.6 (alternate)
// ---------------------------------------------------------------------------

describe("table tennis — two serves each, one each at deuce", () => {
  const cfg = tabletennis.configSchema.parse({});

  /** ITTF 2.13.3, written out. `H` serves the first point of the game;
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
  // runs past 10-all and into the one-serve-each endgame (2.13.3) — the range
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

  it("alternates off the game's first SERVER, not its winner (2.13.6)", () => {
    // In every other alternate fixture the opener also WINS the game, which
    // makes "opponent of the opener" and "opponent of the winner" the same
    // side and pins nothing. Here H opens game 1 and LOSES it 0-3, so the two
    // readings disagree: 2.13.6 keys on the first SERVER, and the opener of
    // game 2 is A. (FIVB 12.1.2 says the same thing for volleyball, and has
    // its own fixture below.)
    const short = tabletennis.configSchema.parse({ setTo: 3, finalSetTo: 3 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "A", serving: "H" }), // H served it, A won it
      rally(tabletennis, { wonBy: "A" }),
      rally(tabletennis, { wonBy: "A" }), // game 1 to A, 0-3 — the opener lost
    );
    const game2 = ctx(tabletennis, short, SINGLES, events);
    expect(game2.servingSide).toBe("A");
    expect(game2.serviceTurn).toBe(0);
    expect(game2.serveNumber).toBe(1);
  });

  it("refuses to alternate off a DISPUTED opener — a contradiction leaves game 2 unopened", () => {
    // 2.13.6 makes the next game's opener the OPPONENT OF THIS GAME'S FIRST
    // SERVER, so the alternation turns on `firstServer` — the very derivation
    // a `recorded-disagrees` disputes. Badminton's Law 7 re-anchor reads the
    // game score, which a contradiction does not touch; this one has nothing
    // sound left to turn on, so it refuses rather than answering off it.
    const short = tabletennis.configSchema.parse({ setTo: 3, finalSetTo: 3 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }), // H opened the game
      rally(tabletennis, { wonBy: "H", serving: "A" }), // …but the pad says A served point 2
      rally(tabletennis, { wonBy: "H" }), // game 1 to H, 3-0
    );
    expect(ctxAfter(tabletennis, short, SINGLES, events, 3).unknownBecause).toBe(
      "recorded-disagrees",
    );
    const game2 = ctx(tabletennis, short, SINGLES, events);
    expect(game2.serveOrderKnown).toBe(false);
    expect(game2.unknownBecause).toBe("alternation-disputed");
  });

  it("and ONE declared serve re-opens game 2 — the refusal is one game wide (D-24)", () => {
    const short = tabletennis.configSchema.parse({ setTo: 3, finalSetTo: 3 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }),
      rally(tabletennis, { wonBy: "H", serving: "A" }), // contradiction, game 1
      rally(tabletennis, { wonBy: "H" }), // game 1 to H, 3-0
      rally(tabletennis, { wonBy: "H", serving: "A" }), // game 2 opens, declared
    );
    const answer = ctx(tabletennis, short, SINGLES, events);
    expect(answer.servingSide).toBe("A"); // A opened game 2; point 1 is still A's turn
    expect(answer.serviceTurn).toBe(0);
    expect(answer.serveNumber).toBe(2);
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
    // `hardbat-21` plays to 21, so the deuce clause bites at 20-all. At 11-11
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

  /**
   * ITTF 2.15.3 stated as a rule, not as this kernel's arithmetic: two serves
   * each until expedite is introduced, and from that moment the service
   * changes after EVERY point — including the point immediately after the
   * introduction, whether or not the server had used both of theirs.
   *
   * `trigger` is the number of points already played when the umpire calls it.
   */
  function expediteServers(trigger: number, through: number): string[] {
    const servers: string[] = [];
    for (let p = 0; p < through; p += 1) {
      if (p < trigger) servers.push(Math.floor(p / 2) % 2 === 0 ? "H" : "A");
      else servers.push(servers[p - 1] === "H" ? "A" : "H");
    }
    return servers;
  }

  /** A side's own 0-based service-turn index at point `p`, read off the server
   *  sequence as the number of separate spells it has had, minus one. */
  function turnIndexFrom(servers: readonly string[], p: number): number {
    let spells = 0;
    for (let i = 0; i <= p; i += 1) {
      if (servers[i] === servers[p] && (i === 0 || servers[i - 1] !== servers[i])) spells += 1;
    }
    return spells - 1;
  }

  // R4's lesson, applied: 10-0 was a parity where the bug was accidentally
  // right, so the trigger is swept rather than picked. A single trigger of
  // five points passes even when the kernel forgets WHERE expedite began.
  for (const trigger of [2, 3, 4, 5, 6, 7]) {
    it(`gives each serve its own turn from the moment expedite is introduced, called at ${trigger} points (2.15.3)`, () => {
      const through = trigger + 3;
      const events = stream(
        ["core.start"],
        rally(tabletennis, { wonBy: "H", serving: "H" }),
        ...Array.from({ length: trigger - 1 }, (_unused, i) =>
          rally(tabletennis, { wonBy: i % 2 === 0 ? "A" : "H" }),
        ),
        [`${tabletennis.key}.expedite.start`, {}],
        ...Array.from({ length: through - trigger }, (_unused, i) =>
          rally(tabletennis, { wonBy: (trigger + i) % 2 === 0 ? "A" : "H" }),
        ),
      );
      const servers = expediteServers(trigger, through);
      // +1 for core.start, +1 for the expedite event once we are past it.
      const at = (played: number) => played + 1 + (played >= trigger ? 1 : 0);
      for (let played = 1; played < through; played += 1) {
        const answer = ctxAfter(tabletennis, cfg, SINGLES, events, at(played));
        expect({ trigger, played, side: answer.servingSide, turn: answer.serviceTurn }).toEqual({
          trigger,
          played,
          side: servers[played],
          turn: turnIndexFrom(servers, played),
        });
        if (played >= trigger) expect(answer.serveNumber).toBe(1);
      }
    });
  }

  it("carries expedite into the next game — every point its own turn from love-all (2.15.4)", () => {
    const short = tabletennis.configSchema.parse({ setTo: 3, finalSetTo: 3 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }),
      [`${tabletennis.key}.expedite.start`, {}],
      rally(tabletennis, { wonBy: "H" }),
      rally(tabletennis, { wonBy: "H" }), // game 1 to H, 3-0
      rally(tabletennis, { wonBy: "A" }), // game 2, point 0
    );
    // Game 2 opens with A (2.13.6 alternation) and, because expedite runs to
    // the end of the MATCH, its very first point is a turn of its own.
    const opener = ctxAfter(tabletennis, short, SINGLES, events, 5);
    expect(opener.servingSide).toBe("A");
    expect(opener.serviceTurn).toBe(0);
    const second = ctx(tabletennis, short, SINGLES, events);
    expect(second.servingSide).toBe("H");
    expect(second.serveNumber).toBe(1);
  });

  it("a later declaration does NOT patch a contradicted game (R4-7)", () => {
    // Under `fixed-turns` a declaration plus the score name the game's opener
    // on their own, so a contradiction would be silently REPAIRED by the next
    // rally carrying `serving` — one derivation patched to match the other,
    // which is the thing R4-7 exists to forbid. The guard that refuses it had
    // no test: deleting it left the suite green.
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }), // H opened
      rally(tabletennis, { wonBy: "H", serving: "A" }), // …but the pad says A served point 2
      rally(tabletennis, { wonBy: "H", serving: "H" }), // a later, agreeable declaration
    );
    const answer = ctx(tabletennis, cfg, SINGLES, events);
    expect(answer.serveOrderKnown).toBe(false);
    expect(answer.unknownBecause).toBe("recorded-disagrees");
  });

  it("accelerates the DECIDING game at ITS target, not the earlier games' (2.13.3)", () => {
    // No shipped variant sets `finalSetTo` apart from `setTo`, but a
    // competition config can, and 2.13.3 bites one short of the target THIS
    // game is played to. Games to 3, decider to 5: the decider is still two
    // serves each at 3-2 and only accelerates at 4-all.
    const decider = tabletennis.configSchema.parse({ bestOf: 3, setTo: 3, finalSetTo: 5 });
    const events = stream(
      ["core.start"],
      rally(tabletennis, { wonBy: "H", serving: "H" }), // game 1: H opens…
      rally(tabletennis, { wonBy: "H" }),
      rally(tabletennis, { wonBy: "H" }), // …3-0
      rally(tabletennis, { wonBy: "A" }), // game 2: A opens…
      rally(tabletennis, { wonBy: "A" }),
      rally(tabletennis, { wonBy: "A" }), // …0-3, one game each
      // Game 3, H opening: alternating winners never reach a two-point lead,
      // so it runs past 4-all with nobody winning it.
      ...Array.from({ length: 10 }, (_unused, i) =>
        rally(tabletennis, { wonBy: i % 2 === 0 ? "H" : "A" }),
      ),
    );
    // Written from the law: two serves each until 4-all (eight points), one
    // each after. Points 5 and 6 are the ones an earlier trigger gets wrong.
    const table = [
      { points: 5, side: "H", serve: 2 }, // still H's second serve of turn 2
      { points: 6, side: "A", serve: 1 }, // an earlier trigger says H here
      { points: 8, side: "H", serve: 1 },
      { points: 9, side: "A", serve: 1 },
    ] as const;
    for (const row of table) {
      // 1 core.start + 3 + 3 game rallies before game 3 begins.
      const answer = ctxAfter(tabletennis, decider, SINGLES, events, 7 + row.points);
      expect({ points: row.points, side: answer.servingSide, serve: answer.serveNumber }).toEqual({
        points: row.points,
        side: row.side,
        serve: row.serve,
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
// Volleyball — FIVB 12.1.1/12.1.2 (first service in a set), 7.6.2, 19.3.2.4
// ---------------------------------------------------------------------------

describe("volleyball", () => {
  const cfg = volleyball.configSchema.parse({});
  const beach = volleyball.configSchema.parse(volleyball.variants["beach"]);
  // Short sets, so set one can be RALLIED out (the anchor has to ride a rally)
  // and the later ones summarised — the two fidelities may not be mixed inside
  // one set, only between sets.
  const short = volleyball.configSchema.parse({ setTo: 3, finalSetTo: 3 });

  /** Set one, opened by a declared serve and played out three-nil. */
  const setOneToHome: Array<[type: string, payload?: unknown]> = [
    ["core.start"],
    rally(volleyball, { wonBy: "H", serving: "H" }),
    rally(volleyball, { wonBy: "H" }),
    rally(volleyball, { wonBy: "H" }),
  ];

  it("alternates the opening serve for sets 2-4", () => {
    const events = stream(...setOneToHome);
    expect(ctx(volleyball, short, SIX, events).servingSide).toBe("A");
  });

  it("alternates off the set's first SERVER, not its winner (12.1.2)", () => {
    // `setOneToHome` above has the opener winning the set, so it cannot tell
    // 12.1.2 ("the team that did not serve first in the previous set") from
    // "the team that lost it". Here H opens and loses 0-3, and the answer is
    // A either way ONLY if you read the law right.
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "A", serving: "H" }), // H served, A sided out
      rally(volleyball, { wonBy: "A" }),
      rally(volleyball, { wonBy: "A" }), // set 1 to A, 0-3 — the opener lost
    );
    const set2 = ctx(volleyball, short, SIX, events);
    expect(set2.servingSide).toBe("A");
    expect(set2.serviceTurn).toBe(0);
    expect(set2.rotation).toBe(1);
  });

  it("refuses to alternate off a DISPUTED opener (12.1.2), and set 2 recovers on its first rally", () => {
    // The same shape as table tennis's: 12.1.2 starts the next set with the
    // side that did NOT serve first in this one, so the alternation rests on
    // this set's first server — which is what the contradiction disputes.
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }), // H opened set 1
      rally(volleyball, { wonBy: "H", serving: "A" }), // H won point 1, so H serves point 2
      rally(volleyball, { wonBy: "H" }), // set 1 to H, 3-0
      rally(volleyball, { wonBy: "A" }), // set 2, point 0
    );
    const set2 = ctxAfter(volleyball, short, SIX, events, 4);
    expect(set2.serveOrderKnown).toBe(false);
    expect(set2.unknownBecause).toBe("alternation-disputed");
    // D-24: one rally of set 2 and side-out answers for itself again — the
    // refusal is one set wide, never the rest of the match.
    const after = ctx(volleyball, short, SIX, events);
    expect(after.servingSide).toBe("A");
    expect(after.serviceTurn).toBeUndefined(); // the set's opener is still untold
  });

  it("stops at the deciding set's door — FIVB 12.1.1 tosses for it afresh", () => {
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

  it("a declaration after a score jump names the side WITHOUT restarting the set", () => {
    // The re-anchor is `before === 0` only. At love-all a declared serve IS
    // the set's opener; midway through a set it names only who serves NEXT.
    // Re-anchoring off it would restart the turn count at zero and the
    // rotation at one — two facts the swallowed rallies actually decided —
    // and both would be fabrications with a confident face on.
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }),
      summary(volleyball, { by: "H", forBy: 6, forOpp: 3, partial: true }),
      rally(volleyball, { wonBy: "A", serving: "A" }),
    );
    const answer = ctx(volleyball, cfg, SIX, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.serviceTurn).toBeUndefined();
    expect(answer.rotation).toBeUndefined();
  });

  it("numbers the rotation off an ORDINARY indoor sheet — six starters, no coach", () => {
    // The number is a pure count of side-outs, so it needs no team-sheet
    // detail. It was gated on `state.squads` all the same, and nothing
    // persists a squad for a plain sheet (`sports/squad-state.ts` keeps one
    // only where the sheet declares a `pairOrder` or a non-`player` role) —
    // so the rotation was dark on every ordinary indoor fixture, and the test
    // above only sees a number because it puts a COACH on the bench.
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }), // H opened, holds serve
      rally(volleyball, { wonBy: "A" }), // A takes it: A rotates once
      rally(volleyball, { wonBy: "H" }), // H takes it back: H rotates once
    );
    // The premise, stated rather than assumed.
    const folded: SetBasedState = foldMatch(volleyball, cfg, SIX_PLAIN, events, STRICT_ALL);
    expect(folded.squads).toBeUndefined();
    expect(ctxAfter(volleyball, cfg, SIX_PLAIN, events, 2).rotation).toBe(1);
    expect(ctxAfter(volleyball, cfg, SIX_PLAIN, events, 3).rotation).toBe(2);
    const answer = ctx(volleyball, cfg, SIX_PLAIN, events);
    expect(answer.rotation).toBe(2);
    // …and still names nobody. FIVB 7.6's six-position court rotation is not
    // folded, so the PERSON needs an order this sheet does not declare.
    expect(answer.serverPersonId).toBeNull();
  });

  it("gives a beach PAIR no rotation number even off a sheet that declares no order", () => {
    // The other half of that ungating. With no squad to size, how many are on
    // court comes from the code the fixture is played under: beach records no
    // substitutions because a pair has no bench (FIVB Beach §7 — the S6/#416
    // regression), and a pair has no six-position rotation to number.
    const bare: LineupPair = { home: barePairSide("H"), away: barePairSide("A") };
    const events = stream(
      ["core.start"],
      rally(volleyball, { wonBy: "H", serving: "H" }),
      rally(volleyball, { wonBy: "A" }), // a side-out, which WOULD advance a rotation
    );
    const folded: SetBasedState = foldMatch(volleyball, beach, bare, events, STRICT_ALL);
    expect(folded.squads).toBeUndefined(); // the same bare sheet as indoor's
    const answer = ctx(volleyball, beach, bare, events);
    expect(answer.servingSide).toBe("A");
    expect(answer.rotation).toBeUndefined();
    expect(answer.serverPersonId).toBeNull();
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
