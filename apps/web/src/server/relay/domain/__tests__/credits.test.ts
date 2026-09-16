// The credits value object (design §5.2; FS10 kept by owner ruling 1 —
// `debit` refuses a negative in MEMORY, before the row lock and the CHECK
// ever see it). C3's arithmetic is pure here so the differential is a
// millisecond test, and Task 10's DB test proves the SAME function is wired.
import { describe, expect, it } from "vitest";
import { CREDIT_REUSE_HOURS } from "../../config";
import { InsufficientCredits, credit, debit, headroomAfterReservations, withinReuseWindow } from "../credits";

describe("debit / credit", () => {
  it("debit 1 from 1 → 0 (exactly zero is allowed); from 0 → InsufficientCredits", () => {
    expect(debit(1)).toEqual({ balanceAfter: 0 });
    expect(() => debit(0)).toThrow(InsufficientCredits);
  });
  it("debit refuses a non-positive or fractional amount; credit likewise", () => {
    expect(() => debit(5, 0)).toThrow(/positive integer/);
    expect(() => debit(5, 1.5)).toThrow(/positive integer/);
    expect(() => credit(5, -1)).toThrow(/positive integer/);
    expect(credit(5, 20)).toEqual({ balanceAfter: 25 });
  });
});

describe("withinReuseWindow (24 h same-fixture rule, m5's pure twin)", () => {
  const now = new Date("2026-09-14T10:00:00Z");
  it("null → false (the empty case); 24 h − 1 s → true; exactly 24 h → false (differential)", () => {
    expect(withinReuseWindow(null, now)).toBe(false);
    expect(withinReuseWindow(new Date(now.getTime() - (CREDIT_REUSE_HOURS * 3600 - 1) * 1000), now)).toBe(true);
    expect(withinReuseWindow(new Date(now.getTime() - CREDIT_REUSE_HOURS * 3600 * 1000), now)).toBe(false);
  });
});

describe("headroomAfterReservations (C3)", () => {
  const usage = { totalStorageMinutes: 100, totalStorageMinutesLimit: 1000 };
  it("no reservations → raw headroom (the empty case)", () => {
    expect(headroomAfterReservations(usage, [])).toBe(900);
  });
  it("reservations subtract; the differential that poll-then-admit cannot see", () => {
    expect(headroomAfterReservations(usage, [300, 300])).toBe(300);
    expect(headroomAfterReservations(usage, [300, 300, 300])).toBe(0);
    expect(headroomAfterReservations(usage, [300, 300, 300, 300])).toBe(-300);
  });
});
