// The organiser, over the real v1 API (design §6.1). Every write that can race
// a server-side cascade reads its sequence first; /complete is never repeated
// once it has completed (design §6.4).
//
// Why never repeat /complete: on an already-complete stage the product answers
// `{completed:true, events:[]}` again (engine-db/competition.ts:575) and then
// re-runs the next-stage progression (usecases/stages.ts:4140 completeStage →
// progressCompletedStage), which computes a NEW draft seed proposal and marks
// the previous draft stale (stages.ts:4942-4944).
import { newSession, raw as benchRaw, type RawResult, type Session } from "../../../bench/lib/http.ts";
import { fetchFixtureLedger, type LedgerRow } from "../../../bench/lib/ledger.ts";
import type { StagePostBody } from "../catalogue.ts";
import { START, type StreamEvent } from "../streams/types.ts";
import { errorOf, is2xx, unwrapEnvelope } from "./envelope.ts";
import {
  DriverMisuse, LineupUnchecked, OrgMismatch, RefusedCall, RequestTimedOut, SEEDING_FAILED_AFTER_COMMIT, VisibilityDegraded, idempotencyKey, inSquadOrder, retryKey,
  type AmericanoViewOut, type ChallengeOut, type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantInput, type EntrantMember, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type FromTemplateAnswer, type FromTemplateOut, type GenerateOut, type LineupChecked, type LineupSlotWire, type MemberInput, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type SeedConfirmOut, type SeedProposalOut, type StageRef, type StagesProbe, type StandingsOut, type StartOut, type WithdrawOut,
} from "./types.ts";

export interface Transport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export interface HttpDriverOptions {
  base: string;
  session: Session;
  expectedOrgId: string;
  transport?: Transport;
  /** How long one request may go unanswered (default REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
}

/** How long one request may go unanswered before the driver stops waiting
 *  (T14 fix round 1, M-5). The model's time box only gates a property run's
 *  START (run-cell.ts), so without this one hung request holds a live cell
 *  forever. A minute: far above any single call the harness makes, far below a
 *  cell's time box (model.ts MODEL_DEFAULTS, pinned by model-cli.test.ts).
 *  The request is not aborted — bench's raw() takes no signal — only no longer
 *  awaited: it may still land, which is why a timed-out /complete is recorded
 *  as an unknown outcome (completeStage). */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The visibility a template create applies when none is asked
 *  (schemas.ts CreateFromTemplate `visibility: Visibility.default("public")`,
 *  pinned by http-driver.test.ts). The gallery sends none, so neither does
 *  createFromTemplate: both paths build the same competition, and anything
 *  else applied is the public-dashboard cap's degrade (W1-driving Task 13). */
export const TEMPLATE_VISIBILITY = "public";

const toDivisionRef = (d: { id: string; slug: string; sport_key: string; variant_key: string; config: Record<string, unknown> | null }): DivisionRef =>
  ({ id: d.id, slug: d.slug, sportKey: d.sport_key, variantKey: d.variant_key, config: d.config ?? {} });

export class HttpDriver implements OrganiserDriver {
  readonly #base: string;
  readonly #session: Session;
  readonly #expectedOrgId: string;
  readonly #t: Transport;
  readonly #completed = new Set<string>();
  readonly #timeoutMs: number;
  #calls = 0;

  constructor(opts: HttpDriverOptions) {
    this.#base = opts.base;
    this.#session = opts.session;
    this.#expectedOrgId = opts.expectedOrgId;
    this.#t = opts.transport ?? { raw: benchRaw };
    const ms = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    // A zero, negative or NaN bound would fire at once; an infinite one never.
    if (!(Number.isFinite(ms) && ms > 0)) throw new DriverMisuse(`driver: requestTimeoutMs must be a positive finite number of ms, got ${ms}`);
    this.#timeoutMs = ms;
  }

  get callCount(): number { return this.#calls; }

  /** Anonymous calls get a FRESH empty jar each time: raw() stores any
   *  Set-Cookie into the jar it was given, so a shared one would stop being
   *  anonymous after the first public answer that set a cookie. */
  async #send(path: string, method = "GET", body?: unknown, anonymous = false): Promise<RawResult> {
    this.#calls++;
    const answer = this.#t.raw(this.#base, anonymous ? newSession() : this.#session, path, method, body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestTimedOut(method, path, this.#timeoutMs)), this.#timeoutMs);
    });
    try {
      return await Promise.race([answer, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  #unwrap<T>(method: string, path: string, r: RawResult): T {
    return unwrapEnvelope<T>(method, path, r.status, r.json);
  }

  async #call<T>(path: string, method = "GET", body?: unknown, anonymous = false): Promise<T> {
    return this.#unwrap<T>(method, path, await this.#send(path, method, body, anonymous));
  }

  async createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef> {
    const c = await this.#call<{ id: string; slug: string; org_id: string; visibility?: string }>(
      "/api/v1/competitions", "POST", { name: input.name, slug: input.slug, ends_on: "2030-12-31", visibility: "unlisted" });
    // RF4: a failed or stale active-org switch creates the competition in the
    // previous case's org. Refuse before anything else lands there.
    if (c.org_id !== this.#expectedOrgId) throw new OrgMismatch(this.#expectedOrgId, c.org_id);
    // The public-dashboard cap degrades the create to private instead of
    // refusing it. The row's `visibility` is the one APPLIED (competitions.ts
    // createCompetition); the `public_quota_degraded` note beside it is an
    // object, never `true`, so the row is the one authority read here.
    if (c.visibility !== "unlisted") throw new VisibilityDegraded(c.slug);
    return { id: c.id, slug: c.slug, orgId: c.org_id };
  }

  /** W1-driving Task 13: the card's POST, then the read-back. The body is the
   *  gallery's (template-gallery.tsx submit) less its optional version guard
   *  and start date: no visibility, so the product's default applies. */
  async createFromTemplate(key: string, input: { name: string; endsOn: string }): Promise<FromTemplateOut> {
    const answer = await this.#call<FromTemplateAnswer>("/api/v1/competitions/from-template", "POST", { template_key: key, name: input.name, ends_on: input.endsOn });
    return this.readBackTemplate(answer, key);
  }

  /** What a template create built, read back — the answer carries ids only
   *  (FromTemplateResult). The browser path's read-back too (BrowserDriver).
   *  Refused by name: a competition outside the case org (RF4, as
   *  createCompetition), an applied visibility other than the default (the
   *  row is the one authority, as createCompetition reads it), a template
   *  with other than one division, stages that are not the ones the create
   *  answered, and (T13-R1 m-7) an answer for another template than the
   *  `key` the caller asked for — before anything is read back. */
  async readBackTemplate(answer: FromTemplateAnswer, key: string): Promise<FromTemplateOut> {
    if (answer.templateKey !== key) throw new DriverMisuse(`driver: the create answered template ${answer.templateKey}; asked for ${key}`);
    if (answer.divisions.length !== 1) throw new DriverMisuse(`driver: template ${answer.templateKey} built ${answer.divisions.length} division(s); a case drives exactly one`);
    const c = await this.#call<{ id: string; slug: string; org_id: string; visibility: string }>(`/api/v1/competitions/${answer.competitionId}`);
    if (c.org_id !== this.#expectedOrgId) throw new OrgMismatch(this.#expectedOrgId, c.org_id);
    if (c.visibility !== TEMPLATE_VISIBILITY) throw new VisibilityDegraded(c.slug);
    const created = answer.divisions[0];
    const division = await this.getDivision(created.id);
    const stages = [...await this.listStages(division.id)].sort((a, b) => a.seq - b.seq);
    const asked = created.stages.map((s) => s.id);
    if (JSON.stringify(stages.map((s) => s.id)) !== JSON.stringify(asked)) {
      throw new DriverMisuse(`driver: division ${division.id} lists stages ${stages.map((s) => s.id).join(", ") || "none"}; template ${answer.templateKey} answered ${asked.join(", ") || "none"}`);
    }
    return { competition: { id: c.id, slug: c.slug, orgId: c.org_id }, division, stages };
  }

  async createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return toDivisionRef(await this.#call(`/api/v1/competitions/${competitionId}/divisions`, "POST", {
      name: input.name, slug: input.slug, sport_key: input.sportKey, variant_key: input.variantKey, config: input.config ?? {},
    }));
  }

  async getDivision(divisionId: string): Promise<DivisionRef> {
    return toDivisionRef(await this.#call(`/api/v1/divisions/${divisionId}`));
  }

  async postStages(divisionId: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    const out = await this.#call<StageRef | StageRef[]>(`/api/v1/divisions/${divisionId}/stages`, "POST", stages);
    return Array.isArray(out) ? out : [out];
  }

  async listStages(divisionId: string): Promise<StageRef[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/stages`);
  }

  /** D2: an input's members ride inline as `new_person` members (schemas.ts
   *  NewPersonMemberInput), in order; an input without them sends no
   *  `members` key at all, so an individual's body is unchanged. */
  async addEntrants(divisionId: string, entrants: readonly EntrantInput[]): Promise<EntrantRow[]> {
    const out = await this.#call<EntrantRow | EntrantRow[]>(`/api/v1/divisions/${divisionId}/entrants`, "POST",
      entrants.map((e) => ({
        kind: e.kind, display_name: e.displayName, seed: e.seed,
        ...(e.members !== undefined ? { members: e.members.map((m) => ({ new_person: { full_name: m.fullName }, squad_number: m.squadNumber, is_captain: m.isCaptain })) } : {}),
      })));
    return Array.isArray(out) ? out : [out];
  }

  async listEntrants(divisionId: string): Promise<EntrantRow[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/entrants`);
  }

  async entrantMembers(entrantId: string): Promise<EntrantMember[]> {
    const e = await this.#call<{ members?: readonly EntrantMember[] }>(`/api/v1/entrants/${entrantId}`);
    return inSquadOrder(e.members ?? []);
  }

  /** The product saves, then answers `{ ...lineup, checked, warnings }`
   *  (fixtures.ts putLineup, WARNING-ONLY): the warnings are returned for the
   *  caller to record; `checked: false`, or an answer with no check at all,
   *  is LineupUnchecked. An empty `slots` is refused before any call: the
   *  product would skip its member check, DELETE the lineup and answer 2xx. */
  async putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<LineupChecked> {
    if (slots.length === 0) throw new DriverMisuse(`driver: putLineup for entrant ${entrantId} on fixture ${fixtureId} with no slots — the product would delete its lineup and answer 2xx, never refuse`);
    const out = await this.#call<{ checked?: unknown; warnings?: unknown; reason?: unknown }>(`/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`, "PUT", { slots });
    const raw: unknown = out.warnings;
    const warnings: readonly string[] | null = Array.isArray(raw) && raw.every((w): w is string => typeof w === "string") ? raw : null;
    if (out.checked === false && warnings !== null) throw new LineupUnchecked(fixtureId, entrantId, typeof out.reason === "string" ? out.reason : "the product gave no reason");
    if (out.checked !== true || warnings === null) {
      throw new LineupUnchecked(fixtureId, entrantId, `the PUT answered no lineup check (checked: ${JSON.stringify(out.checked)}, warnings: ${JSON.stringify(out.warnings)})`);
    }
    return { checked: true, warnings: [...warnings] };
  }

  /** The browser's roster filler (ruling 47): the entrants tab adds by name
   *  only, so each member is created as a person (POST /persons) and the
   *  entrant's roster is then set in ONE PATCH naming them (schemas.ts
   *  PatchEntrant `members`, a full replacement). Answers the stored roster.
   *  An empty roster is refused before any call: its PATCH would CLEAR the
   *  entrant's roster, never seed one. A refused person stops before the
   *  PATCH, so no roster is half-set. */
  async setMembers(entrantId: string, members: readonly MemberInput[]): Promise<EntrantMember[]> {
    if (members.length === 0) throw new DriverMisuse(`driver: setMembers for entrant ${entrantId} with no members — a PATCH of [] would clear its roster, not seed it`);
    const ids: string[] = [];
    for (const m of members) ids.push((await this.#call<{ id: string }>("/api/v1/persons", "POST", { full_name: m.fullName })).id);
    const e = await this.#call<{ members?: readonly EntrantMember[] }>(`/api/v1/entrants/${entrantId}`, "PATCH", {
      members: members.map((m, i) => ({ person_id: ids[i], squad_number: m.squadNumber, is_captain: m.isCaptain })),
    });
    return inSquadOrder(e.members ?? []);
  }

  async start(divisionId: string): Promise<StartOut> {
    return this.#call(`/api/v1/divisions/${divisionId}/start`, "POST", { acknowledge_warnings: true });
  }

  async generate(stageId: string): Promise<GenerateOut> {
    return this.#call(`/api/v1/stages/${stageId}/generate`, "POST", {});
  }

  async listFixtures(divisionId: string): Promise<FixtureRow[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/fixtures`);
  }

  async fixtureState(fixtureId: string): Promise<FixtureStateOut> {
    return this.#call(`/api/v1/fixtures/${fixtureId}/state`);
  }

  async postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]> {
    if (events.length === 0) return [];
    const path = `/api/v1/fixtures/${fixtureId}/events`;
    // RF5: never assume 0 — a server cascade (withdrawal walkover, swiss bye)
    // may already have written to this fixture.
    let seq = (await this.fixtureState(fixtureId)).last_seq;
    const out: PostedEvent[] = [];
    for (const ev of events) {
      const body = { expected_seq: seq, type: ev.type, payload: ev.payload, idempotency_key: idempotencyKey(idempotencyPrefix, seq) };
      let r = await this.#send(path, "POST", body);
      const e = errorOf(r.json);
      const retried = r.status === 409 && e.code === "SEQ_CONFLICT";
      if (retried) {
        // Retry ONCE from the server's tip: current_seq when the 409 carries it
        // (api-v1/http.ts), else a fresh /state read. Under a fresh key (retryKey).
        const tip = typeof e.current_seq === "number" ? e.current_seq : (await this.fixtureState(fixtureId)).last_seq;
        r = await this.#send(path, "POST", { ...body, expected_seq: tip, idempotency_key: retryKey(body.idempotency_key) });
      }
      const posted = this.#unwrap<PostedEvent>("POST", path, r);
      seq = posted.seq;
      out.push(retried ? { ...posted, retried: true } : posted);
    }
    return out;
  }

  async forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]> {
    const state = await this.fixtureState(fixtureId);
    const forfeitEv: StreamEvent = { type: "core.forfeit", payload: { by: byEntrantId, reason } };
    // Identical to generateStream's forfeit composition on a scheduled fixture
    // (streams/index.ts), so the declared points the scenario folds locally are
    // for exactly the events posted here.
    return this.postStream(fixtureId, state.status === "scheduled" ? [START, forfeitEv] : [forfeitEv], idempotencyPrefix);
  }

  /** Finalizes a decided fixture through the product's own route
   *  (fixtures/[id]/finalize/route.ts:11, Body `{expected_seq}`), which
   *  appends core.finalize through the scoring path (usecases/scoring.ts
   *  finalizeFixture). The organiser's console posts the same event to the
   *  events route instead (T5 fixture-console.ts); parity compares the LEDGER
   *  rows the two leave, never the routes (controller ruling D). The state is
   *  the product's own answer to the append. */
  async finalize(fixtureId: string): Promise<FixtureStateOut> {
    // RF5: never assume the tip — read it, as postStream does.
    const tip = (await this.fixtureState(fixtureId)).last_seq;
    const posted = await this.#call<PostedEvent>(`/api/v1/fixtures/${fixtureId}/finalize`, "POST", { expected_seq: tip });
    return { status: posted.status, last_seq: posted.seq, outcome: posted.outcome };
  }

  /** The fixture's ledger rows AFTER `sinceSeq` (EXCLUSIVE — `since 3` never
   *  returns seq 3), seq-sorted and envelope-checked: the bench's hardened
   *  reader (bench/lib/ledger.ts fetchFixtureLedger, ruling 38), sent through
   *  this driver's transport so the read is counted and bounded like any other.
   *  A refusal throws, never reads as an empty ledger. */
  async ledger(fixtureId: string, sinceSeq = 0): Promise<readonly LedgerRow[]> {
    // The route 400s anything but a non-negative integer; refuse it here, by name, before a call.
    if (!(Number.isInteger(sinceSeq) && sinceSeq >= 0)) throw new DriverMisuse(`driver: ledger since_seq must be a non-negative integer seq, got ${sinceSeq}`);
    return fetchFixtureLedger(this.#base, this.#session, fixtureId, sinceSeq, { raw: (_base, _s, path, method) => this.#send(path, method ?? "GET") });
  }

  async withdraw(entrantId: string): Promise<WithdrawOut> {
    return this.#call(`/api/v1/entrants/${entrantId}/withdraw`, "POST", {});
  }

  async completeStage(stageId: string): Promise<CompleteOut> {
    if (this.#completed.has(stageId)) {
      throw new DriverMisuse(`driver: stage ${stageId} already completed, or its /complete ended unknown (5xx or no answer) — /complete is never repeated (design §6.4)`);
    }
    const path = `/api/v1/stages/${stageId}/complete`;
    // Parked Task 6 (a): completeStage COMMITS the completion and then runs
    // progressCompletedStage (usecases/stages.ts:4140-4170), which can throw —
    // so a 5xx, or a request that never answered, may follow a committed
    // completion. Its outcome is unknown, and a repeat would re-run the
    // progression; it is recorded like a completion. A 4xx (a named refusal)
    // committed nothing and stays retryable — except W1-driving T6's FP-3:
    // 409 STAGE_COMPLETED_SEEDING_FAILED is the product saying the completion
    // DID commit and only the next stage's seed proposal failed (:4239-4252),
    // so it is recorded like a completion too.
    let r: RawResult;
    try {
      r = await this.#send(path, "POST", {});
    } catch (e) {
      this.#completed.add(stageId);
      throw e;
    }
    if (r.status >= 500) this.#completed.add(stageId);
    let out: CompleteOut;
    try {
      out = this.#unwrap<CompleteOut>("POST", path, r);
    } catch (e) {
      if (e instanceof RefusedCall && e.code === SEEDING_FAILED_AFTER_COMMIT) this.#completed.add(stageId);
      throw e;
    }
    if (out.completed) this.#completed.add(stageId);
    return out;
  }

  /** W1-driving T6 (D1): the organiser's Confirm on the next stage's draft
   *  (route seed-proposal/confirm, schemas.ts ConfirmSeedProposal). */
  async confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut> {
    return this.#call(`/api/v1/stages/${stageId}/seed-proposal/confirm`, "POST", body);
  }

  /** W1-driving T6 (D1): Recompute — a fresh draft, the previous one stale.
   *  The route answers 201 with the slate under `computed`
   *  (usecases/stages.ts computeSeedProposal). */
  async recomputeSeedProposal(stageId: string): Promise<SeedProposalOut> {
    const p = await this.#call<{ id: string; status: string; computed: { qualifiers: SeedProposalOut["qualifiers"]; ties: SeedProposalOut["ties"] } }>(`/api/v1/stages/${stageId}/seed-proposal`, "POST", {});
    return { id: p.id, status: p.status, qualifiers: p.computed.qualifiers, ties: p.computed.ties };
  }

  /** W1-driving T7 (D8): a ladder challenge (route stages/[id]/challenges,
   *  body `{challenger_id, opponent_id}` → 201 usecases/stages.ts
   *  issueChallenge). The answer's ladder_order is the order at issue; a
   *  refusal (LADDER_*, a non-ladder 422) is the product's RefusedCall. */
  async challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut> {
    return this.#call(`/api/v1/stages/${stageId}/challenges`, "POST", { challenger_id: challengerId, opponent_id: opponentId });
  }

  /** W1-driving Task 8: the americano read model (route stages/[id]/americano
   *  → usecases/americano.ts americanoView), answered as the product serves
   *  it. A non-americano stage is the product's codeless 422 → RefusedCall. */
  async americanoView(stageId: string): Promise<AmericanoViewOut> {
    return this.#call(`/api/v1/stages/${stageId}/americano`);
  }

  async rebuild(stageId: string): Promise<void> {
    // usecases/stages.ts rebuildStageFixtures: refuses whole (409
    // STAGE_HAS_RESULTS) once any fixture carries a result or a score event,
    // 422 STAGE_NOT_ROOT for a stage fed by another. The answer's counts are
    // not read: the model re-lists the fixtures after it.
    await this.#call<unknown>(`/api/v1/stages/${stageId}/rebuild`, "POST", {});
  }

  async standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    return this.#call(`/api/v1/stages/${stageId}/standings${poolId === null ? "" : `?pool_id=${encodeURIComponent(poolId)}`}`);
  }

  async publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut> {
    return this.#call(`/api/v1/public/orgs/${ref.orgSlug}/competitions/${ref.competitionSlug}/divisions/${ref.divisionSlug}/standings`, "GET", undefined, true);
  }

  async patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
    const r = await this.#send(`/api/v1/divisions/${divisionId}`, "PATCH", { config });
    return { status: r.status, code: is2xx(r.status) ? null : (errorOf(r.json).code ?? null) };
  }

  async replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
    const r = await this.#send(`/api/v1/divisions/${divisionId}/stages`, "PUT", stages);
    if (is2xx(r.status)) return { status: r.status, code: null, featureKey: null };
    const e = errorOf(r.json);
    return { status: r.status, code: e.code ?? null, featureKey: e.feature_key ?? null };
  }
}
