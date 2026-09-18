// Unit coverage for scripts/stripe-connect-fixture.ts.
//
// `requireTestStripe` reads STRIPE_SECRET_KEY and exits the process, and
// `tryMintOnboardingLink` is best-effort by construction — neither is worth
// pinning here. The two that are:
//
//   isHealthy — the exact gate that decides "reuse this account" vs "treat it
//     as stale and walk through onboarding again". A flipped operator there
//     either loops the script into creating a fresh account on every run or
//     declares a broken account healthy.
//   createFixtureAccount — takes its Stripe client as a PARAMETER, so a stub
//     proves the account shape it asks for without a key or a network call.
//     That shape is the whole point of the fixture: it has to be the account
//     production creates, or the local/CI destination-charge path is
//     exercising something users never get.
//
// Neither touches the network. The module is side-effect-free on import (the
// `import.meta.url === process.argv[1]` guard at the foot of the script).
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  createFixtureAccount,
  FIXTURE_ACCOUNT_COUNTRY,
  isHealthy,
} from "../stripe-connect-fixture.ts";

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

  // The status list is not typed out as a free-standing array: a Record keyed
  // by the SDK's own union makes the COMPILER demand a verdict for every
  // status Stripe declares, so adding one to `stripe` reds this table until
  // somebody decides what it means — instead of silently going untested.
  // The verdicts themselves are stated, never computed from isHealthy's own
  // expression, which would make the whole thing a tautology.
  const VERDICT: Record<Stripe.Account.Capabilities.Transfers, boolean> = {
    active: true,
    inactive: false,
    pending: false,
  };

  it("treats exactly one of Stripe's declared transfer statuses as healthy", () => {
    const verdicts = Object.entries(VERDICT).map(([status]) => [
      status,
      isHealthy(account(true, status)),
    ]);
    expect(Object.fromEntries(verdicts)).toEqual(VERDICT);
    // Guards the table itself: if someone "fixes" a red by flipping every
    // value to true (or false), this catches it. Exactly one status is ready.
    expect(Object.values(VERDICT).filter(Boolean)).toHaveLength(1);
  });

  it("answers correctly on the V1-INTEROP shape a v2 account really returns", () => {
    // Since the Accounts v2 migration the fixture account is created through
    // `stripe.v2.core.accounts.create` and read back through `/v1/accounts`.
    // connect-accounts-v2.live.test.ts settled against the live test API that
    // this view carries `capabilities.transfers` for a v2 account — this pins
    // that isHealthy still answers on the FULL payload, not just on the
    // two-field stand-in above: a sibling `card_payments` capability and the
    // other interop fields must not disturb the verdict either way.
    const interop = (transfers: string, charges: boolean): Stripe.Account =>
      ({
        id: "acct_v2_interop",
        object: "account",
        charges_enabled: charges,
        payouts_enabled: false,
        details_submitted: false,
        default_currency: undefined,
        requirements: { currently_due: ["individual.id_number"], disabled_reason: null },
        capabilities: { card_payments: "pending", transfers },
      }) as unknown as Stripe.Account;

    // A FRESH v2 account: transfers requested but not yet active, charges off.
    // The script must call this stale and send the operator to onboarding.
    expect(isHealthy(interop("pending", false))).toBe(false);
    // The same account once a human finishes Stripe's hosted onboarding.
    expect(isHealthy(interop("active", true))).toBe(true);
    // The asymmetric pair — each alone is not enough. Without these two a
    // predicate reading only ONE of the fields still passes everything above.
    expect(isHealthy(interop("active", false))).toBe(false);
    expect(isHealthy(interop("pending", true))).toBe(false);
  });
});

describe("createFixtureAccount", () => {
  /** A Stripe stub recording what the fixture asks for. `retrieve` answers a
   *  V1-interop account because that is what the script's own downstream
   *  (isHealthy, reportNotReady) is written against. */
  function stubStripe() {
    const v2Create = vi.fn(async () => ({ id: "acct_v2_new" }));
    const v1Create = vi.fn(async () => ({ id: "acct_v1_new" }));
    const retrieve = vi.fn(async (id: string) => ({
      id,
      charges_enabled: false,
      capabilities: { transfers: "pending" },
    }));
    return {
      v2Create,
      v1Create,
      retrieve,
      stripe: {
        accounts: { create: v1Create, retrieve },
        v2: { core: { accounts: { create: v2Create } } },
      } as unknown as Stripe,
    };
  }

  /** Typed off the SDK's own declaration — the same trick
   *  stripe-connect.test.ts uses — so a field rename in `stripe` moves this
   *  file rather than leaving it asserting a stale name. */
  const paramsOf = (fn: ReturnType<typeof stubStripe>["v2Create"]) =>
    fn.mock.calls[0][0] as unknown as Stripe.V2.Core.AccountCreateParams;

  it("creates through Accounts v2, never the v1 accounts API", async () => {
    const s = stubStripe();
    await createFixtureAccount(s.stripe);
    expect(s.v2Create).toHaveBeenCalledTimes(1);
    // The regression guard: this script was the LAST v1 accounts.create in the
    // tree, so a revert would light exactly this and nothing else would care.
    expect(s.v1Create).not.toHaveBeenCalled();
  });

  it("asks for the account production asks for", async () => {
    const s = stubStripe();
    await createFixtureAccount(s.stripe);
    const p = paramsOf(s.v2Create);
    // Express dashboard — the fixture stands in for an Express account and
    // the manual onboarding step below depends on Stripe's hosted UI.
    expect(p.dashboard).toBe("express");
    // Required by the v2 API whenever configuration.recipient is supplied.
    expect(p.contact_email).toMatch(/@/);
    // Production sends display_name (from organizations.name) for every org
    // whose name is non-blank — essentially always. The fixture sends one too,
    // so the account Stripe creates here has the same SHAPE as a real one, and
    // so the row is identifiable in the test Dashboard rather than nameless.
    // Pinned NON-EMPTY, not merely present: `display_name: ""` is a 400 from
    // the v2 API, which is exactly the trap production's own guard avoids.
    expect(String(p.display_name ?? "").trim()).not.toBe("");
    // Required before configuration.merchant may be set.
    expect(p.identity?.country).toBe(FIXTURE_ACCOUNT_COUNTRY);
    // BOTH capability halves — parity with the v1 card_payments + transfers
    // this replaced. Recipient-only can take transfers but may never light
    // charges_enabled, which is the field isHealthy gates on.
    expect(p.configuration?.merchant?.capabilities?.card_payments?.requested).toBe(true);
    expect(
      p.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.requested,
    ).toBe(true);
    // Non-optional in the v2 type, and the platform's actual position.
    expect(p.defaults?.responsibilities?.fees_collector).toBe("application");
    expect(p.defaults?.responsibilities?.losses_collector).toBe("application");
  });

  it("keeps the fixture metadata and carries NO org_id", async () => {
    const s = stubStripe();
    await createFixtureAccount(s.stripe);
    const meta = paramsOf(s.v2Create).metadata ?? {};
    expect(meta.fixture).toBe("scripts/stripe-connect-fixture.ts");
    expect(Date.parse(String(meta.created_at))).not.toBeNaN();
    // Production stamps org_id here. This account belongs to no org, and a
    // stray one would make it look like a real club's connected account.
    expect(meta).not.toHaveProperty("org_id");
  });

  it("returns the V1-interop account, which is what isHealthy reads", async () => {
    // v2's create response is a V2 Account — it carries none of
    // charges_enabled / capabilities, so handing it straight to isHealthy or
    // reportNotReady would report a fresh account as permanently unready.
    const s = stubStripe();
    const account = await createFixtureAccount(s.stripe);
    expect(s.retrieve).toHaveBeenCalledWith("acct_v2_new");
    expect(account.id).toBe("acct_v2_new");
    expect(account.capabilities?.transfers).toBe("pending");
    expect(isHealthy(account)).toBe(false);
  });
});
