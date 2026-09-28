// What a case OBSERVED, as plain data plus pure helpers. Type imports only,
// with one exception the boundary test allows: invariants.ts value-imports
// these helpers (PF7). W1b's fast-check model and W10's production shadow
// checks build these shapes from their own sources and reuse invariants.ts
// unchanged, so nothing here may reach the engine, HTTP, the bench or node.
import type { Verdict } from "./results.ts";

export type { CheckResult, Verdict } from "./results.ts";

export type ObservedOutcome =
  | { kind: "win" | "award"; winner: string; method?: string }
  | { kind: "draw" | "tie" | "no_result" };

export interface ObservedDeclared { home: number; away: number; forOutcome: ObservedOutcome }

export interface ObservedFixture {
  id: string;
  stageId: string;
  poolId: string | null;
  roundNo: number | null;
  home: string | null;
  away: string | null;
  status: string;
  outcome: ObservedOutcome | null;
  /** Σ-points the sport declares for the stream the HARNESS posted; null when the harness did not post it. */
  declared: ObservedDeclared | null;
}

export interface StandingsRowObs { entrantId: string; rank: number; points: number | null }
export interface GenerateObs { status: number; code: string | null; total: number; created: number }
export interface PairRoundObs { roundNo: number; seated: number }
export interface CompleteObs { status: number; code: string | null; completed: boolean; finalRanks: string[] | null }

export interface ObservedStage {
  id: string;
  seq: number;
  kind: string;
  config: Record<string, unknown>;
  /** Every entrant added to the division (withdrawn ones included). */
  field: string[];
  fixtures: ObservedFixture[];
  standings: { poolId: string | null; rows: StandingsRowObs[] }[];
  generates: GenerateObs[];
  pairRounds: PairRoundObs[];
  complete: CompleteObs | null;
}

export interface FixtureSnap { id: string; status: string; outcome: ObservedOutcome | null }

export interface WithdrawalObs {
  entrantId: string;
  afterRound: number;
  policy: "none" | "walkover" | "expunge";
  walkovers: number;
  voided: number;
  skippedFinalized: number;
  /** The withdrawn entrant's fixtures as they stood immediately before the call. */
  before: FixtureSnap[];
}

export interface ConfigEditObs {
  attempts: { kind: "format" | "entrants_only"; status: number; code: string | null }[];
  before: FixtureSnap[];
  after: FixtureSnap[];
}

export type CaseFact = "withdrawn" | "expunged" | "voided" | "cut_short" | "late_entry" | "shared_place_declared";

export interface ObservedRun {
  caseId: string;
  facts: CaseFact[];
  stages: ObservedStage[];
  withdrawal: WithdrawalObs | null;
  configEdit: ConfigEditObs | null;
}

export interface InvariantResult { verdict: Verdict; checked: number; evidence: string[] }

/** The product's fixture statuses minus the two live ones (scheduled, in_play).
 *  Pinned against the api-v1 fixture-status enum by invariants.test.ts. */
export const TERMINAL_STATUSES: readonly string[] = Object.freeze(["decided", "finalized", "forfeited", "abandoned", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The generic codes api-v1's `statusCode()` stamps on an error that carried
 *  no code of its own (apps/web/src/server/api-v1/http.ts). Pinned against that
 *  function's text by invariants.test.ts. */
export const GENERIC_ERROR_CODES: readonly string[] = Object.freeze([
  "VALIDATION", "UNAUTHENTICATED", "PAYMENT_REQUIRED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "RATE_LIMITED", "INTERNAL", "ERROR",
]);

/** A refusal NAMES its reason: a 4xx carrying a domain code (FORMAT_LOCKED,
 *  STAGE_NOT_READY, …), not a generic one. Every api-v1 error carries SOME
 *  code, so "has a code" proves nothing. A 5xx is a crash whatever it carries:
 *  api-v1 answers any unhandled throw with 500 "INTERNAL", and maps a few
 *  engine codes to 500 too. */
export function isNamedRefusal(status: number, code: string | null): boolean {
  return status >= 400 && status < 500 && code !== null && !GENERIC_ERROR_CODES.includes(code);
}

export function twoSided(f: ObservedFixture): boolean {
  return f.home !== null && f.away !== null;
}

export function toObservedOutcome(raw: unknown): ObservedOutcome | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as { kind?: unknown; winner?: unknown; method?: unknown };
  if ((o.kind === "win" || o.kind === "award") && typeof o.winner === "string") {
    return typeof o.method === "string" ? { kind: o.kind, winner: o.winner, method: o.method } : { kind: o.kind, winner: o.winner };
  }
  if (o.kind === "draw" || o.kind === "tie" || o.kind === "no_result") return { kind: o.kind };
  return null;
}

export function winnerOf(o: ObservedOutcome | null): string | null {
  return o !== null && (o.kind === "win" || o.kind === "award") ? o.winner : null;
}

/** Same kind and same winner; the method is ignored. */
export function sameOutcome(a: ObservedOutcome | null, b: ObservedOutcome | null): boolean {
  return (a?.kind ?? null) === (b?.kind ?? null) && winnerOf(a) === winnerOf(b);
}

export function sameResult(
  a: { status: string; outcome: ObservedOutcome | null },
  b: { status: string; outcome: ObservedOutcome | null },
): boolean {
  return a.status === b.status && sameOutcome(a.outcome, b.outcome);
}

export function snap(f: ObservedFixture): FixtureSnap {
  return { id: f.id, status: f.status, outcome: f.outcome };
}

/** Pending, in the product's reading (lib/table-withdrawal.ts). */
export const PENDING_STATUSES: readonly string[] = Object.freeze(["scheduled", "in_play"]);
/** Locked: the cascade reports these and never touches them (withdrawal.ts:102). */
export const LOCKED_STATUSES: readonly string[] = Object.freeze(["finalized", "cancelled"]);

/** A bye is the engine's only legitimate one-sided finished shape: a
 *  forfeited AWARD to the seated side (competition/stage.ts:30-34). */
export function isBye(f: ObservedFixture): boolean {
  return !twoSided(f) && (f.home !== null || f.away !== null) && f.status === "forfeited" && f.outcome?.kind === "award" && f.outcome.winner === (f.home ?? f.away);
}

/** What the RECORDED withdrawal cascade itself wrote (final review I-1): a
 *  fixture of the withdrawn entrant that the cascade could touch — pending
 *  under walkover, unlocked under expunge, read off the snapshot taken just
 *  before the call — and that now carries a status that policy writes (a
 *  walkover forfeit or the void of a TBD opponent; an expunge's abandon).
 *  Whether it wrote the RIGHT thing is r4-cascade-consistent's question. */
export function cascadeWrote(f: ObservedFixture, w: WithdrawalObs | null): boolean {
  if (w === null || (f.home !== w.entrantId && f.away !== w.entrantId)) return false;
  const before = w.before.find((b) => b.id === f.id);
  if (before === undefined) return false;
  if (w.policy === "walkover") return PENDING_STATUSES.includes(before.status) && (f.status === "abandoned" || f.status === "forfeited");
  return w.policy === "expunge" && !LOCKED_STATUSES.includes(before.status) && f.status === "abandoned";
}
