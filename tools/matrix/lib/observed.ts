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
  /** The product flagged this row a knockout's third-place match (W1b Task 10). Absent otherwise. */
  thirdPlace?: boolean;
  /** W1-driving Task 6: the row's ext_key as the product stored it (a later
   *  stage's TBD rows are identified by it). Absent where the source has none. */
  extKey?: string | null;
  /** W1-driving Task 6: the product flagged this row its stage's final. */
  isFinal?: boolean;
}

export interface StandingsRowObs { entrantId: string; rank: number; points: number | null }
/** `message` (W1-driving Task 8, T8-R1): a refused generate's message, as the
 *  RefusedCall carries it (redacted) — the evidence a 5xx's cause is read
 *  from. Absent on an answered generate (and on the model's). */
export interface GenerateObs { status: number; code: string | null; total: number; created: number; message?: string }
export interface PairRoundObs { roundNo: number; seated: number }
/** `seedProposal` (W1-driving Task 6): the next stage's draft proposal the
 *  /complete minted (usecases/stages.ts progressCompletedStage) — null when
 *  none was (the last stage, a refusal, a seeding failure). Optional so the
 *  model's and the tests' literals that predate it still type. */
export interface CompleteObs { status: number; code: string | null; completed: boolean; finalRanks: string[] | null; seedProposal?: { id: string; status: string } | null }

/** Why a stage's play loop stopped (I-1). Only "drained" — generate answered
 *  and no seated fixture was left open, or the swiss budget was paired
 *  through — is a loop that ran to its end; life-loop-bounded reds every
 *  other exit, and a drained loop that still leaves a fixture open.
 *  "not_reached" (W1-driving Task 6): a later stage the run never got to play
 *  — its source stage did not complete, or the seed advance was refused.
 *  "refused_challenge" (W1-driving Task 7, D8): a ladder whose challenge was
 *  refused, or whose field is too small to hold one — no challenge played is
 *  never "drained".
 *  "stalled_rounds" (W1-driving Task 8, D9): a mexicano whose generate
 *  created nothing before the stage's config.rounds were played — the product
 *  refusing to go on, never "drained" and never `cut_short`.
 *  "short_plan" (W1-driving Task 8, T8-R2): an americano whose Start planned
 *  fewer rounds than the engine's planner lays out for its field and
 *  config.rounds — or none — every planned round decided: a format played
 *  short, never "drained". */
export type LoopExit = "drained" | "cap" | "refused_generate" | "empty_pair_round" | "not_reached" | "refused_challenge" | "stalled_rounds" | "short_plan";

export interface ObservedStage {
  id: string;
  seq: number;
  kind: string;
  config: Record<string, unknown>;
  /** Every entrant added to the division (withdrawn ones included). */
  field: string[];
  /** Where `field` came from: "division" = every entrant of the division (right
   *  for a root stage), "seeded" = the entrants the product placed into THIS
   *  stage (a later stage). I1 refuses to judge a later stage on a
   *  division-wide field (W1a carry 1). */
  fieldSource: "division" | "seeded";
  fixtures: ObservedFixture[];
  standings: { poolId: string | null; rows: StandingsRowObs[] }[];
  generates: GenerateObs[];
  pairRounds: PairRoundObs[];
  complete: CompleteObs | null;
  /** W1-driving Task 6 (PF-6): how this stage's play loop ended; null when it
   *  never ran. Optional: the model (lib/model/state.ts) has no play loop. */
  exit?: LoopExit | null;
  /** W1-driving Task 8: on an americano stage, entrant → its person ids — every
   *  pair entrant its fixtures seat, as entrantMembers answered (two each), and
   *  every division entrant, as the setup read them (one per individual).
   *  Absent on every other kind. */
  persons?: Record<string, readonly string[]>;
  /** W1-driving Task 9 (ruling 45): on a double elim, stepladder or page
   *  playoff, the ext_keys of its terminal finals in engine order (gf before
   *  gf-reset) — the engine generator's own isFinal fixtures for the bracket
   *  the product laid out (scenarios/terminal-finals.ts). An engine-derived
   *  expectation carried as data, like ObservedFixture.declared, so I2 stays
   *  type-only. Absent on every other kind. */
  terminalFinals?: readonly string[];
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

/** `seeding_tie_picked` (W1-driving Task 6): a confirm was refused on a
 *  flagged tie, and the harness took the product's own listed order. */
export type CaseFact = "withdrawn" | "expunged" | "voided" | "cut_short" | "late_entry" | "shared_place_declared" | "seeding_tie_picked";

export interface ObservedRun {
  caseId: string;
  facts: CaseFact[];
  stages: ObservedStage[];
  withdrawal: WithdrawalObs | null;
  configEdit: ConfigEditObs | null;
}

export interface InvariantResult { verdict: Verdict; checked: number; evidence: string[] }

/** The product's fixture statuses minus the live ones: scheduled, in_play, and (W2a, spec §5.4.2) needs_decision — a
 *  bracket match held for the organiser's settle is NOT finished, and is not "pending" either (PENDING_STATUSES below:
 *  the withdrawal cascade skips it, ruling C17). Pinned against the api-v1 fixture-status enum - the list loop F's Task 7
 *  declares once in apps/web/src/lib/fixture-status.ts - by invariants.test.ts, which stays red until that merges. */
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
/** W1-driving Task 7 (false premise 16): the stage kinds whose withdrawal
 *  walkover FORFEITS each pending fixture to the opponent — the withdrawal
 *  module's TABLE_KINDS (withdrawal.ts:37) ∪ BRACKET_WALKOVER_KINDS
 *  (stages.ts:880-884). Every other kind takes the open-format branch
 *  (withdrawal.ts:213-217): pending fixtures are voided, nothing forfeited.
 *  ladder-loop.test.ts holds it equal to the product's two sets, read as text. */
export const FORFEIT_MODEL_KINDS: readonly string[] = Object.freeze(["league", "group", "swiss", "knockout", "double_elim", "stepladder"]);
/** W1-driving Task 7: entrant statuses that have LEFT the field (stages.ts
 *  departedEntrantIds) — off the live ladder, refused as a challenge side. */
export const DEPARTED_STATUSES: readonly string[] = Object.freeze(["withdrawn", "disqualified"]);

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
