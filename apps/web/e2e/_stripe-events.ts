// Signed synthetic Stripe events for e2e specs (moved out of payments-hardening.spec.ts for sponsor deals Task 8, so more than
// one spec drives the REAL webhook route the same way).
//
// The e2e server verifies against STRIPE_WEBHOOK_SECRET (`whsec_e2e_payments` in every e2e.yml job), so
// generateTestHeaderString round-trips through constructEvent. The Stripe client is built only to sign: it makes no network
// call, so a dummy key is enough when none is set.
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { TAG } from "./helpers";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_e2e_payments";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_e2e_dummy");

/** Run-unique id with a Stripe-style prefix (pi_/ch_/dp_/evt_/cus_/…). */
export const stripeUid = (prefix: string): string => `${prefix}_${TAG}_${randomBytes(5).toString("hex")}`;

/** A minimal-but-well-formed Stripe.Event around one object. */
export function stripeEvent(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stripeUid("evt"),
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

/** POST a SIGNED event to the real webhook route; returns the raw response. */
export async function postSignedEvent(request: APIRequestContext, event: Record<string, unknown>): Promise<APIResponse> {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request.post("/api/webhooks/stripe", {
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    data: payload,
  });
}
