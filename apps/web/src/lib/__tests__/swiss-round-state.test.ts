// W3 Task 16 (SW-L11): the public "Round X of N" chip on a Swiss standings table. `swissRoundState` is the one pure
// verdict behind it, over a Swiss stage's rows, so the table says where the event stands.
//
// The expected states below are HAND-DERIVED from the rule (the latest round with a seated board that is not the bye;
// all boards decided -> complete; a board started -> in play; else paired; the stage complete -> final), never read back
// from `swissRoundState`. Anti-vacuity: the state table asserts how many cases it ran, and every state of the closed
// set must be reached by at least one case.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { WITHDRAWAL_PLAYED_STATUSES } from "@/lib/table-withdrawal";
import { SWISS_ROUND_STATES, swissRoundKey, swissRoundState, type SwissRoundFixture, type SwissRoundState } from "../swiss-round-state";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";

/** A seated board: both sides filled. */
const board = (round_no: number, status: string, n = 1): SwissRoundFixture => ({
  round_no,
  home: `h${round_no}-${n}`,
  away: `a${round_no}-${n}`,
  status,
  isBye: false,
});
/** The round's bye: one side filled, never a board. */
const bye = (round_no: number, status = "decided"): SwissRoundFixture => ({ round_no, home: `bye${round_no}`, away: null, status, isBye: true });
/** An unpaired shell: no side filled. */
const shell = (round_no: number): SwissRoundFixture => ({ round_no, home: null, away: null, status: "scheduled", isBye: false });
/** A board whose opponent departed: one side left, walked over (the withdrawal cascade) - a board, not a bye. */
const walkover = (round_no: number): SwissRoundFixture => ({ round_no, home: `w${round_no}`, away: null, status: "forfeited", isBye: false });

interface Case {
  name: string;
  rounds: number;
  fixtures: SwissRoundFixture[];
  stageComplete: boolean;
  /** The hand-derived verdict. */
  want: SwissRoundState | null;
}

const CASES: Case[] = [
  // ---- the empty case first: nothing seated is no state, whatever else the stage holds ----
  { name: "no rows at all", rounds: 5, fixtures: [], stageComplete: false, want: null },
  { name: "only unpaired shells (Start minted them, nothing is paired)", rounds: 3, fixtures: [shell(1), shell(1), shell(2), shell(3)], stageComplete: false, want: null },
  { name: "a round whose only seated row is the bye is not paired (T13: a bye-only round was never played)", rounds: 3, fixtures: [bye(1, "scheduled"), shell(1), shell(2)], stageComplete: false, want: null },
  { name: "a decided bye alone is still nothing seated", rounds: 3, fixtures: [bye(1), shell(1)], stageComplete: false, want: null },
  { name: "a complete stage with nothing seated states nothing (final needs a round to be after)", rounds: 3, fixtures: [shell(1)], stageComplete: true, want: null },

  // ---- paired: seated, no board started ----
  { name: "round 1 paired, both boards scheduled", rounds: 5, fixtures: [board(1, "scheduled", 1), board(1, "scheduled", 2), shell(2), shell(3)], stageComplete: false, want: { round: 1, of: 5, state: "paired" } },
  { name: "paired beside a bye (odd field)", rounds: 3, fixtures: [board(1, "scheduled", 1), board(1, "scheduled", 2), bye(1, "scheduled")], stageComplete: false, want: { round: 1, of: 3, state: "paired" } },
  { name: "round 2 paired after round 1 is decided: the LATEST seated round is the one stated", rounds: 4, fixtures: [board(1, "decided", 1), board(1, "decided", 2), board(2, "scheduled", 1), board(2, "scheduled", 2), shell(3)], stageComplete: false, want: { round: 2, of: 4, state: "paired" } },
  { name: "a bye-only round 3 after a decided round 2 leaves the chip on round 2", rounds: 4, fixtures: [board(2, "decided", 1), bye(3, "scheduled"), shell(3)], stageComplete: false, want: { round: 2, of: 4, state: "complete" } },

  // ---- in play: a result is in or a board is under way, and the round is not all decided ----
  { name: "one board in play, the other scheduled", rounds: 5, fixtures: [board(1, "in_play", 1), board(1, "scheduled", 2)], stageComplete: false, want: { round: 1, of: 5, state: "in_play" } },
  { name: "one board decided, the other still scheduled", rounds: 5, fixtures: [board(1, "decided", 1), board(1, "scheduled", 2)], stageComplete: false, want: { round: 1, of: 5, state: "in_play" } },
  { name: "every board in play", rounds: 3, fixtures: [board(2, "in_play", 1), board(2, "in_play", 2), board(1, "decided", 1), board(1, "decided", 2)], stageComplete: false, want: { round: 2, of: 3, state: "in_play" } },
  { name: "a board abandoned beside a decided one is not complete (no result)", rounds: 3, fixtures: [board(1, "decided", 1), board(1, "abandoned", 2)], stageComplete: false, want: { round: 1, of: 3, state: "in_play" } },
  { name: "a walked-over board beside a scheduled one (after a withdrawal): a result is in", rounds: 3, fixtures: [walkover(2), board(2, "scheduled", 2)], stageComplete: false, want: { round: 2, of: 3, state: "in_play" } },

  // ---- complete: every seated board decided ----
  { name: "both boards decided", rounds: 5, fixtures: [board(1, "decided", 1), board(1, "decided", 2), shell(2)], stageComplete: false, want: { round: 1, of: 5, state: "complete" } },
  { name: "decided, finalized and forfeited are all results", rounds: 3, fixtures: [board(1, "decided", 1), board(1, "finalized", 2), board(1, "forfeited", 3)], stageComplete: false, want: { round: 1, of: 3, state: "complete" } },
  { name: "the bye never holds a round open", rounds: 3, fixtures: [board(1, "decided", 1), board(1, "decided", 2), bye(1, "scheduled")], stageComplete: false, want: { round: 1, of: 3, state: "complete" } },
  { name: "a walkover is a decided board: a round of one walkover is complete", rounds: 2, fixtures: [walkover(1)], stageComplete: false, want: { round: 1, of: 2, state: "complete" } },
  { name: "the last round decided, the stage not yet completed: complete, NOT final", rounds: 3, fixtures: [board(3, "decided", 1), board(3, "decided", 2), board(2, "decided", 1)], stageComplete: false, want: { round: 3, of: 3, state: "complete" } },
  { name: "a take-back reopened a round-1 board while round 2 is decided: the latest round is stated", rounds: 3, fixtures: [board(1, "scheduled", 1), board(1, "decided", 2), board(2, "decided", 1), board(2, "decided", 2)], stageComplete: false, want: { round: 2, of: 3, state: "complete" } },

  // ---- final: the stage is complete ----
  { name: "all five rounds decided and the stage complete", rounds: 5, fixtures: [board(5, "decided", 1), board(5, "decided", 2), board(4, "decided", 1)], stageComplete: true, want: { round: 5, of: 5, state: "final" } },
  { name: "after Finish the Swiss now: rounds is the CURRENT count (3), not the 5 it was created with", rounds: 3, fixtures: [board(1, "decided"), board(2, "decided"), board(3, "decided")], stageComplete: true, want: { round: 3, of: 3, state: "final" } },
  { name: "Finish after round 1 of a 3-round Swiss: of is 1", rounds: 1, fixtures: [board(1, "forfeited", 1), board(1, "forfeited", 2)], stageComplete: true, want: { round: 1, of: 1, state: "final" } },
  { name: "the stage's own completion is the authority: complete with one abandoned board is still final", rounds: 2, fixtures: [board(2, "decided", 1), board(2, "abandoned", 2)], stageComplete: true, want: { round: 2, of: 2, state: "final" } },

  // ---- guards ----
  { name: "a seated round past the declared count states nothing (never 'Round 4 of 3')", rounds: 3, fixtures: [board(4, "scheduled")], stageComplete: false, want: null },
];

describe("swissRoundState — the state table", () => {
  it("runs a table that reaches every state of the closed set (anti-vacuity)", () => {
    expect(CASES.length).toBe(25);
    const reached = new Set(CASES.map((c) => c.want?.state ?? "none"));
    for (const s of SWISS_ROUND_STATES) expect(reached.has(s), `no case reaches ${s}`).toBe(true);
    expect(reached.has("none")).toBe(true);
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(swissRoundState(c.rounds, c.fixtures, c.stageComplete)).toEqual(c.want);
  });

  it("is the same on a second call and for any row order (no hidden state, no order dependence)", () => {
    let checked = 0;
    for (const c of CASES) {
      const first = swissRoundState(c.rounds, c.fixtures, c.stageComplete);
      const second = swissRoundState(c.rounds, c.fixtures, c.stageComplete);
      const reversed = swissRoundState(c.rounds, [...c.fixtures].reverse(), c.stageComplete);
      expect(second).toEqual(first);
      expect(reversed).toEqual(first);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("does not mutate its rows", () => {
    const rows = [board(1, "decided", 1), board(1, "scheduled", 2)];
    const snapshot = JSON.stringify(rows);
    swissRoundState(3, rows, false);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("a rounds count that is not a whole number of 1 or more is a caller bug, refused by name", () => {
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => swissRoundState(bad, [board(1, "scheduled")], false), String(bad)).toThrow(RangeError);
    }
  });
});

describe("swissRoundState — every fixture status of the wire vocabulary lands somewhere, on a one-board round", () => {
  // Hand-written verdict per status. Keyed by status so a status added to `FIXTURE_STATUSES` fails the next test
  // until someone classifies it (the table's keys must equal the vocabulary exactly).
  const ONE_BOARD: Record<(typeof FIXTURE_STATUSES)[number], "paired" | "in_play" | "complete"> = {
    scheduled: "paired",
    in_play: "in_play",
    decided: "complete",
    finalized: "complete",
    forfeited: "complete",
    abandoned: "in_play",
    cancelled: "in_play",
    needs_decision: "in_play",
  };

  it("classifies exactly the statuses the wire carries", () => {
    expect(Object.keys(ONE_BOARD).sort()).toEqual([...FIXTURE_STATUSES].sort());
    expect(FIXTURE_STATUSES.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE_STATUSES.map((s) => [s] as const))("a lone %s board", (status) => {
    expect(swissRoundState(3, [board(1, status)], false)?.state).toBe(ONE_BOARD[status]);
  });

  it("the decided set is the repo's own settled set: usecases/stages.ts's DECIDED, read from source", () => {
    // `stages.ts` is a server-only usecase and cannot be imported here, so its declaration is read as TEXT (the pattern
    // `champion.test.ts` uses for BRACKET_SETTLED): a status added to or removed from that set reds here.
    const source = readFileSync(new URL("../../server/usecases/stages.ts", import.meta.url), "utf8");
    const match = /const DECIDED(?::[^=]*)? = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match, "stages.ts still declares DECIDED").not.toBeNull();
    const declared = [...match![1]!.matchAll(/"([a-z_]+)"/g)].map(([, s]) => s!);
    expect(declared.length).toBeGreaterThan(0);
    expect([...WITHDRAWAL_PLAYED_STATUSES].sort()).toEqual(declared.sort());
  });
});

describe("swissRoundKey — the copy each state says (4 locales)", () => {
  const LOCALES = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as unknown as Record<string, Record<string, string>>;
  const STATE_CASES: { state: SwissRoundState; key: string; en: string }[] = [
    { state: { round: 2, of: 5, state: "paired" }, key: "table.swissRound.paired", en: "Round 2 of 5 · paired" },
    { state: { round: 2, of: 5, state: "in_play" }, key: "table.swissRound.inPlay", en: "Round 2 of 5 · in play" },
    { state: { round: 2, of: 5, state: "complete" }, key: "table.swissRound.complete", en: "Round 2 of 5 · complete" },
    { state: { round: 3, of: 3, state: "final" }, key: "table.swissRound.final.other", en: "Final standings after 3 rounds" },
    // One round is "round", not "rounds": a Swiss finished after round 1 reads right.
    { state: { round: 1, of: 1, state: "final" }, key: "table.swissRound.final.one", en: "Final standings after 1 round" },
  ];

  it("states a key for every state of the closed set, and the English reads as the brief says", () => {
    expect(new Set(STATE_CASES.map((c) => c.state.state))).toEqual(new Set(SWISS_ROUND_STATES));
    for (const c of STATE_CASES) {
      expect(swissRoundKey(c.state)).toBe(c.key);
      const text = (enPublic as Record<string, string>)[c.key]!.replace("{round}", String(c.state.round)).replace("{of}", String(c.state.of));
      expect(text).toBe(c.en);
    }
  });

  it.each(Object.keys(LOCALES))("every key exists in %s with its variables, and is not the English copy", (locale) => {
    let checked = 0;
    for (const c of STATE_CASES) {
      const text = LOCALES[locale]![c.key];
      expect(text, `${c.key} in ${locale}`).toBeTypeOf("string");
      if (c.state.state === "final") expect(text).toContain("{of}");
      else {
        expect(text).toContain("{round}");
        expect(text).toContain("{of}");
      }
      if (locale !== "en") expect(text, `${c.key} is untranslated in ${locale}`).not.toBe(LOCALES.en![c.key]);
      checked++;
    }
    expect(checked).toBe(STATE_CASES.length);
  });
});
