// Bug fix (2026-08-18): opening the "League + Playoffs — 8 teams" template
// (catalog key "league-playoff", whose only Pro-gated stage is a Page
// playoff — kind "page_playoff") on a Community org showed the Pro gate
// "Double-elimination brackets are a Pro format." There is no double
// elimination in that template — `formats.double_elim` legitimately gates
// BOTH "double_elim" and "page_playoff" (format-gates.ts's
// stageNeedsDoubleElimGate, owner ruling: sharing the entitlement is correct
// and unchanged), but the copy always named double-elimination regardless of
// which kind actually triggered it.
//
// `paywallFromError` is the pure decision `TemplateDetailSheet`'s submit()
// catch block makes when a POST to /api/v1/competitions/from-template 402s —
// pulled out and exported so it can be tested directly, the same way this
// directory already tests `generatePreconditionMessage`
// (stages-panel-generate-precondition.test.tsx) and pure derivation helpers
// in template-gallery-progression.test.tsx: no jsdom in this workspace, so a
// real click-through-fetch-catch cycle can't be driven, and the derivation
// is exactly the kind of logic that pulls out cleanly (component-ui-i18n
// memory).
import { describe, expect, it } from "vitest";
import { paywallFromError } from "../template-gallery";
import { ApiV1Error } from "@/lib/client-v1";
import { featureReason } from "@/lib/feature-copy";
import { getTemplate } from "@/server/templates/catalog";
import type { CompetitionTemplate } from "@/server/templates/schema";

const leaguePlayoff = getTemplate("league-playoff");
if (!leaguePlayoff) {
  throw new Error("league-playoff missing from the catalog — catalog.test.ts should already fail this");
}

// Same template, but its page_playoff stage relabelled double_elim — proves
// the double-elim wording still applies to a template that actually
// contains one. No catalog entry uses "double_elim" today (template-gallery
// header comment), so this has to be synthesized rather than looked up.
const doubleElimTemplate: CompetitionTemplate = {
  ...leaguePlayoff,
  divisions: leaguePlayoff.divisions.map((division) => ({
    ...division,
    stages: division.stages.map((stage) =>
      stage.kind === "page_playoff" ? { ...stage, kind: "double_elim" as const } : stage,
    ),
  })),
};

function paymentRequired(featureKey: string): ApiV1Error {
  return new ApiV1Error("Plan upgrade required", 402, "PAYMENT_REQUIRED", { feature_key: featureKey });
}

describe("paywallFromError — template-gallery's 402 -> paywall state", () => {
  it("returns null for a plain Error (falls through to the generic error banner)", () => {
    expect(paywallFromError(new Error("network down"), leaguePlayoff)).toBeNull();
  });

  it("returns null for an ApiV1Error that isn't PAYMENT_REQUIRED", () => {
    const err = new ApiV1Error("bad input", 400, "VALIDATION", {});
    expect(paywallFromError(err, leaguePlayoff)).toBeNull();
  });

  it("names the Page playoff format for the real League + Playoffs template, never double-elimination", () => {
    const paywall = paywallFromError(paymentRequired("formats.double_elim"), leaguePlayoff);
    expect(paywall?.feature).toBe("formats.double_elim");
    expect(paywall?.reason).toMatch(/page playoff/i);
    expect(paywall?.reason).not.toMatch(/double-elimination/i);
  });

  it("keeps the current double-elimination wording, unchanged, for a template that really gates on double_elim", () => {
    const paywall = paywallFromError(paymentRequired("formats.double_elim"), doubleElimTemplate);
    expect(paywall?.reason).toBe(featureReason("formats.double_elim"));
  });

  it("leaves reason undefined for any other feature key — UpgradeGate's own default still applies", () => {
    const paywall = paywallFromError(paymentRequired("formats.advanced"), leaguePlayoff);
    expect(paywall).toEqual({ feature: "formats.advanced" });
  });
});
