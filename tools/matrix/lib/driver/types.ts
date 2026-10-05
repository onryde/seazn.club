// The organiser seam (design §6.1). Scenarios and run.ts reach the product only
// through this interface: HttpDriver drives the real v1 API, and Task 8's fake
// driver implements the same surface in memory.
//
// Wire shapes are the api-v1 rows, trimmed to what the harness reads
// (apps/web/src/server/api-v1/schemas.ts: Stage, Entrant, Fixture,
// FixtureState, AppendEventResponse, CompleteResult; usecases/withdrawal.ts
// WithdrawCascadeOut; usecases/public.ts publicStandings).
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
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
/** POST /api/v1/competitions/from-template's answer (api-v1/schemas.ts
 *  FromTemplateResult, W1-driving Task 13): ids and the APPLIED visibility —
 *  no org id, no sport, no stage kind, so the caller reads those back. */
export interface FromTemplateAnswer {
  competitionId: string;
  slug: string;
  visibility: string;
  public_quota_degraded?: unknown;
  divisions: { id: string; stages: { id: string; fixtureCount: number }[] }[];
  templateKey: string;
  templateVersion: number;
}
/** What one template instantiation built, read back from the product. */
export interface FromTemplateOut { readonly competition: CompetitionRef; readonly division: DivisionRef; readonly stages: readonly StageRef[] }
/** `kind` (W1-driving Task 8): the product serves it (entrants.ts COLS) and
 *  lists EVERY entrant of the division, the `pair` entrants an americano
 *  stage mints included (entrants.ts listEntrants has no kind filter).
 *  Optional: the fakes' plain rows omit it, which reads as not a pair. */
export interface EntrantRow { id: string; display_name: string; seed: number | null; status: string; kind?: string }
/** `third_place` (W1b Task 10, T3 review G1): the product's row flag for a
 *  knockout's third-place match (usecases/fixtures.ts listDivisionFixtures
 *  selects it; the division fixtures route serves it). Optional: the fakes
 *  and older rows omit it, which reads as "not a third-place match".
 *  `ext_key` / `is_final` (W1-driving Task 6): kept as the product serves them
 *  (fixtures.ts listDivisionFixtures selects both) — a later stage's TBD row
 *  is identified by its ext_key; absent from the fakes' single-stage rows.
 *  `scheduled_at` (W1d Task 14): the instant the product dated it at, as served
 *  (null: undated); absent from the fakes' rows, which read as undated. */
export interface FixtureRow { id: string; stage_id: string; pool_id: string | null; round_no: number | null; fixture_no: number | null; home_entrant_id: string | null; away_entrant_id: string | null; status: string; outcome: unknown; third_place?: boolean; ext_key?: string | null; is_final?: boolean; scheduled_at?: string | null }
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
/** W1-driving Task 8: the americano read model (GET /stages/:id/americano →
 *  usecases/americano.ts americanoView). `mode` is the product's own reading
 *  of the stage's config.mode (anything but "mexicano" reads "americano");
 *  each match's team1/team2 are the fixture's home/away pair entrants. Only
 *  the fields the harness reads are typed. */
export interface AmericanoViewOut { readonly mode: "americano" | "mexicano"; readonly rounds: readonly { round_no: number; matches: readonly { fixture_id: string; status: string; team1: { entrant_id: string }; team2: { entrant_id: string } }[] }[]; readonly leaderboard: readonly { person_id: string; points: number; games: number }[] }
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
/** The ledger row type a core.void is (events.ts CORE_EVENT_SCHEMAS; the console posts it from "Void last entry"). */
export const VOID_EVENT = "core.void";
/** W1d Task 14 (item 15e): what voidLast voided. `voidedEventId` is the ledger row's own id (the product mints a
 *  uuid; the fakes use the seq), `voidedType` that row's type — read from the LEDGER, never from what the caller
 *  meant to void, so a scenario judges the choice the console or the route actually made. */
export interface VoidedOut { readonly voidedEventId: string; readonly voidedType: string }
/** The instant scheduleFixtureNow's PATCH made the product store (its own answer, not the one sent). */
export interface ScheduledOut { readonly scheduledAt: string }

/** The newest ledger row that is neither a core.void nor already voided, or null when there is none — the console's
 *  own rule for what "Void last entry" offers (fixture-console.tsx `lastVoidable`, text-pinned by
 *  void-proof.test.ts). Rows are in seq order. A row is voided when some core.void names its id in
 *  `payload.event_id` (the product lifts that into `voids_event_id`); a void whose payload names nothing voids
 *  nothing here, as in the product, where a void with no resolvable target is refused (UNDO_NOOP). */
export function voidTargetOf(rows: readonly LedgerRow[]): LedgerRow | null {
  const voided = new Set<string>();
  for (const r of rows) {
    if (r.type !== VOID_EVENT) continue;
    const id = (r.payload as { event_id?: unknown } | null)?.event_id;
    if (typeof id === "string") voided.add(id);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.type !== VOID_EVENT && !voided.has(r.id)) return r;
  }
  return null;
}

/** voidTargetOf, refused by name when there is nothing to void (an empty ledger, or every event already voided or a
 *  void) or when the target carries no id for a core.void to name. Shared by the two drivers that read the ledger
 *  before voiding (HttpDriver, BrowserDriver), so the refusal has one text. `who` is the driver's own prefix. */
export function requireVoidTarget(who: "driver" | "browser", fixtureId: string, rows: readonly LedgerRow[]): LedgerRow {
  const target = voidTargetOf(rows);
  if (target === null) throw new DriverMisuse(`${who}: voidLast on fixture ${fixtureId} — nothing to void (the ledger holds ${rows.length} row(s), none that is neither a ${VOID_EVENT} nor already voided)`);
  if (target.id === "") throw new DriverMisuse(`${who}: voidLast on fixture ${fixtureId} — the newest voidable ledger row (seq ${target.seq}, ${target.type}) carries no id, so no ${VOID_EVENT} can name it`);
  return target;
}

/** The phases the product's desk serves (division-phase.ts DIVISION_PHASES; text-pinned by http-driver.test.ts). */
export const DESK_PHASES: readonly string[] = Object.freeze(["setting_up", "scheduled", "match_day", "finished"]);
export interface ProbeOutcome { status: number; code: string | null }
/** A stage write's answer as a probe reads it. `featureKey` is api-v1's 402
 *  `feature_key` (server/api-v1/http.ts): PAYMENT_REQUIRED is a generic code
 *  (observed.ts GENERIC_ERROR_CODES), so the key is what names WHICH gate refused. */
export interface StagesProbe { status: number; code: string | null; featureKey: string | null }

export interface OrganiserDriver {
  createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef>;
  /** W1-driving Task 13 (ruling 47): ONE organiser act builds a catalog
   *  template's competition, division and stages — and no entrant
   *  (usecases/templates.ts). The answer is the product's, read back. */
  createFromTemplate(key: string, input: { name: string; endsOn: string }): Promise<FromTemplateOut>;
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
  /** The americano read model (GET /stages/:id/americano, W1-driving Task 8):
   *  the rotation grid and the personal-points leaderboard. A stage of any
   *  other kind is a codeless 422 ("not an americano stage") → RefusedCall. */
  americanoView(stageId: string): Promise<AmericanoViewOut>;
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
  /** W1d Task 14 (item 15e): voids the fixture's newest live event — the newest
   *  that is neither a core.void nor already voided (voidTargetOf), the rule the
   *  console's "Void last entry" applies — and answers which one it was, read from
   *  the ledger. HttpDriver reads the ledger and appends `core.void {event_id}` at
   *  its tip; BrowserDriver taps the console's control, which chooses its own
   *  target. Nothing to void is refused before any write (DriverMisuse). */
  voidLast(fixtureId: string): Promise<VoidedOut>;
  /** The fixture's ledger rows AFTER `sinceSeq` (exclusive), seq-sorted (HttpDriver.ledger).
   *  Optional: a driver without it cannot claim a void proof (VOIDPROOF names the gap). */
  ledger?(fixtureId: string, sinceSeq?: number): Promise<readonly LedgerRow[]>;
  /** W1d Task 14 (item 15c): dates the fixture NOW — today in every venue time zone —
   *  through PATCH /fixtures/:id, and answers the instant the product stored. This is
   *  how a division reaches its match day (division-phase.ts rule 3: a scheduled
   *  fixture dated today). Optional: a driver without it cannot plan a match day. */
  scheduleFixtureNow?(fixtureId: string): Promise<ScheduledOut>;
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

/** W1d Task 6 (D6): a RefusedCall raised in a scenario's SETUP PHASE — the driver calls
 *  `setUpDivision` makes before `start` (scenarios/common.ts `inSetup`), and DENIED's own
 *  four. The harness asked the product to build something it will not build, so it is
 *  the harness's fault, never a finding: the judge reads it as `setup-refused`. A refusal
 *  anywhere else (`start`, the action under test) is the product answering, and stays a
 *  plain RefusedCall — so the tag is by PHASE, never by route.
 *
 *  A subclass, so every `instanceof RefusedCall` catch behaves as before; run.ts `errText`
 *  writes `name` into the reason (`error: SetupRefused: …`). `name` is assigned in the
 *  constructor body, as every Error subclass here does (strip-types, house rule). */
export class SetupRefused extends RefusedCall {
  constructor(method: string, path: string, status: number, code: string | null, message: string | null, featureKey: string | null = null, extra: Readonly<Record<string, unknown>> | null = null) {
    super(method, path, status, code, message, featureKey, extra);
    this.name = "SetupRefused";
  }

  /** The tagged copy of `e`, keeping its message WHOLE. RefusedCall's constructor composes
   *  `<method> <path> → HTTP <status> <code>: <message>` and keeps no raw message, so
   *  rebuilding from `e.message` would double the request line (review 3, R3-m2): the
   *  fields go in with a null message and the finished, already-redacted text is put back. */
  static from(e: RefusedCall): SetupRefused {
    const tagged = new SetupRefused(e.method, e.path, e.status, e.code, null, e.featureKey, e.extra);
    tagged.message = e.message;
    return tagged;
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
