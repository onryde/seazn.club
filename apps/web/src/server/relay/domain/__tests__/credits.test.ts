// The credits value object (design §5.2; FS10 kept by owner ruling 1 —
// `debit` refuses a negative in MEMORY, before the row lock and the CHECK
// ever see it). C3's arithmetic is pure here so the differential is a
// millisecond test, and Task 10's DB test proves the SAME function is wired.
import { describe, expect, it } from "vitest";
import { CREDIT_REUSE_HOURS, FREE_RESTARTS_PER_WINDOW } from "../../config";
import { InsufficientCredits, credit, debit, headroomAfterReservations, restartIsFree, withinReuseWindow } from "../credits";

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

// W23 (capture QR v2, owner 2026-10-01): "three free restarts per reuse window". The number is the RULE TEXT's, pinned
// here against the constant — the boundary rows below then take the limit from the constant, so a change to the rule
// moves one place and this pin says so.
describe("restartIsFree (W23: three free restarts per reuse window)", () => {
  it("the rule text's number: FREE_RESTARTS_PER_WINDOW is three", () => {
    expect(FREE_RESTARTS_PER_WINDOW).toBe(3);
  });
  it("the EMPTY case first: a closed window is never free, whatever the count — the reuse waiver needs a consume that stands", () => {
    let checked = 0;
    for (let used = 0; used <= FREE_RESTARTS_PER_WINDOW + 1; used++) {
      expect(restartIsFree({ windowOpen: false, used }, FREE_RESTARTS_PER_WINDOW), `closed, used ${used}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(FREE_RESTARTS_PER_WINDOW + 2);
  });
  it("an open window: used 0, 1, 2 → free; used 3 → not free (the 4th restart pays); beyond → not free", () => {
    const rows: [number, boolean][] = [[0, true], [1, true], [2, true], [3, false], [4, false]];
    let checked = 0;
    for (const [used, free] of rows) {
      expect(restartIsFree({ windowOpen: true, used }, FREE_RESTARTS_PER_WINDOW), `open, used ${used}`).toBe(free);
      checked++;
    }
    expect(checked).toBe(5);
  });
  it("a count that is not a whole non-negative number, or a limit that is not a positive integer, is refused by name — never read as free", () => {
    expect(() => restartIsFree({ windowOpen: true, used: -1 }, 3)).toThrow(/used/);
    expect(() => restartIsFree({ windowOpen: true, used: 1.5 }, 3)).toThrow(/used/);
    expect(() => restartIsFree({ windowOpen: true, used: Number.NaN }, 3)).toThrow(/used/);
    expect(() => restartIsFree({ windowOpen: true, used: 0 }, 0)).toThrow(/limit/);
    expect(restartIsFree({ windowOpen: true, used: 0 }, 1), "the positive pair").toBe(true);
  });
});
