// Per-format field size (W1-driving Task 2, folded in beneath ruling 49).
// Empty case first: a scenario that seeds its own field is refused by name.
// Expected values come from the ENGINE's own bracket generators
// (generatePagePlayoff accepts exactly one size; generateStepladder takes any),
// never from field-size.ts.
import { generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import { NoFieldSize, fieldSizeFor } from "../lib/field-size.ts";
import { templateField } from "../lib/templates.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
/** The page playoff field, from the ENGINE: every n in 2..16 it accepts. */
const pagePlayoffAccepts = (): number[] => ids(16).map((_, i) => i + 1).filter((n) => n >= 2).filter((n) => {
  try { generatePagePlayoff({ entrants: ids(n) }); return true; } catch { return false; }
});

/** Carry m2-1 (W1-driving Task 13): the rows whose catalogue bodies are one
 *  page-playoff stage, read from the catalogue (stagesForRow) — never a row
 *  name typed here, and never field-size.ts's own table. */
const lonePagePlayoff = (): RowKey[] => ROW_KEYS.filter((r) => { const b = stagesForRow(r); return b.length === 1 && b[0]!.kind === "page_playoff"; });

describe("fieldSizeFor", () => {
  it("empty case first: DENIED and PADPROOF have their own fields and are refused by name", () => {
    expect(() => fieldSizeFor("league", "DENIED")).toThrow(NoFieldSize);
    expect(() => fieldSizeFor("league", "PADPROOF")).toThrow(NoFieldSize);
    try { fieldSizeFor("page_playoff_only", "PADPROOF"); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(NoFieldSize);
      expect(e).toMatchObject({ row: "page_playoff_only", scenario: "PADPROOF" });
    }
  });
  it("page_playoff_only seeds exactly the one size the engine's page playoff accepts", () => {
    const accepted = pagePlayoffAccepts();
    expect(accepted.length, "the engine accepts exactly one page-playoff size").toBe(1);
    for (const s of ["LIFECYCLE", "M1", "R4"] as const) expect(fieldSizeFor("page_playoff_only", s)).toBe(accepted[0]);
  });
  it("F1 on page_playoff_only is unfit: an odd field cannot enter a fixed-size bracket", () => {
    expect(() => fieldSizeFor("page_playoff_only", "F1")).toThrow(/odd field/);
    expect(() => fieldSizeFor("page_playoff_only", "F1")).toThrow(NoFieldSize);
    // The premise, from the engine: its page playoff refuses the odd field every other row seeds.
    expect(pagePlayoffAccepts().every((n) => n % 2 === 0)).toBe(true);
  });
  it("m2-1: the fixed field is the CATALOGUE's lone page playoff — exactly the rows whose bodies are one page_playoff stage take the engine's size", () => {
    const fixed = lonePagePlayoff();
    expect(fixed.length, "rows whose catalogue bodies are one page_playoff stage").toBeGreaterThan(0);
    const accepted = pagePlayoffAccepts()[0]!;
    for (const row of fixed) expect(fieldSizeFor(row, "LIFECYCLE"), row).toBe(accepted);
    // The witness: today that is page_playoff_only alone (the name is the catalogue's answer, not field-size.ts's key).
    expect(fixed).toEqual(["page_playoff_only"]);
  });
  it("every other row keeps 8 / 7, and the engine's stepladder takes the 8 (a differing case: 8 ≠ 4)", () => {
    let checked = 0;
    const fixed = new Set<string>(lonePagePlayoff());
    for (const row of ROW_KEYS.filter((r) => !fixed.has(r))) {
      expect(fieldSizeFor(row, "LIFECYCLE"), row).toBe(8);
      expect(fieldSizeFor(row, "M1"), row).toBe(8);
      expect(fieldSizeFor(row, "R4"), row).toBe(8);
      expect(fieldSizeFor(row, "F1"), row).toBe(7);
      expect(fieldSizeFor(row, "F1") % 2).toBe(1);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length - fixed.size);
    expect(checked).toBeGreaterThan(0);
    expect(generateStepladder({ entrants: ids(fieldSizeFor("stepladder_only", "LIFECYCLE")) }).fixtures.length).toBe(7);
  });
  it("a second call answers the same (pure)", () => {
    expect(fieldSizeFor("page_playoff_only", "R4")).toBe(fieldSizeFor("page_playoff_only", "R4"));
    expect(fieldSizeFor("league", "F1")).toBe(fieldSizeFor("league", "F1"));
    expect(fieldSizeFor("group_only", "LIFECYCLE", "box-league")).toBe(fieldSizeFor("group_only", "LIFECYCLE", "box-league"));
  });
});

// D11 (W1-driving Task 13): a template cell seeds the template's own field,
// read from the catalog JSON (templateField) — never a count typed here.
describe("fieldSizeFor on a template cell (D11)", () => {
  it("fieldSizeFor on a template cell is the template's own entrantCount (D11), which differs from the default 8", () => {
    expect(fieldSizeFor("group_only", "LIFECYCLE", "box-league")).toBe(templateField("box-league").entrantCount);
    expect(fieldSizeFor("group_only", "LIFECYCLE", "box-league")).not.toBe(fieldSizeFor("group_only", "LIFECYCLE"));
  });
  it("LIFECYCLE, M1 and R4 on both template cells take the template's count; the witness is 16 on each (Step 0 anchors)", () => {
    let checked = 0;
    for (const [row, key] of [["group_only", "box-league"], ["group_group_ko", "t20-super8"]] as const) {
      for (const s of ["LIFECYCLE", "M1", "R4"] as const) {
        expect(fieldSizeFor(row, s, key), `${row} ${s} ${key}`).toBe(templateField(key).entrantCount);
        checked++;
      }
      expect(templateField(key).entrantCount).toBe(16);
    }
    expect(checked).toBe(6);
  });
  it("F1 on a template is refused by name: the template seeds its own count, and an odd field is not it", () => {
    expect(() => fieldSizeFor("group_only", "F1", "box-league")).toThrow(NoFieldSize);
    expect(() => fieldSizeFor("group_only", "F1", "box-league")).toThrow(/box-league/);
    // A scenario that seeds its own field is refused with or without a template.
    expect(() => fieldSizeFor("group_only", "PADPROOF", "box-league")).toThrow(NoFieldSize);
  });
  it("a template that does not build the row is refused by name, never answered with its count", () => {
    expect(() => fieldSizeFor("group_group_ko", "LIFECYCLE", "box-league")).toThrow(NoFieldSize);
    expect(() => fieldSizeFor("group_group_ko", "LIFECYCLE", "box-league")).toThrow(/box-league builds group_only/);
    expect(() => fieldSizeFor("league", "LIFECYCLE", "t20-super8")).toThrow(NoFieldSize);
  });
  it("an unknown template is refused by name", () => {
    expect(() => fieldSizeFor("group_only", "LIFECYCLE", "no-such-template")).toThrow(/no-such-template/);
  });
});
