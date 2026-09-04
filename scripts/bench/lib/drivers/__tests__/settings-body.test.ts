// The two organiser request bodies, pinned once for BOTH drivers.
//
// These lived inline in `drivers/http.ts` and `drivers/browser.ts` as separate
// copies. `payment_method` was added to the http copy and not the browser one,
// and because `PutRegistrationSettings` defaults every key it does not receive
// (api-v1/schemas.ts:2334), the browser driver silently reset every division it
// configured back to "offline" — making hosted Checkout unmintable and
// surfacing three steps later as a 422 reading "This entry fee is paid directly
// to the organiser". One builder, one test.
import { describe, expect, it } from "vitest";
import { registrationPatchBody, registrationSettingsBody } from "../settings-body.ts";
import type { RegistrationBlockConfig } from "../types.ts";

const BASE: RegistrationBlockConfig = {
  category: "mixed",
  ageMin: 12,
  ageMax: 18,
  entrantKind: "team",
  feeCents: 500,
  paymentMethod: "stripe",
  approval: "manual",
  capacity: 16,
};

describe("registrationSettingsBody", () => {
  it("sends EVERY key explicitly — an omitted key is a silent reset, not 'leave it alone'", () => {
    // `toEqual`, deliberately. The failure mode is an ABSENT key, which a
    // `toMatchObject` over the remaining fields cannot see: the real one stayed
    // green through the deletion that caused the live outage.
    expect(registrationSettingsBody(BASE)).toEqual({
      enabled: true,
      entrant_kind: "team",
      fee_cents: 500,
      payment_method: "stripe",
      approval: "manual",
      capacity: 16,
    });
  });

  it("carries the block's OWN payment method in both directions", () => {
    // The differential pair. A builder that hardcoded either value would pass
    // a single-case assertion; only both cases witness that the pack's
    // declaration is what travels.
    expect(registrationSettingsBody({ ...BASE, paymentMethod: "stripe" }).payment_method).toBe("stripe");
    expect(registrationSettingsBody({ ...BASE, paymentMethod: "offline" }).payment_method).toBe("offline");
  });

  it("sends capacity as null when the block declares none — clearing a capacity is a real edit", () => {
    const { capacity, ...rest } = BASE;
    void capacity;
    expect(registrationSettingsBody(rest).capacity).toBeNull();
  });
});

describe("registrationPatchBody", () => {
  it("nulls an absent age band rather than omitting it", () => {
    const { ageMin, ageMax, ...rest } = BASE;
    void ageMin;
    void ageMax;
    expect(registrationPatchBody(rest)).toEqual({ category: "mixed", age_min: null, age_max: null });
  });

  it("passes a declared band through unchanged", () => {
    expect(registrationPatchBody(BASE)).toEqual({ category: "mixed", age_min: 12, age_max: 18 });
  });
});
