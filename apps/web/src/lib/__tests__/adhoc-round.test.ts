// W5 app PR A, Task 3 (X-BD-6; RB5-S5) — the pure half of "Add match picks a round": which round a loose match lands in and which
// rounds the form offers. The fixtures are a hand-drawn four-team round robin (the circle method, derived on paper), never read
// from the generator under test:
//   round 1: a-b, c-d      round 2: a-c, b-d      round 3: a-d, b-c
import { describe, expect, it } from "vitest";
import { adhocRoundOptions, adhocRoundPlan, chosenAdhocRound, isOfferedRound, type AdhocRoundRow } from "../adhoc-round";

const row = (round_no: number, home: string, away: string, seats = true): AdhocRoundRow => ({ round_no, home, away, seats });
const FOUR: AdhocRoundRow[] = [row(1, "a", "b"), row(1, "c", "d"), row(2, "a", "c"), row(2, "b", "d"), row(3, "a", "d"), row(3, "b", "c")];
/** The same table with some lines voided: `without(["1:a-b"])`. */
const voided = (keys: string[]): AdhocRoundRow[] => FOUR.map((r) => (keys.includes(`${r.round_no}:${r.home}-${r.away}`) ? { ...r, seats: false } : r));

describe("X-BD-6: the round an added match defaults to (adhocRoundPlan)", () => {
  it("an empty stage has no round yet: the first round is the new round, and the only choice", () => {
    const plan = adhocRoundPlan([], "a", "b");
    expect(plan.newRound).toBe(1);
    expect(plan.suggested).toBe(1);
    expect(plan.choices).toEqual([{ round_no: 1, kind: "new" }]);
  });

  it("a full table seats both sides in every round, so the match goes in a new round after the last", () => {
    const plan = adhocRoundPlan(FOUR, "a", "b");
    expect(plan.newRound).toBe(4);
    expect(plan.suggested).toBe(4); // differential: the same as main's max + 1 (nothing is free)
    expect(plan.choices.map((c) => c.kind)).toEqual(["new", "clash", "clash", "clash"]);
  });

  it("a voided a-b match leaves both sides free in its round: the match goes back there, not round 4", () => {
    const plan = adhocRoundPlan(voided(["1:a-b"]), "a", "b");
    expect(plan.suggested).toBe(1); // differential: main said round 4 (max + 1)
    expect(plan.choices.find((c) => c.round_no === 1)).toEqual({ round_no: 1, kind: "free" });
    expect(isOfferedRound(plan, 1)).toBe(true);
  });

  it("two free rounds: the LATEST wins, not the earliest", () => {
    // round 1: a-b voided (both free); round 2: a-c and b-d voided (both free); round 3 still seats both.
    const plan = adhocRoundPlan(voided(["1:a-b", "2:a-c", "2:b-d"]), "a", "b");
    const free = plan.choices.filter((c) => c.kind === "free").map((c) => c.round_no);
    expect(free.sort()).toEqual([1, 2]);
    expect(plan.suggested).toBe(2);
  });

  it("a round where only ONE side is free is not free: both sides must be", () => {
    const plan = adhocRoundPlan(voided(["2:a-c"]), "a", "b"); // a is free in round 2, b still plays d
    expect(plan.choices.find((c) => c.round_no === 2)).toEqual({ round_no: 2, kind: "clash", entrantId: "b", opponentId: "d" });
    expect(plan.suggested).toBe(4);
    expect(isOfferedRound(plan, 2)).toBe(false);
  });

  it("the roundDefault `append` (the quick-match decider's rule) ignores a free round and takes max + 1", () => {
    const plan = adhocRoundPlan(voided(["1:a-b"]), "a", "b", "append");
    expect(plan.suggested).toBe(4);
    // the free round is still OFFERED: `append` changes the default only
    expect(isOfferedRound(plan, 1)).toBe(true);
  });

  it("a line with an empty side (a TBD seat) seats nobody it does not name", () => {
    const rows: AdhocRoundRow[] = [{ round_no: 1, home: "c", away: null, seats: true }, row(2, "a", "b")];
    const plan = adhocRoundPlan(rows, "a", "b");
    expect(plan.choices.find((c) => c.round_no === 1)).toEqual({ round_no: 1, kind: "free" });
    expect(plan.suggested).toBe(1);
  });

  it("names the side that plays and who it plays: the home side first, else the away side", () => {
    const plan = adhocRoundPlan(FOUR, "a", "b");
    expect(plan.choices.find((c) => c.round_no === 3)).toEqual({ round_no: 3, kind: "clash", entrantId: "a", opponentId: "d" });
    const awayOnly = adhocRoundPlan(voided(["2:a-c"]), "a", "b");
    expect(awayOnly.choices.find((c) => c.round_no === 2)).toMatchObject({ kind: "clash", entrantId: "b", opponentId: "d" });
    // the two sides playing EACH OTHER: the reason names the opponent that is the other side
    expect(plan.choices.find((c) => c.round_no === 1)).toEqual({ round_no: 1, kind: "clash", entrantId: "a", opponentId: "b" });
  });

  it("anti-vacuity: every round 1..max is classified exactly once", () => {
    let checked = 0;
    for (const rows of [FOUR, voided(["1:a-b"]), voided(["1:a-b", "2:a-c", "2:b-d"]), []]) {
      const plan = adhocRoundPlan(rows, "a", "b");
      const max = rows.reduce((m, r) => Math.max(m, r.round_no), 0);
      expect(plan.choices.map((c) => c.round_no)).toEqual(Array.from({ length: max + 1 }, (_, i) => max + 1 - i));
      checked += plan.choices.length;
    }
    expect(checked).toBe(4 + 4 + 4 + 1); // 3 rounds + the new one, three times; the empty stage has only the new one
  });
});

describe("X-BD-6: the select's lines (adhocRoundOptions)", () => {
  /** A league of `n` rounds where `a` plays everyone: `a` plays "x{r}" in round r. */
  const busy = (n: number): AdhocRoundRow[] => Array.from({ length: n }, (_, i) => row(i + 1, "a", `x${i + 1}`));

  it("a run of three unselectable rounds lists each with its reason", () => {
    const opts = adhocRoundOptions(adhocRoundPlan(busy(3), "a", "b"));
    expect(opts.map((o) => o.kind)).toEqual(["new", "clash", "clash", "clash"]);
    expect(opts[0]).toEqual({ kind: "new", round_no: 4, suggested: true });
  });

  it("a longer run lists the newest two and folds the rest into one range, as the R24 mock draws it", () => {
    const opts = adhocRoundOptions(adhocRoundPlan(busy(5), "a", "b"));
    expect(opts).toEqual([
      { kind: "new", round_no: 6, suggested: true },
      { kind: "clash", round_no: 5, entrantId: "a", opponentId: "x5" },
      { kind: "clash", round_no: 4, entrantId: "a", opponentId: "x4" },
      { kind: "clashRange", from: 1, to: 3 },
    ]);
  });

  it("a free round between two runs splits them: each run folds on its own", () => {
    // a plays rounds 1-5 and 7-11; round 6 is free for a and b.
    const rows = [...busy(5), ...Array.from({ length: 5 }, (_, i) => row(7 + i, "a", `y${i}`)), row(6, "c", "d")];
    const opts = adhocRoundOptions(adhocRoundPlan(rows, "a", "b"));
    expect(opts.map((o) => (o.kind === "clashRange" ? `range ${o.from}-${o.to}` : `${o.kind} ${o.round_no}`))).toEqual([
      "new 12",
      "clash 11",
      "clash 10",
      "range 7-9",
      "free 6",
      "clash 5",
      "clash 4",
      "range 1-3",
    ]);
    expect(opts.find((o) => o.kind === "free")).toMatchObject({ suggested: true });
  });

  it("no unselectable round, no range", () => {
    expect(adhocRoundOptions(adhocRoundPlan([], "a", "b"))).toEqual([{ kind: "new", round_no: 1, suggested: true }]);
  });
});

describe("X-BD-6: the round the form holds (chosenAdhocRound)", () => {
  it("no pick: the suggested round; a pick the match may go in: that pick", () => {
    const plan = adhocRoundPlan(voided(["1:a-b", "2:a-c", "2:b-d"]), "a", "b"); // free: 1, 2; suggested 2
    expect(chosenAdhocRound(plan, null)).toBe(2);
    expect(chosenAdhocRound(plan, 1)).toBe(1);
    expect(chosenAdhocRound(plan, 4)).toBe(4); // the new round is offered
  });

  it("a pick the match may NOT go in (a round where a side plays, or one that does not exist) falls back to the suggested round", () => {
    const plan = adhocRoundPlan(voided(["1:a-b"]), "a", "b"); // free: 1; suggested 1; rounds 2, 3 clash
    expect(chosenAdhocRound(plan, 3)).toBe(1); // a pick made for another pair of sides no longer holds
    expect(chosenAdhocRound(plan, 9)).toBe(1);
  });
});
