import "server-only";
// One send attempt, and the first-attempt dispatcher a request runs right after its transaction commits.
//
// Spec "Sending". `dispatchNow(ids)` attempts rows at once, in the request, so a sign-in link is no slower than today.
// It makes FIRST ATTEMPTS ONLY: it never reads `next_attempt_at`, and a row it cannot claim (taken, replaced, already
// attempted, a second call) is `deferred`. Every later attempt is the worker's (Task 4), which claims its own rows and
// calls `attemptClaimed`, the same function, so the rules live in one place.
//
// Rulings R5 and R8: `attemptClaimed` asks `checkSendable` (API key, suppression for non-transactional mail) BEFORE it
// opens the sealed body, then hands the plaintext and the gate's key to the transport. The `SendGate` and Resend's raw
// `detail` are never logged or stored; `last_error` is `http <status> <name>` or `network <cause>`, capped at 200.
//
// Every update after the send is conditional on `status = 'sending'`: a row superseded while its attempt was in flight
// (the replace trigger moves a `sending` row to `replaced`) stays `replaced`, whatever the attempt returned.
import { sql } from "@/lib/db";
import { checkSendable, type DeliverResult } from "@/lib/email";
import { log } from "@/server/logger";
import { INVALID_IDEMPOTENT_REQUEST, classifyResult, nextAttemptAt, type Verdict } from "./classify";
import { LEASE_MS, idempotencyKey, type OutboxKind } from "./constants";
import { afterEndedBadly, type EndedRow } from "./hooks";
import { openBody } from "./seal";
import { deliver } from "./transport";

export type AttemptOutcome = "sent" | "retrying" | "dead" | "suppressed" | "expired" | "deferred";

/** The columns an attempt needs, as the database returns them (a claim statement's RETURNING list). */
export type ClaimedRecord = {
  id: string;
  kind: OutboxKind;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  meta: Record<string, string>;
  recipient: string;
  subject: string;
  body_sealed: Uint8Array | null;
  transactional: boolean;
  attempts: number;
  expires_at: Date;
  lease_until: Date;
};

/** A row as claimed: already `sending`, `attempts` already counting THIS attempt, a lease running. Built by whoever
 *  claims (dispatchNow here, the worker in Task 4) and consumed by `attemptClaimed`. */
export type ClaimedRow = {
  id: string;
  kind: OutboxKind;
  refType: string;
  refId: string;
  orgId: string | null;
  meta: Record<string, string>;
  recipient: string;
  subject: string;
  bodySealed: Uint8Array | null;
  transactional: boolean;
  attempts: number;
  expiresAt: Date;
  leaseUntil: Date;
};

export function toClaimedRow(r: ClaimedRecord): ClaimedRow {
  return {
    id: r.id,
    kind: r.kind,
    refType: r.ref_type,
    refId: r.ref_id,
    orgId: r.org_id,
    meta: r.meta,
    recipient: r.recipient,
    subject: r.subject,
    bodySealed: r.body_sealed,
    transactional: r.transactional,
    attempts: r.attempts,
    expiresAt: r.expires_at,
    leaseUntil: r.lease_until,
  };
}

/** The row a kind hook is given when an attempt ended the row badly; null for any other outcome. (A row that expired
 *  was ended by an UPDATE, not an attempt, so its caller builds that EndedRow from the statement's RETURNING.) */
export function endedRowFor(row: ClaimedRow, outcome: AttemptOutcome): EndedRow | null {
  if (outcome !== "dead" && outcome !== "suppressed") return null;
  return { id: row.id, kind: row.kind, refType: row.refType, refId: row.refId, status: outcome, meta: row.meta };
}

// ---------------------------------------------------------------------------
// last_error: the status and Resend's error NAME, or the network cause. Never the provider's free text, never a body.
// ---------------------------------------------------------------------------

const LAST_ERROR_MAX = 200;

/** Printable ASCII only: a name or cause that carries a newline or a control character cannot forge a log line. */
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?");
const clamp = (s: string): string => s.slice(0, LAST_ERROR_MAX);

function lastErrorOf(r: DeliverResult): string | null {
  if (r.ok) return null;
  if (r.reason === "http") {
    const name = r.errorName ? r.errorName.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 80) : "unknown";
    return clamp(`http ${r.status} ${name}`);
  }
  return clamp(`network ${printable(r.detail)}`);
}

// ---------------------------------------------------------------------------
// The post-attempt writes. Each is conditional on the row still being ours (`sending`) and answers whether it was.
// ---------------------------------------------------------------------------

async function markSent(row: ClaimedRow, providerId: string | null): Promise<boolean> {
  const done = await sql`
    update email_outbox
       set status = 'sent', provider_id = ${providerId}, sent_at = now(), body_sealed = null, lease_until = null,
           status_at = now()
     where id = ${row.id} and status = 'sending'
    returning id`;
  return done.length > 0;
}

async function markRetry(row: ClaimedRow, next: Date, lastError: string | null): Promise<boolean> {
  const done = await sql`
    update email_outbox
       set status = 'queued', next_attempt_at = ${next}, lease_until = null, last_error = ${lastError},
           status_at = now()
     where id = ${row.id} and status = 'sending'
    returning id`;
  return done.length > 0;
}

/** `dead` and `suppressed`: terminal, so the body and the lease go with the status (the V469 CHECKs insist). */
async function markEnded(row: ClaimedRow, status: "dead" | "suppressed", lastError: string | null): Promise<boolean> {
  const done = await sql`
    update email_outbox
       set status = ${status}, body_sealed = null, lease_until = null, last_error = ${lastError}, status_at = now()
     where id = ${row.id} and status = 'sending'
    returning id`;
  return done.length > 0;
}

// ---------------------------------------------------------------------------
// attemptClaimed
// ---------------------------------------------------------------------------

export type AttemptResult = { outcome: AttemptOutcome; verdict: Verdict | null; rateLimited: boolean };

/**
 * Attempt one claimed row once and record the result. Never throws on a send failure (those are results); a database
 * failure on the recording write propagates, and the row is left `sending` with its lease for the worker to reclaim.
 * `outcome` is `deferred` when the row was no longer ours by the time the write ran (replaced mid-flight).
 */
export async function attemptClaimed(row: ClaimedRow): Promise<AttemptResult> {
  // R5/R8: the gate first. The body stays sealed until the gate says yes.
  const gate = await checkSendable({ to: row.recipient, subject: row.subject, transactional: row.transactional });
  if (!gate.ok) {
    const verdict = classifyResult(gate); // "dead" (no key) or "suppressed"
    const status = verdict === "suppressed" ? "suppressed" : "dead";
    const applied = await markEnded(row, status, gate.reason);
    return { outcome: applied ? status : "deferred", verdict, rateLimited: false };
  }

  if (row.bodySealed === null) {
    const applied = await markEnded(row, "dead", "body_missing");
    return { outcome: applied ? "dead" : "deferred", verdict: null, rateLimited: false };
  }
  let body: { html: string; text: string };
  try {
    body = openBody(row.bodySealed);
  } catch {
    // A rotated KEK or a damaged byte. Dead, not retried: it would fail the same way every time (Review Focus 4).
    const applied = await markEnded(row, "dead", "body_unreadable");
    return { outcome: applied ? "dead" : "deferred", verdict: null, rateLimited: false };
  }

  let result: DeliverResult;
  try {
    result = await deliver(
      {
        to: row.recipient,
        subject: row.subject,
        html: body.html,
        text: body.text,
        transactional: row.transactional,
        idempotencyKey: idempotencyKey(row.id),
        tags: { outbox: row.id },
      },
      gate.apiKey,
    );
  } catch {
    // The transport should not throw; if it does, the request may or may not have left. Retry under the same key. The
    // thrown text is dropped: it is not ours to persist.
    result = { ok: false, reason: "network", detail: "transport_threw" };
  }

  const verdict = classifyResult(result);
  const rateLimited = !result.ok && result.reason === "http" && result.status === 429;
  if (!result.ok && result.reason === "http" && result.errorName === INVALID_IDEMPOTENT_REQUEST) {
    // Same key, different payload: a bug in how the key is built, not a transient fault. Ids only.
    log.error(
      { outboxId: row.id, kind: row.kind, status: result.status, errorName: result.errorName },
      "email outbox: Resend refused the idempotency key (same key, different payload); the row is dead",
    );
  }

  const lastError = lastErrorOf(result);
  switch (verdict) {
    case "sent": {
      const applied = await markSent(row, result.ok ? result.providerId : null);
      return { outcome: applied ? "sent" : "deferred", verdict, rateLimited: false }; // a 2xx is not a 429
    }
    case "retry": {
      const next = nextAttemptAt(row.attempts, new Date());
      if (next === null) {
        // Every attempt is spent. The last error stays on the row as the reason.
        const applied = await markEnded(row, "dead", lastError);
        return { outcome: applied ? "dead" : "deferred", verdict, rateLimited };
      }
      const applied = await markRetry(row, next, lastError);
      return { outcome: applied ? "retrying" : "deferred", verdict, rateLimited };
    }
    case "dead":
    case "suppressed": {
      const applied = await markEnded(row, verdict, lastError);
      return { outcome: applied ? verdict : "deferred", verdict, rateLimited };
    }
  }
}

// ---------------------------------------------------------------------------
// dispatchNow
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An injected clock more than this far behind real time is a caller bug (see effectiveNow). */
const STALE_CLOCK_TOLERANCE_MS = 60_000;

/**
 * The time a row's expiry is judged against. Production judges expiry on the REAL current time; `injected` is the test
 * clock seam only (the same `deps.now` openRound and resendExternalPlayNotice take; chess suites open rounds on clocks
 * 30 minutes in the past, and judging them on real time there would expire every invite they write). So in production
 * the injected time can only move the clock forward, which expires a row early, the safe direction; a stale one can
 * never make a send late. Passing a clock more than 60 s behind is logged once.
 */
function effectiveNow(injected: Date | undefined): Date {
  const real = new Date();
  if (injected === undefined) return real;
  if (process.env.NODE_ENV !== "production") return injected;
  const behindMs = real.getTime() - injected.getTime();
  if (behindMs > STALE_CLOCK_TOLERANCE_MS) {
    log.error(
      { behindMs },
      "email outbox: dispatchNow was given a clock more than 60 s behind real time; production judges expiry on real time",
    );
  }
  return injected.getTime() > real.getTime() ? injected : real;
}

const errFields = (err: unknown): { errName: string; errCode?: unknown; errMessage: string } => ({
  errName: err instanceof Error ? err.name : typeof err,
  errCode: (err as { code?: unknown } | null)?.code,
  errMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200),
});

type ExpiredRecord = { id: string; kind: OutboxKind; ref_type: string; ref_id: string; meta: Record<string, string> };

/**
 * Attempt the first send of each id, in order, and say what happened to each. Call it AFTER the caller's transaction
 * has committed (never inside `withTenant`: it uses the pooled client). It does not throw: the rows are durable, so a
 * failure here defers them to the worker rather than failing a request that already committed.
 *
 *  - ids that are `queued` and already past `expires_at` become `expired` (body nulled). That one statement is the only
 *    expiry guard: the claim below does not repeat it (a second copy could never fire, so nothing could test it);
 *  - the rest are claimed one at a time (`queued`, `attempts = 0`) and attempted, in the order given; a repeated id finds
 *    its first outcome already recorded and is skipped;
 *  - after the first 429 the remaining ids are not claimed at all (still `queued`, attempts 0, outcome `deferred`);
 *  - the kind hooks run once at the end, for every row that ended badly in this call.
 */
export async function dispatchNow(ids: readonly string[], opts: { now?: Date } = {}): Promise<Map<string, AttemptOutcome>> {
  const outcomes = new Map<string, AttemptOutcome>();

  // A malformed id is answered without touching the database; an empty (or all-malformed) call issues no statement.
  const valid: string[] = [];
  let malformed = 0;
  for (const id of ids) {
    if (UUID.test(id)) valid.push(id);
    else {
      outcomes.set(id, "deferred");
      malformed++;
    }
  }
  if (malformed > 0) log.error({ malformed }, "email outbox: dispatchNow ignored ids that are not uuids");

  const ended: EndedRow[] = [];
  try {
    const now = effectiveNow(opts.now);

    if (valid.length > 0) {
      const expired = await sql<ExpiredRecord[]>`
        update email_outbox
           set status = 'expired', body_sealed = null, lease_until = null, status_at = now()
         where id = any(${valid}::uuid[]) and status = 'queued' and expires_at <= ${now}
        returning id, kind, ref_type, ref_id, meta`;
      for (const r of expired) {
        outcomes.set(r.id, "expired");
        ended.push({ id: r.id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, status: "expired", meta: r.meta });
      }
    }

    let rateLimited = false;
    for (const id of valid) {
      if (outcomes.has(id)) continue;
      if (rateLimited) {
        outcomes.set(id, "deferred");
        continue;
      }
      const [rec] = await sql<ClaimedRecord[]>`
        update email_outbox
           set status = 'sending', attempts = attempts + 1, lease_until = now() + make_interval(secs => ${LEASE_MS / 1000}),
               status_at = now()
         where id = ${id} and status = 'queued' and attempts = 0
        returning id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional,
                  attempts, expires_at, lease_until`;
      if (!rec) {
        outcomes.set(id, "deferred");
        continue;
      }
      const claimed = toClaimedRow(rec);
      try {
        const res = await attemptClaimed(claimed);
        outcomes.set(id, res.outcome);
        const endedRow = endedRowFor(claimed, res.outcome);
        if (endedRow) ended.push(endedRow);
        if (res.rateLimited) rateLimited = true;
      } catch (err) {
        // The send may have happened; the row is left `sending` with its lease and the worker reclaims it when the
        // lease lapses (under the same idempotency key, so at most one email).
        log.error({ outboxId: id, ...errFields(err) }, "email outbox: recording an attempt failed; the worker will reclaim the row");
        outcomes.set(id, "deferred");
      }
    }
  } catch (err) {
    log.error({ ...errFields(err) }, "email outbox: dispatchNow failed; its rows stay queued for the worker");
    for (const id of valid) if (!outcomes.has(id)) outcomes.set(id, "deferred");
  }

  await afterEndedBadly(ended);
  return outcomes;
}
