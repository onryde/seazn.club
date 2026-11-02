// Match Day PB1 (owner 2026-11-02): a finished stage is one line and a finished round is one bar. The two decisions are pure and live
// here: `stageCardCollapse` (the stage card) and `roundStartsCollapsed` (a round bar of a league / group / Swiss / Americano stage).
// Expected values come from the app's own status declarations (`FIXTURE_STATUSES`, `SETTLED_FIXTURE_STATUSES`,
// `LOCKED_FIXTURE_STATUSES`), never from a list typed here. The empty case is stated FIRST in each block (TEST-STRATEGY: the empty
// set answers yes to "is everything done?" and would collapse a card over nothing). Every sweep reports its count.
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "../fixture-status";
import { latchedOpen, roundDone, roundStartsCollapsed, type RunSheetInput } from "../run-sheet-groups";
import { stageCardCollapse } from "../stage-card/summaries";

function fx(over: Partial<RunSheetInput["fixtures"][number]> = {}) {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-09-03T14:00:00.000Z",
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "h1",
    away_entrant_id: "a1",
    home_slot_label: null,
    away_slot_label: null,
    ...over,
  };
}
const BYE = fx({ id: "bye", fixture_no: 99, away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "h1", loser: null, reason: "bye" } });
const isSettled = (s: string) => SETTLED_FIXTURE_STATUSES.has(s) || LOCKED_FIXTURE_STATUSES.has(s);

describe("roundStartsCollapsed - a round bar starts folded only when every real match in it is settled", () => {
  it("the empty case first: a round with no rows, or only byes, is NOT finished (nothing to fold)", () => {
    expect(roundStartsCollapsed([], new Set())).toBe(false);
    expect(roundStartsCollapsed([BYE], new Set())).toBe(false);
  });

  it("every status the schema has, alone in its round: folded exactly when the app declares it settled", () => {
    let folded = 0;
    let open = 0;
    for (const status of FIXTURE_STATUSES) {
      const want = isSettled(status);
      expect(roundStartsCollapsed([fx({ status })], new Set()), status).toBe(want);
      if (want) folded++;
      else open++;
    }
    expect(folded + open, "anti-vacuity: every status was swept").toBe(FIXTURE_STATUSES.length);
    expect(folded, "both answers are reached").toBeGreaterThan(0);
    expect(open, "both answers are reached").toBeGreaterThan(0);
  });

  it("one open match keeps the round open, whichever status it is open in, and a bye changes nothing either way", () => {
    const settledRows = FIXTURE_STATUSES.filter(isSettled).map((status, i) => fx({ id: `s${i}`, fixture_no: i + 1, status }));
    expect(roundStartsCollapsed(settledRows, new Set()), "premise: all settled folds").toBe(true);
    expect(roundStartsCollapsed([...settledRows, BYE], new Set()), "a bye in the round does not unfold it").toBe(true);
    let checked = 0;
    for (const status of FIXTURE_STATUSES.filter((s) => !isSettled(s))) {
      expect(roundStartsCollapsed([...settledRows, fx({ id: "open", fixture_no: 50, status })], new Set()), status).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: at least one open status").toBeGreaterThan(0);
  });

  it("the sequence: the last match of the round settles and the round folds; a held settle keeps it open until the verdict", () => {
    const first = fx({ id: "a", fixture_no: 1, status: "decided", outcome: { kind: "win", winner: "h1" } });
    expect(roundStartsCollapsed([first, fx({ id: "b", fixture_no: 2, status: "in_play" })], new Set()), "one still in play").toBe(false);
    expect(roundStartsCollapsed([first, fx({ id: "b", fixture_no: 2, status: "decided", outcome: { kind: "win", winner: "h1" } })], new Set()), "it settled").toBe(true);
    const abandoned = fx({ id: "ab", fixture_no: 2, status: "abandoned" });
    expect(roundStartsCollapsed([first, abandoned], new Set(["ab"])), "abandoned but its verdict is owed").toBe(false);
    expect(roundStartsCollapsed([first, abandoned], new Set()), "the verdict is in").toBe(true);
  });

  it("agrees with the bar's own words: it folds exactly when 'N of M done' reads M of M (M > 0)", () => {
    let checked = 0;
    for (const rows of [[], [BYE], [fx({ status: "scheduled" })], [fx({ status: "decided", outcome: { kind: "win", winner: "h1" } })], [fx({ status: "cancelled" }), fx({ id: "x", fixture_no: 2 })]]) {
      const { done, total } = roundDone(rows, new Set());
      expect(roundStartsCollapsed(rows, new Set())).toBe(total > 0 && done === total);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("stageCardCollapse - a stage card folds to one line only when it is complete, has real matches, and nothing on it wants a person", () => {
  const base = { status: "complete", realMatches: 6, openMatches: 0, attention: false, panelOpen: false };

  it("the empty case first: a completed stage with no real matches has nothing to fold - no toggle, open", () => {
    expect(stageCardCollapse({ ...base, realMatches: 0 })).toEqual({ collapsible: false, startsOpen: true });
  });

  it("the status table: only complete is collapsible, and only complete starts folded", () => {
    const out: Record<string, { collapsible: boolean; startsOpen: boolean }> = {};
    for (const status of ["pending", "active", "complete"]) out[status] = stageCardCollapse({ ...base, status });
    expect(out).toEqual({
      pending: { collapsible: false, startsOpen: true },
      active: { collapsible: false, startsOpen: true },
      complete: { collapsible: true, startsOpen: false },
    });
  });

  it("each reason to look keeps a completed card open - and keeps its toggle", () => {
    const reasons: [string, Partial<typeof base>][] = [
      ["a match still open", { openMatches: 1 }],
      ["a warning the page hands in (attention)", { attention: true }],
      ["a settings panel already open on it", { panelOpen: true }],
    ];
    for (const [name, over] of reasons) {
      expect(stageCardCollapse({ ...base, ...over }), name).toEqual({ collapsible: true, startsOpen: true });
    }
    expect(reasons.length, "anti-vacuity").toBe(3);
    // The same three together, and the control that proves each flag is its own reason (the others false above).
    expect(stageCardCollapse({ ...base, openMatches: 2, attention: true, panelOpen: true }).startsOpen).toBe(true);
  });

  it("an unknown status is not complete: a typo never folds a card", () => {
    expect(stageCardCollapse({ ...base, status: "completed" })).toEqual({ collapsible: false, startsOpen: true });
    expect(stageCardCollapse({ ...base, status: "" })).toEqual({ collapsible: false, startsOpen: true });
  });
});

// Controller ruling 2 (2026-11-02): the default is decided the FIRST time a round or a card is seen, and afterwards only ever moves toward
// open - a thing that finishes while the person is looking never folds under them; something that comes back to want them opens it.
describe("latchedOpen: the default a round bar / stage card keeps for the visit", () => {
  it("the empty case first: nothing latched yet - the default of the moment, either way", () => {
    expect(latchedOpen(undefined, true)).toBe(true);
    expect(latchedOpen(undefined, false)).toBe(false);
  });

  it("the whole table: a latched OPEN never folds; a latched FOLD opens only when the default says open", () => {
    const rows: [boolean, boolean, boolean][] = [
      // latched, startsOpenNow, expected
      [true, false, true], // finished during the visit: stays open (ruling 2)
      [true, true, true],
      [false, false, false], // folded at load, still finished: stays folded
      [false, true, true], // folded at load, a void / a warning wants the person: opens (the safe direction)
    ];
    for (const [latched, now, want] of rows) expect(latchedOpen(latched, now), `${latched}/${now}`).toBe(want);
    expect(rows.length, "anti-vacuity: every pair of the two booleans").toBe(4);
  });
});
