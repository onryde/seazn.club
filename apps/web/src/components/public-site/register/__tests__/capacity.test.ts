// Registration redesign B3 T12 (spec §4.1) — the capacity module: what a division card says about its places, and which cart entries
// the server will put on the waiting list. Pure functions, so every row is a plain table.
//
// Where the expected values come from (TEST-STRATEGY: never from the code under test):
//   - the card states and the ≤ 3 "few left" line: spec §4.1's table, and the owner ruling of 2026-11-13 that a division the
//     organiser set no capacity on stays quiet until it is nearly full;
//   - the cart's waiting-list verdicts: SUBMIT's own loop (registration-submit.ts, under the settings lock). For each entry in
//     cart order: a solo sign-up is never waitlisted and takes no team place; any other entry is waitlisted when
//     `taken >= hardCap`, where `taken` counts the places already held PLUS the earlier entries of this same cart that were
//     seated. `submitVerdicts` below re-states exactly that loop, and the sweep holds `cartWaitlisted` to it.
import { describe, expect, it } from "vitest";
import { capacityState, cartWaitlisted, FEW_LEFT_MAX, teamEntriesInCart, type CapacityState } from "../capacity";
import type { DivisionLike } from "../types";

type Probe = Pick<DivisionLike, "open" | "capacity" | "remaining" | "waitlisted">;
const probe = (p: Partial<Probe>): Probe => ({ open: true, capacity: null, remaining: null, ...p });

describe("capacityState — spec §4.1's table, the closed case first", () => {
  // [label, division, inCart, expected]. One place per line, so a red names the row.
  const rows: [string, Probe, number, CapacityState][] = [
    // --- closed: decided before anything about places (a closed division never reads as full, few or open) -------------------
    ["closed, nothing else set", probe({ open: false }), 0, { kind: "closed" }],
    ["closed with places left", probe({ open: false, capacity: 10, remaining: 5 }), 0, { kind: "closed" }],
    ["closed and at 0 places left is closed, not waitlist", probe({ open: false, capacity: 10, remaining: 0, waitlisted: 4 }), 0, { kind: "closed" }],
    ["closed with places left is closed whatever is in the cart", probe({ open: false, capacity: 10, remaining: 5 }), 3, { kind: "closed" }],
    // --- waitlist: open and no place left ----------------------------------------------------------------------------------
    ["open, 0 left, 3 waiting", probe({ capacity: 8, remaining: 0, waitlisted: 3 }), 0, { kind: "waitlist", waiting: 3 }],
    ["open, 0 left, nobody waiting", probe({ capacity: 8, remaining: 0, waitlisted: 0 }), 0, { kind: "waitlist", waiting: 0 }],
    ["open, 0 left, the wire carries no count: nobody waiting", probe({ capacity: 8, remaining: 0 }), 0, { kind: "waitlist", waiting: 0 }],
    ["capacity 0 is a real cap: full from the start", probe({ capacity: 0, remaining: 0 }), 0, { kind: "waitlist", waiting: 0 }],
    ["full by the plan limit with no capacity set is still full", probe({ capacity: null, remaining: 0, waitlisted: 2 }), 0, { kind: "waitlist", waiting: 2 }],
    // --- few: 1 to 3 places left, organiser capacity or not ----------------------------------------------------------------
    ["1 left (capacity set)", probe({ capacity: 8, remaining: 1 }), 0, { kind: "few", left: 1 }],
    ["2 left (capacity set)", probe({ capacity: 8, remaining: 2 }), 0, { kind: "few", left: 2 }],
    ["3 left (capacity set)", probe({ capacity: 8, remaining: 3 }), 0, { kind: "few", left: 3 }],
    ["3 left, no capacity set (the plan limit is close): the count shows", probe({ capacity: null, remaining: 3 }), 0, { kind: "few", left: 3 }],
    ["capacity 1 with its one place free", probe({ capacity: 1, remaining: 1 }), 0, { kind: "few", left: 1 }],
    // --- places: more than 3 left, and the organiser set a capacity --------------------------------------------------------
    ["4 left (capacity set)", probe({ capacity: 8, remaining: 4 }), 0, { kind: "places", left: 4 }],
    ["28 left of 32", probe({ capacity: 32, remaining: 28 }), 0, { kind: "places", left: 28 }],
    // --- uncapped: nothing to say ------------------------------------------------------------------------------------------
    ["no capacity and no plan cap", probe({}), 0, { kind: "uncapped" }],
    ["no capacity, 4 left under the plan: still quiet (the owner's ruling)", probe({ capacity: null, remaining: 4 }), 0, { kind: "uncapped" }],
    ["no capacity, 256 left under the plan: still quiet (the owner's ruling)", probe({ capacity: null, remaining: 256 }), 0, { kind: "uncapped" }],
    // --- inCart: the visitor's own entries take places from this card's count ---------------------------------------------
    ["3 left with 1 in the cart shows 2", probe({ capacity: 8, remaining: 3 }), 1, { kind: "few", left: 2 }],
    ["4 left with 1 in the cart crosses into few", probe({ capacity: 8, remaining: 4 }), 1, { kind: "few", left: 3 }],
    ["5 left with 1 in the cart is still places", probe({ capacity: 8, remaining: 5 }), 1, { kind: "places", left: 4 }],
    ["1 left with 1 in the cart: the next entry waits", probe({ capacity: 8, remaining: 1, waitlisted: 2 }), 1, { kind: "waitlist", waiting: 2 }],
    ["1 left with 5 in the cart never goes below 0", probe({ capacity: 8, remaining: 1 }), 5, { kind: "waitlist", waiting: 0 }],
    ["0 left with 2 in the cart is still waitlist", probe({ capacity: 8, remaining: 0, waitlisted: 1 }), 2, { kind: "waitlist", waiting: 1 }],
    ["no capacity, 4 left with 1 in the cart: few, because the cart brought it close", probe({ capacity: null, remaining: 4 }), 1, { kind: "few", left: 3 }],
    ["uncapped stays uncapped however many are in the cart", probe({}), 6, { kind: "uncapped" }],
  ];

  it("every row of the table", () => {
    let checked = 0;
    for (const [label, division, inCart, expected] of rows) {
      expect(capacityState(division, inCart), label).toEqual(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row was checked").toBe(rows.length);
    expect(rows.length, "anti-vacuity: the table has its rows").toBeGreaterThanOrEqual(25);
    // Every state is reached by some row — a table that never reaches `places` proves nothing about it.
    const reached = new Set(rows.map((r) => r[3].kind));
    expect([...reached].sort()).toEqual(["closed", "few", "places", "uncapped", "waitlist"]);
  });

  it("the few-left line stops at spec §4.1's 3: 3 is few, 4 is not", () => {
    expect(FEW_LEFT_MAX, "spec §4.1: 1 ≤ remaining ≤ 3").toBe(3);
    expect(capacityState(probe({ capacity: 8, remaining: 3 }), 0).kind).toBe("few");
    expect(capacityState(probe({ capacity: 8, remaining: 4 }), 0).kind).toBe("places");
  });

  it("calling it again, and after the cart changed and changed back, gives the same answer (no hidden state)", () => {
    const d = probe({ capacity: 8, remaining: 3 });
    const first = capacityState(d, 1);
    capacityState(d, 3);
    expect(capacityState(d, 1)).toEqual(first);
    expect(d, "the input is not touched").toEqual(probe({ capacity: 8, remaining: 3 }));
  });
});

describe("teamEntriesInCart — what a card subtracts from its count", () => {
  const e = (division_id: string, free_agent = false) => ({ division_id, free_agent });

  it("counts this division's team entries only: another division's and a solo sign-up take no team place here", () => {
    expect(teamEntriesInCart([], "a"), "empty cart").toBe(0);
    expect(teamEntriesInCart([e("a"), e("b"), e("a"), e("a", true)], "a")).toBe(2);
    expect(teamEntriesInCart([e("a"), e("b"), e("a"), e("a", true)], "b")).toBe(1);
    expect(teamEntriesInCart([e("a", true)], "a"), "a solo-only cart").toBe(0);
    expect(teamEntriesInCart([e("a")], "zzz"), "a division not in the cart").toBe(0);
  });
});

describe("cartWaitlisted — per entry, in cart order, the verdict submit will reach", () => {
  const e = (division_id: string, free_agent = false) => ({ division_id, free_agent });
  const left = (entries: Record<string, number | null>) => new Map(Object.entries(entries));

  it("the empty cart has no verdicts", () => {
    expect(cartWaitlisted([], left({ a: 1 }))).toEqual([]);
  });

  it("one place left and two entries: the second is waitlisted (Review Focus 2)", () => {
    expect(cartWaitlisted([e("a"), e("a")], left({ a: 1 }))).toEqual([false, true]);
  });

  it("two places left: the third entry is the one that waits, and every one after it", () => {
    expect(cartWaitlisted([e("a"), e("a"), e("a"), e("a"), e("a")], left({ a: 3 }))).toEqual([false, false, false, true, true]);
  });

  it("a full division waits every entry into it", () => {
    expect(cartWaitlisted([e("a"), e("a")], left({ a: 0 }))).toEqual([true, true]);
  });

  it("remaining null never waitlists, however many entries", () => {
    expect(cartWaitlisted([e("a"), e("a"), e("a"), e("a")], left({ a: null }))).toEqual([false, false, false, false]);
  });

  it("a division the map does not know is never waitlisted (nothing is known about its places)", () => {
    expect(cartWaitlisted([e("ghost"), e("ghost")], left({ a: 0 }))).toEqual([false, false]);
  });

  it("a solo sign-up is never waitlisted (FP2) and does not take the place the next team entry needs", () => {
    // Full division: the solo entry is still not waitlisted; submit refuses a full SOLO pool instead, never queues it.
    expect(cartWaitlisted([e("a", true)], left({ a: 0 }))).toEqual([false]);
    // One place left: team, solo, team. The solo entry takes none, so the first team entry has the place and the second waits.
    expect(cartWaitlisted([e("a"), e("a", true), e("a")], left({ a: 1 }))).toEqual([false, false, true]);
    // Same cart with the solo entry FIRST: it still takes no place.
    expect(cartWaitlisted([e("a", true), e("a"), e("a")], left({ a: 1 }))).toEqual([false, false, true]);
  });

  it("divisions count their places separately, interleaved in cart order", () => {
    expect(cartWaitlisted([e("a"), e("b"), e("a"), e("b"), e("a")], left({ a: 1, b: 2 }))).toEqual([false, false, true, false, true]);
  });

  it("cart order decides who waits: the same entries reversed give the same shape on the other end", () => {
    const first = { division_id: "a", id: "first" };
    const second = { division_id: "a", id: "second" };
    const verdictFor = (cart: { division_id: string; id: string }[]) => {
      const v = cartWaitlisted(cart, left({ a: 1 }));
      return Object.fromEntries(cart.map((c, i) => [c.id, v[i]]));
    };
    expect(verdictFor([first, second])).toEqual({ first: false, second: true });
    expect(verdictFor([second, first])).toEqual({ second: false, first: true });
  });

  it("after a sibling is removed the entries behind it move up: nobody keeps a stale 'waiting' label", () => {
    const cart = [e("a"), e("a"), e("a")];
    expect(cartWaitlisted(cart, left({ a: 2 }))).toEqual([false, false, true]);
    expect(cartWaitlisted(cart.slice(1), left({ a: 2 })), "the first entry removed").toEqual([false, false]);
    expect(cartWaitlisted(cart.slice(0, 1), left({ a: 2 })), "down to one entry").toEqual([false]);
  });

  it("the verdict list is as long as the cart, and does not touch its inputs", () => {
    const entries = [e("a"), e("a", true), e("b")];
    const remaining = left({ a: 1, b: null });
    const before = JSON.stringify([entries, [...remaining]]);
    expect(cartWaitlisted(entries, remaining)).toHaveLength(entries.length);
    expect(JSON.stringify([entries, [...remaining]])).toBe(before);
    expect(cartWaitlisted(entries, remaining), "a second call").toEqual(cartWaitlisted(entries, remaining));
  });

  // ---- the parity sweep: the client's verdicts against submit's own loop, re-stated -----------------------------------------
  /** registration-submit.ts, per entry in cart order, inside the settings lock: a solo sign-up is not waitlisted; otherwise
   *  `taken` (places held + this cart's earlier SEATED entries) `>= hardCap` waitlists it. `hardCap` null = no cap. */
  function submitVerdicts(entries: { free_agent: boolean }[], hardCap: number | null, activeBefore: number): boolean[] {
    let seatedByThisCart = 0;
    return entries.map((entry) => {
      if (entry.free_agent) return false;
      const waitlisted = hardCap !== null && activeBefore + seatedByThisCart >= hardCap;
      if (!waitlisted) seatedByThisCart += 1;
      return waitlisted;
    });
  }

  it("agrees with submit's loop for every combination of cap, places held and cart shape", () => {
    let cases = 0;
    let waited = 0;
    let seated = 0;
    const caps: (number | null)[] = [null, 0, 1, 2, 3, 5];
    const shapes: boolean[][] = [[], [false], [false, false], [false, true, false], [true, false, false, false], [false, false, false, false, false, false]];
    for (const hardCap of caps) {
      for (let active = 0; active <= 6; active += 1) {
        for (const solo of shapes) {
          const entries = solo.map((free_agent) => ({ division_id: "d", free_agent }));
          // The panel's number for this state: places left under the cap, never below 0 (settings.ts / places-left.ts).
          const remaining = hardCap === null ? null : Math.max(0, hardCap - active);
          const want = submitVerdicts(entries, hardCap, active);
          expect(cartWaitlisted(entries, new Map([["d", remaining]])), `cap ${hardCap}, ${active} held, solo flags ${JSON.stringify(solo)}`).toEqual(want);
          cases += 1;
          waited += want.filter(Boolean).length;
          seated += want.filter((w, i) => !w && !entries[i]!.free_agent).length;
        }
      }
    }
    expect(cases, "anti-vacuity: every combination ran").toBe(caps.length * 7 * shapes.length);
    expect(waited, "anti-vacuity: some entries waited").toBeGreaterThan(20);
    expect(seated, "anti-vacuity: some entries were seated").toBeGreaterThan(20);
  });
});
