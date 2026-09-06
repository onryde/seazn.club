import { describe, expect, it } from "vitest";
import { fixtureSubheading } from "../fixture-subheading";

describe("fixtureSubheading", () => {
  // R11 fix round, C3 — the court card directly below this line already
  // carries a LIVE chip (`CourtCard`'s `mc-live-pill`) for `in_play`, so the
  // subheading must NOT repeat the bare word "Live" any more. Mutant: revert
  // the `in_play` branch back to returning a live label → this reds.
  it("returns an EMPTY string for an in-play fixture with no scheduled time — the court card already shows LIVE", () => {
    expect(fixtureSubheading("in_play", null)).toBe("");
  });

  it("still says Time TBD for a scheduled fixture with no scheduled time", () => {
    expect(fixtureSubheading("scheduled", null)).toBe("Time TBD");
  });

  it("still says Time TBD for a decided/other-status fixture with no scheduled time (the card shows a DIFFERENT fact, not this one)", () => {
    expect(fixtureSubheading("decided", null)).toBe("Time TBD");
    expect(fixtureSubheading("other", null)).toBe("Time TBD");
  });

  it("shows the formatted date whenever a scheduled time exists, regardless of status", () => {
    const result = fixtureSubheading("in_play", "2026-07-20T14:30:00.000Z");
    expect(result).not.toBe("Time TBD");
    expect(result).not.toBe("");
  });

  // Task 14b (task-14-review.md OWED item 2) — "Time TBD" was hardcoded
  // English; `timeTbdLabel` is opt-in localisation, so a caller with no
  // locale in hand (or an existing test calling with two args) keeps
  // reading exactly as before.
  it("uses the given timeTbdLabel for a non-live status with no scheduled time", () => {
    expect(fixtureSubheading("scheduled", null, "Heure à déterminer")).toBe("Heure à déterminer");
  });

  it("ignores timeTbdLabel for an in-play fixture (still empty)", () => {
    expect(fixtureSubheading("in_play", null, "Heure à déterminer")).toBe("");
  });
});
