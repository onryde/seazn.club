// Per-format field size (W1-driving Task 2, folded in beneath ruling 49).
// Empty case first: a scenario that seeds its own field is refused by name.
// Expected values come from the ENGINE's own bracket generators
// (generatePagePlayoff accepts exactly one size; generateStepladder takes any),
// never from field-size.ts.
import { generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";
import { describe, expect, it } from "vitest";
import { ROW_KEYS } from "../lib/catalogue.ts";
import { NoFieldSize, fieldSizeFor } from "../lib/field-size.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
/** The page playoff field, from the ENGINE: every n in 2..16 it accepts. */
const pagePlayoffAccepts = (): number[] => ids(16).map((_, i) => i + 1).filter((n) => n >= 2).filter((n) => {
  try { generatePagePlayoff({ entrants: ids(n) }); return true; } catch { return false; }
});

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
  it("every other row keeps 8 / 7, and the engine's stepladder takes the 8 (a differing case: 8 ≠ 4)", () => {
    let checked = 0;
    for (const row of ROW_KEYS.filter((r) => r !== "page_playoff_only")) {
      expect(fieldSizeFor(row, "LIFECYCLE"), row).toBe(8);
      expect(fieldSizeFor(row, "M1"), row).toBe(8);
      expect(fieldSizeFor(row, "R4"), row).toBe(8);
      expect(fieldSizeFor(row, "F1"), row).toBe(7);
      expect(fieldSizeFor(row, "F1") % 2).toBe(1);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length - 1);
    expect(checked).toBeGreaterThan(0);
    expect(generateStepladder({ entrants: ids(fieldSizeFor("stepladder_only", "LIFECYCLE")) }).fixtures.length).toBe(7);
  });
  it("a second call answers the same (pure)", () => {
    expect(fieldSizeFor("page_playoff_only", "R4")).toBe(fieldSizeFor("page_playoff_only", "R4"));
    expect(fieldSizeFor("league", "F1")).toBe(fieldSizeFor("league", "F1"));
  });
});
