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
import type { StagePostBody } from "../catalogue.ts";
import { START, type StreamEvent } from "../streams/types.ts";
import {
  DriverMisuse, OrgMismatch, RefusedCall, RequestTimedOut, VisibilityDegraded, idempotencyKey, retryKey,
  type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type GenerateOut, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type StageRef, type StagesProbe, type StandingsOut, type StartOut, type WithdrawOut,
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

/** api-v1's envelope (server/api-v1/http.ts): `{ok:true, data}` or
 *  `{ok:false, error:{code, message, ...extra}}` — errorResponse spreads an
 *  error's extra beside code and message: `current_seq` (a SEQ_CONFLICT),
 *  `feature_key` (a 402), `next_match` (NEXT_MATCH_STARTED), and more. A
 *  non-v1 or non-JSON answer can carry a bare string `error`; it then yields
 *  no code. */
interface Envelope { ok?: boolean; data?: unknown; error?: Record<string, unknown> | string | null }

/** The envelope's error fields RefusedCall carries as its own; every other one is its `extra` (W1b carry c). */
const OWN_ERROR_FIELDS: ReadonlySet<string> = new Set(["code", "message", "current_seq", "feature_key"]);

const errorFieldsOf = (r: RawResult): Record<string, unknown> | string | null => (r.json as unknown as Envelope | null)?.error ?? null;

function errorOf(r: RawResult): { code?: string; message?: string; current_seq?: number; feature_key?: string } {
  const e = errorFieldsOf(r);
  if (typeof e === "string") return { message: e };
  if (e === null || typeof e !== "object") return {};
  const out: { code?: string; message?: string; current_seq?: number; feature_key?: string } = {};
  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.message === "string") out.message = e.message;
  if (typeof e.current_seq === "number") out.current_seq = e.current_seq;
  if (typeof e.feature_key === "string") out.feature_key = e.feature_key;
  return out;
}

const is2xx = (r: RawResult) => r.status >= 200 && r.status < 300;

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
    if (!is2xx(r)) {
      const e = errorOf(r);
      // Every other field of the error rides on the refusal as `extra` (W1b
      // carry c: NEXT_MATCH_STARTED's `next_match`); RefusedCall redacts it.
      const fields = errorFieldsOf(r);
      const rest = typeof fields === "object" && fields !== null ? Object.entries(fields).filter(([k]) => !OWN_ERROR_FIELDS.has(k)) : [];
      throw new RefusedCall(method, path, r.status, e.code ?? null, e.message ?? null, e.feature_key ?? null, rest.length === 0 ? null : Object.fromEntries(rest));
    }
    const data = (r.json as unknown as Envelope | null)?.data;
    if (data === undefined) throw new RefusedCall(method, path, r.status, "NO_DATA", "response carried no data");
    return data as T;
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

  async addEntrants(divisionId: string, entrants: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    const out = await this.#call<EntrantRow | EntrantRow[]>(`/api/v1/divisions/${divisionId}/entrants`, "POST",
      entrants.map((e) => ({ kind: e.kind, display_name: e.displayName, seed: e.seed })));
    return Array.isArray(out) ? out : [out];
  }

  async listEntrants(divisionId: string): Promise<EntrantRow[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/entrants`);
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
      const e = errorOf(r);
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
    // committed nothing and stays retryable.
    let r: RawResult;
    try {
      r = await this.#send(path, "POST", {});
    } catch (e) {
      this.#completed.add(stageId);
      throw e;
    }
    if (r.status >= 500) this.#completed.add(stageId);
    const out = this.#unwrap<CompleteOut>("POST", path, r);
    if (out.completed) this.#completed.add(stageId);
    return out;
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
    return { status: r.status, code: is2xx(r) ? null : (errorOf(r).code ?? null) };
  }

  async replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
    const r = await this.#send(`/api/v1/divisions/${divisionId}/stages`, "PUT", stages);
    if (is2xx(r)) return { status: r.status, code: null, featureKey: null };
    const e = errorOf(r);
    return { status: r.status, code: e.code ?? null, featureKey: e.feature_key ?? null };
  }
}
