// RS004 W3c — the config panel saves through TWO endpoints (PATCH
// /divisions/{id} for category/age_min/age_max, PUT
// /registration-settings for everything else), and neither one returns a
// structured {field} on every 422: a zod validation failure (400
// VALIDATION) carries `extra.issues[].path`, but a usecase-level
// `HttpError(422, "...")` (the age-band check when only one side is sent,
// the free-agents/capacity/fee/date-order guards) carries nothing but a
// message string. This pure function is the ONE place that maps either
// shape to the field the config panel should show the error against, so
// the panel itself never has to know which of the two failure shapes it
// got.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { mapSaveError } from "@/components/registration-hub-save-error";
// RS004 review finding 2: schemas.ts is explicitly NOT server-only (pure
// Zod, shared with the OpenAPI generator — see its own file header), and
// AGE_MAX_BEFORE_MIN is exported specifically so callers can raise/assert
// the SAME message rather than a hand-typed copy. Other client-side tests
// already import VALUES (not just types) from this module, e.g.
// lib/__tests__/venue-tz.test.ts's PutScheduleSettings.
import { AGE_CUTOFF_BOTH_OR_NEITHER, AGE_MAX_BEFORE_MIN } from "@/server/api-v1/schemas";

describe("mapSaveError — structured zod issues (400 VALIDATION)", () => {
  it("uses issue.path[0] as the field when both age_min and age_max are patched together", () => {
    const err = new ApiV1Error("Invalid input", 400, "VALIDATION", {
      issues: [{ path: ["age_max"], message: "age_max must be greater than or equal to age_min.", code: "custom" }],
    });
    expect(mapSaveError(err)).toEqual({
      field: "age_max",
      message: "age_max must be greater than or equal to age_min.",
    });
  });

  it("falls through to message matching when the issue carries no path (duplicate form field keys)", () => {
    const err = new ApiV1Error("Invalid input", 400, "VALIDATION", {
      issues: [{ path: [], message: "duplicate form field keys", code: "custom" }],
    });
    expect(mapSaveError(err)).toEqual({ field: "form_fields", message: "duplicate form field keys" });
  });

  it("ignores an issue path whose head is not a field this panel owns", () => {
    const err = new ApiV1Error("Invalid input", 400, "VALIDATION", {
      issues: [{ path: ["some_other_field"], message: "nonsense", code: "custom" }],
    });
    expect(mapSaveError(err)).toEqual({ field: null, message: "Invalid input" });
  });
});

// RS004 review finding 2 (minor, CHARACTERISATION — documents mapSaveError's
// CURRENT behaviour against the server's CURRENT prose; it goes green
// immediately and is deliberately not a red/green TDD test): every test
// below used to hand-type the server's message from memory with nothing
// tying it back to its source, so a server-side reword would silently
// degrade a field-anchored error into a context-free banner and nothing
// here would catch it.
//
// AGE_MAX_BEFORE_MIN is now IMPORTED (see the import above) — a reword in
// schemas.ts flows into this test automatically, and it fails unless
// mapSaveError's pattern is updated to match. The other five are
// HttpError(422, "...") string literals inline in
// server/usecases/registrations.ts, a genuinely server-only file (raw DB
// access via `tx`) this client-side suite must not import — COPIED
// verbatim instead, each with a comment naming the exact source line, so a
// `git grep` for the old string on a reword finds this test too.
describe("mapSaveError — plain-message usecase 422s (finding 2 guard, characterisation)", () => {
  it("age band violated with only ONE side sent — the real schemas.ts constant, not a hand-typed copy", () => {
    const err = new ApiV1Error(AGE_MAX_BEFORE_MIN, 422, "ERROR");
    expect(mapSaveError(err)).toEqual({ field: "age_max", message: AGE_MAX_BEFORE_MIN });
  });

  // RS007/V380 — the cutoff columns' own both-or-neither race backstop
  // (divisions.ts's isAgeCutoffCheckViolation), same shape as the age-band
  // case above: a bare HttpError(422, "...") string, no path.
  it("cutoff month/day sent as a mismatched pair — the real schemas.ts constant, not a hand-typed copy", () => {
    const err = new ApiV1Error(AGE_CUTOFF_BOTH_OR_NEITHER, 422, "ERROR");
    expect(mapSaveError(err)).toEqual({ field: "age_cutoff_day", message: AGE_CUTOFF_BOTH_OR_NEITHER });
  });

  it("allow_free_agents on a non-team division (server/usecases/registrations.ts:1021)", () => {
    const err = new ApiV1Error("allow_free_agents requires entrant_kind 'team'", 422, "ERROR");
    expect(mapSaveError(err)).toEqual({
      field: "allow_free_agents",
      message: "allow_free_agents requires entrant_kind 'team'",
    });
  });

  it("card payment chosen without a connected Stripe account (server/usecases/registrations.ts:1027)", () => {
    const err = new ApiV1Error(
      "Connect Stripe under Settings → Connect before choosing card payments",
      422,
      "ERROR",
    );
    expect(mapSaveError(err).field).toBe("payment_method");
  });

  it("card fee below Stripe's minimum charge (server/usecases/registrations.ts:1032)", () => {
    const err = new ApiV1Error("Card entry fees must be at least 1.00 (or 0 for free)", 422, "ERROR");
    expect(mapSaveError(err).field).toBe("fee_cents");
  });

  it("capacity above the plan's entrant limit — dynamic number, the pattern excludes it on purpose (server/usecases/registrations.ts:1043)", () => {
    const err = new ApiV1Error(
      "Capacity exceeds your plan's entrant limit (128) — raise the plan or lower the capacity",
      422,
      "ERROR",
    );
    expect(mapSaveError(err).field).toBe("capacity");
  });

  it("closes_at before opens_at (server/usecases/registrations.ts:1048)", () => {
    const err = new ApiV1Error("closes_at must be after opens_at", 422, "ERROR");
    expect(mapSaveError(err).field).toBe("closes_at");
  });
});

describe("mapSaveError — unmapped errors fall back to a banner, never silently dropped", () => {
  it("a 404 with no known field maps to field:null, message preserved", () => {
    const err = new ApiV1Error("division not found", 404, "NOT_FOUND");
    expect(mapSaveError(err)).toEqual({ field: null, message: "division not found" });
  });

  it("a plain network Error (not an ApiV1Error) still yields a renderable message", () => {
    const err = new Error("Failed to fetch");
    expect(mapSaveError(err)).toEqual({ field: null, message: "Failed to fetch" });
  });
});
