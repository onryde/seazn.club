// Scorer sheets §4.5 — the scan page's one table, read top to bottom. Empty
// case first (the everyday scan), then each row whose right answer differs
// from the wrong answer's constant.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deadLinkKey, fixtureTimeLabel, scanScreen } from "../scan-screen";
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
    for (const status of STATUSES) {
      expect(scanScreen({ status, homeKnown: true, awayKnown: true, carriedForward: false, divisionStatus: "active" }).screen).toMatch(
        /^(confirm|pad|view_only)$/,
      );
    }
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
