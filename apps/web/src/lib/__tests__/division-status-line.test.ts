import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { statusLine, whenLabel, type StatusLineInput } from "@/lib/division-status-line";

const base: StatusLineInput = {
  phase: "scheduled", played: 10, total: 15, unscheduled: 0, inPlay: 0, entrants: 6,
  next: { scheduledAt: "2026-09-12T09:00:00Z", home: "Lakeside FC", away: "Harbour CC" },
  needsDrawStageName: null, locale: "en", displayTz: "Europe/London", orgTz: "Europe/London",
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
  // fix-round-c, Defect 1 (owner ruling): `desk.status.noNext` ("nothing
  // scheduled") is retired everywhere — the reproduced live defect was this
  // exact fallback printed beside a "Scheduled" pill. `scheduled` with no
  // usable `next` instant now states the progress instead, same as
  // `setting_up`/`match_day`'s own no-more-specific-fact fallback.
  it("scheduled with no next fixture states the progress, never 'nothing scheduled'", () => {
    const s = statusLine(en, { ...base, next: null });
    expect(s).toBe("10 of 15 played");
    expect(s).not.toMatch(/nothing scheduled/i);
  });
  it("scheduled with a malformed next time falls back to the progress line, never throws", () => {
    const s = statusLine(en, { ...base, next: { scheduledAt: "not-a-date", home: "A", away: "B" } });
    expect(s).toBe("10 of 15 played");
    expect(s).not.toMatch(/nothing scheduled/i);
  });
  // fix-round-c, Defect 1: the exact live repro — a knockout final carries a
  // date but its entrants are still TBD, so card-stats.ts's `next` query
  // excludes it; the phase is "scheduled" (division-phase.ts rule 5 doesn't
  // care about entrants) but `next` itself is null. Reproduced live before
  // this fix: "0 of 3 played · nothing scheduled · 2 unscheduled" next to a
  // "Scheduled" pill.
  it("scheduled with a TBD-entrant dated fixture (next is null) states progress plus unscheduled, never the contradiction", () => {
    const s = statusLine(en, { ...base, played: 0, total: 3, unscheduled: 2, next: null });
    expect(s).toBe("0 of 3 played · 2 unscheduled");
    expect(s).not.toMatch(/nothing scheduled/i);
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
  // Brief's exact demand: "its status line must not contain any 'nothing
  // scheduled' wording in ANY locale" — the translated equivalents, not just
  // the English string, since a leftover ES/FR/NL copy of the old key's
  // wording living under a different key would pass the English-only check
  // above.
  it("scheduled with no usable next date never says 'nothing scheduled' in any locale", () => {
    const NOTHING_SCHEDULED = {
      en: /nothing scheduled/i,
      es: /nada programado/i,
      fr: /rien de planifi/i,
      nl: /niets gepland/i,
    };
    for (const [name, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
      const s = statusLine(dict, { ...base, next: null, locale: name });
      expect(s, name).not.toMatch(NOTHING_SCHEDULED[name]);
    }
  });
  it("finished never appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, phase: "finished", played: 15, total: 15, next: null, unscheduled: 3 })).toBe("15 of 15 played · complete");
  });
  it("scheduled appends the unscheduled suffix", () => {
    expect(statusLine(en, { ...base, unscheduled: 2 })).toBe("Next Sat 12 Sep 10:00 · 10 of 15 played · 2 unscheduled");
  });
});

// fix-round-c, Defect (c): the masthead's own date ladder step
// (competition-desk.ts's `nextDateLabel`) always used the org zone; a row's
// `whenLabel` used to take ONE tz for both halves (`displayTz`), so the two
// could name a different DAY on the same screen for a venue in a different
// zone from the org. 2026-09-12T23:30:00Z is chosen because the two zones
// below disagree on the DAY it falls on: Sun 13 Sep in Europe/London (BST,
// UTC+1 pushes it past midnight) vs Sat 12 Sep in Pacific/Honolulu (UTC-10).
describe("whenLabel", () => {
  const AT = "2026-09-12T23:30:00Z";
  it("takes the DAY from the org zone and the CLOCK from the display zone, even when they disagree", () => {
    expect(whenLabel(AT, "en", "Europe/London", "Pacific/Honolulu")).toBe("Sun 13 Sep 13:30");
  });
  it("regression guard: the date half must NOT come from the display zone", () => {
    // The pre-fix behaviour (single tz for both halves) would have produced
    // "Sat 12 Sep 13:30" here — Honolulu's own day name, not London's.
    expect(whenLabel(AT, "en", "Europe/London", "Pacific/Honolulu")).not.toBe("Sat 12 Sep 13:30");
  });
  it("agrees with a same-zone call when org and display coincide (the common case)", () => {
    expect(whenLabel(AT, "en", "Europe/London", "Europe/London")).toBe("Sun 13 Sep 00:30");
  });
});
