// V305 — the scheduling timezone is an ORGANISATION setting that divisions
// inherit. The division-level control was removed from the console entirely,
// but `schedule_settings.tz` survives and keeps winning: divisions created
// before V305 hold real zones, and if resolution stopped honouring them their
// published timetables would silently shift.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pickTimezone, resolveVenueTz } from "@/lib/tz";
import { PutScheduleSettings, ScheduleSettings } from "@/server/api-v1/schemas";

const CONFIG = {
  startAt: null,
  endAt: null,
  matchMinutes: 30,
  gapMinutes: 0,
  // P9 cutover: ScheduleConfig.courts is a court-id array, not names. The tz
  // tri-state below is what this suite asserts; the id is incidental but must
  // still parse, or the ZodError masks the assertion entirely.
  courts: ["6f1b7a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

describe("resolveVenueTz — venue lane precedence", () => {
  it("keeps an existing per-division tz even though the UI can no longer set one", () => {
    // The load-bearing case. Org says Madrid; this division was pinned to
    // Chennai before V305 and must stay there.
    expect(resolveVenueTz("Asia/Kolkata", "Europe/Madrid")).toBe("Asia/Kolkata");
  });

  it("inherits the org timezone when the division has none", () => {
    expect(resolveVenueTz(null, "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz(undefined, "Europe/Madrid")).toBe("Europe/Madrid");
  });

  it("falls back to UTC when neither is set", () => {
    expect(resolveVenueTz(null, null)).toBe("UTC");
  });

  it("skips blank or unknown zones rather than trusting them", () => {
    expect(resolveVenueTz("  ", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz("Mars/Olympus_Mons", "Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveVenueTz("Mars/Olympus_Mons", "Nowhere/Nothing")).toBe("UTC");
  });

  it("never consults the personal lane (a London organiser can play in Malaga)", () => {
    // pickTimezone is the PERSONAL lane and takes the user's own zone; the
    // venue lane must produce a different answer from the same inputs.
    expect(pickTimezone("Europe/London", null)).toBe("Europe/London");
    expect(resolveVenueTz(null, "Europe/Madrid")).toBe("Europe/Madrid");
  });
});

describe("PutScheduleSettings.tz — tri-state", () => {
  it("leaves tz undefined when the body omits it, so a save cannot move a division's zone", () => {
    // The console now ALWAYS omits tz. If this defaulted (it used to default
    // to "UTC"), every settings save would stamp UTC over an inherited or
    // pre-existing zone.
    const parsed = PutScheduleSettings.parse({ config: CONFIG });
    expect("tz" in parsed ? parsed.tz : undefined).toBeUndefined();
  });

  it("still accepts an explicit zone, and null to clear back to inheriting", () => {
    expect(PutScheduleSettings.parse({ config: CONFIG, tz: "Europe/Madrid" }).tz).toBe("Europe/Madrid");
    expect(PutScheduleSettings.parse({ config: CONFIG, tz: null }).tz).toBeNull();
  });
});

// m2 — the field was length-checked only (`z.string().min(1).max(64)`), so any
// 1-64 character string reached the column, while `users.timezone`
// (lib/types.ts) and `organizations.timezone` (api/orgs/[id]/route.ts) both
// validate against the runtime's Intl. That asymmetry is what this block
// closes: a junk zone stored here is NOT harmless, because the two public
// loaders resolve it in SQL as `coalesce(ss.tz, o.timezone, 'UTC')`, and
// coalesce rescues NULL only — a non-null junk string flows straight out to a
// spectator surface (see server/__tests__/loader-venue-tz.test.ts).
describe("PutScheduleSettings.tz — validated as a real IANA zone", () => {
  /** Dotted path + message per issue, so a passing assertion cannot mean
   *  "something was rejected" while the refusal names the wrong field. */
  const issues = (tz: unknown) => {
    const r = PutScheduleSettings.safeParse({ config: CONFIG, tz });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("refuses a zone Intl cannot construct, naming tz", () => {
    expect(issues("Mars/Olympus_Mons")).toEqual(["tz: Unknown timezone"]);
  });

  it("refuses a length-legal string that is not a zone at all", () => {
    // 1-64 characters, so every check the field used to carry passes.
    expect(issues("Not A Zone")).toEqual(["tz: Unknown timezone"]);
    expect(issues("Europe/Madridd")).toEqual(["tz: Unknown timezone"]);
  });

  // The write path must not end up STRICTER than the venue lane it feeds:
  // resolveVenueTz keeps anything isValidIana keeps, aliases included, so a
  // division pinned to a legacy spelling before V305 must still be able to save.
  it("still accepts a legacy alias rather than only canonical spellings", () => {
    expect(issues("Asia/Calcutta")).toEqual([]);
    expect(PutScheduleSettings.parse({ config: CONFIG, tz: "Asia/Calcutta" }).tz).toBe(
      "Asia/Calcutta",
    );
  });

  it("leaves the tri-state intact — omitted and null are still accepted", () => {
    // The refine sits on the STRING branch, inside .nullish(). If it were
    // applied after, every console save (which omits tz entirely) would 400.
    expect(issues(undefined)).toEqual([]);
    expect(issues(null)).toEqual([]);
    expect(PutScheduleSettings.safeParse({ config: CONFIG }).success).toBe(true);
  });
});

// The tripwire for the well-intentioned edit that "covers more callers" by
// moving this refine onto the RESPONSE schema. `ScheduleSettings.tz` is the
// RESOLVED venue zone on the way OUT, and divisions already hold junk values
// this branch does not clean up — refining it would turn their schedule page
// into a 500 instead of refusing a bad write. Same distinction, and same
// reason, as ScheduleConfig staying permissive in
// api-v1/__tests__/schedule-settings-date-order.test.ts.
describe("ScheduleSettings (the READ lane) stays permissive", () => {
  it("still parses a stored row whose tz is not a zone Intl accepts", () => {
    const parsed = ScheduleSettings.safeParse({
      division_id: randomUUID(),
      config: CONFIG,
      tz: "Mars/Olympus_Mons",
      updated_at: "2026-09-16T10:00:00.000Z",
    });
    expect(parsed.success, "a legacy junk row must remain READABLE").toBe(true);
  });
});
