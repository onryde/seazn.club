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
  SCHEDULE_OUTSIDE_COMPETITION,
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
