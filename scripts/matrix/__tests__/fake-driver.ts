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
import { EngineError, type MatchOutcome, type StageKind } from "@seazn/engine/core";
import type { StagePostBody } from "../lib/catalogue.ts";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { declaredPoints, foldStream, lineupsFor } from "../lib/fold.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import {
  RefusedCall, idempotencyKey,
  type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type GenerateOut, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type StageRef, type StandingsOut, type StartOut, type WithdrawOut,
} from "../lib/driver/types.ts";

export interface FakeFixture extends FixtureRow { events: StreamEvent[] }

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
// stages.ts:979 — what the swiss gate counts as a finished board.
const DECIDED = new Set(["decided", "finalized", "forfeited"]);

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
  log(m: string): void { this.calls.push(m); }

  createCompetition(i: { name: string; slug: string }): Promise<CompetitionRef> { return settle(() => { this.log("createCompetition"); return { id: "c1", slug: i.slug, orgId: this.orgId }; }); }
  createDivision(_c: string, i: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return settle(() => {
      this.log("createDivision");
      this.sport = i.sportKey;
      this.variant = i.variantKey;
      this.cfg = resolveSportCfg(i.sportKey, i.variantKey);
      // divisions.ts createDivision stores the PARSED preset+overrides.
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
  addEntrants(_d: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    return settle(() => {
      this.log("addEntrants");
      this.entrants = es.map((e, i) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered" }));
      return this.entrants.map((e) => ({ ...e }));
    });
  }
  listEntrants(): Promise<EntrantRow[]> { return settle(() => { this.log("listEntrants"); return this.entrants.map((e) => ({ ...e })); }); }
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
      this.log("postStream");
      const f = this.#f(id);
      const seen = this.keys.get(id) ?? new Map<string, PostedEvent>();
      this.keys.set(id, seen);
      const out: PostedEvent[] = [];
      for (const ev of events) {
        // HttpDriver's key for this event: the same shared function, at the seq it expects.
        const key = idempotencyKey(prefix, f.events.length);
        const replay = seen.get(key);
        if (replay !== undefined) { out.push(replay); continue; }
        const next = [...f.events, ev];
        let folded: ReturnType<typeof foldStream>;
        try {
          folded = foldStream(sportModule(this.sport), this.cfg, f.home_entrant_id!, f.away_entrant_id!, next);
        } catch (e) {
          // The product turns ONLY an EngineError into a status (http.ts:157-158);
          // anything else is a 500 INTERNAL there (http.ts:244-247). Here that is a
          // harness fault, so it surfaces as itself, never as an engine refusal.
          if (!EngineError.is(e)) throw e;
          throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, engineHttpStatus(e.code), e.code, e.message);
        }
        f.events = next;
        f.outcome = folded.outcome;
        f.status = folded.outcome === null ? "in_play" : f.events.some((e) => e.type === "core.forfeit") ? "forfeited" : "decided";
        const posted: PostedEvent = { seq: f.events.length, status: f.status, outcome: f.outcome, event_id: `${id}-${f.events.length}` };
        seen.set(key, posted);
        out.push(posted);
      }
      return out;
    });
  }
  async forfeit(id: string, by: string, reason: "walkover" | "retired hurt", prefix = ""): Promise<PostedEvent[]> {
    this.log("forfeit");
    const s = this.#f(id).status;
    const ev: StreamEvent = { type: "core.forfeit", payload: { by, reason } };
    // http-driver.ts forfeit: START only on a scheduled fixture.
    return this.postStream(id, s === "scheduled" ? [{ type: "core.start", payload: {} }, ev] : [ev], prefix);
  }
  /** withdrawal.ts:130-200 + stage.ts withdrawTableEntrant: played < 50% of
   *  (played + pending) expunges, otherwise pending games walk over; finalized
   *  and cancelled are skipped; a TBD opponent is voided, not walked over. */
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
    const touched = policy === "expunge" ? [...played, ...pending] : pending;
    for (const f of touched) {
      if (f.status === "finalized" || f.status === "cancelled") { skipped++; continue; }
      const opponent = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
      if (policy === "walkover" && opponent !== null) { await this.forfeit(f.id, entrantId, "walkover"); walkovers++; continue; }
      f.status = "abandoned";
      f.outcome = null;
      voided++;
    }
    this.entrants.find((e) => e.id === entrantId)!.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy, walkovers, voided, skipped_finalized: skipped };
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
  standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    return settle(() => {
      this.log("standings");
      const pts = new Map(this.entrants.map((e) => [e.id, 0]));
      const m = sportModule(this.sport);
      const kind = this.stage!.kind as StageKind;
      for (const f of this.fixtures) {
        if (f.outcome === null) continue;
        const ctx = { kind, ...(f.round_no ? { roundNo: f.round_no } : {}) };
        if (f.home_entrant_id === null || f.away_entrant_id === null) {
          const o = f.outcome as MatchOutcome;
          if (o.kind !== "award") continue;
          const home = f.home_entrant_id === o.winner;
          const state: unknown = m.init(this.cfg, lineupsFor(home ? o.winner : BYE_PHANTOM, home ? BYE_PHANTOM : o.winner));
          const pair = m.standingsDelta(o, this.cfg, ctx, state);
          const won = pair.find((d) => d.entrantId === o.winner)!;
          pts.set(o.winner, pts.get(o.winner)! + won.points);
          continue;
        }
        const d = declaredPoints(m, this.cfg, ctx, f.home_entrant_id, f.away_entrant_id, f.events)!;
        pts.set(f.home_entrant_id, pts.get(f.home_entrant_id)! + d.home);
        pts.set(f.away_entrant_id, pts.get(f.away_entrant_id)! + d.away);
      }
      const rows = [...pts].sort((a, b) => b[1] - a[1]).map(([entrantId, points], i) => ({ entrantId, rank: i + 1, points }));
      return { stage_id: stageId, pool_id: poolId, rows };
    });
  }
  async publicStandings(): Promise<PublicStandingsOut> {
    this.log("publicStandings");
    return { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: (await this.standings("s1", null)).rows }] };
  }
  /** divisions.ts:795-870: once fixtures exist, a config that does not parse or
   *  changes anything but `entrants` is 409 FORMAT_LOCKED; otherwise it saves. */
  patchDivisionConfig(_d: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
    return settle(() => {
      this.log("patchDivisionConfig");
      const locked = this.fixtures.length > 0;
      let parsed: Record<string, unknown>;
      try {
        parsed = resolveSportCfg(this.sport, this.variant, config) as Record<string, unknown>;
      } catch {
        return locked ? { status: 409, code: "FORMAT_LOCKED" } : { status: 422, code: "CONFIG_INVALID" };
      }
      if (locked && canonical(withoutEntrants(parsed)) !== canonical(withoutEntrants(this.divisionConfig))) return { status: 409, code: "FORMAT_LOCKED" };
      const entrants = config.entrants;
      this.divisionConfig = entrants != null && typeof entrants === "object" ? { ...parsed, entrants } : parsed;
      return { status: 200, code: null };
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
    if (want.bye) Object.assign(byeShell!, { home_entrant_id: byes[0], status: "forfeited", outcome: { kind: "award", winner: byes[0] } });
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
 *  they went out in, later first, seed order within a round. Standings and
 *  withdraw are the table fake's — no test drives LIFECYCLE or R4 here. */
export class FakeKnockoutDriver extends FakeLeagueDriver {
  /** fixture id → the next round's fixture and slot its winner fills. */
  readonly feeds = new Map<string, { to: string; slot: "home_entrant_id" | "away_entrant_id" }>();
  override acceptsStage(kind: string): boolean { return kind === "knockout"; }
  override refuseStages(): never { throw new Error("fake: knockout only"); }
  override expungesEarly(): boolean { return false; }
  /** Whether a finished fixture's winner goes on — a test seam for a product
   *  that drops one. */
  carriesForward(_f: FakeFixture): boolean { return true; }
  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      const size = 2 ** Math.ceil(Math.log2(Math.max(2, this.entrants.length)));
      let order = [1, 2];
      while (order.length < size) order = order.flatMap((s) => [s, order.length * 2 + 1 - s]);
      const bySeed = (s: number) => this.entrants.find((e) => e.seed === s)?.id ?? null;
      let round = order.flatMap((_, i) => (i % 2 === 0 ? [[bySeed(order[i]), bySeed(order[i + 1])] as const] : []))
        .map(([h, a]) => (h !== null && a !== null ? this.seat(1, h, a)
          : this.seat(1, h ?? a, null, { status: "forfeited", outcome: { kind: "award", winner: (h ?? a)! } })));
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
    const w = (f.outcome as { winner?: unknown } | null)?.winner;
    const to = this.feeds.get(f.id);
    if (typeof w !== "string" || to === undefined || !this.carriesForward(f)) return;
    Object.assign(this.fixtures.find((x) => x.id === to.to)!, { [to.slot]: w });
  }
  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const out = await super.postStream(id, events, prefix);
    const f = this.fixtures.find((x) => x.id === id)!;
    if (f.outcome !== null) this.feed(f);
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
        if (typeof w !== "string" || f.home_entrant_id === null || f.away_entrant_id === null) continue;
        out.push({ id: w === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id, round: f.round_no ?? 0 });
        if (!this.feeds.has(f.id)) champion = w;
      }
      out.sort((a, b) => b.round - a.round || seed(a.id) - seed(b.id));
      return { completed: true, events: [{ type: "stage_completed", finalRanks: [...(champion === null ? [] : [champion]), ...out.map((x) => x.id)] }] };
    });
  }
}
