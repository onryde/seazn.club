// Body copy for the staff alert sent when a match-credit pack charge is
// refunded and the webhook could not reverse it cleanly
// (`sendStreamCreditClawbackAlertEmail`, wired into the four claw-back exits of
// billing-events.ts's `handleStreamPackChargeRefunded`).
//
// The webhook suite proves it FIRES; nothing there proves it is READABLE,
// because it mocks this function. Asserted through the real send path with
// `fetch` stubbed — the shape stream-credit-grant-alert-email.test.ts uses,
// because the body is built inside the send function and there is no separate
// template export to call.
//
// Internal staff alert: NOT localised (it takes no locale/Dict and is composed
// inline in lib/email.ts), so English is the only copy to assert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendStreamCreditClawbackAlertEmail } from "../email";

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
  chargeId: "ch_test_clawback_1",
  orgId: "0f7c6c2e-1111-4000-8000-000000000001",
  purchased: 5,
  clawedBack: 2,
  reason: "full refund clawed back fewer credits than the pack granted — the rest were already spent on live streams",
};

const body = (): string => `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;

describe("match-credit claw-back alert", () => {
  it("carries the charge, the org and both numbers a human needs to judge it", async () => {
    await sendStreamCreditClawbackAlertEmail(base);
    expect(sent).toHaveLength(1);
    expect(body()).toContain(base.chargeId);
    expect(body()).toContain(base.orgId);
    expect(body()).toContain(base.reason);
    // The two numbers ARE the judgement: 2 of 5 revoked means three streams
    // went out and were then refunded. An alert that named neither would be a
    // notification with nothing to act on.
    expect(body()).toMatch(/granted 5 match credits/i);
    expect(body()).toMatch(/2 were revoked/i);
  });

  it("does NOT tell the reader to grant credits — this is the opposite direction", async () => {
    // The grant-failure builder (sendStreamCreditGrantFailedAlertEmail) exists
    // and says "inspect and grant manually". Reusing it here would send whoever
    // triages a claw-back to add credits to an account that just took its money
    // back, which is why this is a separate builder.
    await sendStreamCreditClawbackAlertEmail(base);
    expect(sent[0]!.subject).toMatch(/claw-back/i);
    expect(sent[0]!.subject).not.toMatch(/could not be granted/i);
    expect(body()).not.toMatch(/grant manually/i);
    expect(body()).not.toMatch(/Grant — add credits/);
    // …and it names MATCH credits, never the AI credit wallet: two currencies,
    // two ledgers, two admin panels.
    expect(sent[0]!.subject).toMatch(/match credits/i);
    expect(body()).not.toMatch(/AI credit/i);
  });

  it("says why the difference cannot simply be reversed", async () => {
    await sendStreamCreditClawbackAlertEmail(base);
    // The reason the owner ruling caps the claw-back at the balance: the
    // streams already went out and Cloudflare already billed us. Without this
    // sentence the reader's obvious move is to "correct" the ledger by hand.
    expect(body()).toMatch(/already spent cannot be reversed/i);
    expect(body()).toMatch(/Cloudflare/);
  });

  it("prints no 'undefined' when no purchase row matched, and says so", async () => {
    // The ungranted branch has neither number — absent is its normal state.
    await sendStreamCreditClawbackAlertEmail({
      to: base.to,
      chargeId: base.chargeId,
      orgId: base.orgId,
      reason: "refunded match-credit charge has no purchase ledger row to claw back",
    });
    expect(sent).toHaveLength(1);
    expect(body()).not.toMatch(/\bundefined\b/);
    expect(body()).toMatch(/No match-credit purchase row matched/i);
    expect(body()).toContain(base.chargeId);
    // Positive pair: with the numbers present, the movement line IS printed —
    // otherwise the assertion above is satisfied by copy that never names them.
    sent = [];
    await sendStreamCreditClawbackAlertEmail(base);
    expect(body()).not.toMatch(/No match-credit purchase row matched/i);
    expect(body()).toMatch(/granted 5 match credits/i);
  });

  it("reads correctly when a fully-spent pack clawed back nothing at all", async () => {
    // Zero is the case that most needs a human, and V410's `delta <> 0` means
    // no ledger row was written — this email is the whole trail.
    await sendStreamCreditClawbackAlertEmail({ ...base, clawedBack: 0 });
    expect(body()).toMatch(/0 were revoked/i);
    expect(body()).not.toMatch(/\bundefined\b/);
  });

  it("leaves no unresolved template token", async () => {
    await sendStreamCreditClawbackAlertEmail(base);
    expect(sent[0]!.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(sent[0]!.text.length).toBeGreaterThan(10);
    expect(sent[0]!.subject.length).toBeGreaterThan(5);
  });
});
