import "server-only";
// server/usecases/stream-credits.ts — the match-credits ledger (design §5.2).
// One currency, one table, rows only (never UPDATE/DELETE — it is money).
//  * Balance = sum(delta) through creditBalance(); balance_after is a per-row
//    snapshot and the schema's oversell floor, never read as the balance.
//  * THE MONEY LOCK: every writer here (purchase, consume, grant, refund, revoke) takes
//    lockOrg — pg_advisory_xact_lock on a relay-namespaced org key, adminAdjust's idiom
//    (lib/credits.ts) — before it reads anything. An advisory lock, not `select … for
//    update` over the org's rows: row locks lock NOTHING on an empty ledger, so two
//    first-ever writes to an org would read the same balance and write the same snapshot
//    (and a same-key pair IN THAT ORG would both miss the key and 23505). The lock is per
//    ORG and the key index is TABLE-wide, so the lock cannot stop one key racing on two
//    DIFFERENT orgs: both miss the lookup and the second insert still raises 23505 on
//    org_stream_credits_idempotency_key. staffRow answers that 23505 as the 409 it is.
//  * consumeForSession runs INSIDE the transaction that makes the stream live
//    (stream-sessions.ts): the lock, then the 24 h same-fixture reuse rule (skipped
//    when the session has no fixture), then balance < 1 → NoCreditsError.
//  * recordPurchase is replay-safe by the stripe_event_id unique constraint:
//    `on conflict do nothing` and the existing row is returned.
//  * grant/refund/revoke are the /admin panel's rows (Task 7A). Each is ONE row with
//    created_by = the staff user, an idempotency key checked under the lock BEFORE any
//    guard, and ONE staff_audit_log row in the same transaction (lib/credits.ts adminAdjust's
//    shape, which cannot be called here: it is bound to ai_credit_ledger). An EXACT replay
//    writes neither row; the same key with a different org, reason, delta or session is a
//    409 (a deliberate departure from adminAdjust, which answers applied:false to any replay).
//    Refusals are 422, as the donor route's are. admin-addons.ts has no refund neighbour (P9).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { InsufficientCredits, credit, debit, withinReuseWindow } from "@/server/relay/domain/credits";
import { log } from "@/server/logger";
// TYPE-ONLY, as lib/credits.ts does: admin-adjustments-log.ts VALUE-imports
// STREAM_CREDIT_AUDIT_ACTIONS from here, so a value import back would be a runtime cycle.
import type { AdjustmentAction } from "@/server/usecases/admin-adjustments-log";

type Executor = Tx | typeof sql;

export class NoCreditsError extends HttpError {
  constructor(orgId: string) {
    super(402, "This organisation has no match credits", "no_credits", { featureKey: "streaming.relay", orgId });
  }
}

export async function creditBalance(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal from org_stream_credits where org_id = ${orgId}`;
  return Number(row?.bal ?? 0);
}

/** The org's money-lock key — ONE authority for its spelling. Lower-cased (N1): Postgres
 *  returns uuids lower-case, so Task 10's consume and Task 8's purchase pass a lower-case id,
 *  while z.uuid() accepts an upper-case one in a hand-built /admin URL; without this, the two
 *  spellings of one org would take two DIFFERENT locks and a revoke could race a consume.
 *  Namespaced (`stream-credits-org:`) apart from lib/credits.ts's `ai-credit-wallet:` strings.
 *  hashtext is 32-bit, so two different keys CAN hash equal; a collision only serialises two
 *  unrelated writers (a spurious wait), never lets two writers of one org run together. */
export function orgMoneyLockKey(orgId: string): string {
  return `stream-credits-org:${orgId.toLowerCase()}`;
}

/** Serialise every money write to one org, until the transaction ends. Taken FIRST, before
 *  any read, by every writer in this file. Exported for the concurrency tests, which hold it
 *  from a transaction of their own to make writers queue. */
export async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${orgMoneyLockKey(orgId)}))`;
}

export async function consumeForSession(
  tx: Tx,
  args: { orgId: string; fixtureId: string | null; sessionId: string },
  now: Date = new Date(),
): Promise<{ consumed: boolean; balance: number; ledgerId: string | null }> {
  await lockOrg(tx, args.orgId);
  // The 24 h reuse rule is per FIXTURE. A session whose fixture is gone (fixture_id is
  // `on delete set null`) has none to match, so it has no window and consumes; comparing
  // `= null` would say the same thing by accident, and `is not distinct from` would wrongly
  // make every fixture-less session one fixture.
  const [last] = args.fixtureId === null ? [] : await tx<{ created_at: string }[]>`
    select c.created_at from org_stream_credits c
      join fixture_stream_sessions s on s.id = c.session_id
     where c.org_id = ${args.orgId} and c.reason = 'consume' and s.fixture_id = ${args.fixtureId}
     order by c.created_at desc limit 1`;
  const balance = await creditBalance(tx, args.orgId);
  if (withinReuseWindow(last ? new Date(last.created_at) : null, now)) {   // the pure 24 h rule (domain/credits.ts)
    log.info({ orgId: args.orgId, fixtureId: args.fixtureId, sid: args.sessionId, reason: "reuse_24h" }, "stream credits: restart within the reuse window, no consume");
    return { consumed: false, balance, ledgerId: null };   // no row written, so no id
  }
  let balanceAfter: number;
  try {
    ({ balanceAfter } = debit(balance));                                   // FS10 in memory, before the row
  } catch (e) {
    if (e instanceof InsufficientCredits) throw new NoCreditsError(args.orgId);
    throw e;
  }
  // `returning id` — Task 10 writes it to fixture_stream_sessions.credit_ledger_id,
  // so the session row points at the exact row that paid for it.
  const [row] = await tx<{ id: string }[]>`
    insert into org_stream_credits (org_id, delta, reason, session_id, balance_after)
    values (${args.orgId}, -1, 'consume', ${args.sessionId}, ${balanceAfter})
    returning id`;
  return { consumed: true, balance: balanceAfter, ledgerId: row!.id };
}

/** Ruling 13 item 6: the purchase row carries its Stripe link — which checkout,
 *  which payment, which pack, how much, in what currency. Ids and amounts only;
 *  never card data (Stripe holds that). */
export interface PurchaseLink {
  checkoutSessionId: string | null; paymentIntentId: string | null;
  /** The pack's Stripe lookup key. The field is named `pack` and NOT given the
   *  `…Key` suffix: the sanitiser's allowlist guard refuses any key matching
   *  /key|secret|pass|token|…/, and an allowlist entry needing a hand-written
   *  exemption is one nobody rereads. The COLUMN is still `pack_key` (C10). */
  pack: string | null;
  amountMinor: number | null; currency: string | null;
}

export async function recordPurchase(args: {
  orgId: string; delta: number; stripeEventId: string; note?: string; link?: PurchaseLink;
}): Promise<{ id: string; applied: boolean; balance: number }> {
  if (!Number.isInteger(args.delta) || args.delta <= 0) throw new HttpError(422, "purchase delta must be a positive integer");
  const link = args.link ?? { checkoutSessionId: null, paymentIntentId: null, pack: null, amountMinor: null, currency: null };
  return sql.begin(async (tx) => {
    await lockOrg(tx, args.orgId);
    const balance = await creditBalance(tx, args.orgId);
    const { balanceAfter } = credit(balance, args.delta);
    const [inserted] = await tx<{ id: string }[]>`
      insert into org_stream_credits (org_id, delta, reason, stripe_event_id, balance_after, note,
                                      stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency)
      values (${args.orgId}, ${args.delta}, 'purchase', ${args.stripeEventId}, ${balanceAfter}, ${args.note ?? null},
              ${link.checkoutSessionId}, ${link.paymentIntentId}, ${link.pack}, ${link.amountMinor}, ${link.currency?.toLowerCase() ?? null})
      on conflict (stripe_event_id) do nothing
      returning id`;
    if (inserted) return { id: inserted.id, applied: true, balance: balanceAfter };
    // The read-back is org-SCOPED, exactly as staffRow's key check is (review C1). stripe_event_id
    // is unique TABLE-wide, so `on conflict do nothing` above swallows the same event id arriving
    // for a SECOND org — and an unscoped read-back would then hand this caller the FIRST org's row:
    // `applied: false` to an org that paid and got nothing, plus an id that would cross-link two
    // orgs through fixture_stream_sessions.credit_ledger_id. The ledger is append-only, so that
    // state can only be compensated, never corrected. A conflict on another org's event is a
    // reused id, not an idempotent replay, and it is refused with nothing written.
    const [existing] = await tx<{ id: string; org_id: string }[]>`
      select id, org_id from org_stream_credits where stripe_event_id = ${args.stripeEventId}`;
    if (existing!.org_id !== args.orgId.toLowerCase()) {
      throw new HttpError(409, "That Stripe event was already recorded against a different organisation; nothing was written", "stripe_event_org_mismatch");
    }
    return { id: existing!.id, applied: false, balance };
  }) as Promise<{ id: string; applied: boolean; balance: number }>;
}

/** The staff_audit_log actions of the three staff writers. Spread into admin-adjustments-log.ts's
 *  ADJUSTMENT_ACTIONS the way `...SUSPENSION_ACTIONS` (:64) and `...DISCOVERY_AUDIT_ACTIONS` (:67)
 *  are — NOT the way PASS_CREDIT_RESOLVE_ACTION (:71) is, which is a bare value, not a spread
 *  (re-pin 2026-09-27, FP-3). An org-targeted action outside that allowlist is audited and
 *  unreadable. Underscored, never dotted — admin-audit-actor-truth.test.ts reads a dotted literal
 *  beside a direct insert as a CUSTOMER self-service action. */
export const STREAM_CREDIT_AUDIT_ACTIONS = ["stream_credit_grant", "stream_credit_refund", "stream_credit_revoke"] as const;

type StaffKind = "grant" | "refund" | "revoke";
const AUDIT_ACTION: Record<StaffKind, AdjustmentAction> = {
  grant: "stream_credit_grant",
  refund: "stream_credit_refund",
  revoke: "stream_credit_revoke",
};

/** The ruled ceiling on ONE staff adjustment (plan §Task 7A Revision 1 item 4: 1-50 per action for
 *  every staff role, with NO exemption). Enforced HERE, at the single writer, and imported by 7A's
 *  route zod so the two cannot drift — the donor's `SUPPORT_CREDIT_CAP` (credits/route.ts) is a
 *  different thing, an RBAC gate a superadmin passes, and an absolute domain bound does not belong
 *  in an RBAC check. A route is not the only possible caller: Tasks 10/11/12 call grantCredits
 *  directly, and a bound only the route holds is a bound the second caller does not have. Same
 *  argument that put V410's `max_duration_minutes <= 300` in the DDL rather than only in a usecase. */
export const STAFF_CREDIT_MAX = 50;

export interface StaffCreditArgs {
  orgId: string;
  /** A positive integer for all three kinds; a revoke writes its negation. */
  delta: number;
  /** The staff user — org_stream_credits.created_by AND staff_audit_log.actor_id. */
  createdBy: string;
  note: string;
  /** One per panel submission, kept across retries (Task 7A). */
  idempotencyKey: string;
}

export interface StaffCreditResult { id: string; balance: number; applied: boolean }

async function staffRow(kind: StaffKind, args: StaffCreditArgs & { sessionId?: string | null }): Promise<StaffCreditResult> {
  // The ruled 1..STAFF_CREDIT_MAX bound, at the single writer (review I4). Written as two
  // comparisons so each end can be mutated on its own rather than covering for the other.
  if (!Number.isInteger(args.delta) || args.delta < 1 || args.delta > STAFF_CREDIT_MAX) {
    throw new HttpError(422, `A ${kind} must move between 1 and ${STAFF_CREDIT_MAX} match credits; got ${args.delta}`, "delta_out_of_range");
  }
  // Lower-cased: Postgres returns uuids lower-case, and z.uuid() accepts upper-case, so an exact
  // replay of a pasted upper-case id must still compare equal below. `orgId` is the NORMALISED
  // spelling, and it is what the audit row's target_id must carry: that column is TEXT (V103), so
  // an upper-case id there writes a row `adjustmentsForOrg` compares as a string and never finds —
  // money moved, no visible trail. org_stream_credits.org_id is `uuid` and normalises itself.
  const orgId = args.orgId.toLowerCase();
  const sessionId = args.sessionId ? args.sessionId.toLowerCase() : null;
  const delta = kind === "revoke" ? -args.delta : args.delta;   // the SIGNED delta the row stores
  return sql.begin(async (tx) => {
    await lockOrg(tx, args.orgId);   // FIRST: the money lock (an empty ledger included)
    const balance = await creditBalance(tx, args.orgId);

    // THE KEY CHECK — under the lock and BEFORE every guard (adminAdjust's order). Looked up
    // TABLE-wide (the V410 index is table-wide, the donor's V320 scope) so the stored row's org
    // is part of the comparison. An EXACT replay returns the original row and writes nothing, not
    // a second ledger row, not a second audit row. The SAME key with a different org, reason,
    // signed delta or session is a staff mistake (an amount retyped after a lost response), so
    // it is refused rather than silently answered `applied: false` (adminAdjust does the latter;
    // this is the recorded departure), and the refusal names nothing about the stored row. The
    // check must precede the refund cap and the revoke floor, because the ORIGINAL call has
    // already used them up — a replay that reached them would read as a 422.
    const [prior] = await tx<{ id: string; org_id: string; reason: string; delta: number; session_id: string | null }[]>`
      select id, org_id, reason, delta, session_id from org_stream_credits where idempotency_key = ${args.idempotencyKey}`;
    if (prior) {
      const same =
        prior.org_id === orgId && prior.reason === kind && prior.delta === delta && prior.session_id === sessionId;
      if (!same) {
        throw new HttpError(409, "That idempotency key was already used for a different adjustment; nothing was written", "idempotency_key_reused");
      }
      return { id: prior.id, balance, applied: false };
    }

    let balanceAfter: number;
    if (kind === "revoke") {
      try {
        ({ balanceAfter } = debit(balance, args.delta));   // FS10 in memory; the balance_after CHECK is the backstop
      } catch (e) {
        if (e instanceof InsufficientCredits) {
          throw new HttpError(422, `Revoking ${args.delta} would take this organisation's match credits (${balance}) below zero`, "insufficient_credits");
        }
        throw e;
      }
    } else {
      if (kind === "refund" && sessionId) {
        // A linked refund returns what THAT session consumed, at most, across every refund linked to it.
        // LOCK ORDER (N2): the insert below takes FOR KEY SHARE on this fixture_stream_sessions row
        // (the session_id FK) AFTER the org lock, while Task 10's live transition holds that row FOR
        // UPDATE BEFORE consumeForSession takes the org lock — the opposite order. It cannot deadlock
        // only because a credit is consumed ONCE, at warming → live, so a session inside that
        // transaction has no committed consume row, and THIS cap refuses its refund BEFORE the insert.
        // Keep the cap ahead of the insert, and keep consume a one-shot, or this becomes a 40P01.
        const [s] = await tx<{ consumed: number; refunded: number }[]>`
          select coalesce(-sum(delta) filter (where reason = 'consume'), 0)::int as consumed,
                 coalesce(sum(delta) filter (where reason = 'refund'), 0)::int as refunded
            from org_stream_credits where org_id = ${args.orgId} and session_id = ${sessionId}`;
        if (s!.refunded + args.delta > s!.consumed) {
          throw new HttpError(422, `That session consumed ${s!.consumed} and has ${s!.refunded} refunded already; refund it unlinked if more is owed`, "refund_exceeds_consumed");
        }
      }
      ({ balanceAfter } = credit(balance, args.delta));
    }

    const [row] = await tx<{ id: string }[]>`
      insert into org_stream_credits (org_id, delta, reason, session_id, balance_after, note, created_by, idempotency_key)
      values (${args.orgId}, ${delta}, ${kind}, ${sessionId}, ${balanceAfter}, ${args.note}, ${args.createdBy}, ${args.idempotencyKey})
      returning id`;
    // The unified staff audit, IN this transaction — adminAdjust's auditApplied statement
    // (lib/credits.ts): target 'org', balance_after in the detail, and `reason` = the note
    // (the key adjustmentsForOrg renders as the log's subject). Applied writes only.
    await tx`
      insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
      values (${args.createdBy}, ${AUDIT_ACTION[kind]}, 'org', ${orgId},
              ${tx.json({ delta, reason: args.note, session_id: sessionId, ledger_id: row!.id, balance_after: balanceAfter } as never)})`;
    return { id: row!.id, balance: balanceAfter, applied: true };
  }).catch((err: unknown) => {
    // N3: one key on two DIFFERENT orgs at once holds two different money locks, so both writers
    // miss the lookup and the second insert raises 23505 on the TABLE-wide key index. That is a
    // reused key, not a server error. Caught OUTSIDE sql.begin: postgres.js rethrows a query
    // error even when the transaction callback catches it. The constraint-name check is
    // registration-submit.ts's idiom; any other 23505 stays an error.
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "org_stream_credits_idempotency_key") {
      throw new HttpError(409, "That idempotency key was already used for a different adjustment; nothing was written", "idempotency_key_reused");
    }
    throw err;
  }) as Promise<StaffCreditResult>;
}

export async function grantCredits(args: StaffCreditArgs): Promise<StaffCreditResult> {
  return staffRow("grant", args);
}

export async function refundCredits(args: StaffCreditArgs & { sessionId: string | null }): Promise<StaffCreditResult> {
  return staffRow("refund", args);
}

export async function revokeCredits(args: StaffCreditArgs): Promise<StaffCreditResult> {
  return staffRow("revoke", args);
}
