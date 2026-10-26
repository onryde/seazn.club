import "server-only";
// The retry worker (spec "The retry worker"): ONE TICK, run by POST /api/cron/email-outbox on the cron Worker's fast
// trigger (every minute on prod, every 5 minutes on stg). `dispatchNow` makes every row's FIRST attempt in the request;
// everything after that is this tick's: a retry whose delay has passed, a row whose attempt crashed and whose lease has
// lapsed, a row whose time is up, a row that spent every attempt.
//
// A tick, in order:
//  0. asks the role check (R10): the pooled role must be a superuser or BYPASSRLS to write the outbox, and a role that is
//     not would "claim" zero rows and look like an empty queue for ever. So it asks on EVERY tick (a fixed role is believed
//     at once), and when the answer is no it logs an error and SKIPS the tick, reporting `failed: 1` so the cron Worker's
//     failure counter hears about it;
//  1. ends `expired` the rows that are `queued`, or `sending` with a lapsed lease, whose `expires_at` has passed (the body
//     goes with them: a late sign-in link is worse than none), the longest-expired first, at most ENDING_BATCH_SIZE;
//  2. ends `dead` ('attempts_exhausted') the `sending` rows with a lapsed lease that have spent MAX_ATTEMPTS: the last
//     attempt crashed and there is none left to reclaim it with. Same bound, longest-lapsed first;
//  3. claims one due row at a time, up to WORKER_BATCH_SIZE, earliest deadline first, and attempts it (`attemptClaimed`, the same
//     function `dispatchNow` uses, so the rules live in one place). A claim takes a `queued` row whose time has come (a
//     never-attempted one only once it is older than FIRST_ATTEMPT_WINDOW_MS: before that its request's `dispatchNow` owns it,
//     M2) OR a `sending` row whose lease has lapsed (R9: a 2xx whose recording write failed leaves exactly such a row, and
//     re-sending it under the SAME idempotency key yields one provider message), sets `sending`, `attempts + 1` and a lease in the claiming
//     statement (R10: the post-send writes are fenced on that attempt number), and skips rows another tick holds;
//  4. before each attempt after a request has left waits out the rest of MIN_SEND_INTERVAL_MS since that request began
//     (Resend: 2 requests a second; a row refused before any request starts no interval, like `dispatchNow`'s), and stops claiming at the claim cut-off (`claimCutoffMs`: the budget less the
//     HOOK_RESERVE_FRACTION kept for step 6, one send timeout and one pacing wait, so an attempt in flight at the cut-off
//     still ends before the reserve and sends can never starve the hooks), when the batch is full, or at the first 429;
//  5. counts, as `deferred`, the rows that were due right now and were not taken;
//  6. runs the kind hooks (`afterEndedBadly`), one row at a time, for every row steps 1-3 ended, plus (R9) every
//     badly-ended row whose effect a kind says was never applied (`findUnappliedEndings`): a process that dies between a
//     terminal write and its hook leaves such a row, and the next tick finishes the job. The hooks and the re-drive count
//     against the SAME budget (M2): once TICK_BUDGET_MS is spent no further hook runs and the finder is not asked, and what
//     was skipped is exactly what the finder reports next tick (a hook is idempotent and recomputes from state);
//  7. purges the rows older than RETENTION_DAYS (`purgeOldEmails`, at most PURGE_BATCH, whatever their status), LAST and inside the
//     SAME budget: housekeeping never takes time from a send or a hook, so once TICK_BUDGET_MS is spent it is skipped and the next
//     tick purges (the rows are as old tomorrow as today). A purge that throws is logged (`errFields`) and reported as 0: it never
//     turns a tick whose sends and hooks are done into a failure.
//
// Overlap is safe: skip locked keeps two ticks off the same row, and the lease keeps the second off a row the first is
// still sending. A row that is claimed but whose attempt throws in OUR code (the post-send write failed) is left `sending`
// with its lease, counted `failed`, and reclaimed when the lease lapses.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { attemptClaimed, endedRowFor, errFields, toClaimedRow, type AttemptOutcome, type ClaimedRecord } from "./attempt";
import {
  ENDING_BATCH_SIZE,
  FIRST_ATTEMPT_WINDOW_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MIN_SEND_INTERVAL_MS,
  REDRIVE_LIMIT,
  TICK_BUDGET_MS,
  WORKER_BATCH_SIZE,
  claimCutoffMs,
  type OutboxKind,
} from "./constants";
import { afterEndedBadly, findUnappliedEndings, hasEndedBadlyHook, type EndedRow } from "./hooks";
import { outboxRoleOk } from "./role-check";
import { purgeOldEmails } from "./status";

/**
 * What a tick did. `claimed` is every row it took; a claimed row lands in exactly one of `sent`, `retried`, `dead`,
 * `suppressed`, `expired` (found expired as its attempt began) or `failed` (the attempt threw in our own code), except a
 * row that was replaced while its attempt was in flight, which is counted in `claimed` only: its fate belongs to the newer
 * row. `expired` and `dead` also count the rows steps 1 and 2 ended without a claim. `deferred` is a count of rows due
 * right now that this tick did not take (batch full, budget spent, or stopped at a 429). `purged` is the number of rows older than
 * RETENTION_DAYS the tick deleted (step 7): 0 when none were old enough, and 0 when the budget was already spent.
 */
export type OutboxTickReport = {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  suppressed: number;
  expired: number;
  failed: number;
  deferred: number;
  purged: number;
};

export type RunOutboxTickOptions = {
  /** Wait this long. Default: a real timer. The test seam for pacing. */
  sleep?: (ms: number) => Promise<void>;
  /** The whole tick's budget. Claims stop at `claimCutoffMs(budgetMs)`, leaving the hook reserve whole; hooks and the
   *  re-drive stop at `budgetMs`. Default TICK_BUDGET_MS. */
  budgetMs?: number;
  /** A monotonic clock in ms, behind the pacing and the budget. Default `performance.now()`. The test seam for both. */
  nowMs?: () => number;
  /**
   * TEST SEAM ONLY (the route never passes it; external-play's sweep has the same as `orgIds`): restrict every statement
   * of the tick to these row ids. Test files run in parallel against one database and the worker takes ANY due row, so
   * without it a test would claim, expire or end another file's rows. An empty list means "no row", not "every row".
   */
  onlyIds?: readonly string[];
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The test seam's restriction as a fragment of a WHERE clause: nothing for the production tick. */
const scopeOf = (onlyIds: readonly string[] | undefined) =>
  onlyIds === undefined ? sql`` : sql`and id = any(${onlyIds as string[]}::uuid[])`;

/** Rows that are due right now: a `queued` row whose time has come, or a `sending` row whose lease has lapsed, with an
 *  attempt left and time left. One fragment shared by the claim and the deferred count, so they cannot disagree.
 *
 *  M2: a `queued` row that has never been attempted (`attempts = 0`) is the worker's only once it is older than the first-attempt
 *  window (FIRST_ATTEMPT_WINDOW_MS, judged on the database's clock): until then the request that wrote it is still sending its
 *  round (`dispatchNow`), and a tick that sent the same rows at the same time would double the rate Resend is asked for. A retry
 *  (`attempts > 0`) and a `sending` row whose lease lapsed carry no such owner, so the window does not touch them. */
const dueNow = (onlyIds: readonly string[] | undefined) => sql`
  ((status = 'queued' and next_attempt_at <= now()
      and (attempts > 0 or created_at <= now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000})))
    or (status = 'sending' and lease_until < now()))
  and attempts < ${MAX_ATTEMPTS} and expires_at > now() ${scopeOf(onlyIds)}`;

type EndedRecord = { id: string; kind: OutboxKind; ref_type: string; ref_id: string; meta: Record<string, string> };
const endedAs =
  (status: "expired" | "dead") =>
  (r: EndedRecord): EndedRow => ({ id: r.id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, status, meta: r.meta });

/** Step 1. `queued` rows, and `sending` rows whose lease lapsed, past `expires_at`: ended unsent, body and lease gone. At
 *  most ENDING_BATCH_SIZE, the longest-expired first; `skip locked` leaves a row another tick is ending to that tick. */
function expirePastDue(onlyIds: readonly string[] | undefined): Promise<EndedRecord[]> {
  return sql<EndedRecord[]>`
    with picked as (
      select id from email_outbox
       where (status = 'queued' or (status = 'sending' and lease_until < now())) and expires_at <= now() ${scopeOf(onlyIds)}
       order by expires_at, id
       limit ${ENDING_BATCH_SIZE}
       for update skip locked
    )
    update email_outbox o
       set status = 'expired', body_sealed = null, lease_until = null, status_at = now()
      from picked
     where o.id = picked.id
    returning o.id, o.kind, o.ref_type, o.ref_id, o.meta`;
}

/** Step 2. A lapsed `sending` row with every attempt spent: nothing is left to reclaim it with. Bounded like step 1, the
 *  longest-lapsed lease first. */
function endExhausted(onlyIds: readonly string[] | undefined): Promise<EndedRecord[]> {
  return sql<EndedRecord[]>`
    with picked as (
      select id from email_outbox
       where status = 'sending' and lease_until < now() and attempts >= ${MAX_ATTEMPTS} ${scopeOf(onlyIds)}
       order by lease_until, id
       limit ${ENDING_BATCH_SIZE}
       for update skip locked
    )
    update email_outbox o
       set status = 'dead', body_sealed = null, lease_until = null, last_error = 'attempts_exhausted', status_at = now()
      from picked
     where o.id = picked.id
    returning o.id, o.kind, o.ref_type, o.ref_id, o.meta`;
}

/**
 * Step 3's claim, one row: the due row whose deadline is earliest (M2: then the one due longest, then the lower id) that no other
 * transaction holds, set to `sending` with `attempts + 1` and a lease in the same statement. The deadline leads because the rows
 * an open writes share one `next_attempt_at` (the transaction's `now()`), so that key alone would take a round's leftovers in uuid
 * order and let a board whose check-in closes first expire behind boards that close later. `for update skip locked` is the registrations.ts pattern: a second tick
 * passes over a row the first is claiming instead of waiting for it.
 *
 * Exported so a test that must stage an interleaving between a worker's claim and `attemptClaimed` (or re-claim a lapsed lease) claims
 * with THIS statement and not a copy of it that can drift (a `ClaimedRecord` is what `toClaimedRow` takes). `dispatchNow`'s own claim
 * of a never-attempted row is `claimQueuedRow` (attempt.ts).
 */
export async function claimOne(onlyIds: readonly string[] | undefined): Promise<ClaimedRecord | undefined> {
  const [rec] = await sql<ClaimedRecord[]>`
    with picked as (
      select id, status as prior_status from email_outbox
       where ${dueNow(onlyIds)}
       order by expires_at, next_attempt_at, id
       limit 1
       for update skip locked
    )
    update email_outbox o
       set status = 'sending', attempts = o.attempts + 1,
           lease_until = now() + make_interval(secs => ${LEASE_MS / 1000}), status_at = now()
      from picked
     where o.id = picked.id
    returning o.id, o.kind, o.ref_type, o.ref_id, o.org_id, o.meta, o.recipient, o.subject, o.body_sealed,
              o.transactional, o.attempts, o.expires_at, o.lease_until, o.recipient_user_id, o.last_error,
              (picked.prior_status = 'sending') as reclaimed`;
  return rec;
}

/** Step 5: how many rows are due right now (the ones this tick left). */
async function countDue(onlyIds: readonly string[] | undefined): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ${dueNow(onlyIds)}`;
  return row?.n ?? 0;
}

function tally(report: OutboxTickReport, outcome: AttemptOutcome): void {
  switch (outcome) {
    case "sent":
      report.sent++;
      return;
    case "retrying":
      report.retried++;
      return;
    case "dead":
      report.dead++;
      return;
    case "suppressed":
      report.suppressed++;
      return;
    case "expired":
      report.expired++;
      return;
    case "deferred":
      return; // no longer ours when the write ran (replaced in flight, or re-claimed by a later attempt): claimed only
    default: {
      const unhandled: never = outcome;
      throw new Error(`runOutboxTick: unhandled attempt outcome ${String(unhandled)}`);
    }
  }
}

/** Run one tick. Throws only when the database does (a statement of its own failed); a row's own failure is counted. */
export async function runOutboxTick(opts: RunOutboxTickOptions = {}): Promise<OutboxTickReport> {
  const sleep = opts.sleep ?? realSleep;
  const nowMs = opts.nowMs ?? (() => performance.now());
  const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
  const report: OutboxTickReport = {
    claimed: 0, sent: 0, retried: 0, dead: 0, suppressed: 0, expired: 0, failed: 0, deferred: 0, purged: 0,
  };

  if (!(await outboxRoleOk())) {
    log.error(
      {},
      "email outbox: the database role is neither superuser nor BYPASSRLS, so it cannot write email_outbox; this tick was skipped and nothing was sent",
    );
    report.failed = 1;
    return report;
  }

  const startedAt = nowMs();
  // No claim after this: an attempt started just before it can wait out a pacing interval and run to its timeout, and it
  // must still end inside the send share, so the hooks (step 6, which may run on to `budgetMs`) have the reserve whole.
  const cutoffMs = claimCutoffMs(budgetMs);
  const ended: EndedRow[] = [];

  const expired = await expirePastDue(opts.onlyIds);
  report.expired += expired.length;
  ended.push(...expired.map(endedAs("expired")));

  const exhausted = await endExhausted(opts.onlyIds);
  report.dead += exhausted.length;
  ended.push(...exhausted.map(endedAs("dead")));

  let drained = false;
  let lastAttemptStartedAt: number | null = null;
  for (let i = 0; i < WORKER_BATCH_SIZE; i++) {
    if (nowMs() - startedAt >= cutoffMs) break;
    const rec = await claimOne(opts.onlyIds);
    if (!rec) {
      drained = true;
      break;
    }
    report.claimed++;
    // Pace AFTER the claim, so a tick that has nothing left does not sleep to find that out: the waits are exactly the
    // claims after the first request. The interval runs from the START of the previous REQUEST (Resend limits requests per
    // second, and a slow request already used its share of it), so an attempt that took the whole interval owes no wait. The
    // row is leased meanwhile, and `attemptClaimed` judges its expiry on the real clock as it starts, so a row that ran out of
    // time during the wait is ended unsent.
    if (lastAttemptStartedAt !== null) {
      const wait = MIN_SEND_INTERVAL_MS - (nowMs() - lastAttemptStartedAt);
      if (wait > 0) await sleep(wait);
    }
    const attemptStartedAt = nowMs();
    const claimed = toClaimedRow(rec);
    let rateLimited = false;
    try {
      const result = await attemptClaimed(claimed);
      // The interval is the provider's: only a request starts one (`AttemptResult.requestMade`, the same rule as `dispatchNow`'s).
      // A row refused before any request left (no body, no key, suppressed, expired as it began) used none of Resend's rate, so the
      // next row measures from the last request that did, and a tick of refusals never sleeps.
      if (result.requestMade) lastAttemptStartedAt = attemptStartedAt;
      tally(report, result.outcome);
      const endedRow = endedRowFor(claimed, result.outcome);
      if (endedRow) ended.push(endedRow);
      rateLimited = result.rateLimited;
    } catch (err) {
      // The send may have happened (a 2xx whose recording write failed): the request may have left, so it starts an interval. The
      // row stays `sending` with its lease and the reclaim re-sends it under the same idempotency key. Ids and the error's name
      // only: no address, no body.
      lastAttemptStartedAt = attemptStartedAt;
      report.failed++;
      log.error(
        { outboxId: rec.id, kind: rec.kind, attempt: rec.attempts, ...errFields(err) },
        "email outbox: recording an attempt failed; the row stays sending and the worker reclaims it when the lease lapses",
      );
    }
    if (rateLimited) break; // Resend asked us to slow down: the rest wait for the next tick
  }
  if (!drained) report.deferred = await countDue(opts.onlyIds);

  // Step 6. Hooks, one row at a time, against the tick's budget (M2): a row this tick ended first, then (R9) the rows a
  // previous tick ended whose hook never ran or never finished, found from each kind's own state. A row this tick ended is
  // also found by its kind's query (its hook has not run yet), so each id is driven once. A hook skipped for the budget is
  // not lost: it is still unapplied, so the finder reports it next tick.
  const overBudget = (): boolean => nowMs() - startedAt >= budgetMs;
  const handled = new Set<string>();
  let skippedHooks = 0;
  const drive = async (rows: readonly EndedRow[]): Promise<void> => {
    for (const row of rows) {
      if (handled.has(row.id)) continue;
      handled.add(row.id);
      if (overBudget()) {
        if (hasEndedBadlyHook(row.kind)) skippedHooks++; // a kind with no hook had nothing to skip
        continue;
      }
      await afterEndedBadly([row]);
    }
  };
  await drive(ended);
  if (!overBudget()) await drive(await findUnappliedEndings(REDRIVE_LIMIT));
  if (skippedHooks > 0) {
    log.warn(
      { skippedHooks },
      "email outbox: the tick budget was spent before every kind hook ran; the skipped hooks are re-driven by the next tick",
    );
  }

  // Step 7. Last, and only with budget left: retention is housekeeping, and the next tick does it just as well. It is also the one
  // step whose failure costs nothing that was already done: the sends and the hooks above are committed, so a purge that throws
  // (a statement timeout on a big backlog, a dropped connection) must not turn the tick into a 500 that loses their report. It is
  // logged by name, code and message only (`errFields`: the driver's error carries the failed statement), counted as 0, and the
  // next tick purges. It is NOT a `failed` row: nothing was attempted for a row.
  if (!overBudget()) {
    try {
      report.purged = await purgeOldEmails({ onlyIds: opts.onlyIds });
    } catch (err) {
      log.error({ ...errFields(err) }, "email outbox: the retention purge failed; the tick's other work is done and the next tick purges");
    }
  }

  if (report.claimed + report.expired + report.dead + report.deferred + report.purged > 0) log.info({ ...report }, "email outbox: tick");
  return report;
}
