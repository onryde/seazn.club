// Capture QR v2 §5.1 — domain/stream-code.ts: C1 (validity, with C1b/C3's deferral), C2 (expiry is evaluated),
// C5 (a reverted result). Pure: `now` is passed in. Expected values come from the spec's rule text and the
// declared constants, never from the module.
import { describe, expect, it } from "vitest";
import { CODE_GRACE_AFTER_FINISH_MINUTES } from "../../config";
import { type CodeCall, type CodeStatus, codeServes, codeStatus, normaliseCode } from "../stream-code";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * 60_000;
const STATUSES: readonly CodeStatus[] = ["active", "finishing", "ended", "expiry_due"];
const CALLS: readonly CodeCall[] = ["get", "beat", "claim", "start"];

describe("codeStatus (C2, C3, C5)", () => {
  it("the empty case first: never ended, never finished → active, with or without an open session", () => {
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, false)).toBe("active");
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, true)).toBe("active");
  });

  it("ended outranks everything: a reissued or expired code reads ended whatever finished_at and the session say", () => {
    let checked = 0;
    for (const finishedAt of [null, ago(1000), ago(GRACE_MS * 2)]) {
      for (const open of [false, true]) {
        expect(codeStatus({ endedAt: ago(5000), finishedAt }, NOW, open)).toBe("ended");
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it(`expiry at the grace (${CODE_GRACE_AFTER_FINISH_MINUTES} min, read from CODE_GRACE_AFTER_FINISH_MINUTES): grace − 1 s is finishing, the grace exactly is expiry_due`, () => {
    expect(codeStatus({ endedAt: null, finishedAt: ago(0) }, NOW, false)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS - 1000) }, NOW, false)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS) }, NOW, false)).toBe("expiry_due");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS + 1000) }, NOW, false)).toBe("expiry_due");
  });

  it("an open session DEFERS expiry (W2: never ends a live session): at and past the grace it is still finishing", () => {
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS) }, NOW, true)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS * 10) }, NOW, true)).toBe("finishing");
  });

  it("C5: a reverted result (finishedAt cleared to null) reads active — the stamp it had is gone, so nothing expires", () => {
    // The same code, before and after the revert: past the grace it was due; with the stamp cleared it is active.
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS * 3) }, NOW, false)).toBe("expiry_due");
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, false)).toBe("active");
  });

  it("the grace is a parameter, so tunable() can shorten it (§6.15): at a 1-minute grace, 60 s after finishing is due", () => {
    expect(codeStatus({ endedAt: null, finishedAt: ago(59_000) }, NOW, false, 1)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(60_000) }, NOW, false, 1)).toBe("expiry_due");
  });
});

describe("codeServes (C1, C1b, C3)", () => {
  /** C1, transcribed from §5.1: (a) ACTIVE or ACTIVE·FINISHING answers every call; (b) ENDED answers only the fixture's
   *  open-session phone, for a session created before ended_at, and (C3) only its get and beat — no claim, no start.
   *  expiry_due is the evaluation that ENDS the code (C2), and it can only arise with no open session. */
  const rule = (s: CodeStatus, phone: boolean, before: boolean, call: CodeCall): boolean =>
    s === "active" || s === "finishing" ? true : s === "ended" ? phone && before && (call === "get" || call === "beat") : false;

  it("every (status × caller × session age × call) row: 64 rows, 34 served", () => {
    let rows = 0, served = 0;
    for (const status of STATUSES) {
      for (const callerIsOpenSessionPhone of [true, false]) {
        for (const sessionCreatedBeforeEnd of [true, false]) {
          for (const call of CALLS) {
            const want = rule(status, callerIsOpenSessionPhone, sessionCreatedBeforeEnd, call);
            expect(codeServes({ status, callerIsOpenSessionPhone, sessionCreatedBeforeEnd, call }),
              `${status} phone=${callerIsOpenSessionPhone} before=${sessionCreatedBeforeEnd} ${call}`).toBe(want);
            rows++;
            if (want) served++;
          }
        }
      }
    }
    expect(rows).toBe(STATUSES.length * 2 * 2 * CALLS.length);
    expect(served).toBe(2 * 2 * 2 * CALLS.length + 2);
  });

  it("C1b: an ended code still serves its open session's phone — the get and the beat", () => {
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: true, call: "get" })).toBe(true);
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: true, call: "beat" })).toBe(true);
  });

  it("C1b's negative pair: the SAME caller after the session ends (no longer the open session's phone) gets no service", () => {
    for (const call of CALLS) {
      expect(codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: true, call }), call).toBe(false);
    }
  });

  it("ended code, new claim: refused even from the open session's phone (C3: no new claim, no start)", () => {
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: true, call: "claim" })).toBe(false);
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: true, call: "start" })).toBe(false);
  });

  it("a session created AFTER the code ended is not served by the old code (it belongs to the new one)", () => {
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: false, call: "beat" })).toBe(false);
  });
});

describe("normaliseCode", () => {
  it("the empty case first: empty and blank are not codes", () => {
    expect(normaliseCode("")).toBeNull();
    expect(normaliseCode("   ")).toBeNull();
  });

  it("trims and lower-cases: \" ABCDEFGHJKMN \" → \"abcdefghjkmn\"", () => {
    expect(normaliseCode(" ABCDEFGHJKMN ")).toBe("abcdefghjkmn");
    expect(normaliseCode("0123456789ab")).toBe("0123456789ab");
  });

  it("Crockford's excluded letters are refused, after lower-casing: i, l, o, u", () => {
    expect(normaliseCode("abcdefghijkl")).toBeNull();
    expect(normaliseCode("ABCDEFGHJKMO")).toBeNull();
    expect(normaliseCode("abcdefghjkmu")).toBeNull();
  });

  it("the length is exactly twelve, and an interior space is not trimmed away", () => {
    expect(normaliseCode("abcdefghjkm")).toBeNull();
    expect(normaliseCode("abcdefghjkmnp")).toBeNull();
    expect(normaliseCode("abcdef ghjkmn")).toBeNull();
  });
});
