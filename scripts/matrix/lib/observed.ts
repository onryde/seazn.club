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
