// A cricket wicket is voidable only while it is the latest active ball of the match (owner, 2026-11-10;
// docs/specs/2026-11-10-cricket-wicket-void-latest-only.md).
//
// Voiding an OLDER wicket replays the ledger without it: the over boundaries shift, the bowler rules (consecutive
// overs, the per-bowler maximum) are not re-checked on replay, the dismissed batter is no longer out, and the incoming
// batter keeps batting because later balls name him. The card quietly stops being what was played.
//
// One definition for the SERVER (`assertUndoTarget` refuses it, 409 UNDO_WICKET_NOT_LATEST) and the CONSOLE (the row
// shows "Void back to here" instead of Void). Pure: no React, no server import, so the pad bundle's purity gate allows it.

/** The ledger types that carry a delivery and so may carry a `wicket`: the ball, and the super over's twin. */
export const CRICKET_BALL_TYPES: readonly string[] = ["cricket.ball", "cricket.superover.ball"];

/** The fields of a ledger row this module reads — structural, so the console's rows and the pad's both fit. */
export type WicketLedgerRow = {
  readonly id: string;
  readonly type: string;
  readonly seq: number;
  readonly payload: unknown;
  /** Set only when THIS row is a `core.void`: the id of the row it cancels. */
  readonly voids: string | null;
};

export function isCricketBall(type: string): boolean {
  return CRICKET_BALL_TYPES.includes(type);
}

/** A ball that dismisses someone: `payload.wicket` present and not null. */
export function carriesWicket(row: Pick<WicketLedgerRow, "type" | "payload">): boolean {
  if (!isCricketBall(row.type)) return false;
  const wicket = (row.payload as { wicket?: unknown } | null)?.wicket;
  return wicket !== undefined && wicket !== null;
}

/** The rows the fold still applies: not a void, and not named by one. */
function activeRows(all: readonly WicketLedgerRow[]): WicketLedgerRow[] {
  const voided = new Set(all.flatMap((r) => (r.voids === null ? [] : [r.voids])));
  return all.filter((r) => r.type !== "core.void" && !voided.has(r.id));
}

/**
 * Is `row` an ACTIVE cricket wicket with an active ball after it? "Later" is a later ACTIVE ball (any innings, super
 * overs included): a wicket followed only by non-ball entries (a bowler change, a powerplay) is still the latest.
 */
export function isWicketBehindLaterBall(row: WicketLedgerRow, all: readonly WicketLedgerRow[]): boolean {
  if (!carriesWicket(row)) return false;
  const active = activeRows(all);
  if (!active.some((r) => r.id === row.id)) return false;
  return active.some((r) => r.seq > row.seq && isCricketBall(r.type));
}

/**
 * The ids "Void back to here" sends, in order: every active entry newer than `row`, newest first, then `row` itself.
 * Each is then the latest active entry when its turn comes, so the server's rule never blocks the sequence.
 */
export function voidBackIds(row: WicketLedgerRow, all: readonly WicketLedgerRow[]): string[] {
  const newer = activeRows(all)
    .filter((r) => r.seq > row.seq)
    .sort((a, b) => b.seq - a.seq)
    .map((r) => r.id);
  return [...newer, row.id];
}

export type VoidBackStep = (eventId: string, expectedSeq: number) => Promise<{ ok: true } | { ok: false; message: string | null }>;

export type VoidBackResult = { readonly done: number; readonly total: number; readonly refusal: { readonly message: string | null } | null };

/**
 * Run the sequence one void at a time, stopping at the first refusal (a scorer wrote meanwhile, a conflict). `fromSeq` is
 * the ledger's last seq when the operator confirmed; each void lands on the next one.
 */
export async function runVoidBack(ids: readonly string[], fromSeq: number, step: VoidBackStep): Promise<VoidBackResult> {
  let seq = fromSeq;
  for (let done = 0; done < ids.length; done++) {
    const r = await step(ids[done]!, seq);
    if (!r.ok) return { done, total: ids.length, refusal: { message: r.message } };
    seq += 1;
  }
  return { done: ids.length, total: ids.length, refusal: null };
}
