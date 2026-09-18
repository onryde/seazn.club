// LIVE contract probe for ACCOUNTS V2 account creation — NOT a unit test.
//
// stripe-connect.test.ts pins every VALUE this codebase passes, against a
// stubbed SDK; connect-accounts-v2-wire.test.ts pins the HTTP REQUEST that
// actually goes out, against a local fixture server. Neither can answer the
// half that belongs to Stripe: does Stripe ACCEPT these parameters, and does
// the V1 INTEROP VIEW of the resulting account still carry the health fields
// `syncConnectAccount` and `connectStatus` read? (Which fields, and which of
// them are asserted rather than merely named, is set out at the interop test
// below — the count has been wrong here twice.)
//
// That interop view is the whole reason this migration touched one function
// instead of ten. `syncConnectAccount`, the billing-events dispatch, the
// webhook route and both destination-charge paths were left on v1 because
// `stripe.accounts.retrieve(<v2 id>)` returns a v1-shaped Account. If Stripe
// ever narrows that, nothing else in this repo notices — this file is the
// tripwire.
//
// ── What this does and does NOT prove ───────────────────────────────────────
// It creates an UN-ONBOARDED account, exactly as production's first connect
// does. It therefore proves the create is accepted, the configurations apply
// and the interop fields are present. It does NOT prove money moves: an
// un-onboarded account cannot take a destination charge (v1 and v2 both refuse
// it, for the same missing-`transfers` reason), so nothing here says anything
// about a successful transfer. Completing onboarding needs a human in Stripe's
// hosted form — see scripts/stripe-connect-fixture.ts.
//
// The account is CLOSED in afterAll. A failed close leaves a real, empty,
// un-onboarded test-mode account behind; that is why this is opt-in and not
// part of any normal run.
//
// Skipped unless BILLING_LIVE=1 — vitest.config.ts deletes STRIPE_SECRET_KEY
// from the loaded env otherwise, so CI (which ships no .env.local) can never
// run this. Run:
//
//   BILLING_LIVE=1 npx vitest run --testTimeout=30000 \
//     src/server/usecases/__tests__/connect-accounts-v2.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { CONNECT_ACCOUNT_DEFAULT_COUNTRY } from "../stripe-connect";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;

/**
 * TEST MODE ONLY, asserted rather than assumed.
 *
 * A live key here would create a REAL connected account on the platform, so
 * the gate is a refusal, not a skip. Both `sk_test_` and `rk_test_` are
 * accepted: the repo-root `.env.local` this suite reads its key from carries a
 * RESTRICTED test key (`rk_test_…`), and an `sk_test_`-only check would refuse
 * on the machine the file is meant to be run from. What matters is that a live
 * key can never reach `accounts.create` — the same `_test_` reasoning
 * scripts/stripe-connect-fixture.ts already uses as a hard gate.
 */
function requireTestKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error(
      "connect-accounts-v2.live.test.ts refuses to run: STRIPE_SECRET_KEY is not a TEST-mode key " +
        "(expected sk_test_… or rk_test_…). This suite creates a real connected account.",
    );
  }
  return key;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

describe.skipIf(!LIVE)("Accounts v2 create against live Stripe (test mode)", () => {
  // Constructed in beforeAll, never at describe-body scope: vitest evaluates
  // the describe factory during COLLECTION even when skipIf is true, so a
  // `new Stripe(process.env.STRIPE_SECRET_KEY!)` here throws on every run
  // WITHOUT the flag — a suite-collection failure, not a clean skip.
  let stripe: Stripe;
  let account: Stripe.V2.Core.Account;

  beforeAll(async () => {
    stripe = new Stripe(requireTestKey(), { apiVersion: "2026-06-24.dahlia" });
    // The SAME parameters createConnectOnboardingLink sends, so a divergence
    // between what production passes and what Stripe accepts shows up here.
    account = await stripe.v2.core.accounts.create({
      dashboard: "express",
      contact_email: "connect-live-probe@test.local",
      display_name: "LIVE PROBE delete me",
      identity: { country: CONNECT_ACCOUNT_DEFAULT_COUNTRY },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
        recipient: {
          capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
        },
      },
      defaults: {
        responsibilities: { fees_collector: "application", losses_collector: "application" },
      },
      metadata: { fixture: "connect-accounts-v2.live.test.ts" },
    });
    // Stripe: "All configurations on the Account must be passed in for this
    // request to succeed" — so the list comes off the account itself rather
    // than being typed out and drifting the next time one is added.
    cleanup.push(() =>
      stripe.v2.core.accounts.close(account.id, {
        applied_configurations: account.applied_configurations,
      }),
    );
  });

  it("Stripe accepts the create and applies BOTH configurations on an Express dashboard", () => {
    expect(account.id).toMatch(/^acct_/);
    expect(account.dashboard).toBe("express");
    // Recipient-only is the failure this asserts against: it can receive
    // transfers but may never light `charges_enabled`, which ~17 non-test
    // sites gate registration, sponsors and public data on.
    expect(account.applied_configurations).toContain("merchant");
    expect(account.applied_configurations).toContain("recipient");
  });

  it("the V1 INTEROP VIEW still carries every field syncConnectAccount mirrors", async () => {
    // This is the tripwire. FIVE fields are ASSERTED below, and they are not
    // all one function's: four are syncConnectAccount's (charges_enabled,
    // payouts_enabled, default_currency and requirements.currently_due);
    // `details_submitted` is connectStatus's (stripe-connect.ts:83) and
    // syncConnectAccount never touches it — it is what the
    // return-from-onboarding page shows before the webhook lands. If any of
    // them stops being present on the v1 view of a v2 account, every Connect
    // health flag in this app silently stops updating.
    //
    // A sixth, `requirements.disabled_reason`, is read by syncConnectAccount
    // but is deliberately NOT pinned by name: it is nullable, and whether
    // Stripe emits the key at all when it is null has never been established
    // against the live API — a key-presence assertion written on a guess
    // would red for the wrong reason on someone else's BILLING_LIVE run.
    // Presence of `requirements` stands in for it. Narrow this the day a live
    // run confirms the key is always emitted.
    const v1 = await stripe.accounts.retrieve(account.id);
    expect(v1.object).toBe("account");
    expect(typeof v1.charges_enabled).toBe("boolean");
    expect(typeof v1.payouts_enabled).toBe("boolean");
    expect(typeof v1.details_submitted).toBe("boolean");
    // `default_currency` is legitimately absent until Stripe knows the
    // account's country/bank — syncConnectAccount handles null on purpose — so
    // the contract is "the key is readable", not "it holds a value".
    expect(["string", "undefined"]).toContain(typeof v1.default_currency);
    expect(Array.isArray(v1.requirements?.currently_due)).toBe(true);
    // disabled_reason is nullable by design; presence of `requirements` is
    // what syncConnectAccount actually depends on.
    expect(v1.requirements).toBeDefined();
  });

  it("the v1 view exposes `capabilities`, which the fixture script depends on", async () => {
    // This assertion is what UNBLOCKED the fixture migration. While it was
    // open, scripts/stripe-connect-fixture.ts was the last v1
    // `accounts.create` in the repo, held there because its `isHealthy()`
    // reads `account.capabilities?.transfers` off this view and nobody had
    // confirmed that survives for a v2 account. It does, so the script now
    // creates through v2 and reads the account back through this same view.
    //
    // A RED here is therefore no longer "leave the script alone" — it is the
    // opposite. It means the SHIPPED fixture is broken: every local and CI
    // destination-charge fixture would report not-ready for ever, sending
    // operators back through onboarding that can never satisfy it. Fix the
    // script (or `isHealthy`) rather than recording the result.
    const v1 = await stripe.accounts.retrieve(account.id);
    expect(v1.capabilities).toBeDefined();
    expect(v1.capabilities?.transfers).toBeDefined();
  });

  it("mints an onboarding link through Account Links V1 against the v2 id", async () => {
    // The interop claim that let `createConnectOnboardingLink` keep its second
    // Stripe call on v1.
    const link = await stripe.accountLinks.create({
      account: account.id,
      type: "account_onboarding",
      refresh_url: "https://example.test/settings/connect?connect=refresh",
      return_url: "https://example.test/settings/connect?connect=return",
    });
    expect(link.url).toContain("connect.stripe.com");
  });
});
