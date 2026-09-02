import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { statusLine, whenLabel, type StatusLineInput } from "@/lib/division-status-line";

const base: StatusLineInput = {
  phase: "scheduled", played: 10, total: 15, unscheduled: 0, inPlay: 0, entrants: 6,
  next: { scheduledAt: "2026-09-12T09:00:00Z", home: "Lakeside FC", away: "Harbour CC" },
  needsDrawStageName: null, locale: "en", displayTz: "Europe/London",
  // G1 fix: `now` fixed well before `next.scheduledAt` above, so the
  // existing "scheduled leads with the next kick-off" cases below keep
  // reading as future without each one having to restate it.
  now: "2026-09-05T09:00:00Z",
};

describe("statusLine", () => {
  it("finished states played/total", () => {
    const s = statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null });
    expect(s).toBe("15 of 15 played · complete");
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
  // English cannot witness this: its adjectives do not inflect, so " · 1
  // unscheduled" reads correctly against BOTH the singular and plural key.
  // French does inflect, and the hardcoded plural rendered "1 non planifiés"
  // on a live page. The French case is the one that can fail.
  it("the unscheduled suffix agrees with its count, in a locale that inflects", async () => {
    const fr = (await import("@/dictionaries/fr/ui.json")).default as unknown as typeof en;
    const one = statusLine(fr, { ...base, phase: "match_day", inPlay: 0, unscheduled: 1, next: null, locale: "fr" });
    const many = statusLine(fr, { ...base, phase: "match_day", inPlay: 0, unscheduled: 3, next: null, locale: "fr" });
    expect(one).toContain("1 non planifié");
    expect(one).not.toContain("non planifiés");
    expect(many).toContain("3 non planifiés");
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
  it("setting up with fixtures appends the unscheduled suffix", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 0, total: 6, unscheduled: 6, next: null });
    expect(s).toBe("0 of 6 played · 6 unscheduled");
  });
  it("setting up with SOME fixtures played still states the count, not entrants", () => {
    const s = statusLine(en, { ...base, phase: "setting_up", played: 2, total: 6, unscheduled: 4, next: null });
    expect(s).toBe("2 of 6 played · 4 unscheduled");
  });
  it("scheduled leads with the next kick-off in the display zone", () => {
    expect(statusLine(en, base)).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  // fix-round-c, Defect 1 (owner ruling): `desk.status.noNext` ("nothing
  // scheduled") is retired everywhere — the reproduced live defect was this
  // exact fallback printed beside a "Scheduled" pill. `scheduled` with no
  // usable `next` instant now states the progress instead, same as
  // `setting_up`/`match_day`'s own no-more-specific-fact fallback.
  it("scheduled with no next fixture states the progress", () => {
    const s = statusLine(en, { ...base, next: null });
    expect(s).toBe("10 of 15 played");
  });
  it("scheduled with a malformed next time falls back to the progress line, never throws", () => {
    const s = statusLine(en, { ...base, next: { scheduledAt: "not-a-date", home: "A", away: "B" } });
    expect(s).toBe("10 of 15 played");
  });
  // G1 fix (fix round D, Critical): `StatusLineInput` had NO `now` field at
  // all — this arm could not ask "is this kick-off still ahead of us?" and
  // rendered a PAST kick-off as "Next …" directly beside a Needs-you row
  // reading "the match window has passed" for the SAME fixture (F5's own
  // symptom, reached live at the one consumer F5 never guarded). Mirrors
  // division-ledger.tsx's own F5 guard on `nextLine`.
  it("G1: a past kick-off falls back to the progress line, never renders as Next", () => {
    const s = statusLine(en, {
      ...base, now: "2026-09-05T09:00:00Z",
      next: { scheduledAt: "2026-09-01T11:00:00Z", home: "Riverside FC", away: "Harbour CC" },
    });
    expect(s).toBe("10 of 15 played");
    expect(s).not.toMatch(/next/i);
  });
  it("G1: a kick-off exactly AT now is still Next (the floor is inclusive, not strictly future)", () => {
    const s = statusLine(en, { ...base, now: "2026-09-12T09:00:00Z" });
    expect(s).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  it("G1: a kick-off one minute in the future still renders as Next", () => {
    const s = statusLine(en, { ...base, now: "2026-09-12T08:59:00Z" });
    expect(s).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played");
  });
  // fix-round-c, Defect 1: the exact live repro — a knockout final carries a
  // date but its entrants are still TBD, so card-stats.ts's `next` query
  // excludes it; the phase is "scheduled" (division-phase.ts rule 5 doesn't
  // care about entrants) but `next` itself is null. Reproduced live before
  // this fix: "0 of 3 played · nothing scheduled · 2 unscheduled" next to a
  // "Scheduled" pill.
  it("scheduled with a TBD-entrant dated fixture (next is null) states progress plus unscheduled", () => {
    const s = statusLine(en, { ...base, played: 0, total: 3, unscheduled: 2, next: null });
    expect(s).toBe("0 of 3 played · 2 unscheduled");
  });
  // fix-round-c: retired everywhere — pin the KEY's absence, not just one
  // rendering of it, so a re-add in any of the four dicts is caught even if
  // no arm of `statusLine` happens to reach it in a given test run.
  it("desk.status.noNext is retired from every locale dictionary", () => {
    // Dicts are FLAT-keyed (the key itself is the literal string
    // "desk.status.noNext", not a nested path) — `in` on the object, not
    // `toHaveProperty`'s dot-path parsing, which would misread this key.
    for (const [name, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
      expect("desk.status.noNext" in dict, name).toBe(false);
    }
  });
  it("finished never appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null, unscheduled: 3 })).toBe("15 of 15 played · complete");
  });
  it("scheduled appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, unscheduled: 2 })).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played · 2 unscheduled");
  });
});

// G2 fix (fix round D, Important — corrected ruling): fix-round-c's original
// rule ("date from the org zone, clock from the display zone") named an
// instant that could exist in NEITHER zone — measured live, org
// `Europe/London`, division `America/New_York`, `2026-09-06T23:00Z` rendered
// "Mon 7 Sept 19:00" where the venue truth is Sun 6 Sept 19:00. The
// corrected ruling: a rendered instant is formatted ENTIRELY in the display
// zone — the venue's own local time, both halves. 2026-09-12T23:30:00Z is
// kept as the probe instant because the two zones below still disagree on
// which DAY it falls on (Sun 13 Sep in Europe/London (BST) vs Sat 12 Sep in
// Pacific/Honolulu, UTC-10) — exactly the shape that would catch a
// regression back to splitting the label across two zones.
describe("whenLabel", () => {
  const AT = "2026-09-12T23:30:00Z";
  it("formats the WHOLE instant — day and clock — in the display zone alone", () => {
    expect(whenLabel(AT, "en", "Pacific/Honolulu")).toBe("Sat 12 Sep 13:30");
  });
  it("a different display zone names a different day AND a different clock face for the SAME instant", () => {
    expect(whenLabel(AT, "en", "Europe/London")).toBe("Sun 13 Sep 00:30");
  });
  // Regression guard: the pre-fix behaviour took the day from a SEPARATE org
  // zone. Passing London's day against Honolulu's clock is the exact
  // defect shape — the corrected function must never produce it.
  it("regression guard: never mixes one zone's day with a different zone's clock", () => {
    expect(whenLabel(AT, "en", "Pacific/Honolulu")).not.toBe("Sun 13 Sep 13:30");
  });
  // The G2 finding's own exact repro, at the function level: org
  // Europe/London / division America/New_York, instant 2026-09-06T23:00Z.
  // Venue truth is Sun 6 Sept 19:00 — the OLD two-zone rule rendered
  // "Mon 7 Sept 19:00" (Monday, from London's day).
  it("the G2 repro: the venue-local label, never the org-zone day appended to it", () => {
    const label = whenLabel("2026-09-06T23:00:00Z", "en", "America/New_York");
    expect(label).toBe("Sun 6 Sep 19:00");
    expect(label).not.toBe("Mon 7 Sep 19:00");
  });
});
