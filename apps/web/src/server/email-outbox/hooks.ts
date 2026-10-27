// Per-kind reactions to a row that ended badly (spec "The two kinds": the chess invite releases its seat stamp once
// every row for the stamp has ended badly). A lookup table, not an if-chain, so the core never names a kind.
//
// Ruling R1: this module imports no usecase. A kind's hook lives in a LEAF module (it imports no usecase that imports
// the outbox) and is registered in KIND_HOOKS below; the chess hook is invite-outbox-hook.ts. no-import-cycle.test.ts
// fails on an import path from the core back to the core, and names the leaves this file may import.
import { log } from "@/server/logger";
import { chessInviteEndedBadly, findUnappliedChessEndings } from "@/server/usecases/external-play/invite-outbox-hook";
import { ENDED_BADLY_STATUSES, OUTBOX_KINDS, type OutboxKind, type OutboxStatus } from "./constants";

/** What a hook is told about the row that ended: ids and the non-secret `meta`; never a body, never a recipient. */
export type EndedRow = {
  id: string;
  kind: OutboxKind;
  refType: string;
  refId: string;
  status: OutboxStatus;
  meta: Record<string, string>;
};

export type KindHook = {
  /** React to a row of this kind that ended badly. Idempotent, and it recomputes from the database's state rather than
   *  trusting the row it was handed: it may run twice for one row (a worker that re-drives it, a request that raced one). */
  onEndedBadly?: (row: EndedRow) => Promise<void>;
  /**
   * R9 (M2): the rows of this kind that ended badly whose effect `onEndedBadly` has NOT been applied for, found from the
   * kind's own state (the chess invite: a seat still stamped while every row for it has ended badly), at most `limit`.
   * The hook runs AFTER the terminal write and in the same process, so a process that dies between the two, or a hook
   * that throws, leaves exactly such a row; the worker asks for them on every tick and re-drives their hooks. A kind with
   * no side effect leaves this out. A row that is already applied must NOT be returned (exclude it in the query, before
   * the limit), or the same rows would fill every tick's limit and starve the rest.
   */
  findUnapplied?: (limit: number) => Promise<EndedRow[]>;
};

/** One entry per kind (the type makes a new kind a compile error here). The sign-in link needs no hook; the chess invite
 *  releases its seat stamp once every email for the stamp has ended badly, and the worker re-drives a release that was never
 *  applied (R9). The five registration and refund kinds have no side effect to apply when a mail ends badly (spec §1), and nor
 *  have wave 2's ten money mails, wave 3's eight account and invite mails, wave 4's nine officials, discipline, report and
 *  billing-group mails or wave 5's funnel reminder and sixteen staff alerts: each body renders at enqueue time and nothing waits on
 *  its outcome (phase-4 note). */
export const KIND_HOOKS: Record<OutboxKind, KindHook> = {
  magic_link: {},
  chess_invite: { onEndedBadly: chessInviteEndedBadly, findUnapplied: findUnappliedChessEndings },
  registration_confirmation: {},
  payment_reminder: {},
  registration_promoted: {},
  refund_issued: {},
  solo_signup_assigned: {},
  registration_dispute_alert: {},
  registration_dispute_lost: {},
  sponsor_invoice: {},
  sponsor_receipt: {},
  sponsor_refund: {},
  sponsor_dispute_alert: {},
  sponsor_dispute_won: {},
  sponsor_dispute_lost: {},
  pass_revoked: {},
  trial_ending: {},
  email_verification: {},
  funnel_claim: {},
  email_change_confirmation: {},
  email_change_notice: {},
  account_deletion: {},
  org_invite: {},
  claim_invite: {},
  official_invite: {},
  official_assigned: {},
  official_assignment_changed: {},
  suspension_confirmed: {},
  suspension_served: {},
  match_report_submitted: {},
  group_transfer_offer: {},
  group_transfer_complete: {},
  group_org_removed: {},
  group_org_left: {},
  funnel_reminder: {},
  staff_registration_refund_failed: {},
  staff_credit_pack_grant_failed: {},
  staff_size_pack_grant_failed: {},
  staff_stream_credit_grant_failed: {},
  staff_pass_credit_reversal_incomplete: {},
  staff_pass_rung_mismatch: {},
  staff_pass_unknown_competition: {},
  staff_stream_credit_clawback: {},
  staff_extra_org_reprice_failed: {},
  staff_dispute_alert: {},
  staff_connect_bank_changed: {},
  staff_stuck_events: {},
  staff_stream_pack_price_drift: {},
  staff_ai_run_cost: {},
  staff_earn_grant_volume: {},
  staff_extra_org_allowance: {},
};

/** Does this kind have a hook to run for a row that ended badly? (A kind with none is not "skipped" when a tick runs out of
 *  budget: there was nothing to run.) */
export const hasEndedBadlyHook = (kind: OutboxKind): boolean => KIND_HOOKS[kind]?.onEndedBadly !== undefined;

/**
 * Run each row's kind hook. A hook that throws is logged and never rethrown, and the rows after it still run: the
 * caller is a request that already committed, or a worker that must move on to the next row. A row whose status is not
 * one of ENDED_BADLY_STATUSES is refused (and logged): a hook releases a seat, and a `sent` row must never release one.
 */
export async function afterEndedBadly(rows: readonly EndedRow[]): Promise<void> {
  for (const row of rows) {
    if (!ENDED_BADLY_STATUSES.includes(row.status)) {
      log.error(
        { outboxId: row.id, kind: row.kind, status: row.status },
        "email outbox: afterEndedBadly was given a row that did not end badly; its hook was not run",
      );
      continue;
    }
    const hook = KIND_HOOKS[row.kind]?.onEndedBadly;
    if (!hook) continue;
    try {
      await hook(row);
    } catch (err) {
      log.error(
        { outboxId: row.id, kind: row.kind, status: row.status, errName: errName(err) },
        "email outbox: a kind hook threw; the row's other hooks and the rest of the batch still ran",
      );
    }
  }
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * Ask every kind for the badly-ended rows whose effect was never applied (see KindHook.findUnapplied). At most `limit` per
 * kind. A finder that throws is logged (by kind and error name, never its message) and the other kinds are still asked; a
 * row of another kind than its finder's is dropped and logged, because a hook is chosen by the row's kind and one kind's
 * finder must not be able to fire another's. Never throws.
 */
export async function findUnappliedEndings(limit: number): Promise<EndedRow[]> {
  const found: EndedRow[] = [];
  if (!(limit >= 1)) return found;
  for (const kind of OUTBOX_KINDS) {
    const find = KIND_HOOKS[kind]?.findUnapplied;
    if (!find) continue;
    try {
      for (const row of (await find(limit)).slice(0, limit)) {
        if (row.kind !== kind) {
          log.error(
            { outboxId: row.id, kind: row.kind, finderKind: kind },
            "email outbox: a kind's findUnapplied returned a row of another kind; it was dropped",
          );
          continue;
        }
        found.push(row);
      }
    } catch (err) {
      log.error({ kind, errName: errName(err) }, "email outbox: a kind's findUnapplied threw; its badly-ended rows were not re-driven this tick");
    }
  }
  return found;
}
