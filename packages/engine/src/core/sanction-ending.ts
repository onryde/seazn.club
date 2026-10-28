// W2e (spec 2026-10-28 §5.2; D3 (1), D12, D13; rule X-SE-1) — which sanction levels END a match, and the readers the
// scoring route and the pad share with the fold: what ending is pending on a ledger, the ledger's last live event, and
// whether a scorer's forfeit is the ending of the side's own sanction.
//
// The ending is a RECORDED event, never a new reading of an old sanction (anti-goal 1): a sanction at an end level is
// followed by `core.forfeit{reason:"disqualified"}` against the sanctioned side, appended as its own event. Until it is,
// the write path takes no other event but a forfeit or an abandon (`ENDING_SANCTION_PENDING`, core/events.ts); replay
// stays lenient, so a ledger written before W2e folds as it always did.
//
// ONE definition of "an ending is pending" (review I-1): the latest live end-level sanction (`latestEndingSanction`, one
// step at a time) while the match is neither decided nor abandoned (`endingPending`). The fold calls both as it walks;
// `pendingEndingSanction` runs the same two over a whole ledger. A LEAF of core: it imports nothing from events.ts at run
// time, so events.ts can import it without a cycle.
import type { EntrantId, ForfeitReason, MatchOutcome } from "./types.ts";

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

/** The two facts about the match that lift a pending ending: it is decided (by its result, a forfeit or a settle), or an
 *  abandon is active. The fold knows both as it walks; any other caller derives them with `matchEndFacts`. */
export interface MatchEndFacts {
  readonly decided: boolean;
  readonly abandonActive: boolean;
}

/**
 * What is wrong with a declaration, one sentence per fault; [] when it holds (review M-1). Each of Tasks 3 and 4 runs it
 * over the module it declares. A declaration must name its sanction event, name at least one level (one that names none
 * declares nothing), never name a level twice, and never name a level in both lists: an end level and a prompt level
 * call for different endings (`scorerMayForfeit`), so a level in both would admit either.
 */
export function sanctionEndingIssues(decl: SanctionEndingDecl): string[] {
  const issues: string[] = [];
  if (decl.eventType === "") issues.push("eventType is empty: the declaration names no sanction event");
  if (decl.endLevels.length + decl.promptLevels.length === 0) issues.push("endLevels and promptLevels are both empty: the declaration names no level");
  for (const [list, levels] of [["endLevels", decl.endLevels], ["promptLevels", decl.promptLevels]] as const) {
    if (levels.includes("")) issues.push(`${list} names an empty level`);
    if (new Set(levels).size !== levels.length) issues.push(`${list} names a level twice`);
  }
  const both = decl.endLevels.filter((level) => decl.promptLevels.includes(level));
  if (both.length > 0) issues.push(`${both.join(", ")} is both an end level and a prompt level`);
  return issues;
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

/** The one walking step: a sanction at an end level becomes the latest end-level sanction; any other event leaves it.
 *  A sport that declares no ending never has one. Whether it is still PENDING is `endingPending`'s question. */
export function latestEndingSanction(
  decl: SanctionEndingDecl | undefined,
  latest: PendingEndingSanction | null,
  event: { readonly type: string; readonly payload: unknown },
): PendingEndingSanction | null {
  if (decl === undefined || event.type !== decl.eventType) return latest;
  const { by, level } = sanctionFieldsOf(decl, event.payload);
  return decl.endLevels.includes(level) ? { by, level } : latest;
}

/** THE predicate: the latest end-level sanction is pending unless the match is decided (its ending, or any other result,
 *  is recorded) or an abandon is active (the match was stopped; settle it or void the abandon). */
export function endingPending(latest: PendingEndingSanction | null, facts: MatchEndFacts): PendingEndingSanction | null {
  return facts.decided || facts.abandonActive ? null : latest;
}

/** The LIVE rows of a ledger, in order: no `core.void`, and nothing a live void targets. The one void walk of this file
 *  (the fold's own reading, `resolveVoids`, minus its refusals of a malformed void: these readers read accepted ledgers). */
function liveRows(events: readonly SanctionLedgerRow[]): SanctionLedgerRow[] {
  const voided = new Set<string>();
  for (const e of events) if (e.type === "core.void" && typeof e.voids === "string") voided.add(e.voids);
  return events.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}

/** The ledger's last live event, or null for a ledger with none (review M-2): what `scorerMayForfeit` judges a scorer's
 *  forfeit against. After [sanction, forfeit, void(forfeit)] it is the sanction again, so the scorer may re-confirm. */
export function lastLiveEvent(events: readonly SanctionLedgerRow[]): SanctionLedgerRow | null {
  return liveRows(events).at(-1) ?? null;
}

/** `MatchEndFacts` for a caller outside the fold (the route, the pad), from the folded result and the ledger it folded:
 *  decided exactly as the fold decides (the module's outcome, or a settle), and an abandon active when a live
 *  `core.abandon` is in the ledger. */
export function matchEndFacts<State>(
  module: { outcome(state: State): MatchOutcome | null },
  folded: { readonly state: State; readonly settlement: object | null },
  events: readonly SanctionLedgerRow[],
): MatchEndFacts {
  return {
    decided: module.outcome(folded.state) !== null || folded.settlement !== null,
    abandonActive: liveRows(events).some((e) => e.type === "core.abandon"),
  };
}

/**
 * The end-level sanction an ending is pending for, or null: the latest live one (`latestEndingSanction` over the live
 * rows) while `endingPending` holds for `facts`. The pad opens its ending prompt on it (a reload after a failed second
 * append included); the write path refuses scoring while the fold's own reading of it is set.
 */
export function pendingEndingSanction(
  module: { readonly sanctionEnding?: SanctionEndingDecl },
  events: readonly SanctionLedgerRow[],
  facts: MatchEndFacts,
): PendingEndingSanction | null {
  let latest: PendingEndingSanction | null = null;
  for (const e of liveRows(events)) latest = latestEndingSanction(module.sanctionEnding, latest, e);
  return endingPending(latest, facts);
}

/**
 * D13 — the one exception to "a forfeit is organiser-only": may a SCORER append this forfeit? Only as the ending of the
 * side's own sanction, right after it: `lastLive` (the ledger's `lastLiveEvent`) is the sport's sanction against the
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
