// W2c P-7 / X-AB-5 (fix round 1, I1). `rowAwaitsSettle` is the stored-row reading of "owed the organiser's settle" that the
// desk, the division page and the phase share. It must agree with the engine's `settleOffered` (the predicate the server's
// settle guard and the console's block read) for every stage kind - a row the console demands a decision on must not be
// struck as a void on the run sheet. Pure (no DB): the stored row is the input, the expected values come from the rule
// (a bracket holds an abandon with no outcome or a level one; a table holds only one with no outcome; an expunge holds
// nothing) and from the engine's own kind sets, never from the function under test.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, StageKind, settleOffered } from "@seazn/engine/core";
import { abandonAwaitsSettle, rowAwaitsSettle } from "../recorded-abandon";
import { fixtureAwaitsSettle } from "@/server/usecases/competition-desk";

type Row = { status: string; outcome: unknown; has_active_abandon: boolean; expunged?: boolean };
const DRAW = { kind: "draw" };
const NO_RESULT = { kind: "no_result" };
const WIN = { kind: "win", winner: "a", loser: "b", method: "normal" };

// [name, row, held in a bracket, held in a table]. `null`: unreachable and so not asserted - a bracket's withdrawal
// WALKS OVER (withdrawal.ts), it never expunges, so the kernel's own settle precondition is the only authority there.
const ROWS: [string, Row, boolean | null, boolean][] = [
  ["abandoned, nobody decided", { status: "abandoned", outcome: null, has_active_abandon: true }, true, true],
  ["abandoned at a level no_result", { status: "abandoned", outcome: NO_RESULT, has_active_abandon: true }, true, false],
  ["abandoned at a level draw", { status: "abandoned", outcome: DRAW, has_active_abandon: true }, true, false],
  ["abandoned with a winner", { status: "abandoned", outcome: WIN, has_active_abandon: true }, false, false],
  ["the generator's void (abandoned, no ledger)", { status: "abandoned", outcome: null, has_active_abandon: false }, false, false],
  ["a withdrawal's expunge", { status: "abandoned", outcome: null, has_active_abandon: true, expunged: true }, null, false],
  ["a scheduled row", { status: "scheduled", outcome: null, has_active_abandon: false }, false, false],
  ["an in-play row with a stale abandon flag", { status: "in_play", outcome: null, has_active_abandon: true }, false, false],
  ["a decided row", { status: "decided", outcome: WIN, has_active_abandon: false }, false, false],
];

describe("rowAwaitsSettle: the stored-row reading agrees with the engine's settle offer in every stage kind", () => {
  it("empty case first: a plain scheduled row is held by no stage kind, and the two kind sets cover every kind", () => {
    const scheduled: Row = { status: "scheduled", outcome: null, has_active_abandon: false };
    let checked = 0;
    for (const kind of StageKind.options) {
      expect(rowAwaitsSettle(kind, scheduled), kind).toBe(false);
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size + DRAW_KINDS.size);
    expect(checked).toBeGreaterThan(0);
  });

  it("every kind x every row: a bracket and a table hold exactly the rows the rule says (counted, both answers reached)", () => {
    let checked = 0;
    let held = 0;
    for (const kind of StageKind.options)
      for (const [why, row, inBracket, inTable] of ROWS) {
        const want = BRACKET_KINDS.has(kind) ? inBracket : inTable;
        if (want === null) continue;
        expect(rowAwaitsSettle(kind, row), `${kind}: ${why}`).toBe(want);
        expect(fixtureAwaitsSettle(kind, row), `${kind}: ${why} (the desk's entry)`).toBe(want);
        checked++;
        if (want) held++;
      }
    expect(checked).toBe(StageKind.options.length * ROWS.length - BRACKET_KINDS.size);
    expect(held, "some rows are held").toBeGreaterThan(0);
    expect(checked - held, "some rows are not").toBeGreaterThan(0);
  });

  it("a fixture outside any stage reads as a table (the same default the console and the server guard use)", () => {
    const abandoned: Row = { status: "abandoned", outcome: null, has_active_abandon: true };
    expect(rowAwaitsSettle(null, abandoned)).toBe(true);
    expect(rowAwaitsSettle(undefined, abandoned)).toBe(true);
    expect(rowAwaitsSettle(undefined, { ...abandoned, outcome: DRAW })).toBe(false);
  });

  it("it IS the engine's settleOffered, fed the stored row: the two cannot drift (every kind x every row)", () => {
    let checked = 0;
    for (const kind of StageKind.options)
      for (const [why, row] of ROWS) {
        const offered =
          row.status === "abandoned" &&
          row.has_active_abandon &&
          settleOffered({}, kind, { outcome: row.outcome as never, abandoned: true, expunged: row.expunged === true, state: null });
        expect(rowAwaitsSettle(kind, row), `${kind}: ${why}`).toBe(offered);
        checked++;
      }
    expect(checked).toBe(StageKind.options.length * ROWS.length);
  });

  it("the bracket-only reader (bracketEngineStatus's) is unchanged: it ignores the stage and reads the bracket arm", () => {
    let checked = 0;
    for (const [why, row, inBracket] of ROWS) {
      if (inBracket === null) continue; // unreachable in a bracket (above)
      expect(abandonAwaitsSettle(row), why).toBe(inBracket);
      checked++;
    }
    expect(checked).toBe(ROWS.length - 1);
  });
});
