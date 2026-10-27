// The credits value object (design §5.2; FS10 kept by owner ruling 1 —
// `debit` refuses a negative in MEMORY, before the row lock and the CHECK
// ever see it). C3's arithmetic is pure here so the differential is a
// millisecond test, and Task 10's DB test proves the SAME function is wired.
import { describe, expect, it } from "vitest";
import { CREDIT_REUSE_HOURS, FINALISATION_GRACE_SECONDS, FINALISATION_PROCESSING_SLACK_SECONDS, FREE_RESTARTS_PER_WINDOW, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, MAX_DURATION_MINUTES, NEVER_LIVE_REFUNDS_PER_WINDOW, RESERVATION_BUFFER_MINUTES } from "../../config";
import { FakeIngest } from "../../fakes";
import {
  InsufficientCredits, RECORDINGS_PER_SESSION, credit, debit, elapsedMinutesSince, endedCameraReservationMinutes, endedReservationMinutes, headroomAfterReservations,
  neverLiveRefundCapped, reservationMinutes, restartIsFree, withinReuseWindow,
} from "../credits";

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
// runs, so it makes two recordings; passthrough records its one input. The counts are the RULING's, typed here.
// Owner ruling 2026-10-26 (E1, "30 mins buffer") AMENDS how much each recording reserves: not a full match up front but
// min(maxDurationMinutes, ceil(elapsed minutes) + RESERVATION_BUFFER_MINUTES). Every expected value below is built from
// RESERVATION_BUFFER_MINUTES / MAX_DURATION_MINUTES / RECORDINGS_PER_SESSION, so a change to a constant moves the test with it.
describe("reservationMinutes (R2004 recordings x the 2026-10-26 rolling reservation)", () => {
  const MODES = ["passthrough", "composed"] as const;
  const B = RESERVATION_BUFFER_MINUTES;
  const MAX = MAX_DURATION_MINUTES;
  it("the ruling's recording counts (1 and 2) and the premise the cases below rely on: the buffer is a whole number that leaves room under the cap", () => {
    expect(RECORDINGS_PER_SESSION).toEqual({ passthrough: 1, composed: 2 });
    expect(Number.isInteger(B) && B > 0, "a zero buffer would reserve nothing at elapsed 0").toBe(true);
    expect(B * 2, "the cap and the buffer must be distinguishable, or the cap cases witness nothing").toBeLessThan(MAX);
  });
  it("ELAPSED 0 - the admission threshold: just the buffer per recording (passthrough B, composed 2B), never the full match", () => {
    for (const mode of MODES) expect(reservationMinutes(mode, MAX), mode).toBe(RECORDINGS_PER_SESSION[mode] * B);
    expect(reservationMinutes("composed", MAX), "the differential from the retired rule (2 x MAX)").not.toBe(2 * MAX);
  });
  it("rolls with the elapsed time, rounded UP to a whole minute: 47.3 min -> 48 + buffer per recording; a whole 47 stays 47", () => {
    for (const mode of MODES) {
      const n = RECORDINGS_PER_SESSION[mode];
      expect(reservationMinutes(mode, MAX, 47.3), `${mode} 47.3`).toBe(n * (48 + B));
      expect(reservationMinutes(mode, MAX, 47), `${mode} 47`).toBe(n * (47 + B));
      expect(reservationMinutes(mode, MAX, 47.0001), `${mode} 47.0001`).toBe(n * (48 + B));
      expect(reservationMinutes(mode, MAX, 0.001), `${mode} the first fraction of a minute already counts a minute`).toBe(n * (1 + B));
    }
  });
  it("capped at the booking, per recording: the cap's boundary row (elapsed = MAX - B) is exactly MAX, one minute earlier is MAX - 1, one later is still MAX; far past it stays MAX", () => {
    for (const mode of MODES) {
      const n = RECORDINGS_PER_SESSION[mode];
      expect(reservationMinutes(mode, MAX, MAX - B - 1), `${mode} below the cap`).toBe(n * (MAX - 1));
      expect(reservationMinutes(mode, MAX, MAX - B), `${mode} at the cap`).toBe(n * MAX);
      expect(reservationMinutes(mode, MAX, MAX - B + 1), `${mode} past the cap`).toBe(n * MAX);
      expect(reservationMinutes(mode, MAX, MAX * 10), `${mode} far past`).toBe(n * MAX);
    }
  });
  it("the booking's OWN length is the cap, not 300: a booking shorter than the buffer reserves its own length per recording at elapsed 0", () => {
    const short = Math.floor(B / 3);
    expect(short, "premise: the booking is shorter than the buffer").toBeLessThan(B);
    for (const mode of MODES) expect(reservationMinutes(mode, short), mode).toBe(RECORDINGS_PER_SESSION[mode] * short);
  });
  it("the empty case: a zero-length booking reserves zero in both modes; a duration or an elapsed that is not a whole/finite non-negative number is refused by name", () => {
    expect(reservationMinutes("passthrough", 0)).toBe(0);
    expect(reservationMinutes("composed", 0)).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reservationMinutes("composed", bad), String(bad)).toThrow(/reservationMinutes: maxDurationMinutes must be a whole non-negative number/);
    }
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reservationMinutes("composed", MAX, bad), String(bad)).toThrow(/reservationMinutes: elapsedMinutes must be a finite non-negative number/);
    }
  });
});

describe("elapsedMinutesSince (a running session's elapsed, from its start)", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  it("no start yet is zero (the empty case: a session that has not begun owes the buffer only); a start in the future is zero, never negative", () => {
    expect(elapsedMinutesSince(null, now)).toBe(0);
    expect(elapsedMinutesSince(new Date(now.getTime() + 5 * 60_000), now)).toBe(0);
  });
  it("fractional minutes between the start and now", () => {
    expect(elapsedMinutesSince(new Date(now.getTime() - 47.3 * 60_000), now)).toBeCloseTo(47.3, 9);
    expect(elapsedMinutesSince(now, now)).toBe(0);
  });
});

// Owner ruling 2026-10-26 ("C"): an ENDED composed session keeps the camera's share only for the minutes it actually ran,
// rounded UP to a whole minute and capped at the booking; a span that cannot be read is the whole booking, never zero.
describe("endedCameraReservationMinutes (the 2026-10-26 ended rule)", () => {
  const MAX = MAX_DURATION_MINUTES;
  const t0 = new Date("2026-10-26T09:00:00Z");
  const after = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  it("a 6-minute stream reserves 6, not the 300 it reserved before", () => {
    expect(endedCameraReservationMinutes(t0, after(6), MAX)).toBe(6);
  });
  it("rounds UP to a whole minute: 59.2 -> 60, a whole 60 stays 60, a millisecond over is 61", () => {
    expect(endedCameraReservationMinutes(t0, after(59.2), MAX)).toBe(60);
    expect(endedCameraReservationMinutes(t0, after(60), MAX)).toBe(60);
    expect(endedCameraReservationMinutes(t0, new Date(after(60).getTime() + 1), MAX)).toBe(61);
  });
  it("capped at the booking: exactly MAX is MAX, one over is MAX, far over is MAX, and a session's own shorter booking is the cap", () => {
    expect(endedCameraReservationMinutes(t0, after(MAX - 1), MAX)).toBe(MAX - 1);
    expect(endedCameraReservationMinutes(t0, after(MAX), MAX)).toBe(MAX);
    expect(endedCameraReservationMinutes(t0, after(MAX + 1), MAX)).toBe(MAX);
    expect(endedCameraReservationMinutes(t0, after(MAX * 10), MAX)).toBe(MAX);
    expect(endedCameraReservationMinutes(t0, after(100), 90), "the session's own booking").toBe(90);
  });
  it("a camera that NEVER WARMED recorded nothing and reserves ZERO (review m3), whatever the end; a missing END of a warmed one is the whole booking (an unknown span is never zero)", () => {
    expect(endedCameraReservationMinutes(null, after(6), MAX), "never warmed, ended").toBe(0);
    expect(endedCameraReservationMinutes(null, null, MAX), "never warmed, no end").toBe(0);
    expect(endedCameraReservationMinutes(null, null, 90), "never warmed, own booking").toBe(0);
    expect(endedCameraReservationMinutes(t0, null, MAX), "warmed, end not recorded").toBe(MAX);
    expect(endedCameraReservationMinutes(t0, null, 90), "warmed, end not recorded, the session's own booking").toBe(90);
  });
  it("an unreadable span is the whole booking too (an end BEFORE the start, an invalid date); a span of exactly zero is a real measurement of zero", () => {
    expect(endedCameraReservationMinutes(after(6), t0, MAX), "end before start").toBe(MAX);
    expect(endedCameraReservationMinutes(new Date(Number.NaN), after(6), MAX), "invalid start").toBe(MAX);
    expect(endedCameraReservationMinutes(t0, new Date(Number.NaN), MAX), "invalid end").toBe(MAX);
    expect(endedCameraReservationMinutes(t0, t0, MAX)).toBe(0);
  });
  it("a booking that is not a whole non-negative number is refused by name", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => endedCameraReservationMinutes(t0, after(6), bad), String(bad)).toThrow(/endedCameraReservationMinutes: maxDurationMinutes must be a whole non-negative number/);
    }
  });
});

// Review I1 (PR #1041): an in-progress recording is counted by NOTHING (R0 F2); its minutes land in one lump when Cloudflare
// finalises it. So for the finalisation grace after `ended_at`, an ended session keeps EVERY recording's span reserved:
// composed 2 x (the camera and the programme), passthrough 1. After it, composed keeps the camera alone until the
// recordings are deleted, and passthrough nothing.
describe("endedReservationMinutes (the finalisation grace)", () => {
  const MAX = MAX_DURATION_MINUTES;
  const GRACE_MS = FINALISATION_GRACE_SECONDS * 1000;
  const start = new Date("2026-10-26T09:00:00Z");
  const ran = 23;
  const end = new Date(start.getTime() + ran * 60_000);
  const at = (msAfterEnd: number) => new Date(end.getTime() + msAfterEnd);
  const base = { warmingAt: start, endedAt: end, maxDurationMinutes: MAX, cameraHeld: true };

  it("the grace is the hold window the ingest port itself declares PLUS the processing allowance (not a typed figure), strictly longer than the hold alone", () => {
    const hold = new FakeIngest().capabilities.holdWindowSeconds.rtmps;
    expect(hold, "PREMISE: the port declares an RTMPS hold").toBe(INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS);
    expect(FINALISATION_PROCESSING_SLACK_SECONDS, "the allowance is a real span of time").toBeGreaterThan(0);
    expect(FINALISATION_GRACE_SECONDS).toBe(hold! + FINALISATION_PROCESSING_SLACK_SECONDS);
    expect(FINALISATION_GRACE_SECONDS).toBeGreaterThan(hold!);
  });

  it("COMPOSED: every recording's span while finalising (just inside), the camera alone just after - the boundary row, both neighbours", () => {
    const n = RECORDINGS_PER_SESSION.composed;
    expect(endedReservationMinutes({ ...base, mode: "composed", now: end }), "the instant it ends").toBe(n * ran);
    expect(endedReservationMinutes({ ...base, mode: "composed", now: at(GRACE_MS - 1000) }), "one second inside").toBe(n * ran);
    expect(endedReservationMinutes({ ...base, mode: "composed", now: at(GRACE_MS) }), "exactly at the grace: closed").toBe(ran);
    expect(endedReservationMinutes({ ...base, mode: "composed", now: at(GRACE_MS + 1000) }), "one second after").toBe(ran);
    expect(endedReservationMinutes({ ...base, mode: "composed", now: at(GRACE_MS * 100) }), "long after").toBe(ran);
  });

  it("PASSTHROUGH: its one recording's span while finalising (just inside), NOTHING just after", () => {
    const n = RECORDINGS_PER_SESSION.passthrough;
    expect(endedReservationMinutes({ ...base, mode: "passthrough", now: end }), "the instant it ends").toBe(n * ran);
    expect(endedReservationMinutes({ ...base, mode: "passthrough", now: at(GRACE_MS - 1000) }), "one second inside").toBe(n * ran);
    expect(endedReservationMinutes({ ...base, mode: "passthrough", now: at(GRACE_MS) }), "exactly at the grace: closed").toBe(0);
    expect(endedReservationMinutes({ ...base, mode: "passthrough", now: at(GRACE_MS + 1000) }), "one second after").toBe(0);
  });

  it("the camera's own release is independent of the grace: deleted camera + inside the grace is the programme alone; deleted + after is nothing", () => {
    const deleted = { ...base, mode: "composed" as const, cameraHeld: false };
    expect(endedReservationMinutes({ ...deleted, now: at(GRACE_MS - 1000) })).toBe(ran);
    expect(endedReservationMinutes({ ...deleted, now: at(GRACE_MS + 1000) })).toBe(0);
  });

  it("a session that NEVER WARMED recorded nothing: zero in both modes, inside the grace too (review m3)", () => {
    for (const mode of ["composed", "passthrough"] as const) {
      expect(endedReservationMinutes({ ...base, mode, warmingAt: null, now: end }), `${mode} never warmed, inside`).toBe(0);
      expect(endedReservationMinutes({ ...base, mode, warmingAt: null, now: at(GRACE_MS + 1000) }), `${mode} never warmed, after`).toBe(0);
    }
  });

  it("the span keeps the C rules inside the grace too: rounded UP, capped at the booking, a zero span is zero", () => {
    const n = RECORDINGS_PER_SESSION.composed;
    const lasting = (minutes: number) => ({ ...base, mode: "composed" as const, endedAt: new Date(start.getTime() + minutes * 60_000), now: new Date(start.getTime() + minutes * 60_000) });
    expect(endedReservationMinutes(lasting(59.2))).toBe(n * 60);
    expect(endedReservationMinutes(lasting(MAX + 50))).toBe(n * MAX);
    expect(endedReservationMinutes(lasting(0))).toBe(0);
  });

  it("an END THAT WAS NEVER RECORDED has no grace to be inside: composed keeps the camera's whole booking, passthrough nothing", () => {
    expect(endedReservationMinutes({ ...base, mode: "composed", endedAt: null, now: end })).toBe(MAX);
    expect(endedReservationMinutes({ ...base, mode: "passthrough", endedAt: null, now: end })).toBe(0);
  });

  it("a booking that is not a whole non-negative number is refused by name", () => {
    expect(() => endedReservationMinutes({ ...base, mode: "composed", maxDurationMinutes: 1.5, now: end })).toThrow(/endedCameraReservationMinutes: maxDurationMinutes must be a whole non-negative number/);
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
