import { describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { buildMatchCentre, type MatchCentreInput } from "@/server/public-site/match-centre";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";
import type { PublicFixture } from "@/server/public-site/data";
import { fixtureSubheading, fixtureSubheadingLine } from "../fixture-subheading";

describe("fixtureSubheading", () => {
  // R11 fix round, C3 — the court card directly below this line already
  // carries a LIVE chip (`CourtCard`'s `mc-live-pill`) for `in_play`, so the
  // subheading must NOT repeat the bare word "Live" any more. Mutant: revert
  // the `in_play` branch back to returning a live label → this reds.
  it("returns an EMPTY string for an in-play fixture with no start time — the court card already shows LIVE", () => {
    expect(fixtureSubheading("in_play", null)).toBe("");
  });

  it("still says Time TBD for a scheduled fixture with no start time", () => {
    expect(fixtureSubheading("scheduled", null)).toBe("Time TBD");
  });

  // R11 phone read — this used to assert "Time TBD" for `decided`, which is
  // what `match-b-tab-scorecard-320.png` showed above an ENDED scorebug. "To
  // be determined" is a promise about the future; a played match is missing a
  // time, not awaiting one. The assertion is INVERTED here deliberately, not
  // relaxed: the old wording is now what must NOT appear.
  //
  // M1 k2 — `decided` is also the DOCUMENT's folded status (`statusOf` folds
  // `finalized` into it), so this one set covers both the raw fixture status
  // the fallback path passes and the folded one the live document carries.
  it("says the time was NOT RECORDED for a match that has already been played", () => {
    for (const status of ["decided", "finalized"]) {
      expect(fixtureSubheading(status, null), `${status} is a played match`).toBe("Time not recorded");
      expect(fixtureSubheading(status, null)).not.toBe("Time TBD");
    }
  });

  // The default branch is deliberately NOT swept in with the played ones.
  // `statusOf` folds abandoned / forfeited / cancelled — and any status this
  // module does not yet know — into "other", which is exactly where guessing
  // would be wrong, so its wording is unchanged. This is the negative pair
  // for the test above: a change that simply moved every non-live status onto
  // the new label would pass that one and fail this.
  it("leaves every OTHER status on Time TBD — abandoned/forfeited/cancelled and anything unknown", () => {
    for (const status of ["other", "abandoned", "forfeited", "cancelled", "some_future_status"]) {
      expect(fixtureSubheading(status, null), `${status} must keep the TBD wording`).toBe("Time TBD");
    }
  });

  // M1 k2 — the date branch no longer formats anything. It used to run its own
  // `new Date(iso).toLocaleString(locale, …)` with NO `timeZone` (so it printed
  // the rendering server's zone) and in a long weekday style the court card
  // below does not use, so one page showed one kick-off in two wordings and two
  // zones. The single formatter is `startTimeText`
  // (`server/public-site/match-centre.ts`, covered by
  // `match-centre-start-time.test.ts`) and its output arrives here already
  // formatted — which is also what lets a reschedule move this line.
  it("renders the already-formatted start time VERBATIM, whatever it says", () => {
    expect(fixtureSubheading("scheduled", "20 Jul 2026, 14:30")).toBe("20 Jul 2026, 14:30");
    expect(fixtureSubheading("scheduled", "20 juil. 2026, 14:30")).toBe("20 juil. 2026, 14:30");
  });

  it("shows the start time whenever one exists, regardless of status", () => {
    for (const status of ["in_play", "decided", "scheduled", "abandoned"]) {
      expect(fixtureSubheading(status, "20 Jul 2026, 14:30"), status).toBe("20 Jul 2026, 14:30");
    }
  });

  // A document built before `startTime` existed carries `undefined`, not
  // `null` (the field is `.optional()`), and must take the same branch.
  it("treats an ABSENT start time the same as a null one", () => {
    expect(fixtureSubheading("scheduled", undefined)).toBe("Time TBD");
    expect(fixtureSubheading("decided", undefined)).toBe("Time not recorded");
    expect(fixtureSubheading("in_play", undefined)).toBe("");
  });

  // Task 14b (task-14-review.md OWED item 2) — "Time TBD" was hardcoded
  // English; `timeTbdLabel` is opt-in localisation, so a caller with no
  // locale in hand (or an existing test calling with two args) keeps
  // reading exactly as before.
  it("uses the given timeTbdLabel for a non-live status with no start time", () => {
    expect(fixtureSubheading("scheduled", null, "Heure à déterminer")).toBe("Heure à déterminer");
  });

  // Both labels localise INDEPENDENTLY. Passing only the third argument must
  // not silently drag a played match onto the TBD string — that would be the
  // exact regression this parameter split exists to prevent, and it would be
  // invisible to any test that passes both.
  it("localises the played-match label separately from the TBD one", () => {
    expect(fixtureSubheading("decided", null, "Heure à déterminer", "Heure non enregistrée")).toBe(
      "Heure non enregistrée",
    );
    expect(fixtureSubheading("decided", null, "Heure à déterminer")).toBe("Time not recorded");
  });

  it("ignores both labels for an in-play fixture (still empty)", () => {
    expect(fixtureSubheading("in_play", null, "Heure à déterminer", "Heure non enregistrée")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// M1 k2 — the whole line, off the LIVE document
// ---------------------------------------------------------------------------
// `apps/web` vitest is `environment: "node"`, so these prove the MODEL the
// island renders (the DOM wiring — that the island really re-renders on a
// push — is the e2e's job, `spectator-public.spec.ts`). The documents here are
// real `buildMatchCentre` output, not hand-typed objects, so a builder change
// moves these with it.

const LABELS = { timeTbd: "Time TBD", timeNotRecorded: "Time not recorded" };

const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "Home Blazers", short: "HOM", colour: null, badgeUrl: null },
  { entrantId: "away", name: "Southend Queens", short: "SEQ", colour: null, badgeUrl: null },
];

function docFor(over: Partial<PublicFixture> = {}): MatchCentreDocT {
  const fixture: PublicFixture = {
    id: "fx1",
    division_id: "d1",
    stage_id: "s1",
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "home",
    away_entrant_id: "away",
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: "2026-07-20T13:30:00.000Z",
    venue: "Stale Building",
    court_label: "Stale Court",
    venue_name: "Riverside Sports Hall",
    court_name: "Court 3",
    status: "scheduled",
    outcome: null,
    summary: null,
    last_seq: null,
    ...over,
  };
  const input: MatchCentreInput = {
    fixture,
    sportKey: "cricket",
    cfg: cricket.configSchema.parse({}),
    events: [],
    lineups: { home: [], away: [] },
    sides: SIDES,
    venueTz: "Europe/London",
    locale: "en",
    now: new Date("2026-07-20T10:00:00.000Z"),
    hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: null,
    moduleVersion: null,
    formatLabel: null,
  };
  return buildMatchCentre(input);
}

describe("fixtureSubheadingLine — the line derives from the live document", () => {
  it("joins the document's start time, venue and court", () => {
    expect(fixtureSubheadingLine(docFor(), "scheduled", LABELS)).toBe(
      "20 Jul 2026, 14:30 · Riverside Sports Hall · Court 3",
    );
  });

  // THE k2 DEFECT. The rain-delay test moved `scheduled_at` and the court card
  // followed while this line did not, because the page had formatted it once
  // on the server. Feeding the line a document with the new time must produce
  // the new line — that is the whole reason the facts moved onto the document.
  it("a RESCHEDULED document yields the new time, with no other input changed", () => {
    const before = fixtureSubheadingLine(docFor(), "scheduled", LABELS);
    const after = fixtureSubheadingLine(
      docFor({ scheduled_at: "2026-07-20T16:45:00.000Z" }),
      "scheduled",
      LABELS,
    );
    expect(before).toContain("14:30");
    expect(after).toContain("17:45");
    expect(after).not.toBe(before);
  });

  // …and the line is the SAME string the court card prints, because both come
  // off `startTimeText`. A page that showed "Starts 20 Jul 2026, 14:30" over a
  // subheading reading "Monday 20 July at 02:30 PM" is exactly what this
  // replaced.
  it("the time it shows is character-for-character the court card's", () => {
    const doc = docFor();
    expect(fixtureSubheadingLine(doc, "scheduled", LABELS)).toContain(
      String(doc.header.statusLine!.params!.time),
    );
  });

  it("a court reassignment moves the line too", () => {
    expect(fixtureSubheadingLine(docFor({ court_name: "Court 9" }), "scheduled", LABELS)).toBe(
      "20 Jul 2026, 14:30 · Riverside Sports Hall · Court 9",
    );
  });

  it("carries the DERIVED venue/court names, never the frozen venue/court_label columns", () => {
    const line = fixtureSubheadingLine(docFor(), "scheduled", LABELS)!;
    expect(line).not.toContain("Stale Building");
    expect(line).not.toContain("Stale Court");
  });

  it("drops the missing parts rather than leaving a gap between separators", () => {
    expect(fixtureSubheadingLine(docFor({ court_name: null }), "scheduled", LABELS)).toBe(
      "20 Jul 2026, 14:30 · Riverside Sports Hall",
    );
    // The failure this guards is " · · ", which reads as punctuation on a page
    // and passes any non-empty check.
    expect(
      fixtureSubheadingLine(docFor({ venue_name: null, court_name: null }), "scheduled", LABELS),
    ).toBe("20 Jul 2026, 14:30");
  });

  it("is NULL — no empty paragraph — when a live fixture has neither a time nor a venue", () => {
    expect(
      fixtureSubheadingLine(
        docFor({ status: "in_play", scheduled_at: null, venue_name: null, court_name: null }),
        "in_play",
        LABELS,
      ),
    ).toBeNull();
  });

  it("takes the label from the DOCUMENT's folded status, not the payload's raw one", () => {
    // `statusOf` folds `finalized` into `decided`, so the document says
    // "decided" where the fixture row says "finalized" — and the line must
    // read the document, which is the thing that updates.
    const doc = docFor({ status: "finalized", scheduled_at: null });
    expect(doc.header.status).toBe("decided");
    expect(fixtureSubheadingLine(doc, "scheduled", LABELS)).toBe(
      "Time not recorded · Riverside Sports Hall · Court 3",
    );
  });

  it("falls back to the payload's status only when there is NO document at all", () => {
    // `MatchCentre`'s own `mc-fallback` path. The line degrades to the status
    // label rather than disappearing or crashing.
    expect(fixtureSubheadingLine(undefined, "scheduled", LABELS)).toBe("Time TBD");
    expect(fixtureSubheadingLine(undefined, "decided", LABELS)).toBe("Time not recorded");
    expect(fixtureSubheadingLine(undefined, "in_play", LABELS)).toBeNull();
  });
});
