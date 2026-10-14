// In-memory OrganiserDriver for the scenario tests (Task 8). It proves WIRING
// and canary mechanics, never product truth: outcomes come from folding the
// posted stream through the real engine module, standings from the module's
// own standingsDelta, and the rules it mirrors are the product's, each cited.
//
// FakeLeagueDriver is a single-stage LEAGUE and refuses anything else with
// "fake: league only" (Task 9's run-cli test pins that message). FakeSwissDriver
// is the separate swiss fake Task 8 Step 9 allows for, so the swiss branch of
// playStage (per-round generate, pair rounds, byes) is witnessed DB-free, and
// FakeKnockoutDriver does the same for a bracket (M1's progression, F1's
// first-round-only rule).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, deciderPending, forbidsLevelResult, type MatchOutcome, type StageKind } from "@seazn/engine/core";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import { resolvePositions, validateLineup } from "@seazn/engine/sport";
import type { StagePostBody } from "../lib/catalogue.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { feedsNextMatch } from "../../../apps/web/src/lib/bracket-next-match.ts";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { declaredPoints, foldStream, lineupsFor } from "../lib/fold.ts";
import { liveEvents } from "../lib/scenarios/common.ts";
import { entrantKindsFor, resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";

/** A stage config's posted `rules` object, or undefined (R-T12-3: what `stageCfg` layers over the preset). */
export const rulesOfConfig = (config: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined => {
  const r = config?.rules;
  return r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
};
import { DEPARTED_STATUSES } from "../lib/observed.ts";
import { forfeitPosting } from "../lib/streams/index.ts";
import type { ForfeitReason, StreamEvent } from "../lib/streams/types.ts";
import {
  DriverMisuse, LineupUnchecked, RefusedCall, VOID_EVENT, idempotencyKey, inSquadOrder, voidTargetOf,
  type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantInput, type EntrantMember, type EntrantRow, type FixtureRow,
  type AmericanoViewOut, type ChallengeOut, type FixtureStateOut, type FromTemplateAnswer, type FromTemplateOut, type GenerateOut, type LineupChecked, type LineupSlotWire, type MemberInput, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type ScheduledOut, type SeedConfirmOut, type SeedProposalOut, type StageRef, type StagesProbe, type StandingsOut, type StartOut, type VoidedOut, type WithdrawOut,
} from "../lib/driver/types.ts";
import { bracketWithdrawalPolicyText, bracketWithdrawalText, wireCodeFor, withdrawalReason } from "./product-text.ts";
import { fixtureStatusFromFold } from "./w2a-status.ts";

export interface FakeFixture extends FixtureRow { events: StreamEvent[] }

/** A catalog template as the product's JSON spells it (server/templates/catalog). */
export interface RawCatalogTemplate {
  key: string;
  version: number;
  divisions: { sportKey: string; variantKey: string; entrantKind: string; entrantCount: number; stages: { kind: string; groups?: number; points?: unknown; config?: Record<string, unknown>; progression?: unknown }[] }[];
}
const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/web/src/server/templates/catalog");
/** The catalog file, read here as text — never through lib/templates.ts. */
export function rawCatalogTemplate(key: string): RawCatalogTemplate {
  return JSON.parse(readFileSync(join(CATALOG_DIR, `${key}.json`), "utf8")) as RawCatalogTemplate;
}
/** usecases/templates.ts effectiveStageConfig (text-pinned by templates.test.ts). */
function templateStageConfig(st: RawCatalogTemplate["divisions"][number]["stages"][number]): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (st.kind === "group" && st.groups !== undefined) cfg.pools = { count: st.groups };
  if (st.points !== undefined) cfg.points = st.points;
  Object.assign(cfg, st.config ?? {});
  return cfg;
}

/** Key-sorted JSON, the product's canonicalJson comparison (divisions.ts:852-855). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x);
}
function withoutEntrants(c: Record<string, unknown>): Record<string, unknown> {
  const { entrants: _e, ...rest } = c;
  return rest;
}
const BYE_PHANTOM = "__bye__"; // engine-db/competition.ts:79
// lib/table-withdrawal.ts:16-18.
const PLAYED = new Set(["decided", "finalized", "forfeited"]);
const PENDING = new Set(["scheduled", "in_play"]);
/** withdrawal.ts bracketWithdrawalStatus, read from its text (loop F, C-2): the statuses a BRACKET withdrawal walks over
 *  whatever the ledger, and the ones it walks over only while an abandon is active (the cascade voids that abandon
 *  first, D-G2 corner 1). */
const BRACKET_WITHDRAWAL = bracketWithdrawalText();
const BRACKET_WITHDRAW_PENDING: ReadonlySet<string> = new Set(BRACKET_WITHDRAWAL.pending);
const IF_ABANDON_ACTIVE: ReadonlySet<string> = new Set(BRACKET_WITHDRAWAL.ifAbandonActive);
/** The ACTIVE abandons of a fake ledger (a core.abandon no core.void names), by the id fold.ts and `ledger()` give each
 *  event: its seq, as a string. */
export function activeAbandonIds(events: readonly StreamEvent[]): string[] {
  const voided = new Set(events.filter((e) => e.type === "core.void").map((e) => String((e.payload as { event_id?: unknown } | null)?.event_id)));
  return events.flatMap((e, i) => (e.type === "core.abandon" && !voided.has(String(i + 1)) ? [String(i + 1)] : []));
}
/** Does a BRACKET withdrawal act on a fixture of this status (withdrawal.ts: bracketWithdrawalStatus answers
 *  "scheduled")? `abandonActive`: its ledger holds an abandon nothing voided. */
export function bracketWithdrawalActs(status: string, abandonActive: boolean): boolean {
  return BRACKET_WITHDRAW_PENDING.has(status) || (IF_ABANDON_ACTIVE.has(status) && abandonActive);
}
/** withdrawal.ts's bracket-branch policy line, read from its text (owner rulings 53 + 106, loop F; product-text.ts). */
const BRACKET_POLICY = bracketWithdrawalPolicyText();
/** The policy a withdrawal answers after a BRACKET-path stage (WITHDRAWAL_WALKOVER_KINDS: knockout, double_elim,
 *  stepladder, page_playoff, ladder): a `prior` policy an earlier stage set stands; a `none` moves to `walkover` only as
 *  the product's rule says — under rulings 53 + 106 when the planner acted on a line (`acted`: the entrant's fixtures
 *  bracketWithdrawalActs reads as pending), so an entrant with nothing pending answers `none`. `inStage`: the entrant's
 *  fixtures in the stage, what the rule read before ruling 53. */
export function bracketWithdrawalPolicy(prior: WithdrawOut["policy"], inStage: number, acted: number): WithdrawOut["policy"] {
  if (prior !== "none") return prior;
  return (BRACKET_POLICY === "acted" ? acted : inStage) > 0 ? "walkover" : "none";
}
// stages.ts:979 — what the swiss gate counts as a finished board.
const DECIDED = new Set(["decided", "finalized", "forfeited"]);
/** The code the product's structural lineup refusals reach the wire with:
 *  fixtures.ts throws them as codeless HttpError(422), so http.ts's status
 *  default names them (read from the product, product-text.ts). Never
 *  LINEUP_INVALID — that is the engine's event-time assertLineup code
 *  (fix round 1, m-2). */
const LINEUP_REFUSAL = wireCodeFor(422);

/** Runs `body` NOW and settles with what it returns, or REJECTS with what it
 *  throws — exactly what an `async` method with no `await` does, since a
 *  Promise executor's throw rejects. The fake's methods are synchronous in
 *  fact; this keeps each refusal (RefusedCall, "fake: league only", a missing
 *  fixture) arriving as a rejection, as HttpDriver's do, never a sync throw. */
function settle<T>(body: () => T): Promise<T> {
  return new Promise<T>((resolve) => { resolve(body()); });
}

export class FakeLeagueDriver implements OrganiserDriver {
  readonly calls: string[] = [];
  /** PF-4 (W1-driving Task 4): `calls` one for one, each line the bare method
   *  name followed by the ids the call named where the method passes them
   *  (`postStream <fixture>`, `putLineup <fixture> <entrant>`). Additive:
   *  `calls` keeps its bare names, so every assert written against it holds. */
  readonly trace: string[] = [];
  readonly orgId: string;
  sport = "";
  variant = "";
  /** The cfg fixtures are scored under (frozen at create, like config_snapshot). */
  cfg: unknown = null;
  /** What getDivision answers and what the format lock compares against. */
  divisionConfig: Record<string, unknown> = {};
  stage: StageRef | null = null;
  entrants: EntrantRow[] = [];
  fixtures: FakeFixture[] = [];
  completed = false;
  constructor(orgId = "org-fake") { this.orgId = orgId; }
  get callCount(): number { return this.calls.length; }
  log(m: string, ...ids: string[]): void {
    this.calls.push(m);
    this.trace.push([m, ...ids].join(" "));
  }
  /** Roster members stored across every entrant (W1-driving Task 4). */
  memberCount(): number {
    let n = 0;
    for (const ms of this.members.values()) n += ms.length;
    return n;
  }
  /** The fixtures a posted stream finished, in fixture order: a terminal
   *  status reached through events. A bye's award, written at generation with
   *  no event, is not one (W1-driving Task 4). */
  decidedFixtureIds(): string[] {
    return this.fixtures.filter((f) => DECIDED.has(f.status) && f.events.length > 0).sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0)).map((f) => f.id);
  }

  createCompetition(i: { name: string; slug: string }): Promise<CompetitionRef> { return settle(() => { this.log("createCompetition"); return { id: "c1", slug: i.slug, orgId: this.orgId }; }); }
  createDivision(_c: string, i: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return settle(() => {
      this.log("createDivision");
      this.sport = i.sportKey;
      this.variant = i.variantKey;
      // divisions.ts createDivision stores the PARSED preset+overrides, and the
      // fixtures are scored under it (config_snapshot) — overrides included.
      this.cfg = resolveSportCfg(i.sportKey, i.variantKey, i.config ?? {});
      this.divisionConfig = { ...(resolveSportCfg(i.sportKey, i.variantKey, i.config ?? {}) as Record<string, unknown>) };
      return { id: "d1", slug: i.slug, sportKey: i.sportKey, variantKey: i.variantKey, config: { ...this.divisionConfig } };
    });
  }
  getDivision(): Promise<DivisionRef> {
    return settle(() => {
      this.log("getDivision");
      return { id: "d1", slug: "d", sportKey: this.sport, variantKey: this.variant, config: { ...this.divisionConfig } };
    });
  }
  acceptsStage(kind: string): boolean { return kind === "league"; }
  refuseStages(): never { throw new Error("fake: league only"); }
  postStages(_d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    return settle(() => {
      this.log("postStages");
      if (stages.length !== 1 || !this.acceptsStage(stages[0].kind)) this.refuseStages();
      this.stage = { id: "s1", seq: 1, kind: stages[0].kind, config: { ...stages[0].config }, status: "pending" };
      return [this.stage];
    });
  }
  listStages(): Promise<StageRef[]> { return settle(() => { this.log("listStages"); return this.stage ? [{ ...this.stage }] : []; }); }

  // --- W1-driving Task 13: the product's from-template -------------------------------------------------
  // usecases/templates.ts createFromTemplate (pinned at 32e942711): one
  // competition, its catalog division (sport, variant, the parsed preset), the
  // stage rows at seq si + 1 with effectiveStageConfig's config and the
  // progression verbatim, and NO entrant (templates.ts:351-366). The league
  // fake holds one stage, so a multi-stage template is refused by name.
  /** Every createFromTemplate the HTTP path made, as asked. */
  readonly templateCalls: { key: string; input: { name: string; endsOn: string } }[] = [];
  /** A test's edit of the catalog JSON before the fake instantiates it. */
  templateOverride: ((raw: RawCatalogTemplate) => RawCatalogTemplate) | null = null;
  #instantiate(key: string): FromTemplateAnswer {
    const raw0 = rawCatalogTemplate(key);
    const raw = this.templateOverride === null ? raw0 : this.templateOverride(raw0);
    const d = raw.divisions[0];
    if (raw.divisions.length !== 1 || d.stages.length !== 1) throw new Error(`fake: league only — the league fake instantiates a one-division, one-stage template (${key} has ${raw.divisions.length} division(s), ${d.stages.length} stage(s))`);
    this.sport = d.sportKey;
    this.variant = d.variantKey;
    this.cfg = resolveSportCfg(d.sportKey, d.variantKey, {});
    this.divisionConfig = { ...(resolveSportCfg(d.sportKey, d.variantKey, {}) as Record<string, unknown>) };
    const st = d.stages[0];
    this.stage = { id: "s1", seq: 1, kind: st.kind, config: templateStageConfig(st), status: "pending" };
    return { competitionId: "c1", slug: `tmpl-${key}`, visibility: "public", divisions: [{ id: "d1", stages: [{ id: "s1", fixtureCount: 0 }] }], templateKey: key, templateVersion: raw.version };
  }
  #readBack(a: FromTemplateAnswer): FromTemplateOut {
    return {
      competition: { id: a.competitionId, slug: a.slug, orgId: this.orgId },
      division: { id: a.divisions[0].id, slug: "d", sportKey: this.sport, variantKey: this.variant, config: { ...this.divisionConfig } },
      stages: this.stage === null ? [] : [{ ...this.stage }],
    };
  }
  /** The card's product side (what the gallery's POST does), for the browser tests' fake page. */
  instantiateTemplate(key: string): FromTemplateAnswer { this.log("instantiateTemplate", key); return this.#instantiate(key); }
  /** HttpDriver.readBackTemplate's product side; `trace` keeps the key the caller asked for (T13-R1 m-7). */
  readBackTemplate(a: FromTemplateAnswer, key: string): Promise<FromTemplateOut> { return settle(() => { this.log("readBackTemplate", key); return this.#readBack(a); }); }
  createFromTemplate(key: string, input: { name: string; endsOn: string }): Promise<FromTemplateOut> {
    return settle(() => {
      this.log("createFromTemplate", key);
      this.templateCalls.push({ key, input: { ...input } });
      return this.#readBack(this.#instantiate(key));
    });
  }
  /** entrant id → its stored roster, in the product's order; person ids `p-<entrant>-<m>`. */
  members = new Map<string, EntrantMember[]>();
  /** `<fixture>|<entrant>` → the lineup last PUT (fixtures.ts putLineup replaces it whole). */
  readonly lineups = new Map<string, LineupSlotWire[]>();
  rosterOf(entrantId: string, ms: readonly MemberInput[]): EntrantMember[] {
    return inSquadOrder(ms.map((m, k) => ({ person_id: `p-${entrantId}-${k + 1}`, squad_number: m.squadNumber, is_captain: m.isCaptain })));
  }
  addEntrants(_d: string, es: readonly EntrantInput[]): Promise<EntrantRow[]> {
    return settle(() => {
      this.log("addEntrants");
      // `kind`: the product serves it on every row (entrants.ts COLS), as posted (T12-R1).
      this.entrants = es.map((e, i) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered", kind: e.kind }));
      // Inline members (schemas.ts CreateEntrant): stored with the entrant they came on.
      this.members = new Map(es.flatMap((e, i) => (e.members === undefined ? [] : [[`e${i + 1}`, this.rosterOf(`e${i + 1}`, e.members)] as const])));
      return this.entrants.map((e) => ({ ...e }));
    });
  }
  listEntrants(): Promise<EntrantRow[]> { return settle(() => { this.log("listEntrants"); return this.entrants.map((e) => ({ ...e })); }); }
  #entrant(method: string, entrantId: string): void {
    // entrants.ts getEntrant / patchEntrant: an unknown entrant is a 404.
    if (!this.entrants.some((e) => e.id === entrantId)) throw new RefusedCall(method, `/api/v1/entrants/${entrantId}`, 404, "NOT_FOUND", "entrant not found");
  }
  entrantMembers(entrantId: string): Promise<EntrantMember[]> {
    return settle(() => {
      this.log("entrantMembers");
      this.#entrant("GET", entrantId);
      return (this.members.get(entrantId) ?? []).map((m) => ({ ...m }));
    });
  }
  /** HttpDriver.setMembers's product side: the persons, then the PATCH's full replacement. */
  setMembers(entrantId: string, ms: readonly MemberInput[]): Promise<EntrantMember[]> {
    return settle(() => {
      this.log("setMembers");
      if (ms.length === 0) throw new Error("fake: setMembers with no members (HttpDriver refuses it before any call)");
      this.#entrant("PATCH", entrantId);
      this.members.set(entrantId, this.rosterOf(entrantId, ms));
      return (this.members.get(entrantId) ?? []).map((m) => ({ ...m }));
    });
  }
  /** fixtures.ts putLineup, in its order: the entrant must be a side of the
   *  fixture, the fixture `scheduled`, no person twice, and every person the
   *  entrant's member; then the lineup is replaced whole and CHECKED, warning
   *  only: the answer is `{ checked: true, warnings }`, the warnings the
   *  engine's validateLineup on the division's stored cfg. The warning TEXT is
   *  the fake's own (each issue as JSON); the product formats them in
   *  fixtures.ts formatLineupIssue. */
  putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<LineupChecked> {
    return settle(() => {
      // Carry n-1: HttpDriver refuses an empty lineup before any call (the
      // product would DELETE the stored one and answer 2xx); so does the fake.
      if (slots.length === 0) throw new DriverMisuse(`driver: putLineup for entrant ${entrantId} on fixture ${fixtureId} with no slots — the product would delete its lineup and answer 2xx, never refuse`);
      this.log("putLineup", fixtureId, entrantId);
      const path = `/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`;
      const f = this.#f(fixtureId);
      if (f.home_entrant_id !== entrantId && f.away_entrant_id !== entrantId) throw new RefusedCall("PUT", path, 422, LINEUP_REFUSAL, "entrant is not a side of this fixture");
      if (f.status !== "scheduled") throw new RefusedCall("PUT", path, 422, LINEUP_REFUSAL, `lineup is locked once a fixture is ${f.status}`);
      if (new Set(slots.map((s) => s.person_id)).size !== slots.length) throw new RefusedCall("PUT", path, 422, LINEUP_REFUSAL, "duplicate person in lineup");
      const roster = new Set((this.members.get(entrantId) ?? []).map((m) => m.person_id));
      if (slots.some((s) => !roster.has(s.person_id))) throw new RefusedCall("PUT", path, 422, LINEUP_REFUSAL, "lineup contains a person who is not a member of the entrant");
      const stored = slots.map((s) => ({ ...s, ...(s.roles !== undefined ? { roles: [...s.roles] } : {}) }));
      this.lineups.set(`${fixtureId}|${entrantId}`, stored);
      let issues: ReturnType<typeof validateLineup>;
      try {
        issues = validateLineup(resolvePositions(sportModule(this.sport) as never, this.cfg as never), {
          entrantId,
          slots: stored.map((s, i) => ({ personId: s.person_id, slot: s.slot, ...(s.position_key !== undefined ? { positionKey: s.position_key } : {}), roles: [...(s.roles ?? [])], orderNo: s.order_no ?? i + 1 })),
        });
      } catch (err) {
        // The product answers `checked: false, reason: <error kind>` and has
        // already saved; HttpDriver refuses that answer as LineupUnchecked.
        throw new LineupUnchecked(fixtureId, entrantId, err instanceof Error ? err.name : "unknown");
      }
      return { checked: true, warnings: issues.map((x) => JSON.stringify(x)) };
    });
  }
  /** Circle-method rounds over the entrant ids, "BYE" padding an odd field. */
  circle(): [string, string][][] {
    const ring = this.entrants.length % 2 === 0 ? this.entrants.map((e) => e.id) : [...this.entrants.map((e) => e.id), "BYE"];
    const rounds: [string, string][][] = [];
    for (let r = 0; r < ring.length - 1; r++) {
      const pairs: [string, string][] = [];
      for (let i = 0; i < ring.length / 2; i++) pairs.push([ring[i], ring[ring.length - 1 - i]]);
      rounds.push(pairs);
      ring.splice(1, 0, ring.pop()!);
    }
    return rounds;
  }
  /** Last fixture number handed out: ids stay unique when a subclass deletes rows. */
  minted = 0;
  seat(round: number, home: string | null, away: string | null, extra: Partial<FakeFixture> = {}): FakeFixture {
    const no = ++this.minted;
    const f: FakeFixture = { id: `f${no}`, stage_id: "s1", pool_id: null, round_no: round, fixture_no: no, home_entrant_id: home, away_entrant_id: away, status: "scheduled", outcome: null, events: [], ...extra };
    this.fixtures.push(f);
    return f;
  }
  start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      for (const [r, pairs] of this.circle().entries()) {
        for (const [h, a] of pairs) if (h !== "BYE" && a !== "BYE") this.seat(r + 1, h, a);
      }
      this.stage!.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
    });
  }
  rows(): FixtureRow[] { return this.fixtures.map(({ events: _e, ...f }) => ({ ...f })); }
  generate(): Promise<GenerateOut> { return settle(() => { this.log("generate"); return { created: 0, existing: this.fixtures.length, fixtures: this.rows() }; }); }
  listFixtures(): Promise<FixtureRow[]> { return settle(() => { this.log("listFixtures"); return this.rows(); }); }
  fixtureState(id: string): Promise<FixtureStateOut> { return settle(() => { this.log("fixtureState"); const f = this.#f(id); return { status: f.status, last_seq: f.events.length, outcome: f.outcome }; }); }
  /** One event at a time, like HttpDriver's POST per event: each answer
   *  carries the fixture's status and outcome AFTER that event, and a refused
   *  event leaves the ones before it appended. */
  /** fixture id → idempotency key → the answer it was first given. The
   *  product's unique (fixture_id, idempotency_key) index REPLAYS that answer
   *  on a duplicate and appends nothing (scoring.ts, append-event.ts). */
  readonly keys = new Map<string, Map<string, PostedEvent>>();
  postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    return settle(() => {
      this.log("postStream", id);
      const f = this.#f(id);
      const seen = this.keys.get(id) ?? new Map<string, PostedEvent>();
      this.keys.set(id, seen);
      const out: PostedEvent[] = [];
      for (const ev of events) {
        // HttpDriver's key for this event: the same shared function, at the seq it expects.
        const key = idempotencyKey(prefix, f.events.length);
        const replay = seen.get(key);
        if (replay !== undefined) { out.push(replay); continue; }
        this.#append(f, ev);
        const posted: PostedEvent = { seq: f.events.length, status: f.status, outcome: f.outcome, event_id: `${id}-${f.events.length}` };
        seen.set(key, posted);
        out.push(posted);
      }
      return out;
    });
  }
  /** Appends one event the way the product does: the whole ledger is folded with it (voids resolved), a refusal
   *  leaves the ledger as it was, and the fixture's outcome and status follow the fold. A fold that reaches no
   *  outcome is `in_play` — also the fold of a ledger voided back to nothing, which the product would hold at
   *  `scheduled` until a start is recorded (the fake does not model that corner). */
  #append(f: FakeFixture, ev: StreamEvent): void {
    const next = [...f.events, ev];
    let folded: ReturnType<typeof foldStream>;
    const kind = this.stageKindOf(f);
    try {
      // W2a: the product folds a bracket fixture under the stage's overlay (resolveFixtureCfg), and the status follows D3.
      folded = foldStream(sportModule(this.sport), this.foldCfgOf(f), f.home_entrant_id!, f.away_entrant_id!, next);
    } catch (e) {
      // The product turns ONLY an EngineError into a status (http.ts:157-158);
      // anything else is a 500 INTERNAL there (http.ts:244-247). Here that is a
      // harness fault, so it surfaces as itself, never as an engine refusal.
      if (!EngineError.is(e)) throw e;
      throw new RefusedCall("POST", `/api/v1/fixtures/${f.id}/events`, engineHttpStatus(e.code), e.code, e.message);
    }
    // W2a (GN-KO-1, spec §5.4 item 3): a WRITE guard of the product (append-event.ts), not a fold refusal — a generic
    // draw in a bracket kind is refused and nothing is written. Every other level result is accepted and held.
    if (this.sport === "generic" && kind !== null && forbidsLevelResult(kind) && folded.outcome?.kind === "draw") {
      throw new RefusedCall("POST", `/api/v1/fixtures/${f.id}/events`, 409, "LEVEL_RESULT_IN_BRACKET", "A knockout match can't end level — enter the winner.");
    }
    f.events = next;
    f.outcome = folded.outcome;
    f.status = fixtureStatusFromFold(folded.outcome, liveEvents(next), kind);
  }
  /** The kind of the stage a fixture belongs to: this fake plays one stage (a subclass with several overrides it). */
  protected stageKindOf(_f: FakeFixture): string | null { return this.stage?.kind ?? null; }
  /** The `config.rules` the fixture's stage was POSTED with (R-T12-3): the product stores them over the preset and folds
   *  under both, which `stageCfg` layers. */
  protected stageRulesOf(_f: FakeFixture): Readonly<Record<string, unknown>> | undefined { return rulesOfConfig(this.stage?.config); }
  /** The cfg a fixture folds under: the division's, or its stage's (presets, posted rules, a bracket's deciders). */
  protected foldCfgOf(f: FakeFixture): unknown {
    const kind = this.stageKindOf(f);
    return kind === null ? this.cfg : stageCfg(this.sport, this.cfg, kind as StageKind, this.variant, this.stageRulesOf(f));
  }
  /** W1d Task 14: the fixture's ledger as the product serves it — a row per event, seq from 1, the id the seq as a
   *  string (the id space the harness's own void names, fold.ts envelopes), exclusive of `sinceSeq`. */
  ledger(id: string, sinceSeq = 0): Promise<readonly LedgerRow[]> {
    return settle(() => {
      this.log("ledger", id);
      return this.#f(id).events.map((e, i): LedgerRow => ({ id: String(i + 1), seq: i + 1, type: e.type, payload: e.payload })).filter((r) => r.seq > sinceSeq);
    });
  }
  /** The console's "Void last entry": the newest event that is neither a core.void nor already voided (the shared
   *  rule, voidTargetOf), voided by appending `core.void {event_id}`. Nothing to void is refused before any write. */
  voidLast(id: string): Promise<VoidedOut> {
    return settle(() => {
      this.log("voidLast", id);
      const f = this.#f(id);
      const rows = f.events.map((e, i): LedgerRow => ({ id: String(i + 1), seq: i + 1, type: e.type, payload: e.payload }));
      const target = voidTargetOf(rows);
      if (target === null) throw new DriverMisuse(`fake: voidLast on fixture ${id} — nothing to void (${rows.length} ledger row(s), none that is neither a ${VOID_EVENT} nor already voided)`);
      this.#append(f, { type: VOID_EVENT, payload: { event_id: target.id } });
      return { voidedEventId: target.id, voidedType: target.type };
    });
  }
  /** W1d Task 14: the phase the fake's desk serves for every division (HttpDriver.divisionPhase). The fake does not
   *  derive it from its fixtures — that is the product's rule (division-phase.ts), not the fake's to model — so a
   *  test sets it. */
  phase = "scheduled";
  divisionPhase(_competitionId: string, _divisionId: string): Promise<string> {
    return settle(() => {
      this.log("divisionPhase");
      return this.phase;
    });
  }
  /** W1d Task 14: what the fake's clock reads when it dates a fixture "now"; a test sets it. */
  now: () => Date = () => new Date();
  scheduleFixtureNow(id: string): Promise<ScheduledOut> {
    return settle(() => {
      this.log("scheduleFixtureNow", id);
      const f = this.#f(id);
      f.scheduled_at = this.now().toISOString();
      return { scheduledAt: f.scheduled_at };
    });
  }
  async forfeit(id: string, by: string, reason: ForfeitReason, prefix = "", play: readonly StreamEvent[] = []): Promise<PostedEvent[]> {
    this.log("forfeit");
    // http-driver.ts forfeit: the shared composition (W2b: a walkover bare, before START).
    return this.postStream(id, forfeitPosting(this.#f(id).status, { by, reason }, play), prefix);
  }
  /** withdrawal.ts:130-200 + stage.ts withdrawTableEntrant: played < 50% of
   *  (played + pending) expunges, otherwise pending games walk over; finalized
   *  and cancelled are skipped; a TBD opponent is voided, not walked over; an
   *  opponent who already left (X-WD-4, Loop R M-4: no bracket scope) makes the
   *  line a recorded double walkover, unless it holds live play (M-1: left as
   *  it is, and not counted). */
  expungesEarly(): boolean { return true; }
  async withdraw(entrantId: string): Promise<WithdrawOut> {
    this.log("withdraw");
    const mine = this.fixtures.filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);
    const played = mine.filter((f) => PLAYED.has(f.status) && f.outcome !== null);
    const pending = mine.filter((f) => PENDING.has(f.status));
    const total = played.length + pending.length;
    const policy = this.expungesEarly() && (total === 0 ? 0 : played.length / total) < 0.5 ? "expunge" : "walkover";
    let walkovers = 0;
    let voided = 0;
    let skipped = 0;
    const gone = new Set(this.entrants.filter((e) => e.status === "withdrawn").map((e) => e.id));
    const touched = policy === "expunge" ? [...played, ...pending] : pending;
    for (const f of touched) {
      if (f.status === "finalized" || f.status === "cancelled") { skipped++; continue; }
      const opponent = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
      if (policy === "walkover" && opponent !== null && gone.has(opponent)) {
        if (liveEvents(f.events).length === 0) { await this.doubleWalkoverFixture(f); walkovers++; }
        continue;
      }
      if (policy === "walkover" && opponent !== null) { await this.walkoverFixture(f, entrantId); walkovers++; continue; }
      await this.abandonFixture(f);
      voided++;
    }
    this.entrants.find((e) => e.id === entrantId)!.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy, walkovers, voided, skipped_finalized: skipped, walked_over_held: 0 };
  }
  /** withdrawal.ts `held` (the plan's N1, `walked_over_held`): a line that used to wait for the organiser's settle —
   *  needs_decision (a held level result), an active abandon, or in play with a decider still owed (the engine's own
   *  `deciderPending` over the fold, a chess tie-break: R14). */
  heldForWithdrawal(f: FakeFixture): boolean {
    if (f.status === "needs_decision" || this.abandonActive(f)) return true;
    if (f.status !== "in_play" || f.home_entrant_id === null || f.away_entrant_id === null) return false;
    const m = sportModule(this.sport);
    const folded = foldStream(m, this.foldCfgOf(f), f.home_entrant_id, f.away_entrant_id, this.tableEvents(f));
    return deciderPending(m as never, { state: folded.state as never, settlement: null });
  }
  /** The fixture's ledger holds an abandon nothing voided (withdrawal.ts activeAbandons). */
  abandonActive(f: FakeFixture): boolean { return activeAbandonIds(this.tableEvents(f)).length > 0; }
  /** withdrawal.ts applyUpdate's bracket walkover: an active abandon is voided first (D4 refuses a forfeit over it), then
   *  the bare core.forfeit with the cascade's own REASON. */
  async walkOverForWithdrawal(f: FakeFixture, by: string): Promise<void> {
    for (const id of activeAbandonIds(f.events)) await this.postStream(f.id, [{ type: "core.void", payload: { event_id: id } }]);
    await this.postStream(f.id, [{ type: "core.forfeit", payload: { by, reason: WITHDRAWAL_REASON } }]);
  }
  /** The walkover of one pending fixture. This table fake composes it as
   *  HttpDriver.forfeit does (START first on a scheduled fixture);
   *  ModelFakeDriver posts withdrawal.ts's bare forfeit instead. */
  async walkoverFixture(f: FakeFixture, by: string): Promise<void> {
    await this.forfeit(f.id, by, "walkover");
  }
  /** X-WD-4 on a table (Loop R M-4): both sides gone — the double walkover, composed as walkoverFixture is. */
  async doubleWalkoverFixture(f: FakeFixture): Promise<void> {
    await this.forfeit(f.id, "both", "walkover");
  }
  /** The expunge's void of one fixture. This table fake writes the status
   *  directly, with no event, so a later post would fold over it (Task 1
   *  review); ModelFakeDriver rides the ledger instead, as the product does. */
  abandonFixture(f: FakeFixture): Promise<void> {
    return settle(() => {
      f.status = "abandoned";
      f.outcome = null;
    });
  }
  /** W1-driving Task 6: a single stage has no later stage to seed. The
   *  product refuses a recompute on a stage with no progression (422
   *  SEEDING_RULES_MISSING, computeSeedProposal) and a confirm of a proposal
   *  it never minted (404, codeless). FakeMultiStageDriver models the advance. */
  recomputeSeedProposal(stageId: string): Promise<SeedProposalOut> {
    return settle(() => {
      this.log("recomputeSeedProposal", stageId);
      throw new RefusedCall("POST", `/api/v1/stages/${stageId}/seed-proposal`, 422, "SEEDING_RULES_MISSING", "this stage has no progression rules");
    });
  }
  confirmSeedProposal(stageId: string, body: { proposalId: string }): Promise<SeedConfirmOut> {
    return settle(() => {
      this.log("confirmSeedProposal", stageId, body.proposalId);
      throw new RefusedCall("POST", `/api/v1/stages/${stageId}/seed-proposal/confirm`, 404, wireCodeFor(404), "seed proposal not found");
    });
  }
  /** W1-driving T7: challenges exist on ladder stages only — stages.ts
   *  issueChallenge throws a CODELESS 422, so the wire code is http.ts's
   *  default for the status (read from the product). FakeLadderDriver
   *  (fake-formats-driver.ts) models a ladder. */
  challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut> {
    return settle(() => {
      this.log("challenge", stageId, challengerId, opponentId);
      throw new RefusedCall("POST", `/api/v1/stages/${stageId}/challenges`, 422, wireCodeFor(422), "challenges only exist on ladder stages");
    });
  }
  /** W1-driving Task 8: the americano read model exists on americano stages
   *  only — usecases/americano.ts americanoView throws a CODELESS 422, so the
   *  wire code is http.ts's default for the status (read from the product).
   *  FakeAmericanoDriver (fake-formats-driver.ts) models one. */
  americanoView(stageId: string): Promise<AmericanoViewOut> {
    return settle(() => {
      this.log("americanoView", stageId);
      throw new RefusedCall("GET", `/api/v1/stages/${stageId}/americano`, 422, wireCodeFor(422), "not an americano stage");
    });
  }
  /** The table fake models no rebuild; refused by name (Task 13). */
  rebuild(_stageId: string): Promise<void> {
    return settle(() => {
      this.log("rebuild");
      throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 422, "UNSUPPORTED_IN_FAKE", "fake: rebuild");
    });
  }
  completeStage(): Promise<CompleteOut> {
    return settle(() => {
      this.log("completeStage");
      this.completed = this.fixtures.every((f) => f.status !== "scheduled" && f.status !== "in_play");
      return { completed: this.completed, events: [] };
    });
  }
  /** The table the product folds: [home, away] deltas from standingsDelta over
   *  each result, and a one-sided award (bye) scored the way
   *  engine-db/competition.ts awardByeDelta does it. */
  /** Who the table folds over: the division's entrants. An americano stage
   *  folds over its SIDES instead (FakeAmericanoDriver). */
  tableEntrants(): string[] { return this.entrants.map((e) => e.id); }
  /** The events the table folds for a fixture: the ones it holds (ModelFakeDriver: its ledger's LIVE entries, voids
   *  resolved — its fixtures' `events` keep every core.void, whose target id the fold cannot read). */
  tableEvents(f: FakeFixture): readonly StreamEvent[] { return f.events; }
  standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    return settle(() => {
      this.log("standings");
      const pts = new Map(this.tableEntrants().map((id) => [id, 0]));
      // W2b (X-WO-1): the rest of the row as engine StandingsRow carries it — played/won/drawn/lost and the metrics,
      // summed from the same standingsDelta the points come from. The points (and so the ranks) are unchanged.
      type Detail = { played: number; won: number; drawn: number; lost: number; metrics: Record<string, number> };
      const detail = new Map<string, Detail>(this.tableEntrants().map((id) => [id, { played: 0, won: 0, drawn: 0, lost: 0, metrics: {} }]));
      const add = (d: { entrantId: string; played: number; won: number; drawn: number; lost: number; metrics: Record<string, number> }) => {
        const row = detail.get(d.entrantId);
        if (row === undefined) return;
        row.played += d.played; row.won += d.won; row.drawn += d.drawn; row.lost += d.lost;
        for (const [k, v] of Object.entries(d.metrics)) row.metrics[k] = (row.metrics[k] ?? 0) + v;
      };
      const m = sportModule(this.sport);
      const kind = this.stage!.kind as StageKind;
      const cfg = stageCfg(this.sport, this.cfg, kind, this.variant, rulesOfConfig(this.stage!.config)); // W2a: the cfg the stage's fixtures were folded under
      for (const f of this.fixtures) {
        if (f.outcome === null) continue;
        const ctx = { kind, ...(f.round_no ? { roundNo: f.round_no } : {}) };
        if (f.home_entrant_id === null || f.away_entrant_id === null) {
          const o = f.outcome as MatchOutcome;
          if (o.kind !== "award") continue;
          const home = f.home_entrant_id === o.winner;
          const state: unknown = m.init(cfg, lineupsFor(home ? o.winner : BYE_PHANTOM, home ? BYE_PHANTOM : o.winner));
          // The product's awardByeDelta (engine-db/competition.ts, W2b C-5): the module is handed the TYPED bye whatever
          // the row stores — ruling 116's one-sided award names a withdrawn loser no lineup holds.
          const bye = { kind: "award", winner: o.winner, loser: null, reason: "bye" } as MatchOutcome;
          const pair = m.standingsDelta(bye, cfg, ctx, state);
          const won = pair.find((d) => d.entrantId === o.winner)!;
          pts.set(o.winner, pts.get(o.winner)! + won.points);
          add(won);
          continue;
        }
        const events = this.tableEvents(f);
        const d = declaredPoints(m, cfg, ctx, f.home_entrant_id, f.away_entrant_id, events)!;
        pts.set(f.home_entrant_id, pts.get(f.home_entrant_id)! + d.home);
        pts.set(f.away_entrant_id, pts.get(f.away_entrant_id)! + d.away);
        const folded = foldStream(m, cfg, f.home_entrant_id, f.away_entrant_id, events);
        if (folded.outcome !== null) for (const x of m.standingsDelta(folded.outcome, cfg, ctx, folded.state)) add(x);
      }
      const rows = [...pts].sort((a, b) => b[1] - a[1]).map(([entrantId, points], i) => ({ entrantId, rank: i + 1, points, ...detail.get(entrantId)! }));
      return { stage_id: stageId, pool_id: poolId, rows };
    });
  }
  async publicStandings(): Promise<PublicStandingsOut> {
    this.log("publicStandings");
    return { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: (await this.standings("s1", null)).rows }] };
  }
  /** The distinct kinds of the division's ACTIVE entrants — divisions.ts:857-871
   *  `select distinct kind from entrants where … status not in ('withdrawn',
   *  'disqualified')`. A row with no kind names none. The americano fake adds
   *  the pair entrants its stage mints. */
  kindsInUse(): string[] {
    return [...new Set(this.entrants.filter((e) => !DEPARTED_STATUSES.includes(e.status)).flatMap((e) => (e.kind === undefined ? [] : [e.kind])))];
  }
  /** Has any fixture of the stage started? The product's predicate (rule-locks.ts `lockedStageIdsAmong`): a fixture that
   *  holds an event (its config freezes at the first one). The table fake's expunge writes `abandoned` with no event,
   *  where the product writes a score event, so that status counts too. Generated-but-unplayed fixtures start nothing,
   *  and neither does a bye's award (decided at generation, with no event). */
  stageStarted(): boolean {
    return this.fixtures.some((f) => f.events.length > 0 || f.status === "abandoned");
  }
  /** usecases/divisions.ts patchDivision (W2c, X-SR-4, owner P-2 "A"): the lock is per STARTED stage that INHERITS a
   *  key. A config that does not parse is 422 CONFIG_INVALID whether or not anything started; once a stage started, a
   *  change to anything but `entrants` is 409 DIVISION_FORMAT_LOCKED (a match-format key — the keys this fake's probes
   *  edit; a table key would be DIVISION_TABLE_RULES_LOCKED, which no probe sends); a model that no longer accepts an
   *  active entrant's kind is 422 ENTRANT_KIND_IN_USE; otherwise it saves. The fake plays stages that post no
   *  per-stage `rules`, so a started stage inherits every key — and it refuses to run if one ever does. */
  patchDivisionConfig(_d: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
    return settle(() => {
      this.log("patchDivisionConfig");
      if (this.stage !== null && this.stage.config.rules !== undefined) throw new Error("fake: a stage with its own match rules — per-stage inheritance is not modelled here");
      const locked = this.stageStarted();
      let parsed: Record<string, unknown>;
      try {
        parsed = resolveSportCfg(this.sport, this.variant, config) as Record<string, unknown>;
      } catch {
        return { status: 422, code: "CONFIG_INVALID" };
      }
      if (locked && canonical(withoutEntrants(parsed)) !== canonical(withoutEntrants(this.divisionConfig))) return { status: 409, code: "DIVISION_FORMAT_LOCKED" };
      const entrants = config.entrants;
      const next = entrantKindsFor(this.sport, entrants != null && typeof entrants === "object" ? { ...parsed, entrants } : parsed);
      if (this.kindsInUse().some((k) => !next.includes(k))) return { status: 422, code: "ENTRANT_KIND_IN_USE" };
      this.divisionConfig = entrants != null && typeof entrants === "object" ? { ...parsed, entrants } : parsed;
      return { status: 200, code: null };
    });
  }
  /** The league fake models no stage replacement: FakeDeniedDriver does. */
  replaceStagesProbe(_d: string, _stages: readonly StagePostBody[]): Promise<StagesProbe> {
    return settle(() => {
      this.log("replaceStagesProbe");
      return { status: 422, code: "UNSUPPORTED_IN_FAKE", featureKey: null };
    });
  }
  #f(id: string): FakeFixture { const f = this.fixtures.find((x) => x.id === id); if (!f) throw new Error(`fake: no fixture ${id}`); return f; }
}

/** A single swiss stage, shaped like the product's (stages.ts swissGen):
 *  - Start's Generate mints an EMPTY shell per board, plus a bye shell on an
 *    odd field, for every round of the budget, and seats nobody
 *    (swiss-shell.ts planSwissShells);
 *  - each later Generate seats the next unseated round onto its shells
 *    (UPDATE, so `created` is 0), refused STAGE_NOT_READY while the round
 *    before it has an undecided seated board;
 *  - the round being seated is first reshaped to the ACTIVE field
 *    (reconcileSwissRoundShells: surplus board shells dropped from the tail, a
 *    bye shell minted or dropped).
 *  Pairs come from the circle method so none repeats; a withdrawn opponent or
 *  the odd one out gets the bye — a one-sided forfeited AWARD row
 *  `{kind: "award", winner}`. Swiss never expunges (withdrawal.ts:6-8). */
export class FakeSwissDriver extends FakeLeagueDriver {
  schedule: [string, string][][] = [];
  paired = 0;
  /** The bye shell ids (the product's `sw-r<n>-bye` ext_key). */
  readonly byeShells = new Set<string>();
  override acceptsStage(kind: string): boolean { return kind === "swiss"; }
  override refuseStages(): never { throw new Error("fake: swiss only"); }
  override expungesEarly(): boolean { return false; }
  get budget(): number { return Number(this.stage!.config.rounds); }
  /** Who no longer gets paired (the withdrawn). */
  sittingOut(): Set<string> { return new Set(this.entrants.filter((e) => e.status === "withdrawn").map((e) => e.id)); }
  mintShells(round: number, boards: number, bye: boolean): void {
    for (let b = 0; b < boards; b++) this.seat(round, null, null);
    if (bye) this.byeShells.add(this.seat(round, null, null).id);
  }
  /** Seats round paired+1 onto its shells; returns how many rows it seated. */
  pairNext(): number {
    const r = this.paired + 1;
    const pairs = this.schedule[r - 1];
    if (pairs === undefined || r > this.budget) return 0;
    const out = this.sittingOut();
    const boards: [string, string][] = [];
    const byes: string[] = [];
    for (const [h, a] of pairs) {
      const hOut = h === "BYE" || out.has(h);
      const aOut = a === "BYE" || out.has(a);
      if (hOut && aOut) continue;
      if (hOut || aOut) byes.push(hOut ? a : h);
      else boards.push([h, a]);
    }
    const active = this.entrants.length - out.size;
    const want = { boards: Math.floor(active / 2), bye: active % 2 === 1 };
    // stages.ts: "swiss shell count mismatch for pairing" (CONFIG_INVALID).
    if (boards.length !== want.boards || byes.length !== (want.bye ? 1 : 0)) throw new Error(`fake: round ${r} pairs ${boards.length}+${byes.length}, the active field wants ${want.boards}+${want.bye ? 1 : 0}`);
    const shells = this.fixtures.filter((f) => f.round_no === r);
    const boardShells = shells.filter((f) => !this.byeShells.has(f.id));
    let byeShell = shells.find((f) => this.byeShells.has(f.id));
    const doomed = new Set([...boardShells.slice(want.boards), ...(byeShell !== undefined && !want.bye ? [byeShell] : [])].map((f) => f.id));
    this.fixtures = this.fixtures.filter((f) => !doomed.has(f.id));
    const kept = boardShells.slice(0, want.boards);
    while (kept.length < want.boards) kept.push(this.seat(r, null, null));
    if (want.bye && byeShell === undefined) {
      byeShell = this.seat(r, null, null);
      this.byeShells.add(byeShell.id);
    }
    boards.forEach(([h, a], i) => Object.assign(kept[i], { home_entrant_id: h, away_entrant_id: a }));
    if (want.bye) Object.assign(byeShell!, { home_entrant_id: byes[0], status: "forfeited", outcome: { kind: "award", winner: byes[0], loser: null, reason: "bye" } });
    this.paired = r;
    return boards.length + byes.length;
  }
  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      this.schedule = this.circle();
      const n = this.entrants.length;
      for (let r = 1; r <= this.budget; r++) this.mintShells(r, Math.floor(n / 2), n % 2 === 1);
      this.stage!.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
    });
  }
  override generate(): Promise<GenerateOut> {
    return settle(() => {
      this.log("generate");
      const r = this.paired + 1;
      const undecided = this.fixtures.some((f) => f.round_no === r - 1 && (f.home_entrant_id !== null || f.away_entrant_id !== null) && !DECIDED.has(f.status));
      if (r > 1 && r <= this.budget && undecided) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", 422, "STAGE_NOT_READY", "current swiss round has undecided fixtures");
      this.pairNext();
      return { created: 0, existing: this.fixtures.length, fixtures: this.rows() };
    });
  }
}

/** A single knockout stage (stages.ts knockout generation), kept small: Start
 *  mints the whole bracket — round 1 seeded top-vs-bottom over the next power
 *  of two, later rounds with both seats TBD — and a missing opponent makes a
 *  one-sided forfeited AWARD row whose winner is fed forward at generation
 *  (stages.ts:2614+). Deciding a fixture fills its winner into the next
 *  round's slot (scoring.ts:729 → fillSlot, stages.ts:3567). Complete emits
 *  stage_completed with finalRanks: the champion, then losers by the round
 *  they went out in, later first, seed order within a round. Standings are
 *  the table fake's, and so is a knockout's withdraw.
 *
 *  `pagePlayoff: true` (W1-driving Task 2) makes it a single page_playoff
 *  stage instead: Start builds the ENGINE's own generatePagePlayoff shape
 *  (pp-q1, pp-elim, pp-q2, pp-final; its round r is round_no r + 1), and
 *  refuses any field but the engine's as the product's Start does (an
 *  EngineError → its status). A pp-q1 LOSER feeds pp-q2 as well as its
 *  winner feeding the final. page_playoff is not a bracket-walkover kind
 *  (stages.ts BRACKET_WALKOVER_KINDS), so withdraw takes the product's
 *  open-format branch (withdrawal.ts:213-217): every pending fixture of the
 *  withdrawn entrant is voided (abandoned), nothing is forfeited, and the
 *  policy reads "walkover" once anything was voided, "none" otherwise.
 *
 *  `stepladder: true` (W1-driving T15) makes it a single stepladder stage the
 *  same way: Start builds the ENGINE's own generateStepladder shape (sl-g0 the
 *  two lowest seeds, then one game per round up to the top seed; its round r
 *  is round_no r + 1, as the product's rows read). stepladder IS a
 *  bracket-walkover kind, so its withdraw stays the table fake's.
 *
 *  `doubleElim: true` (T15-R8 m-7) makes it a single double_elim stage the
 *  same way, on generateDoubleElim (no bracketReset): a bye line is a
 *  one-sided forfeited AWARD row whose winner is fed forward, as the
 *  knockout's are; a slot fed by a bye line's LOSER never fills, so a
 *  fixture whose other slot is filled is awarded through (the product's
 *  bye award at generation, stages.ts:2614+). Two such dead slots on one
 *  fixture are out of this fake's scope and thrown by name. */
/*  `thirdPlace: true` (W2b review I-1) makes it the knockout_third_place row's knockout ON THE ENGINE's single elim
 *  (generateSingleElim, thirdPlace), keyed as the product keys it (ext_key, is_final, third_place), so the harness's
 *  feed graph and nextLineOf resolve on it. As the server does (append-event.ts, X-DW-3), a double walkover on a
 *  fixture that feeds no next match by the product's feedsNextMatch (no line out: the final, the third-place match; or
 *  both lines into one fixture: a two-entrant double elim's winners' match, loop F I-5) is refused 409
 *  DOUBLE_WALKOVER_NO_NEXT_MATCH and writes nothing — on every shape this fake plays (a bracket reset is not one). An accepted one that feeds a next match seats nobody there (the
 *  dead-seat cascade, X-DW-2, is the product's and is not mirrored: a scenario that needs it runs on the product). */
export interface FakeKnockoutOptions {
  readonly pagePlayoff?: boolean; readonly stepladder?: boolean; readonly doubleElim?: boolean; readonly thirdPlace?: boolean;
  /** A plain knockout on the engine's own single elimination, rows keyed as the product keys them (ext_key, is_final),
   *  with the plan's bracket withdrawal cascade (Task 8's table, D17) — what WD-CASC drives (W2b review I-6). */
  readonly singleElim?: boolean;
}
/** withdrawal.ts REASON, read from its text: the cascade's walkover carries it (loop F makes it D1's "withdrew"). */
const WITHDRAWAL_REASON = withdrawalReason();
type Slot = "home_entrant_id" | "away_entrant_id";
export class FakeKnockoutDriver extends FakeLeagueDriver {
  /** fixture id → the next round's fixture and slot its winner fills. */
  readonly feeds = new Map<string, { to: string; slot: Slot }>();
  /** fixture id → the fixture and slot its LOSER fills (a page playoff's pp-q1 → pp-q2). */
  readonly loserFeeds = new Map<string, { to: string; slot: Slot }>();
  readonly pagePlayoff: boolean;
  readonly stepladder: boolean;
  readonly doubleElim: boolean;
  readonly thirdPlace: boolean;
  readonly singleElim: boolean;
  /** `<row id>:<slot>`: a slot fed by a bye line's loser, which never fills (doubleElim). */
  readonly deadSlots = new Set<string>();
  /** singleElim: the dead slots that died THROUGH DEPARTURE (stages.ts seatDeparted) — a seat its withdrawn entrant left
   *  (the bye stamp, X-WD-3) or one a departure double walkover feeds. Any other dead slot (a recorded double walkover's,
   *  a void's) is dead but not departed. */
  readonly departedSlots = new Set<string>();
  /** `<row id>:<slot>` → the entrant who WITHDREW from that seat while it was a winner edge's (owner ruling 116,
   *  stages.ts `awardSeededByes`): the arriving side walks over her, and the award names her, reason "withdrew". */
  readonly withdrawnFrom = new Map<string, string>();
  /** The engine's fixture id (pp-q1, …) → the fake's row id, in the engine's order. */
  readonly extIds = new Map<string, string>();
  constructor(opts: FakeKnockoutOptions = {}, orgId = "org-fake") {
    super(orgId);
    this.pagePlayoff = opts.pagePlayoff === true;
    this.stepladder = !this.pagePlayoff && opts.stepladder === true;
    this.doubleElim = !this.pagePlayoff && !this.stepladder && opts.doubleElim === true;
    this.thirdPlace = !this.pagePlayoff && !this.stepladder && !this.doubleElim && opts.thirdPlace === true;
    this.singleElim = !this.pagePlayoff && !this.stepladder && !this.doubleElim && !this.thirdPlace && opts.singleElim === true;
  }
  /** The single stage kind this fake plays. */
  get bracketKind(): string { return this.pagePlayoff ? "page_playoff" : this.stepladder ? "stepladder" : this.doubleElim ? "double_elim" : "knockout"; }
  override acceptsStage(kind: string): boolean { return kind === this.bracketKind; }
  override refuseStages(): never { throw new Error(`fake: ${this.bracketKind.replace("_", " ")} only`); }
  override expungesEarly(): boolean { return false; }
  /** Whether a finished fixture's winner goes on — a test seam for a product
   *  that drops one. */
  carriesForward(_f: FakeFixture): boolean { return true; }
  /** Start on the engine's own bracket shape (a page playoff, a stepladder or a double elim). */
  startEngineBracket(): StartOut {
    let bracket: GeneratedBracket;
    try {
      const opts = { entrants: this.entrants.map((e) => e.id), seeds: new Map(this.entrants.map((e) => [e.id, e.seed ?? Number.MAX_SAFE_INTEGER])) };
      const bySeed = [...opts.entrants].sort((a, b) => opts.seeds.get(a)! - opts.seeds.get(b)!);
      bracket = this.pagePlayoff ? generatePagePlayoff(opts) : this.doubleElim ? generateDoubleElim(opts) : this.thirdPlace ? generateSingleElim({ entrants: bySeed, thirdPlace: true })
        : this.singleElim ? generateSingleElim({ entrants: bySeed }) : generateStepladder(opts);
    } catch (e) {
      if (!EngineError.is(e)) throw e;
      throw new RefusedCall("POST", "/api/v1/divisions/d1/start", engineHttpStatus(e.code), e.code, e.message);
    }
    // Each row carries the engine's id and final flag, as the product's rows do
    // (stages.ts bracketToGen `extKey: f.id`; fixtures.ts listDivisionFixtures
    // serves ext_key and is_final) — I2 reads a page playoff's champion off them.
    for (const g of bracket.fixtures) {
      const tags = { ext_key: g.id, is_final: g.isFinal === true, ...(g.thirdPlace === true ? { third_place: true } : {}) };
      const row = g.award !== undefined
        ? this.seat(g.round + 1, g.award, null, { ...tags, status: "forfeited", outcome: { kind: "award", winner: g.award, loser: null, reason: "bye" } })
        : this.seat(g.round + 1, g.home ?? null, g.away ?? null, tags);
      this.extIds.set(g.id, row.id);
    }
    const awards = new Set(bracket.fixtures.filter((g) => g.award !== undefined).map((g) => g.id));
    for (const g of bracket.fixtures) {
      for (const [ref, slot] of [[g.homeFrom, "home_entrant_id"], [g.awayFrom, "away_entrant_id"]] as const) {
        if (ref === undefined) continue;
        if (ref.side === "loser" && awards.has(ref.fixtureId)) { this.deadSlots.add(`${this.extIds.get(g.id)!}:${slot}`); continue; }
        (ref.side === "winner" ? this.feeds : this.loserFeeds).set(this.extIds.get(ref.fixtureId)!, { to: this.extIds.get(g.id)!, slot });
      }
    }
    const bothDead = this.fixtures.find((x) => this.deadSlots.has(`${x.id}:home_entrant_id`) && this.deadSlots.has(`${x.id}:away_entrant_id`));
    if (bothDead !== undefined) throw new Error(`fake: ${bothDead.id} has two dead slots (adjacent bye lines) — outside this fake`);
    for (const f of this.fixtures.filter((x) => x.status === "forfeited")) this.feed(f);
    this.stage!.status = "active";
    return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
  }
  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      if (this.pagePlayoff || this.stepladder || this.doubleElim || this.thirdPlace || this.singleElim) return this.startEngineBracket();
      const size = 2 ** Math.ceil(Math.log2(Math.max(2, this.entrants.length)));
      let order = [1, 2];
      while (order.length < size) order = order.flatMap((s) => [s, order.length * 2 + 1 - s]);
      const bySeed = (s: number) => this.entrants.find((e) => e.seed === s)?.id ?? null;
      let round = order.flatMap((_, i) => (i % 2 === 0 ? [[bySeed(order[i]), bySeed(order[i + 1])] as const] : []))
        .map(([h, a]) => (h !== null && a !== null ? this.seat(1, h, a)
          : this.seat(1, h ?? a, null, { status: "forfeited", outcome: { kind: "award", winner: (h ?? a)!, loser: null, reason: "bye" } })));
      for (let r = 2; round.length > 1; r++) {
        const next = Array.from({ length: round.length / 2 }, () => this.seat(r, null, null));
        round.forEach((f, i) => this.feeds.set(f.id, { to: next[i >> 1].id, slot: i % 2 === 0 ? "home_entrant_id" : "away_entrant_id" }));
        round = next;
      }
      for (const f of this.fixtures.filter((x) => x.status === "forfeited")) this.feed(f);
      this.stage!.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
    });
  }
  feed(f: FakeFixture): void {
    // singleElim (X-DW-2): a double walkover advances nobody, so the slot it feeds is dead.
    if (this.singleElim && (f.outcome as { kind?: unknown } | null)?.kind === "double_walkover") {
      const next = this.feeds.get(f.id);
      if (next !== undefined) this.killSlot(next.to, next.slot, f.events.length === 0);
      return;
    }
    const w = (f.outcome as { winner?: unknown } | null)?.winner;
    const to = this.feeds.get(f.id);
    const lo = this.loserFeeds.get(f.id);
    if (typeof w !== "string" || (to === undefined && lo === undefined) || !this.carriesForward(f)) return;
    if (to !== undefined) this.fill(to.to, to.slot, w);
    const loser = w === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id;
    if (lo === undefined || loser === null) return;
    // A page playoff's WALKOVER (a forfeit of a fixture with both sides seated) seats its loser nowhere: the product
    // records the fixture the loser would have played as a bye award, which never reaches a batch (W2a whole-branch
    // review I-3: the database read of `page_playoff_only|*|M1` - q1 forfeited, elim decided, q2 an award, final decided).
    // The loser's slot is dead, so the fixture is awarded through to whoever fills the other.
    if (this.pagePlayoff && f.status === "forfeited") {
      this.deadSlots.add(`${lo.to}:${lo.slot}`);
      const target = this.fixtures.find((x) => x.id === lo.to)!;
      const other: Slot = lo.slot === "home_entrant_id" ? "away_entrant_id" : "home_entrant_id";
      const waiting = target[other];
      if (waiting !== null) this.awardThrough(target, waiting);
      return;
    }
    this.fill(lo.to, lo.slot, loser);
  }
  /** Fill a slot; a fixture whose OTHER slot is dead (a bye line's loser) is awarded through and fed on. */
  fill(id: string, slot: Slot, entrant: string): void {
    const target = this.fixtures.find((x) => x.id === id)!;
    Object.assign(target, { [slot]: entrant });
    const other: Slot = slot === "home_entrant_id" ? "away_entrant_id" : "home_entrant_id";
    if (!this.deadSlots.has(`${id}:${other}`)) return;
    this.awardThrough(target, entrant);
  }
  /** awardSeededByes: a dead seat's opponent walks over — `forfeited` + `{kind: "award", winner, loser: null, reason:
   *  "bye"}` and no event (W2b C-5); over a seat a winner WITHDREW from, the award names her, reason "withdrew" (owner
   *  ruling 116), and she is still never seated. */
  awardThrough(target: FakeFixture, winner: string): void {
    const slots: readonly Slot[] = ["home_entrant_id", "away_entrant_id"];
    const loser = slots.map((slot) => this.withdrawnFrom.get(`${target.id}:${slot}`)).find((id) => id !== undefined) ?? null;
    Object.assign(target, { status: "forfeited", outcome: { kind: "award", winner, loser, reason: loser === null ? "bye" : "withdrew" } });
    this.feed(target);
  }
  /** A slot a WINNER edge fills (stages.ts `awardSeededByes` reads the winner edge only: a loser edge's dead seat,
   *  X-WD-5, stays a bye). */
  winnerFed(id: string, slot: Slot): boolean {
    return [...this.feeds.values()].some((edge) => edge.to === id && edge.slot === slot);
  }
  /** singleElim, stages.ts resolveBracketSeats (loop F): a slot no entrant will reach (D17, X-WD-3, X-DW-2) is dead.
   *  - An entrant waiting opposite it walks over at once (awardThrough, the bye award).
   *  - Both slots dead THROUGH DEPARTURE (X-WD-4): a double walkover, no event, which kills the slot it feeds by
   *    departure — or, on a final, nothing is written and it stays open (D19, X-DW-3).
   *  - Both slots dead otherwise (Review Focus 1: a recorded double walkover's seat, a void's): the line is a void,
   *    `abandoned` with no outcome, and the slot it feeds is dead but not departed. */
  killSlot(id: string, slot: Slot, departed: boolean): void {
    this.deadSlots.add(`${id}:${slot}`);
    if (departed) this.departedSlots.add(`${id}:${slot}`);
    const target = this.fixtures.find((x) => x.id === id)!;
    if (target.status !== "scheduled" || target.outcome !== null) return;
    const other: Slot = slot === "home_entrant_id" ? "away_entrant_id" : "home_entrant_id";
    const waiting = target[other];
    if (waiting !== null) { this.awardThrough(target, waiting); return; }
    if (!this.deadSlots.has(`${id}:${other}`)) return;
    const next = this.feeds.get(id);
    if (this.departedSlots.has(`${id}:${slot}`) && this.departedSlots.has(`${id}:${other}`)) {
      if (next === undefined) return;
      Object.assign(target, { status: "forfeited", outcome: { kind: "double_walkover" } });
      this.killSlot(next.to, next.slot, true);
      return;
    }
    Object.assign(target, { status: "abandoned", outcome: null });
    if (next !== undefined) this.killSlot(next.to, next.slot, false);
  }
  /** singleElim, withdrawal.ts withdrawEntrantCascade's bracket path (loop F; D17, X-WD-1, X-WD-3, X-WD-4), for each
   *  fixture of the entrant the planner acts on (bracketWithdrawalActs):
   *  - opponent TBD: her seat is emptied and dies by departure (killSlot) — counted a walkover, as F counts it;
   *  - opponent already withdrawn (X-WD-4): a feeding line is a departure double walkover, no event, both seats kept, and
   *    the seat it feeds dies by departure; a final is left as it is (D19);
   *  - otherwise it walks over (walkOverForWithdrawal), and a HELD line counts in `walked_over_held`.
   *  Nothing is expunged. */
  async #withdrawBracket(entrantId: string): Promise<WithdrawOut> {
    this.log("withdraw");
    const gone = new Set(this.entrants.filter((e) => e.status === "withdrawn").map((e) => e.id));
    const mine = this.fixtures.filter((x) => x.home_entrant_id === entrantId || x.away_entrant_id === entrantId);
    let walkovers = 0;
    let held = 0;
    const acts = mine.filter((x) => bracketWithdrawalActs(x.status, this.abandonActive(x)));
    for (const f of acts) {
      const slot: Slot = f.home_entrant_id === entrantId ? "home_entrant_id" : "away_entrant_id";
      const opponent = slot === "home_entrant_id" ? f.away_entrant_id : f.home_entrant_id;
      if (opponent === null) {
        Object.assign(f, { [slot]: null });
        if (this.winnerFed(f.id, slot)) this.withdrawnFrom.set(`${f.id}:${slot}`, entrantId);
        this.killSlot(f.id, slot, true);
        walkovers++;
        continue;
      }
      if (gone.has(opponent)) {
        const next = this.feeds.get(f.id);
        if (next === undefined) continue;
        Object.assign(f, { status: "forfeited", outcome: { kind: "double_walkover" } });
        walkovers++;
        this.killSlot(next.to, next.slot, true);
        continue;
      }
      if (this.heldForWithdrawal(f)) held++;
      await this.walkOverForWithdrawal(f, entrantId);
      walkovers++;
    }
    this.entrants.find((e) => e.id === entrantId)!.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy: bracketWithdrawalPolicy("none", mine.length, acts.length), walkovers, voided: 0, skipped_finalized: 0, walked_over_held: held };
  }
  /** W2b X-WD-2 / X-WD-3 (ruling 90): a page playoff withdrawal walks its pending fixtures over to the opponent, as
   *  knockout does, and never voids one; a seat whose opponent is still TBD is emptied and goes dead — counted a
   *  walkover, as loop F's departSeat is — so the opponent who arrives there is walked over (fill → awardThrough). */
  override async withdraw(entrantId: string): Promise<WithdrawOut> {
    if (this.singleElim) return this.#withdrawBracket(entrantId);
    const inStage = this.fixtures.filter((x) => x.home_entrant_id === entrantId || x.away_entrant_id === entrantId);
    if (!this.pagePlayoff) {
      // A stepladder, a double elimination, a third-place or plain knockout keeps the league's cascade here; its policy
      // is still the bracket branch's (rulings 53 + 106), counted on the rows as they stood before the cascade.
      const acted = inStage.filter((x) => bracketWithdrawalActs(x.status, this.abandonActive(x))).length;
      return { ...(await super.withdraw(entrantId)), policy: bracketWithdrawalPolicy("none", inStage.length, acted) };
    }
    this.log("withdraw");
    let walkovers = 0;
    let pending = 0;
    let held = 0;
    // loop F: a page playoff takes the bracket path (WITHDRAWAL_WALKOVER_KINDS), so a held line walks over too.
    for (const f of this.fixtures.filter((x) => (x.home_entrant_id === entrantId || x.away_entrant_id === entrantId) && bracketWithdrawalActs(x.status, this.abandonActive(x)))) {
      pending++;
      const mine: Slot = f.home_entrant_id === entrantId ? "home_entrant_id" : "away_entrant_id";
      const opponent = mine === "home_entrant_id" ? f.away_entrant_id : f.home_entrant_id;
      if (opponent !== null) {
        if (this.heldForWithdrawal(f)) held++;
        if (activeAbandonIds(f.events).length > 0) await this.walkOverForWithdrawal(f, entrantId);
        else await this.walkoverFixture(f, entrantId);
        walkovers++;
        continue;
      }
      Object.assign(f, { [mine]: null });
      if (this.winnerFed(f.id, mine)) this.withdrawnFrom.set(`${f.id}:${mine}`, entrantId);
      this.deadSlots.add(`${f.id}:${mine}`);
      walkovers++;
    }
    this.entrants.find((e) => e.id === entrantId)!.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy: bracketWithdrawalPolicy("none", inStage.length, pending), walkovers, voided: 0, skipped_finalized: 0, walked_over_held: held };
  }
  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const f = this.fixtures.find((x) => x.id === id)!;
    const dw = events.some((e) => e.type === "core.forfeit" && (e.payload as { by?: unknown }).by === "both");
    // The server's rule (append-event.ts X-DW-3): the product's own feedsNextMatch over the fixture's two lines — none,
    // or (loop F I-5) both into ONE fixture (a two-entrant double elim's winners' match), is no next match.
    if (dw && !feedsNextMatch({ winner_to_fixture: this.feeds.get(id)?.to ?? null, loser_to_fixture: this.loserFeeds.get(id)?.to ?? null })) {
      throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, engineHttpStatus("DOUBLE_WALKOVER_NO_NEXT_MATCH"), "DOUBLE_WALKOVER_NO_NEXT_MATCH", "a double walkover needs a next match");
    }
    const out = await super.postStream(id, events, prefix);
    if (f.outcome !== null) this.feed(f); // a held level result has no winner, so it seats nobody (X-BR-1)
    return out;
  }
  override completeStage(): Promise<CompleteOut> {
    return settle(() => {
      this.log("completeStage");
      if (this.fixtures.some((f) => PENDING.has(f.status))) return { completed: false, events: [] };
      const seed = (id: string) => this.entrants.find((e) => e.id === id)?.seed ?? Number.MAX_SAFE_INTEGER;
      const out: { id: string; round: number }[] = [];
      let champion: string | null = null;
      for (const f of this.fixtures) {
        const w = (f.outcome as { winner?: unknown } | null)?.winner;
        // singleElim: a final won by a bye award (its other seat died, X-DW-2) still crowns its winner.
        if (this.singleElim && typeof w === "string" && !this.feeds.has(f.id)) champion = w;
        if (typeof w !== "string" || f.home_entrant_id === null || f.away_entrant_id === null) continue;
        // A loser that plays on (a page playoff's pp-q1) is not out yet - unless its next seat is dead (a walkover's loser).
        const lo = this.loserFeeds.get(f.id);
        if (lo === undefined || this.deadSlots.has(`${lo.to}:${lo.slot}`)) out.push({ id: w === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id, round: f.round_no ?? 0 });
        if (!this.feeds.has(f.id)) champion = w;
      }
      // T16 review m8: rank every entrant the stage's fixtures name, as the product's `bracketRanks` does (engine
      // stage.ts): a double walkover's two sides are out at that fixture's round (X-DW-2: `walkedOver`); an entrant no
      // stored fixture puts out (a winner who then withdrew, X-WD-3) is eliminated nowhere (-1) and ranks below every
      // elimination, by seed. An award's loser who holds no seat there (ruling 116's withdrawn winner) is no loss
      // (engine-db/competition.ts `bracketWinnerLoser`), and a seated one is the first loop's.
      const ranked = new Set<string>([...out.map((x) => x.id), ...(champion === null ? [] : [champion])]);
      const rank = (id: string | null | undefined, round: number) => {
        if (typeof id !== "string" || ranked.has(id)) return;
        out.push({ id, round });
        ranked.add(id);
      };
      for (const f of this.fixtures) {
        const o = f.outcome as { kind?: unknown; loser?: unknown } | null;
        if (o?.kind === "double_walkover") for (const id of [f.home_entrant_id, f.away_entrant_id]) rank(id, f.round_no ?? 0);
      }
      for (const f of this.fixtures) for (const id of [f.home_entrant_id, f.away_entrant_id]) rank(id, -1);
      out.sort((a, b) => b.round - a.round || seed(a.id) - seed(b.id));
      if (this.thirdPlace) {
        // The final's winner, then its loser, then the third-place match's winner and loser, then the rest by round.
        const pair = (row: FakeFixture | undefined): string[] => {
          const w = (row?.outcome as { winner?: unknown } | null | undefined)?.winner;
          if (row === undefined || typeof w !== "string") return [];
          return [w, w === row.home_entrant_id ? row.away_entrant_id! : row.home_entrant_id!];
        };
        const top = [...pair(this.fixtures.find((x) => x.is_final === true)), ...pair(this.fixtures.find((x) => x.third_place === true))];
        return { completed: true, events: [{ type: "stage_completed", finalRanks: [...top, ...out.map((x) => x.id).filter((e) => !top.includes(e))] }] };
      }
      return { completed: true, events: [{ type: "stage_completed", finalRanks: [...(champion === null ? [] : [champion]), ...out.map((x) => x.id)] }] };
    });
  }
}

/** A product that gates stage kinds by feature (ruling 24): `deny` maps a
 *  kind to the feature_key its 402 names, and is read in insertion order —
 *  the FIRST entry whose kind any posted stage has answers, as createStages
 *  checks its gates in order over every stage (stages.ts:373-382). Only kinds:
 *  the advanced gate's config keys (byes, cross_feeds, placements) are carried
 *  by no catalogue row. Stages are kept per division (ids d1, d2, …).
 *  deleteFirst mirrors today's replaceStages (stages.ts: delete, THEN gate). */
export class FakeDeniedDriver extends FakeLeagueDriver {
  readonly deny: ReadonlyMap<string, string>;
  readonly deleteFirst: boolean;
  readonly byDivision = new Map<string, StageRef[]>();
  #divisions = 0;
  constructor(deny: ReadonlyMap<string, string>, opts: { deleteFirst: boolean }, orgId = "org-fake") {
    super(orgId);
    this.deny = deny;
    this.deleteFirst = opts.deleteFirst;
  }
  override createDivision(c: string, i: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return super.createDivision(c, i).then((d) => {
      const id = `d${++this.#divisions}`;
      this.byDivision.set(id, []);
      return { ...d, id };
    });
  }
  #refusal(stages: readonly StagePostBody[]): RefusedCall | null {
    for (const [kind, featureKey] of this.deny) {
      if (stages.some((s) => s.kind === kind)) return new RefusedCall("POST", "/api/v1/divisions/d/stages", 402, "PAYMENT_REQUIRED", "upgrade", featureKey);
    }
    return null;
  }
  override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    return settle(() => {
      this.log("postStages");
      const refused = this.#refusal(stages);
      if (refused !== null) throw refused;
      const made = stages.map((s, k) => ({ id: `${d}-s${k + 1}`, seq: s.seq, kind: s.kind, config: { ...s.config }, status: "pending" }));
      this.byDivision.set(d, made);
      return made.map((s) => ({ ...s }));
    });
  }
  override listStages(d = "d1"): Promise<StageRef[]> {
    return settle(() => {
      this.log("listStages");
      return (this.byDivision.get(d) ?? []).map((s) => ({ ...s }));
    });
  }
  override replaceStagesProbe(d: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
    return settle(() => {
      this.log("replaceStagesProbe");
      if (this.deleteFirst) this.byDivision.set(d, []);
      const refused = this.#refusal(stages);
      if (refused !== null) return { status: refused.status, code: refused.code, featureKey: refused.featureKey };
      this.byDivision.set(d, stages.map((s, k) => ({ id: `${d}-r${k + 1}`, seq: s.seq, kind: s.kind, config: { ...s.config }, status: "pending" })));
      return { status: 200, code: null, featureKey: null };
    });
  }
}
