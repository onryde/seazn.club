// W4 T3 (K2; X-SD-5): `isByeLine`, the one predicate for "this row is a bye line" — a line nobody plays, so it never
// takes a court or a time. Every shape is answered by the rules (bye-line-shapes.ts says where each answer comes from);
// the SQL twin `byeLineSql` is held to the SAME table in bracket-bye-line-slot.test.ts.
import { describe, expect, it } from "vitest";
import { BYE_SLOT_LABEL, isByeLine, isWaitingByeLine } from "@/lib/bye-line";
import { BYE_LINE_SHAPES, rowOf } from "./bye-line-shapes";

const IDS = { H: "11111111-1111-4111-8111-111111111111", A: "22222222-2222-4222-8222-222222222222" };

describe("W4 T3 isByeLine (X-SD-5)", () => {
  it("the empty row first: every nullable field null is a line still waiting on its feeders, not a bye", () => {
    const empty = BYE_LINE_SHAPES[0]!;
    expect(empty.name, "the table states its empty case first").toMatch(/^the empty row/);
    expect(isByeLine(rowOf(empty, IDS))).toBe(false);
  });

  it("answers every shape the way the rules do, both ways", () => {
    let checked = 0;
    const yes: string[] = [];
    const no: string[] = [];
    for (const shape of BYE_LINE_SHAPES) {
      expect(isByeLine(rowOf(shape, IDS)), shape.name).toBe(shape.expected);
      (shape.expected ? yes : no).push(shape.name);
      checked++;
    }
    // Anti-vacuity: the whole table, and both answers represented — a predicate that always said one thing could not pass.
    expect(checked, "shapes checked").toBe(BYE_LINE_SHAPES.length);
    expect(checked).toBe(20);
    expect(yes.length, "bye lines in the table").toBe(8);
    expect(no.length, "non-bye lines in the table").toBe(12);
  });

  it("BYE_SLOT_LABEL is the stored marker: key bracket.slot.bye, no params (the label the run sheet resolves to 'Bye')", () => {
    expect(BYE_SLOT_LABEL).toEqual({ key: "bracket.slot.bye", params: {} });
  });
});

// B1a review #1: the desk's "owed a slot" count and the board's tray read a bye line the way the server's placement does.
// A bye line nobody has settled yet (`scheduled`) waits, and no one can ever schedule it (BYE_LINE_NOT_PLACEABLE), so it is
// no work owed; once settled (its award written, `forfeited`) it is an ordinary decided line. The answer is the table's
// own (`expected`) and the row's own status — never `isByeLine`'s.
describe("W4 B1a isWaitingByeLine (a bye line no one can schedule, still waiting)", () => {
  it("the empty row first: not a bye line, so not a waiting one", () => {
    expect(isWaitingByeLine(rowOf(BYE_LINE_SHAPES[0]!, IDS))).toBe(false);
  });

  it("is a bye line that is still scheduled, on every shape — and a scheduled real line or a settled bye is neither", () => {
    let waiting = 0;
    let settledByes = 0;
    let scheduledReal = 0;
    for (const shape of BYE_LINE_SHAPES) {
      const want = shape.expected && shape.status === "scheduled";
      expect(isWaitingByeLine(rowOf(shape, IDS)), shape.name).toBe(want);
      if (want) waiting++;
      else if (shape.expected) settledByes++;
      else if (shape.status === "scheduled") scheduledReal++;
    }
    // Anti-vacuity: each of the three answers is represented, or the gate on status (or on the bye) could go unwitnessed.
    expect(waiting, "waiting bye lines").toBeGreaterThan(0);
    expect(settledByes, "settled byes").toBeGreaterThan(0);
    expect(scheduledReal, "scheduled real lines").toBeGreaterThan(0);
  });
});
