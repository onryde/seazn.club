// Admit tickets read `registrations`, not `entrants`, so a competition whose
// organiser added entrants directly has nothing to ticket. Before this suite
// that case rendered a branded page with zero ticket sections and returned it
// as a 200 PDF, which is indistinguishable from a working export. Every other
// document that can be inapplicable refuses instead — see the bracket arm's
// BRACKET_NOT_AVAILABLE (exports.ts) — so this one does too.
import { describe, it, expect } from "vitest";
import { HttpError } from "@/lib/errors";
import { generateRefCode } from "@/lib/ref-code";
import { asOwner, rig, seedOrg, seedRegistration } from "./_registration-fixtures";
import { buildAdmitTicketsDoc } from "@/server/usecases/exports";

const PRINTED_AT = "2026-08-24T10:00:00.000Z";
const SETTINGS = { fee_cents: 2000, currency: "gbp", payment_method: "offline" as const };

async function ownerWithCompetition() {
  const { orgId, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  return { owner, competition, division };
}

describe("buildAdmitTicketsDoc", () => {
  it("builds one ticket section per confirmed registration", async () => {
    const { owner, competition, division } = await ownerWithCompetition();
    for (const displayName of ["Alex Morgan", "Priya Raghavan", "Tom Okafor"]) {
      await seedRegistration(competition.id, division.id, SETTINGS, {
        displayName,
        status: "confirmed",
        refCode: generateRefCode(),
      });
    }

    const model = await buildAdmitTicketsDoc(owner, competition.id, { printedAt: PRINTED_AT });
    expect(model.sections).toHaveLength(3);
  });

  it("refuses with 422 TICKETS_NOT_AVAILABLE when no registration is confirmed", async () => {
    const { owner, competition } = await ownerWithCompetition();

    await expect(
      buildAdmitTicketsDoc(owner, competition.id, { printedAt: PRINTED_AT }),
    ).rejects.toMatchObject({ status: 422, code: "TICKETS_NOT_AVAILABLE" });
  });

  it("refuses when registrations exist but none has reached confirmed", async () => {
    const { owner, competition, division } = await ownerWithCompetition();
    await seedRegistration(competition.id, division.id, SETTINGS, {
      displayName: "Unpaid Ursula",
      status: "pending",
      refCode: generateRefCode(),
    });

    await expect(
      buildAdmitTicketsDoc(owner, competition.id, { printedAt: PRINTED_AT }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
