// Money fixtures (phase 3 wave 2): sponsor orders (Batch B), Event Pass orgs and trialing billing groups (Batch D), shared by the outbox
// tests, the kind sweep and the older suites they came from. Real Postgres rows only; nothing here calls a usecase. Every address a fixture
// makes starts with `prefix`, so a caller whose cleanup finds its rows by address (the kind sweep's RUN prefix) can hand its own in.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { PassKey } from "@/lib/currency";
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

/**
 * A sponsor order in an organisation that sells sponsorship, with its owner (an account at `<prefix>-owner-…@test.local`, with the given
 * account language, seated in `org_members`: the dispute mail's recipient), a competition-scoped package (so a dispute recovery has a
 * competition to audit on), and a sponsor contact at `<prefix>-sponsor-…@test.local`. Generalised from sponsor-dispute.test.ts's
 * `seedPaidSponsorOrder`.
 *
 *  - `paid`: the order carries its payment intent and `paid_at`, and the active placement it bought (`sponsorId`).
 *  - `pending`: a checkout that has not been paid yet: no placement, no `paid_at`, and no intent on the order (the success webhook
 *    writes it). `intent` is still returned: it is the id the caller's payment event carries.
 *
 * The org and package names carry no `&`, `<` or `>`.
 */
export async function seedSponsorOrder(opts: {
  status: "pending" | "paid";
  intent?: string;
  defaultLocale?: Locale;
  ownerLocale?: string | null;
  prefix?: string;
}): Promise<{
  orderId: string;
  orgId: string;
  sponsorId: string | null;
  intent: string;
  sponsorEmail: string;
  ownerId: string;
  ownerEmail: string;
  orgName: string;
  packageName: string;
}> {
  const suffix = randomUUID().slice(0, 12);
  const prefix = opts.prefix ?? "sp";
  const intent = opts.intent ?? `pi_sp_${suffix}`;
  const ownerEmail = `${prefix}-owner-${suffix}@test.local`;
  const sponsorEmail = `${prefix}-sponsor-${suffix}@test.local`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${ownerEmail}, 'Owner', true, ${opts.ownerLocale ?? null}) returning id`;
  const orgName = `Sponsor Org ${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled, default_locale)
    values (${orgName}, ${`sp-org-${suffix}`}, ${ownerId}, ${`acct_${suffix}`}, true, ${opts.defaultLocale ?? "en"}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${`Sponsor Cup ${suffix}`}, ${`sp-cup-${suffix}`}) returning id`;
  const packageName = "Gold package";
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${compId}, ${packageName}, 25000, 'gbp', 'gold') returning id`;
  const paid = opts.status === "paid";
  const sponsorId = paid
    ? (
        await sql<{ id: string }[]>`
          insert into sponsors (org_id, competition_id, name, tier, status)
          values (${orgId}, ${compId}, 'Acme Corp', 'gold', 'active') returning id`
      )[0]!.id
    : null;
  const [{ id: orderId }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email,
                                amount_cents, currency, status, sponsor_id,
                                payment_intent_id, paid_at)
    values (${orgId}, ${packageId}, 'Acme Corp', ${sponsorEmail},
            25000, 'gbp', ${opts.status}, ${sponsorId}, ${paid ? intent : null}, ${paid ? new Date() : null})
    returning id`;
  return { orderId, orgId, sponsorId, intent, sponsorEmail, ownerId, ownerEmail, orgName, packageName };
}

/**
 * An organisation with one competition, for the Event Pass refund path. Moved from billing-pass-revoke.test.ts. The org's owner (an
 * account at `<prefix>-owner-…@test.local`, with the given account language, seated in `org_members` as `owner`) is a DIFFERENT account
 * from `organizations.created_by` (`<prefix>-trap-…`, `trapId`): a notice to the owner must find them by membership, and `created_by` is
 * the trap. With `intent`, the competition holds an Event Pass bought with that payment intent, of the given rung (default the M rung).
 * The org and competition names carry no `&`, `<` or `>`.
 */
export async function seedPassOrg(
  opts: { intent?: string; passKey?: PassKey; ownerLocale?: string | null; defaultLocale?: Locale; prefix?: string } = {},
): Promise<{ orgId: string; compId: string; orgName: string; compName: string; ownerId: string; ownerEmail: string; trapId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const prefix = opts.prefix ?? "pass";
  const ownerEmail = `${prefix}-owner-${suffix}@test.local`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${ownerEmail}, 'Owner', true, ${opts.ownerLocale ?? null}) returning id`;
  const [{ id: trapId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${prefix}-trap-${suffix}@test.local`}, 'Trap Creator', true) returning id`;
  const orgName = `Pass Org ${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale)
    values (${orgName}, ${`pass-org-${suffix}`}, ${trapId}, ${opts.defaultLocale ?? "en"}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const compName = `Pass Cup ${suffix}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${compName}, ${`pass-cup-${suffix}`}) returning id`;
  if (opts.intent !== undefined) {
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent, pass_key)
              values (${compId}, ${orgId}, ${opts.intent}, ${opts.passKey ?? "event_pass"})`;
  }
  return { orgId, compId, orgName, compName, ownerId, ownerEmail, trapId };
}

/**
 * A billing group in its trial: the payer (`subscriptions.owner_user_id`, an account at `<prefix>-payer-…@test.local` with the given
 * account language) and one org they created in the group (`orgDefaultLocale`, default en), whose slug the warning links to. The group
 * carries a Stripe subscription id (`stripeSubId`), which is how a `trial_will_end` event finds it, and the `has_payment_method` mirror.
 * Moved from billing-events-payout-health.test.ts's `trialingGroup`.
 */
export async function seedTrialingGroup(opts: {
  hasPaymentMethod: boolean;
  planKey?: string;
  ownerLocale?: string | null;
  orgDefaultLocale?: Locale;
  prefix?: string;
}): Promise<{ groupId: string; stripeSubId: string; ownerId: string; ownerEmail: string; slug: string; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const prefix = opts.prefix ?? "trial";
  const ownerEmail = `${prefix}-payer-${suffix}@test.local`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, locale)
    values (${ownerEmail}, 'Owner', ${opts.ownerLocale ?? null}) returning id`;
  const stripeSubId = `sub_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, has_payment_method, stripe_subscription_id)
    values (${ownerId}, ${opts.planKey ?? "pro"}, 'trialing', ${opts.hasPaymentMethod}, ${stripeSubId})
    returning id`;
  const slug = `trial-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, default_locale)
    values (${`Trial ${suffix}`}, ${slug}, ${ownerId}, ${groupId}, ${opts.orgDefaultLocale ?? "en"})
    returning id`;
  return { groupId, stripeSubId, ownerId, ownerEmail, slug, orgId };
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
