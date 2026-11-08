import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C1, §7.2; plan 1 Task 7; pre-flight B7b, D5):
// the 7-day clock. An unsaved quick match expires QUICK_MATCH_EXPIRY_DAYS after its last activity, "creation or the last
// score" (C1); every activity moves `last_activity_at` and re-arms `expires_at` from it. A saved row carries no expiry
// (§7.7, plan 3) and keeps none: its activity still moves, its `expires_at` stays null.
//
// A re-armed expiry re-arms the reminder too (plan-1 T8 review, controller ruling; plan 3 Task 2): an unsaved row's touch
// clears `reminder_sent_at`, so a match revived after its "save it before it expires" mail gets that mail again before its
// NEW expiry (C2: one reminder per approach to expiry). A saved row keeps the stamp the save gave it.
//
// And the reminder already QUEUED for the old expiry ends (branch review B m6, controller PO rec 2026-11-08): a score that
// lands between the sweep's claim and the worker's send would otherwise mail "deleted tomorrow" for a match now 7 days out,
// and then a second reminder before the new expiry. It ends on the outbox's cancel path with QUICK_MATCH_REARMED_REASON, on
// the system org's tenant handle (`cancelQueuedEmails` fences on `current_org_id()`: on the pool it would end nothing of the
// system org's, cancel.ts G-7). Only a re-armed match whose reminder is still queued opens that transaction: one indexed read
// of the outbox (`email_outbox_ref_idx`) decides it, so a scored rally on a match with nothing queued pays one read.
//
// Two doors, one rule:
//   - `touchQuickMatchActivity(id)`: the home's own actions (plan 2's Score tap);
//   - `touchQuickMatchActivityForFixture(fixtureId)`: the scoring path, after an append commits (Task 8, D5). It finds the
//     row through fixtures → divisions → quick_matches.competition_id (unique, so indexed) in ONE statement, and touches
//     nothing for a fixture outside a quick match.
//
// PRIVILEGED (the pooled `sql`, not a tenant transaction): the scoring caller holds no system-org session, and runs this
// after its own transaction has closed. Import-light on purpose — the db client, the constants, the outbox's cancel leaf
// (type-only imports) and the delete module's ref-type constant — so the scoring path's call adds nothing of the home
// read's graph.
import { sql, withTenant } from "@/lib/db";
import { QUICK_MATCH_EXPIRY_DAYS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { QUICK_MATCH_REARMED_REASON, cancelQueuedEmails } from "@/server/email-outbox/cancel";
import type { OutboxKind } from "@/server/email-outbox/constants";
import { QUICK_MATCH_OUTBOX_REF_TYPE } from "./quick-match-delete";

const DAY_MS = 24 * 3600 * 1000;
/** The reminder the sweep queues before expiry (C2). */
const REMINDER_KIND: OutboxKind = "quick_match_reminder";

const expiryFrom = (now: Date): Date => new Date(now.getTime() + QUICK_MATCH_EXPIRY_DAYS * DAY_MS);

/** The rows a touch wrote: `rearmed` when it moved the expiry (unsaved), so a reminder queued for the old one is stale. */
type Touched = { id: string; rearmed: boolean };

/** End the reminder still queued for an expiry the touch just moved (see the header). Nothing queued: one read, no transaction. */
async function endStaleReminders(touched: readonly Touched[]): Promise<void> {
  const ids = touched.filter((t) => t.rearmed).map((t) => t.id);
  if (ids.length === 0) return;
  const queued = await sql<{ ref_id: string }[]>`
    select distinct ref_id from email_outbox
     where ref_type = ${QUICK_MATCH_OUTBOX_REF_TYPE} and ref_id = any(${ids}::text[]) and kind = ${REMINDER_KIND} and status = 'queued'`;
  if (queued.length === 0) return;
  // The ended rows are dropped: the reminder kind has no ended-badly hook (hooks.ts KIND_HOOKS), as quick-match-save.ts says.
  await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, (tx) =>
    cancelQueuedEmails(tx, {
      kind: REMINDER_KIND,
      refType: QUICK_MATCH_OUTBOX_REF_TYPE,
      refIds: queued.map((q) => q.ref_id),
      reason: QUICK_MATCH_REARMED_REASON,
    }),
  );
}

/** Mark activity on one quick match: `last_activity_at = now`, and while unsaved `expires_at` re-armed
 *  QUICK_MATCH_EXPIRY_DAYS out and the reminder re-armed (a saved row's expiry stays null and its stamp stays), a reminder
 *  still queued for the old expiry ended. An unknown id touches nothing. */
export async function touchQuickMatchActivity(id: string, now: Date = new Date()): Promise<void> {
  const touched = await sql<Touched[]>`
    update quick_matches
    set last_activity_at = ${now},
        expires_at = case when saved_by_user_id is null then ${expiryFrom(now)}::timestamptz else expires_at end,
        reminder_sent_at = case when saved_by_user_id is null then null else reminder_sent_at end
    where id = ${id}
    returning id, saved_by_user_id is null as rearmed`;
  await endStaleReminders(touched);
}

/** The same touch, for the quick match whose competition holds `fixtureId`. A fixture in an ordinary competition (or
 *  none) matches no row and touches nothing. */
export async function touchQuickMatchActivityForFixture(fixtureId: string, now: Date = new Date()): Promise<void> {
  const touched = await sql<Touched[]>`
    update quick_matches q
    set last_activity_at = ${now},
        expires_at = case when q.saved_by_user_id is null then ${expiryFrom(now)}::timestamptz else q.expires_at end,
        reminder_sent_at = case when q.saved_by_user_id is null then null else q.reminder_sent_at end
    from fixtures f
    join divisions d on d.id = f.division_id
    where f.id = ${fixtureId} and q.competition_id = d.competition_id
    returning q.id, q.saved_by_user_id is null as rearmed`;
  await endStaleReminders(touched);
}
