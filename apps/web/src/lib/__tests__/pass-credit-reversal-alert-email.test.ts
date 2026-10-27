// Body copy for the staff alert queued when a refunded Event Pass credit could
// NOT be safely reversed (`reason: "undetermined"`, pass-credit.ts §5).
//
// The alert used to end at "nothing was automatically reversed", which reads
// like the only outstanding item is a number to check in Stripe. It isn't: the
// undetermined row goes on holding `pass_credit_redemptions_group_cap` (V337 /
// #286), so the billing group's ONE lifetime Event Pass credit is blocked for
// every org in it, and settling the customer's balance in Stripe does not
// release it — there is no self-serve release this wave. A staff member acting
// on the old wording would close the ticket with a customer silently unable to
// ever earn another pass credit.
//
// Internal staff alert: NOT localised (unlike the customer-facing builders in
// email-templates/, this one takes no `locale`/`Dict` and is composed inline in
// lib/email.ts), so English is the only copy to assert.
//
// Asserted by calling the builder (`passCreditReversalIncompleteAlertEmail`)
// that `alertPassCreditReversalIncomplete` (pass-credit.ts) renders onto the
// email outbox as kind `staff_pass_credit_reversal_incomplete`;
// pass-credit-refund-reversal.test.ts proves the row is queued.
import { describe, expect, it } from "vitest";
import { passCreditReversalIncompleteAlertEmail } from "../email";

const base = {
  // The pre-#294 shape of this alert, so the existing cases keep meaning what
  // they meant; the rung-naming cases at the bottom vary it.
  passKey: "event_pass" as const,
  orgId: "org-123",
  orgName: "Riverside Racquets",
  competitionName: "Spring Open 2026",
  grantedMinor: 2500,
  currency: "gbp",
};

describe("pass credit reversal alert — undetermined", () => {
  it("says the group's lifetime credit is BLOCKED and cannot be released in Stripe", () => {
    const { subject, text, html } = passCreditReversalIncompleteAlertEmail({
      ...base,
      reversedMinor: 0,
      reason: "undetermined",
    });

    expect(subject).toBe(`Pass credit reversal skipped — needs manual review — org ${base.orgId}`);
    // The existing "nothing was reversed" line is not enough on its own — the
    // consequence has to be spelled out.
    expect(text).toContain("nothing was automatically reversed");
    expect(text.toLowerCase()).toContain("blocked");
    expect(text).toContain("lifetime Event Pass credit");
    // Settling the balance in Stripe is the obvious-but-wrong next step.
    expect(text).toContain("does NOT release it");
    // And there is no button anywhere that clears it today.
    expect(text).toContain("no self-serve way");
    // Same copy reaches the HTML part, not just the plain-text fallback.
    expect(html.toLowerCase()).toContain("blocked");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("does NOT claim a block on the ordinary consumed-remainder alert", () => {
    // "consumed" reversals did claw back what they could and cleared the cap;
    // telling staff that group is blocked would be a lie.
    const { subject, text } = passCreditReversalIncompleteAlertEmail({
      ...base,
      reversedMinor: 1000,
      reason: "consumed",
    });

    expect(subject).toBe(`Pass credit reversal incomplete — org ${base.orgId}`);
    expect(text.toLowerCase()).not.toContain("blocked");
    expect(text).toContain("written off");
  });
});

// v17 #294 — the same defect class as the buyer's refund email, one file over.
// Every sentence in this alert said "An Event Pass credit for …", so a staff
// member triaging a $59 Event Pass L reversal went looking for a $29 charge.
// Ops-only copy, so English is the only version to assert.
describe("pass credit reversal alert — the rung it names", () => {
  const render = (passKey: "event_pass" | "event_pass_l", reason: "consumed" | "undetermined") =>
    passCreditReversalIncompleteAlertEmail({
      ...base,
      passKey,
      reversedMinor: reason === "undetermined" ? 0 : 1000,
      reason,
    });

  it("names the rung on BOTH reasons, and never the other rung", () => {
    // Both branches build their own sentence, so a fix applied to one of them
    // leaves the other lying.
    let checked = 0;
    for (const reason of ["consumed", "undetermined"] as const) {
      expect(render("event_pass_l", reason).text, reason).toContain("Event Pass L");

      const m = render("event_pass", reason).text;
      expect(m, reason).toContain("Event Pass M");
      expect(m, reason).not.toContain("Event Pass L");
      checked++;
    }
    expect(checked, "anti-vacuity: both reasons were rendered").toBe(2);
  });

  it("carries the rung into the eyebrow the reader sees first", () => {
    expect(render("event_pass_l", "undetermined").html).toContain("Event Pass L");
  });
});
