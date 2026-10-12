// Capture QR v2 §5.1 — domain/stream-code.ts: C1 (validity, with C1b/C3's deferral), C2 (expiry is evaluated),
// C5 (a reverted result). Pure: `now` is passed in. Expected values come from the spec's rule text and the
// declared constants, never from the module.
import { describe, expect, it } from "vitest";
import { CAPTURE_RECORD_TAIL_HOURS, CODE_GRACE_AFTER_FINISH_MINUTES } from "../../config";
import { type CodeCall, type CodeStatus, codeServes, codeStatus, normaliseCode, recordTailAnchor } from "../stream-code";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * 60_000;
const STATUSES: readonly CodeStatus[] = ["active", "finishing", "ended", "expiry_due"];
const CALLS: readonly CodeCall[] = ["get", "beat", "claim", "start"];

describe("codeStatus (C2, C3, C5)", () => {
  it("the empty case first: never ended, never finished → active, with or without an open session", () => {
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("active");
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, true, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("active");
  });

  it("ended outranks everything: a reissued or expired code reads ended whatever finished_at and the session say", () => {
    let checked = 0;
    for (const finishedAt of [null, ago(1000), ago(GRACE_MS * 2)]) {
      for (const open of [false, true]) {
        expect(codeStatus({ endedAt: ago(5000), finishedAt }, NOW, open, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("ended");
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it(`expiry at the grace (${CODE_GRACE_AFTER_FINISH_MINUTES} min, read from CODE_GRACE_AFTER_FINISH_MINUTES): grace − 1 s is finishing, the grace exactly is expiry_due`, () => {
    expect(codeStatus({ endedAt: null, finishedAt: ago(0) }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS - 1000) }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS) }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("expiry_due");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS + 1000) }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("expiry_due");
  });

  it("an open session DEFERS expiry (W2: never ends a live session): at and past the grace it is still finishing", () => {
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS) }, NOW, true, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("finishing");
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS * 10) }, NOW, true, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("finishing");
  });

  it("C5: a reverted result (finishedAt cleared to null) reads active — the stamp it had is gone, so nothing expires", () => {
    // The same code, before and after the revert: past the grace it was due; with the stamp cleared it is active.
    expect(codeStatus({ endedAt: null, finishedAt: ago(GRACE_MS * 3) }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("expiry_due");
    expect(codeStatus({ endedAt: null, finishedAt: null }, NOW, false, CODE_GRACE_AFTER_FINISH_MINUTES)).toBe("active");
  });

  it("m-1: the grace is REQUIRED, so a use-case cannot fall back to the constant and skip tunable(…) — tsc reds an unused @ts-expect-error", () => {
    const omitted = () =>
      // @ts-expect-error — graceMinutes has no default (§6.15, D1)
      codeStatus({ endedAt: null, finishedAt: null }, NOW, false);
    expect(omitted).toBeTypeOf("function");   // never called: the check is the type error above
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

// capture record upload (spec 2026-10-12 §4, P11 + Q1 approved): the `record` call. Typed from §4's text:
//  - C1(a): ACTIVE and FINISHING serve `record`;
//  - C1(b) for record: ENDED with an open session created before the end serves it for ANY phone (no phone condition,
//    R4) — the row that differs from `get`;
//  - C1(c): ENDED with none serves it for 24 h after the tail's anchor, and is refused one moment past it.
describe("codeServes — the `record` call (C1(a), C1(b) without the phone, C1(c) the 24 h tail)", () => {
  const SPEC_TAIL_MS = 24 * 3_600_000;   // §4 C1(c): "for 24 h after it last served"
  const tail = (anchorAgoMs: number | null) => ({ now: NOW, anchor: anchorAgoMs === null ? null : ago(anchorAgoMs) });

  it("the empty case first: an ENDED code with no open session and no anchor serves no record", () => {
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: false, call: "record", tail: tail(null) })).toBe(false);
  });

  it("C1(a): active and finishing serve a record, whatever the caller, the session and the tail say", () => {
    let rows = 0;
    for (const status of ["active", "finishing"] as const) {
      for (const callerIsOpenSessionPhone of [true, false]) {
        for (const sessionCreatedBeforeEnd of [true, false]) {
          for (const t of [tail(null), tail(SPEC_TAIL_MS * 10)]) {
            expect(codeServes({ status, callerIsOpenSessionPhone, sessionCreatedBeforeEnd, call: "record", tail: t })).toBe(true);
            rows++;
          }
        }
      }
    }
    expect(rows).toBe(16);
  });

  it("C1(b) for record: an ENDED code with an open pre-end session serves ANY phone — where `get` from that same caller is refused", () => {
    // The differential row: a caller who is NOT the open session's phone.
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: true, call: "record", tail: tail(null) })).toBe(true);
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: true, call: "get" })).toBe(false);
    expect(codeServes({ status: "ended", callerIsOpenSessionPhone: true, sessionCreatedBeforeEnd: true, call: "record", tail: tail(null) })).toBe(true);
  });

  it(`C1(c): with no open pre-end session, served through anchor + 24 h exactly, refused 1 ms past it (and one day past it)`, () => {
    const at = (msPastAnchor: number) => codeServes({
      status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: false, call: "record",
      tail: { now: new Date(NOW.getTime() + msPastAnchor), anchor: NOW },
    });
    expect(at(0)).toBe(true);
    expect(at(60_000)).toBe(true);
    expect(at(SPEC_TAIL_MS)).toBe(true);
    expect(at(SPEC_TAIL_MS + 1)).toBe(false);
    expect(at(SPEC_TAIL_MS * 2)).toBe(false);
  });

  it("the tail serves only `record`: get, beat, claim and start under the same tail are refused", () => {
    let checked = 0;
    for (const call of CALLS) {
      expect(codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: false, call, tail: tail(1000) }), call).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("expiry_due never serves a record (the use-case turns it into ended first)", () => {
    expect(codeServes({ status: "expiry_due", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: true, call: "record", tail: tail(0) })).toBe(false);
  });

  it("an assumption is a guard: a `record` call without its tail is a named refusal, never a silent false", () => {
    expect(() => codeServes({ status: "ended", callerIsOpenSessionPhone: false, sessionCreatedBeforeEnd: false, call: "record" })).toThrow(/tail/);
  });

  it("CAPTURE_RECORD_TAIL_HOURS is §4's 24", () => {
    expect(CAPTURE_RECORD_TAIL_HOURS * 3_600_000).toBe(SPEC_TAIL_MS);
  });
});

describe("recordTailAnchor (§4 C1(c): the LATER of the code's own end and the end of the last session open when it ended)", () => {
  const H = 3_600_000;
  const at = (h: number): Date => new Date(NOW.getTime() + h * H);
  const graceMinutes = CODE_GRACE_AFTER_FINISH_MINUTES;

  it("the empty case first: a code that has not ended has no tail", () => {
    expect(recordTailAnchor({ endCause: null, endedAt: null, finishedAt: null, graceMinutes, sessions: [] })).toBeNull();
  });

  it("a reissue with no session: its ended_at", () => {
    expect(recordTailAnchor({ endCause: "reissued", endedAt: at(0), finishedAt: null, graceMinutes, sessions: [] })).toEqual(at(0));
  });

  it("a reissue whose session outlived it: that session's end (M12's differential — the code's end alone would be 5 h early)", () => {
    const sessions = [{ createdAt: at(-1), endedAt: at(5) }];
    expect(recordTailAnchor({ endCause: "reissued", endedAt: at(0), finishedAt: null, graceMinutes, sessions })).toEqual(at(5));
  });

  it("a session created AFTER the code ended (the new code's) does not move the old code's tail", () => {
    const sessions = [{ createdAt: at(1), endedAt: at(9) }];
    expect(recordTailAnchor({ endCause: "reissued", endedAt: at(0), finishedAt: null, graceMinutes, sessions })).toEqual(at(0));
  });

  it("a session that ended before the code did, or is still open, never moves it earlier or to null", () => {
    const sessions = [{ createdAt: at(-5), endedAt: at(-4) }, { createdAt: at(-1), endedAt: null }];
    expect(recordTailAnchor({ endCause: "reissued", endedAt: at(0), finishedAt: null, graceMinutes, sessions })).toEqual(at(0));
  });

  it("an expiry runs from finished_at + the grace, NOT the lazily written ended_at (written 3 days late here)", () => {
    const finishedAt = at(-80);
    const lazy = at(0);
    const want = new Date(finishedAt.getTime() + graceMinutes * 60_000);
    expect(recordTailAnchor({ endCause: "expired", endedAt: lazy, finishedAt, graceMinutes, sessions: [] })).toEqual(want);
    expect(want.getTime()).toBeLessThan(lazy.getTime() - 24 * H);   // premise: the two anchors fall on either side of the tail
  });

  it("an expiry whose session kept the code finishing past the grace: that session's end", () => {
    const finishedAt = at(-10);
    const sessions = [{ createdAt: at(-11), endedAt: at(-2) }];
    expect(recordTailAnchor({ endCause: "expired", endedAt: at(0), finishedAt, graceMinutes, sessions })).toEqual(at(-2));
  });

  it("an expiry whose result was later reverted (finished_at null again, C5) falls back to its ended_at", () => {
    expect(recordTailAnchor({ endCause: "expired", endedAt: at(0), finishedAt: null, graceMinutes, sessions: [] })).toEqual(at(0));
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
