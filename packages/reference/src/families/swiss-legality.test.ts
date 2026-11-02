// The Swiss legality and existence checker's tests (format-matrix W3, Task 19; spec §6.4; RB3-24). Every expected
// value is worked out BY HAND from rulebook-W3-swiss.md §2.1 (absolute rules), §2.3 (what the reference checks) and
// §3.1 (round bounds) — never from engine source and never from the checker (R8; TEST-STRATEGY rule 3). Each fixed
// history is written out round by round in a comment, so a reader can redo the arithmetic.
//
// The engine is touched in ONE place, the producer -> consumer sweep at the bottom (R15): its real `pairRound` is called
// as a black box and every round it seats is judged here. `pairKey` comes with it, as the engine's own declared encoding
// of its `played` input (SwissHistory.played is a set of pairKey strings) — the harness never guesses that format.
//
// What the sweep (Step 3) can and cannot reach, by construction — the unit tests carry every rule regardless:
//   - P-A1, P-A3, P-A5, P-A6 (existence, empty rounds) and P-Q3 in both seeded modes (fold, rank_adjacent): every round.
//   - P-A2 (a walkover is not a meeting): one sequence in three has walkovers; boards re-pairing a walked-over pair are
//     counted and asserted > 0.
//   - P-A4: its walkover clause and its second-bye clause are both reached once walkovers exhaust the bye-eligible pool
//     below the hard maximum. That is where the sweep found the named engine 1.x defect (a bye re-given where a refusal
//     was owed). The engine's SwissHistory has one bye-eligibility channel, `byes`, and the harness passes walkover
//     winners through it. That is the harness's encoding; how the app maps them is App-B's to prove on the real app path.
//   - P-A7: checked on every round with a departed entrant (counted), but it cannot be VIOLATED here. The harness builds
//     the engine's standings from the active field, and pairRound has no departed channel, so the app path (App-B) owns it.
//   - P-Q2: printed as an opportunity count (a bye above a strictly lower eligible entrant). It is 0 because engine 1.1.0
//     never offers that choice, so only the unit tests witness P-Q2.
//
// Single-sport reason: the checker has no sport parameter. Its one sport-dependent rule is P-A5 (chess colours, the
// boardgame row), so the "another sport" axis is `chess` on and off, which every colour test runs both ways.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { pairKey, pairRound } from "@seazn/engine/scheduling";
import { checkSwissRound, type SwissColour, type SwissHistoryIn, type SwissRound1Mode, type SwissRoundIn, type SwissRule, type SwissVerdict } from "./swiss-legality.ts";
import type * as Matching from "./swiss-matching.ts";
import { BLOSSOM_MAX_N, BRUTE_FORCE_MAX_N, SwissOutOfScope, blossomMatching, bruteForceMaximumMatching, bruteForcePerfectMatching } from "./swiss-matching.ts";

/** Anti-vacuity (TEST-STRATEGY rule 2): every property and sweep prints how many items it checked. */
function report(line: string): void {
  // eslint-disable-next-line no-console -- the count a property or sweep checked is printed, never only asserted (TEST-STRATEGY rule 2)
  console.info(`[swiss-legality] ${line}`);
}

/** RB3-24's bound, typed from the rulebook (never read from the code under test): blossom answers n <= 128, the
 *  brute-force cross-check n <= 12. */
const RB3_24_BLOSSOM_N = 128;
const RB3_24_BRUTE_N = 12;

type Pair = [string, string];
const NO_HISTORY: SwissHistoryIn = { met: [], byes: [], walkoverWinners: [], colours: {}, scores: {} };
const history = (h: Partial<SwissHistoryIn>): SwissHistoryIn => ({ ...NO_HISTORY, ...h });
const zeros = (ids: readonly string[]): Record<string, number> => Object.fromEntries(ids.map((id) => [id, 0]));
const paired = (boards: Pair[], bye: string | null = null): SwissRoundIn["outcome"] => ({ kind: "paired", boards: boards.map(([home, away]) => ({ home, away })), bye });
const refused = (reason: string): SwissRoundIn["outcome"] => ({ kind: "refused", reason });
const rulesOf = (v: SwissVerdict): SwissRule[] => v.violations.map((x) => x.rule);
const check = (field: string[], h: SwissHistoryIn, outcome: SwissRoundIn["outcome"], opts: { chess?: boolean; departed?: string[]; round1Mode?: SwissRound1Mode } = {}): SwissVerdict =>
  checkSwissRound({ field, departed: opts.departed ?? [], chess: opts.chess ?? false, history: h, outcome, ...(opts.round1Mode === undefined ? {} : { round1Mode: opts.round1Mode }) });

const FOUR = ["A", "B", "C", "D"];
const FIVE = ["A", "B", "C", "D", "E"];

// 4 players after round 1. R1: A–B (A wins), C–D (C wins). Scores A1 B0 C1 D0.
const FOUR_R1 = history({ met: [["A", "B"], ["C", "D"]], scores: { A: 1, B: 0, C: 1, D: 0 } });
// 4 players after round 2. R2: A–C (A wins), B–D (B wins). Scores A2 B1 C1 D0. Left unmet: A–D, B–C.
const FOUR_R2 = history({ met: [["A", "B"], ["C", "D"], ["A", "C"], ["B", "D"]], scores: { A: 2, B: 1, C: 1, D: 0 } });
// 4 players after round 3 — K₄ is exhausted. R3: A–D (A wins), B–C (B wins). Scores A3 B2 C1 D0. §3.1: the hard
// maximum for an even field is n − 1 = 3 rounds, so round 4 cannot exist.
const FOUR_K4 = history({ met: [["A", "B"], ["C", "D"], ["A", "C"], ["B", "D"], ["A", "D"], ["B", "C"]], scores: { A: 3, B: 2, C: 1, D: 0 } });
// 5 players after round 1. R1: A–B (A wins), C–D (C wins), E bye (win points). Scores A1 B0 C1 D0 E1.
const FIVE_R1 = history({ met: [["A", "B"], ["C", "D"]], byes: ["E"], scores: { A: 1, B: 0, C: 1, D: 0, E: 1 } });

describe("checkSwissRound: the empty case and the input's own guards first", () => {
  it("an empty active field is refused by name (OutOfScope) — there is no round to judge, and a verdict on nothing would be vacuous", () => {
    expect(() => check([], NO_HISTORY, paired([]))).toThrow(SwissOutOfScope);
    expect(() => check(["A"], history({ scores: { A: 0 } }), paired([]), { departed: ["A"] })).toThrow(/no active entrant/);
  });

  it("a field naming an entrant twice, an active entrant with no score, and a self-meeting in the history are refused, never guessed", () => {
    expect(() => check(["A", "B", "A"], history({ scores: zeros(["A", "B"]) }), paired([["A", "B"]]))).toThrow(/twice/);
    expect(() => check(FOUR, history({ scores: { A: 0, B: 0, C: 0 } }), paired([["A", "B"], ["C", "D"]]))).toThrow(/no score for D/);
    expect(() => check(FOUR, history({ met: [["A", "A"]], scores: zeros(FOUR) }), paired([["A", "B"], ["C", "D"]]))).toThrow(/met itself/);
  });

  it("a second call answers the same, and the checker never writes to its input (deep-frozen)", () => {
    const input: SwissRoundIn = { field: FIVE, departed: [], chess: false, history: FIVE_R1, outcome: paired([["B", "C"], ["D", "E"]], "A") };
    const frozen = deepFreeze(structuredClone(input));
    const first = checkSwissRound(frozen);
    const second = checkSwissRound(frozen);
    expect(second).toEqual(first);
    expect(rulesOf(first)).toEqual(["P-Q2"]);
  });
});

describe("§2.1 absolute rules — one illegal round per rule, each with its legal pair", () => {
  it("P-A1 (two entrants meet at most once): round 2 repeating both round-1 boards is illegal; the fresh pairing is legal", () => {
    // FOUR_R1 met A–B and C–D. Repeating both: two P-A1 violations.
    const bad = check(FOUR, FOUR_R1, paired([["A", "B"], ["C", "D"]]));
    expect(bad.verdict).toBe("illegal");
    expect(rulesOf(bad)).toEqual(["P-A1", "P-A1"]);
    // A–C and B–D never met: legal. Even field: one candidate (the whole field) tested for a perfect matching.
    const good = check(FOUR, FOUR_R1, paired([["A", "C"], ["B", "D"]]));
    expect(good).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 0, candidates: 1 } });
  });

  it("P-A3 (every active entrant seated exactly once; one bye iff the field is odd): a partial round is illegal; the full round is legal", () => {
    // Only A–C seated: B and D are not seated.
    const partial = check(FOUR, FOUR_R1, paired([["A", "C"]]));
    expect(partial.verdict).toBe("illegal");
    expect(rulesOf(partial)).toEqual(["P-A3", "P-A3"]);
    expect(partial.violations.map((v) => v.detail).join(" | ")).toMatch(/B is not seated.*D is not seated/);
    expect(check(FOUR, FOUR_R1, paired([["A", "C"], ["B", "D"]])).verdict).toBe("legal");
  });

  it("P-A3: an entrant seated twice, a board against itself, an entrant not in the field, an odd field with no bye, an even field with a bye", () => {
    // C on two boards (A–C, C–B — neither met), D unseated.
    expect(rulesOf(check(FOUR, FOUR_R1, paired([["A", "C"], ["C", "B"]])))).toEqual(["P-A3", "P-A3"]);
    // A–A: the self-board, then A counted twice, then C unseated.
    expect(rulesOf(check(FOUR, FOUR_R1, paired([["A", "A"], ["B", "D"]])))).toEqual(["P-A3", "P-A3", "P-A3"]);
    // Z is in no field: the stranger, then D unseated.
    expect(rulesOf(check(FOUR, FOUR_R1, paired([["A", "C"], ["B", "Z"]])))).toEqual(["P-A3", "P-A3"]);
    // FIVE_R1, round 2 with every board full and no bye: E unseated, and an odd field of 5 owes a bye.
    expect(rulesOf(check(FIVE, FIVE_R1, paired([["A", "C"], ["B", "D"]])))).toEqual(["P-A3", "P-A3"]);
    // FOUR_R1 with a bye: D unseated, and an even field of 4 has a bye.
    expect(rulesOf(check(FOUR, FOUR_R1, paired([["A", "C"]], "B")))).toEqual(["P-A3", "P-A3"]);
  });

  it("P-A4 (a second bye): giving the bye to an entrant who already had one is illegal; an eligible bye is legal", () => {
    // 5 players after round 2.
    //   R1: A–B (A wins), C–D (C wins), E bye → A1 B0 C1 D0 E1.
    //   R2: A–C (A wins), B–E (B wins), D bye → A2 B1 C1 D1 E1.
    // Met: A–B, C–D, A–C, B–E. Byes: E, D. Bye-eligible for round 3: A, B, C.
    const h = history({ met: [["A", "B"], ["C", "D"], ["A", "C"], ["B", "E"]], byes: ["E", "D"], scores: { A: 2, B: 1, C: 1, D: 1, E: 1 } });
    // E's second bye. A–D, B–C never met. Nobody eligible scores strictly below E's 1, so P-Q2 is silent.
    const bad = check(FIVE, h, paired([["A", "D"], ["B", "C"]], "E"));
    expect(bad.verdict).toBe("illegal");
    expect(rulesOf(bad)).toEqual(["P-A4"]);
    // B's first bye; A–D, C–E never met; nobody eligible scores below B's 1. Three candidates tested (A, B, C).
    const good = check(FIVE, h, paired([["A", "D"], ["C", "E"]], "B"));
    expect(good).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 1, candidates: 3 } });
  });

  it("P-A4 (no bye after a win's points without playing): the bye to a walkover winner is illegal; an eligible bye is legal", () => {
    // 5 players after round 2.
    //   R1: A–B (A wins), C–D (C wins), E bye → A1 B0 C1 D0 E1.
    //   R2: A–C (A wins), D–E walkover (E absent: D scores a win's points without playing), B bye → A2 B1 C1 D1 E1.
    // Met: A–B, C–D, A–C (D–E did NOT meet: P-A2). Byes: E, B. Walkover winner: D. Bye-eligible: A, C.
    const h = history({ met: [["A", "B"], ["C", "D"], ["A", "C"]], byes: ["E", "B"], walkoverWinners: ["D"], scores: { A: 2, B: 1, C: 1, D: 1, E: 1 } });
    // D's bye: A–E, B–C never met; nobody eligible scores strictly below D's 1 (C has 1).
    const bad = check(FIVE, h, paired([["A", "E"], ["B", "C"]], "D"));
    expect(bad.verdict).toBe("illegal");
    expect(rulesOf(bad)).toEqual(["P-A4"]);
    expect(bad.violations[0]?.detail).toMatch(/without playing/);
    // C's bye; A–D never met, B–E never met. Two candidates tested (A, C).
    expect(check(FIVE, h, paired([["A", "D"], ["B", "E"]], "C"))).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 1, candidates: 2 } });
  });

  it("P-A5 (chess colours on: colour difference within ±2, never one colour three times running): a board breaking both limits is illegal; the swapped board is legal; chess off ignores colour", () => {
    // 4 players, chess, after round 2 (a board's home plays White).
    //   R1: A(W)–C(B), D(W)–B(B).   R2: A(W)–D(B), C(W)–B(B).
    // Colours: A W,W · B B,B · C B,W · D W,B. Met: A–C, B–D, A–D, B–C. Scores A2 B0 C1 D1 (A won both; D beat B; C beat B).
    const colours: Record<string, SwissColour[]> = { A: ["W", "W"], B: ["B", "B"], C: ["B", "W"], D: ["W", "B"] };
    const h = history({ met: [["A", "C"], ["B", "D"], ["A", "D"], ["B", "C"]], colours, scores: { A: 2, B: 0, C: 1, D: 1 } });
    // A White again → W,W,W (three running) and difference +3; B Black again → B,B,B and −3. C W → B,W,W (+1); D B → W,B,B (−1).
    const bad = check(FOUR, h, paired([["A", "B"], ["C", "D"]]), { chess: true });
    expect(bad.verdict).toBe("illegal");
    expect(rulesOf(bad)).toEqual(["P-A5", "P-A5"]);
    // B White → B,B,W (−1); A Black → W,W,B (+1). Legal.
    expect(check(FOUR, h, paired([["B", "A"], ["C", "D"]]), { chess: true }).verdict).toBe("legal");
    // P-A5's scope is chess colours on: the same board with chess off is legal.
    expect(check(FOUR, h, paired([["A", "B"], ["C", "D"]]), { chess: false }).verdict).toBe("legal");
  });

  it("P-A5: each colour limit on its own — the difference alone (+3, no three running), then three running alone (difference +2)", () => {
    // Synthetic histories: X's and Y's colour lists stand alone (their earlier opponents are not in this field).
    // X W,W,B,W (difference +2). White again → W,W,B,W,W: difference +3, last three B,W,W are not one colour.
    const diffOnly = check(["X", "Y"], history({ colours: { X: ["W", "W", "B", "W"] }, scores: { X: 3, Y: 3 } }), paired([["X", "Y"]]), { chess: true });
    expect(rulesOf(diffOnly)).toEqual(["P-A5"]);
    expect(diffOnly.violations[0]?.detail).toMatch(/difference \+3/);
    expect(diffOnly.violations[0]?.detail).not.toMatch(/three times running/);
    // X B,W,W (difference +1). White again → B,W,W,W: difference +2 (allowed), but W three times running.
    const runOnly = check(["X", "Y"], history({ colours: { X: ["B", "W", "W"] }, scores: { X: 2, Y: 2 } }), paired([["X", "Y"]]), { chess: true });
    expect(rulesOf(runOnly)).toEqual(["P-A5"]);
    expect(runOnly.violations[0]?.detail).toMatch(/W three times running/);
    expect(runOnly.violations[0]?.detail).not.toMatch(/difference/);
    // Swapped, X takes Black in both: legal.
    expect(check(["X", "Y"], history({ colours: { X: ["W", "W", "B", "W"] }, scores: { X: 3, Y: 3 } }), paired([["Y", "X"]]), { chess: true }).verdict).toBe("legal");
    expect(check(["X", "Y"], history({ colours: { X: ["B", "W", "W"] }, scores: { X: 2, Y: 2 } }), paired([["Y", "X"]]), { chess: true }).verdict).toBe("legal");
  });

  it("P-A7 (withdrawn, disqualified, deleted entrants are not paired): seating a departed entrant is illegal; the active field alone is legal", () => {
    // FIVE_R1, then D withdraws after round 1. Active for round 2: A, B, C, E (even, so no bye).
    // D as the bye: P-A7, and the even active field of 4 then has a bye (P-A3) — a departed seat always costs one.
    const asBye = check(FIVE, FIVE_R1, paired([["A", "C"], ["B", "E"]], "D"), { departed: ["D"] });
    expect(asBye.verdict).toBe("illegal");
    expect(rulesOf(asBye)).toEqual(["P-A7", "P-A3"]);
    // D on a board (A–D never met), C as the bye: P-A7 on the board, then the bye in an even field.
    expect(rulesOf(check(FIVE, FIVE_R1, paired([["A", "D"], ["B", "E"]], "C"), { departed: ["D"] }))).toEqual(["P-A7", "P-A3"]);
    // A deleted entrant may be gone from the field altogether: still P-A7, never "not in the field".
    expect(rulesOf(check(["A", "B", "C", "E"], FIVE_R1, paired([["A", "D"], ["B", "E"]], "C"), { departed: ["D"] }))).toEqual(["P-A7", "P-A3"]);
    // A–C, B–E: neither met; every active entrant seated once; even field, no bye.
    expect(check(FIVE, FIVE_R1, paired([["A", "C"], ["B", "E"]]), { departed: ["D"] })).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 0, candidates: 1 } });
  });
});

describe("§2.3 item 3: existence (P-A6) — refusals and empty rounds", () => {
  it("refusal_correct: 4 players after 3 rounds — K₄ is exhausted (rulebook §3.1, hard maximum n − 1 for even n)", () => {
    const v = check(FOUR, FOUR_K4, refused("NO_LEGAL_PAIRING: every remaining pairing repeats a match"));
    expect(v).toEqual({ verdict: "refusal_correct", violations: [], examined: { boards: 0, byes: 0, candidates: 1 } });
  });

  it("refusal_correct: 3 players after 3 rounds — every entrant has had the bye (rulebook §3.1, hard maximum n for odd n)", () => {
    // R1: A–B (A wins), C bye. R2: A–C (C wins), B bye. R3: B–C (B wins), A bye. Scores A2 B2 C2.
    // Met: all 3 pairs. Byes: C, B, A — no bye-eligible entrant, so no candidate is even tested.
    const h = history({ met: [["A", "B"], ["A", "C"], ["B", "C"]], byes: ["C", "B", "A"], scores: { A: 2, B: 2, C: 2 } });
    expect(check(["A", "B", "C"], h, refused("NO_LEGAL_PAIRING"))).toEqual({ verdict: "refusal_correct", violations: [], examined: { boards: 0, byes: 0, candidates: 0 } });
  });

  it("refusal_wrong: a refusal while a legal pairing exists — 4 players after 2 rounds (A–D, B–C remain), and 3 players after 2 rounds (A's bye, B–C remain)", () => {
    const four = check(FOUR, FOUR_R2, refused("NO_LEGAL_PAIRING"));
    expect(four.verdict).toBe("refusal_wrong");
    expect(rulesOf(four)).toEqual(["P-A6"]);
    // R1: A–B (A wins), C bye. R2: A–C (C wins), B bye. Met A–B, A–C; byes C, B. Only A is bye-eligible; without A,
    // B–C never met — a perfect matching. One candidate tested.
    const h3 = history({ met: [["A", "B"], ["A", "C"]], byes: ["C", "B"], scores: { A: 1, B: 1, C: 2 } });
    const three = check(["A", "B", "C"], h3, refused("NO_LEGAL_PAIRING"));
    expect(three.verdict).toBe("refusal_wrong");
    expect(three.examined.candidates).toBe(1);
    expect(three.violations[0]?.detail).toMatch(/A on the bye/);
  });

  it("refusal_wrong: a refusal that names no reason, even where no pairing exists (§2.3 item 3: the refusal names the reason)", () => {
    const v = check(FOUR, FOUR_K4, refused("  "));
    expect(v.verdict).toBe("refusal_wrong");
    expect(rulesOf(v)).toEqual(["P-A6"]);
    expect(v.violations[0]?.detail).toMatch(/names no reason/);
  });

  it("empty_success (SW-H1's shape, the regression): zero boards returned as success while a pairing exists is caught, never legal", () => {
    // FOUR_R1: A–C, B–D (or A–D, B–C) is available, and the round came back empty.
    const v = check(FOUR, FOUR_R1, paired([]));
    expect(v.verdict).toBe("empty_success");
    expect(rulesOf(v)).toEqual(["P-A6"]);
    expect(v.examined).toEqual({ boards: 0, byes: 0, candidates: 1 });
    // And where none exists (K₄ exhausted), an empty round as success is still SW-H1: a named refusal was owed.
    const exhausted = check(FOUR, FOUR_K4, paired([]));
    expect(exhausted.verdict).toBe("empty_success");
    expect(exhausted.violations[0]?.detail).toMatch(/refusal was owed/);
  });

  it("the empty round's boundary: 2 active entrants with zero boards is empty_success — one board was owed", () => {
    // A fresh 2-entrant field: A–B is owed, and nothing came back.
    expect(check(["A", "B"], history({ scores: zeros(["A", "B"]) }), paired([]))).toEqual({
      verdict: "empty_success",
      violations: [{ rule: "P-A6", detail: "zero boards returned as success while a legal pairing exists" }],
      examined: { boards: 0, byes: 0, candidates: 1 },
    });
    // 3 entrants, C withdrew: the same 2-entrant boundary, reached after a withdrawal.
    expect(check(["A", "B", "C"], history({ scores: zeros(["A", "B", "C"]) }), paired([]), { departed: ["C"] }).verdict).toBe("empty_success");
  });

  // Ruling (controller, T19 fix round 2): §3.1 gives hardMax(1) = 0 — one active entrant is owed no round. Nothing to
  // pair, and a bye-only round is not a round (P-A6; T13 agrees: a round whose only seat is a bye is not decided).
  // A and B played round 1 (A won), then B withdrew: A is the one active entrant.
  const ALONE = history({ met: [["A", "B"]], scores: { A: 1, B: 0 } });

  it("§3.1 ruling, one active entrant: a paired outcome is illegal (P-A6, no round is owed — a bye-only round is not a round), with the bye or without it, fresh or after a withdrawal", () => {
    const byeOnly = check(["A", "B"], ALONE, paired([], "A"), { departed: ["B"] });
    expect(byeOnly.verdict).toBe("illegal");
    expect(rulesOf(byeOnly)).toEqual(["P-A6"]);
    expect(byeOnly.violations[0]?.detail).toMatch(/hard maximum is 0, so no round is owed/);
    expect(byeOnly.examined).toEqual({ boards: 0, byes: 1, candidates: 0 });
    expect(rulesOf(check(["A", "B"], ALONE, paired([]), { departed: ["B"] }))).toEqual(["P-A6"]);
    // A single-entrant field before any round: the same answer — never empty_success, never legal.
    expect(rulesOf(check(["A"], history({ scores: { A: 0 } }), paired([], "A")))).toEqual(["P-A6"]);
  });

  it("§3.1 ruling, one active entrant: a named refusal is refusal_correct (no matching tested); a blank one is refusal_wrong", () => {
    expect(check(["A", "B"], ALONE, refused("NO_ROUND_OWED: one active entrant"), { departed: ["B"] })).toEqual({ verdict: "refusal_correct", violations: [], examined: { boards: 0, byes: 0, candidates: 0 } });
    const blank = check(["A", "B"], ALONE, refused(""), { departed: ["B"] });
    expect(blank.verdict).toBe("refusal_wrong");
    expect(rulesOf(blank)).toEqual(["P-A6"]);
  });

  it("P-A5 inside existence: compatibility is pairwise — with chess on, a field whose every unmet pair breaks the colour limits has no pairing; with chess off it has one", () => {
    // 4 players, chess, after round 2: R1 A(W)–C(B), B(W)–D(B); R2 A(W)–D(B), B(W)–C(B).
    // Colours A W,W · B W,W · C B,B · D B,B. Unmet: A–B (both need Black) and C–D (both need White): neither pair has
    // a colour assignment within both limits, so no perfect matching exists.
    const colours: Record<string, SwissColour[]> = { A: ["W", "W"], B: ["W", "W"], C: ["B", "B"], D: ["B", "B"] };
    const h = history({ met: [["A", "C"], ["B", "D"], ["A", "D"], ["B", "C"]], colours, scores: { A: 1, B: 1, C: 1, D: 1 } });
    expect(check(FOUR, h, refused("NO_LEGAL_PAIRING: colour limits"), { chess: true }).verdict).toBe("refusal_correct");
    expect(check(FOUR, h, refused("NO_LEGAL_PAIRING: colour limits"), { chess: false }).verdict).toBe("refusal_wrong");
  });
});

describe("§2.3 item 4: the bye goes to the lowest score whose removal leaves a pairable remainder (P-Q2's hard core)", () => {
  it("P-Q2: the bye to a 1-point entrant while 0-point eligible entrants leave a pairable remainder is illegal; the bye to the lowest is legal", () => {
    // FIVE_R1, round 2. Eligible: A1 B0 C1 D0 (E had the bye).
    // Bye A: B (0) is lower — without B, {A,C,D,E} pairs A–C, D–E; D (0) is lower — without D, {A,B,C,E} pairs A–C, B–E.
    const bad = check(FIVE, FIVE_R1, paired([["B", "C"], ["D", "E"]], "A"));
    expect(bad.verdict).toBe("illegal");
    expect(rulesOf(bad)).toEqual(["P-Q2"]);
    expect(bad.violations[0]?.detail).toMatch(/B.*D/);
    // Bye B (0): nobody lower. A–C, D–E never met. Four candidates tested (A, B, C, D).
    expect(check(FIVE, FIVE_R1, paired([["A", "C"], ["D", "E"]], "B"))).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 1, candidates: 4 } });
  });

  it("P-Q2: a higher bye is legal when the lower eligible entrant's removal leaves NO pairable remainder", () => {
    // 5 players after round 3.
    //   R1: A–B (A wins), C–D (C wins), E bye → A1 B0 C1 D0 E1.
    //   R2: A–D (A wins), E–C (E wins), B bye → A2 B1 C1 D0 E2.
    //   R3: A–E (A wins), B–C walkover (C absent: B wins without playing), D bye → A3 B2 C1 D1 E2.
    // Met: A–B, C–D, A–D, C–E, A–E (B–C did NOT meet: P-A2). Byes E, B, D. Walkover winner B. Eligible: A3, C1.
    // Without C, A has met B, D and E — no partner, no perfect matching. Without A, B–C and D–E pair.
    const h = history({ met: [["A", "B"], ["C", "D"], ["A", "D"], ["C", "E"], ["A", "E"]], byes: ["E", "B", "D"], walkoverWinners: ["B"], scores: { A: 3, B: 2, C: 1, D: 1, E: 2 } });
    expect(check(FIVE, h, paired([["B", "C"], ["D", "E"]], "A"))).toEqual({ verdict: "legal", violations: [], examined: { boards: 2, byes: 1, candidates: 2 } });
  });
});

describe("§2.3 item 5: round 1 with explicit seeds and no history is exact, in the stage's effective mode (§7: fold by default, or rank_adjacent; unseeded is not exact)", () => {
  const EIGHT = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
  const R0 = (ids: string[]) => history({ scores: zeros(ids) });

  it("8 seeded players: 1v5, 2v6, 3v7, 4v8 is legal in either colour order; rank-adjacent 1v2, 3v4 … and the mirror 1v8 … are illegal", () => {
    expect(check(EIGHT, R0(EIGHT), paired([["p1", "p5"], ["p2", "p6"], ["p3", "p7"], ["p4", "p8"]])).verdict).toBe("legal");
    expect(check(EIGHT, R0(EIGHT), paired([["p5", "p1"], ["p6", "p2"], ["p7", "p3"], ["p8", "p4"]]), { chess: true }).verdict).toBe("legal");
    const adjacent = check(EIGHT, R0(EIGHT), paired([["p1", "p2"], ["p3", "p4"], ["p5", "p6"], ["p7", "p8"]]));
    expect(adjacent.verdict).toBe("illegal");
    expect(rulesOf(adjacent)).toEqual(["P-Q3"]);
    expect(rulesOf(check(EIGHT, R0(EIGHT), paired([["p1", "p8"], ["p2", "p7"], ["p3", "p6"], ["p4", "p5"]])))).toEqual(["P-Q3"]);
  });

  it("7 seeded players: the last seed takes the bye and the rest fold (1v4, 2v5, 3v6); another bye is illegal", () => {
    const SEVEN = EIGHT.slice(0, 7);
    expect(check(SEVEN, R0(SEVEN), paired([["p1", "p4"], ["p2", "p5"], ["p3", "p6"]], "p7")).verdict).toBe("legal");
    // p1 on the bye, p2..p7 folded (2v5, 3v6, 4v7): all scores 0, so P-Q2 is silent — only the round-1 fold is broken.
    expect(rulesOf(check(SEVEN, R0(SEVEN), paired([["p2", "p5"], ["p3", "p6"], ["p4", "p7"]], "p1")))).toEqual(["P-Q3"]);
  });

  it("rank_adjacent (§2.3 item 5: 1v2, 3v4): 8 seeds 1v2, 3v4, 5v6, 7v8 is legal; the fold is illegal under it; an explicit fold equals the default", () => {
    const adjacent = paired([["p1", "p2"], ["p3", "p4"], ["p5", "p6"], ["p7", "p8"]]);
    const fold = paired([["p1", "p5"], ["p2", "p6"], ["p3", "p7"], ["p4", "p8"]]);
    expect(check(EIGHT, R0(EIGHT), adjacent, { round1Mode: "rank_adjacent" })).toEqual({ verdict: "legal", violations: [], examined: { boards: 4, byes: 0, candidates: 1 } });
    expect(check(EIGHT, R0(EIGHT), paired([["p2", "p1"], ["p4", "p3"], ["p6", "p5"], ["p8", "p7"]]), { round1Mode: "rank_adjacent", chess: true }).verdict).toBe("legal");
    const wrong = check(EIGHT, R0(EIGHT), fold, { round1Mode: "rank_adjacent" });
    expect(wrong.verdict).toBe("illegal");
    expect(rulesOf(wrong)).toEqual(["P-Q3"]);
    expect(wrong.violations[0]?.detail).toMatch(/rank_adjacent/);
    // 1v3, 2v4, 5v7, 6v8: neither order.
    expect(rulesOf(check(EIGHT, R0(EIGHT), paired([["p1", "p3"], ["p2", "p4"], ["p5", "p7"], ["p6", "p8"]]), { round1Mode: "rank_adjacent" }))).toEqual(["P-Q3"]);
    expect(check(EIGHT, R0(EIGHT), fold, { round1Mode: "fold" })).toEqual(check(EIGHT, R0(EIGHT), fold));
    expect(rulesOf(check(EIGHT, R0(EIGHT), adjacent, { round1Mode: "fold" }))).toEqual(["P-Q3"]);
  });

  it("rank_adjacent, 7 seeds: the last seed takes the bye and the rest pair adjacently (1v2, 3v4, 5v6); a fold or another bye is illegal", () => {
    const SEVEN = EIGHT.slice(0, 7);
    expect(check(SEVEN, R0(SEVEN), paired([["p1", "p2"], ["p3", "p4"], ["p5", "p6"]], "p7"), { round1Mode: "rank_adjacent" }).verdict).toBe("legal");
    expect(rulesOf(check(SEVEN, R0(SEVEN), paired([["p1", "p4"], ["p2", "p5"], ["p3", "p6"]], "p7"), { round1Mode: "rank_adjacent" }))).toEqual(["P-Q3"]);
    // p1 on the bye, p2..p7 adjacent (2v3, 4v5, 6v7): all scores 0, so P-Q2 is silent — only the round-1 order breaks.
    expect(rulesOf(check(SEVEN, R0(SEVEN), paired([["p2", "p3"], ["p4", "p5"], ["p6", "p7"]], "p1"), { round1Mode: "rank_adjacent" }))).toEqual(["P-Q3"]);
  });

  it("unseeded round 1 (no explicit seeds: item 5 does not apply) is judged on legality alone — any order is legal, a partial round or a missing bye is not", () => {
    const SEVEN = EIGHT.slice(0, 7);
    for (const boards of [
      [["p1", "p5"], ["p2", "p6"], ["p3", "p7"], ["p4", "p8"]],
      [["p1", "p2"], ["p3", "p4"], ["p5", "p6"], ["p7", "p8"]],
      [["p1", "p8"], ["p2", "p7"], ["p3", "p6"], ["p4", "p5"]],
    ] as Pair[][]) {
      expect(check(EIGHT, R0(EIGHT), paired(boards), { round1Mode: "unseeded" }).verdict).toBe("legal");
    }
    // Any bye in an odd field: all scores are 0, so P-Q2 has nobody strictly lower.
    expect(check(SEVEN, R0(SEVEN), paired([["p2", "p7"], ["p3", "p6"], ["p4", "p5"]], "p1"), { round1Mode: "unseeded" }).verdict).toBe("legal");
    // Legality still holds: p7 and p8 unseated (P-A3 ×2); the odd field without a bye (p7 unseated, no bye).
    expect(rulesOf(check(EIGHT, R0(EIGHT), paired([["p1", "p2"], ["p3", "p4"], ["p5", "p6"]]), { round1Mode: "unseeded" }))).toEqual(["P-A3", "P-A3"]);
    expect(rulesOf(check(SEVEN, R0(SEVEN), paired([["p1", "p2"], ["p3", "p4"], ["p5", "p6"]]), { round1Mode: "unseeded" }))).toEqual(["P-A3", "P-A3"]);
  });

  it("an unknown round-1 mode is refused, never read as a default", () => {
    expect(() => checkSwissRound({ field: EIGHT, departed: [], chess: false, history: R0(EIGHT), round1Mode: "random" as SwissRound1Mode, outcome: paired([]) })).toThrow(/unknown round-1 mode "random"/);
  });

  it("after a withdrawal before round 1: the fold is of the ACTIVE field in seed order (p3 gone: bye p8; 1v5, 2v6, 4v7)", () => {
    const v = check(EIGHT, R0(EIGHT), paired([["p1", "p5"], ["p2", "p6"], ["p4", "p7"]], "p8"), { departed: ["p3"] });
    expect(v).toEqual({ verdict: "legal", violations: [], examined: { boards: 3, byes: 1, candidates: 7 } });
    expect(rulesOf(check(EIGHT, R0(EIGHT), paired([["p1", "p4"], ["p2", "p5"], ["p6", "p7"]], "p8"), { departed: ["p3"] }))).toEqual(["P-Q3"]);
  });
});

describe("RB3-24: the matching oracle, cross-checked", () => {
  it("the empty graph, and the bounds: blossom refuses n > 128 and the brute force n > 12 (OutOfScope); a bad edge is refused", () => {
    expect(Array.from(blossomMatching(0, []))).toEqual([]);
    expect(bruteForcePerfectMatching(0, [])).toBe(true);
    expect(bruteForceMaximumMatching(0, [])).toBe(0);
    expect([BLOSSOM_MAX_N, BRUTE_FORCE_MAX_N]).toEqual([RB3_24_BLOSSOM_N, RB3_24_BRUTE_N]);
    expect(() => blossomMatching(RB3_24_BLOSSOM_N + 1, [])).toThrow(SwissOutOfScope);
    expect(() => bruteForcePerfectMatching(RB3_24_BRUTE_N + 1, [])).toThrow(SwissOutOfScope);
    expect(() => bruteForceMaximumMatching(RB3_24_BRUTE_N + 1, [])).toThrow(SwissOutOfScope);
    // The bound is inclusive: n = 12 is answered by both brute forces (the 128 side is the K₁₂₈ test below).
    expect(bruteForcePerfectMatching(RB3_24_BRUTE_N, allPairs(RB3_24_BRUTE_N))).toBe(true);
    expect(bruteForceMaximumMatching(RB3_24_BRUTE_N, allPairs(RB3_24_BRUTE_N))).toBe(6);
    expect(() => blossomMatching(3, [[0, 0]])).toThrow(/self-loop/);
    expect(() => blossomMatching(3, [[0, 3]])).toThrow(/vertex range/);
  });

  it("fast-check: blossomMatching is a valid matching of the brute force's maximum size, and perfect exactly when the brute force says so (n <= 12, seed 20261031)", () => {
    const SEED = 20261031;
    const RUNS = 1500;
    let runs = 0;
    let perfect = 0;
    let evenWithout = 0;
    let unsaturated = 0;
    const graph = fc.integer({ min: 0, max: RB3_24_BRUTE_N }).chain((n) => fc.tuple(fc.constant(n), fc.subarray(allPairs(n))));
    fc.assert(
      fc.property(graph, ([n, edges]) => {
        runs++;
        const mate = blossomMatching(n, edges);
        const size = matchingSize(n, edges, mate);
        // The SIZE, not only "perfect or not": where a perfect matching exists, every free vertex has an augmenting path
        // (Berge), so a blossom that gives up at its first failed search still answers "perfect" correctly. Only the
        // maximum size tells it apart (measured: that mutant survives the perfect-matching agreement alone).
        const max = bruteForceMaximumMatching(n, edges);
        expect(size).toBe(max);
        const isPerfect = 2 * size === n;
        expect(isPerfect).toBe(bruteForcePerfectMatching(n, edges));
        if (isPerfect) perfect++;
        else if (n % 2 === 0) evenWithout++;
        if (2 * size < n - 1) unsaturated++;
      }),
      { seed: SEED, numRuns: RUNS },
    );
    report(`oracle cross-check: ${runs} random graphs (seed ${SEED}); ${perfect} with a perfect matching, ${evenWithout} even without one, ${unsaturated} leaving 2+ vertices free`);
    expect(runs).toBe(RUNS);
    // Both answers, and graphs where a maximum matching leaves vertices free, were reached — never one side only.
    expect(perfect).toBeGreaterThan(0);
    expect(evenWithout).toBeGreaterThan(0);
    expect(unsaturated).toBeGreaterThan(0);
  });

  it("n = 128: K₁₂₈ has a perfect matching, and so does K₁₂₈ minus a perfect matching", () => {
    const n = RB3_24_BLOSSOM_N;
    const complete = allPairs(n);
    expect(matchingSize(n, complete, blossomMatching(n, complete))).toBe(n / 2);
    // Remove the 64 edges {2i, 2i+1}: every vertex keeps degree 126, and a perfect matching still exists — by hand,
    // {0,2},{1,3},{4,6},{5,7},… pairs every vertex using none of the removed edges.
    const minus = complete.filter(([u, v]) => !(u % 2 === 0 && v === u + 1));
    expect(minus.length).toBe((n * (n - 1)) / 2 - n / 2);
    expect(matchingSize(n, minus, blossomMatching(n, minus))).toBe(n / 2);
  });
});

// 3 players, no bye-eligible entrant left within the hard maximum (§3.1: 3 rounds for n = 3).
//   R1: A–B walkover (B absent: A scores a win's points without playing — not a meeting, P-A2), C bye → A1 B0 C1.
//   R2: A–C (A wins), B bye → A2 B1 C1.
// Met: A–C. Byes: C, B. Walkover winner: A. Round 3 is odd and every entrant is barred from the bye (P-A4): no seating
// is legal, so a named refusal is owed (P-A6) — and no candidate is even tested.
const THREE_NO_ELIGIBLE = history({ met: [["A", "C"]], byes: ["C", "B"], walkoverWinners: ["A"], scores: { A: 2, B: 1, C: 1 } });

describe("P-A4 × P-A6: an odd round with no bye-eligible entrant left", () => {
  it("3 players after 2 rounds (A won a walkover; B and C had byes): every seating is illegal (P-A4), a named refusal is correct, 0 candidates", () => {
    // A–B never met (the walkover is not a meeting): C's second bye is the only fault.
    expect(rulesOf(check(["A", "B", "C"], THREE_NO_ELIGIBLE, paired([["A", "B"]], "C")))).toEqual(["P-A4"]);
    // B–C never met: A's bye after a walkover win is the only fault.
    expect(rulesOf(check(["A", "B", "C"], THREE_NO_ELIGIBLE, paired([["B", "C"]], "A")))).toEqual(["P-A4"]);
    expect(check(["A", "B", "C"], THREE_NO_ELIGIBLE, refused("NO_LEGAL_PAIRING: no entrant may take the bye"))).toEqual({ verdict: "refusal_correct", violations: [], examined: { boards: 0, byes: 0, candidates: 0 } });
  });

  // Named regression (TEST-STRATEGY rule 10), found by the producer -> consumer sweep with walkovers: the same history
  // through the engine's real pairRound. The rulebook's answer is refusal_correct. This test PINS engine 1.1.0's exact
  // output (controller ruling, fix round 2), so any change to it turns the test red; App-B's bump flips it to assert
  // refusal_correct. The walkover winner reaches the engine through `byes`, its one bye-eligibility channel (header).
  it("engine 1.1.0 defect pin (P-A4 × P-A6): 3 players, round 3 with no bye-eligible entrant — 1.1.0 returns A–B with C's SECOND bye (illegal); App-B's bump flips this to refusal_correct", () => {
    const standings = [{ entrantId: "A", score: 2, rank: 1 }, { entrantId: "B", score: 1, rank: 2 }, { entrantId: "C", score: 1, rank: 3 }];
    let outcome: SwissRoundIn["outcome"];
    try {
      const r = pairRound(standings, { played: new Set([pairKey("A", "C")]), byes: new Set(["C", "B", "A"]) }, { chess: false });
      outcome = { kind: "paired", boards: r.pairings.map((p) => ({ home: p.home, away: p.away })), bye: r.bye ?? null };
    } catch (e) {
      outcome = { kind: "refused", reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    const v = check(["A", "B", "C"], THREE_NO_ELIGIBLE, outcome);
    report(`engine 1.1.0 defect pin (P-A4 × P-A6): outcome ${JSON.stringify(outcome)} → ${v.verdict} ${JSON.stringify(v.violations)}`);
    expect(outcome).toEqual({ kind: "paired", boards: [{ home: "A", away: "B" }], bye: "C" });
    expect(v).toEqual({ verdict: "illegal", violations: [{ rule: "P-A4", detail: "C already received the pairing-allocated bye" }], examined: { boards: 1, byes: 1, candidates: 0 } });
  });
});

describe("the checker's own guard: a broken matching oracle is refused, never turned into a verdict", () => {
  it("with blossomMatching stubbed to match nothing, a legal round throws 'the oracle is broken'; an illegal round still answers illegal", async () => {
    vi.resetModules();
    vi.doMock("./swiss-matching.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Matching>()), blossomMatching: (n: number) => new Int32Array(n).fill(-1) }));
    try {
      const { checkSwissRound: withBrokenOracle } = await import("./swiss-legality.ts");
      const round = (outcome: SwissRoundIn["outcome"]): SwissRoundIn => ({ field: FOUR, departed: [], chess: false, history: FOUR_R1, outcome });
      // FOUR_R1, A–C and B–D: legal by every rule, yet the stub finds no perfect matching.
      expect(() => withBrokenOracle(round(paired([["A", "C"], ["B", "D"]])))).toThrow(/the oracle is broken/);
      // The guard fires on a LEGAL verdict only: the rematch round is illegal (P-A1 ×2) whatever the oracle says.
      expect(rulesOf(withBrokenOracle(round(paired([["A", "B"], ["C", "D"]]))))).toEqual(["P-A1", "P-A1"]);
    } finally {
      vi.doUnmock("./swiss-matching.ts");
      vi.resetModules();
    }
  });
});

describe("producer -> consumer (R15): the engine's real pairRound, every round judged", () => {
  it("200 seeded sequences, n 2–16, rounds to the hard maximum (§3.1), chess on and off, fold and rank_adjacent, some with a withdrawal or walkovers: no illegal round", () => {
    const BASE_SEED = 20261031;
    const SEQUENCES = 200;
    const histogram: Record<SwissVerdict["verdict"], number> = { legal: 0, illegal: 0, refusal_correct: 0, refusal_wrong: 0, empty_success: 0 };
    const illegal: string[] = [];
    /** Engine 1.x defect, named (see the 1.1.0 defect pin above): an odd round with NO bye-eligible entrant left (every
     *  active entrant had the bye or a walkover win — reachable below the hard maximum only through walkovers) owes a
     *  named refusal (P-A4, P-A6); 1.1.0 re-gives a bye instead. Matched exactly: odd field, empty eligible pool, every
     *  violation P-A4. Printed, not asserted — App-B's bump asserts it 0, with `illegal === 0` restored. */
    const reByeWithNoEligible: string[] = [];
    const notes: string[] = [];
    let rounds = 0;
    let boards = 0;
    let withdrawals = 0;
    /** empty_success split by the active field's parity and by what was owed: a pairing existed, or a named refusal. */
    const emptySplit = { odd_pairing: 0, even_pairing: 0, odd_refusal: 0, even_refusal: 0 };
    /** How often each rule the unit tests carry had something to judge here (see the header: some are 0 by construction). */
    const reach = {
      walkovers: 0,
      doubleWalkovers: 0,
      /** P-A2: a board re-pairing two entrants whose earlier board was a walkover (not a meeting). */
      rePairedAfterWalkover: 0,
      /** P-A4 walkover clause: an odd round judged with an active walkover winner who never had the bye. */
      oddRoundsWithWalkoverWinner: 0,
      /** P-A7: rounds judged with a departed entrant. */
      roundsWithDeparted: 0,
      /** P-Q2: odd rounds whose bye holder scored strictly more than some eligible active entrant. */
      byeAboveALowerEligible: 0,
      /** P-A4 second bye: odd rounds where every active entrant had already had a bye or a walkover win. */
      oddRoundsWithNoEligible: 0,
      round1Fold: 0,
      round1RankAdjacent: 0,
    };
    for (let s = 0; s < SEQUENCES; s++) {
      const rng = mulberry32(BASE_SEED + s);
      const n = 2 + (s % 15);
      const chess = s % 2 === 1;
      // One sequence pair in three is a rank_adjacent stage (§7 stores the mode; the engine's `pairing` constraint).
      const mode: "fold" | "rank_adjacent" = Math.floor(s / 2) % 3 === 2 ? "rank_adjacent" : "fold";
      // One sequence in three has walkovers: a one-sided walkover (8% of boards) or a double walkover (2%).
      const walkovers = s % 3 === 2;
      const field = Array.from({ length: n }, (_, i) => `e${String(i + 1).padStart(2, "0")}`);
      const departed: string[] = [];
      const met: Pair[] = [];
      const walkedOver: Pair[] = [];
      const byes: string[] = [];
      const walkoverWinners: string[] = [];
      const colours: Record<string, SwissColour[]> = {};
      const scores: Record<string, number> = zeros(field);
      // One sequence in five loses an entrant between two rounds (TEST-STRATEGY rule 1: after a withdrawal).
      const withdrawAfter = s % 5 === 4 && n > 2 ? 1 + Math.floor(rng() * (hardMax(n) - 1)) : 0;
      for (let round = 1; ; round++) {
        const active = field.filter((id) => !departed.includes(id));
        if (round > hardMax(active.length)) break;
        const seed = (id: string) => field.indexOf(id);
        const standings = [...active]
          .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || seed(a) - seed(b))
          .map((entrantId, i) => ({ entrantId, score: scores[entrantId] ?? 0, rank: i + 1 }));
        const engineHistory = {
          played: new Set(met.map(([a, b]) => pairKey(a, b))),
          // The engine's one bye-eligibility channel: a walkover winner is passed as bye-ineligible (P-A4) through it.
          byes: new Set([...byes, ...walkoverWinners]),
          ...(chess ? { colours: new Map(Object.entries(colours)) } : {}),
        };
        let outcome: SwissRoundIn["outcome"];
        try {
          const r = pairRound(standings, engineHistory, { chess, pairing: mode });
          outcome = { kind: "paired", boards: r.pairings.map((p) => ({ home: p.home, away: p.away })), bye: r.bye ?? null };
        } catch (e) {
          outcome = { kind: "refused", reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
        const before: SwissHistoryIn = { met: met.map(([a, b]): Pair => [a, b]), byes: [...byes], walkoverWinners: [...walkoverWinners], colours: structuredClone(colours), scores: { ...scores } };
        const v = checkSwissRound({ field, departed: [...departed], chess, history: before, round1Mode: mode, outcome });
        rounds++;
        boards += v.examined.boards;
        histogram[v.verdict]++;
        const odd = active.length % 2 === 1;
        if (round === 1) reach[mode === "fold" ? "round1Fold" : "round1RankAdjacent"]++;
        if (departed.length > 0) reach.roundsWithDeparted++;
        if (odd && active.some((id) => walkoverWinners.includes(id) && !byes.includes(id))) reach.oddRoundsWithWalkoverWinner++;
        if (odd && active.every((id) => byes.includes(id) || walkoverWinners.includes(id))) reach.oddRoundsWithNoEligible++;
        if (outcome.kind === "paired" && outcome.bye !== null) {
          const byeScore = scores[outcome.bye] ?? 0;
          if (active.some((id) => !byes.includes(id) && !walkoverWinners.includes(id) && (scores[id] ?? 0) < byeScore)) reach.byeAboveALowerEligible++;
        }
        if (outcome.kind === "paired") {
          const keyOf = ([a, b]: Pair) => (a < b ? `${a}|${b}` : `${b}|${a}`);
          const walked = new Set(walkedOver.map(keyOf));
          reach.rePairedAfterWalkover += outcome.boards.filter(({ home, away }) => walked.has(keyOf([home, away]))).length;
        }
        const eligible = active.filter((id) => !byes.includes(id) && !walkoverWinners.includes(id));
        const at = `seq ${s} (seed ${BASE_SEED + s}, n ${n}, chess ${chess}, ${mode}, walkovers ${walkovers}, departed [${departed.join(",")}]) round ${round}, ${active.length} active, bye-eligible [${eligible.join(",")}]`;
        if (v.verdict === "empty_success") {
          const owed = v.violations[0]?.detail.includes("refusal was owed") === true ? "refusal" : "pairing";
          emptySplit[`${odd ? "odd" : "even"}_${owed}`]++;
        }
        if (v.verdict === "illegal") {
          const line = `${at}: ${JSON.stringify(v.violations)} | history ${JSON.stringify(before)} | outcome ${JSON.stringify(outcome)}`;
          if (odd && eligible.length === 0 && v.violations.every((x) => x.rule === "P-A4")) reByeWithNoEligible.push(line);
          else illegal.push(line);
        }
        if (v.verdict !== "legal") {
          notes.push(`${at}: ${v.verdict}`);
          break;
        }
        // Play the round. A walkover is not a meeting and gives no colour (P-A2, A2 3.4): its winner scores a win's
        // points without playing (P-A4); a double walkover scores nobody and leaves both bye-eligible. Otherwise home
        // win, away win or draw at chess points (win 1, draw ½). The bye scores a win's points.
        if (outcome.kind !== "paired") throw new Error("test: a legal verdict on a refusal");
        for (const { home, away } of outcome.boards) {
          const wo = walkovers ? rng() : 1;
          if (wo < 0.02) {
            walkedOver.push([home, away]);
            reach.doubleWalkovers++;
            continue;
          }
          if (wo < 0.1) {
            const winner = wo < 0.06 ? home : away;
            walkedOver.push([home, away]);
            if (!walkoverWinners.includes(winner)) walkoverWinners.push(winner);
            scores[winner] = (scores[winner] ?? 0) + 1;
            reach.walkovers++;
            continue;
          }
          met.push([home, away]);
          const roll = rng();
          if (roll < 0.45) scores[home] = (scores[home] ?? 0) + 1;
          else if (roll < 0.9) scores[away] = (scores[away] ?? 0) + 1;
          else {
            scores[home] = (scores[home] ?? 0) + 0.5;
            scores[away] = (scores[away] ?? 0) + 0.5;
          }
          if (chess) {
            (colours[home] ??= []).push("W");
            (colours[away] ??= []).push("B");
          }
        }
        if (outcome.bye !== null) {
          byes.push(outcome.bye);
          scores[outcome.bye] = (scores[outcome.bye] ?? 0) + 1;
        }
        if (round === withdrawAfter) {
          const leaving = active[Math.floor(rng() * active.length)];
          if (leaving !== undefined) {
            departed.push(leaving);
            withdrawals++;
          }
        }
      }
    }
    report(`producer -> consumer: ${SEQUENCES} sequences (seeds ${BASE_SEED}..${BASE_SEED + SEQUENCES - 1}), ${rounds} rounds, ${boards} boards, ${withdrawals} withdrawals`);
    report(`verdicts: ${JSON.stringify(histogram)}`);
    // HAND-OFF to App-B's engine bump: once SW-H1 is closed, this becomes `expect(histogram.empty_success).toBe(0)`,
    // with `expect(histogram.refusal_wrong).toBe(0)` beside it (an empty round must not turn into a wrong refusal).
    report(`empty_success = ${histogram.empty_success} ${JSON.stringify(emptySplit)} — SW-H1 in engine 1.x, printed, not asserted; App-B's bump asserts 0`);
    report(`reach: ${JSON.stringify(reach)}`);
    report(`known engine 1.x defect — a bye re-given with no bye-eligible entrant left (a refusal was owed): ${reByeWithNoEligible.length} (printed, not asserted; App-B's bump asserts 0)`);
    for (const line of notes.slice(0, 40)) report(`  stop: ${line}`);
    for (const line of illegal.slice(0, 20)) report(`  ILLEGAL: ${line}`);
    // No illegal round outside the one named defect — every other rule held on every round the engine seated.
    expect(illegal).toEqual([]);
    expect(histogram.illegal).toBe(reByeWithNoEligible.length);
    expect(rounds).toBeGreaterThan(0);
    expect(histogram.legal).toBeGreaterThan(0);
    expect(boards).toBeGreaterThan(0);
    expect(withdrawals).toBeGreaterThan(0);
    expect(Object.values(emptySplit).reduce((a, b) => a + b, 0)).toBe(histogram.empty_success);
    // The sweep reached the transitions it claims to (header): walkovers of both kinds, a walked-over pair re-paired
    // (P-A2), an odd round holding an unbyed walkover winner (P-A4), a departed entrant (P-A7), both round-1 modes.
    expect(reach.walkovers).toBeGreaterThan(0);
    expect(reach.doubleWalkovers).toBeGreaterThan(0);
    expect(reach.rePairedAfterWalkover).toBeGreaterThan(0);
    expect(reach.oddRoundsWithWalkoverWinner).toBeGreaterThan(0);
    expect(reach.oddRoundsWithNoEligible).toBeGreaterThan(0);
    expect(reach.roundsWithDeparted).toBeGreaterThan(0);
    expect(reach.round1Fold).toBeGreaterThan(0);
    expect(reach.round1RankAdjacent).toBeGreaterThan(0);
  });
});

/** §3.1 hard maximum: n − 1 rounds for an even field, n for an odd one (and none below 2 players). */
function hardMax(n: number): number {
  if (n < 2) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

/** Every unordered pair of [0, n). */
function allPairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) out.push([u, v]);
  return out;
}

/** Asserts `mate` is a matching of the graph (symmetric, on its edges) and returns its number of edges. */
function matchingSize(n: number, edges: readonly (readonly [number, number])[], mate: Int32Array): number {
  expect(mate.length).toBe(n);
  const has = new Set(edges.map(([u, v]) => (u < v ? `${u}-${v}` : `${v}-${u}`)));
  let size = 0;
  for (let i = 0; i < n; i++) {
    const j = mate[i] ?? -1;
    if (j === -1) continue;
    expect(mate[j]).toBe(i);
    expect(has.has(i < j ? `${i}-${j}` : `${j}-${i}`)).toBe(true);
    if (i < j) size++;
  }
  return size;
}

/** A small seeded PRNG for the harness (mulberry32) — reproducible from the seed printed beside each sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
