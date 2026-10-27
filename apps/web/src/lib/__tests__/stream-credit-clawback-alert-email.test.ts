// Body copy for the staff alert queued when a match-credit pack charge is
// refunded and the webhook could not reverse it cleanly
// (`streamCreditClawbackAlertEmail`, rendered by `alertStreamClawback` in
// billing-events.ts for four claw-back exits: partial, short refund and
// ungranted in `handleStreamPackChargeRefunded`, plus the short lost-dispute
// one in `handlePlatformDispute`, and queued on the email outbox as kind
// `staff_stream_credit_clawback`).
//
// The webhook suite proves it is QUEUED (one row per incident, its recipient
// and subject); this file proves what it SAYS, by calling the builder that
// renders it.
//
// Internal staff alert: NOT localised (it takes no locale/Dict and is composed
// inline in lib/email.ts), so English is the only copy to assert.
import { describe, expect, it } from "vitest";
import { streamCreditClawbackAlertEmail } from "../email";

const base = {
  chargeId: "ch_test_clawback_1",
  orgId: "0f7c6c2e-1111-4000-8000-000000000001",
  purchased: 5,
  clawedBack: 2,
  reason: "full refund clawed back fewer credits than the pack granted — the rest were already spent on live streams",
};

const body = (mail: { subject: string; html: string; text: string }): string => `${mail.subject}\n${mail.html}\n${mail.text}`;

describe("match-credit claw-back alert", () => {
  it("carries the charge, the org and both numbers a human needs to judge it", () => {
    const mail = streamCreditClawbackAlertEmail(base);
    expect(body(mail)).toContain(base.chargeId);
    expect(body(mail)).toContain(base.orgId);
    expect(body(mail)).toContain(base.reason);
    // The two numbers ARE the judgement: 2 of 5 revoked means three streams
    // went out and were then refunded. An alert that named neither would be a
    // notification with nothing to act on.
    expect(body(mail)).toMatch(/granted 5 match credits/i);
    expect(body(mail)).toMatch(/2 were revoked/i);
  });

  it("does NOT tell the reader to grant credits — this is the opposite direction", () => {
    // The grant-failure builder (streamCreditGrantFailedAlertEmail) exists
    // and says "inspect and grant manually". Reusing it here would send whoever
    // triages a claw-back to add credits to an account that just took its money
    // back, which is why this is a separate builder.
    const mail = streamCreditClawbackAlertEmail(base);
    expect(mail.subject).toBe(`Match credits claw-back needs review: ${base.chargeId}`);
    expect(mail.subject).not.toMatch(/could not be granted/i);
    expect(body(mail)).not.toMatch(/grant manually/i);
    expect(body(mail)).not.toMatch(/Grant — add credits/);
    // …and it names MATCH credits, never the AI credit wallet: two currencies,
    // two ledgers, two admin panels.
    expect(mail.subject).toMatch(/match credits/i);
    expect(body(mail)).not.toMatch(/AI credit/i);
  });

  it("says why the difference cannot simply be reversed", () => {
    const mail = streamCreditClawbackAlertEmail(base);
    // The reason the owner ruling caps the claw-back at the balance: the
    // streams already went out and Cloudflare already billed us. Without this
    // sentence the reader's obvious move is to "correct" the ledger by hand.
    expect(body(mail)).toMatch(/already spent cannot be reversed/i);
    expect(body(mail)).toMatch(/Cloudflare/);
  });

  it("prints no 'undefined' when no purchase row matched, and says so", () => {
    // The ungranted branch has neither number — absent is its normal state.
    const mail = streamCreditClawbackAlertEmail({
      chargeId: base.chargeId,
      orgId: base.orgId,
      reason: "refunded match-credit charge has no purchase ledger row to claw back",
    });
    expect(body(mail)).not.toMatch(/\bundefined\b/);
    expect(body(mail)).toMatch(/No match-credit purchase row matched/i);
    expect(body(mail)).toContain(base.chargeId);
    // Positive pair: with the numbers present, the movement line IS printed —
    // otherwise the assertion above is satisfied by copy that never names them.
    const withNumbers = streamCreditClawbackAlertEmail(base);
    expect(body(withNumbers)).not.toMatch(/No match-credit purchase row matched/i);
    expect(body(withNumbers)).toMatch(/granted 5 match credits/i);
  });

  it("reads correctly when a fully-spent pack clawed back nothing at all", () => {
    // Zero is the case that most needs a human, and V410's `delta <> 0` means
    // no ledger row was written — this email is the whole trail.
    const mail = streamCreditClawbackAlertEmail({ ...base, clawedBack: 0 });
    expect(body(mail)).toMatch(/0 were revoked/i);
    expect(body(mail)).not.toMatch(/\bundefined\b/);
  });

  it("leaves no unresolved template token", () => {
    const mail = streamCreditClawbackAlertEmail(base);
    expect(mail.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(mail.text.length).toBeGreaterThan(10);
    expect(mail.subject.length).toBeGreaterThan(5);
  });
});
