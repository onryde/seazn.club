import { describe, expect, it } from "vitest";
import { generatePreconditionMessage } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";

// Regression (design/fix-ui/03-console-division.md "Group-stage 'Générer les
// matchs' gives a misleading success message when it generates nothing"): a
// Groups+Knockout division with too few entrants (2, when the configured
// groups need more) showed a green "Rien de nouveau à générer — les matchs
// sont à jour" (up to date) success banner, even though zero fixtures had
// ever been generated — the phase card still read "no matches yet". The
// server now throws STAGE_NOT_READY / reason=group_too_few_entrants instead
// of returning the same { created: 0, existing: 0 } shape as a real no-op;
// this is the client-side classifier that turns that into an actionable,
// non-success message instead of falling through to the generic error text.
describe("generatePreconditionMessage — StagesPanel generate-click classifier", () => {
  it("returns an actionable message for a group stage that can't fill its groups yet", () => {
    const err = new ApiV1Error(
      "not enough entrants to fill 4 groups — each group needs at least 2 (have 2, need 8)",
      422,
      "STAGE_NOT_READY",
      { reason: "group_too_few_entrants", groups: 4, entrants: 2, required: 8 },
    );
    const text = generatePreconditionMessage(err, msg);
    expect(text).not.toBeNull();
    // Actionable — tells the organiser what to DO, not just that nothing
    // happened, and must not read as the "up to date" success copy.
    expect(text).toContain("4");
    expect(text).toContain("8");
    expect(text).toContain("2");
    expect(text).not.toBe(msg("schedule.notice.nothingNew"));
  });

  // F2a (P7 follow-up): the seeded-path analogue — a `.seeding` group stage
  // whose placed qualifiers can't fill its configured pools
  // (generateSeededStageFixtures) throws the same STAGE_NOT_READY shape with
  // a distinct reason. Same actionable-banner treatment as the plain path.
  it("returns an actionable message for a seeded group stage whose qualifiers can't fill its pools", () => {
    const err = new ApiV1Error(
      "not enough qualifiers to fill 4 groups — each group needs at least 2 (have 6, need 8); 2 would never receive a fixture",
      422,
      "STAGE_NOT_READY",
      { reason: "seeded_pool_too_few_qualifiers", groups: 4, qualifiers: 6, required: 8, stranded: 2 },
    );
    const text = generatePreconditionMessage(err, msg);
    expect(text).not.toBeNull();
    expect(text).toContain("4");
    expect(text).toContain("8");
    expect(text).toContain("6");
    // Minor 1 (P7 fix round, whole-branch review): `stranded` is the one
    // datum this message adds over the plain-path copy — assert it actually
    // reaches the rendered text, not just that it's present on `.extra`.
    expect(text).toContain("2");
    expect(text).not.toBe(msg("schedule.notice.nothingNew"));
  });

  // Major (P7 fix round, whole-branch review): groups<=1 — an ungrouped
  // seeded kind (knockout/page_playoff/double_elim/stepladder/league) — used
  // to fall through to the PLAIN path's tooFewEntrants copy ("add at least 2
  // entrants to this stage first"). That advice cannot be followed: a
  // `.seeding` stage's entrants are synthetic slot:N seeds minted from
  // seeding.take rules (stages.ts:1399-1403), not rows a user can add. This
  // must render seeded-specific, actionable copy instead.
  //
  // NOTE: an earlier version of this comment also claimed "a group-kind stage
  // left at pools.count's default of 1" reaches this branch. That is FALSE and
  // was disproven by reading the generators: with one pool stages.ts:655-656
  // runs a full-field round robin, which strands nobody, so stranding requires
  // count > 1 and that forces the groups > 1 branch. This case is a shape
  // tripwire for a future generator regression, not a live user path.
  it("returns the seeded-specific message (not tooFewEntrants) for a seeded stage with groups <= 1", () => {
    const err = new ApiV1Error("1 of 3 qualifiers would never receive a fixture", 422, "STAGE_NOT_READY", {
      reason: "seeded_pool_too_few_qualifiers",
      groups: 1,
      qualifiers: 3,
      required: 2,
      stranded: 1,
    });
    const text = generatePreconditionMessage(err, msg);
    expect(text).not.toBeNull();
    expect(text).not.toBe(msg("schedule.error.tooFewEntrants"));
    expect(text).toBe(msg("schedule.error.tooFewQualifiers", { qualifiers: 3, stranded: 1 }));
    // The stranded count is the datum this copy adds — confirm it renders.
    expect(text).toContain("1");
    expect(text).toContain("3");
  });

  it("returns null for an unrelated ApiV1Error (falls through to the generic error banner)", () => {
    const err = new ApiV1Error("boom", 500, "INTERNAL", {});
    expect(generatePreconditionMessage(err, msg)).toBeNull();
  });

  it("returns null for a plain Error (not an ApiV1Error)", () => {
    expect(generatePreconditionMessage(new Error("network down"), msg)).toBeNull();
  });

  it("returns null for PAYMENT_REQUIRED so the paywall gate still wins", () => {
    const err = new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" });
    expect(generatePreconditionMessage(err, msg)).toBeNull();
  });
});
