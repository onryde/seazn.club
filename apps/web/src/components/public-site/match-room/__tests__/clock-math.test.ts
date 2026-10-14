import { describe, expect, it } from "vitest";
import { formatClock, remainingMs } from "../clock-math";
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
  it("m:ss above ten seconds, rounding a partial second UP so 0:00 means really zero", () => {
    expect(formatClock(600_000)).toBe("10:00");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(12_000)).toBe("0:12");
    expect(formatClock(10_000)).toBe("0:10");
  });

  it("tenths below ten seconds (the time-trouble face), and 0.0 only at zero", () => {
    expect(formatClock(9_950)).toBe("0:09.9");
    expect(formatClock(1)).toBe("0:00.1");
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(-5)).toBe("0:00.0");
  });
});
