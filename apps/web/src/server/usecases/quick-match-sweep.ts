import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md C1, C2, C21, §7.8; plan 3 Task 2 with its
// pre-flight amendments): the hourly sweep. An unsaved quick match lives QUICK_MATCH_EXPIRY_DAYS after its last activity;
// a guest who typed an address gets ONE reminder before that; then the match is hard-deleted with everything under it.
// Nothing here ever deletes on a date (C21): a competition's `ends_on` is never read, only `quick_matches.expires_at`.
//
// One pass, four steps, in this order, each over at most QUICK_MATCH_SWEEP_LIMIT rows (the rest is `deferred`, never a
// failure: the next hourly run reaches it):
//   0. orphans: a system-org competition with no `quick_matches` row, older than an hour, is a create that died between
//      its two commits (quick-match-create.ts's header). It is hard-deleted. The hour leaves a create in flight alone.
//   1. re-arm (Review Focus 3, D8): a saved match whose saver's account is soft-deleted (`users.deleted_at`; the account
//      deletion releases its matches itself, so this is the backstop) or hard-deleted (the FK nulled `saved_by_user_id`,
//      leaving a row with neither saver nor expiry) becomes unsaved again, expiring 7 days after its last activity. Its
//      address goes too: with the account gone it can no longer be compared with anyone's.
//   2. expire: an unsaved match whose expiry is strictly past is hard-deleted (quick-match-delete.ts), each in its own
//      transaction that re-reads the expiry under the row's lock, so a score that landed since the read keeps it.
//   3. remind (C2): an unsaved match with an address, not yet reminded, whose expiry is within
//      QUICK_MATCH_REMINDER_HOURS_BEFORE, is CLAIMED (`reminder_sent_at` stamped only where it is still null, every other
//      condition re-checked by the same UPDATE) and its reminder queued on the email outbox in the same transaction, so of
//      two overlapping sweeps only the one whose claim wrote a row queues the mail; a refused enqueue rolls the claim back.
//      The once-key names the expiry being reminded of, so a match that is revived (the touch clears the stamp,
//      quick-match-activity.ts) is reminded again before its new expiry, and never twice before the same one. The outbox's
//      worker sends it (the sweep makes no attempt itself), not transactional: a suppressed address is not mailed.
//
// A row whose step throws is counted in `failed` and logged with its ids and an error code, never a token, an address or
// the error object (a driver error can carry the statement's parameters); the other rows carry on.
//
// PRIVILEGED: the pooled role, as the delete and the touch. Every statement names the system org. The reminder's links are
// rebuilt from the row the home module reads (`findQuickMatchByCompetition`), never from the sealed column itself, which
// only the create and the home read may name (enc-boundary.test.ts).
import { sql } from "@/lib/db";
import { quickMatchReminderEmail } from "@/lib/email";
import { HttpError } from "@/lib/errors";
import {
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_REMINDER_HOURS_BEFORE,
  QUICK_MATCH_SYSTEM_ORG_ID,
} from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";
import { log } from "@/server/logger";
import { hardDeleteQuickMatchCompetition, QUICK_MATCH_OUTBOX_REF_TYPE, type QuickMatchDeleteResult } from "./quick-match-delete";
import { findQuickMatchByCompetition } from "./quick-match-home";
import { tryOpenHomeToken } from "./quick-match-tokens";

/** The most rows one step takes in one run (pre-flight B10). The rest is `deferred`. */
export const QUICK_MATCH_SWEEP_LIMIT = 200;
/** A system-org competition with no `quick_matches` row is an orphan once it is this old (pre-flight D5). */
export const QUICK_MATCH_ORPHAN_AGE_MS = 3600 * 1000;

const HOUR_MS = 3600 * 1000;
const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;
const REMINDER_KIND = "quick_match_reminder" as const;

/** One run's counts (pre-flight D6). The cron Worker counts `failed` as a failure; `deferred` is not one. */
export interface QuickMatchSweepReport {
  /** The quick matches in scope the run judged, plus the orphan competitions it found. */
  checked: number;
  /** Saved matches whose saver's account was gone, made unsaved again. */
  rearmed: number;
  /** Reminders queued. */
  reminded: number;
  /** Unsaved matches past their expiry, deleted. */
  expired: number;
  /** Orphan competitions, deleted. */
  orphans: number;
  /** Rows whose step threw (logged by id and code). */
  failed: number;
  /** Rows past a step's limit, and rows a delete's re-check kept (revived, saved, or locked by another transaction). */
  deferred: number;
}

export interface SweepQuickMatchesOptions {
  /** The app's base URL, for the reminder's links (the route passes `baseUrl(req)`). */
  baseUrl: string;
  /** The run's clock. Production passes none. */
  now?: Date;
  /** TEST ONLY (never read from a request): restrict every step to rows whose `quick_matches.id` or competition id is listed.
   *  The system org is shared by every suite running against one database; an empty list scopes the run to nothing. */
  onlyIds?: readonly string[];
  /** TEST ONLY: make the delete of a listed competition throw, to see one failure counted while the other rows carry on. */
  _failDeleteForTests?: (competitionId: string) => boolean;
}

/** An error's code for the log and nothing else (never its message, which may quote a parameter). */
function codeOf(err: unknown): string {
  if (err instanceof HttpError) return err.code ?? `HTTP_${err.status}`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : "UNKNOWN";
}

/** One sweep of the quick matches (see the header). */
export async function sweepQuickMatches(opts: SweepQuickMatchesOptions): Promise<QuickMatchSweepReport> {
  const now = opts.now ?? new Date();
  const only = opts.onlyIds === undefined ? null : [...opts.onlyIds];
  const report: QuickMatchSweepReport = { checked: 0, rearmed: 0, reminded: 0, expired: 0, orphans: 0, failed: 0, deferred: 0 };
  const matchInScope = () =>
    only === null ? sql`` : sql`and (q.id = any(${only}::uuid[]) or q.competition_id = any(${only}::uuid[]))`;
  const competitionInScope = () => (only === null ? sql`` : sql`and c.id = any(${only}::uuid[])`);
  /** One step's candidates beyond the limit are deferred to the next run. */
  const deferRest = (rows: readonly { total: number }[]) => {
    report.deferred += Math.max(0, (rows[0]?.total ?? 0) - rows.length);
  };
  /** A delete's answer, counted under `into`. */
  const countDelete = (r: QuickMatchDeleteResult, into: "expired" | "orphans") => {
    if (r.deleted) report[into] += 1;
    else if (r.kept) report.deferred += 1;
  };
  const failed = (step: string, ids: Record<string, string>, err: unknown, rows = 1) => {
    report.failed += rows;
    log.error({ step, ...ids, rows, code: codeOf(err) }, "quick match sweep: a row failed; the others carry on");
  };

  const [counted] = await sql<{ n: number }[]>`
    select count(*)::int as n from quick_matches q where q.org_id = ${SYSTEM_ORG} ${matchInScope()}`;
  report.checked += counted?.n ?? 0;

  // 0. Orphans.
  const orphanBefore = new Date(now.getTime() - QUICK_MATCH_ORPHAN_AGE_MS);
  const orphans = await sql<{ id: string; total: number }[]>`
    select c.id, count(*) over ()::int as total
      from competitions c
     where c.org_id = ${SYSTEM_ORG} and c.created_at < ${orphanBefore}
       and not exists (select 1 from quick_matches q where q.competition_id = c.id)
       ${competitionInScope()}
     order by c.created_at
     limit ${QUICK_MATCH_SWEEP_LIMIT}`;
  report.checked += orphans[0]?.total ?? 0;
  deferRest(orphans);
  for (const o of orphans) {
    try {
      if (opts._failDeleteForTests?.(o.id)) throw new Error("armed: this delete fails (test)");
      countDelete(await hardDeleteQuickMatchCompetition(o.id, { orphanedBefore: orphanBefore }), "orphans");
    } catch (err) {
      failed("orphan", { competitionId: o.id }, err);
    }
  }

  // 1. Re-arm the matches whose saver is gone: ONE statement, whose rows are chosen and locked by the condition itself
  //    (`for update skip locked`, which re-reads it on the row's latest version), so a row saved since, or held by an
  //    overlapping run, is never re-armed here. The rows that qualified but were not re-armed (past the limit, or held) are
  //    deferred: the next run reaches them.
  const saverGone = () => sql`((q.saved_by_user_id is null and q.expires_at is null)
    or exists (select 1 from users u where u.id = q.saved_by_user_id and u.deleted_at is not null))`;
  const [releasable] = await sql<{ n: number }[]>`
    select count(*)::int as n from quick_matches q where q.org_id = ${SYSTEM_ORG} and ${saverGone()} ${matchInScope()}`;
  const pendingRearm = releasable?.n ?? 0;
  try {
    const rearmed = await sql`
      update quick_matches t
         set saved_by_user_id = null,
             expires_at = t.last_activity_at + make_interval(days => ${QUICK_MATCH_EXPIRY_DAYS}::int),
             email = null,
             reminder_sent_at = null
       where t.id in (
         select q.id from quick_matches q
          where q.org_id = ${SYSTEM_ORG} and ${saverGone()} ${matchInScope()}
          order by q.last_activity_at
          limit ${QUICK_MATCH_SWEEP_LIMIT}
            for update of q skip locked)`;
    report.rearmed += rearmed.count;
    report.deferred += Math.max(0, pendingRearm - rearmed.count);
  } catch (err) {
    // One statement: every row it would have taken failed with it (and a failure is never counted as none).
    failed("rearm", {}, err, Math.max(1, Math.min(pendingRearm, QUICK_MATCH_SWEEP_LIMIT)));
    report.deferred += Math.max(0, pendingRearm - QUICK_MATCH_SWEEP_LIMIT);
  }

  // 2. Expire.
  const expired = await sql<{ id: string; competition_id: string; total: number }[]>`
    select q.id, q.competition_id, count(*) over ()::int as total
      from quick_matches q
     where q.org_id = ${SYSTEM_ORG} and q.saved_by_user_id is null and q.expires_at < ${now}
       ${matchInScope()}
     order by q.expires_at
     limit ${QUICK_MATCH_SWEEP_LIMIT}`;
  deferRest(expired);
  for (const e of expired) {
    try {
      if (opts._failDeleteForTests?.(e.competition_id)) throw new Error("armed: this delete fails (test)");
      countDelete(await hardDeleteQuickMatchCompetition(e.competition_id, { expiredBefore: now }), "expired");
    } catch (err) {
      failed("expire", { quickMatchId: e.id, competitionId: e.competition_id }, err);
    }
  }

  // 3. Remind.
  const horizon = new Date(now.getTime() + QUICK_MATCH_REMINDER_HOURS_BEFORE * HOUR_MS);
  const due = await sql<{ id: string; competition_id: string; total: number }[]>`
    select q.id, q.competition_id, count(*) over ()::int as total
      from quick_matches q
     where q.org_id = ${SYSTEM_ORG} and q.saved_by_user_id is null and q.email is not null and q.reminder_sent_at is null
       and q.expires_at >= ${now} and q.expires_at <= ${horizon}
       ${matchInScope()}
     order by q.expires_at
     limit ${QUICK_MATCH_SWEEP_LIMIT}`;
  deferRest(due);
  for (const d of due) {
    try {
      if (await remind(d.id, d.competition_id, { baseUrl: opts.baseUrl, now, horizon })) report.reminded += 1;
    } catch (err) {
      failed("remind", { quickMatchId: d.id, competitionId: d.competition_id }, err);
    }
  }

  return report;
}

/** Claim one match's reminder and queue it, in one transaction. True when this call queued it; false when the row no longer
 *  qualifies (claimed by an overlapping run, saved, revived, gone) or the reminder for this expiry is already on the outbox. */
async function remind(
  quickMatchId: string,
  competitionId: string,
  ctx: { baseUrl: string; now: Date; horizon: Date },
): Promise<boolean> {
  const row = await findQuickMatchByCompetition(competitionId);
  if (!row || row.id !== quickMatchId) return false; // deleted since the read
  const opened = tryOpenHomeToken(row.tokenEnc);
  // A key that cannot open the token cannot build the link: a fault, before anything is claimed (the next run tries again).
  if (!opened.ok) throw new HttpError(503, "the home token cannot be opened", `QUICK_MATCH_HOME_TOKEN_${opened.reason.toUpperCase()}`);
  const home = `${ctx.baseUrl}${routes.quickMatch(opened.token)}`;
  return sql.begin(async (tx) => {
    const [claimed] = await tx<{ email: string; locale: string; name: string; expires_at: Date }[]>`
      update quick_matches
         set reminder_sent_at = ${ctx.now}
       where id = ${quickMatchId} and org_id = ${SYSTEM_ORG}
         and reminder_sent_at is null and saved_by_user_id is null and email is not null
         and expires_at >= ${ctx.now} and expires_at <= ${ctx.horizon}
      returning email, locale, name, expires_at`;
    if (!claimed) return false;
    const queued = await enqueueEmailOnce(tx, {
      kind: REMINDER_KIND,
      refType: QUICK_MATCH_OUTBOX_REF_TYPE,
      refId: quickMatchId,
      dedupeKey: onceKey(REMINDER_KIND, QUICK_MATCH_OUTBOX_REF_TYPE, quickMatchId, `reminder:${claimed.expires_at.toISOString()}`),
      // The system org's own row, as the link mail is (plan 3 Global Constraints: one rule for both quick match kinds).
      orgId: SYSTEM_ORG,
      to: claimed.email,
      // Not transactional (controller ruling 2026-11-08): a suppressed address (a bounce, a complaint) is not mailed.
      transactional: false,
      // Worthless once the match has expired.
      expiresAt: expiryWithin(claimed.expires_at),
      ...(await quickMatchReminderEmail(
        { name: claimed.name, link: home, saveLink: `${home}/save`, expiresAt: claimed.expires_at },
        // A guest has no account and the system org is no one's, so the setup form's own language.
        await recipientLocale(tx, { pick: claimed.locale, userId: null, orgDefault: null }),
      )),
    });
    return queued !== null;
  });
}
