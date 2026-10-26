// Sponsor-money fixtures (phase 3 wave 2, Batch B), shared by the sponsor outbox tests, the kind sweep and the older sponsor suites.
// Real Postgres rows only; nothing here calls a usecase. Every address a fixture makes starts with `prefix`, so a caller whose cleanup
// finds its rows by address (the kind sweep's RUN prefix) can hand its own in.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

/**
 * A Pro organisation that may sell sponsorship (`sponsors.monetize`), Connect-live (an account that can take charges, so the checkout's
 * Connect gate lets it through), with one owner (an account at `<prefix>-owner-…@test.local`, seated in `org_members`) and one active,
 * org-wide package. Generalised from sponsor-checkout.test.ts's `seedOrg`. The org and package names carry no `&`, `<` or `>`, so a
 * test may look for them in an escaped body as they are.
 */
export async function seedSponsorOrg(opts: { defaultLocale?: Locale; prefix?: string } = {}): Promise<{
  orgId: string;
  ownerId: string;
  packageId: string;
  auth: AuthCtx;
  orgName: string;
  packageName: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const prefix = opts.prefix ?? "money";
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${prefix}-owner-${suffix}@test.local`}, 'Sponsor Org Owner', true) returning id`;
  const orgName = `Money Org ${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled, default_locale)
    values (${orgName}, ${`money-${suffix}`}, ${ownerId}, ${`acct_${suffix}`}, true, ${opts.defaultLocale ?? "en"})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const packageName = `Gold package ${suffix}`;
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${null}, ${packageName}, 25000, 'gbp', 'gold') returning id`;
  return {
    orgId,
    ownerId,
    packageId,
    auth: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null },
    orgName,
    packageName,
  };
}

/** Everything the fixtures above made for these organisations: their outbox rows, their sponsor orders (a RESTRICT foreign key keeps
 *  an organisation with orders, V299), the organisations (packages, placements and memberships cascade), then the owners' billing
 *  groups and accounts. */
export async function cleanUpSponsorOrgs(orgIds: readonly string[], userIds: readonly string[]): Promise<void> {
  if (orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${orgIds as string[]}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${orgIds as string[]}::uuid[])`;
    await sql`delete from organizations where id = any(${orgIds as string[]}::uuid[])`;
  }
  if (userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${userIds as string[]}::uuid[])`;
    await sql`delete from users where id = any(${userIds as string[]}::uuid[])`;
  }
}
