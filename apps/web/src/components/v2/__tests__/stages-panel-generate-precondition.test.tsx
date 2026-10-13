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

  // W2c P-7 / X-AB-5 (fix round 1, I2): the next Swiss round is refused while an abandoned board has no result. The
  // organiser must read WHICH board(s) to settle, in their own language - not the generic failure banner.
  describe("swiss_abandoned_boards (X-AB-5)", () => {
    const refusal = (abandoned: unknown) => new ApiV1Error("current swiss round has undecided fixtures", 422, "STAGE_NOT_READY", { reason: "swiss_abandoned_boards", abandoned });
    const b = (round: number, board: number) => ({ fixtureId: `f-${round}-${board}`, round, board });

    it("one board: the singular sentence naming round and board", () => {
      const text = generatePreconditionMessage(refusal([b(1, 3)]), msg);
      expect(text).toBe(msg("schedule.error.swissAbandonedOne", { boards: msg("schedule.error.swissAbandonedRef", { round: 1, board: 3 }) }));
      expect(text).toContain("round 1 board 3");
    });

    it("several boards: the plural sentence naming each, in the order given", () => {
      const text = generatePreconditionMessage(refusal([b(1, 2), b(1, 5), b(2, 1)]), msg)!;
      expect(text).toBe(
        msg("schedule.error.swissAbandonedMany", {
          boards: ["round 1 board 2", "round 1 board 5", "round 2 board 1"].join(", "),
        }),
      );
      expect(text.indexOf("round 1 board 2")).toBeLessThan(text.indexOf("round 1 board 5"));
      expect(text).not.toBe(msg("schedule.error.swissAbandonedOne", { boards: "round 1 board 2" }));
    });

    it("an unreadable list keeps the code's own copy (null), never a guess", () => {
      for (const abandoned of [undefined, [], [{ fixtureId: "f", round: 0, board: 1 }], "x"]) expect(generatePreconditionMessage(refusal(abandoned), msg), JSON.stringify(abandoned)).toBeNull();
    });

    it("the same STAGE_NOT_READY without the reason is not mistaken for it", () => {
      const err = new ApiV1Error("x", 422, "STAGE_NOT_READY", { abandoned: [b(1, 1)] });
      expect(generatePreconditionMessage(err, msg)).toBeNull();
    });
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
