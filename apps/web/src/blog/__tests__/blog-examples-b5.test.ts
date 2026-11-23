// Batch 5 (Task 11): the claims of #22 to #27 have teeth. Every claim passes on its committed golden (blog-examples.test.ts
// holds that); here each one must FAIL on an empty result, and the load-bearing ones fail on a golden corrupted in the
// one way the claim exists to catch. Anti-vacuity: the counts of claims checked are asserted.
import { describe, expect, it } from "vitest";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";

const B5 = ["americano-rotation", "mexicano-next-round", "ladder-challenge", "knockout-withdrawal", "forfeit-scores", "double-walkover"] as const;
const EMPTY: ExampleResult = { facts: {}, text: [] };
const clone = (id: string): ExampleResult => JSON.parse(JSON.stringify(BLOG_GOLDENS[id]!)) as ExampleResult;
const claimsOf = (id: string) => BLOG_EXAMPLES.find((e) => e.id === id)!.claims;
const failing = (id: string, r: ExampleResult) => claimsOf(id).filter((c) => c.check(r) !== true).map((c) => c.says);

describe("batch 5 claims have teeth", () => {
  it("every claim of every batch 5 example passes on its golden and fails on an empty result", () => {
    let checked = 0;
    for (const id of B5) {
      expect(claimsOf(id).length, `${id}: claims`).toBeGreaterThan(0);
      for (const c of claimsOf(id)) {
        expect(c.check(BLOG_GOLDENS[id]!), `${id}: ${c.says}`).toBe(true);
        expect(c.check(EMPTY), `${id}: '${c.says}' passes on an empty result`).not.toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: batch 5 claims checked").toBeGreaterThanOrEqual(B5.length * 2);
  });

  it("ladder: a ladder that did not swap on a win, or a refusal inside the reach, is caught", () => {
    const noSwap = clone("ladder-challenge");
    noSwap.table!.rows[0]![3] = noSwap.table!.rows[1]![3] = "Ana, Ben, Cy, Dev, Eli, Fay";
    expect(failing("ladder-challenge", noSwap).length).toBeGreaterThan(0);
    const reach = clone("ladder-challenge");
    reach.facts.reach = 4; // a reach of 4 would have allowed the refused 4-place challenge
    expect(failing("ladder-challenge", reach).length).toBeGreaterThan(0);
  });

  it("forfeits: a football walkover shown as hockey's 5-0 is caught", () => {
    const r = clone("forfeit-scores");
    const row = r.table!.rows.find((x) => x[0] === "Football")!;
    row[1] = "5 — 0";
    r.facts.footballScore = "5 — 0";
    expect(failing("forfeit-scores", r).length).toBeGreaterThan(0);
  });

  it("double walkover: a point paid to either side is caught", () => {
    const r = clone("double-walkover");
    r.table!.rows.find((x) => x[0] === "Table tennis")![2] = 1;
    r.facts.tabletennisPoints = 1;
    expect(failing("double-walkover", r).length).toBeGreaterThan(0);
  });

  it("knockout withdrawal: a played quarter-final that changed, or a walkover to the wrong player, is caught", () => {
    const played = clone("knockout-withdrawal");
    played.table!.rows[1]![2] = "Walkover: Eli goes through";
    expect(failing("knockout-withdrawal", played).length).toBeGreaterThan(0);
    const wrong = clone("knockout-withdrawal");
    wrong.facts.opponent = "Cy";
    expect(failing("knockout-withdrawal", wrong).length).toBeGreaterThan(0);
  });
});
