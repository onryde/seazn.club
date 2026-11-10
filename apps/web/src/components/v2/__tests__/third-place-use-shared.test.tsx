// B4 fix round 1 (I-2; pick 7A): the one place a refused draw's stage is read off the wire. A refusal that names no stage offers
// nothing to act on (never a button that PATCHes `undefined`); any other refusal offers nothing.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { tooFewOfferFrom } from "@/components/v2/third-place-use-shared";

describe("tooFewOfferFrom", () => {
  it("names the stage and the count of a KO_THIRD_PLACE_TOO_FEW refusal", () => {
    expect(tooFewOfferFrom(new ApiV1Error("x", 422, "KO_THIRD_PLACE_TOO_FEW", { entrants: 3, stageId: "s9" }))).toEqual({ stageId: "s9", entrants: 3 });
    expect(tooFewOfferFrom(new ApiV1Error("x", 422, "KO_THIRD_PLACE_TOO_FEW", { entrants: 0, stageId: "s9" }))).toEqual({ stageId: "s9", entrants: 0 });
  });
  it("offers nothing without a stage or a count, for another code, or for a non-API error", () => {
    const none = [
      new ApiV1Error("x", 422, "KO_THIRD_PLACE_TOO_FEW", { entrants: 3 }),
      new ApiV1Error("x", 422, "KO_THIRD_PLACE_TOO_FEW", { stageId: "s9" }),
      new ApiV1Error("x", 409, "THIRD_PLACE_LOCKED", { entrants: 3, stageId: "s9" }),
      new Error("boom"),
      null,
    ];
    for (const e of none) expect(tooFewOfferFrom(e)).toBeNull();
    expect(none.length).toBe(5);
  });
});
