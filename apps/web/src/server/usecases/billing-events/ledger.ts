import "server-only";
// Stripe event processing: the billing_events ledger — claim/run, replay, stuck-event sweep, reads (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { getStripe } from "@/lib/stripe";
import { processStripeEvent } from "./dispatch";
import { invoiceSubId } from "./invoices";
import { checkoutGroupId, resolveGroupForStripeSub } from "./group-resolution";
import { alertStuckEventParked } from "./staff-alerts";

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  type: string;
  org_id: string | null;
  org_name?: string | null;
  subscription_id?: string | null; // resolved group (#223)
  received_at: string;
  processed_at: string | null;
}

export type EventStatus = "processed" | "received" | "missing";

/** Status of a Stripe event against the ledger: no row = never received
 *  (webhook missed), row without processed_at = handler didn't finish. */
export function eventStatus(row: { processed_at: string | Date | null } | undefined): EventStatus {
  if (!row) return "missing";
  return row.processed_at ? "processed" : "received";
}

/**
 * Best-effort billing GROUP for one event, stamped durably at ingest so
 * attribution does not depend on live Stripe object metadata — which
 * invoice.* events do not carry (Stripe never copies subscription metadata
 * onto an invoice). Reuses the existing resolvers; a throw or a miss returns
 * null, which falls back to org-based attribution. (#223)
 */
async function resolveEventGroup(event: Stripe.Event): Promise<string | null> {
  try {
    const obj = event.data.object;
    if (event.type.startsWith("invoice.")) {
      const subId = invoiceSubId(obj as Stripe.Invoice);
      if (!subId) return null;
      const [g] = await sql<{ id: string }[]>`
        select id from subscriptions where stripe_subscription_id = ${subId}`;
      return g?.id ?? null;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const r = await resolveGroupForStripeSub(obj as Stripe.Subscription);
      return r?.subscriptionId ?? null;
    }
    if (event.type === "checkout.session.completed") {
      const session = obj as Stripe.Checkout.Session;
      return await checkoutGroupId(session, session.metadata?.org_id ?? "");
    }
    return null;
  } catch (err) {
    log.error({ eventId: event.id, err }, "billing: resolveEventGroup failed");
    return null;
  }
}

/**
 * Record + process one event exactly once, stamping processed_at only after the
 * handler ran (a throw leaves the row in the "received" state for the console).
 * Shared by the signed webhook and the staff replay.
 *
 * #229 P0-2: the claim is atomic. The webhook used to SELECT then INSERT ON
 * CONFLICT DO NOTHING but process unconditionally, so two concurrent deliveries
 * of the same event both ran the handler (a second dunning email/analytics
 * event) while only one wrote the ledger row. Now a single statement either
 * inserts a fresh row (leased now) or takes over a row that is still unprocessed
 * AND whose lease has expired (a crashed attempt); a row already processed, or
 * being processed under a live lease, matches nothing and returns no id. Only
 * the caller that gets an id back runs the handler. Returns whether it did.
 */
export async function runEvent(event: Stripe.Event): Promise<boolean> {
  const orgId =
    (event.data.object as { metadata?: { org_id?: string } }).metadata?.org_id ?? null;
  const groupId = await resolveEventGroup(event);
  const claimed = await sql<{ id: string }[]>`
    insert into billing_events
      (id, type, org_id, subscription_id, payload, processing_started_at)
    values (${event.id}, ${event.type}, ${orgId}, ${groupId},
            ${JSON.stringify(event.data.object)}, now())
    on conflict (id) do update
      set processing_started_at = now()
      where billing_events.processed_at is null
        -- Lease is shorter than the hourly stuck-event sweep, so a crash
        -- mid-handler is recovered, but long enough to cover a slow handler.
        and (billing_events.processing_started_at is null
             or billing_events.processing_started_at < now() - interval '10 minutes')
    returning id`;
  if (claimed.length === 0) return false;
  await processStripeEvent(event);
  await sql`
    update billing_events set processed_at = now() where id = ${event.id}`;
  return true;
}

/** Staff replay: skip events the ledger already saw through; heal a stuck one. */
export async function replayEvent(
  event: Stripe.Event,
): Promise<"processed" | "already_processed"> {
  const [existing] = await sql<{ processed_at: string | null }[]>`
    select processed_at from billing_events where id = ${event.id}`;
  if (existing?.processed_at) return "already_processed";
  // runEvent claims atomically; a live delivery may have taken the lease first.
  return (await runEvent(event)) ? "processed" : "already_processed";
}

/** Ledger rows for a set of live Stripe event ids (the diff read). */
export async function ledgerByIds(ids: string[]): Promise<Map<string, LedgerRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<LedgerRow[]>`
    select b.id, b.type, b.org_id, o.name as org_name, b.subscription_id, b.received_at, b.processed_at
    from billing_events b
    left join organizations o on o.id = b.org_id
    where b.id in ${sql(ids)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Auto-heal stuck events (spec P1-7): rows that landed in the ledger but never
 * reached processed_at (deploy crash / transient DB error mid-handler) sit
 * `received` forever, and /admin/billing-events (#87) only exposes MANUAL
 * replay. This cron sweep re-pulls each stuck row FRESH from Stripe (the trust
 * anchor — never the stored payload) and replays it; handlers are
 * replay-idempotent by contract, so replaying a `received` row is always safe.
 *
 * A row is retried up to 3 times; on the 3rd-attempt row it is PARKED
 * (replay_attempts set to 4, which the `< 4` filter excludes from every future
 * sweep) and staff are alerted ONCE, so the sweep stays quiet instead of
 * hammering a permanently-broken event. The park is the transition (R6): it
 * moves the row from 3 to 4 or matches nothing, so of two overlapping passes
 * (the cron is `retry: true`) only the one that parked it counts `alerted` and
 * pages; the alert's once-key (`<event>:parked`) backs that up. Stripe calls
 * stay OUTSIDE any sql.begin.
 */
export async function sweepStuckEvents(limit = 25): Promise<{
  replayed: number;
  failed: number;
  alerted: number;
}> {
  if (!process.env.STRIPE_SECRET_KEY) return { replayed: 0, failed: 0, alerted: 0 };
  const rows = await sql<{ id: string; type: string; replay_attempts: number }[]>`
    select id, type, replay_attempts from billing_events
    where processed_at is null
      and received_at < now() - interval '10 minutes'
      and replay_attempts < 4
    order by received_at
    limit ${limit}`;
  let replayed = 0,
    failed = 0,
    alerted = 0;
  for (const row of rows) {
    // Cap reached: park it (3 → 4, never selected again) and alert once. A pass
    // whose park matches nothing lost the row to an overlapping pass, which
    // counts and pages it.
    if (row.replay_attempts >= 3) {
      const parked = await sql`
        update billing_events set replay_attempts = 4
         where id = ${row.id} and replay_attempts = 3
        returning id`;
      if (parked.length > 0) {
        alerted++;
        await alertStuckEventParked({ eventId: row.id, eventType: row.type, attempts: row.replay_attempts + 1 });
      }
      continue;
    }
    try {
      const event = await getStripe().events.retrieve(row.id);
      await replayEvent(event);
      replayed++;
    } catch {
      // A retrieve/handler failure leaves the row `received`; bump the counter
      // so the next pass advances it toward the cap rather than looping forever.
      await sql`update billing_events set replay_attempts = replay_attempts + 1 where id = ${row.id}`;
      failed++;
    }
  }
  return { replayed, failed, alerted };
}

/** Stuck rows outside the live window: received, never processed. */
export async function stuckLedgerEvents(
  excludeIds: string[],
  limit = 50,
): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    select b.id, b.type, b.org_id, o.name as org_name, b.subscription_id, b.received_at, b.processed_at
    from billing_events b
    left join organizations o on o.id = b.org_id
    where b.processed_at is null
      ${excludeIds.length ? sql`and b.id not in ${sql(excludeIds)}` : sql``}
    order by b.received_at desc
    limit ${limit}`;
}
