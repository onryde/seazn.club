// Unit coverage for scripts/stripe-connect-fixture.ts's one pure predicate.
// Everything else in that file either makes a real Stripe API call
// (createFixtureAccount, tryMintOnboardingLink) or reads STRIPE_SECRET_KEY
// and exits the process (requireTestStripe) — neither is meaningfully
// testable without a live key and network access, and both are already
// exercised for real by the fixture's own idempotent re-run (see the RS006
// dispatch report: `npm run stripe:connect-fixture` run twice, second run a
// clean no-op). isHealthy is the one piece worth pinning here: it is the
// exact gate that decides "reuse this account" vs "treat it as stale and
// walk through onboarding again", and a flipped operator there would either
// loop the script into creating a fresh account on every run (== instead of
// a real check) or declare a broken account healthy.
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { isHealthy } from "../stripe-connect-fixture.ts";

/** A minimal stand-in for the two fields isHealthy reads — real
 *  Stripe.Account objects carry dozens of fields this predicate never
 *  touches, so this is deliberately not a full fixture. */
function account(charges_enabled: boolean, transfers?: string): Stripe.Account {
  return {
    charges_enabled,
    capabilities: transfers === undefined ? undefined : { transfers },
  } as unknown as Stripe.Account;
}

describe("isHealthy", () => {
  it("is healthy when charges are enabled and transfers are active", () => {
    expect(isHealthy(account(true, "active"))).toBe(true);
  });

  it("is NOT healthy when charges_enabled is false, even with transfers active", () => {
    expect(isHealthy(account(false, "active"))).toBe(false);
  });

  it("is NOT healthy when transfers is any status other than active", () => {
    expect(isHealthy(account(true, "inactive"))).toBe(false);
    expect(isHealthy(account(true, "pending"))).toBe(false);
  });

  it("is NOT healthy when capabilities is absent (transfers never requested)", () => {
    expect(isHealthy(account(true, undefined))).toBe(false);
  });
});
