// Money fixtures (phase 3 wave 2): sponsor orders (Batch B), Event Pass orgs and trialing billing groups (Batch D), shared by the outbox
// tests, the kind sweep and the older suites they came from; and (wave 5) the staff-alert rows a site test reads back. Real Postgres
// rows only; nothing here calls a usecase. Every address a fixture makes starts with `prefix`, so a caller whose cleanup finds its rows
// by address (the kind sweep's RUN prefix) can hand its own in.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { PassKey } from "@/lib/currency";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { STAFF_ALERT_QUEUE_FAILED } from "../staff-alert";

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

// ---------------------------------------------------------------------------------------------------------------------------------
// Billing groups changing hands (phase 3 wave 4, T4): the transfer offer and the immediate handover, and an org leaving a group. Moved
// from the three billing-group notify suites, which re-import them, so the kind sweep and the body guard drive the same producers.
// ---------------------------------------------------------------------------------------------------------------------------------

type GroupUser = { id: string; email: string };

/** An account at `<prefix>-…@test.local` with a display name and an account language (none by default). Moved from the billing-group
 *  notify suites' `makeUser`; each suite hands in the prefix its addresses always had. */
export async function makeGroupUser(name: string, opts: { prefix?: string; locale?: string | null } = {}): Promise<GroupUser> {
  const email = `${opts.prefix ?? "group"}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${email}, ${name}, true, ${opts.locale ?? null}) returning id`;
  return { id, email };
}

/**
 * A live Pro group (a Stripe subscription and customer, paid through 20 days from now) that `payer` ("Dana Payer") pays for, with one
 * org in it (`Riverside …`, created by the payer, default language `orgDefaultLocale`) that `heir` ("Rae Heir", account language
 * `heirLocale`) owns, and no standing offer: offering it to the heir takes the two-phase path (a SetupIntent). Moved from
 * billing-group-offer-notify.test.ts's `seedLiveGroup`. A suite on the Stripe fixture server points its SetupIntents at `customer`.
 */
export async function seedLiveGroup(opts: { heirLocale?: string | null; orgDefaultLocale?: Locale; prefix?: string } = {}): Promise<{
  payer: GroupUser;
  heir: GroupUser;
  groupId: string;
  orgId: string;
  orgName: string;
  customer: string;
}> {
  const prefix = opts.prefix ?? "offer";
  const payer = await makeGroupUser("Dana Payer", { prefix });
  const heir = await makeGroupUser("Rae Heir", { prefix, locale: opts.heirLocale });
  const customer = "cus_" + randomUUID().slice(0, 8);
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, status_changed_at)
    values (${payer.id}, 'pro', 'active', 1, ${"sub_" + randomUUID().slice(0, 8)}, ${customer},
            now() + interval '20 days', now())
    returning id`;
  const s = randomUUID().slice(0, 8);
  const orgName = `Riverside ${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, default_locale)
    values (${orgName}, ${`riverside-${s}`}, ${payer.id}, ${groupId}, ${opts.orgDefaultLocale ?? "en"}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir.id}, 'owner')`;
  return { payer, heir, groupId, orgId, orgName, customer };
}

/** A live Pro group with TWO orgs: the OLDEST (`Primary …`, created by the payer) the heir is not a member of, and a NEWER one
 *  (`Recip …`) the heir owns. A link that must reach the heir has to pick the newer, heir-owned org, not just the oldest. Moved from
 *  billing-group-transfer-notify-followups.test.ts. */
export async function seedLiveGroupTwoOrgs(opts: { prefix?: string } = {}): Promise<{
  payer: GroupUser;
  heir: GroupUser;
  groupId: string;
  primarySlug: string;
  recipSlug: string;
  customer: string;
}> {
  const prefix = opts.prefix ?? "fnu";
  const payer = await makeGroupUser("Dana Payer", { prefix });
  const heir = await makeGroupUser("Rae Heir", { prefix });
  const customer = "cus_" + randomUUID().slice(0, 8);
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id,
       stripe_customer_id, current_period_end, status_changed_at)
    values (${payer.id}, 'pro', 'active', 1, ${"sub_" + randomUUID().slice(0, 8)}, ${customer},
            now() + interval '20 days', now())
    returning id`;
  const s1 = randomUUID().slice(0, 8);
  const primarySlug = `primary-${s1}`;
  await sql`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${`Primary ${s1}`}, ${primarySlug}, ${payer.id}, ${groupId}, now() - interval '1 hour')`;
  const s2 = randomUUID().slice(0, 8);
  const recipSlug = `recip-${s2}`;
  const [{ id: recipOrg }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at)
    values (${`Recip ${s2}`}, ${recipSlug}, ${heir.id}, ${groupId}, now())
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${recipOrg}, ${heir.id}, 'owner')`;
  return { payer, heir, groupId, primarySlug, recipSlug, customer };
}

/** A COMMUNITY group (no live Stripe subscription) that `payer` pays for, with one org in it (`Community …`, default language
 *  `orgDefaultLocale`) the heir owns: handing it to the heir takes the immediate path, which needs the heir to own an org in the group.
 *  With `customer`, the group keeps a Stripe customer from an earlier subscription, so the handover's tidy-up calls Stripe. Moved from
 *  billing-group-transfer-notify-followups.test.ts. */
export async function seedCommunityGroup(
  opts: { heirLocale?: string | null; orgDefaultLocale?: Locale; customer?: string; prefix?: string } = {},
): Promise<{ payer: GroupUser; heir: GroupUser; groupId: string; orgId: string; orgName: string; slug: string }> {
  const prefix = opts.prefix ?? "fnu";
  const payer = await makeGroupUser("Dana Payer", { prefix });
  const heir = await makeGroupUser("Rae Heir", { prefix, locale: opts.heirLocale });
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, stripe_customer_id, status_changed_at)
    values (${payer.id}, 'community', 'active', 1, ${opts.customer ?? null}, now())
    returning id`;
  const s = randomUUID().slice(0, 8);
  const slug = `community-${s}`;
  const orgName = `Community ${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, default_locale)
    values (${orgName}, ${slug}, ${heir.id}, ${groupId}, ${opts.orgDefaultLocale ?? "en"})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${heir.id}, 'owner')`;
  return { payer, heir, groupId, orgId, orgName, slug };
}

/**
 * A paying Pro group (active, paid through 20 days from now) with NO live Stripe subscription, so a detach's quantity sync returns
 * before any Stripe call. The payer ("Dana Payer", account language `payerLocale`) owns the oldest org (`Primary …`, default
 * `remainingDefaultLocale`); a SECOND org (`Northside …`, default `orgDefaultLocale`) is owned by someone else ("Ola Owner", account
 * language `ownerLocale`), so detaching it is a genuine cross-party removal. Moved from billing-group-detach-notify.test.ts's
 * `seedLiveGroup`.
 */
export async function seedDetachableGroup(
  opts: {
    payerLocale?: string | null;
    ownerLocale?: string | null;
    orgDefaultLocale?: Locale;
    remainingDefaultLocale?: Locale;
    prefix?: string;
  } = {},
): Promise<{ payer: GroupUser; owner: GroupUser; groupId: string; orgId: string; orgName: string; primaryId: string; primarySlug: string }> {
  const prefix = opts.prefix ?? "dnu";
  const payer = await makeGroupUser("Dana Payer", { prefix, locale: opts.payerLocale });
  const owner = await makeGroupUser("Ola Owner", { prefix, locale: opts.ownerLocale });
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, quantity_paid, current_period_end, status_changed_at)
    values (${payer.id}, 'pro', 'active', 2, now() + interval '20 days', now())
    returning id`;
  const s1 = randomUUID().slice(0, 8);
  const primarySlug = `primary-${s1}`;
  const [{ id: primaryId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at, default_locale)
    values (${`Primary ${s1}`}, ${primarySlug}, ${payer.id}, ${groupId}, now() - interval '1 hour', ${opts.remainingDefaultLocale ?? "en"})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${primaryId}, ${payer.id}, 'owner')`;
  const s2 = randomUUID().slice(0, 8);
  const orgName = `Northside ${s2}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id, created_at, default_locale)
    values (${orgName}, ${`northside-${s2}`}, ${owner.id}, ${groupId}, now(), ${opts.orgDefaultLocale ?? "en"})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  return { payer, owner, groupId, orgId, orgName, primaryId, primarySlug };
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Staff alerts (phase 3 wave 5, T4-T6). A staff alert has no org and no account: it is a row to `STAFF_ALERT_EMAIL`, whose ref IS its
// once-key (`<id>` or `<id>:<suffix>`, P-W5-1). A site test stubs that variable with its own per-run address, drives a real call site,
// and reads the rows back here.
// ---------------------------------------------------------------------------------------------------------------------------------

export type StaffRow = { ref_id: string; dedupe_key: string | null; status: string; recipient: string; subject: string };

/** The `kind` rows of `refType` about `id` (the id the alert is about: a row UUID or a Stripe id; ids carry no `:`), whatever their
 *  suffix, to ANY recipient, oldest first. Filtered by the test's own id, never by kind alone: the test database is shared. */
export const staffRows = (kind: string, refType: string, id: string) =>
  sql<StaffRow[]>`
    select ref_id, dedupe_key, status, recipient, subject from email_outbox
     where kind = ${kind} and ref_type = ${refType} and split_part(ref_id, ':', 1) = ${id}
     order by created_at, id`;

/** What `queueStaffAlert`'s catch left while a test ran (I2): its one log line and its Sentry issue. The writer answers `null` for an
 *  unset address, a replay and a drop alike, and only these tell a drop apart, so a site test that expects its alert to be queued (or
 *  deduplicated) asserts both are zero. `logError` is a spy on the logger's `error`; `capture` is the suite's `captureError` mock. */
export function staffAlertDrops(
  logError: { mock: { calls: unknown[][] } },
  capture: { mock: { calls: unknown[][] } },
): { logged: number; issues: number } {
  return {
    logged: logError.mock.calls.filter((c) => c[1] === STAFF_ALERT_QUEUE_FAILED).length,
    issues: capture.mock.calls.filter((c) => (c[1] as { route?: unknown } | undefined)?.route === "staff-alert").length,
  };
}
