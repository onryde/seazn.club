// Shared rig for the sponsor invoice suites (Task 22): an org that can sell online (Pro + a Connect account that takes charges),
// its package and sponsor, and a Stripe stand-in with Stripe's own idempotency (the same key answers the same session,
// sandbox-verified in task-6-7-report.md). Not a test file (no `.test.` in the name), so vitest never collects it.
//
// The TOKENS are never made here. Each suite wraps the real `mintInvoiceToken` with its own `vi.mock` (hoisted per file) and
// reads what the REAL createDeal / sendDealInvoice minted from `minted` (F9): no suite writes a hash.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDealInput } from "@/server/usecases/sponsor-deals";

export const uniq = () => randomUUID().slice(0, 8);
export const ORIGIN = "https://invoice.test";

export interface RigOrg {
  orgId: string;
  slug: string;
  name: string;
  auth: AuthCtx;
}

/** Everything a rig made, for `cleanUp`. */
export const made = { orgIds: [] as string[], userIds: [] as string[] };

/** A Checkout session as Stripe answers `create`: `secondsLeft` until it expires. */
export function session(secondsLeft = 86_400): { id: string; url: string; expires_at: number } {
  return { id: `cs_${uniq()}`, url: `https://checkout.stripe.test/${uniq()}`, expires_at: Math.floor(Date.now() / 1000) + secondsLeft };
}

/** Stripe's idempotency: the same key answers the same session (so a re-used key is a STALE link, which a test can see). */
export function idempotentCreate(): (params: unknown, opts: { idempotencyKey: string }) => Promise<ReturnType<typeof session>> {
  const byKey = new Map<string, ReturnType<typeof session>>();
  return async (_params, opts) => {
    let s = byKey.get(opts.idempotencyKey);
    if (!s) byKey.set(opts.idempotencyKey, (s = session()));
    return s;
  };
}

/** An org with a real editor. `pro` sells online (`sponsors.monetize`) through a Connect account that takes charges. */
export async function rigOrg(opts: {
  plan?: "pro" | "community";
  locale?: "en" | "es" | "fr" | "nl";
  timezone?: string | null;
  address?: string | null;
  bank?: string | null;
} = {}): Promise<RigOrg> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`invoice-${uniq()}@test.local`}, 'Invoice Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const slug = `invoice-${s}`;
  const name = `Riverside Shuttlers ${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled, default_locale, timezone,
                               sponsor_invoice_address, sponsor_invoice_bank_details)
    values (${name}, ${slug}, ${userId}, ${`acct_${s}`}, true, ${opts.locale ?? "en"}, ${opts.timezone ?? null},
            ${opts.address ?? null}, ${opts.bank ?? null})
    returning id`;
  made.orgIds.push(orgId);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, opts.plan ?? "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, slug, name, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

export async function rigPackage(o: RigOrg, over: { name?: string; price?: number; currency?: string; onStream?: boolean } = {}): Promise<{ id: string; name: string }> {
  const name = over.name ?? `Gold board ${uniq()}`;
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier, includes_on_stream)
    values (${o.orgId}, ${name}, ${over.price ?? 25_000}, ${over.currency ?? "gbp"}, 'partner', ${over.onStream ?? false})
    returning id`;
  return { id: row!.id, name };
}

export async function rigSponsor(o: RigOrg, name = `Harbour Bank ${uniq()}`): Promise<{ id: string; name: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${name}, 'partner', 'active') returning id`;
  return { id: row!.id, name };
}

/** An Add deal body. Online deals need a billing email; the others may carry one. */
export function dealInput(packageId: string, over: Partial<CreateDealInput> = {}): CreateDealInput {
  const method = over.payment_method ?? "offline";
  return {
    package_id: packageId,
    competition_id: null,
    payment_method: method,
    go_live: method === "complimentary" ? "immediate" : "on_payment",
    sponsor_email: method === "online" ? `billing-${uniq()}@test.local` : null,
    ends_on: null,
    end_current: false,
    ...over,
  };
}

/** The stored row's invoice columns. */
export async function invoiceCols(dealId: string): Promise<{ invoice_number: number | null; invoice_token_hash: Buffer | null }> {
  const [row] = await sql<{ invoice_number: number | null; invoice_token_hash: Buffer | null }[]>`
    select invoice_number, invoice_token_hash from sponsor_orders where id = ${dealId}`;
  return row!;
}

/** Drop everything a rig made, in the order the RESTRICT keys need (the counter before its org, T20). */
export async function cleanUp(): Promise<void> {
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_invoice_counters where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsors where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_packages where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from org_members where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
}
