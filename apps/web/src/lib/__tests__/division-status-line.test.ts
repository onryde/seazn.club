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

  // The first entrant an organiser adds read "1 entrants" until the key was
  // split — the singular is the state this line is MOST often seen in.
  it("setting up says one entrant, not one entrants", () => {
    expect(statusLine(en, { ...base, phase: "setting_up", played: 0, total: 0, entrants: 1, next: null })).toBe("Setting up · 1 entrant");
  });

  it("setting up keeps the plural for every other count", () => {
    expect(statusLine(en, { ...base, phase: "setting_up", played: 0, total: 0, entrants: 0, next: null })).toBe("Setting up · 0 entrants");
    expect(statusLine(en, { ...base, phase: "setting_up", played: 0, total: 0, entrants: 2, next: null })).toBe("Setting up · 2 entrants");
  });
  it("match day counts in play and appends unscheduled", () => {
    expect(statusLine(en, { ...base, phase: "match_day", inPlay: 2, unscheduled: 3 })).toBe("10 of 15 played · 2 in play · 3 unscheduled");
  });
  it("match day minor fix: zero in play is an empty cell, not '0 in play'", () => {
    const s = statusLine(en, { ...base, phase: "match_day", inPlay: 0, next: null });
    expect(s).toBe("10 of 15 played");
    expect(s).not.toMatch(/in play/);
  });
  it("match day with zero in play still appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, phase: "match_day", inPlay: 0, unscheduled: 2, next: null })).toBe("10 of 15 played · 2 unscheduled");
  });

  // F1 fix (final review, Critical): setting_up is now reachable for a
  // division that already has fixtures (division-phase.ts rule 5's
  // fallback) — the live defect was a "Scheduled" pill next to "nothing
  // scheduled" text; this pins the replacement copy and the hard
  // requirement that the two facts never contradict each other again.
  it("setting up with fixtures states the played count, not the entrant count", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 0, total: 6, entrants: 4, next: null });
    expect(s).toBe("0 of 6 played");
    expect(s).not.toContain("Setting up");
    expect(s).not.toContain("entrant");
  });
  it("setting up with fixtures appends the unscheduled suffix and never says nothing scheduled", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 0, total: 6, unscheduled: 6, next: null });
    expect(s).toBe("0 of 6 played · 6 unscheduled");
    expect(s).not.toMatch(/nothing scheduled/i);
  });
  it("setting up with SOME fixtures played still states the count, not entrants", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 2, total: 6, unscheduled: 4, next: null });
    expect(s).toBe("2 of 6 played · 4 unscheduled");
  });
  it("scheduled leads with the next kick-off in the display zone", () => {
    expect(statusLine(en, base)).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  it("scheduled with no next fixture says so once, plainly", () => {
    expect(statusLine(en, { ...base, next: null })).toBe("10 of 15 played · nothing scheduled");
  });
  it("scheduled with a malformed next time falls back to the no-next line, never throws", () => {
    expect(
      statusLine(en, { ...base, next: { scheduledAt: "not-a-date", home: "A", away: "B" } }),
    ).toBe("10 of 15 played · nothing scheduled");
  });
  it("finished never appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null, unscheduled: 3 })).toBe("15 of 15 played · complete");
  });
  it("scheduled appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, unscheduled: 2 })).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played · 2 unscheduled");
  });
});
