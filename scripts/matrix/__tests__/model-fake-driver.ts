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
//  - a withdrawal's expunge rides the ledger as the product's does
//    (withdrawal.ts voidAndAbandon), and rebuild refuses once any fixture has
//    a score event or a result (stages.ts rebuildStageFixtures).
// The faults are opt-in. fault879 reproduces issue #879's SHAPE, not a blanket
// fault: only once an entrant has been added AFTER the stage started does
// Generate seat every pair again (pre-flight ruling R-PF8).
import { EngineError } from "@seazn/engine/core";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { RefusedCall, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type GenerateOut, type PostedEvent, type StartOut } from "../lib/driver/types.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";

export interface ModelFakeOpts {
  /** #879: after a post-start entrant add, Generate seats every pair again. */
  fault879?: boolean;
  /** Every decided outcome reports a winner nobody posted. */
  lieOutcome?: boolean;
  /** /complete answers 500 with no code. */
  unnamedCompleteRefusal?: boolean;
  /** Generate answers 2xx with zero fixtures (carry b). */
  emptyGenerate?: boolean;
  /** Even legs are NOT mirrored: each pair meets `legs` times in one orientation (carry c). */
  unmirroredLegs?: boolean;
}

/** append-event.ts LOCKED_FIXTURE_STATUSES: refused before the fold. */
const LOCKED = new Set(["finalized", "cancelled"]);
/** lib/table-withdrawal.ts WITHDRAWAL_PLAYED_STATUSES: a result to void first. */
const SETTLED = new Set(["decided", "finalized", "forfeited"]);
/** withdrawal.ts voidAndAbandon: the events an expunge never voids. */
const NOT_VOIDED = new Set(["core.start", "core.void", "core.note", "core.award"]);
/** withdrawal.ts REASON. */
const REASON = "entrant withdrew";

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
  /** An entrant was added after the stage started (#879's trigger). Reset per division. */
  #lateEntrant = false;
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
    return super.createDivision(c, i);
  }
  override addEntrants(_d: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    return Promise.resolve().then(() => {
      this.log("addEntrants");
      // FakeLeagueDriver.start() — and this one — flip the stage from "pending" to "active".
      if (es.length > 0 && this.stage !== null && this.stage.status !== "pending") this.#lateEntrant = true;
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
  override start(): Promise<StartOut> {
    return Promise.resolve().then(() => {
      this.log("start");
      if (this.stage === null) throw new Error("fake: start before postStages");
      for (const s of this.schedule()) this.seat(s.round, s.home, s.away);
      this.stage.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
    });
  }
  override generate(): Promise<GenerateOut> {
    return Promise.resolve().then(() => {
      this.log("generate");
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
        out.push({ seq: ledger.length, status: f.status, outcome: f.outcome, event_id: eid });
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
  override rebuild(_stageId: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.log("rebuild");
      if (this.fixtures.some((f) => (this.ledgers.get(f.id) ?? []).length > 0 || f.outcome !== null)) {
        throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 409, "STAGE_HAS_RESULTS", "stage already has recorded results");
      }
      this.fixtures = [];
      for (const s of this.schedule()) this.seat(s.round, s.home, s.away);
    });
  }
  override completeStage(): Promise<CompleteOut> {
    if (this.opts.unnamedCompleteRefusal === true) return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/complete", 500, null, "boom"));
    return super.completeStage();
  }
  /** A test hook for stages.ts addFixture (PROMPT-66): an ad-hoc match on a
   *  running league — "a replay, a friendly, a manual tie-breaker or a missing
   *  match". Not a model command: COMMAND_KINDS has no AddMatch. */
  addFixture(home: string, away: string): FakeFixture {
    const round = Math.max(0, ...this.fixtures.map((f) => f.round_no ?? 0)) + 1;
    return this.seat(round, home, away);
  }
}
