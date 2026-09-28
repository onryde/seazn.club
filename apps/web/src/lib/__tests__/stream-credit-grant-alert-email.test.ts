// Body copy for the staff alert sent when a PAID match-credit checkout session
// granted nothing (`sendStreamCreditGrantFailedAlertEmail`, wired into both
// ungranted exits of billing-events.ts's `stream_credits` branch).
//
// Both exits ACK the webhook — Stripe stops redelivering — so this email is the
// only thing left that can reach a human. The webhook suite proves it FIRES;
// nothing there proves it is readable, because it mocks this function. Asserted
// through the real send path with `fetch` stubbed, the same shape
// extra-org-reprice-alert-email.test.ts and pass-credit-reversal-alert-email
// .test.ts use, because the body is built inside the send function and there is
// no separate template export to call.
//
// Internal staff alert: NOT localised (it takes no locale/Dict and is composed
// inline in lib/email.ts), so English is the only copy to assert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendStreamCreditGrantFailedAlertEmail } from "../email";

interface SentPayload {
  subject: string;
  html: string;
  text: string;
}

let sent: SentPayload[] = [];
const OLD_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  sent = [];
  process.env.RESEND_API_KEY = "re_test_key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentPayload);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

const base = {
  to: "ops@seazn.test",
  sessionId: "cs_test_ungranted_1",
  orgId: "0f7c6c2e-1111-4000-8000-000000000001",
  packRaw: "5",
  reason: "no credits snapshot and no resolvable pack",
};

describe("match-credit grant failure alert", () => {
  it("carries the three ids a human needs and says the buyer was charged", async () => {
    await sendStreamCreditGrantFailedAlertEmail(base);
    expect(sent).toHaveLength(1);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;

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

  it("names MATCH credits, never the AI credit wallet", async () => {
    // The two currencies have separate ledgers and separate admin panels. An
    // alert that said "credits" would send whoever triages it to the wrong
    // balance — and the donor alert for the OTHER currency
    // (sendCreditPackGrantFailedAlertEmail) exists and is worded for it, which
    // is why this is a distinct builder rather than a shared one.
    await sendStreamCreditGrantFailedAlertEmail(base);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;
    expect(sent[0]!.subject).toMatch(/match credits/i);
    expect(body).not.toMatch(/AI credit/i);
    expect(body).not.toContain("credit_pack");
  });

  it("is sendable and prints no 'undefined' when the session carried no pack", async () => {
    // `packRaw` is the RAW metadata value, and the limb that alerts is
    // precisely the one where it failed to resolve — so absent is its normal
    // state here, not an edge case.
    const noPack = { ...base, packRaw: undefined };
    await sendStreamCreditGrantFailedAlertEmail(noPack);
    expect(sent).toHaveLength(1);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;
    expect(body).not.toMatch(/\bundefined\b/);
    expect(body).toContain(base.sessionId);
    // Positive pair: with a pack, the raw value IS printed — otherwise the
    // assertion above is satisfied by copy that never mentions the pack.
    sent = [];
    await sendStreamCreditGrantFailedAlertEmail(base);
    expect(`${sent[0]!.html}`).toMatch(/pack 5|pack: 5/);
  });

  it("leaves no unresolved template token", async () => {
    await sendStreamCreditGrantFailedAlertEmail(base);
    expect(sent[0]!.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(sent[0]!.text.length).toBeGreaterThan(10);
    expect(sent[0]!.subject.length).toBeGreaterThan(5);
  });
});
