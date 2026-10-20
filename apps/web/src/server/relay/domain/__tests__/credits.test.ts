// The credits value object (design §5.2; FS10 kept by owner ruling 1 —
// `debit` refuses a negative in MEMORY, before the row lock and the CHECK
// ever see it). C3's arithmetic is pure here so the differential is a
// millisecond test, and Task 10's DB test proves the SAME function is wired.
import { describe, expect, it } from "vitest";
import { CREDIT_REUSE_HOURS, FREE_RESTARTS_PER_WINDOW, NEVER_LIVE_REFUNDS_PER_WINDOW } from "../../config";
import { InsufficientCredits, RECORDINGS_PER_SESSION, credit, debit, headroomAfterReservations, neverLiveRefundCapped, reservationMinutes, restartIsFree, withinReuseWindow } from "../credits";

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

// R2004 (owner ruling 2026-10-18, option (a)): a composed session's camera (A) AND programme (B) both record while it
// runs, so it reserves two full matches; passthrough records its one input. The counts are the RULING's, typed here.
describe("reservationMinutes (R2004, owner ruling 2026-10-18)", () => {
  it("passthrough reserves ONE recording of the match, composed TWO — the ruling's 1× and 2×, at two durations", () => {
    expect(RECORDINGS_PER_SESSION).toEqual({ passthrough: 1, composed: 2 });
    expect(reservationMinutes("passthrough", 300)).toBe(300);
    expect(reservationMinutes("composed", 300)).toBe(600);
    expect(reservationMinutes("passthrough", 90)).toBe(90);
    expect(reservationMinutes("composed", 90)).toBe(180);
  });
  it("the empty case: a zero-length reservation is zero in both modes, and a duration that is not a whole non-negative number is refused by name", () => {
    expect(reservationMinutes("passthrough", 0)).toBe(0);
    expect(reservationMinutes("composed", 0)).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reservationMinutes("composed", bad), String(bad)).toThrow(/reservationMinutes: maxDurationMinutes must be a whole non-negative number/);
    }
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

// R2008 free-gaps (owner ruling 2026-10-20, "fix both gap"): the platform returns AT MOST ONE never-live credit per fixture per
// reuse window. The number is the ruling's, pinned here against the constant; the rows below take their limit from it. The
// window is the reuse rule's own (`withinReuseWindow`, CREDIT_REUSE_HOURS), so its boundary is the one pinned above.
describe("neverLiveRefundCapped (R2008 free-gaps: one never-live refund per fixture per reuse window)", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const WINDOW_S = CREDIT_REUSE_HOURS * 3600;
  it("the ruling's number: NEVER_LIVE_REFUNDS_PER_WINDOW is one", () => {
    expect(NEVER_LIVE_REFUNDS_PER_WINDOW).toBe(1);
  });
  it("the EMPTY case first: with no earlier refund nothing is capped — the first never-live end of a fixture is always refunded", () => {
    expect(neverLiveRefundCapped([], now, NEVER_LIVE_REFUNDS_PER_WINDOW)).toBe(false);
  });
  it("one earlier refund: a second inside the window is capped; one exactly a window ago is not (the reuse rule's own boundary, from the constant)", () => {
    expect(neverLiveRefundCapped([ago(0)], now, NEVER_LIVE_REFUNDS_PER_WINDOW), "just now").toBe(true);
    expect(neverLiveRefundCapped([ago(WINDOW_S - 1)], now, NEVER_LIVE_REFUNDS_PER_WINDOW), "a second inside").toBe(true);
    expect(neverLiveRefundCapped([ago(WINDOW_S)], now, NEVER_LIVE_REFUNDS_PER_WINDOW), "exactly the window").toBe(false);
    expect(neverLiveRefundCapped([ago(WINDOW_S + 1)], now, NEVER_LIVE_REFUNDS_PER_WINDOW), "a second past").toBe(false);
  });
  it("only refunds INSIDE the window count, whatever order they come in — a limit of 2 is the differential (one inside, one past is not capped; two inside is)", () => {
    expect(neverLiveRefundCapped([ago(WINDOW_S + 5), ago(60)], now, 1)).toBe(true);
    expect(neverLiveRefundCapped([ago(60), ago(WINDOW_S + 5)], now, 1)).toBe(true);
    expect(neverLiveRefundCapped([ago(WINDOW_S + 5), ago(WINDOW_S + 9)], now, 1)).toBe(false);
    expect(neverLiveRefundCapped([ago(WINDOW_S + 5), ago(60)], now, 2), "one inside of two allowed").toBe(false);
    expect(neverLiveRefundCapped([ago(120), ago(60)], now, 2), "two inside of two allowed").toBe(true);
  });
  it("a limit that is not a positive integer is refused by name — read as 0 or NaN it would cap everything, or nothing", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => neverLiveRefundCapped([], now, bad), String(bad)).toThrow(/neverLiveRefundCapped: limit/);
    }
    expect(neverLiveRefundCapped([], now, 1), "the positive pair").toBe(false);
  });
});
