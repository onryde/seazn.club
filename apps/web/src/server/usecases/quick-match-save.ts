import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended 2026-11-08, C3, C9, C13;
// plan 3 Task 4, pre-flight D3, D8, D9, D10, D13, B19): keeping a quick match, and letting go of it.
//
// Two ways to keep one, and ONE save (D9):
//   - on any verified sign-in, every unsaved, unexpired match whose typed address is the account's (case-folded):
//     `saveQuickMatchesForVerifiedUser`, called at all six doors that start a session and never at staff impersonation
//     (quick-match-save-doors.test.ts stops a seventh door from shipping without it);
//   - the Save button's one match, for whoever presses it, address or none (C3): `saveQuickMatchForUser`.
// Both go through `saveInTx`: the saver set, the expiry cleared, the typed address forgotten, the reminder marked spent and
// any queued reminder ended, in ONE `withTenant(system org)` transaction. The address goes because the saver is known now
// (branch review B m9, controller PO rec 2026-11-08): a guest typed it and nobody verified it, a saved match is never
// reminded, and a stranger's address is not kept for ever. V507's `email_lower` is generated from it, so it goes too.
// The tenant is load-bearing: `cancelQueuedEmails` fences on
// `current_org_id()`, and on the pool it ends only org-less rows, which is nothing of the system org's (cancel.ts G-7).
//
// A match past its expiry that the sweep has not reached yet is never revived (D13): the button hears `gone`, as the
// home's resolver does. Nothing here reads the home token: the button's caller resolves it (quick-match-home.ts).
//
// And letting go (D8): `releaseQuickMatchesOfDeletedAccount`, inside the account deletion's own transaction.
import { withTenant, type Tx } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { EVENTS } from "@/lib/analytics-events";
import { captureServer } from "@/lib/posthog-server";
import { QUICK_MATCH_EXPIRY_DAYS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { deletedAccountPlaceholder, endQueuedForDeletedAccount } from "@/server/email-outbox/account-deletion";
import { QUICK_MATCH_SAVED_REASON, cancelQueuedEmails } from "@/server/email-outbox/cancel";
import type { OutboxKind } from "@/server/email-outbox/constants";
import type { EndedRow } from "@/server/email-outbox/hooks";
import { log } from "@/server/logger";
import { QUICK_MATCH_OUTBOX_REF_TYPE } from "./quick-match-delete";

/** The reminder the sweep queues before expiry (C2; the kind is in OUTBOX_KINDS and the kind CHECK since V507). */
const QUICK_MATCH_REMINDER_KIND: OutboxKind = "quick_match_reminder";
/** A quick match's two mails: the link at creation and the reminder before expiry (both literal-address, V507). */
const QUICK_MATCH_MAIL_KINDS: readonly OutboxKind[] = ["quick_match_link", QUICK_MATCH_REMINDER_KIND];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Save button's answers. `taken`: someone else's match, refused and unchanged. `gone`: no such match, or one past
 *  its expiry that the sweep has not reached yet (never revived, D13). */
export type QuickMatchSaveAnswer = "saved" | "already_yours" | "taken" | "gone";

type Which = { ids: readonly string[] } | { email: string };

/**
 * THE save, on the caller's system-org transaction: every row `which` names that nobody has saved and that has not
 * expired becomes `userId`'s, with no expiry, no address and its reminder marked spent (a reminder already sent keeps its time), and
 * any queued reminder for those rows ends with `quick_match_saved`. Returns the ids it saved. Row locks make a race
 * safe: a second save waiting on the row re-reads `saved_by_user_id is null` and saves nothing.
 */
async function saveInTx(tx: Tx, userId: string, which: Which): Promise<string[]> {
  // The by-email arm runs on every verified sign-in. It compares V507's generated `email_lower` (= lower(email)), never
  // `lower(email)` itself: under the table's RLS a non-leakproof function on a column cannot be an index condition, so only
  // the column form looks the address up in `quick_matches_unsaved_email_idx` (quick-match-save.test.ts proves it reads one
  // index entry, not every unsaved address).
  const named =
    "email" in which ? tx`email_lower = lower(${which.email})` : tx`id = any(${which.ids as string[]}::uuid[])`;
  const rows = await tx<{ id: string }[]>`
    update quick_matches
       set saved_by_user_id = ${userId}, expires_at = null, email = null, reminder_sent_at = coalesce(reminder_sent_at, now())
     where ${named}
       and saved_by_user_id is null
       and (expires_at is null or expires_at > now())
     returning id`;
  const ids = rows.map((r) => r.id);
  // The rows the cancel ended are dropped, not handed to `afterEndedBadly`: the reminder kind has no ended-badly hook and
  // no re-drive (KIND_HOOKS, hooks.ts), since nothing waits on a reminder's outcome. quick-match-save.test.ts pins that; a
  // kind that gains a hook must gain the call after this transaction's commit too.
  await cancelQueuedEmails(tx, {
    kind: QUICK_MATCH_REMINDER_KIND,
    refType: QUICK_MATCH_OUTBOX_REF_TYPE,
    refIds: ids,
    reason: QUICK_MATCH_SAVED_REASON,
  });
  return ids;
}

/** One `quick_match_saved` per saved match, after the commit (D10): the system org's own event, as the create's is.
 *  The match's id and the way in only: never its name, its address or its token. Tail work: one deferral for them all,
 *  so a sign-in never waits on a PostHog flush. */
function announce(userId: string, ids: readonly string[], via: "button" | "email"): void {
  if (ids.length === 0) return;
  deferred(async () => {
    for (const id of ids) {
      await captureServer({
        event: EVENTS.QUICK_MATCH_SAVED,
        distinctId: userId,
        orgId: QUICK_MATCH_SYSTEM_ORG_ID,
        properties: { quick_match_id: id, via },
      });
    }
  });
}

/**
 * On a verified sign-in: save every match typed with the account's address (§7.7, C3). A no-op answering 0 for an
 * account whose address is not verified (B19) or that is deleted. Runs at each door right after `createSession`, so it
 * NEVER throws: a failure is logged and answered 0, and the sign-in goes on (the next sign-in tries again).
 */
export async function saveQuickMatchesForVerifiedUser(userId: string): Promise<{ savedByEmail: number }> {
  try {
    const ids = await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, async (tx) => {
      const [account] = await tx<{ email: string }[]>`
        select email from users where id = ${userId} and email_verified and deleted_at is null`;
      return account ? saveInTx(tx, userId, { email: account.email }) : [];
    });
    announce(userId, ids, "email");
    return { savedByEmail: ids.length };
  } catch (err) {
    log.error({ err, userId }, "quick match: the save on sign-in failed; the sign-in goes on");
    return { savedByEmail: 0 };
  }
}

/** The Save button: keep this one match for `userId`, whoever typed what on it (C3). */
export async function saveQuickMatchForUser(userId: string, quickMatchId: string): Promise<QuickMatchSaveAnswer> {
  if (!UUID.test(quickMatchId)) return "gone";
  const answer = await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, async (tx): Promise<QuickMatchSaveAnswer> => {
    const [row] = await tx<{ saved_by_user_id: string | null }[]>`
      select saved_by_user_id from quick_matches where id = ${quickMatchId} for update`;
    if (!row) return "gone";
    if (row.saved_by_user_id === userId) return "already_yours";
    if (row.saved_by_user_id !== null) return "taken";
    // Unsaved and locked: the save's own expiry predicate is the one alive check, so an expired row saves nothing.
    return (await saveInTx(tx, userId, { ids: [quickMatchId] })).length === 1 ? "saved" : "gone";
  });
  if (answer === "saved") announce(userId, [quickMatchId], "button");
  return answer;
}

/**
 * A deleted account lets go of its quick matches (D8), on the deletion's own transaction (the pooled client, before the
 * account's address is anonymised): the matches it saved expire again `QUICK_MATCH_EXPIRY_DAYS` after their last
 * activity, so friends with the link keep scoring until then, and the reminder is owed again (the save had marked it
 * sent); its address leaves every match it was typed on. The matches it saved are found by their saver, never by the
 * address: a saved match holds none (m9), so a released one has no address to be reminded at either.
 *
 * And every quick match mail still QUEUED to the address (its link, its reminder) ends unsent (branch review B m4, controller
 * PO rec 2026-11-08), whichever match it is about: one a stranger saved has forgotten the address (m9), its queued link mail
 * has not. It ends on the account deletion's own end path (`account_deleted`, email-outbox/account-deletion.ts), not
 * `cancelQueuedEmails`: that one fences on `current_org_id()` and this transaction is the pooled one, on which it would end
 * nothing of the system org's (cancel.ts G-7); a second, tenant transaction could fail apart from the deletion. Returns the
 * ended rows for the route's `afterEndedBadly` (neither kind has a hook; the route hands every ended row on regardless).
 *
 * The address is case-folded, as the rest of the release folds it, where the account deletion's own legacy arm deliberately
 * does not (account-deletion.ts N-B: `users.email` is case-sensitive, so a folded match could reach a case-variant twin
 * account's rows). The account deletion fences that arm on `recipient_user_id is null` and can match exactly; quick match
 * mail never carries an account id (enqueue.ts refuses one on a literal-address kind), so there is no account to fence on, and
 * a guest's typed spelling is not the account's. Two residuals, both accepted as rare (branch review B): a case-variant
 * twin's quick match mail is ended and scrubbed too; and mail sent to an address the account has since changed away from is
 * not reached (the same gap as account-deletion.ts's RESIDUAL).
 *
 * The end is index-served: its predicate is `email_outbox_replace_idx`'s (kind, ref_type, lower(recipient)), partial on the
 * live statuses that `status = 'queued'` implies.
 *
 * Then EVERY quick match mail to the address, whatever its status (sent, delayed, ended), loses it to the deleted account's
 * placeholder, as the account deletion's step 3 scrubs the account's own rows (controller ruling 2026-11-12: the same policy,
 * none of its own). After the end, which finds the queued rows by the address. A sent row keeps its status: the provider's
 * later events find it by its provider id, never by recipient (provider-events.ts). NOT index-served: with no status filter
 * the partial `email_outbox_replace_idx` cannot serve it, so it reads every quick match outbox row (`email_outbox_ref_idx`
 * by ref_type, then a filter on the recipient), of every status, up to retention, once per account deletion. Account
 * deletion is rare, so no index is added for it (review m-1).
 */
export async function releaseQuickMatchesOfDeletedAccount(tx: Tx, a: { userId: string; email: string }): Promise<EndedRow[]> {
  await tx`
    update quick_matches
       set saved_by_user_id = null,
           expires_at = last_activity_at + make_interval(days => ${QUICK_MATCH_EXPIRY_DAYS}),
           reminder_sent_at = null
     where saved_by_user_id = ${a.userId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
  await tx`
    update quick_matches set email = null
     where email_lower = lower(${a.email}) and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
  const mailToAddress = () =>
    tx`(kind = any(${QUICK_MATCH_MAIL_KINDS as string[]}::text[]) and ref_type = ${QUICK_MATCH_OUTBOX_REF_TYPE}
        and lower(recipient) = lower(${a.email}))`;
  const ended = await endQueuedForDeletedAccount(tx, mailToAddress());
  await tx`update email_outbox set recipient = ${deletedAccountPlaceholder(a.userId)} where ${mailToAddress()}`;
  return ended;
}
