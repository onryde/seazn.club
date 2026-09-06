import { describe, expect, it } from "vitest";
import { fixtureSubheading } from "../fixture-subheading";

describe("fixtureSubheading", () => {
  it("says Live instead of Time TBD for an in-play fixture with no scheduled time", () => {
    expect(fixtureSubheading("in_play", null)).toBe("Live");
  });

  it("still says Time TBD for a scheduled fixture with no scheduled time", () => {
    expect(fixtureSubheading("scheduled", null)).toBe("Time TBD");
  });

  it("shows the formatted date whenever a scheduled time exists, regardless of status", () => {
    const result = fixtureSubheading("in_play", "2026-07-20T14:30:00.000Z");
    expect(result).not.toBe("Time TBD");
    expect(result).not.toBe("Live");
  });

  // Task 14 — the page now passes the localised `matchCentre.status.live`
  // word instead of relying on the bare English default.
  it("uses the given liveLabel for an in-play fixture with no scheduled time", () => {
    expect(fixtureSubheading("in_play", null, "En direct")).toBe("En direct");
  });

  it("ignores liveLabel for a non-live status (still Time TBD)", () => {
    expect(fixtureSubheading("scheduled", null, "En direct")).toBe("Time TBD");
  });
});
