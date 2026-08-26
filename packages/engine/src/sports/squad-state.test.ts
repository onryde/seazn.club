// R4 defect 2 (MEDIUM, code review) — `pairOrderOf` filtered `role ===
// "player"` but not on-field status, so a bench member carrying a declared
// `pairOrder` (the lineup editor renders that select on every row, bench
// included) joined the rotation as a THIRD player. `expectedPairServer`'s
// `turn % order.length` then cycles through three people instead of two,
// naming the bench player as due to serve on every third turn — an
// authoritative-looking wrong answer, since the pad shows no pip beside any
// on-field player when that happens.
//
// Built on the real `initSquads`, not a hand-rolled `SquadMember`, so the
// fixture can never drift from what a real fold actually produces.
import { describe, expect, it } from "vitest";
import { initSquads } from "../core/lineup.ts";
import type { LineupPair } from "../core/types.ts";
import { expectedPairServer, expectedPairServerOf, pairOrderOf } from "./squad-state.ts";

/** Two on-field players, declared order first-named first — `orderNo` runs
 *  the OTHER way (matches `nested/lineup.test.ts`'s own fixture), so a
 *  reader that quietly used `orderNo` instead of `pairOrder` gets caught. */
const doublesPair: LineupPair["home"] = {
  entrantId: "H",
  slots: [
    { personId: "H-second", slot: "starting", orderNo: 1, pairOrder: 2 },
    { personId: "H-first", slot: "starting", orderNo: 2, pairOrder: 1 },
  ],
};

/** The same pair, plus a THIRD, benched player whose row also carries a
 *  declared `pairOrder` — the exact shape `lineup-editor.tsx` can produce
 *  by rendering the pair-order select on a bench row. */
const withBenchPairOrder: LineupPair["home"] = {
  ...doublesPair,
  slots: [...doublesPair.slots, { personId: "H-bench", slot: "bench", orderNo: 3, pairOrder: 1 }],
};

describe("pairOrderOf", () => {
  it("orders a declared pair first-named first (baseline, no bench involved)", () => {
    const { home } = initSquads({ home: doublesPair, away: doublesPair });
    expect(pairOrderOf(home)).toEqual(["H-first", "H-second"]);
  });

  it("excludes a bench member even when it declares a pairOrder", () => {
    const { home } = initSquads({ home: withBenchPairOrder, away: doublesPair });
    const bench = home.members.find((m) => m.personId === "H-bench");
    expect(bench?.onField).toBe(false); // sanity — never took the field
    expect(bench?.pairOrder).toBe(1); // sanity — the bad row's fact still reaches State

    // Today's code returns all THREE (H-first, H-bench, H-second) here,
    // because the filter never checks `onField` — the defect this test pins.
    expect(pairOrderOf(home)).toEqual(["H-first", "H-second"]);
  });
});

describe("expectedPairServer / expectedPairServerOf", () => {
  it("cycles only the two on-field partners, never the bench", () => {
    const { home } = initSquads({ home: withBenchPairOrder, away: doublesPair });
    expect(expectedPairServer(home, 0)).toBe("H-first");
    expect(expectedPairServer(home, 1)).toBe("H-second");
    // Turn 1 is where a 3-length rotation would name "H-bench" instead.
    expect(expectedPairServer(home, 2)).toBe("H-first"); // cycles back to 2, not 3
  });

  it("expectedPairServerOf answers the same way through the State-shaped wrapper", () => {
    const squads = initSquads({ home: withBenchPairOrder, away: doublesPair });
    expect(expectedPairServerOf(squads, "home", 1)).toBe("H-second");
  });
});
