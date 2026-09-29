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
//    message, and the code api-v1 puts on the wire.
// The faults are opt-in. fault879 reproduces issue #879's SHAPE, not a blanket
// fault: only an entrant added while the stage already has fixtures makes the
// next Generate seat every pair again (ruling C-1, superseding R-PF8's
// post-Start add, which the roster lock makes impossible).
import { EngineError } from "@seazn/engine/core";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { RefusedCall, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type GenerateOut, type PostedEvent, type StartOut } from "../lib/driver/types.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";
import { rosterLockText, withdrawalReason } from "./product-text.ts";

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
}

const LOCK = rosterLockText();

/** append-event.ts LOCKED_FIXTURE_STATUSES: refused before the fold. */
const LOCKED = new Set(["finalized", "cancelled"]);
/** lib/table-withdrawal.ts WITHDRAWAL_PLAYED_STATUSES: a result to void first. */
const SETTLED = new Set(["decided", "finalized", "forfeited"]);
/** withdrawal.ts voidAndAbandon: the events an expunge never voids. */
const NOT_VOIDED = new Set(["core.start", "core.void", "core.note", "core.award"]);
/** withdrawal.ts REASON. */
const REASON = withdrawalReason();

/** append-event.ts fixtureStatusFromFold, over the ACTIVE (void-resolved) events. */
function statusFromFold(outcome: unknown, live: readonly LedgerEntry[]): string {
  const has = (type: string) => live.some((e) => e.type === type);
  if (has("core.abandon")) return "abandoned";
  if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
  return has("core.start") ? "in_play" : "scheduled";
}

const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);

export class ModelFakeDriver extends FakeLeagueDriver {
  readonly opts: ModelFakeOpts;
  /** fixture id → its ledger, every event the product accepted, in seq order. */
  readonly ledgers = new Map<string, LedgerEntry[]>();
  #eventNo = 0;
  /** An entrant arrived while the stage had fixtures (#879's trigger). Reset per division. */
  #lateEntrant = false;
  /** divisions.status: setup until Start (the model has no publish). */
  #divisionStatus = "setup";
  constructor(opts: ModelFakeOpts = {}) {
    super("org-model");
    this.opts = opts;
  }
  /** One driver may serve every property run of a cell, as HttpDriver does: a
   *  new division starts empty. Fixture ids keep counting (minted). */
  override createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]): Promise<DivisionRef> {
    this.entrants = [];
    this.fixtures = [];
    this.ledgers.clear();
    this.stage = null;
    this.completed = false;
    this.#lateEntrant = false;
    this.#divisionStatus = "setup";
    return super.createDivision(c, i);
  }
  override addEntrants(divisionId: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
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
      if (empty) for (const s of this.schedule()) this.seat(s.round, s.home, s.away);
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
    return Promise.resolve().then(() => {
      this.log("postStream");
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
        try {
          outcome = foldLedger(this.sport, this.cfg, f.home_entrant_id, f.away_entrant_id, [...ledger, entry]);
        } catch (e) {
          // As FakeLeagueDriver: only an EngineError is a product refusal.
          if (!EngineError.is(e)) throw e;
          throw new RefusedCall("POST", path, engineHttpStatus(e.code), e.code, e.message);
        }
        ledger.push(entry);
        f.events = [...f.events, ev];
        f.outcome = this.opts.lieOutcome === true && outcome !== null ? { ...(outcome as object), winner: "nobody" } : outcome;
        f.status = statusFromFold(outcome, liveEntries(ledger));
        out.push({ seq: ledger.length, status: f.status, outcome: f.outcome, event_id: eid, ...(this.opts.retriedPosts === true ? { retried: true } : {}) });
      }
      return out;
    });
  }
  /** withdrawal.ts applyUpdate + voidAndAbandon: a played fixture has every
   *  live state-bearing event voided, newest first; then core.abandon. */
  override async abandonFixture(f: FakeFixture): Promise<void> {
    if (SETTLED.has(f.status) && f.outcome !== null) {
      const targets = liveEntries(this.ledgers.get(f.id) ?? []).filter((e) => !NOT_VOIDED.has(e.type)).sort((a, b) => b.seq - a.seq);
      for (const t of targets) await this.postStream(f.id, [{ type: "core.void", payload: { event_id: t.id } }]);
    }
    await this.postStream(f.id, [{ type: "core.abandon", payload: { reason: REASON } }]);
  }
  /** withdrawal.ts applyUpdate's walkover: a bare core.forfeit, whatever the
   *  fixture's status — no START first (HttpDriver.forfeit's composition is the
   *  organiser's, not the cascade's). */
  override async walkoverFixture(f: FakeFixture, by: string): Promise<void> {
    await this.postStream(f.id, [{ type: "core.forfeit", payload: { by, reason: REASON } }]);
  }
  override rebuild(_stageId: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.log("rebuild");
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
  /** A test hook for stages.ts addFixture (PROMPT-66): an ad-hoc match on a
   *  running league — "a replay, a friendly, a manual tie-breaker or a missing
   *  match". Not a model command: COMMAND_KINDS has no AddMatch. */
  addFixture(home: string, away: string): FakeFixture {
    const round = Math.max(0, ...this.fixtures.map((f) => f.round_no ?? 0)) + 1;
    return this.seat(round, home, away);
  }
}
