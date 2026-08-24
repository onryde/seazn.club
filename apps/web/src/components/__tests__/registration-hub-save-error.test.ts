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

describe("mapSaveError — plain-message usecase 422s", () => {
  it("age band violated with only ONE side sent (usecase-level check, no structured path)", () => {
    const err = new ApiV1Error("age_max must be greater than or equal to age_min.", 422, "ERROR");
    expect(mapSaveError(err)).toEqual({
      field: "age_max",
      message: "age_max must be greater than or equal to age_min.",
    });
  });

  it("allow_free_agents on a non-team division", () => {
    const err = new ApiV1Error("allow_free_agents requires entrant_kind 'team'", 422, "ERROR");
    expect(mapSaveError(err)).toEqual({
      field: "allow_free_agents",
      message: "allow_free_agents requires entrant_kind 'team'",
    });
  });

  it("card payment chosen without a connected Stripe account", () => {
    const err = new ApiV1Error(
      "Connect Stripe under Settings → Connect before choosing card payments",
      422,
      "ERROR",
    );
    expect(mapSaveError(err).field).toBe("payment_method");
  });

  it("card fee below Stripe's minimum charge", () => {
    const err = new ApiV1Error("Card entry fees must be at least 1.00 (or 0 for free)", 422, "ERROR");
    expect(mapSaveError(err).field).toBe("fee_cents");
  });

  it("capacity above the plan's entrant limit — message carries a dynamic number", () => {
    const err = new ApiV1Error(
      "Capacity exceeds your plan's entrant limit (128) — raise the plan or lower the capacity",
      422,
      "ERROR",
    );
    expect(mapSaveError(err).field).toBe("capacity");
  });

  it("closes_at before opens_at", () => {
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
