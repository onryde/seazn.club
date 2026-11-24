// The save door's remedy ("Pick one of ...") for a per-group take out of a FED group stage. A fed stage's field is whatever it was fed,
// not the roster, so - like the Add stage form (`addStageGroupSource`: entrants null when the source has a progression) - the options
// are bounded by the draw alone, never capped by the roster. A group stage that is NOT fed holds the roster, which caps them.
// No shape the builder offers is refused for EVERY outcome (group-take-refusal-always.test.ts), so the oracle is stood in - the one seam -
// to reach the refusal; the gate, its roster read and its fed read run for real against a fake transaction that answers the two reads.
import { describe, expect, it, vi } from "vitest";
import { groupsKoTake } from "@/lib/format-templates";
import { groupTakeWorkingCounts } from "@/lib/group-take-refusal";

vi.mock("@/lib/cross-pool-draw-risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-pool-draw-risk")>();
  // Always for the two-rule shape asked below; the real oracle for every other take (so the options are the real working counts).
  return { ...actual, crossPoolShapeAlwaysRefuses: (...a: Parameters<typeof actual.crossPoolShapeAlwaysRefuses>) => (a[2].length === 2 ? true : actual.crossPoolShapeAlwaysRefuses(...a)) };
});
import { refuseGroupTakeShape } from "../stages/group-take-gate";
import type { Tx } from "../stages/types";

/** A fake transaction: the roster read answers `roster`, the fed read answers `fed`. Anything else is a defect of the test. */
function fakeTx(roster: number, fed: boolean): Tx {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (/count\(\*\)/.test(text)) return Promise.resolve([{ n: roster }]);
    if (/progression is not null/.test(text)) return Promise.resolve([{ fed }]);
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
  return tx as unknown as Tx;
}

const progression = { sources: [{ stage: "previous", take: groupsKoTake(5, 4) }], placement: "rank_order", timing: "on_complete" } as never;
const optionsOf = async (roster: number, fed: boolean): Promise<number[]> => {
  const err = await refuseGroupTakeShape(fakeTx(roster, fed), { division_id: "d", kind: "knockout" }, progression, [{ id: "s1", kind: "group", status: "active" }], [4]).then(
    () => null,
    (e: unknown) => e as { code: string; extra?: { options?: string } },
  );
  expect(err?.code, "the premise: the stood-in oracle refuses the shape at save").toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
  return String(err!.extra?.options).split(", ").map(Number);
};

describe("refuseGroupTakeShape: the remedy's counts for a fed group source", () => {
  it("a source that is NOT fed holds the roster: no option is above it", async () => {
    const options = await optionsOf(5, false);
    expect(options.length, "anti-vacuity").toBeGreaterThan(0);
    expect(Math.max(...options)).toBeLessThanOrEqual(5);
  });

  it("a FED source is not capped by the roster (its field is what it was fed): the options are the form's, from the draw's bounds alone", async () => {
    const options = await optionsOf(5, true);
    const formCounts = groupTakeWorkingCounts("knockout", 4, null);
    expect(options.every((o) => formCounts.includes(o)), "every option is a count the form offers for this source").toBe(true);
    expect(Math.max(...options), "the roster of 5 did not cap them").toBeGreaterThan(5);
  });
});
