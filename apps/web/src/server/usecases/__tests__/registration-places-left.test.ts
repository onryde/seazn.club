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
import { placesLeft } from "../registrations/places-left";

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
