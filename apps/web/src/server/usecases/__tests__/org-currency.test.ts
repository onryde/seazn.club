// RS001b — org preferred currency, the allowlist CHECK, and the same-currency
// lock. Real Postgres required; skipped without DATABASE_URL.
//
// Owner ruling 2026-08-16 (design §2): a connected org's CHARGE currency always
// equals its account's SETTLEMENT currency, so a registration destination
// charge never carries an FX leg. The lock is enforced on every Connect sync,
// not just the first — an org that changes its Stripe bank later converges on
// the next sync. Free choice from the allowlist is for UNCONNECTED
// (offline/display) orgs only.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { REGISTRATION_CURRENCIES } from "@/lib/currency";
import { syncConnectAccount } from "../stripe-connect";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(currency?: string, accountId?: string | null): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`cur-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Currency Org " + suffix}, ${"cur-org-" + suffix}, ${ownerId}) returning id`;
  if (currency) await sql`update organizations set currency = ${currency} where id = ${orgId}`;
  if (accountId !== undefined) {
    await sql`update organizations set stripe_account_id = ${accountId} where id = ${orgId}`;
  }
  return orgId;
}

interface OrgCurrencyCols {
  currency: string;
  stripe_unsupported_currency: string | null;
}

async function orgCurrency(orgId: string): Promise<OrgCurrencyCols> {
  const [row] = await sql<OrgCurrencyCols[]>`
    select currency, stripe_unsupported_currency from organizations where id = ${orgId}`;
  return row;
}

/** The minimum of a Stripe account the sync reads. */
function account(id: string, defaultCurrency: string | null): Stripe.Account {
  return {
    id,
    charges_enabled: true,
    payouts_enabled: true,
    default_currency: defaultCurrency ?? undefined,
    requirements: { disabled_reason: null, currently_due: [] },
  } as unknown as Stripe.Account;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("organizations.currency (RS001b schema)", () => {
  it("the DB CHECK admits exactly REGISTRATION_CURRENCIES — the drift net", async () => {
    // The one gate that catches a list edit shipped without a migration (or a
    // migration shipped without the list edit). Both halves are silent
    // otherwise: `tsc` cannot see a SQL CHECK, and the DB cannot see the TS
    // constant. Parse the codes back out of the constraint definition rather
    // than restating them here — restating them makes this a tautology.
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'organizations_currency_check'`;
    expect(row, "organizations_currency_check is missing").toBeTruthy();
    const codes = [...row.def.matchAll(/'([a-z]{3})'/g)].map((m) => m[1]).sort();
    expect(codes).toEqual([...REGISTRATION_CURRENCIES].sort());
  });

  it("defaults to gbp and refuses a code outside the allowlist", async () => {
    const orgId = await seedOrg();
    expect((await orgCurrency(orgId)).currency).toBe("gbp");
    await expect(
      sql`update organizations set currency = 'jpy' where id = ${orgId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("registration_settings no longer carries a currency — it is org-level now", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'registration_settings' and column_name = 'currency'`;
    expect(cols).toHaveLength(0);
  });

  it("a cart must snapshot its currency explicitly — registration_groups.currency is NOT NULL", async () => {
    // No default on purpose: RS002's group insert has to name the org currency
    // it quoted, so a later org-currency change cannot rewrite what a submitted
    // cart was charged.
    const [col] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'registration_groups' and column_name = 'currency'`;
    expect(col.is_nullable).toBe("NO");
    expect(col.column_default).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("same-currency lock on Connect sync (owner ruling 2026-08-16)", () => {
  it("overwrites a manually-set org currency with the account's settlement currency", async () => {
    const acct = "acct_lock_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("gbp", acct);
    await syncConnectAccount(account(acct, "eur"));
    expect(await orgCurrency(orgId)).toMatchObject({
      currency: "eur",
      stripe_unsupported_currency: null,
    });
  });

  it("converges on EVERY sync, not just the first — a changed settlement currency follows", async () => {
    const acct = "acct_again_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("gbp", acct);
    await syncConnectAccount(account(acct, "eur"));
    await syncConnectAccount(account(acct, "aud"));
    expect((await orgCurrency(orgId)).currency).toBe("aud");
  });

  it("an unsupported settlement currency sets the card-unsupported state and leaves currency alone", async () => {
    // The failure has to surface at CONNECT time. Writing 'sgd' into
    // organizations.currency would violate the CHECK and abort the sync tx;
    // charging in gbp off an SGD-settled account would reintroduce the FX leg
    // the ruling exists to forbid. So: record the offending code, leave the
    // org's own currency untouched, and let RS004 render the message.
    const acct = "acct_unsup_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("gbp", acct);
    await syncConnectAccount(account(acct, "sgd"));
    expect(await orgCurrency(orgId)).toMatchObject({
      currency: "gbp",
      stripe_unsupported_currency: "sgd",
    });
  });

  it("clears the card-unsupported state once the account settles in an allowed currency", async () => {
    const acct = "acct_fixed_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("gbp", acct);
    await syncConnectAccount(account(acct, "sgd"));
    await syncConnectAccount(account(acct, "usd"));
    expect(await orgCurrency(orgId)).toMatchObject({
      currency: "usd",
      stripe_unsupported_currency: null,
    });
  });

  it("leaves an unconnected org's chosen currency alone", async () => {
    // Free allowlist choice is exactly the unconnected (offline/display) case.
    const orgId = await seedOrg("inr", null);
    await syncConnectAccount(account("acct_someone_else", "usd"));
    expect((await orgCurrency(orgId)).currency).toBe("inr");
  });

  it("an account with no settlement currency yet leaves the org currency untouched", async () => {
    // Express accounts exist before onboarding completes; `default_currency`
    // is absent until Stripe knows the country/bank. Nothing to lock to.
    const acct = "acct_early_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("eur", acct);
    await syncConnectAccount(account(acct, null));
    expect(await orgCurrency(orgId)).toMatchObject({
      currency: "eur",
      stripe_unsupported_currency: null,
    });
  });

  it("still mirrors the Connect health flags while locking the currency", async () => {
    // The lock is an addition to syncConnectAccount, not a replacement — the
    // charges/payouts/requirements mirror must survive it.
    const acct = "acct_flags_" + randomUUID().slice(0, 8);
    const orgId = await seedOrg("gbp", acct);
    await syncConnectAccount({
      id: acct,
      charges_enabled: false,
      payouts_enabled: false,
      default_currency: "usd",
      requirements: { disabled_reason: "requirements.past_due", currently_due: ["a", "b"] },
    } as unknown as Stripe.Account);
    const [row] = await sql<
      {
        stripe_charges_enabled: boolean;
        stripe_payouts_enabled: boolean;
        stripe_disabled_reason: string | null;
        stripe_requirements_due: number;
        currency: string;
      }[]
    >`
      select stripe_charges_enabled, stripe_payouts_enabled, stripe_disabled_reason,
             stripe_requirements_due, currency
      from organizations where id = ${orgId}`;
    expect(row).toMatchObject({
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
      stripe_disabled_reason: "requirements.past_due",
      stripe_requirements_due: 2,
      currency: "usd",
    });
  });
});
