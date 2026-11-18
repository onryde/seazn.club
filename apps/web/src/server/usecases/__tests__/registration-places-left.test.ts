// Registration redesign B3 T11 (spec §4.1, false premise FP3): the public register panel's "places left" used the
// division's capacity alone, while submit waitlists against min(capacity, plan entrant limit). A division under its
// capacity but at its plan limit showed places left, then waitlisted the entry. `placesLeft` is the panel's count; this
// table pins it to the spec's rule, typed from the rule itself (never from the function):
//
//   hardCap   = min(capacity ?? ∞, planLimit ?? ∞)
//   remaining = hardCap is ∞ ? null : max(0, hardCap − active)
//
// Pure, no DB. The DB-backed sequence (submit, withdrawal, promotion, solo sign-up) is registration-public-info.test.ts.
// Another sport: N/A — registration capacity is sport-agnostic.
import { describe, expect, it } from "vitest";
import { placesLeft, promotionVerdict } from "../registrations/places-left";

type Row = [label: string, capacity: number | null, planLimit: number | null, active: number, want: number | null];

const ROWS: Row[] = [
  // The empty case first: no cap anywhere is "no count", not 0 and not ∞.
  ["no capacity, unlimited plan, nobody in", null, null, 0, null],
  ["no capacity, unlimited plan, entries in", null, null, 7, null],
  ["capacity only", 10, null, 3, 7],
  ["plan limit only (capacity unset is not unlimited under a finite plan)", null, 64, 3, 61],
  ["plan tighter than capacity, one place left", 32, 4, 3, 1],
  ["plan tighter than capacity, at the limit", 32, 4, 4, 0],
  ["capacity tighter than plan", 2, 256, 1, 1],
  ["capacity equals plan, full", 4, 4, 4, 0],
  // A plan lowered (downgrade, expired pass, staff cap) under the entries already in: full, never negative.
  ["plan lowered below the entries already in", 32, 4, 6, 0],
  // 0 is a real cap on either side, never "unset" — a `||` in place of `??` would read both as uncapped.
  ["capacity 0 is a real cap", 0, null, 0, 0],
  ["plan limit 0 is a real cap (getLimit answers 0 when no plan row grants the key)", null, 0, 0, 0],
];

describe("placesLeft — the public count uses submit's cap (registration redesign B3 T11)", () => {
  it("follows min(capacity, plan limit) − active, null only when neither caps, never below 0", () => {
    let checked = 0;
    for (const [label, capacity, planLimit, active, want] of ROWS) {
      expect(placesLeft({ capacity, planLimit, active }), label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(ROWS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the plan limit binds when it is tighter: the answer differs from capacity − active", () => {
    // The regression case FP3 names, in the shape where the wrong answer (capacity alone) is a different number.
    const right = placesLeft({ capacity: 32, planLimit: 4, active: 3 });
    expect(right).toBe(1);
    expect(right).not.toBe(32 - 3);
  });
});

// Item 1 (registration defects, 2026-11-18): an ORGANISER's manual promotion off the waitlist. The rule, typed from the owner's
// brief, never from the function: promoting adds ONE team place, so it is past the PLAN's per-division limit when
// active >= planLimit (always refused), and past the division's OWN capacity when active >= capacity (refused unless the
// organiser confirms). null = unset / unlimited; 0 is a real cap. The plan outranks capacity when both are met.
type VerdictRow = [label: string, capacity: number | null, planLimit: number | null, active: number, want: "ok" | "over_capacity" | "plan_limit"];

const VERDICT_ROWS: VerdictRow[] = [
  // The empty case first: nothing caps the division, however many are in.
  ["no capacity, unlimited plan, nobody in", null, null, 0, "ok"],
  ["no capacity, unlimited plan, many in", null, null, 500, "ok"],
  ["under capacity", 3, null, 2, "ok"],
  ["exactly at capacity: the next one is OVER it", 3, null, 3, "over_capacity"],
  ["already over capacity", 3, null, 5, "over_capacity"],
  ["capacity 0 is a real cap", 0, null, 0, "over_capacity"],
  ["blank capacity, plan limit one place left", null, 4, 3, "ok"],
  ["blank capacity, at the plan limit: refused for good", null, 4, 4, "plan_limit"],
  ["blank capacity, over the plan limit (plan lowered under entries)", null, 4, 6, "plan_limit"],
  ["plan limit 0 is a real cap", null, 0, 0, "plan_limit"],
  ["capacity tighter than plan, at capacity: confirmable", 2, 256, 2, "over_capacity"],
  ["plan tighter than capacity, at the plan limit: not confirmable", 32, 4, 4, "plan_limit"],
  ["both met: the plan wins, no confirm can pass it", 4, 4, 4, "plan_limit"],
  ["over capacity but still under the plan limit: confirmable", 2, 256, 9, "over_capacity"],
];

describe("promotionVerdict — an organiser's manual promotion (registration defects item 1)", () => {
  it("follows the plan-then-capacity rule over every row", () => {
    let checked = 0;
    for (const [label, capacity, planLimit, active, want] of VERDICT_ROWS) {
      expect(promotionVerdict({ capacity, planLimit, active }).kind, label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(VERDICT_ROWS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("carries the numbers the refusal states, so the message never re-derives them", () => {
    expect(promotionVerdict({ capacity: 3, planLimit: 8, active: 3 })).toEqual({ kind: "over_capacity", capacity: 3, active: 3 });
    expect(promotionVerdict({ capacity: 9, planLimit: 4, active: 4 })).toEqual({ kind: "plan_limit", limit: 4, active: 4 });
    expect(promotionVerdict({ capacity: null, planLimit: null, active: 0 })).toEqual({ kind: "ok" });
  });

  it("agrees with placesLeft: a division with places left is exactly one a promotion passes without a confirm", () => {
    let checked = 0;
    for (const [, capacity, planLimit, active] of VERDICT_ROWS) {
      const left = placesLeft({ capacity, planLimit, active });
      const ok = promotionVerdict({ capacity, planLimit, active }).kind === "ok";
      expect(ok, `capacity=${capacity} plan=${planLimit} active=${active}`).toBe(left === null || left > 0);
      checked += 1;
    }
    expect(checked).toBe(VERDICT_ROWS.length);
  });
});
