import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { log } from "@/server/logger";
import { runEvent } from "@/server/usecases/billing-events";

// Signed Stripe webhook. The dispatch table lives in
// server/usecases/billing-events.ts, shared with the staff console's
// "process now" replay — this route only owns signature verification.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  // Stripe's event-destinations UI splits "Your account" and "Connected
  // accounts" into separate destinations, each minting its own signing
  // secret — v1 account.updated only delivers on the Connected-accounts
  // scope. Both destinations point at this one route, so this accepts a
  // comma-separated list and verifies against each until one matches.
  const secrets = (process.env.STRIPE_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!sig || secrets.length === 0) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event | undefined;
  for (const secret of secrets) {
    try {
      event = getStripe().webhooks.constructEvent(rawBody, sig, secret);
      break;
    } catch {
      // try the next configured secret
    }
  }
  if (!event) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    // runEvent claims the event atomically and processes it exactly once
    // (#229 P0-2); a duplicate or concurrent delivery is a no-op. It stamps
    // processed_at only after the handler ran, so a throw leaves the row
    // visible as "received" on /admin/billing-events for replay.
    await runEvent(event);
  } catch (err) {
    // Return 5xx so Stripe retries
    log.error({ err }, "stripe-webhook: processing failed");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
