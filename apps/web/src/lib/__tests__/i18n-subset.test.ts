import { describe, it, expect } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import { pickDictPrefixes } from "@/lib/i18n-subset";

// The public /scheduling demo renders the board's AI trace and conflict copy
// only — shipping the whole 196KB ui.json onto a marketing page is the thing
// this helper exists to prevent.
const PREFIXES = ["board.ai.", "board.conflict."] as const;

describe("pickDictPrefixes", () => {
  it("keeps only keys under the requested flat-key prefixes", () => {
    const dict = {
      "board.ai.trace.node.draft": "a",
      "board.conflict.court": "b",
      "pricing.title": "c",
      // Contains a prefix but does not START with it: a substring match would
      // wrongly ship this.
      "legacy.board.ai.shim": "d",
    };
    expect(pickDictPrefixes(dict, PREFIXES)).toEqual({
      "board.ai.trace.node.draft": "a",
      "board.conflict.court": "b",
    });
  });

  it("keeps the real ui.json subset under the page payload budget", () => {
    const subset = pickDictPrefixes(uiEn, PREFIXES);
    const bytes = JSON.stringify(subset).length;

    expect(bytes).toBeLessThan(40_000);
    // Floor: a filter that returned `{}` would satisfy the ceiling and read as
    // green, so pin that the real copy is actually present.
    expect(bytes).toBeGreaterThan(10_000);
    expect(Object.keys(subset)).toContain("board.ai.trace.node.draft");
    expect(Object.keys(subset).every((k) => PREFIXES.some((p) => k.startsWith(p)))).toBe(true);
  });
});
