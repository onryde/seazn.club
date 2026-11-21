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
      expect(placesLeft({ capacity, planLimit, formatMax: null, active }), label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(ROWS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the plan limit binds when it is tighter: the answer differs from capacity − active", () => {
    // The regression case FP3 names, in the shape where the wrong answer (capacity alone) is a different number.
    const right = placesLeft({ capacity: 32, planLimit: 4, formatMax: null, active: 3 });
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
      expect(promotionVerdict({ capacity, planLimit, formatMax: null, active }).kind, label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(VERDICT_ROWS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("carries the numbers the refusal states, so the message never re-derives them", () => {
    expect(promotionVerdict({ capacity: 3, planLimit: 8, formatMax: null, active: 3 })).toEqual({ kind: "over_capacity", capacity: 3, active: 3 });
    expect(promotionVerdict({ capacity: 9, planLimit: 4, formatMax: null, active: 4 })).toEqual({ kind: "plan_limit", limit: 4, active: 4 });
    expect(promotionVerdict({ capacity: null, planLimit: null, formatMax: null, active: 0 })).toEqual({ kind: "ok" });
  });

  it("agrees with placesLeft: a division with places left is exactly one a promotion passes without a confirm", () => {
    let checked = 0;
    for (const [, capacity, planLimit, active] of VERDICT_ROWS) {
      const left = placesLeft({ capacity, planLimit, formatMax: null, active });
      const ok = promotionVerdict({ capacity, planLimit, formatMax: null, active }).kind === "ok";
      expect(ok, `capacity=${capacity} plan=${planLimit} active=${active}`).toBe(left === null || left > 0);
      checked += 1;
    }
    expect(checked).toBe(VERDICT_ROWS.length);
  });
});

// W5 B4 (stress F8; owner 2026-11-21): the division's FORMAT max entrants (`lib/format-max-entrants.ts`: the largest field its first
// stage can start) is the third cap, the same on every plan. Sign-up waitlists past the smallest of the three, and no confirmation
// lifts the format's: the rule, typed from the owner's brief ("clamp to the smaller of the organiser's capacity and the format
// max"), never from the functions. null = the division has no format yet, or one whose start no field bounds.
type FormatRow = [label: string, capacity: number | null, planLimit: number | null, formatMax: number | null, active: number, left: number | null, verdict: "ok" | "over_capacity" | "plan_limit" | "format_max"];

const FORMAT_ROWS: FormatRow[] = [
  // The empty case first: no format, no capacity, unlimited plan - nothing caps it.
  ["no format, no capacity, unlimited plan", null, null, null, 0, null, "ok"],
  ["the format alone caps an otherwise uncapped division", null, null, 100, 40, 60, "ok"],
  ["the format alone, one place left", null, null, 100, 99, 1, "ok"],
  ["the format alone, at its max: the next is refused for good", null, null, 100, 100, 0, "format_max"],
  ["capacity above the format's max: the format binds", 500, null, 100, 100, 0, "format_max"],
  ["capacity below the format's max: capacity binds, and a confirm can pass it", 50, null, 100, 50, 0, "over_capacity"],
  ["plan below the format's max: the plan binds", null, 64, 100, 64, 0, "plan_limit"],
  ["all three met: the format wins - no plan or confirm can pass it", 100, 100, 100, 100, 0, "format_max"],
  ["entries already past the format's max (format changed after sign-ups): full, never negative", null, null, 71, 90, 0, "format_max"],
];

describe("the format's max entrants is the third cap (W5 B4, F8)", () => {
  it("places left is min(capacity, plan limit, format max) - active, and a promotion at the format max is refused whatever else", () => {
    let checked = 0;
    for (const [label, capacity, planLimit, formatMax, active, left, verdict] of FORMAT_ROWS) {
      expect(placesLeft({ capacity, planLimit, formatMax, active }), label).toBe(left);
      expect(promotionVerdict({ capacity, planLimit, formatMax, active }).kind, label).toBe(verdict);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(FORMAT_ROWS.length);
  });

  it("carries the max and the count the refusal states", () => {
    expect(promotionVerdict({ capacity: null, planLimit: null, formatMax: 100, active: 100 })).toEqual({ kind: "format_max", max: 100, active: 100 });
  });
});
