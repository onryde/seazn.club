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

  // R11 phone read — this used to assert "Time TBD" for `decided`, which is
  // what `match-b-tab-scorecard-320.png` showed above an ENDED scorebug. "To
  // be determined" is a promise about the future; a played match is missing a
  // time, not awaiting one. The assertion is INVERTED here deliberately, not
  // relaxed: the old wording is now what must NOT appear.
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

  // The date branch had NO positive witness in the repo: it was asserted with
  // three negatives ("not Time TBD", "not Time not recorded", "not empty"),
  // which every locale satisfies equally — so it rendered hardcoded en-GB on
  // fr/es/nl for the life of the branch and no test could see it. These pin
  // what it actually produces, and that the LOCALE is what decides it.
  it("formats the date in the locale it is given, not in English", () => {
    const at = "2026-07-20T14:30:00.000Z";
    const en = fixtureSubheading("scheduled", at, "Time TBD", "Time not recorded", "en-GB");
    const fr = fixtureSubheading("scheduled", at, "Time TBD", "Time not recorded", "fr-FR");
    // Derived from Intl itself, never a literal typed here: a CI runner with a
    // different ICU build must move the expectation with it, not red.
    const expected = (locale: string) =>
      new Date(at).toLocaleString(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      });
    expect(en).toBe(expected("en-GB"));
    expect(fr).toBe(expected("fr-FR"));
    // The assertion with teeth: the two must DIFFER. Passing the locale
    // through and then ignoring it would satisfy both lines above.
    expect(fr).not.toBe(en);
  });

  // Callers that pass no locale keep the previous behaviour exactly — the
  // parameter is additive, and every existing two- and four-argument call site
  // still reads as it did.
  it("defaults to en-GB when no locale is given", () => {
    const at = "2026-07-20T14:30:00.000Z";
    expect(fixtureSubheading("scheduled", at)).toBe(
      fixtureSubheading("scheduled", at, "Time TBD", "Time not recorded", "en-GB"),
    );
  });

  it("shows the formatted date whenever a scheduled time exists, regardless of status", () => {
    for (const status of ["in_play", "decided", "scheduled"]) {
      const result = fixtureSubheading(status, "2026-07-20T14:30:00.000Z");
      expect(result).not.toBe("Time TBD");
      expect(result).not.toBe("Time not recorded");
      expect(result).not.toBe("");
    }
  });

  // Task 14b (task-14-review.md OWED item 2) — "Time TBD" was hardcoded
  // English; `timeTbdLabel` is opt-in localisation, so a caller with no
  // locale in hand (or an existing test calling with two args) keeps
  // reading exactly as before.
  it("uses the given timeTbdLabel for a non-live status with no scheduled time", () => {
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
