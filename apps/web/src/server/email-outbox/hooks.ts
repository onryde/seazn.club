// Per-kind reactions to a row that ended badly (spec "The two kinds": the chess invite releases its seat stamp once
// every row for the stamp has ended badly). A lookup table, not an if-chain, so the core never names a kind.
//
// Ruling R1: this module imports no usecase. A kind's hook lives in a LEAF module (it imports no usecase that imports
// the outbox) and is registered in KIND_HOOKS below; Task 7 registers the chess hook. no-import-cycle.test.ts fails on
// an import path from the core back to the core.
import { log } from "@/server/logger";
import { ENDED_BADLY_STATUSES, type OutboxKind, type OutboxStatus } from "./constants";

/** What a hook is told about the row that ended: ids and the non-secret `meta`; never a body, never a recipient. */
export type EndedRow = {
  id: string;
  kind: OutboxKind;
  refType: string;
  refId: string;
  status: OutboxStatus;
  meta: Record<string, string>;
};

export type KindHook = { onEndedBadly?: (row: EndedRow) => Promise<void> };

/** One entry per kind (the type makes a third kind a compile error here). Both are empty until a kind needs a hook. */
export const KIND_HOOKS: Record<OutboxKind, KindHook> = {
  magic_link: {},
  chess_invite: {},
};

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
