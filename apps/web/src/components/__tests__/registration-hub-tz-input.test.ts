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
