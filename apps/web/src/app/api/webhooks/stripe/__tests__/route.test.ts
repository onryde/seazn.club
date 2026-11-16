// Stripe's new event-destinations UI splits "Your account" and "Connected
// accounts" into two destinations, each with its own signing secret — see
// go-live runbook. STRIPE_WEBHOOK_SECRET must accept both, comma-separated,
// or the Connect destination's account.updated events 400 forever.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Stripe from "stripe";
import { log } from "@/server/logger";
import { runEvent } from "@/server/usecases/billing-events";
// The REAL error class (not the mocked barrel): the route matches it by name, so the test pins the name the producer actually sets.
import { BillingGroupNotLinkedError } from "@/server/usecases/billing-events/lifecycle-mail";

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

describe("stripe webhook route — a processing failure (review round 2 m-d)", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET_ACCOUNT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(runEvent).mockReset().mockImplementation(async () => true);
  });

  const deliver = async () => {
    const { POST } = await import("../route");
    const payload = JSON.stringify({ id: "evt_fail_1", type: "invoice.payment_succeeded", data: { object: {} } });
    return POST(request(payload, sign(payload, SECRET_ACCOUNT)));
  };

  it("an invoice waiting for its group's link is an expected wait: a WARNING (no Sentry error), still a 500 so Stripe retries", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const err = new BillingGroupNotLinkedError("in_wait_1", "00000000-0000-4000-8000-000000000001", "sub_wait_1");
    vi.mocked(runEvent).mockRejectedValueOnce(err);
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ err });
  });

  it("any other failure is still an ERROR (positive pair), and a 500", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const err = new Error("boom");
    vi.mocked(runEvent).mockRejectedValueOnce(err);
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ err });
  });
});
