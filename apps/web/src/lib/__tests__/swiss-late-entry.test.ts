// W3 Task 9 — "Add late player", the pure decision (spec 2026-10-31-format-matrix-w3-swiss-design.md §4, ruling 250):
//   X-SW-12: late entry cases (a) re-pair / (b) take the bye / (c) join the next round; (a) deviates from FIDE C.04.2 4.4;
//   X-SW-13: an automatic arrival after Start (registration, waitlist, import, reinstate) always takes case (c);
//   X-SW-14: no round left — "Add a round" while running (SWISS_NO_ROUND_LEFT), "This Swiss is over" after (SWISS_OVER).
// Every expected decision is read off the plan's rule list (Task 9, "Order, stated as code-level rules"), never off the
// function under test. Single-sport by nature: the decision reads seats and flags, no sport field.
import { describe, expect, it } from "vitest";
import { decideSwissLateEntry, type LateEntryBoard, type LateEntryDecision } from "@/lib/swiss-late-entry";

const NEW = "newcomer";

/** One row of a round. `seated` fills both seats with names derived from the board, a bye seats its holder only. */
function board(
  round: number,
  seq: number,
  o: { bye?: boolean; seated?: boolean; started?: boolean; decided?: boolean; home?: string; extKey?: string } = {},
): LateEntryBoard {
  const isBye = o.bye === true;
  const seated = o.seated ?? true;
  return {
    id: `r${round}-${isBye ? "bye" : `b${seq}`}`,
    round,
    seq,
    extKey: o.extKey ?? (isBye ? `sw-r${round}-bye` : `sw-r${round}-b${seq}`),
    home: seated ? (o.home ?? `h${round}.${seq}`) : null,
    away: seated && !isBye ? `a${round}.${seq}` : null,
    started: o.started ?? false,
    decided: o.decided ?? false,
    isBye,
  };
}

/** A whole round: `boards` boards (flags per board index), plus a seated bye when `bye`. */
function round(
  r: number,
  boards: number,
  o: { bye?: boolean; seated?: boolean; started?: number[]; decided?: boolean } = {},
): LateEntryBoard[] {
  const rows = Array.from({ length: boards }, (_, i) =>
    board(r, i + 1, { seated: o.seated, started: (o.started ?? []).includes(i + 1), decided: o.decided }),
  );
  if (o.bye) rows.push(board(r, boards + 1, { bye: true, seated: o.seated, home: `holder${r}`, decided: o.seated !== false }));
  return rows;
}

type Input = Parameters<typeof decideSwissLateEntry>[0];
const base = (over: Partial<Input>): Input => ({
  boards: [],
  rounds: 3,
  swissOver: false,
  automatic: false,
  alreadyAdmitted: false,
  canPlayBye: () => true,
  newcomer: NEW,
  ...over,
});

/** A round decided end to end (results in, the bye awarded). */
const done = (r: number, boards: number, bye = false) => round(r, boards, { bye, decided: true, started: [1, 2, 3, 4] });

interface Row {
  name: string;
  input: Input;
  expected: LateEntryDecision;
}

const ROWS: Row[] = [
  // Empty case first (R13): no row at all — nothing minted yet. Rule 2: round 1.
  { name: "the empty board list", input: base({ boards: [] }), expected: { kind: "next_round", firstRound: 1 } },
  // Rule 2: shells only (before the first Pair) — round 1, whoever asks.
  {
    name: "shells only",
    input: base({ boards: round(1, 2, { seated: false, bye: true }).concat(round(2, 2, { seated: false })) }),
    expected: { kind: "next_round", firstRound: 1 },
  },
  {
    name: "shells only, automatic",
    input: base({ automatic: true, boards: round(1, 2, { seated: false }) }),
    expected: { kind: "next_round", firstRound: 1 },
  },
  // Rule 3: between rounds (round 1 decided, round 2 not yet paired) — the next round.
  {
    name: "between rounds",
    input: base({ boards: done(1, 2, true).concat(round(2, 2, { seated: false, bye: true })) }),
    expected: { kind: "next_round", firstRound: 2 },
  },
  {
    name: "between rounds with no round left",
    input: base({ rounds: 2, boards: done(1, 2).concat(done(2, 2)) }),
    expected: { kind: "refused", code: "SWISS_NO_ROUND_LEFT" },
  },
  // Rule 5: round 2 paired, nothing started — (a) re-pair.
  {
    name: "(a)",
    input: base({ boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "repair", round: 2 },
  },
  // Rule 5 reads only NON-bye boards: a bye is decided at award, and is no start.
  {
    name: "(a) over a round whose only decided row is its bye",
    input: base({ boards: done(1, 2, true).concat(round(2, 2, { bye: true })) }),
    expected: { kind: "repair", round: 2 },
  },
  // Rule 6: a board started, the round's bye unused, the pair legal — (b).
  {
    name: "(b)",
    input: base({ boards: done(1, 2, true).concat(round(2, 2, { bye: true, started: [1] })) }),
    expected: { kind: "take_bye", round: 2, byeFixtureId: "r2-bye", holder: "holder2" },
  },
  {
    name: "(b) with canPlayBye false (met, or no legal colour) → (c)",
    input: base({ canPlayBye: () => false, boards: done(1, 2, true).concat(round(2, 2, { bye: true, started: [1] })) }),
    expected: { kind: "next_round", firstRound: 3 },
  },
  // m8: a first newcomer took the bye — the row is gone and the new board stands unstarted — so a second falls to (c).
  {
    name: "(b) already used by a first newcomer (no bye row left) → (c) for a second newcomer",
    input: base({
      boards: done(1, 2, true).concat(round(2, 2, { started: [1] }), [board(2, 3, { extKey: "sw-r2-b3", home: "holder2" })]),
    }),
    expected: { kind: "next_round", firstRound: 3 },
  },
  // Rule 7: started, no bye — (c).
  {
    name: "(c) a started round without a bye",
    input: base({ boards: done(1, 2).concat(round(2, 2, { started: [2] })) }),
    expected: { kind: "next_round", firstRound: 3 },
  },
  // Rule 0 (m8): admitted already — nothing, whatever the round state, the Swiss being over included.
  {
    name: "alreadyAdmitted → noop (round open)",
    input: base({ alreadyAdmitted: true, boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "noop" },
  },
  {
    name: "alreadyAdmitted → noop (Swiss over)",
    input: base({ alreadyAdmitted: true, swissOver: true, boards: done(1, 2).concat(done(2, 2)) }),
    expected: { kind: "noop" },
  },
  {
    name: "alreadyAdmitted → noop (automatic, no round left)",
    input: base({ alreadyAdmitted: true, automatic: true, rounds: 2, boards: done(1, 2).concat(round(2, 2, { started: [1] })) }),
    expected: { kind: "noop" },
  },
  // Rule 4 (X-SW-13): automatic during an (a)-eligible round still takes (c) — never re-pairs.
  {
    name: "automatic during (a)-eligible → (c)",
    input: base({ automatic: true, boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "next_round", firstRound: 3 },
  },
  {
    name: "automatic during (b)-eligible → (c)",
    input: base({ automatic: true, boards: done(1, 2, true).concat(round(2, 2, { bye: true, started: [1] })) }),
    expected: { kind: "next_round", firstRound: 3 },
  },
  // X-SW-14: automatic with no round left is refused HERE; the server records it and never throws.
  {
    name: "automatic with no round left → refused",
    input: base({ automatic: true, rounds: 2, boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "refused", code: "SWISS_NO_ROUND_LEFT" },
  },
  // Rule 1: the Swiss is over — whoever asks, before any other rule (rules 1 and 4 in that order).
  {
    name: "swissOver",
    input: base({ swissOver: true, boards: done(1, 2).concat(done(2, 2), done(3, 2)) }),
    expected: { kind: "refused", code: "SWISS_OVER" },
  },
  {
    name: "swissOver, automatic, with a round still open",
    input: base({ swissOver: true, automatic: true, boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "refused", code: "SWISS_OVER" },
  },
  // Decisions to confirm item 1: (a)/(b) are judged before "no round left" — the LAST round, started, with a bye.
  {
    name: "the last round started with a bye → (b)",
    input: base({ rounds: 2, boards: done(1, 2, true).concat(round(2, 2, { bye: true, started: [1] })) }),
    expected: { kind: "take_bye", round: 2, byeFixtureId: "r2-bye", holder: "holder2" },
  },
  {
    name: "the last round started without a bye → SWISS_NO_ROUND_LEFT",
    input: base({ rounds: 2, boards: done(1, 2).concat(round(2, 2, { started: [1] })) }),
    expected: { kind: "refused", code: "SWISS_NO_ROUND_LEFT" },
  },
  {
    name: "the last round unstarted → (a)",
    input: base({ rounds: 2, boards: done(1, 2).concat(round(2, 2)) }),
    expected: { kind: "repair", round: 2 },
  },
];

describe("X-SW-12 / X-SW-13 / X-SW-14 decision table", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    expect(decideSwissLateEntry(row.input)).toEqual(row.expected);
  });

  it("anti-vacuity: the table is the plan's 13 branches plus its guards, and reaches every decision kind and code", () => {
    expect(ROWS.length).toBe(22);
    const seen = new Set(ROWS.map((r) => (r.expected.kind === "refused" ? `refused:${r.expected.code}` : r.expected.kind)));
    expect([...seen].sort()).toEqual(["next_round", "noop", "refused:SWISS_NO_ROUND_LEFT", "refused:SWISS_OVER", "repair", "take_bye"]);
  });

  it("canPlayBye is asked only by rule 6 — never for an automatic arrival, never when nothing started", () => {
    // The server's canPlayBye reads the stage's history and may refuse by name (buildSwissHistory: a forfeit with no
    // played fact). An automatic arrival must never fail on it (X-SW-13, Review Focus 4), so the decision never asks.
    let asked = 0;
    const throwing = (): boolean => {
      asked++;
      throw new Error("canPlayBye must not be consulted here");
    };
    const automatic = decideSwissLateEntry(
      base({ automatic: true, canPlayBye: throwing, boards: done(1, 2, true).concat(round(2, 2, { bye: true, started: [1] })) }),
    );
    expect(automatic).toEqual({ kind: "next_round", firstRound: 3 });
    const unstarted = decideSwissLateEntry(base({ canPlayBye: throwing, boards: round(1, 2, { bye: true }) }));
    expect(unstarted).toEqual({ kind: "repair", round: 1 });
    expect(asked).toBe(0);
    // And the positive pair: rule 6 does ask, with the holder.
    const holders: string[] = [];
    decideSwissLateEntry(
      base({
        canPlayBye: (h) => (holders.push(h), true),
        boards: round(1, 2, { bye: true, started: [2] }),
      }),
    );
    expect(holders).toEqual(["holder1"]);
  });
});
