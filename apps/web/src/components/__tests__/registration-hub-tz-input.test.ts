// RS004 W3c — config panel datetime fields are edited/displayed in the ORG
// timezone (owner decision 1), never browser-local. A <input
// type="datetime-local"> always carries a bare "YYYY-MM-DDTHH:MM" wall-clock
// string with no zone of its own; these two pure functions are the only
// place that string is translated to/from a real UTC instant, using the
// org's chosen IANA zone rather than the visitor's.
import { describe, expect, it } from "vitest";
import {
  instantToOrgTzInputValue,
  orgTzInputValueToInstant,
  orgTzDateTimeHalves,
  isDateTimeHalvesIncomplete,
  editOrgTzDateTimeHalf,
} from "@/components/registration-hub-tz-input";

describe("instantToOrgTzInputValue", () => {
  it("returns empty string for null", () => {
    expect(instantToOrgTzInputValue(null, "UTC")).toBe("");
  });

  // Same hand-verified instant as registration-hub-row-derive.test.ts and
  // registration-hub-division-row.test.tsx: 2026-01-15T10:00:00Z in
  // Asia/Kolkata (UTC+5:30) is 15:30 local.
  it("renders the wall-clock value in the ORG timezone, not UTC", () => {
    expect(instantToOrgTzInputValue("2026-01-15T10:00:00Z", "Asia/Kolkata")).toBe(
      "2026-01-15T15:30",
    );
  });

  it("renders UTC unchanged when orgTz is UTC", () => {
    expect(instantToOrgTzInputValue("2026-01-15T10:00:00Z", "UTC")).toBe("2026-01-15T10:00");
  });

  it("accepts a Date instance, not just an ISO string", () => {
    expect(instantToOrgTzInputValue(new Date("2026-01-15T10:00:00Z"), "UTC")).toBe(
      "2026-01-15T10:00",
    );
  });

  it("returns empty string for an unparseable instant rather than 'Invalid Date'", () => {
    expect(instantToOrgTzInputValue("not-a-date", "UTC")).toBe("");
  });
});

describe("orgTzInputValueToInstant", () => {
  it("returns null for an empty string", () => {
    expect(orgTzInputValueToInstant("", "UTC")).toBeNull();
  });

  it("interprets the wall-clock value in the ORG timezone, not the runtime's zone", () => {
    expect(orgTzInputValueToInstant("2026-01-15T15:30", "Asia/Kolkata")).toBe(
      "2026-01-15T10:00:00.000Z",
    );
  });

  // DST proof: the same 12:00 wall-clock reads as two different UTC instants
  // six months apart in a zone with daylight saving — a fixed-offset
  // implementation would get one of these two wrong.
  it("resolves the correct offset either side of a DST transition (EDT, summer)", () => {
    expect(orgTzInputValueToInstant("2026-07-01T12:00", "America/New_York")).toBe(
      "2026-07-01T16:00:00.000Z",
    );
  });

  it("resolves the correct offset either side of a DST transition (EST, winter)", () => {
    expect(orgTzInputValueToInstant("2026-01-01T12:00", "America/New_York")).toBe(
      "2026-01-01T17:00:00.000Z",
    );
  });

  it("round-trips through instantToOrgTzInputValue for an arbitrary zone", () => {
    const iso = "2026-03-10T08:15:00.000Z";
    const tz = "Pacific/Auckland";
    const value = instantToOrgTzInputValue(iso, tz);
    expect(orgTzInputValueToInstant(value, tz)).toBe(iso);
  });
});

// RS005 R4 task 2 — the half-filled clock bug. DateTimeSplitField's own
// `joinValue` collapses a half-filled pair to "", identical to a fully
// cleared one, before this module ever sees a value — so the fix has to
// live where the two halves are still known separately. These three
// functions are that layer; see the file's own header comment for why a
// native `input.validity.badInput` check does not apply to this UI's actual
// DOM shape (a split date input + time select, never a raw datetime-local).
describe("orgTzDateTimeHalves", () => {
  it("splits a stored instant into its date/time halves, in the org zone", () => {
    expect(orgTzDateTimeHalves("2026-01-15T10:00:00Z", "Asia/Kolkata")).toEqual({
      date: "2026-01-15",
      time: "15:30",
    });
  });

  it("returns two empty halves for null — never a bare date with a blank time", () => {
    expect(orgTzDateTimeHalves(null, "UTC")).toEqual({ date: "", time: "" });
  });
});

describe("isDateTimeHalvesIncomplete", () => {
  it("is false when both halves are empty — a deliberate, complete clear", () => {
    expect(isDateTimeHalvesIncomplete({ date: "", time: "" })).toBe(false);
  });

  it("is false when both halves are filled", () => {
    expect(isDateTimeHalvesIncomplete({ date: "2026-08-24", time: "10:00" })).toBe(false);
  });

  it("is true when only the date is filled — THE bug this task fixes", () => {
    expect(isDateTimeHalvesIncomplete({ date: "2026-08-24", time: "" })).toBe(true);
  });

  it("is true when only the time is filled", () => {
    expect(isDateTimeHalvesIncomplete({ date: "", time: "10:00" })).toBe(true);
  });
});

describe("editOrgTzDateTimeHalf", () => {
  it("picking a date with the time still blank reports incomplete, with NO usable instant", () => {
    const result = editOrgTzDateTimeHalf({ date: "", time: "" }, "date", "2026-08-24", "UTC");
    expect(result.incomplete).toBe(true);
    expect(result.instant).toBeNull();
    expect(result.halves).toEqual({ date: "2026-08-24", time: "" });
  });

  it("then filling the time completes the pair and resolves the real instant", () => {
    const afterDate = editOrgTzDateTimeHalf({ date: "", time: "" }, "date", "2026-08-24", "UTC");
    const afterTime = editOrgTzDateTimeHalf(afterDate.halves, "time", "10:00", "UTC");
    expect(afterTime.incomplete).toBe(false);
    expect(afterTime.instant).toBe(orgTzInputValueToInstant("2026-08-24T10:00", "UTC"));
  });

  it("picking the time first, date still blank, is ALSO incomplete (both directions)", () => {
    const result = editOrgTzDateTimeHalf({ date: "", time: "" }, "time", "10:00", "UTC");
    expect(result.incomplete).toBe(true);
    expect(result.instant).toBeNull();
  });

  it("clearing a fully-set pair back to both-empty is a real, complete clear — not incomplete", () => {
    const cleared = editOrgTzDateTimeHalf({ date: "2026-08-24", time: "10:00" }, "date", "", "UTC");
    // Time is still "10:00" here — one half filled, one blank: incomplete.
    expect(cleared.incomplete).toBe(true);
    const fullyCleared = editOrgTzDateTimeHalf(cleared.halves, "time", "", "UTC");
    expect(fullyCleared.incomplete).toBe(false);
    expect(fullyCleared.instant).toBeNull();
  });

  it("resolves the instant in the ORG timezone, not UTC", () => {
    const withDate = editOrgTzDateTimeHalf({ date: "", time: "" }, "date", "2026-01-15", "Asia/Kolkata");
    const complete = editOrgTzDateTimeHalf(withDate.halves, "time", "15:30", "Asia/Kolkata");
    expect(complete.incomplete).toBe(false);
    expect(complete.instant).toBe("2026-01-15T10:00:00.000Z");
  });
});
