// The organiser seam (design §6.1). Scenarios and run.ts reach the product only
// through this interface: HttpDriver drives the real v1 API, and Task 8's fake
// driver implements the same surface in memory.
//
// Wire shapes are the api-v1 rows, trimmed to what the harness reads
// (apps/web/src/server/api-v1/schemas.ts: Stage, Entrant, Fixture,
// FixtureState, AppendEventResponse, CompleteResult; usecases/withdrawal.ts
// WithdrawCascadeOut; usecases/public.ts publicStandings).
import type { StagePostBody } from "../catalogue.ts";
import { mapStrings, redact } from "../redact.ts";
import type { StreamEvent } from "../streams/types.ts";

export type EntrantKind = "individual" | "pair" | "team";
/** One roster member as the harness writes it (D2): a synthetic person
 *  ("Matrix Player <entrant>.<m>", R14a), created by name — inline on the
 *  create (schemas.ts NewPersonMemberInput) or as filler (persons, then the
 *  entrant's PATCH). */
export interface MemberInput { readonly fullName: string; readonly squadNumber: number; readonly isCaptain: boolean }
/** An entrant to add. `members` absent: no roster, and no `members` key on
 *  the wire (an individual's body, byte for byte). */
export interface EntrantInput { readonly displayName: string; readonly seed: number; readonly kind: EntrantKind; readonly members?: readonly MemberInput[] }
/** A stored roster member, trimmed to what the harness reads (entrants.ts
 *  withMembers serves more: name, dob, gender, roles). */
export interface EntrantMember { readonly person_id: string; readonly squad_number: number | null; readonly is_captain: boolean }
/** One lineup slot on the wire (schemas.ts LineupSlotInput). */
export interface LineupSlotWire { readonly person_id: string; readonly slot: "starting" | "bench"; readonly position_key?: string; readonly order_no?: number; readonly roles?: readonly string[] }

/** A roster in the product's order — squad number, nulls last (entrants.ts
 *  withMembers `order by em.squad_number nulls last`) — each member trimmed to
 *  an EntrantMember. The one authority for that order: HttpDriver, the fakes
 *  and the lineup builder all read it. */
export function inSquadOrder(members: readonly EntrantMember[]): EntrantMember[] {
  const key = (m: EntrantMember) => m.squad_number ?? Number.POSITIVE_INFINITY;
  return [...members].sort((a, b) => key(a) - key(b)).map((m) => ({ person_id: m.person_id, squad_number: m.squad_number, is_captain: m.is_captain }));
}
export interface CompetitionRef { id: string; slug: string; orgId: string }
export interface DivisionRef { id: string; slug: string; sportKey: string; variantKey: string; config: Record<string, unknown> }
export interface StageRef { id: string; seq: number; kind: string; config: Record<string, unknown>; status: string }
export interface EntrantRow { id: string; display_name: string; seed: number | null; status: string }
/** `third_place` (W1b Task 10, T3 review G1): the product's row flag for a
 *  knockout's third-place match (usecases/fixtures.ts listDivisionFixtures
 *  selects it; the division fixtures route serves it). Optional: the fakes
 *  and older rows omit it, which reads as "not a third-place match".
 *  `ext_key` / `is_final` (W1-driving Task 6): kept as the product serves them
 *  (fixtures.ts listDivisionFixtures selects both) — a later stage's TBD row
 *  is identified by its ext_key; absent from the fakes' single-stage rows. */
export interface FixtureRow { id: string; stage_id: string; pool_id: string | null; round_no: number | null; fixture_no: number | null; home_entrant_id: string | null; away_entrant_id: string | null; status: string; outcome: unknown; third_place?: boolean; ext_key?: string | null; is_final?: boolean }
export interface GenerateOut { created: number; existing: number; fixtures: FixtureRow[] }
export interface StartOut { division_id: string; status: string; started: boolean; generated: number }
/** The next stage's DRAFT seed proposal a /complete minted
 *  (usecases/stages.ts progressCompletedStage `seed_proposal`). There is no GET:
 *  /complete's answer is the only place the harness learns its id. */
export interface SeedProposalRef { readonly id: string; readonly status: string }
export interface CompleteOut { completed: boolean; events: { type: string; finalRanks?: string[] }[]; division_completed?: boolean; seed_proposal?: SeedProposalRef | null }
/** A flagged seeding tie: the destination slots it spans and the tied
 *  entrants, in the product's listed order (computeSeedProposal `ties`). */
export interface SeedTie { readonly slots: readonly string[]; readonly entrantIds: readonly string[]; readonly reason: string }
/** A recomputed draft (POST /stages/:id/seed-proposal → 201 `computed`). */
export interface SeedProposalOut { readonly id: string; readonly status: string; readonly qualifiers: readonly { rank: number; entrantId: string; destinationSlot: string }[]; readonly ties: readonly SeedTie[] }
/** confirmSeedProposal's answer: `filled` counts SLOTS (a bye seed owns two),
 *  and `fixtures` is the WHOLE target stage (stages.ts, `where f.stage_id`). */
export interface SeedConfirmOut { readonly proposalId: string; readonly filled: number; readonly fixtures: readonly FixtureRow[] }
/** W1-driving T6 (FP-3): the 409 a /complete answers when the stage's
 *  completion COMMITTED and only the next stage's seed proposal failed
 *  (usecases/stages.ts progressCompletedStage). A repeat of that /complete
 *  would re-run the progression, so the drivers record it as a completion.
 *  Pinned against the product's text by http-driver.test.ts. */
export const SEEDING_FAILED_AFTER_COMMIT = "STAGE_COMPLETED_SEEDING_FAILED";
export interface WithdrawOut { entrant_id: string; status: string; policy: "none" | "walkover" | "expunge"; walkovers: number; voided: number; skipped_finalized: number }
/** W1-driving T7 (D8): a ladder challenge's answer (route stages/[id]/challenges
 *  → 201 usecases/stages.ts issueChallenge). `ladder_order` is the RAW order
 *  as it stood when the challenge was ISSUED — before its result lands, and
 *  never pruned of a departed entrant. */
export interface ChallengeOut { readonly fixture_id: string; readonly ladder_order: readonly string[] }
export interface StandingsRowWire { entrantId: string; rank: number; points?: number; played?: number }
export interface StandingsOut { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }
export interface PublicStandingsOut { division_id: string; standings: { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }[] }
export interface FixtureStateOut { status: string; last_seq: number; outcome: unknown }
export interface PostedEvent {
  seq: number; status: string; outcome: unknown; event_id: string;
  /** Parked Task 6 (b): set (true) only when this event landed on the one
   *  SEQ_CONFLICT retry, so a parity trace can say which posts raced. */
  retried?: boolean;
  /** W1c Task 7: the ledger row as the product holds it. Only the pad path
   *  sets it, and it sets it on every event it answers. Its taps wrote the row,
   *  so the scenario folds this and never the event it meant to send. */
  stored?: StreamEvent;
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
  /** An input's `members` ride inline on the create over HTTP; the browser
   *  adds by name and seeds them as filler (D2, ruling 47). */
  addEntrants(divisionId: string, entrants: readonly EntrantInput[]): Promise<EntrantRow[]>;
  /** The division's stored entrants (GET, ordered by seed) — the read-back
   *  life-built-as-posted compares with what was posted (final review I-2). */
  listEntrants(divisionId: string): Promise<EntrantRow[]>;
  /** The entrant's stored roster (GET /entrants/:id → members), in squad
   *  order (inSquadOrder); [] for an entrant with none. */
  entrantMembers(entrantId: string): Promise<EntrantMember[]>;
  /** Replaces the entrant's lineup for the fixture (PUT
   *  /fixtures/:id/lineups/:entrantId). The product takes it only while the
   *  fixture is `scheduled`, with no person twice, and only of the entrant's
   *  own members (fixtures.ts putLineup); a refusal throws RefusedCall. A
   *  lineup it takes is saved and then checked — WARNING-ONLY — so the
   *  answer is returned: `warnings` for the caller to record, never refused
   *  here. A lineup saved UNCHECKED throws LineupUnchecked. An empty `slots`
   *  is refused before any call (the product would delete the lineup, 2xx). */
  putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<LineupChecked>;
  start(divisionId: string): Promise<StartOut>;
  generate(stageId: string): Promise<GenerateOut>;
  listFixtures(divisionId: string): Promise<FixtureRow[]>;
  fixtureState(fixtureId: string): Promise<FixtureStateOut>;
  postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]>;
  forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]>;
  withdraw(entrantId: string): Promise<WithdrawOut>;
  completeStage(stageId: string): Promise<CompleteOut>;
  /** Confirms a draft seed proposal (POST /stages/:id/seed-proposal/confirm,
   *  schemas.ts ConfirmSeedProposal): fills the stage's TBD rows through
   *  fillSlot. A refusal (stale, already confirmed, an unresolved tie, a
   *  withdrawn qualifier, nothing to fill) throws RefusedCall. */
  confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut>;
  /** Recomputes the stage's draft (POST /stages/:id/seed-proposal), marking
   *  the previous draft stale. Throws RefusedCall on a refusal. */
  recomputeSeedProposal(stageId: string): Promise<SeedProposalOut>;
  /** Replaces a root stage's fixtures wholesale (POST /stages/:id/rebuild).
   *  Throws RefusedCall on a refusal — 409 STAGE_HAS_RESULTS once any fixture
   *  carries a result (usecases/stages.ts rebuildStageFixtures). */
  rebuild(stageId: string): Promise<void>;
  /** Issues a ladder challenge (POST /stages/:id/challenges, body
   *  `{challenger_id, opponent_id}`): the product inserts ONE scheduled
   *  fixture, challenger home. A refusal (FOREIGN, WITHDRAWN, NOT_UPWARD,
   *  OUT_OF_RANGE, a non-ladder stage) throws RefusedCall. */
  challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut>;
  standings(stageId: string, poolId: string | null): Promise<StandingsOut>;
  publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut>;
  /** A probe: returns the refusal, never throws on 4xx. */
  patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome>;
  /** A probe: PUT /divisions/:id/stages; returns the refusal, never throws on 4xx. */
  replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe>;
  /** Finalizes a decided fixture and answers its state (W1c Task 6). Optional:
   *  a driver without it cannot claim a finalize proof (Task 7's PADPROOF
   *  refuses such a driver). HttpDriver posts the finalize route, BrowserDriver
   *  taps the console's Finalize (the events route): both append ONE
   *  core.finalize ledger row, and parity compares that row, never the route
   *  (controller ruling D). */
  finalize?(fixtureId: string): Promise<FixtureStateOut>;
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
 *  redacted (R14a). `featureKey` is a 402's `feature_key` (Task 9), else null.
 *  `extra` is every other field of the product's error envelope — e.g. a
 *  NEXT_MATCH_STARTED refusal's `next_match` (W1b carry c) — with every string
 *  in it redacted, or null when there is none. */
export class RefusedCall extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | null;
  readonly featureKey: string | null;
  readonly extra: Readonly<Record<string, unknown>> | null;
  constructor(method: string, path: string, status: number, code: string | null, message: string | null, featureKey: string | null = null, extra: Readonly<Record<string, unknown>> | null = null) {
    super(redact(`${method} ${path} → HTTP ${status} ${code ?? NO_CODE}: ${message ?? NO_MESSAGE}`));
    this.name = "RefusedCall";
    this.method = method;
    this.path = redact(path);
    this.status = status;
    this.code = code;
    this.featureKey = featureKey;
    this.extra = extra === null ? null : mapStrings(extra, redact);
  }
}

/** The fixture a refusal says the result fed, or null (W1b carry c): the
 *  product's NEXT_MATCH_STARTED names it as `next_match.fixture_id`
 *  (fed-seats.ts boardRef; pinned by product-text.ts). */
export function nextMatchFixtureId(e: RefusedCall): string | null {
  const nm = e.extra?.next_match;
  return typeof nm === "object" && nm !== null && typeof (nm as { fixture_id?: unknown }).fixture_id === "string" ? (nm as { fixture_id: string }).fixture_id : null;
}

/** The harness asked the driver for something it must never do. */
export class DriverMisuse extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = "DriverMisuse";
  }
}

/** The product's verdict on a lineup it saved (fixtures.ts PutLineupOut's
 *  LineupCheck, checked arm): validateLineup on the division's STORED config,
 *  each issue as one warning string. Warnings do not stop the save. */
export interface LineupChecked { readonly checked: true; readonly warnings: readonly string[] }

/** A lineup PUT the product saved but did not check: its answer said
 *  `checked: false` (validation crashed; `reason` is the error's kind), or
 *  carried no check at all. Fail closed — an unchecked lineup is never read as
 *  a clean one (fix round 1, I-1). */
export class LineupUnchecked extends Error {
  readonly fixtureId: string;
  readonly entrantId: string;
  readonly reason: string;
  constructor(fixtureId: string, entrantId: string, reason: string) {
    super(redact(`driver: the lineup for entrant ${entrantId} on fixture ${fixtureId} was saved UNCHECKED — ${reason}`));
    this.name = "LineupUnchecked";
    this.fixtureId = fixtureId;
    this.entrantId = entrantId;
    this.reason = reason;
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

/** 🚫 (W1c Task 6, M-4 ruling): the case asked this driver for a path the
 *  product has but this layer does not drive; `wave` owes it. The runner
 *  records it through decideState's `noPath`, never as an error red. */
export class NoOrganiserPath extends Error {
  readonly wave: string;
  readonly reason: string;
  constructor(wave: string, reason: string) {
    super(redact(`driver: no organiser path in this layer — ${reason} → ${wave}`));
    this.name = "NoOrganiserPath";
    this.wave = wave;
    this.reason = redact(reason);
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
