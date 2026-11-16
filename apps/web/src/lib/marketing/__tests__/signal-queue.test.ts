// The Remote scoring page's demo model (signal-queue.ts): a phone that keeps scoring with no signal and sends its taps,
// in order, when the signal returns. The claims the page makes are the assertions here: nothing is lost, nothing is
// counted twice, and other people's screens do not move until the phone is back.
import { describe, expect, it } from "vitest";
import { BALLS_PER_OVER as BPO } from "../cricket-chase-rules";
import { chaseOver, type ChaseKey } from "../cricket-chase";
import { openingSignal, setSignal, signalTap, signalUndo, type SignalState } from "../signal-queue";

const KEYS: ChaseKey[] = ["0", "1", "2", "3", "4", "6", "wide", "out"];
const score = (c: { runs: number; wkts: number; balls: number; over: string[] }) => ({ runs: c.runs, wkts: c.wkts, balls: c.balls, over: c.over });

describe("signal queue", () => {
  it("opens with signal, nothing waiting, and the phone and everyone else agreeing", () => {
    const s = openingSignal();
    expect(s.signal).toBe(true);
    expect(s.pending).toEqual([]);
    expect(s.sent).toBe(0);
    expect(s.server).toBe(s.phone);
  });

  it("with signal, every tap reaches everyone at once", () => {
    let s = openingSignal();
    for (const k of ["4", "wide", "1"] as const) {
      s = signalTap(s, k, BPO);
      expect(s.server).toBe(s.phone);
      expect(s.pending).toEqual([]);
    }
    expect(s.phone.runs).toBe(openingSignal().phone.runs + 6);
  });

  it("without signal, the phone keeps scoring, the taps wait, and nobody else's screen moves", () => {
    const start = openingSignal();
    let s = setSignal(start, false);
    for (const k of ["4", "6", "out"] as const) s = signalTap(s, k, BPO);
    expect(s.phone.runs).toBe(start.phone.runs + 10);
    expect(s.phone.wkts).toBe(start.phone.wkts + 1);
    expect(s.pending).toHaveLength(3);
    expect(s.server).toBe(start.server);
  });

  it("when signal returns, everything waiting goes up in order and the count is reported once", () => {
    let s = setSignal(openingSignal(), false);
    for (const k of ["1", "2", "wide", "4"] as const) s = signalTap(s, k, BPO);
    s = setSignal(s, true);
    expect(s.pending).toEqual([]);
    expect(s.sent).toBe(4);
    expect(score(s.server)).toEqual(score(s.phone));
    // The next tap is ordinary again, and the "sent" note does not linger.
    s = signalTap(s, "1", BPO);
    expect(s.sent).toBe(0);
    expect(s.server).toBe(s.phone);
  });

  it("taking back a waiting tap removes it from the queue; taking back a sent one queues the correction", () => {
    let s = signalTap(openingSignal(), "4", BPO); // sent
    s = setSignal(s, false);
    s = signalTap(s, "6", BPO); // waiting
    s = signalUndo(s);
    expect(s.pending).toEqual([]);
    s = signalUndo(s); // the 4 everyone already saw
    expect(s.pending).toEqual(["undo"]);
    expect(s.server.runs).toBe(openingSignal().phone.runs + 4);
    s = setSignal(s, true);
    expect(s.server.runs).toBe(openingSignal().phone.runs);
    expect(s.sent).toBe(1);
  });

  it("no-ops change nothing: same signal twice, undo with nothing to undo, a tap after the chase is over", () => {
    const s = openingSignal();
    expect(setSignal(s, true)).toBe(s);
    expect(signalUndo(s)).toBe(s);
    let done: SignalState = setSignal(s, false);
    while (!chaseOver(done.phone)) done = signalTap(done, "6", BPO);
    const n = done.pending.length;
    expect(signalTap(done, "6", BPO)).toBe(done);
    expect(done.pending).toHaveLength(n);
  });

  it("whatever happens offline, once signal is back everyone sees exactly the phone's score", () => {
    // Deterministic sweep: every key, signal dropped and restored at every position in a fixed sequence.
    const seq: (ChaseKey | "undo")[] = ["1", "wide", "4", "undo", "out", "2", "undo", "undo", "6", "0", "3"];
    let checked = 0;
    for (let off = 0; off <= seq.length; off++) {
      for (let on = off; on <= seq.length; on++) {
        let s = openingSignal();
        seq.forEach((a, i) => {
          if (i === off) s = setSignal(s, false);
          if (i === on) s = setSignal(s, true);
          s = a === "undo" ? signalUndo(s) : signalTap(s, a, BPO);
          if (s.signal) expect(s.server).toBe(s.phone);
        });
        s = setSignal(s, true);
        expect(score(s.server)).toEqual(score(s.phone));
        expect(s.pending).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(((seq.length + 1) * (seq.length + 2)) / 2);
    expect(KEYS.length).toBe(8);
  });
});
