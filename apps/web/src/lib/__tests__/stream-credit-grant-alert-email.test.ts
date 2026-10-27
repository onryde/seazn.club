// Body copy for the staff alert queued when a PAID match-credit checkout
// session granted nothing (`streamCreditGrantFailedAlertEmail`, rendered by
// `alertStreamCreditGrantFailed` in stream-credits-checkout.ts for both
// ungranted exits of the `stream_credits` branch, and queued on the email
// outbox as kind `staff_stream_credit_grant_failed`).
//
// Both exits ACK the webhook — Stripe stops redelivering — so this email is the
// only thing left that can reach a human. The webhook suite proves it is QUEUED
// (one row, its recipient and subject); this file proves what it SAYS, by
// calling the builder that renders it.
//
// Internal staff alert: NOT localised (it takes no locale/Dict and is composed
// inline in lib/email.ts), so English is the only copy to assert.
import { describe, expect, it } from "vitest";
import { streamCreditGrantFailedAlertEmail } from "../email";

const base = {
  sessionId: "cs_test_ungranted_1",
  orgId: "0f7c6c2e-1111-4000-8000-000000000001",
  packRaw: "5",
  reason: "no credits snapshot and no resolvable pack",
};

describe("match-credit grant failure alert", () => {
  it("carries the three ids a human needs and says the buyer was charged", () => {
    const mail = streamCreditGrantFailedAlertEmail(base);
    const body = `${mail.subject}\n${mail.html}\n${mail.text}`;

    expect(body).toContain(base.sessionId);
    expect(body).toContain(base.orgId);
    expect(body).toContain(base.reason);
    // The sentence that decides whether the ticket is triaged or filed: money
    // has already moved, and nothing retries.
    expect(body).toMatch(/charged but holds no match credits/i);
    // …and where to fix it, naming the panel and the action as the admin page
    // actually labels them (admin-stream-credits-panel.tsx:64, :199).
    expect(body).toContain(`/admin/orgs/${base.orgId}`);
    expect(body).toContain("Match credits (streaming)");
    expect(body).toContain("Grant — add credits");
  });

  it("names MATCH credits, never the AI credit wallet", () => {
    // The two currencies have separate ledgers and separate admin panels. An
    // alert that said "credits" would send whoever triages it to the wrong
    // balance — and the donor alert for the OTHER currency
    // (creditPackGrantFailedAlertEmail) exists and is worded for it, which
    // is why this is a distinct builder rather than a shared one.
    const mail = streamCreditGrantFailedAlertEmail(base);
    const body = `${mail.subject}\n${mail.html}\n${mail.text}`;
    expect(mail.subject).toBe(`Match credits could not be granted: ${base.sessionId}`);
    expect(body).not.toMatch(/AI credit/i);
    expect(body).not.toContain("credit_pack");
  });

  it("renders and prints no 'undefined' when the session carried no pack", () => {
    // `packRaw` is the RAW metadata value, and the limb that alerts is
    // precisely the one where it failed to resolve — so absent is its normal
    // state here, not an edge case.
    const noPack = { ...base, packRaw: undefined };
    const mail = streamCreditGrantFailedAlertEmail(noPack);
    const body = `${mail.subject}\n${mail.html}\n${mail.text}`;
    expect(body).not.toMatch(/\bundefined\b/);
    expect(body).toContain(base.sessionId);
    expect(body, "no pack, no pack line").not.toMatch(/pack 5|pack: 5/);
    // Positive pair: with a pack, the raw value IS printed — otherwise the
    // assertion above is satisfied by copy that never mentions the pack.
    expect(streamCreditGrantFailedAlertEmail(base).html).toMatch(/pack 5|pack: 5/);
  });

  it("leaves no unresolved template token", () => {
    const mail = streamCreditGrantFailedAlertEmail(base);
    expect(mail.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(mail.text.length).toBeGreaterThan(10);
    expect(mail.subject.length).toBeGreaterThan(5);
  });
});
