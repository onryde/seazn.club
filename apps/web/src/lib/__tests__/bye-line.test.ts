// W4 T3 (K2; X-SD-5): `isByeLine`, the one predicate for "this row is a bye line" — a line nobody plays, so it never
// takes a court or a time. Every shape is answered by the rules (bye-line-shapes.ts says where each answer comes from);
// the SQL twin `byeLineSql` is held to the SAME table in bracket-bye-line-slot.test.ts.
import { describe, expect, it } from "vitest";
import { BYE_SLOT_LABEL, isByeLine } from "@/lib/bye-line";
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
