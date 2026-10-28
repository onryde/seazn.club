// W2e (spec 2026-10-28 §5.2; D3 (1), D12, D13; rule X-SE-1) — which sanction levels END a match, and the two readers
// the scoring route and the pad share: what ending is pending on a ledger, and whether a scorer's forfeit is the ending
// of the side's own sanction.
//
// The ending is a RECORDED event, never a new reading of an old sanction (anti-goal 1): a sanction at an end level is
// followed by `core.forfeit{reason:"disqualified"}` against the sanctioned side, appended as its own event. Until it is,
// the write path takes no other event but a forfeit or an abandon (`ENDING_SANCTION_PENDING`, core/events.ts); replay
// stays lenient, so a ledger written before W2e folds as it always did.
//
// A LEAF of core: it imports nothing from events.ts at run time, and events.ts imports `pendingAfter` from here, so the
// fold and the readers below judge "an ending is pending" by one step function.
import type { EntrantId, ForfeitReason } from "./types.ts";

/** A sport's declaration of the sanction levels that end a match (the module's `sanctionEnding`). */
export interface SanctionEndingDecl {
  /** The sport's sanction event type, e.g. "badminton.sanction". Its payload carries `by` (the sanctioned entrant) and
   *  `level`. */
  readonly eventType: string;
  /** A sanction at one of these ends the match (D3 (1)): the next event is its ending, `core.forfeit{disqualified}`. */
  readonly endLevels: readonly string[];
  /** After one of these the pad asks "can <team> still field six?" (D12). Never an automatic ending; "no" is recorded as
   *  `core.forfeit{retired}`. */
  readonly promptLevels: readonly string[];
}

/** An end-level sanction with no ending recorded after it: who was sanctioned, at which level. */
export interface PendingEndingSanction {
  readonly by: EntrantId;
  readonly level: string;
}

/** What the readers need of a ledger row: an `EventEnvelope`, or a stored row, whose `voids` reads null when it voids
 *  nothing. */
export interface SanctionLedgerRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly voids?: string | null;
}

/** The sanctioned side and the level of an event of `decl.eventType`. Its payload carries both by the declaration's own
 *  contract; one that does not is a module bug (the declaration names the wrong event), surfaced as a plain Error so it
 *  pages rather than reading as a refusal a scorer is asked to fix. */
function sanctionFieldsOf(decl: SanctionEndingDecl, payload: unknown): { by: string; level: string } {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as { by?: unknown; level?: unknown };
  if (typeof p.by !== "string" || typeof p.level !== "string") {
    throw new Error(
      `sanctionEnding names "${decl.eventType}", whose payload carries no string \`by\` and \`level\` — the declaration names the wrong event`,
    );
  }
  return { by: p.by, level: p.level };
}

/** The one step of "an ending is pending", shared by the fold and `pendingEndingSanction`: any `core.forfeit` ends what
 *  was pending (the match is decided by it); a sanction at an end level becomes the pending one; anything else leaves it.
 *  A sport that declares no ending never has one pending. */
export function pendingAfter(
  decl: SanctionEndingDecl | undefined,
  pending: PendingEndingSanction | null,
  event: { readonly type: string; readonly payload: unknown },
): PendingEndingSanction | null {
  if (event.type === "core.forfeit") return null;
  if (decl === undefined || event.type !== decl.eventType) return pending;
  const { by, level } = sanctionFieldsOf(decl, event.payload);
  return decl.endLevels.includes(level) ? { by, level } : pending;
}

/**
 * The latest LIVE (not voided) end-level sanction with no `core.forfeit` after it, or null. The pad opens its ending
 * prompt on it (a reload after a failed second append included), and the write path refuses scoring while it is set.
 * Voids resolve as the fold resolves them: a voided event is not there, and a void is not an event of the match.
 */
export function pendingEndingSanction(
  module: { readonly sanctionEnding?: SanctionEndingDecl },
  events: readonly SanctionLedgerRow[],
): PendingEndingSanction | null {
  const voided = new Set<string>();
  for (const e of events) if (e.type === "core.void" && typeof e.voids === "string") voided.add(e.voids);
  let pending: PendingEndingSanction | null = null;
  for (const e of events) {
    if (e.type !== "core.void" && !voided.has(e.id)) pending = pendingAfter(module.sanctionEnding, pending, e);
  }
  return pending;
}

/**
 * D13 — the one exception to "a forfeit is organiser-only": may a SCORER append this forfeit? Only as the ending of the
 * side's own sanction, right after it: the ledger's last live event (`lastLive`) is the sport's sanction against the
 * same side, and the forfeit's reason is the one its level calls for — `disqualified` after an end level, `retired` after
 * a prompt level (D12: the team cannot field six). Every other scorer forfeit stays organiser-only.
 */
export function scorerMayForfeit(
  module: { readonly sanctionEnding?: SanctionEndingDecl },
  lastLive: { readonly type: string; readonly payload: unknown } | null,
  forfeit: { readonly by: string; readonly reason: ForfeitReason },
): boolean {
  const decl = module.sanctionEnding;
  if (decl === undefined || lastLive === null || lastLive.type !== decl.eventType) return false;
  const { by, level } = sanctionFieldsOf(decl, lastLive.payload);
  if (by !== forfeit.by) return false;
  return (
    (forfeit.reason === "disqualified" && decl.endLevels.includes(level)) ||
    (forfeit.reason === "retired" && decl.promptLevels.includes(level))
  );
}
