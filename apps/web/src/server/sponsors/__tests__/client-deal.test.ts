// Sponsor deals (plan 2026-11-07-sponsor-deals F11/D14): `clientDeal` is the ONE strip between a ServerDeal and what the console
// and the API carry. No database: the function is pure, so this runs where the DB-backed deal-apply.test.ts is skipped.
//
// The five handles are F11's list, typed here from the spec rather than read off the function: the pay link (and its session,
// expiry and Stripe intent) is answered once by the call that minted it, and the invoice counter is server bookkeeping.
import { describe, expect, it } from "vitest";
import { clientDeal, type ServerDeal } from "../deal-apply";

const MONEY_HANDLES = ["payment_intent_id", "checkout_session_id", "checkout_url", "checkout_expires_at", "invoice_send_count"] as const;

/** A deal row holding every handle with a non-null value, so an omission is visible and a null does not hide one. */
function serverDeal(over: Record<string, unknown> = {}): ServerDeal {
  return {
    id: "deal_1",
    sponsor_id: "sponsor_1",
    deal_status: "live",
    payment_status: "paid",
    amount_cents: 5000,
    ended_at: null,
    has_payment_intent: true,
    payment_intent_id: "pi_123",
    checkout_session_id: "cs_123",
    checkout_url: "https://checkout.stripe.test/cs_123",
    checkout_expires_at: "2026-11-11T00:00:00.000Z",
    invoice_send_count: 2,
    ...over,
  } as unknown as ServerDeal;
}

describe("clientDeal — the strip between a ServerDeal and the wire (F11)", () => {
  it("removes every money handle and keeps every other field as it was", () => {
    const d = serverDeal();
    const out = clientDeal(d) as unknown as Record<string, unknown>;
    for (const h of MONEY_HANDLES) expect(Object.hasOwn(out, h), `${h} is absent, not set to undefined`).toBe(false);
    const kept = Object.keys(d).filter((k) => !(MONEY_HANDLES as readonly string[]).includes(k));
    expect(kept.length, "fields kept").toBeGreaterThan(0);
    expect(Object.keys(out)).toEqual(kept);
    for (const k of kept) expect(out[k], k).toEqual((d as unknown as Record<string, unknown>)[k]);
  });

  it("the pair: a deal that holds no handle value (all null) is stripped the same way, and the input is never mutated", () => {
    const d = serverDeal({ payment_intent_id: null, checkout_session_id: null, checkout_url: null, checkout_expires_at: null, invoice_send_count: 0 });
    const before = structuredClone(d);
    const out = clientDeal(d) as unknown as Record<string, unknown>;
    for (const h of MONEY_HANDLES) expect(Object.hasOwn(out, h), h).toBe(false);
    expect(d, "the input still carries its handles").toEqual(before);
    expect(out.has_payment_intent, "the boolean the console reads survives").toBe(true);
  });
});
