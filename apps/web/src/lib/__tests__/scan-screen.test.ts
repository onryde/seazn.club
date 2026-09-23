// Scorer sheets §4.5 — the scan page's one table, read top to bottom. Empty
// case first (the everyday scan), then each row whose right answer differs
// from the wrong answer's constant.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deadLinkKey, fixtureTimeLabel, scanScreen } from "../scan-screen";

const ddl = readFileSync(
  resolve(import.meta.dirname, "../../../../../db/migration/v2-engine/tables/V214__fixtures.sql"),
  "utf8",
);
const STATUSES = [...ddl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)![1]!.matchAll(/'([a-z_]+)'/g)].map(
  (m) => m[1]!,
);

describe("scanScreen (scorer sheets §4.5)", () => {
  it("the everyday case first: scheduled, both sides known, not carried → Confirm (never the pad)", () => {
    expect(scanScreen({ status: "scheduled", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({
      screen: "confirm",
    });
  });

  it("in_play skips Confirm straight to the pad", () => {
    expect(scanScreen({ status: "in_play", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({
      screen: "pad",
    });
  });

  it("a TBD side while scheduled → Waiting, whichever side", () => {
    for (const [h, a] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      expect(scanScreen({ status: "scheduled", homeKnown: h, awayKnown: a, carriedForward: false })).toEqual({
        screen: "waiting",
      });
    }
  });

  it("finalized / cancelled / carried → View-only with their own reason, even with a TBD side", () => {
    expect(scanScreen({ status: "finalized", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({
      screen: "view_only",
      reason: "finalized",
    });
    expect(scanScreen({ status: "cancelled", homeKnown: false, awayKnown: true, carriedForward: false })).toEqual({
      screen: "view_only",
      reason: "cancelled",
    });
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: true })).toEqual({
      screen: "view_only",
      reason: "carried_forward",
    });
  });

  it("a settled one-sided fixture (a bye) is 'no opponent' — never Waiting forever (Review Focus 5)", () => {
    expect(scanScreen({ status: "forfeited", homeKnown: true, awayKnown: false, carriedForward: false })).toEqual({
      screen: "view_only",
      reason: "no_opponent",
    });
  });

  it("decided but not carried → the pad (the umpire's own undo window)", () => {
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({
      screen: "pad",
    });
  });

  it("every fixture status in the schema has an answer for both sides known and not carried", () => {
    // The DDL parse must find the whole set, or the loop below proves nothing.
    expect(STATUSES).toEqual(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]);
    for (const status of STATUSES) {
      expect(scanScreen({ status, homeKnown: true, awayKnown: true, carriedForward: false }).screen).toMatch(
        /^(confirm|pad|view_only)$/,
      );
    }
  });
});

describe("deadLinkKey", () => {
  it("maps each resolver code to its own copy; anything else is 'invalid'", () => {
    expect(deadLinkKey("LINK_REVOKED")).toBe("device.dead.revoked");
    expect(deadLinkKey("LINK_EXPIRED")).toBe("device.dead.expired");
    expect(deadLinkKey("LINK_INVALID")).toBe("device.dead.invalid");
    expect(deadLinkKey(null)).toBe("device.dead.invalid");
    // A prototype key is not a resolver code.
    expect(deadLinkKey("constructor")).toBe("device.dead.invalid");
    expect(deadLinkKey("toString")).toBe("device.dead.invalid");
  });
});

describe("fixtureTimeLabel", () => {
  it("renders in the VENUE tz, not UTC — 10:30Z shows as 22:30 in Auckland", () => {
    const label = fixtureTimeLabel("2026-09-23T10:30:00Z", "Pacific/Auckland", "en-GB");
    expect(label).toContain("22:30");
    expect(label).not.toContain("10:30");
    expect(fixtureTimeLabel(null, "UTC", "en-GB")).toBeNull();
  });
});
