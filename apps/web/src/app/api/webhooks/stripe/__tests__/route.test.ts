// Stripe's new event-destinations UI splits "Your account" and "Connected
// accounts" into two destinations, each with its own signing secret — see
// go-live runbook. STRIPE_WEBHOOK_SECRET must accept both, comma-separated,
// or the Connect destination's account.updated events 400 forever.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

vi.mock("@/server/usecases/billing-events", () => ({
  runEvent: vi.fn(async () => true),
}));

const SECRET_ACCOUNT = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_CONNECT = "whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function sign(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

function request(payload: string, sig: string): Request {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": sig },
    body: payload,
  });
}

describe("stripe webhook route — multiple signing secrets", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = `${SECRET_ACCOUNT},${SECRET_CONNECT}`;
  });

  it("accepts an event signed with the 'Your account' destination secret", async () => {
    const { POST } = await import("../route");
    const payload = JSON.stringify({
      id: "evt_account_1",
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const res = await POST(request(payload, sign(payload, SECRET_ACCOUNT)));
    expect(res.status).toBe(200);
  });

  it("accepts an event signed with the 'Connected accounts' destination secret", async () => {
    const { POST } = await import("../route");
    const payload = JSON.stringify({
      id: "evt_connect_1",
      type: "account.updated",
      data: { object: {} },
    });
    const res = await POST(request(payload, sign(payload, SECRET_CONNECT)));
    expect(res.status).toBe(200);
  });

  it("rejects a signature that matches neither configured secret", async () => {
    const { POST } = await import("../route");
    const payload = JSON.stringify({
      id: "evt_bad_1",
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const res = await POST(
      request(payload, sign(payload, "whsec_wrongwrongwrongwrongwrongwrong")),
    );
    expect(res.status).toBe(400);
  });
});
