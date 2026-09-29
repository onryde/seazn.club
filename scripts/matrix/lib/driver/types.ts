// The organiser seam (design §6.1). Scenarios and run.ts reach the product only
// through this interface: HttpDriver drives the real v1 API, and Task 8's fake
// driver implements the same surface in memory.
//
// Wire shapes are the api-v1 rows, trimmed to what the harness reads
// (apps/web/src/server/api-v1/schemas.ts: Stage, Entrant, Fixture,
// FixtureState, AppendEventResponse, CompleteResult; usecases/withdrawal.ts
// WithdrawCascadeOut; usecases/public.ts publicStandings).
import type { StagePostBody } from "../catalogue.ts";
import { redact } from "../redact.ts";
import type { StreamEvent } from "../streams/types.ts";

export type EntrantKind = "individual" | "pair" | "team";
export interface CompetitionRef { id: string; slug: string; orgId: string }
export interface DivisionRef { id: string; slug: string; sportKey: string; variantKey: string; config: Record<string, unknown> }
export interface StageRef { id: string; seq: number; kind: string; config: Record<string, unknown>; status: string }
export interface EntrantRow { id: string; display_name: string; seed: number | null; status: string }
/** `third_place` (W1b Task 10, T3 review G1): the product's row flag for a
 *  knockout's third-place match (usecases/fixtures.ts listDivisionFixtures
 *  selects it; the division fixtures route serves it). Optional: the fakes
 *  and older rows omit it, which reads as "not a third-place match". */
export interface FixtureRow { id: string; stage_id: string; pool_id: string | null; round_no: number | null; fixture_no: number | null; home_entrant_id: string | null; away_entrant_id: string | null; status: string; outcome: unknown; third_place?: boolean }
export interface GenerateOut { created: number; existing: number; fixtures: FixtureRow[] }
export interface StartOut { division_id: string; status: string; started: boolean; generated: number }
export interface CompleteOut { completed: boolean; events: { type: string; finalRanks?: string[] }[]; division_completed?: boolean }
export interface WithdrawOut { entrant_id: string; status: string; policy: "none" | "walkover" | "expunge"; walkovers: number; voided: number; skipped_finalized: number }
export interface StandingsRowWire { entrantId: string; rank: number; points?: number; played?: number }
export interface StandingsOut { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }
export interface PublicStandingsOut { division_id: string; standings: { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }[] }
export interface FixtureStateOut { status: string; last_seq: number; outcome: unknown }
export interface PostedEvent {
  seq: number; status: string; outcome: unknown; event_id: string;
  /** Parked Task 6 (b): set (true) only when this event landed on the one
   *  SEQ_CONFLICT retry, so a parity trace can say which posts raced. */
  retried?: boolean;
}

/** Final review m-2: the product keeps a durable unique index on
 *  (fixture_id, idempotency_key) and REPLAYS the first answer on a duplicate
 *  (usecases/scoring.ts, engine-db/append-event.ts). A key that restarts at
 *  `:0` on every call replays an earlier event on the second post to the same
 *  fixture. Keyed on the expected seq instead — strictly increasing per
 *  fixture, and the prefix carries the run and case — a key names exactly one
 *  (fixture, event) across calls and runs. Shared by HttpDriver and the fake. */
export function idempotencyKey(prefix: string, expectedSeq: number): string {
  return `${prefix}:s${expectedSeq}`;
}
/** The one SEQ_CONFLICT retry posts under a FRESH key: the refused attempt
 *  never reached the insert (the seq check precedes it), so reusing its key
 *  would be harmless today, but a fresh one names no ledger row whatever the
 *  product's order of checks. */
export function retryKey(key: string): string {
  return `${key}:retry`;
}
export interface ProbeOutcome { status: number; code: string | null }
/** A stage write's answer as a probe reads it. `featureKey` is api-v1's 402
 *  `feature_key` (server/api-v1/http.ts): PAYMENT_REQUIRED is a generic code
 *  (observed.ts GENERIC_ERROR_CODES), so the key is what names WHICH gate refused. */
export interface StagesProbe { status: number; code: string | null; featureKey: string | null }

export interface OrganiserDriver {
  createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef>;
  createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef>;
  getDivision(divisionId: string): Promise<DivisionRef>;
  postStages(divisionId: string, stages: readonly StagePostBody[]): Promise<StageRef[]>;
  listStages(divisionId: string): Promise<StageRef[]>;
  addEntrants(divisionId: string, entrants: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]>;
  /** The division's stored entrants (GET, ordered by seed) — the read-back
   *  life-built-as-posted compares with what was posted (final review I-2). */
  listEntrants(divisionId: string): Promise<EntrantRow[]>;
  start(divisionId: string): Promise<StartOut>;
  generate(stageId: string): Promise<GenerateOut>;
  listFixtures(divisionId: string): Promise<FixtureRow[]>;
  fixtureState(fixtureId: string): Promise<FixtureStateOut>;
  postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]>;
  forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]>;
  withdraw(entrantId: string): Promise<WithdrawOut>;
  completeStage(stageId: string): Promise<CompleteOut>;
  /** Replaces a root stage's fixtures wholesale (POST /stages/:id/rebuild).
   *  Throws RefusedCall on a refusal — 409 STAGE_HAS_RESULTS once any fixture
   *  carries a result (usecases/stages.ts rebuildStageFixtures). */
  rebuild(stageId: string): Promise<void>;
  standings(stageId: string, poolId: string | null): Promise<StandingsOut>;
  publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut>;
  /** A probe: returns the refusal, never throws on 4xx. */
  patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome>;
  /** A probe: PUT /divisions/:id/stages; returns the refusal, never throws on 4xx. */
  replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe>;
  readonly callCount: number;
}

/** RefusedCall's placeholders for an answer that carried no code or no message. */
export const NO_CODE = "(no code)";
export const NO_MESSAGE = "(no message)";
/** RefusedCall's request line, which it writes before the product's words:
 *  `METHOD path → HTTP status CODE: `, CODE being NO_CODE or one without a
 *  space or a colon. */
const REQUEST_LINE = /^\S+ \S+ → HTTP \d{3} (?:\(no code\)|[^\s:]+): /;

/** The product's own words in a RefusedCall's message — what follows its
 *  request line — or null: a message in no such shape, or one the product gave
 *  no words for (NO_MESSAGE). A committed `match` is read against these alone
 *  (final batch FB-3), never the method, path, status or code around them. */
export function productMessageOf(said: string): string | null {
  const line = REQUEST_LINE.exec(said);
  if (line === null) return null;
  const words = said.slice(line[0].length);
  return words === NO_MESSAGE ? null : words;
}

/** A product answer outside 2xx (or a 2xx with no data). Carries what I4's
 *  named-refusal check reads (observed.ts isNamedRefusal: status + code) and
 *  what a reader needs to find the call (method + path). Message and path are
 *  redacted (R14a). `featureKey` is a 402's `feature_key` (Task 9), else null. */
export class RefusedCall extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | null;
  readonly featureKey: string | null;
  constructor(method: string, path: string, status: number, code: string | null, message: string | null, featureKey: string | null = null) {
    super(redact(`${method} ${path} → HTTP ${status} ${code ?? NO_CODE}: ${message ?? NO_MESSAGE}`));
    this.name = "RefusedCall";
    this.method = method;
    this.path = redact(path);
    this.status = status;
    this.code = code;
    this.featureKey = featureKey;
  }
}

/** The harness asked the driver for something it must never do. */
export class DriverMisuse extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = "DriverMisuse";
  }
}

/** A request that did not answer within the driver's bound (HttpDriver,
 *  REQUEST_TIMEOUT_MS). Its outcome is unknown, and it is environmental — the
 *  product did not answer, it did not refuse — so the model aborts the cell on
 *  it rather than report a regression (T14 fix round 2, RR-2). Here, not in
 *  http-driver.ts, so the model reads it without importing bench. */
export class RequestTimedOut extends Error {
  readonly method: string;
  readonly path: string;
  readonly ms: number;
  constructor(method: string, path: string, ms: number) {
    super(`driver: ${method} ${path} did not answer within ${ms} ms — its outcome is unknown`);
    this.name = "RequestTimedOut";
    this.method = method;
    this.path = path;
    this.ms = ms;
  }
}

export class OrgMismatch extends Error {
  constructor(expected: string, got: string) {
    super(redact(`driver: competition landed in org ${got}, expected ${expected} — the active-org switch did not hold`));
    this.name = "OrgMismatch";
  }
}

export class VisibilityDegraded extends Error {
  constructor(slug: string) {
    super(redact(`driver: competition ${slug} was not created unlisted (public-dashboard cap degrade) — public reads would 404`));
    this.name = "VisibilityDegraded";
  }
}
