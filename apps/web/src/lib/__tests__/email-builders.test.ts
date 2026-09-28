// Every email builder now composes from the HTML files in email-templates/html.
// These tests fail against the old string-literal card() templates: they assert
// the courtside shell (slab masthead, preheader, court line), escaping of
// user-supplied content, and that no {{TOKEN}} leaks into a sent email.
import { describe, expect, it } from "vitest";
import {
  accountDeletionTemplate,
  disputeAlertTemplate,
  disputeLostTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  inviteTemplate,
  magicLinkTemplate,
  officialAssignedTemplate,
  officialAssignmentChangedTemplate,
  officialInviteTemplate,
  passRevokedTemplate,
  staffDisputeAlertTemplate,
  passwordResetTemplate,
  paymentReminderTemplate,
  refundIssuedTemplate,
  registrationPromotedTemplate,
  registrationTemplate,
  sponsorInvoiceTemplate,
  sponsorReceiptTemplate,
  sponsorRefundTemplate,
  sponsorDisputeAlertTemplate,
  sponsorDisputeLostTemplate,
  verificationTemplate,
} from "../email-templates";
import { standingsTable } from "../email-templates/compose";
import type { Dict } from "@/lib/i18n";
import { buildPseudoDictionary } from "@/lib/pseudo";
// Localized builders take the emails dict; the en namespace is the source text.
import emailsEn from "@/dictionaries/en/emails.json";
import { PASS_KEYS, type PassKey } from "@/lib/currency";

const LINK = "https://seazn.club/x?token=abc";

// Single-entry shaped — feeds paymentReminderTemplate/registrationPromotedTemplate
// below, which are UNCHANGED by RS005 W4 (only registrationTemplate went
// cart-shaped). Kept under its original name since those two callers still
// take these exact fields.
const registrationArgs = {
  orgName: "Riverside Racquets",
  competitionName: "Spring Open 2026",
  displayName: "Alex",
  status: "pending",
  feeCents: 2500,
  currency: "gbp",
  paymentInstructions: "Bank transfer\nRef: SPRING",
  statusUrl: LINK,
};

// Cart-shaped — RS005 W4: registrationTemplate now takes an entries array +
// a cart total instead of one displayName/status/feeCents. A single-entry
// cart (the common case) so most existing assertions carry over unchanged;
// the multi-entry shape gets its own dedicated tests below.
const registrationCartArgs = {
  orgName: "Riverside Racquets",
  competitionName: "Spring Open 2026",
  entries: [{ displayName: "Alex", status: "pending", feeCents: 2500 }],
  totalCents: 2500,
  currency: "gbp",
  paymentInstructions: "Bank transfer\nRef: SPRING",
  statusUrl: LINK,
};

// Each entry pairs a builder (built from `dict`) with the dict key that supplies
// its subject line — the localization regression overrides that key and asserts
// the output follows (the pre-i18n templates ignored the dict entirely).
function makeBuilders(
  dict: Dict,
): [string, { subject: string; html: string; text: string }, string][] {
  return [
    ["verification", verificationTemplate(LINK, dict), "verification.subject"],
    ["password-reset", passwordResetTemplate(LINK, dict), "passwordReset.subject"],
    ["magic-link", magicLinkTemplate(LINK, dict), "magicLink.subject"],
    ["email-change-confirm", emailChangeConfirmTemplate(LINK, dict), "emailChangeConfirm.subject"],
    [
      "email-change-notice",
      emailChangeNoticeTemplate("new@example.com", dict),
      "emailChangeNotice.subject",
    ],
    ["account-deletion", accountDeletionTemplate(dict), "accountDeletion.subject"],
    ["invite", inviteTemplate("Riverside Racquets", LINK, dict), "invite.subject"],
    ["registration", registrationTemplate(registrationCartArgs, dict), "registration.subject"],
    ["payment-reminder", paymentReminderTemplate(registrationArgs, dict), "paymentReminder.subject"],
    [
      "registration-promoted",
      registrationPromotedTemplate(
        {
          ...registrationArgs,
          payUrl: LINK,
          payDeadline: "2026-08-01T12:00:00Z",
          refCode: "SZ-ABCD-EFGH",
          refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFGH",
        },
        dict,
      ),
      "registrationPromoted.subject",
    ],
    [
      "refund-issued",
      refundIssuedTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
        },
        dict,
      ),
      "refundIssued.subject",
    ],
    [
      "dispute-alert",
      disputeAlertTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
        },
        dict,
      ),
      "disputeAlert.subject",
    ],
    [
      "dispute-lost",
      disputeLostTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
          recoveredCents: 2375,
          consoleUrl: LINK,
        },
        dict,
      ),
      "disputeLost.subject",
    ],
    [
      "sponsor-invoice",
      sponsorInvoiceTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
          checkoutUrl: LINK,
        },
        dict,
      ),
      "sponsorInvoice.subject",
    ],
    [
      "sponsor-receipt",
      sponsorReceiptTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
          publicUrl: "https://seazn.club/shared/riverside",
        },
        dict,
      ),
      "sponsorReceipt.subject",
    ],
    [
      "sponsor-refund",
      sponsorRefundTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
        },
        dict,
      ),
      "sponsorRefund.subject",
    ],
    [
      "sponsor-dispute-alert",
      sponsorDisputeAlertTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
        },
        dict,
      ),
      "sponsorDisputeAlert.subject",
    ],
    [
      "sponsor-dispute-lost",
      sponsorDisputeLostTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
          recoveredCents: 23_750,
        },
        dict,
      ),
      "sponsorDisputeLost.subject",
    ],
    [
      "pass-revoked",
      passRevokedTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          passKey: "event_pass",
        },
        dict,
      ),
      "passRevoked.subject",
    ],
    [
      "staff-dispute-alert",
      staffDisputeAlertTemplate(
        {
          kind: "subscription",
          orgName: "Riverside Racquets",
          phase: "closed",
          status: "lost",
          amountCents: 1900,
          currency: "gbp",
          disputeId: "dp_test123",
        },
        dict,
      ),
      "staffDisputeAlert.subject",
    ],
    [
      "official-invite",
      officialInviteTemplate(
        { orgName: "Riverside Racquets", personName: "Priya <Ref>", claimUrl: LINK },
        dict,
      ),
      "officialInvite.subject",
    ],
    [
      "official-assigned",
      officialAssignedTemplate(
        {
          orgName: "Riverside Racquets",
          officialName: "Priya",
          meUrl: LINK,
          fixtures: [
            {
              label: "A & Co <vs> B",
              role_key: "referee",
              scheduled_at: "2026-08-01T09:00:00Z",
              venue_tz: "Europe/London",
              venue: "Main Hall",
              court_label: "Court 1",
            },
          ],
        },
        dict,
      ),
      "officialAssigned.subject",
    ],
    [
      "official-assignment-changed",
      officialAssignmentChangedTemplate(
        {
          orgName: "Riverside Racquets",
          officialName: "Priya",
          roleKey: "referee",
          label: "A vs B",
          prevAt: "2026-08-01T09:00:00Z",
          nextAt: "2026-08-01T11:30:00Z",
          venueTz: "Europe/London",
          court: "Court 2",
          venue: "Main Hall",
          meUrl: LINK,
        },
        dict,
      ),
      "officialChanged.subject",
    ],
  ];
}

const allBuilders = makeBuilders(emailsEn as Dict);

describe("email builders compose from the html templates", () => {
  for (const [name, out] of allBuilders) {
    it(`${name}: courtside shell, no unresolved tokens, non-empty text`, () => {
      // Stadium-night slab + pitch line + ball come from base.html only.
      expect(out.html).toContain('bgcolor="#150b36"');
      expect(out.html).toContain('bgcolor="#a3e635"');
      expect(out.html).toContain("&#9679;");
      // Direction B: one bulletproof system stack, no web fonts (see
      // email-html-templates.test.ts for the full font pin).
      expect(out.html).toContain(
        "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
      );
      expect(out.html).not.toContain("fonts.googleapis.com");
      // Preheader div present and filled.
      expect(out.html).toContain("mso-hide:all");
      // No template token survives substitution.
      expect(out.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      // No i18n placeholder leaks (an un-passed {var} would).
      expect(out.subject).not.toMatch(/\{\w+\}/);
      // Plain-text part still populated.
      expect(out.text.length).toBeGreaterThan(10);
      expect(out.subject.length).toBeGreaterThan(5);
    });
  }

  it("every builder reads the provided dict, not hardcoded English", () => {
    for (const [name, , subjectKey] of allBuilders) {
      const marker = `SUBJ_${name.toUpperCase()}`;
      const fr = { ...(emailsEn as Dict), [subjectKey]: marker } as Dict;
      const [, out] = makeBuilders(fr).find(([n]) => n === name)!;
      expect(out.subject).toBe(marker);
    }
  });

  // Email-side equivalent of the SEAZN_PSEUDO Playwright audit: build every
  // template from the en-XA pseudo dict; all copy must be ⟦…⟧-wrapped, so any
  // un-extracted (hardcoded) English string would leak through un-wrapped.
  it("pseudolocale audit: all copy comes from the dict, nothing hardcoded", () => {
    const pseudo = buildPseudoDictionary(emailsEn as Dict) as Dict;
    for (const [name, out] of makeBuilders(pseudo)) {
      expect(out.subject.startsWith("⟦"), `${name}: subject not from dict`).toBe(true);
      expect(out.html, `${name}: body copy not from dict`).toContain("⟦");
    }
  });

  it("card registration carries a Pay now button and the deadline", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        paymentInstructions: null,
        payUrl: "https://checkout.stripe.test/cs_1",
        payDeadline: "2026-08-01T12:00:00Z",
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("https://checkout.stripe.test/cs_1");
    expect(out.html).toContain("Pay now");
    expect(out.text).toContain("https://checkout.stripe.test/cs_1");
  });

  it("card payment reminder links the fresh checkout, offline keeps instructions", () => {
    const card = paymentReminderTemplate(
      {
        ...registrationArgs,
        paymentInstructions: null,
        checkoutUrl: "https://checkout.stripe.test/cs_2",
        payDeadline: "2026-08-01T12:00:00Z",
      },
      emailsEn as Dict,
    );
    expect(card.html).toContain("https://checkout.stripe.test/cs_2");
    const offline = paymentReminderTemplate(registrationArgs, emailsEn as Dict);
    expect(offline.html).toContain("Bank transfer");
  });

  it("dispute-lost email states the loss, the balance debit and who pays the fee", () => {
    const out = disputeLostTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 2000, currency: "gbp", refCode: "SZ-XXXX-YYYY",
        recoveredCents: 1900, consoleUrl: LINK,
      },
      emailsEn as Dict,
    );
    expect(out.subject.toLowerCase()).toContain("dispute lost");
    expect(out.text).toContain("SZ-XXXX-YYYY");
    expect(out.text).toContain("£20.00"); // disputed amount
    expect(out.text).toContain("£19.00"); // recovered from the club's balance
    expect(out.text.toLowerCase()).toContain("stripe balance");
    expect(out.text.toLowerCase()).toContain("dispute fee");
    expect(out.html).toContain(`href="${LINK}"`);
    // Recovery failed → no false claim that money moved.
    const failed = disputeLostTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 2000, currency: "gbp", refCode: null,
        recoveredCents: 0, consoleUrl: LINK,
      },
      emailsEn as Dict,
    );
    expect(failed.text.toLowerCase()).not.toContain("recovered from your stripe balance");
  });

  it("refund email states the amount; dispute alert warns the organiser", () => {
    const refund = refundIssuedTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 1234, currency: "gbp", refCode: null,
      },
      emailsEn as Dict,
    );
    expect(refund.text).toContain("12.34");
    const dispute = disputeAlertTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 1234, currency: "gbp", refCode: "SZ-XXXX-YYYY",
      },
      emailsEn as Dict,
    );
    expect(dispute.subject.toLowerCase()).toContain("dispute");
    expect(dispute.text).toContain("SZ-XXXX-YYYY");
  });

  it("CTA builders carry the link in a button href", () => {
    for (const t of [
      verificationTemplate(LINK, emailsEn as Dict),
      passwordResetTemplate(LINK, emailsEn as Dict),
      magicLinkTemplate(LINK, emailsEn as Dict),
      emailChangeConfirmTemplate(LINK, emailsEn as Dict),
      inviteTemplate("Org", LINK, emailsEn as Dict),
      registrationTemplate(registrationCartArgs, emailsEn as Dict),
    ]) {
      expect(t.html).toContain(`href="${LINK}"`);
    }
  });

  it("registration escapes user-supplied names in the html", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        competitionName: 'Spring <script>alert("x")</script>',
        entries: [{ displayName: "A & B", status: "pending", feeCents: 2500 }],
      },
      emailsEn as Dict,
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("A &amp; B");
  });

  it("registration renders fee panel with instructions preserved", () => {
    const out = registrationTemplate(registrationCartArgs, emailsEn as Dict);
    expect(out.html).toContain("Entry fee: £25.00");
    expect(out.html).toContain(">Bank transfer\nRef: SPRING</p>");
  });

  it("registration carries the reference number + status link in html AND text (v3/05 §3)", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        refCode: "SZ-ABCD-EFG2",
        refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFG2",
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("SZ-ABCD-EFG2");
    expect(out.html).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    expect(out.text).toContain("Your reference: SZ-ABCD-EFG2");
    expect(out.text).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    // Rows without a ref (pre-v2) keep the old shape — no dangling label.
    expect(registrationTemplate(registrationCartArgs, emailsEn as Dict).text).not.toContain(
      "Your reference",
    );
  });

  it("registration waitlist variant drops the fee panel", () => {
    const out = registrationTemplate(
      { ...registrationCartArgs, entries: [{ displayName: "Alex", status: "waitlisted", feeCents: 0 }], totalCents: 0 },
      emailsEn as Dict,
    );
    expect(out.html).toContain("on the waitlist");
    expect(out.html).not.toContain("Entry fee");
  });

  // RS005 W4: the cart-shaped rewrite's own acceptance bar — a single-entry
  // cart (the common case) must still read like the pre-cart email, not a
  // list of one.
  it("single-entry cart reads as a single-entry email — no cart list, no entry count", () => {
    const out = registrationTemplate(registrationCartArgs, emailsEn as Dict);
    expect(out.html).toContain("Thanks Alex");
    expect(out.html).not.toContain("Your entries");
    expect(out.text).not.toContain("Your entries");
  });

  // The assertion the whole finding hinges on: a cart with one confirmed and
  // one waitlisted entry must show BOTH their own states, not one repeated
  // (owner ruling 2026-08-25: rejects one-email-per-cart on the old
  // single-entry template for exactly this failure mode).
  it("multi-entry cart renders every entry with its OWN status, not one repeated", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        entries: [
          { displayName: "Riverside A", status: "confirmed", feeCents: 0 },
          { displayName: "Riverside B", status: "waitlisted", feeCents: 0 },
        ],
        totalCents: 0,
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("Riverside A");
    expect(out.html).toContain("Riverside B");
    expect(out.html).toContain("Confirmed");
    expect(out.html).toContain("Waitlisted");
    expect(out.text).toContain("Riverside A");
    expect(out.text).toContain("Riverside B");
    expect(out.text).toContain("Confirmed");
    expect(out.text).toContain("Waitlisted");
    // Not the single-entry intro — a cart of two must not claim to be one.
    expect(out.html).not.toContain("Thanks Riverside A");
  });

  it("multi-entry cart: a paid entry's own fee appears on its line, a waitlisted entry's does not", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        entries: [
          { displayName: "Team Paid", status: "pending", feeCents: 1500 },
          { displayName: "Team Waitlisted", status: "waitlisted", feeCents: 0 },
        ],
        totalCents: 1500,
      },
      emailsEn as Dict,
    );
    expect(out.text).toContain("Team Paid — Pending (£15.00)");
    expect(out.text).toContain("Team Waitlisted — Waitlisted");
    expect(out.text).not.toContain("Team Waitlisted — Waitlisted (");
  });

  // RS005 F1 finding 1: reusing this cart-shaped template for a RESEND (or a
  // dispute-evidence reconstruction) on an already-settled entry must not
  // re-ask for money already given — `totalCents` alone (the cart's whole
  // historical subtotal) can't tell "still owed" from "already collected".
  it("a settled (paid/confirmed) single entry gets no fee panel at all on resend/reconstruction", () => {
    for (const status of ["paid", "confirmed"] as const) {
      const out = registrationTemplate(
        { ...registrationCartArgs, entries: [{ displayName: "Alex", status, feeCents: 2500 }] },
        emailsEn as Dict,
      );
      expect(out.html, `status=${status}`).not.toContain("Entry fee");
      expect(out.text, `status=${status}`).not.toContain("Entry fee");
      // Not a blank/broken mail — the "received" framing still renders.
      expect(out.html, `status=${status}`).toContain("Thanks Alex");
    }
  });

  // Withdrawn/rejected/expired are the same "nothing left owed" case as
  // paid/confirmed, just via a different route (the money was never
  // collected AND never will be) — same gate, same expectation.
  it("a withdrawn/rejected/expired single entry also gets no fee panel", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      const out = registrationTemplate(
        { ...registrationCartArgs, entries: [{ displayName: "Alex", status, feeCents: 2500 }] },
        emailsEn as Dict,
      );
      expect(out.html, `status=${status}`).not.toContain("Entry fee");
    }
  });

  // A mixed cart must quote what is STILL owed, not the cart's whole
  // historical subtotal (which would overstate it once one entry is
  // already settled) — same underlying bug as the single-entry case above,
  // just visible even when SOME money genuinely is still due.
  it("a mixed cart's fee panel quotes only the entry still pending, not the whole cart's subtotal", () => {
    const out = registrationTemplate(
      {
        ...registrationCartArgs,
        entries: [
          { displayName: "Already Paid", status: "confirmed", feeCents: 2500 },
          { displayName: "Still Owing", status: "pending", feeCents: 1500 },
        ],
        // A caller might still pass the whole-cart historical subtotal here
        // (registrations.ts's own `totalCents` field) — the template must
        // not use it for the amount it quotes as due.
        totalCents: 4000,
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("Entry fee: £15.00");
    expect(out.html).not.toContain("£40.00");
  });

  it("payment reminder without instructions points at the organiser", () => {
    const out = paymentReminderTemplate(
      { ...registrationArgs, paymentInstructions: null },
      emailsEn as Dict,
    );
    expect(out.html).toContain("Please contact Riverside Racquets to arrange payment.");
  });

  it("standings table renders leader accent + zebra rows, escaped names", () => {
    const html = standingsTable({
      title: "Division 1",
      meta: "After week 6",
      nameHeader: "Team",
      rows: [
        { rank: 1, name: "A & B", played: 6, won: 6, lost: 0, points: 18, leader: true },
        { rank: 2, name: "C", played: 6, won: 4, lost: 2, points: 12 },
        { rank: 3, name: "D", played: 6, won: 3, lost: 3, points: 9 },
      ],
    });
    expect(html).toContain("border-left:3px solid #7c3aed"); // leader accent bar
    expect(html).toContain("A &amp; B");
    // Zebra alternation over row indices (rows 2 and 3 get opposite fills).
    expect(html).toContain('bgcolor="#faf9fc"');
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  // v17 #294: two Event Pass rungs at different prices. The staff dispute alert
  // names the disputed product, so the label has to distinguish them — otherwise
  // a $59 L chargeback is triaged as the $29 M product.
  it("staff dispute alert names the Event Pass RUNG that was disputed", () => {
    const alert = (kind: "subscription" | "event_pass" | "event_pass_l") =>
      staffDisputeAlertTemplate(
        {
          kind,
          orgName: "Riverside Racquets",
          phase: "closed",
          status: "lost",
          amountCents: 5900,
          currency: "usd",
          disputeId: "dp_test123",
        },
        emailsEn as Dict,
      );

    expect(alert("event_pass").subject).toContain("Event Pass");
    expect(alert("event_pass_l").subject).toContain("Event Pass L");
    // Distinct, and neither is the subscription label.
    const labels = (["subscription", "event_pass", "event_pass_l"] as const).map(
      (k) => alert(k).subject,
    );
    expect(new Set(labels).size).toBe(3);
    // A lost dispute on EITHER rung revokes the pass; only a subscription is
    // downgraded. The outcome branch keys on "is this a subscription", so it must
    // still take the revoke arm for a rung it has never seen before.
    expect(alert("event_pass_l").text).toContain("revoked");
    expect(alert("event_pass_l").text).not.toContain("auto-downgraded");
    expect(alert("subscription").text).toContain("auto-downgraded");

    // …and the revoke sentence — the one line that says what was taken away —
    // names the rung too. It hardcoded "the Event Pass" for both, so a lost $59
    // L chargeback described the $29 product in the sentence a staffer acts on.
    expect(alert("event_pass_l").text).toContain("the Event Pass L has been revoked");
    expect(alert("event_pass").text).toContain("the Event Pass has been revoked");
    expect(alert("event_pass").text).not.toContain("Event Pass L");
  });

  // Streaming R1 lane-B tail (OWNER RULING 2026-09-28): a disputed MATCH-CREDIT
  // pack charge is a third product on this alert. Its outcome is neither a
  // downgrade nor a pass revoke, and the pass sentence ("the competition
  // returns to the plan allowance") is false in both halves for it — no
  // competition is involved, and the claw-back is capped at the balance.
  it("staff dispute alert names match credits and describes the CAPPED claw-back", () => {
    const alert = (kind: "subscription" | "stream_credits" | "event_pass", status: string) =>
      staffDisputeAlertTemplate(
        {
          kind,
          orgName: "Riverside Racquets",
          phase: "closed",
          status,
          amountCents: 2500,
          currency: "gbp",
          disputeId: "dp_test_stream",
        },
        emailsEn as Dict,
      );

    // A label of its own, distinct from the other two products' — the whole
    // reason `kind` is a union and not a boolean.
    const lost = alert("stream_credits", "lost");
    expect(lost.subject).toMatch(/match credits/i);
    expect(new Set([lost.subject, alert("subscription", "lost").subject, alert("event_pass", "lost").subject]).size).toBe(3);

    // The outcome line is the sentence a staffer acts on.
    expect(lost.text).toMatch(/capped at the balance left/i);
    expect(lost.text).not.toContain("auto-downgraded");
    expect(lost.text).not.toMatch(/returns to the plan allowance/);
    // A WON dispute takes neither arm — the credits stay where they are.
    expect(alert("stream_credits", "won").text).toMatch(/dispute flag has been cleared/i);
    expect(alert("stream_credits", "won").text).not.toMatch(/capped at the balance left/i);
  });
});

// v17 #294 — the BUYER-facing counterpart of the staff dispute alert above.
// `passRevokedTemplate` had no rung field at all, so an org refunded on a $59
// Event Pass L was emailed "Your Event Pass was refunded" — the $29 product's
// name, in the one message that tells them what they got their money back for.
describe("pass-revoked names the rung that was refunded", () => {
  const revoked = (passKey: PassKey) =>
    passRevokedTemplate(
      { orgName: "Riverside Racquets", competitionName: "Spring Open 2026", passKey },
      emailsEn as Dict,
    );

  it("names the rung in the subject", () => {
    expect(revoked("event_pass_l").subject).toContain("Event Pass L");
    expect(revoked("event_pass").subject).toContain("Event Pass M");
  });

  it("gives the two rungs DIFFERENT subject, body and text", () => {
    // Both arms and every part: a template that interpolated the rung into the
    // subject alone would still tell an L buyer, in the body of the mail, that
    // "the Event Pass" was refunded.
    const m = revoked("event_pass");
    const l = revoked("event_pass_l");
    expect(l.subject).not.toBe(m.subject);
    expect(l.html).not.toBe(m.html);
    expect(l.text).not.toBe(m.text);
  });

  it("never names the other rung", () => {
    // "contains L" is satisfied by copy that names both. This is not.
    expect(revoked("event_pass").html).not.toContain("Event Pass L");
    expect(revoked("event_pass").text).not.toContain("Event Pass L");
  });

  it("leaves no un-substituted placeholder", () => {
    for (const key of PASS_KEYS) {
      const out = revoked(key);
      expect(out.subject).not.toMatch(/\{\w+\}/);
      expect(out.text).not.toMatch(/\{\w+\}/);
    }
  });
});
