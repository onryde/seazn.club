import { describe, expect, it } from "vitest";
import { formatClock, remainingMs, TENTHS_BELOW_MS } from "../clock-math";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

describe("remainingMs", () => {
  it("a stopped clock ignores wall time entirely", () => {
    expect(remainingMs({ baseMs: 180_000, asOfMs: 0, nowMs: 60_000, running: false })).toBe(180_000);
  });

  it("a running clock counts down by exactly the elapsed wall time", () => {
    expect(remainingMs({ baseMs: 180_000, asOfMs: 1_000, nowMs: 4_500, running: true })).toBe(176_500);
  });

  it("never goes below zero — the flag is Lichess's to declare, not ours", () => {
    expect(remainingMs({ baseMs: 2_000, asOfMs: 0, nowMs: 90_000, running: true })).toBe(0);
  });

  it("a viewer clock BEHIND the as-of instant never adds time (skew guard)", () => {
    expect(remainingMs({ baseMs: 60_000, asOfMs: 10_000, nowMs: 9_000, running: true })).toBe(60_000);
  });

  it("a clock correction that moves time BACKWARDS is honoured (reconcile is authoritative, M11)", () => {
    // our local arithmetic said 176_500; the export says 174_000
    expect(remainingMs({ baseMs: 174_000, asOfMs: 4_500, nowMs: 4_500, running: true })).toBe(174_000);
  });

  it("every ship-1 time control OPENS at its own declared limit, taken from the catalogue not a table here", () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const opening = remainingMs({ baseMs: tc.limitSeconds * 1_000, asOfMs: 0, nowMs: 0, running: false });
      expect(opening, tc.key).toBe(tc.limitSeconds * 1_000);
      expect(opening, `${tc.key} must not open at a hard-coded 3+0`).toBeGreaterThan(0);
      // The rendered face reads the catalogue's own minutes, e.g. "10:00" for 10+5.
      expect(formatClock(opening), tc.key).toBe(`${tc.key.split("+")[0]}:00`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: time controls checked").toBe(SHIP1_TIME_CONTROLS.length);
    expect(SHIP1_TIME_CONTROLS.length, "catalogue is not empty").toBeGreaterThan(1);
  });
});

describe("formatClock", () => {
  it("m:ss from twenty seconds up, rounding a partial second UP so 0:00 means really zero", () => {
    expect(formatClock(600_000)).toBe("10:00");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(30_000)).toBe("0:30");
    expect(formatClock(20_000)).toBe("0:20");
    expect(formatClock(20_001), "a partial second above the line rounds up, still m:ss").toBe("0:21");
  });

  it("tenths below TWENTY seconds (D24, owner: the time-trouble face starts earlier), two-digit seconds included, and 0.0 only at zero", () => {
    expect(formatClock(19_999)).toBe("0:19.9");
    expect(formatClock(19_700)).toBe("0:19.7");
    expect(formatClock(10_000), "ten seconds is no longer the line").toBe("0:10.0");
    expect(formatClock(9_950)).toBe("0:09.9");
    expect(formatClock(1)).toBe("0:00.1");
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(-5)).toBe("0:00.0");
  });

  it("the threshold is twenty seconds, typed from the ruling, and the face switches exactly there", () => {
    expect(TENTHS_BELOW_MS).toBe(20_000);
    expect(formatClock(TENTHS_BELOW_MS - 1), "one ms under: tenths").toMatch(/^0:\d\d\.\d$/);
    expect(formatClock(TENTHS_BELOW_MS), "at the line: whole seconds").toMatch(/^\d+:\d\d$/);
  });

  it("a counted table across the line: every whole second and tenth from 0.1 s to 25 s reads as its own value, never 0.0 while time remains", () => {
    let checked = 0;
    for (let ms = 1; ms <= 25_000; ms += 50) {
      const face = formatClock(ms);
      if (ms < 20_000) {
        // The oracle reads the digits off the decimal (whole seconds, then the tenth below them), a different route to
        // the same face; a clock with any time left never reads 0.0, so under a tenth it shows 0.1.
        const whole = Math.floor(ms / 1_000);
        const tenth = Math.floor((ms % 1_000) / 100);
        const expected = whole === 0 && tenth === 0 ? "0:00.1" : `0:${String(whole).padStart(2, "0")}.${tenth}`;
        expect(face, `${ms} ms`).toBe(expected);
        expect(face, `${ms} ms is not 0.0`).not.toBe("0:00.0");
      } else {
        // Whole seconds, a started second counted: 20.001 s reads 0:21.
        const seconds = Math.floor(ms / 1_000) + (ms % 1_000 === 0 ? 0 : 1);
        expect(face, `${ms} ms`).toBe(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: faces checked").toBe(500);
  });
});
