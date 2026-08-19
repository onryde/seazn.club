// SCHEDULE_OUTSIDE_COMPETITION -> localized organiser copy.
//
// Before this, the containment refusal from `server/usecases/schedule.ts`
// reached the organiser as the server's raw English sentence in all four
// locales — the board rendered `err.message` verbatim. These tests pin the
// resolver's whole contract: the right variant for the bounds that were
// actually crossed, the dates interpolated, every other code passed through
// untouched, and a malformed payload degrading to the server's message rather
// than to a sentence with a hole in it.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import {
  SCHEDULE_COURT_STILL_IN_USE,
  SCHEDULE_OUTSIDE_COMPETITION,
  courtStillInUseErrorMessage,
  scheduleWindowErrorMessage,
  settingsErrorText,
} from "@/lib/schedule-error";
import en from "@/dictionaries/en/errors.json";
import es from "@/dictionaries/es/errors.json";
import fr from "@/dictionaries/fr/errors.json";
import nl from "@/dictionaries/nl/errors.json";

const SERVER_MESSAGE =
  "this division's schedule starts before the competition opens on 2026-07-01 — widen the competition dates, or bring the division inside them";

const both = {
  startsBefore: true,
  endsAfter: true,
  competitionStartsOn: "2026-07-01",
  competitionEndsOn: "2026-07-20",
};

const COURTS_DETAIL = "Court 1 (2 pinned + 1 in play or completed)";
const SERVER_COURT_MESSAGE =
  `cannot remove a court that still holds fixtures the schedule cannot move: ${COURTS_DETAIL} — unpin or reschedule them first`;

describe("scheduleWindowErrorMessage", () => {
  it("picks the START variant and names the competition's opening date", () => {
    const out = scheduleWindowErrorMessage("en", SCHEDULE_OUTSIDE_COMPETITION, { ...both, endsAfter: false }, "fb");
    expect(out).toContain("2026-07-01");
    expect(out).not.toContain("2026-07-20");
    expect(out).not.toContain("{");
  });

  it("picks the END variant and names the competition's closing date", () => {
    const out = scheduleWindowErrorMessage("en", SCHEDULE_OUTSIDE_COMPETITION, { ...both, startsBefore: false }, "fb");
    expect(out).toContain("2026-07-20");
    expect(out).not.toContain("2026-07-01");
  });

  it("picks the BOTH variant when the range overhangs at each end", () => {
    const out = scheduleWindowErrorMessage("en", SCHEDULE_OUTSIDE_COMPETITION, both, "fb");
    expect(out).toContain("2026-07-01");
    expect(out).toContain("2026-07-20");
  });

  it("renders in every shipped locale, never the English sentence and never a bare key", () => {
    for (const [locale, dict] of [
      ["en", en],
      ["es", es],
      ["fr", fr],
      ["nl", nl],
    ] as const) {
      const out = scheduleWindowErrorMessage(locale, SCHEDULE_OUTSIDE_COMPETITION, both, SERVER_MESSAGE);
      expect(out).not.toBe(SERVER_MESSAGE);
      // `t()` returns the KEY on a miss — a locale hole would surface as the
      // key itself, which is the failure this asserts against directly.
      expect(out).not.toContain("SCHEDULE_OUTSIDE_COMPETITION");
      expect(out).toContain("2026-07-01");
      expect(out).toContain("2026-07-20");
      // And it is that locale's own string, not en leaking through.
      expect(out).toBe(
        (dict as Record<string, string>)[`schedule.${SCHEDULE_OUTSIDE_COMPETITION}.both`]
          .replace("{startsOn}", "2026-07-01")
          .replace("{endsOn}", "2026-07-20"),
      );
    }
  });

  it("passes ANY other code straight through — never a guess at copy this pass didn't author", () => {
    expect(scheduleWindowErrorMessage("es", "SEQ_CONFLICT", both, SERVER_MESSAGE)).toBe(SERVER_MESSAGE);
    expect(scheduleWindowErrorMessage("es", "VALIDATION_FAILED", undefined, SERVER_MESSAGE)).toBe(SERVER_MESSAGE);
  });

  it("falls back when the payload names a bound but carries no date for it", () => {
    // A sentence with `{startsOn}` still in it would be worse than the
    // server's English one. This is the guard against that.
    expect(
      scheduleWindowErrorMessage(
        "en",
        SCHEDULE_OUTSIDE_COMPETITION,
        { startsBefore: true, endsAfter: false, competitionStartsOn: null, competitionEndsOn: null },
        SERVER_MESSAGE,
      ),
    ).toBe(SERVER_MESSAGE);
  });

  it("degrades BOTH to the half that has a date, rather than to a hole", () => {
    const out = scheduleWindowErrorMessage(
      "en",
      SCHEDULE_OUTSIDE_COMPETITION,
      { ...both, competitionEndsOn: null },
      SERVER_MESSAGE,
    );
    expect(out).toContain("2026-07-01");
    expect(out).not.toContain("{endsOn}");
    expect(out).not.toBe(SERVER_MESSAGE);
  });

  it("falls back on a payload claiming no bound at all, and on a missing payload", () => {
    expect(
      scheduleWindowErrorMessage("en", SCHEDULE_OUTSIDE_COMPETITION, { startsBefore: false, endsAfter: false }, SERVER_MESSAGE),
    ).toBe(SERVER_MESSAGE);
    expect(scheduleWindowErrorMessage("en", SCHEDULE_OUTSIDE_COMPETITION, undefined, SERVER_MESSAGE)).toBe(
      SERVER_MESSAGE,
    );
  });

  it("treats a non-boolean `startsBefore` as absent — the wire is not trusted", () => {
    expect(
      scheduleWindowErrorMessage(
        "en",
        SCHEDULE_OUTSIDE_COMPETITION,
        { startsBefore: "true", endsAfter: 0, competitionStartsOn: "2026-07-01" },
        SERVER_MESSAGE,
      ),
    ).toBe(SERVER_MESSAGE);
  });
});

describe("settingsErrorText", () => {
  it("localizes the containment refusal thrown by the real client error type", () => {
    const err = new ApiV1Error(SERVER_MESSAGE, 422, SCHEDULE_OUTSIDE_COMPETITION, both);
    const out = settingsErrorText(err, "fr", "generic");
    expect(out).toBe((fr as Record<string, string>)[`schedule.${SCHEDULE_OUTSIDE_COMPETITION}.both`]
      .replace("{startsOn}", "2026-07-01")
      .replace("{endsOn}", "2026-07-20"));
  });

  it("localizes the court-still-in-use refusal thrown by the real client error type", () => {
    const err = new ApiV1Error(SERVER_COURT_MESSAGE, 409, SCHEDULE_COURT_STILL_IN_USE, {
      anyPinned: true,
      anyFixed: false,
      courtsDetail: COURTS_DETAIL,
    });
    const out = settingsErrorText(err, "nl", "generic");
    expect(out).toBe(
      (nl as Record<string, string>)[`schedule.${SCHEDULE_COURT_STILL_IN_USE}.pinned`].replace(
        "{courtsDetail}",
        COURTS_DETAIL,
      ),
    );
  });

  it("shows the server's own message for any other ApiV1Error", () => {
    const err = new ApiV1Error("Courts in use", 409, "SEQ_CONFLICT", {});
    expect(settingsErrorText(err, "es", "generic")).toBe("Courts in use");
  });

  it("shows a plain Error's message, and the generic string for a non-Error throw", () => {
    expect(settingsErrorText(new Error("network down"), "en", "generic")).toBe("network down");
    expect(settingsErrorText("not an error", "en", "generic")).toBe("generic");
    expect(settingsErrorText(undefined, "en", "generic")).toBe("generic");
  });
});

// SCHEDULE_COURT_STILL_IN_USE -> localized organiser copy (Fix 3).
//
// Mirrors the `scheduleWindowErrorMessage` contract above, but with THREE
// variants selected by two independent booleans rather than one: a court can
// be blocked by a pin (`anyPinned`), a fixed/completed fixture (`anyFixed`),
// or both in the same refusal (`mixed`). Precedence when both are true is
// "mixed", never one half silently winning.
describe("courtStillInUseErrorMessage", () => {
  it("picks the PINNED variant and interpolates courtsDetail", () => {
    const out = courtStillInUseErrorMessage(
      "en",
      SCHEDULE_COURT_STILL_IN_USE,
      { anyPinned: true, anyFixed: false, courtsDetail: COURTS_DETAIL },
      "fb",
    );
    expect(out).toContain(COURTS_DETAIL);
    expect(out).not.toContain("{courtsDetail}");
    expect(out).toBe(
      (en as Record<string, string>)[`schedule.${SCHEDULE_COURT_STILL_IN_USE}.pinned`].replace(
        "{courtsDetail}",
        COURTS_DETAIL,
      ),
    );
  });

  it("picks the FIXED variant", () => {
    const out = courtStillInUseErrorMessage(
      "en",
      SCHEDULE_COURT_STILL_IN_USE,
      { anyPinned: false, anyFixed: true, courtsDetail: COURTS_DETAIL },
      "fb",
    );
    expect(out).toBe(
      (en as Record<string, string>)[`schedule.${SCHEDULE_COURT_STILL_IN_USE}.fixed`].replace(
        "{courtsDetail}",
        COURTS_DETAIL,
      ),
    );
  });

  it("picks the MIXED variant when both a pin and a fixed fixture are reported", () => {
    const out = courtStillInUseErrorMessage(
      "en",
      SCHEDULE_COURT_STILL_IN_USE,
      { anyPinned: true, anyFixed: true, courtsDetail: COURTS_DETAIL },
      "fb",
    );
    expect(out).toBe(
      (en as Record<string, string>)[`schedule.${SCHEDULE_COURT_STILL_IN_USE}.mixed`].replace(
        "{courtsDetail}",
        COURTS_DETAIL,
      ),
    );
  });

  it("renders in every shipped locale, never the server sentence and never a bare key", () => {
    for (const [locale, dict] of [
      ["en", en],
      ["es", es],
      ["fr", fr],
      ["nl", nl],
    ] as const) {
      const out = courtStillInUseErrorMessage(
        locale,
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: true, anyFixed: true, courtsDetail: COURTS_DETAIL },
        SERVER_COURT_MESSAGE,
      );
      expect(out).not.toBe(SERVER_COURT_MESSAGE);
      expect(out).not.toContain(SCHEDULE_COURT_STILL_IN_USE);
      expect(out).toContain(COURTS_DETAIL);
      expect(out).toBe(
        (dict as Record<string, string>)[`schedule.${SCHEDULE_COURT_STILL_IN_USE}.mixed`].replace(
          "{courtsDetail}",
          COURTS_DETAIL,
        ),
      );
    }
  });

  it("passes ANY other code straight through — never a guess at copy this pass didn't author", () => {
    expect(
      courtStillInUseErrorMessage(
        "es",
        "SEQ_CONFLICT",
        { anyPinned: true, anyFixed: false, courtsDetail: COURTS_DETAIL },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
  });

  it("falls back when neither boolean is true", () => {
    expect(
      courtStillInUseErrorMessage(
        "en",
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: false, anyFixed: false, courtsDetail: COURTS_DETAIL },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
  });

  it("falls back when courtsDetail isn't a usable string — a sentence with a hole is worse than the server's own", () => {
    expect(
      courtStillInUseErrorMessage(
        "en",
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: true, anyFixed: false, courtsDetail: undefined },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
    expect(
      courtStillInUseErrorMessage(
        "en",
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: true, anyFixed: false, courtsDetail: 42 },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
    expect(
      courtStillInUseErrorMessage(
        "en",
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: true, anyFixed: false, courtsDetail: "" },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
  });

  it("falls back on a missing payload", () => {
    expect(
      courtStillInUseErrorMessage("en", SCHEDULE_COURT_STILL_IN_USE, undefined, SERVER_COURT_MESSAGE),
    ).toBe(SERVER_COURT_MESSAGE);
  });

  it("treats a non-boolean anyPinned/anyFixed as absent — the wire is not trusted", () => {
    expect(
      courtStillInUseErrorMessage(
        "en",
        SCHEDULE_COURT_STILL_IN_USE,
        { anyPinned: "true", anyFixed: 1, courtsDetail: COURTS_DETAIL },
        SERVER_COURT_MESSAGE,
      ),
    ).toBe(SERVER_COURT_MESSAGE);
  });
});
