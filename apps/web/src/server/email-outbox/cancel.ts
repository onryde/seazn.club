import "server-only";
// The void (spec §7): ending a tenant's own QUEUED emails because the thing they were about is gone - a round unpaired, a board
// settled by a walkover, a fixture deleted - or a person's own account mail that a newer request has superseded (an email change's
// older confirmation, on the pooled handle). `app_user` holds INSERT only (V470), so the way in is the SECURITY DEFINER function
// `email_outbox_cancel` (V472), which this module calls and whose rows it maps to `EndedRow`s.
//
// A LEAF of the core on purpose: no runtime import at all (the db handle and the row type are types). It must not import a usecase
// (no-import-cycle.test.ts claim 1), so it knows nothing about what a "seat" is. The caller, which does, builds the refs
// (`chessSeatRef`) and says WHICH reason: see `usecases/external-play/cancel-invites.ts`, the one place that builds a board's seat refs.
//
// What the row looks like afterwards: `expired`, `last_error` = the reason, no body, no lease, and no once-key (a cancelled email is
// dead for good, so the same key can be queued again). Only a `queued` row is ended: a `sending` row may be on the wire, a `sent`
// one was mailed. `status.ts`'s `current()` reads `CANCELLED_REASONS` to tell such a row from an `expired` one the worker aged out.
import type { Tx } from "@/lib/db";
import type { OutboxKind } from "./constants";
import type { EndedRow } from "./hooks";

/** An Unpair ended the round's invites (the seats they were about are cleared, and the bridge rows go with them). */
export const ROUND_VOIDED_REASON = "round_voided";
/** A walkover or a void settled the board: no game will be played there, so the invite is moot. */
export const BOARD_SETTLED_REASON = "board_settled";
/** The board's fixture was deleted (a stage rebuilt or deleted, an undone generation, a competition deleted). */
export const FIXTURE_DELETED_REASON = "fixture_deleted";
/** A newer email-change request ended the user's older queued confirmation: its token is gone, and the address it would reach is one
 *  the person has moved on from (phase-3 spec §5). Org-less account mail, so the change request cancels on the pooled handle. */
export const EMAIL_CHANGE_SUPERSEDED_REASON = "email_change_superseded";

/**
 * Every reason a cancel may write. `status.ts` reads an `expired` row with one of these in `last_error` as "voided, not delivered":
 * the reason is the only thing that tells it from a row the worker aged out. `cancelQueuedEmails` refuses a reason that is not here,
 * so a typo cannot write a voided row the readers would take for a failed send. A new reason is added here AND is a snake_case word
 * (`email_outbox_cancel` refuses anything else).
 */
export const CANCELLED_REASONS: readonly string[] = [
  ROUND_VOIDED_REASON,
  BOARD_SETTLED_REASON,
  FIXTURE_DELETED_REASON,
  EMAIL_CHANGE_SUPERSEDED_REASON,
];

type CancelledRecord = {
  outbox_id: string;
  outbox_kind: OutboxKind;
  outbox_ref_type: string;
  outbox_ref_id: string;
  outbox_meta: Record<string, string> | null;
};

/**
 * End every `queued` email of this kind, ref type and these refs, with `reason`, on the caller's transaction. Returns the rows it
 * ended (a row already `sending`, `sent` or ended is not among them, so a second call returns `[]`). Empty `refIds` returns `[]` and
 * issues no statement.
 *
 * ORGANISATION FENCE (G-7). The function fences on `current_org_id()` itself, because it runs as its definer and bypasses RLS. So
 * the handle decides whose rows match: a `withTenant` transaction (the callers in the stages, withdrawal, history and competition
 * usecases) ends THAT organisation's rows, and only those. Called on the POOLED client (no tenant, `current_org_id()` is null) it
 * matches only the rows that have NO organisation - the sign-in link's shape - and silently ends nothing of any organisation's.
 *
 * It does not run the kind's hook. The caller's transaction has not committed, and a hook opens its own connection; the rows come
 * back so a caller that wants the hook runs `afterEndedBadly` after its commit. A seat whose rows were cancelled and whose
 * bridge row survives is released by the worker's re-drive (`findUnappliedChessEndings`).
 */
export async function cancelQueuedEmails(
  tx: Tx,
  a: { kind: OutboxKind; refType: string; refIds: readonly string[]; reason: string },
): Promise<EndedRow[]> {
  if (!CANCELLED_REASONS.includes(a.reason)) {
    // An assumption as a guard: the readers (`status.ts` `current()`) know only these words.
    throw new Error(`email outbox: "${a.reason}" is not a cancel reason; the readers could not tell the row from a failed send`);
  }
  if (a.refIds.length === 0) return [];
  const rows = await tx<CancelledRecord[]>`
    select * from email_outbox_cancel(${a.kind}, ${a.refType}, ${a.refIds as string[]}::text[], ${a.reason})`;
  return rows.map((r) => ({
    id: r.outbox_id,
    kind: r.outbox_kind,
    refType: r.outbox_ref_type,
    refId: r.outbox_ref_id,
    status: "expired" as const,
    meta: r.outbox_meta ?? {},
  }));
}
