// Scorer sheets §4.5 — the scan page's one table, read top to bottom. Empty
// case first (the everyday scan), then each row whose right answer differs
// from the wrong answer's constant.
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { askFreshLinkKey, deadLinkKey, decidedKey, fixtureTimeLabel, scanScreen, VIEW_ONLY_COPY, viewOnlyKey, type ViewOnlyReason } from "../scan-screen";
import { divisionScoringClosed } from "../division-phase";

const ddl = readFileSync(
  resolve(import.meta.dirname, "../../../../../db/migration/v2-engine/tables/V214__fixtures.sql"),
  "utf8",
);
const STATUSES = [...ddl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)![1]!.matchAll(/'([a-z_]+)'/g)].map(
  (m) => m[1]!,
);

describe("scanScreen (scorer sheets §4.5)", () => {
  it("the everyday case first: scheduled, both sides known, not carried → Confirm (never the pad)", () => {
    expect(scanScreen({ status: "scheduled", homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "confirm",
    });
  });

  it("in_play skips Confirm straight to the pad", () => {
    expect(scanScreen({ status: "in_play", homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "pad",
    });
  });

  it("a TBD side while scheduled → Waiting, whichever side", () => {
    for (const [h, a] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      expect(scanScreen({ status: "scheduled", homeKnown: h, awayKnown: a, carriedForward: false, divisionStatus: "active" })).toEqual({
        screen: "waiting",
      });
    }
  });

  it("finalized / cancelled / carried → View-only with their own reason, even with a TBD side", () => {
    expect(scanScreen({ status: "finalized", homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "view_only",
      reason: "finalized",
    });
    expect(scanScreen({ status: "cancelled", homeKnown: false, awayKnown: true, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "view_only",
      reason: "cancelled",
    });
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: true, divisionStatus: "active" })).toEqual({
      screen: "view_only",
      reason: "carried_forward",
    });
  });

  it("a settled one-sided fixture (a bye) is 'no opponent' — never Waiting forever (Review Focus 5)", () => {
    expect(scanScreen({ status: "forfeited", homeKnown: true, awayKnown: false, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "view_only",
      reason: "no_opponent",
    });
  });

  it("decided but not carried → the pad (the umpire's own undo window)", () => {
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" })).toEqual({
      screen: "pad",
    });
  });

  it("every fixture status in the schema has an answer for both sides known and not carried", () => {
    // The DDL parse must find the whole set, or the loop below proves nothing.
    expect(STATUSES).toEqual(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]);
    // W2a: V432 widens the check with `needs_decision`; FIXTURE_STATUSES is held to V432's constraint by
    // v432-needs-decision-migration.test.ts, and must contain every V214 value.
    expect(STATUSES.filter((s) => !(FIXTURE_STATUSES as readonly string[]).includes(s))).toEqual([]);
    let checked = 0;
    for (const status of FIXTURE_STATUSES) {
      checked++;
      expect(scanScreen({ status, homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" }).screen).toMatch(
        /^(confirm|pad|view_only)$/,
      );
    }
    expect(checked).toBe(STATUSES.length + 1);
  });
});

// Owner-approved fix 2026-09-24: a sheet scanned before the organiser starts
// the division opened on Confirm, and its Start was refused with the generic
// WRONG_PHASE copy. The scan now opens on "Not started yet" whenever the
// scoring door would refuse on the division — the same predicate, so the
// screen and the door cannot disagree.
const divisionDdl = readFileSync(
  resolve(import.meta.dirname, "../../../../../db/migration/v2-engine/tables/V209__divisions.sql"),
  "utf8",
);
const DIVISION_STATUSES = [
  ...divisionDdl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)![1]!.matchAll(/'([a-z_]+)'/g),
].map((m) => m[1]!);

describe("scanScreen: a division the organiser has not started (owner fix 2026-09-24)", () => {
  const everyday = { status: "scheduled", homeKnown: true, awayKnown: true, carriedForward: false };

  it("the edge case first: a STARTED division changes nothing — only setup and scheduled read as not started", () => {
    // The DDL parse must find the whole set, or the sweep below proves nothing.
    expect(DIVISION_STATUSES).toEqual(["setup", "scheduled", "active", "completed"]);
    const answers = Object.fromEntries(
      DIVISION_STATUSES.map((divisionStatus) => [divisionStatus, scanScreen({ ...everyday, divisionStatus }).screen]),
    );
    expect(answers).toEqual({
      setup: "division_not_started",
      scheduled: "division_not_started",
      active: "confirm",
      completed: "confirm",
    });
  });

  // `divisionScoringClosed` is what usecases/scoring.ts refuses WRONG_PHASE on
  // (its setup/scheduled refusals are pinned in integration.test.ts and
  // schedule.test.ts), so this is the screen agreeing with the door.
  it("…and answers exactly as `divisionScoringClosed` does, on every status and on junk", () => {
    for (const divisionStatus of [...DIVISION_STATUSES, "", "archived"]) {
      expect(
        scanScreen({ ...everyday, divisionStatus }).screen === "division_not_started",
        `division ${JSON.stringify(divisionStatus)}`,
      ).toBe(divisionScoringClosed(divisionStatus));
    }
  });

  // Precedence, one differential per neighbour: each case's right answer
  // differs from what the wrong order would return.
  it("View-only outranks it: finalized, cancelled, carried and no-opponent keep their own words", () => {
    expect(scanScreen({ ...everyday, status: "finalized", divisionStatus: "setup" })).toEqual({
      screen: "view_only",
      reason: "finalized",
    });
    expect(scanScreen({ ...everyday, status: "cancelled", divisionStatus: "scheduled" })).toEqual({
      screen: "view_only",
      reason: "cancelled",
    });
    expect(scanScreen({ ...everyday, status: "decided", carriedForward: true, divisionStatus: "setup" })).toEqual({
      screen: "view_only",
      reason: "carried_forward",
    });
    // A bye is settled at generate time, before any start: it is still "no
    // opponent", never "not started" forever.
    expect(scanScreen({ ...everyday, status: "forfeited", awayKnown: false, divisionStatus: "setup" })).toEqual({
      screen: "view_only",
      reason: "no_opponent",
    });
  });

  it("it outranks Waiting: a TBD side in an unstarted division says the division has not started", () => {
    expect(scanScreen({ ...everyday, homeKnown: false, divisionStatus: "setup" })).toEqual({
      screen: "division_not_started",
    });
    expect(scanScreen({ ...everyday, homeKnown: false, divisionStatus: "active" }), "the pair: started → Waiting").toEqual({
      screen: "waiting",
    });
  });

  it("it outranks Confirm and the pad: nothing the door would refuse is offered", () => {
    expect(scanScreen({ ...everyday, divisionStatus: "scheduled" })).toEqual({ screen: "division_not_started" });
    expect(scanScreen({ ...everyday, status: "in_play", divisionStatus: "setup" })).toEqual({
      screen: "division_not_started",
    });
    expect(scanScreen({ ...everyday, status: "in_play", divisionStatus: "active" }), "the pair: started → the pad").toEqual({
      screen: "pad",
    });
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

// OWNER RULING 2026-09-24 (copy): "carried forward" is organiser jargon; the
// umpire reads where the result went. The ruling IS the source, so the English
// is pinned verbatim here; the other locales are translations of it and must
// not fall back to the old wording's jargon.
describe("the carried-forward View-only copy (owner ruling 2026-09-24)", () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(resolve(import.meta.dirname, `../../dictionaries/${locale}/ui.json`), "utf8")) as Record<
      string,
      string
    >;
  it("English says where the result went, in the owner's words", () => {
    expect(load("en")["device.scan.viewOnly.carried"]).toBe(
      "Match over — the result has already moved to the next match. Ask the organiser to correct it.",
    );
  });
  it.each(["fr", "es", "nl"])("%s names the next match, never the old 'carried forward' wording", (locale) => {
    const text = load(locale)["device.scan.viewOnly.carried"]!;
    expect(text).not.toBe(load("en")["device.scan.viewOnly.carried"]);
    expect(text.toLowerCase(), "no English jargon left behind").not.toContain("carried");
    const nextMatch = ({ fr: "match suivant", es: "siguiente partido", nl: "volgende wedstrijd" } as Record<string, string>)[
      locale
    ]!;
    expect(text, "the translation names the next match").toContain(nextMatch);
  });
});

// Quick match (branch-fix A review Q1/Q2, controller rulings 2026-11-12): a guest's pad has no organiser, so no line it
// shows sends the guest to one; each says what a guest can do instead. Copy only: the screen each reason opens is the
// shared table's.
describe("the quick match's pad copy: no organiser to ask (review Q1/Q2)", () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(resolve(import.meta.dirname, `../../dictionaries/${locale}/ui.json`), "utf8")) as Record<
      string,
      string
    >;
  const REASONS = Object.keys(VIEW_ONLY_COPY) as ViewOnlyReason[];
  /** The organiser, in each language's own word (the strings the ordinary copy uses). */
  const ORGANISER: Record<string, RegExp> = { en: /organi[sz]er/i, es: /organizador/i, fr: /organisateur/i, nl: /organisator/i };

  it("the rulings' English, verbatim", () => {
    const en = load("en");
    // Whole review m4: sport-neutral (it said "undo the last point" under a cricket chase); it names the button beside it.
    expect(en["device.quickMatch.resultSaved"]).toBe("Result saved. To correct it, void your last entry and record it again.");
    expect(en["device.quickMatch.resultLocked"]).toBe("This result can't change: the next round has already started.");
    expect(en["device.quickMatch.finished"]).toBe("This match is finished.");
    expect(en["device.quickMatch.askFreshLink"]).toBe("Go back to the quick match and tap Score again.");
  });

  it("the decided line says no racket word in any locale: a cricket or football guest reads it too (whole review m4)", () => {
    // Each language's own word for a rally point, the word the old line used.
    const POINT: Record<string, RegExp> = { en: /\bpoint\b/i, es: /\bpunto\b/i, fr: /\bpoint\b/i, nl: /\bpunt\b/i };
    let checked = 0;
    for (const [locale, word] of Object.entries(POINT)) {
      const line = load(locale)["device.quickMatch.resultSaved"];
      expect(line, `${locale}: present`).toBeTruthy();
      expect(line, locale).not.toMatch(word);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("an ordinary pad keeps every reason's own copy, the organiser's decided line and its fresh-link hint (the negative pair)", () => {
    let checked = 0;
    for (const reason of REASONS) {
      expect(viewOnlyKey(reason, false), reason).toBe(VIEW_ONLY_COPY[reason]);
      checked++;
    }
    expect(checked, "anti-vacuity: every View-only reason").toBe(4);
    expect(decidedKey(false)).toBe("device.resultRecorded");
    expect(askFreshLinkKey(false)).toBe("device.askFreshLink");
  });

  it("a quick match's pad: carried forward reads as locked, finalized as finished, cancelled as Not played, decided as saved, a dead link as go back; no opponent is unchanged", () => {
    expect(viewOnlyKey("carried_forward", true)).toBe("device.quickMatch.resultLocked");
    expect(viewOnlyKey("finalized", true)).toBe("device.quickMatch.finished");
    // Quick match plan 4 (T1 review G1, controller ruling 2026-11-13): the only way a guest's match becomes `cancelled` is
    // the skip, so a pad left open on it says Not played and how to put it back, never "cancelled".
    expect(viewOnlyKey("cancelled", true)).toBe("device.quickMatch.notPlayed");
    expect(decidedKey(true)).toBe("device.quickMatch.resultSaved");
    expect(askFreshLinkKey(true)).toBe("device.quickMatch.askFreshLink");
    const others = REASONS.filter((r) => r !== "carried_forward" && r !== "finalized" && r !== "cancelled");
    expect(others, "premise: the one reason a quick match keeps the ordinary words for").toEqual(["no_opponent"]);
    for (const reason of others) expect(viewOnlyKey(reason, true), reason).toBe(VIEW_ONLY_COPY[reason]);
  });

  it("the Not played line, verbatim, is the home's own Score refusal: one sentence on the pad and on the home (T1 G1)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      const d = load(locale);
      expect(d["device.quickMatch.notPlayed"], locale).toBeTruthy();
      expect(d["device.quickMatch.notPlayed"], locale).toBe(d["quickMatch.flash.notPlayed"]);
      checked++;
    }
    expect(checked).toBe(4);
    expect(load("en")["device.quickMatch.notPlayed"]).toBe(
      "This match was marked Not played. Put it back from the match list to score it.",
    );
  });

  /** Every line these helpers give a quick match's pad: each View-only reason, the decided line, and the dead-link
   *  screen's headlines (each resolver code, an unknown one, a deleted match) with its hint. */
  const quickMatchKeys = (): string[] => [
    ...REASONS.map((r) => viewOnlyKey(r, true)),
    decidedKey(true),
    ...["LINK_REVOKED", "LINK_EXPIRED", null].map((code) => deadLinkKey(code)),
    "device.dead.gone",
    askFreshLinkKey(true),
  ];

  it.each(["en", "es", "fr", "nl"])("%s: no line a quick match's pad shows names an organiser, where the ordinary ones do", (locale) => {
    const d = load(locale);
    let checked = 0;
    for (const key of quickMatchKeys()) {
      expect(d[key], `${locale} ${key}`).toBeTruthy();
      expect(d[key], `${locale} ${key}`).not.toMatch(ORGANISER[locale]!);
      checked++;
    }
    expect(checked, "anti-vacuity: four reasons, the decided line, four dead-link headlines, its hint").toBe(10);
    // The positive pair: the word the check looks for IS in each language's ordinary copy, so the check can fail.
    for (const key of [VIEW_ONLY_COPY.carried_forward, VIEW_ONLY_COPY.finalized, "device.resultRecorded", "device.askFreshLink"]) {
      expect(d[key], `${locale} ${key}`).toMatch(ORGANISER[locale]!);
    }
  });
});
