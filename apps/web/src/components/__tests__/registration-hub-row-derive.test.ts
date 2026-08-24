// RS004 W3 — pure derivations feeding the Settings tab row: the window label
// (rendered in the ORG timezone, never browser-local — the deleted form's
// bug), the capacity meter, and the category/age badges.
import { describe, expect, it } from "vitest";
import {
  formatRegistrationWindow,
  deriveCapacityMeter,
  resolveDivisionCategory,
  deriveAgeBand,
} from "@/components/registration-hub-row-derive";

describe("formatRegistrationWindow — org timezone, not browser/server local", () => {
  // Hand-verified: 2026-01-15T10:00:00Z in Asia/Kolkata (UTC+5:30, no DST) is
  // 15:30 local, and `fmtZoneAbbrev` resolves that zone's ICU "GMT+5:30" to
  // "IST" via its DST-free table (lib/format.ts) — so this can only pass if
  // the org's own tz was actually threaded through, not defaulted to UTC or
  // whatever zone the test runner happens to be in.
  const OPENS = "2026-01-15T10:00:00Z";
  const CLOSES = "2026-01-20T10:00:00Z";

  it("formats a two-sided window in the given org tz, with the zone labelled", () => {
    const label = formatRegistrationWindow(OPENS, CLOSES, "Asia/Kolkata");
    expect(label.kind).toBe("range");
    expect(label.opens).toBe("15 Jan 2026, 15:30");
    expect(label.closes).toBe("20 Jan 2026, 15:30");
    expect(label.zone).toBe("IST");
  });

  it("renders the SAME instant differently in a different org tz", () => {
    const kolkata = formatRegistrationWindow(OPENS, null, "Asia/Kolkata");
    const utc = formatRegistrationWindow(OPENS, null, "UTC");
    expect(kolkata.opens).not.toBe(utc.opens);
    expect(utc.opens).toBe("15 Jan 2026, 10:00");
  });

  it("is opens-only when there is no closes_at", () => {
    const label = formatRegistrationWindow(OPENS, null, "UTC");
    expect(label.kind).toBe("opens");
    expect(label.opens).toBe("15 Jan 2026, 10:00");
    expect(label.closes).toBeUndefined();
  });

  it("is closes-only when there is no opens_at", () => {
    const label = formatRegistrationWindow(null, CLOSES, "UTC");
    expect(label.kind).toBe("closes");
    expect(label.closes).toBe("20 Jan 2026, 10:00");
    expect(label.opens).toBeUndefined();
  });

  it("is 'none' when neither bound is set", () => {
    const label = formatRegistrationWindow(null, null, "UTC");
    expect(label.kind).toBe("none");
    expect(label.opens).toBeUndefined();
    expect(label.closes).toBeUndefined();
  });
});

describe("deriveCapacityMeter", () => {
  it("computes a percent fill against a set capacity", () => {
    expect(deriveCapacityMeter(5, 20)).toEqual({ count: 5, capacity: 20, percent: 25 });
  });

  it("renders sensibly with capacity null — no NaN, no divide-by-zero", () => {
    expect(deriveCapacityMeter(5, null)).toEqual({ count: 5, capacity: null, percent: null });
  });

  it("clamps an over-capacity count (waitlisted spot holders) to 100%", () => {
    expect(deriveCapacityMeter(25, 20)).toEqual({ count: 25, capacity: 20, percent: 100 });
  });

  it("treats a non-positive capacity (defensive — DB CHECK forbids it) as unlimited", () => {
    expect(deriveCapacityMeter(3, 0)).toEqual({ count: 3, capacity: 0, percent: null });
  });
});

describe("resolveDivisionCategory", () => {
  it("returns the explicit category unchanged", () => {
    expect(resolveDivisionCategory("mixed")).toBe("mixed");
  });

  it("treats a null category as open — never renders the literal null", () => {
    expect(resolveDivisionCategory(null)).toBe("open");
  });
});

describe("deriveAgeBand", () => {
  it("is a two-sided range when both bounds are set", () => {
    expect(deriveAgeBand(10, 18)).toEqual({ kind: "range", min: 10, max: 18 });
  });

  it("is min-only (a floor, no ceiling) when only age_min is set", () => {
    expect(deriveAgeBand(35, null)).toEqual({ kind: "min", min: 35 });
  });

  it("is max-only (a ceiling, no floor) when only age_max is set", () => {
    expect(deriveAgeBand(null, 12)).toEqual({ kind: "max", max: 12 });
  });

  it("is 'none' when neither bound is set", () => {
    expect(deriveAgeBand(null, null)).toEqual({ kind: "none" });
  });
});
