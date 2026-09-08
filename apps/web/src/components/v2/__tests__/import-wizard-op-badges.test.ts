// Every op kind the import planner can emit needs a human label in the
// preview. W4 added `squad.add` to the engine and NOT to `OP_BADGE`, and
// nothing went red: an unmapped kind falls back to `op.kind`, so the preview
// simply printed a grey "squad.add" chip next to "new club" and "new player".
// It was found by looking at a screenshot.
//
// The kinds here are read off the engine's own discriminated union rather
// than typed into this file, so the next op to be added moves this test with
// it instead of leaving it asserting yesterday's list.
import { describe, expect, it } from "vitest";
import { ImportOp } from "@seazn/engine/import";
import { OP_BADGE } from "@/components/v2/import-wizard";
import en from "@/dictionaries/en/ui.json";

const KINDS = ImportOp.options.map((o) => o.shape.kind.value as string);

describe("import wizard — op badges", () => {
  it("guards the guard: the engine really does declare a non-trivial set of kinds", () => {
    // Without this an `options` that came back empty would satisfy every
    // "for each kind" assertion below by iterating nothing.
    expect(KINDS.length).toBeGreaterThan(5);
    expect(KINDS, "the kind W4 added must be in the union").toContain("squad.add");
  });

  it("every emittable op kind has a badge — no raw `kind` string reaches the preview", () => {
    const unmapped = KINDS.filter((k) => !OP_BADGE[k]);
    expect(unmapped, `these kinds would print their raw name: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("every badge's label key resolves to real copy in the dictionary", () => {
    // A mapped kind whose key is missing is the same defect one layer down:
    // the chip would render the KEY instead of the word.
    const dict = en as Record<string, string>;
    for (const kind of KINDS) {
      const key = OP_BADGE[kind]!.labelKey;
      expect(dict[key], `${kind} → ${key} has no English copy`).toBeTruthy();
    }
  });

  it("no badge maps a kind the engine cannot emit", () => {
    // The other direction: a stale entry left behind by a renamed op is dead
    // copy that reads as coverage.
    const stale = Object.keys(OP_BADGE).filter((k) => !KINDS.includes(k));
    expect(stale, `badges for kinds no longer emitted: ${stale.join(", ")}`).toEqual([]);
  });
});
