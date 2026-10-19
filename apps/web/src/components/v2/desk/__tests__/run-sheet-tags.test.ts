// W2c Task 19 (X-SR-2, S4) - the run sheet's "Format changed" tag: a pure decision over the row, so its killers need no
// browser. The tag reads `fixtures.rules_override is not null` (`listDivisionFixtures`, `format_changed`), never the
// stage's rules or the match's status: a match that plays its stage's format carries none.
import { describe, expect, it } from "vitest";
import { formatChangedTag } from "../run-sheet-tags";
import { messages } from "@/lib/messages";

describe("run sheet tags", () => {
  it("the run sheet tags a changed format", () => {
    const cases: readonly [string, { format_changed?: boolean | null }, string | null][] = [
      ["true", { format_changed: true }, "runSheet.formatChanged"],
      ["false", { format_changed: false }, null],
      ["null", { format_changed: null }, null],
      ["absent", {}, null],
    ];
    let checked = 0;
    for (const [name, row, want] of cases) {
      expect(formatChangedTag(row), name).toBe(want);
      checked++;
    }
    expect(checked, "all four cases ran").toBe(4);
  });

  it("the tag key is a real dictionary key with words behind it", () => {
    const key = formatChangedTag({ format_changed: true });
    expect(key).not.toBeNull();
    expect(Object.hasOwn(messages, key!)).toBe(true);
    expect(messages[key as keyof typeof messages].length).toBeGreaterThan(0);
  });

  it("a truthy non-boolean is not a changed format (the column is a boolean, a string 'false' is not one)", () => {
    expect(formatChangedTag({ format_changed: "false" as unknown as boolean })).toBeNull();
    expect(formatChangedTag({ format_changed: 1 as unknown as boolean })).toBeNull();
  });
});
