// Task 33e: what a paused (seat-frozen) admin's 402 looks like on the wire, read structurally (an `ApiV1Error` is what the
// client throws, but a test double and a re-thrown error are plain objects with the same three fields).
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { FROZEN_SEAT_FEATURE, isSeatFrozenError } from "@/lib/seat-frozen";
import { PaymentRequiredError } from "@/lib/errors";

describe("isSeatFrozenError", () => {
  it("is the members.max feature the SERVER's own refusal names (not a literal typed here)", () => {
    // The expected value comes from the thrower: `requireOrgAuth` throws `new PaymentRequiredError("members.max")`.
    expect(new PaymentRequiredError(FROZEN_SEAT_FEATURE).featureKey).toBe("members.max");
  });

  it("a 402 PAYMENT_REQUIRED whose feature_key is the frozen seat: yes", () => {
    expect(isSeatFrozenError(new ApiV1Error("x", 402, "PAYMENT_REQUIRED", { feature: "members.max", feature_key: "members.max" }))).toBe(true);
  });

  it("every other shape: no — another plan feature, another status, another code, a network error, and things that are not errors", () => {
    const refused: unknown[] = [
      new ApiV1Error("x", 402, "PAYMENT_REQUIRED", { feature_key: "streaming.relay" }),
      new ApiV1Error("x", 402, "PAYMENT_REQUIRED", {}),
      new ApiV1Error("x", 500, "PAYMENT_REQUIRED", { feature_key: "members.max" }),
      new ApiV1Error("x", 402, "FORBIDDEN", { feature_key: "members.max" }),
      new ApiV1Error("x", 403, "FORBIDDEN"),
      new TypeError("Failed to fetch"),
      null,
      undefined,
      "members.max",
      402,
    ];
    let checked = 0;
    for (const e of refused) {
      expect(isSeatFrozenError(e), String(e)).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(refused.length);
  });
});
