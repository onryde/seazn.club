import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { statusLine, type StatusLineInput } from "@/lib/division-status-line";

const base: StatusLineInput = {
  phase: "scheduled", played: 10, total: 15, unscheduled: 0, inPlay: 0, entrants: 6,
  next: { scheduledAt: "2026-09-12T09:00:00Z", home: "Lakeside FC", away: "Harbour CC" },
  needsDrawStageName: null, locale: "en", displayTz: "Europe/London",
};

describe("statusLine", () => {
  it("finished never says nothing scheduled", () => {
    const s = statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null });
    expect(s).toBe("15 of 15 played · complete");
    expect(s).not.toMatch(/nothing scheduled/i);
  });
  it("setting up with a pending draw names the stage", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 28, total: 28, needsDrawStageName: "Finals", next: null });
    expect(s).toBe("28 of 28 played · Finals not drawn");
  });
  it("setting up without a draw counts entrants", () => {
    expect(statusLine(en, { ...base, phase: "setting_up", played: 0, total: 0, next: null })).toBe("Setting up · 6 entrants");
  });
  it("match day counts in play and appends unscheduled", () => {
    expect(statusLine(en, { ...base, phase: "match_day", inPlay: 2, unscheduled: 3 })).toBe("10 of 15 played · 2 in play · 3 unscheduled");
  });
  it("scheduled leads with the next kick-off in the display zone", () => {
    expect(statusLine(en, base)).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  it("scheduled with no next fixture says so once, plainly", () => {
    expect(statusLine(en, { ...base, next: null })).toBe("10 of 15 played · nothing scheduled");
  });
});
