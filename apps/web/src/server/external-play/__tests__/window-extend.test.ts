// The check-in extension (spec §3.2.2): the arbiter adds CHECKIN_EXTEND_STEP_MS to ONE board's check-in, up to CHECKIN_EXTEND_MAX
// times. The window functions are the only place a deadline is computed, so the extension is a fourth input to the board's
// anchor and everything downstream (the phase, a counted check-in, the line's cap) moves with it from that one place.
//
// Expected values come from the constants and from the rule as the owner stated it (+5 minutes a press, three presses at
// most, the line's cap moves by the same offset), never from the function under test. The one typed number is the pin of the
// owner's values, on purpose, like window.test.ts's.
// Single-sport reason: no sport is involved - this is clock arithmetic on a board's anchor.
import { describe, expect, it } from "vitest";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MS,
  DEADLINE_AFTER_MS,
  MINT_CLAIM_STALE_MS,
  EXTEND_REFUSALS,
  LINE_DEADLINE_GRACE_MS,
  WINDOW_OPEN_LEAD_MS,
  boardAnchor,
  boardCap,
  bridgeGameOnFile,
  checkInCounts,
  extendRefusal,
  extensionsLeft,
  roomPhase,
  windowFor,
  type ExtendRefusal,
} from "../window";

const T = new Date("2026-10-19T12:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("the owner's values (typed on purpose: this pins the ruling, not the code)", () => {
  it("+5 minutes a press, three presses at most (owner, 2026-10-19)", () => {
    expect([CHECKIN_EXTEND_STEP_MS, CHECKIN_EXTEND_MAX]).toEqual([300_000, 3]);
  });
});

describe("windowFor / roomPhase / checkInCounts / boardCap with an extension", () => {
  const presses = Array.from({ length: CHECKIN_EXTEND_MAX + 1 }, (_, k) => k); // 0, 1, 2, 3 presses

  it("the deadline is T + DEADLINE_AFTER_MS + k presses, for 0, 1, 2 and 3 (and moves by exactly one step per press)", () => {
    let checked = 0;
    let previous: number | null = null;
    for (const k of presses) {
      const w = windowFor(boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS));
      expect(w.deadline.getTime(), `${k} presses`).toBe(T.getTime() + DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS);
      if (previous !== null) expect(w.deadline.getTime() - previous, `step before press ${k}`).toBe(CHECKIN_EXTEND_STEP_MS);
      previous = w.deadline.getTime();
      checked += 1;
    }
    expect(checked, "anti-vacuity: 0, 1, 2 and 3 presses all judged").toBe(CHECKIN_EXTEND_MAX + 1);
  });

  it("an extension moves ONLY the deadline: the email and the opening are where they were", () => {
    const plain = windowFor(boardAnchor(T, 0, false, 0));
    for (const k of presses) {
      const w = windowFor(boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS));
      expect(w.emailAt, `${k}: emailAt`).toEqual(plain.emailAt);
      expect(w.opensAt, `${k}: opensAt`).toEqual(plain.opensAt);
    }
  });

  it("the phase flips at the EXTENDED deadline: open at deadline - 1 ms, closed at it - for every press count (the wrong answer is the unextended edge)", () => {
    let checked = 0;
    for (const k of presses) {
      const a = boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS);
      const edge = DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS;
      expect(roomPhase(at(edge - 1), a), `${k}: one ms before the extended deadline`).toBe("open");
      expect(roomPhase(at(edge), a), `${k}: at the extended deadline`).toBe("closed");
      if (k > 0) {
        // The unextended deadline is a time the extended board is STILL OPEN at: the differential a dropped extension fails.
        expect(roomPhase(at(DEADLINE_AFTER_MS), a), `${k}: at the UNextended deadline it is still open`).toBe("open");
        expect(roomPhase(at(DEADLINE_AFTER_MS), boardAnchor(T, 0, false, 0)), `${k}: control - the same instant on a plain board`).toBe("closed");
      }
      checked += 1;
    }
    expect(checked).toBe(CHECKIN_EXTEND_MAX + 1);
  });

  it("a check-in counts up to the extended deadline, not past it: a stamp the plain board would have refused now counts", () => {
    for (const k of presses.filter((p) => p > 0)) {
      const a = boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS);
      const edge = DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS;
      expect(checkInCounts(at(DEADLINE_AFTER_MS + 1), a), `${k}: just past the old deadline`).toBe(true);
      expect(checkInCounts(at(edge - 1), a), `${k}: just before the new one`).toBe(true);
      expect(checkInCounts(at(edge), a), `${k}: at the new one`).toBe(false);
      expect(checkInCounts(at(DEADLINE_AFTER_MS + 1), boardAnchor(T, 0, false, 0)), `${k}: control - plain board`).toBe(false);
    }
  });

  it("the line's cap moves by the SAME offset: cap = extended deadline + LINE_DEADLINE_GRACE_MS (it is never left behind at the old one)", () => {
    for (const k of presses) {
      const a = boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS);
      expect(boardCap(a).getTime(), `${k} presses`).toBe(T.getTime() + DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS + LINE_DEADLINE_GRACE_MS);
      expect(boardCap(a).getTime() - windowFor(a).deadline.getTime(), `${k}: the grace is unchanged`).toBe(LINE_DEADLINE_GRACE_MS);
    }
  });

  it("a later batch keeps its OWN start: batch 2 + 2 presses closes at T + 2 gaps + DEADLINE + 2 steps (not the round's, not batch 0's)", () => {
    const a = boardAnchor(T, 20, true, 2 * CHECKIN_EXTEND_STEP_MS);
    const w = windowFor(a);
    expect(w.opensAt.getTime()).toBe(T.getTime() + 2 * CHECKIN_BATCH_GAP_MS);
    expect(w.deadline.getTime()).toBe(T.getTime() + 2 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS + 2 * CHECKIN_EXTEND_STEP_MS);
    // Batch 0's lead is a no-op of the open and does not leak into the extension either.
    expect(windowFor(boardAnchor(T, 0, true, CHECKIN_EXTEND_STEP_MS)).opensAt.getTime()).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
  });

  it("the extension rides on the anchor: it is a number the anchor carries, 0 when none is given", () => {
    expect(boardAnchor(T, 0, false).extraMs).toBe(0);
    expect(boardAnchor(T, 3, true, CHECKIN_EXTEND_STEP_MS).extraMs).toBe(CHECKIN_EXTEND_STEP_MS);
  });

  it("an extension that is not a non-negative integer number of ms is refused, not added (a guard, not a comment)", () => {
    const bad = [-1, -CHECKIN_EXTEND_STEP_MS, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const x of bad) expect(() => boardAnchor(T, 0, false, x), String(x)).toThrow(RangeError);
    expect(bad.length, "anti-vacuity: the refusals tried").toBeGreaterThan(3);
  });
});

describe("extendRefusal - may this board's check-in be extended now? (spec §3.2.2: open, no game, playable, under the cap)", () => {
  const plain = boardAnchor(T, 0, false, 0);
  /** An extendable board: mid-window (T+1 min, batch 0's window is open), nothing played, a fresh count. */
  const ok = { now: at(60_000), anchor: plain, extensions: 0, playable: true, gameOnFile: false };

  it("a board inside its window with no game, playable and under the cap may be extended", () => {
    expect(extendRefusal(ok)).toBeNull();
  });

  it("the window's edges: one ms before the (extended) deadline may, the deadline itself is closed - plain and after a press", () => {
    for (const k of [0, 1, CHECKIN_EXTEND_MAX - 1]) {
      const anchor = boardAnchor(T, 0, false, k * CHECKIN_EXTEND_STEP_MS);
      const edge = DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS;
      expect(extendRefusal({ ...ok, anchor, extensions: k, now: at(edge - 1) }), `${k}: 1 ms before`).toBeNull();
      expect(extendRefusal({ ...ok, anchor, extensions: k, now: at(edge) }), `${k}: at the deadline`).toBe("closed");
    }
  });

  it("before the board's check-in opens it is `not_open`; at its opening instant it may (a later batch's opening, exactly)", () => {
    const b2 = boardAnchor(T, 20, true, 0);
    const opens = windowFor(b2).opensAt.getTime() - T.getTime();
    expect(extendRefusal({ ...ok, anchor: b2, now: at(opens - 1) })).toBe("not_open");
    expect(extendRefusal({ ...ok, anchor: b2, now: at(opens) })).toBeNull();
  });

  it("the cap: the last allowed press (count MAX - 1) may, count MAX may not - and after the cap the board is still judged by the window first", () => {
    const last = boardAnchor(T, 0, false, (CHECKIN_EXTEND_MAX - 1) * CHECKIN_EXTEND_STEP_MS);
    expect(extendRefusal({ ...ok, anchor: last, extensions: CHECKIN_EXTEND_MAX - 1 })).toBeNull();
    const capped = boardAnchor(T, 0, false, CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS);
    expect(extendRefusal({ ...ok, anchor: capped, extensions: CHECKIN_EXTEND_MAX })).toBe("cap_reached");
    // Capped AND past the extended deadline: `closed` (the more fundamental answer), not `cap_reached`.
    const closedEdge = DEADLINE_AFTER_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;
    expect(extendRefusal({ ...ok, anchor: capped, extensions: CHECKIN_EXTEND_MAX, now: at(closedEdge) })).toBe("closed");
  });

  it("a game on file is `game_started`, even inside the window; a board that is not playable is `not_playable` before anything else", () => {
    expect(extendRefusal({ ...ok, gameOnFile: true })).toBe("game_started");
    expect(extendRefusal({ ...ok, playable: false })).toBe("not_playable");
    // Precedence: not playable beats a game on file, which beats the window (an over board is over whatever the clock says).
    expect(extendRefusal({ ...ok, playable: false, gameOnFile: true })).toBe("not_playable");
    expect(extendRefusal({ ...ok, gameOnFile: true, now: at(DEADLINE_AFTER_MS + 1) })).toBe("game_started");
  });

  it("every refusal is reachable (anti-vacuity: the table of reasons and the function agree)", () => {
    const reached = new Set<ExtendRefusal>();
    const capped = boardAnchor(T, 0, false, CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS);
    for (const r of [
      extendRefusal({ ...ok, playable: false }),
      extendRefusal({ ...ok, gameOnFile: true }),
      extendRefusal({ ...ok, now: at(DEADLINE_AFTER_MS) }),
      extendRefusal({ ...ok, anchor: boardAnchor(T, 20, true, 0) }),
      extendRefusal({ ...ok, anchor: capped, extensions: CHECKIN_EXTEND_MAX }),
    ]) {
      expect(r).not.toBeNull();
      reached.add(r!);
    }
    expect([...reached].sort()).toEqual([...EXTEND_REFUSALS].sort());
    expect(EXTEND_REFUSALS.length).toBe(5);
  });

  it("a count that cannot be (negative, fractional) is refused loudly, not read as 'under the cap'", () => {
    for (const extensions of [-1, 0.5, Number.NaN]) expect(() => extendRefusal({ ...ok, extensions }), String(extensions)).toThrow(RangeError);
  });
});

describe("extensionsLeft", () => {
  it("counts down from the cap to zero and never below", () => {
    // The rule: every press uses one of the MAX allowed; once all are used none is left, and a count past the cap (a row that
    // somehow holds more) still reads none left, never a negative number of presses.
    let checked = 0;
    for (let used = 0; used <= CHECKIN_EXTEND_MAX; used++) {
      expect(extensionsLeft(used), `${used} used`).toBe(CHECKIN_EXTEND_MAX - used);
      checked += 1;
    }
    expect(extensionsLeft(CHECKIN_EXTEND_MAX + 1)).toBe(0);
    expect(checked, "anti-vacuity").toBe(CHECKIN_EXTEND_MAX + 1);
  });
});

describe("bridgeGameOnFile - the three facts that mean a game is, or may be, behind the board", () => {
  const none = { status: "pending", challengeId: null, createSentAt: null, mintClaimedAt: null };
  const now = at(0);
  it("an empty bridge (nothing minted, nothing sent, no claim) has no game on file", () => {
    expect(bridgeGameOnFile(none, now)).toBe(false);
  });
  it("a recorded challenge, a sent create and a live mint claim each put a game on file", () => {
    expect(bridgeGameOnFile({ ...none, status: "ready", challengeId: "abc" }, now)).toBe(true);
    expect(bridgeGameOnFile({ ...none, createSentAt: at(-1) }, now)).toBe(true);
    expect(bridgeGameOnFile({ ...none, mintClaimedAt: at(-1) }, now)).toBe(true);
  });
  it("a mint claim is live for MINT_CLAIM_STALE_MS: one ms inside counts, the stale edge does not count past it", () => {
    expect(bridgeGameOnFile({ ...none, mintClaimedAt: at(-MINT_CLAIM_STALE_MS) }, now), "exactly at the bound: still live").toBe(true);
    expect(bridgeGameOnFile({ ...none, mintClaimedAt: at(-MINT_CLAIM_STALE_MS - 1) }, now), "one ms past: stale").toBe(false);
  });
  it("a claim on a row that is no longer pending is not 'in flight' (it is judged by the challenge or the marker alone)", () => {
    expect(bridgeGameOnFile({ ...none, status: "needs_organiser", mintClaimedAt: at(-1) }, now)).toBe(false);
  });
});
