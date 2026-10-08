// A league-only product for the model's unit tests (Task 13). It proves the
// MODEL, never the product: its rules are the product's, each cited, and its
// truths come from the engine —
//  - the schedule is the engine's own round robin (generateRoundRobin) over
//    the active roster, `legs` from the stage config; Generate adds only the
//    meetings a pair is missing; a late entrant is appended;
//  - each fixture's outcome is the engine's fold of its ledger, voids resolved,
//    and its status the product's rule over that fold (append-event.ts
//    fixtureStatusFromFold) — never written directly, so an abandoned fixture
//    stays abandoned (carry a);
//  - a withdrawal's cascade rides the ledger as the product's does: the
//    expunge voids then abandons (withdrawal.ts voidAndAbandon), and the
//    walkover posts a BARE core.forfeit with the product's reason
//    (withdrawal.ts applyUpdate — no START first, so a sport that refuses a
//    forfeit before core.start refuses it here too: F1);
//  - Generate works before Start, and Start generates only an empty stage
//    (schedule.ts startDivision); rebuild refuses once any fixture has a
//    score event or a result (stages.ts rebuildStageFixtures);
//  - the roster locks at Start exactly as entrants.ts's TEXT says (read by
//    product-text.ts, never typed): statuses, open-window kinds, status,
//    message, and the code api-v1 puts on the wire;
//  - a bracket's feed edges (a test hook, `feed`) fill and give back seats as
//    fed-seats.ts does (ruling RR-1): a decision seats its winner in the
//    fixture it feeds, only ever into an empty seat (usecases/scoring.ts
//    onDecided → fillSlot), and a write that changes who that decision
//    advances empties the seat again — or, when the fed match has started,
//    is refused by name before anything is written (planRelease). A cascade
//    walkover (isCascadeWalkover) is RESET instead, and the reset follows its
//    own winner one edge on. Status, code, message, the not-started rule and
//    the exemption are read from the product's text.
// The faults are opt-in. fault879 reproduces issue #879's SHAPE, not a blanket
// fault: only an entrant added while the stage already has fixtures makes the
// next Generate seat every pair again (ruling C-1, superseding R-PF8's
// post-Start add, which the roster lock makes impossible).
//
// W1-driving Task 14 (FP-T14-1): a single SWISS stage too, so the model's
// Swiss bias is witnessed on a swiss-shaped product. Its rules are the
// product's (stages.ts swissGen, swiss-shell.ts), each cited at its method,
// and its pairings are the ENGINE's own pairRound (scheduling/swiss.ts) — the
// one the product calls. The ledger, the fold, the withdrawal cascade and the
// feeds stay the league path's: only Start, Generate, Rebuild and the
// withdrawal policy branch on the stage kind. Not modelled: the implicit-bye
// inference for a round a late entrant missed (only a pairing ORDER changes),
// the rank_adjacent cascade rank, and chess colours.
import { EngineError, type StageKind } from "@seazn/engine/core";
import { generateRoundRobin, pairKey as swissPairKey, pairRound, type SwissStanding } from "@seazn/engine/scheduling";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { stageCfg } from "../lib/sport-cfg.ts";
import { RefusedCall, type CompleteOut, type DivisionRef, type EntrantInput, type EntrantRow, type GenerateOut, type PostedEvent, type StartOut } from "../lib/driver/types.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";
import { nextMatchStartedText, rosterLockText, withdrawalReason } from "./product-text.ts";
import { fixtureStatusFromFold } from "./w2a-status.ts";

export interface ModelFakeOpts {
  /** #879: after an entrant is added while the stage has fixtures, the next Generate seats every pair again. */
  fault879?: boolean;
  /** Every decided outcome reports a winner nobody posted. */
  lieOutcome?: boolean;
  /** /complete answers 500 with no code. */
  unnamedCompleteRefusal?: boolean;
  /** Generate answers 2xx with zero fixtures (carry b). */
  emptyGenerate?: boolean;
  /** Even legs are NOT mirrored: each pair meets `legs` times in one orientation (carry c). */
  unmirroredLegs?: boolean;
  /** The roster lock after Start: "product" (default) refuses exactly as
   *  entrants.ts does; "named" refuses with a domain code; "open" lets the
   *  latecomer in. */
  rosterLock?: "product" | "named" | "open";
  /** Every posted event is answered as landing on the SEQ_CONFLICT retry. */
  retriedPosts?: boolean;
  /** A faulty fed-seat release: "always" refuses a take-back whether or not
   *  the fed match has started — a cascade walkover included; "leaky"
   *  refuses it after writing the event. */
  fedSeatsFault?: "always" | "leaky";
  /** What the NEXT_MATCH_STARTED refusal names as its fed match (W1c Task 2,
   *  ruling Q2): "product" (the default) the fed fixture, in fed-seats.ts's
   *  wire shape (product-text.ts nextMatchStartedText().wire); "absent" no
   *  next_match at all; "foreign" FOREIGN_NEXT_MATCH, a fixture this division
   *  does not have. */
  nextMatchRef?: "product" | "absent" | "foreign";
}

/** The fixture a "foreign" nextMatchRef names: never one the fake seats. */
export const FOREIGN_NEXT_MATCH = "f-not-in-this-division";

const LOCK = rosterLockText();
const NEXT = nextMatchStartedText();

/** fed-seats.ts advancingSides' winner: a `win` or an `award` sends it onward. */
function advancingWinner(outcome: unknown): string | undefined {
  const o = (outcome ?? {}) as { kind?: string; winner?: string };
  return o.kind === "win" || o.kind === "award" ? o.winner : undefined;
}

/** append-event.ts LOCKED_FIXTURE_STATUSES: refused before the fold. */
const LOCKED = new Set(["finalized", "cancelled"]);
/** lib/table-withdrawal.ts WITHDRAWAL_PLAYED_STATUSES: a result to void first. */
const SETTLED = new Set(["decided", "finalized", "forfeited"]);
/** withdrawal.ts voidAndAbandon: the events an expunge never voids. */
const NOT_VOIDED = new Set(["core.start", "core.void", "core.note", "core.award"]);
/** withdrawal.ts REASON. */
const REASON = withdrawalReason();

const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);

/** stages.ts DECIDED: a swiss board the next round's gate counts as finished. */
const SWISS_DECIDED = new Set(["decided", "finalized", "forfeited"]);
/** fixture-results-sql.ts fixtureHasResultSql's status clause: what a rebuild refuses over (with evidence, or abandoned with an outcome). */
const RESULT_STATUSES = new Set(["in_play", "decided", "finalized"]);
const isAward = (outcome: unknown): boolean => (outcome as { kind?: unknown } | null)?.kind === "award";
/** swiss-shell.ts isSwissBoardSeated: an award row, or both seats filled. */
const swissSeated = (f: FakeFixture): boolean => isAward(f.outcome) || (f.home_entrant_id !== null && f.away_entrant_id !== null);

export class ModelFakeDriver extends FakeLeagueDriver {
  readonly opts: ModelFakeOpts;
  /** fixture id → its ledger, every event the product accepted, in seq order. */
  readonly ledgers = new Map<string, LedgerEntry[]>();
  #eventNo = 0;
  /** An entrant arrived while the stage had fixtures (#879's trigger). Reset per division. */
  #lateEntrant = false;
  /** divisions.status: setup until Start (the model has no publish). */
  #divisionStatus = "setup";
  /** source fixture id → the seat its winner fills (winner_to_fixture / winner_to_slot). */
  readonly feeds = new Map<string, { target: string; slot: 1 | 2 }>();
  /** A swiss stage's bye shells (the product's `sw-r<n>-bye` ext_key). Reset per division. */
  readonly byeShells = new Set<string>();
  constructor(opts: ModelFakeOpts = {}) {
    super("org-model");
    this.opts = opts;
  }
  /** W1d Task 14: the base fake's ledger and void ride `fixtures[].events`, which this driver never fills (its
   *  own ledger is `ledgers`, with ids it mints). A void or a ledger read inherited from it would answer over an
   *  empty list as if the product held nothing, so both are refused by name: the model does not drive voidLast. */
  override voidLast(): Promise<never> {
    return Promise.reject(new Error("fake: the model fake keeps its ledger in `ledgers`, not fixtures[].events — voidLast is not modelled here"));
  }
  override ledger(): Promise<never> {
    return Promise.reject(new Error("fake: the model fake keeps its ledger in `ledgers`, not fixtures[].events — a ledger read is not modelled here"));
  }
  /** Task 14: a league stage, or a single swiss stage (FP-T14-1). */
  override acceptsStage(kind: string): boolean { return kind === "league" || kind === "swiss"; }
  override refuseStages(): never { throw new Error("fake: league or swiss only"); }
  get #swiss(): boolean { return this.stage?.kind === "swiss"; }
  /** withdrawal.ts: swiss NEVER expunges (owner ruling 2026-09-24) — every
   *  paired board walks over; a league keeps the table rule. */
  override expungesEarly(): boolean { return !this.#swiss; }
  /** One driver may serve every property run of a cell, as HttpDriver does: a
   *  new division starts empty. Fixture ids keep counting (minted). */
  override createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]): Promise<DivisionRef> {
    this.entrants = [];
    this.fixtures = [];
    this.ledgers.clear();
    this.feeds.clear();
    this.byeShells.clear();
    this.stage = null;
    this.completed = false;
    this.#lateEntrant = false;
    this.#divisionStatus = "setup";
    // Entrant ids restart at e1 per division: a roster must not leak into the next one.
    this.members = new Map();
    return super.createDivision(c, i);
  }
  /** Inline members ride the add, as the base fake and the product's create
   *  store them (W1-driving Task 4 carry). The model sends none until Task 14
   *  gives it rosters; a late add keeps them too. */
  override addEntrants(divisionId: string, es: readonly EntrantInput[]): Promise<EntrantRow[]> {
    return Promise.resolve().then(() => {
      this.log("addEntrants");
      const locked = LOCK.statuses.includes(this.#divisionStatus) && !LOCK.openKinds.includes(this.stage?.kind ?? "");
      if (locked && this.opts.rosterLock !== "open") {
        const code = this.opts.rosterLock === "named" ? "ROSTER_LOCKED" : LOCK.wireCode;
        throw new RefusedCall("POST", `/api/v1/divisions/${divisionId}/entrants`, LOCK.status, code, LOCK.message);
      }
      if (es.length > 0 && this.fixtures.length > 0) this.#lateEntrant = true;
      const made = es.map((e, i) => ({ id: `e${this.entrants.length + i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered" }));
      this.entrants = [...this.entrants, ...made];
      es.forEach((e, i) => { if (e.members !== undefined) this.members.set(made[i].id, this.rosterOf(made[i].id, e.members)); });
      return made.map((e) => ({ ...e }));
    });
  }
  /** The engine's round robin over the active roster (withdrawn entrants sit out). */
  schedule(): { round: number; home: string; away: string }[] {
    const legs = typeof this.stage?.config.legs === "number" ? this.stage.config.legs : 1;
    const active = this.entrants.filter((e) => e.status !== "withdrawn").map((e) => e.id);
    return generateRoundRobin({ entrants: active, config: { legs } }).fixtures.map((f) =>
      this.opts.unmirroredLegs === true && f.leg % 2 === 0 ? { round: f.roundNo, home: f.away, away: f.home } : { round: f.roundNo, home: f.home, away: f.away });
  }
  /** schedule.ts startDivision: generates only when the first stage has no fixtures. */
  override start(): Promise<StartOut> {
    return Promise.resolve().then(() => {
      this.log("start");
      if (this.stage === null) throw new Error("fake: start before postStages");
      const empty = this.fixtures.length === 0;
      // A swiss Start's generate is swissGen's first press: empty shells.
      if (empty && this.#swiss) this.#mintSwissShells();
      else if (empty) for (const s of this.schedule()) this.seat(s.round, s.home, s.away);
      this.stage.status = "active";
      this.#divisionStatus = "active";
      return { division_id: "d1", status: "active", started: true, generated: empty ? this.fixtures.length : 0 };
    });
  }
  override generate(): Promise<GenerateOut> {
    return Promise.resolve().then(() => {
      this.log("generate");
      if (this.stage === null) throw new Error("fake: generate before postStages");
      // stages.ts: a pending stage goes active on its first generate, Start or not.
      if (this.stage.status === "pending") this.stage.status = "active";
      if (this.opts.emptyGenerate === true) return { created: 0, existing: 0, fixtures: [] };
      if (this.#swiss) return this.#swissGenerate();
      const want = this.schedule();
      const need = new Map<string, number>();
      for (const s of want) need.set(pairKey(s.home, s.away), (need.get(pairKey(s.home, s.away)) ?? 0) + 1);
      const have = new Map<string, number>();
      for (const f of this.fixtures) if (f.home_entrant_id !== null && f.away_entrant_id !== null) have.set(pairKey(f.home_entrant_id, f.away_entrant_id), (have.get(pairKey(f.home_entrant_id, f.away_entrant_id)) ?? 0) + 1);
      const duplicates = this.opts.fault879 === true && this.#lateEntrant;
      let created = 0;
      for (const s of want) {
        const k = pairKey(s.home, s.away);
        if (!duplicates) {
          const h = have.get(k) ?? 0;
          if (h >= (need.get(k) ?? 0)) continue;
          have.set(k, h + 1);
        }
        this.seat(s.round, s.home, s.away);
        created++;
      }
      // The reconcile has run over the grown roster: the next one is clean.
      this.#lateEntrant = false;
      return { created, existing: this.fixtures.length - created, fixtures: this.rows() };
    });
  }
  override postStream(id: string, events: readonly StreamEvent[], _prefix = ""): Promise<PostedEvent[]> {
    // PF-4: `calls` keeps the bare name; `trace` carries the fixture (Task
    // 14). The withdrawal cascade below writes through this method — the
    // product's own write, which no organiser driver call makes — so its trace
    // line says so: `postStream <f>` is the organiser's post, `postStream <f>
    // by-product` the cascade's. The label is set at the cascade's call sites
    // (#cascadePost), never read off the prefix (review m-5): an organiser
    // post may carry none. Read here, synchronously, before any await.
    const label = this.#cascading > 0 ? " by-product" : "";
    return Promise.resolve().then(() => {
      this.calls.push("postStream");
      this.trace.push(`postStream ${id}${label}`);
      const f = this.fixtures.find((x) => x.id === id);
      if (f === undefined) throw new Error(`fake: no fixture ${id}`);
      if (f.home_entrant_id === null || f.away_entrant_id === null) throw new Error(`fake: fixture ${id} is not seated`);
      const path = `/api/v1/fixtures/${id}/events`;
      const ledger = this.ledgers.get(id) ?? [];
      this.ledgers.set(id, ledger);
      const out: PostedEvent[] = [];
      for (const ev of events) {
        if (LOCKED.has(f.status)) throw new RefusedCall("POST", path, 422, "ALREADY_DECIDED", `fixture ${id} is ${f.status}`);
        const eid = `ev${++this.#eventNo}`;
        const target = ev.type === "core.void" ? (ev.payload as { event_id?: unknown } | null)?.event_id : undefined;
        const entry: LedgerEntry = { id: eid, seq: ledger.length + 1, type: ev.type, payload: ev.payload, ...(typeof target === "string" ? { voids: target } : {}) };
        let outcome: unknown;
        const kind = this.stage?.kind ?? null;
        try {
          // W2a: the product folds a fixture under its STAGE's cfg (resolveFixtureCfg: a bracket's overlay on top of the division's).
          outcome = foldLedger(this.sport, kind === null ? this.cfg : stageCfg(this.sport, this.cfg, kind as StageKind), f.home_entrant_id, f.away_entrant_id, [...ledger, entry]);
        } catch (e) {
          // As FakeLeagueDriver: only an EngineError is a product refusal.
          if (!EngineError.is(e)) throw e;
          throw new RefusedCall("POST", path, engineHttpStatus(e.code), e.code, e.message);
        }
        // append-event.ts: releaseFedSeats after the fold, BEFORE the first write.
        const plan: (() => void)[] = [];
        const refused = this.#release(f, outcome, path, plan);
        if (refused !== null && this.opts.fedSeatsFault !== "leaky") throw refused;
        ledger.push(entry);
        f.events = [...f.events, ev];
        f.outcome = this.opts.lieOutcome === true && outcome !== null ? { ...(outcome as object), winner: "nobody" } : outcome;
        f.status = fixtureStatusFromFold(outcome, liveEntries(ledger), kind);
        if (refused !== null) throw refused;
        for (const step of plan) step();
        this.#fill(f);
        out.push({ seq: ledger.length, status: f.status, outcome: f.outcome, event_id: eid, ...(this.opts.retriedPosts === true ? { retried: true } : {}) });
      }
      return out;
    });
  }
  /** A test hook for a bracket feed edge (stages.ts generate's second pass:
   *  a target's homeFrom/awayFrom becomes the source's winner_to_fixture/slot). */
  feed(source: string, target: string, slot: 1 | 2): void {
    this.feeds.set(source, { target, slot });
  }
  /** fed-seats.ts hasStarted, its three terms. */
  #started(t: FakeFixture): boolean {
    return t.status !== NEXT.notStarted || t.outcome !== null || liveEntries(this.ledgers.get(t.id) ?? []).length > 0;
  }
  /** fed-seats.ts isCascadeWalkover, its three terms. */
  #cascade(t: FakeFixture): boolean {
    const kind = (t.outcome as { kind?: unknown } | null)?.kind;
    return t.status === NEXT.cascade.status && kind === NEXT.cascade.outcomeKind && liveEntries(this.ledgers.get(t.id) ?? []).length === 0;
  }
  /** fed-seats.ts planRelease over one winner edge: only when who advances
   *  changed, and only a seat holding one of this fixture's two entrants. Every
   *  seat is PLANNED (into `plan`) before any is given back; the refusal to
   *  throw, or null. A cascade walkover is reset, and whatever it advanced
   *  moves too. */
  #release(f: FakeFixture, next: unknown, path: string, plan: (() => void)[]): RefusedCall | null {
    const edge = this.feeds.get(f.id);
    const was = advancingWinner(f.outcome);
    if (edge === undefined || was === undefined || was === advancingWinner(next)) return null;
    const t = this.fixtures.find((x) => x.id === edge.target);
    if (t === undefined) return null;
    const occupant = edge.slot === 1 ? t.home_entrant_id : t.away_entrant_id;
    if (occupant === null || (occupant !== f.home_entrant_id && occupant !== f.away_entrant_id)) return null;
    const reset = this.#cascade(t);
    if (this.opts.fedSeatsFault === "always" || (!reset && this.#started(t))) return new RefusedCall("POST", path, NEXT.status, NEXT.code, NEXT.message(`R${t.round_no ?? 0}·${t.fixture_no ?? 0}`), null, this.#nextMatch(t));
    plan.push(() => {
      if (edge.slot === 1) t.home_entrant_id = null;
      else t.away_entrant_id = null;
      if (reset) {
        t.status = NEXT.notStarted;
        t.outcome = null;
      }
    });
    return reset ? this.#release(t, null, path, plan) : null;
  }
  /** fed-seats.ts: the HttpError's extra, `{ [key]: boardRef(tx, t) }`, which
   *  api-v1 spreads into `error` — key and id field read from the product's
   *  text, never typed (ruling Q2). Only the id field: it is all the model reads. */
  #nextMatch(t: FakeFixture): Record<string, unknown> | null {
    const mode = this.opts.nextMatchRef ?? "product";
    if (mode === "absent") return null;
    return { [NEXT.wire.key]: { [NEXT.wire.idField]: mode === "foreign" ? FOREIGN_NEXT_MATCH : t.id } };
  }
  /** usecases/scoring.ts onDecided → fillSlot: the winner goes forward, into an empty seat only. */
  #fill(f: FakeFixture): void {
    const edge = this.feeds.get(f.id);
    const w = advancingWinner(f.outcome);
    const t = edge === undefined ? undefined : this.fixtures.find((x) => x.id === edge.target);
    if (edge === undefined || w === undefined || t === undefined) return;
    if (edge.slot === 1 && t.home_entrant_id === null) t.home_entrant_id = w;
    if (edge.slot === 2 && t.away_entrant_id === null) t.away_entrant_id = w;
  }
  /** withdrawal.ts applyUpdate + voidAndAbandon: a played fixture has every
   *  live state-bearing event voided, newest first; then core.abandon. */
  override async abandonFixture(f: FakeFixture): Promise<void> {
    if (SETTLED.has(f.status) && f.outcome !== null) {
      const targets = liveEntries(this.ledgers.get(f.id) ?? []).filter((e) => !NOT_VOIDED.has(e.type)).sort((a, b) => b.seq - a.seq);
      for (const t of targets) await this.#cascadePost(f.id, [{ type: "core.void", payload: { event_id: t.id } }]);
    }
    await this.#cascadePost(f.id, [{ type: "core.abandon", payload: { reason: REASON } }]);
  }
  /** withdrawal.ts applyUpdate's walkover: a bare core.forfeit, whatever the
   *  fixture's status — no START first (HttpDriver.forfeit's composition is the
   *  organiser's, not the cascade's). */
  override async walkoverFixture(f: FakeFixture, by: string): Promise<void> {
    await this.#cascadePost(f.id, [{ type: "core.forfeit", payload: { by, reason: REASON } }]);
  }
  /** Open while a withdrawal cascade writes (review m-5): postStream labels its trace line `by-product`. */
  #cascading = 0;
  /** The withdrawal cascade's write: through postStream (so a subclass's
   *  override still sees it), labelled the product's own. */
  async #cascadePost(id: string, events: readonly StreamEvent[]): Promise<void> {
    this.#cascading++;
    try {
      await this.postStream(id, events);
    } finally {
      this.#cascading--;
    }
  }
  override rebuild(_stageId: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.log("rebuild");
      if (this.#swiss) {
        // stages.ts rebuildStageFixtures: refused while any fixture holds a
        // result (fixtureHasResultSql — a result status, an abandoned row with
        // an outcome, or score events); a generation-time bye holds none. Then
        // every fixture goes and the regenerate is swissGen's first press.
        if (this.fixtures.some((f) => (this.ledgers.get(f.id) ?? []).length > 0 || RESULT_STATUSES.has(f.status) || (f.status === "abandoned" && f.outcome !== null))) {
          throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 409, "STAGE_HAS_RESULTS", "this stage has fixtures with a recorded result");
        }
        this.fixtures = [];
        this.byeShells.clear();
        this.#mintSwissShells();
        return;
      }
      if (this.fixtures.some((f) => (this.ledgers.get(f.id) ?? []).length > 0 || f.outcome !== null)) {
        throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 409, "STAGE_HAS_RESULTS", "stage already has recorded results");
      }
      this.fixtures = [];
      for (const s of this.schedule()) this.seat(s.round, s.home, s.away);
      this.#lateEntrant = false;
    });
  }
  override completeStage(): Promise<CompleteOut> {
    if (this.opts.unnamedCompleteRefusal === true) return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/complete", 500, null, "boom"));
    return super.completeStage().then((out) => {
      // The model's one stage is the division's last: its completion completes the division.
      if (out.completed) this.#divisionStatus = "completed";
      return out;
    });
  }
  // --- Task 14: a single swiss stage (FP-T14-1) ------------------------------------------
  /** swissGen's `entrants`: the ACTIVE field (withdrawn entrants sit out), in entrant order. */
  #active(): string[] { return this.entrants.filter((e) => e.status !== "withdrawn").map((e) => e.id); }
  #roundOf(r: number): FakeFixture[] { return this.fixtures.filter((f) => f.round_no === r); }
  /** swiss-shell.ts swissBoardsForField. */
  #shape(): { boards: number; bye: boolean } {
    const n = this.#active().length;
    return { boards: Math.floor(n / 2), bye: n % 2 === 1 };
  }
  #mintBoard(r: number): FakeFixture { return this.seat(r, null, null); }
  #mintBye(r: number): FakeFixture {
    const f = this.seat(r, null, null);
    this.byeShells.add(f.id);
    return f;
  }
  /** swissGen's first press (swiss-shell.ts planSwissShells): for every round
   *  of config.rounds, a board shell per pair of the active field and a bye
   *  shell on an odd one — nobody seated. Returns the rows minted. */
  #mintSwissShells(): number {
    const rounds = this.stage?.config.rounds;
    // stages.ts swissGen: CONFIG_INVALID without a whole config.rounds >= 1.
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", engineHttpStatus("CONFIG_INVALID"), "CONFIG_INVALID", "swiss stage requires config.rounds >= 1");
    const { boards, bye } = this.#shape();
    const before = this.fixtures.length;
    for (let r = 1; r <= rounds; r++) {
      for (let b = 0; b < boards; b++) this.#mintBoard(r);
      if (bye) this.#mintBye(r);
    }
    return this.fixtures.length - before;
  }
  /** swiss-shell.ts nextUnseatedSwissRound: the lowest round with an unseated row. */
  #nextUnseated(): number | null {
    const rounds = [...new Set(this.fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
    return rounds.find((r) => this.#roundOf(r).some((f) => !swissSeated(f))) ?? null;
  }
  /** stages.ts reconcileSwissRoundShells: round `r` reshaped to the active
   *  field — surplus board shells dropped from the tail, a bye shell minted or
   *  dropped. Only an unseated round with no recorded data reshapes; otherwise
   *  the target round refuses (STAGE_NOT_READY) and a later one is skipped. */
  #reconcile(r: number, onBlocked: "refuse" | "skip"): void {
    const round = this.#roundOf(r);
    const boards = round.filter((f) => !this.byeShells.has(f.id));
    const byeRow = round.find((f) => this.byeShells.has(f.id));
    const want = this.#shape();
    if (boards.length === want.boards && (byeRow !== undefined) === want.bye) return;
    const blocked = round.some(swissSeated) ? "swiss round is already partly seated — reconcile refused"
      : round.some((f) => (this.ledgers.get(f.id) ?? []).length > 0) ? "swiss round has recorded match data — reconcile refused" : null;
    if (blocked !== null) {
      if (onBlocked === "skip") return;
      throw new RefusedCall("POST", "/api/v1/stages/s1/generate", engineHttpStatus("STAGE_NOT_READY"), "STAGE_NOT_READY", blocked);
    }
    const doomed = new Set([...boards.slice(want.boards), ...(byeRow !== undefined && !want.bye ? [byeRow] : [])].map((f) => f.id));
    this.fixtures = this.fixtures.filter((f) => !doomed.has(f.id));
    for (const id of doomed) this.byeShells.delete(id);
    for (let b = boards.length; b < want.boards; b++) this.#mintBoard(r);
    if (want.bye && byeRow === undefined) this.#mintBye(r);
  }
  /** stages.ts swissGen: the first press mints shells; each later press seats
   *  the next unseated round onto its shells (an UPDATE: `created` stays 0),
   *  refused STAGE_NOT_READY while the round before it has an undecided seated
   *  board. Before Start every later unseated round is reshaped too (eager,
   *  "skip"); after it only the target (lazy). The pairing is the engine's
   *  pairRound over the active field — score from the results, rank the seed
   *  order, history every pair already seated and every entrant a bye or an
   *  award already went to (FIDE C.04.1(d)) — and a round it cannot pair
   *  rematch-free seats only its bye, as the product does (W3's H1). */
  #swissGenerate(): GenerateOut {
    if (this.fixtures.length === 0) {
      const created = this.#mintSwissShells();
      return { created, existing: 0, fixtures: this.rows() };
    }
    const target = this.#nextUnseated();
    if (target === null) return { created: 0, existing: this.fixtures.length, fixtures: this.rows() };
    if (target > 1 && this.#roundOf(target - 1).some((f) => swissSeated(f) && !SWISS_DECIDED.has(f.status))) {
      throw new RefusedCall("POST", "/api/v1/stages/s1/generate", engineHttpStatus("STAGE_NOT_READY"), "STAGE_NOT_READY", "current swiss round has undecided fixtures");
    }
    this.#reconcile(target, "refuse");
    if (this.#divisionStatus === "setup") {
      for (const r of [...new Set(this.fixtures.map((f) => f.round_no ?? 0))].filter((x) => x > target)) this.#reconcile(r, "skip");
    }
    const score = new Map(this.#active().map((id) => [id, 0]));
    const played = new Set<string>();
    const byes = new Set<string>();
    for (const f of this.fixtures) {
      const o = f.outcome as { kind?: string; winner?: string } | null | undefined;
      if (f.home_entrant_id !== null && f.away_entrant_id !== null) played.add(swissPairKey(f.home_entrant_id, f.away_entrant_id));
      if (o?.kind === "award" && o.winner !== undefined) byes.add(o.winner);
      if ((o?.kind === "win" || o?.kind === "award") && o.winner !== undefined) score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
      else if ((o?.kind === "draw" || o?.kind === "tie") && f.home_entrant_id !== null && f.away_entrant_id !== null) {
        score.set(f.home_entrant_id, (score.get(f.home_entrant_id) ?? 0) + 0.5);
        score.set(f.away_entrant_id, (score.get(f.away_entrant_id) ?? 0) + 0.5);
      }
    }
    const standings: SwissStanding[] = this.#active().map((id, i) => ({ entrantId: id, score: score.get(id) ?? 0, rank: i + 1 }));
    const cfg = this.stage?.config ?? {};
    const round = pairRound(standings, { played, byes }, { chess: cfg.chess === true, ...(cfg.pairing === "rank_adjacent" ? { pairing: "rank_adjacent" as const } : {}) });
    const shells = this.#roundOf(target);
    const boards = shells.filter((f) => !this.byeShells.has(f.id));
    round.pairings.forEach((p, i) => {
      const shell = boards[i];
      if (shell === undefined) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", engineHttpStatus("CONFIG_INVALID"), "CONFIG_INVALID", "swiss shell count mismatch for pairing");
      Object.assign(shell, { home_entrant_id: p.home, away_entrant_id: p.away, status: "scheduled", outcome: null });
    });
    if (round.bye !== undefined) {
      const byeShell = shells.find((f) => this.byeShells.has(f.id));
      if (byeShell === undefined) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", engineHttpStatus("CONFIG_INVALID"), "CONFIG_INVALID", "swiss bye shell missing for pairing");
      Object.assign(byeShell, { home_entrant_id: round.bye, away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: round.bye } });
    }
    return { created: 0, existing: this.fixtures.length, fixtures: this.rows() };
  }

  /** A test hook for stages.ts addFixture (PROMPT-66): an ad-hoc match on a
   *  running league — "a replay, a friendly, a manual tie-breaker or a missing
   *  match". Not a model command: COMMAND_KINDS has no AddMatch. */
  addFixture(home: string, away: string): FakeFixture {
    const round = Math.max(0, ...this.fixtures.map((f) => f.round_no ?? 0)) + 1;
    return this.seat(round, home, away);
  }
}

/** W1d item 26: a bracket whose Generate 500s once the division's roster has changed the way `refuses` says —
 *  the shape of MB-007 (an entrant added) and MB-010 (one withdrawn), which share the product's words. `message`
 *  is those words. Per division (createDivision resets it, as model.ts reuses one driver across a cell's runs):
 *  the model's own setup makes the one addEntrants call, so a second is an AddEntrant that the product took, and
 *  a Withdraw the product took sets `withdrew`. A round-robin fake stands in for the bracket: only the roster
 *  change and the refusal matter. */
export class StaleBracketDriver extends ModelFakeDriver {
  #adds = 0;
  withdrew = false;
  readonly message: string;
  readonly refuses: (d: StaleBracketDriver) => boolean;
  constructor(refuses: (d: StaleBracketDriver) => boolean, message: string) {
    super();
    this.refuses = refuses;
    this.message = message;
  }
  /** An entrant arrived after the build's own. */
  get added(): boolean { return this.#adds > 1; }
  override createDivision(...a: Parameters<ModelFakeDriver["createDivision"]>) { this.#adds = 0; this.withdrew = false; return super.createDivision(...a); }
  override addEntrants(...a: Parameters<ModelFakeDriver["addEntrants"]>) { return super.addEntrants(...a).then((r) => { this.#adds++; return r; }); }
  override withdraw(...a: Parameters<ModelFakeDriver["withdraw"]>) { return super.withdraw(...a).then((r) => { this.withdrew = true; return r; }); }
  override generate(...a: Parameters<ModelFakeDriver["generate"]>) {
    return this.refuses(this) ? Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, "INTERNAL", this.message)) : super.generate(...a);
  }
}
