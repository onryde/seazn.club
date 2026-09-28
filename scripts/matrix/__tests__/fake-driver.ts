// In-memory OrganiserDriver for the scenario tests (Task 8). It proves WIRING
// and canary mechanics, never product truth: outcomes come from folding the
// posted stream through the real engine module, standings from the module's
// own standingsDelta, and the rules it mirrors are the product's, each cited.
//
// FakeLeagueDriver is a single-stage LEAGUE and refuses anything else with
// "fake: league only" (Task 9's run-cli test pins that message). FakeSwissDriver
// is the separate swiss fake Task 8 Step 9 allows for, so the swiss branch of
// playStage (per-round generate, pair rounds, byes) is witnessed DB-free.
import type { MatchOutcome, StageKind } from "@seazn/engine/core";
import type { StagePostBody } from "../lib/catalogue.ts";
import { declaredPoints, foldStream, lineupsFor } from "../lib/fold.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import {
  RefusedCall,
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

  async createCompetition(i: { name: string; slug: string }): Promise<CompetitionRef> { this.log("createCompetition"); return { id: "c1", slug: i.slug, orgId: this.orgId }; }
  async createDivision(_c: string, i: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    this.log("createDivision");
    this.sport = i.sportKey;
    this.variant = i.variantKey;
    this.cfg = resolveSportCfg(i.sportKey, i.variantKey);
    // divisions.ts createDivision stores the PARSED preset+overrides.
    this.divisionConfig = { ...(resolveSportCfg(i.sportKey, i.variantKey, i.config ?? {}) as Record<string, unknown>) };
    return { id: "d1", slug: i.slug, sportKey: i.sportKey, variantKey: i.variantKey, config: { ...this.divisionConfig } };
  }
  async getDivision(): Promise<DivisionRef> {
    this.log("getDivision");
    return { id: "d1", slug: "d", sportKey: this.sport, variantKey: this.variant, config: { ...this.divisionConfig } };
  }
  acceptsStage(kind: string): boolean { return kind === "league"; }
  refuseStages(): never { throw new Error("fake: league only"); }
  async postStages(_d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    this.log("postStages");
    if (stages.length !== 1 || !this.acceptsStage(stages[0]!.kind)) this.refuseStages();
    this.stage = { id: "s1", seq: 1, kind: stages[0]!.kind, config: { ...stages[0]!.config }, status: "pending" };
    return [this.stage];
  }
  async listStages(): Promise<StageRef[]> { this.log("listStages"); return this.stage ? [{ ...this.stage }] : []; }
  async addEntrants(_d: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    this.log("addEntrants");
    this.entrants = es.map((e, i) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered" }));
    return this.entrants.map((e) => ({ ...e }));
  }
  /** Circle-method rounds over the entrant ids, "BYE" padding an odd field. */
  circle(): [string, string][][] {
    const ring = this.entrants.length % 2 === 0 ? this.entrants.map((e) => e.id) : [...this.entrants.map((e) => e.id), "BYE"];
    const rounds: [string, string][][] = [];
    for (let r = 0; r < ring.length - 1; r++) {
      const pairs: [string, string][] = [];
      for (let i = 0; i < ring.length / 2; i++) pairs.push([ring[i]!, ring[ring.length - 1 - i]!]);
      rounds.push(pairs);
      ring.splice(1, 0, ring.pop()!);
    }
    return rounds;
  }
  seat(round: number, home: string, away: string | null, extra: Partial<FakeFixture> = {}): void {
    const no = this.fixtures.length + 1;
    this.fixtures.push({ id: `f${no}`, stage_id: "s1", pool_id: null, round_no: round, fixture_no: no, home_entrant_id: home, away_entrant_id: away, status: "scheduled", outcome: null, events: [], ...extra });
  }
  async start(): Promise<StartOut> {
    this.log("start");
    for (const [r, pairs] of this.circle().entries()) {
      for (const [h, a] of pairs) if (h !== "BYE" && a !== "BYE") this.seat(r + 1, h, a);
    }
    this.stage!.status = "active";
    return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
  }
  rows(): FixtureRow[] { return this.fixtures.map(({ events: _e, ...f }) => ({ ...f })); }
  async generate(): Promise<GenerateOut> { this.log("generate"); return { created: 0, existing: this.fixtures.length, fixtures: this.rows() }; }
  async listFixtures(): Promise<FixtureRow[]> { this.log("listFixtures"); return this.rows(); }
  async fixtureState(id: string): Promise<FixtureStateOut> { this.log("fixtureState"); const f = this.#f(id); return { status: f.status, last_seq: f.events.length, outcome: f.outcome }; }
  /** One event at a time, like HttpDriver's POST per event: each answer
   *  carries the fixture's status and outcome AFTER that event, and a refused
   *  event leaves the ones before it appended. */
  async postStream(id: string, events: readonly StreamEvent[], _prefix = ""): Promise<PostedEvent[]> {
    this.log("postStream");
    const f = this.#f(id);
    const out: PostedEvent[] = [];
    for (const ev of events) {
      const next = [...f.events, ev];
      let folded: ReturnType<typeof foldStream>;
      try {
        folded = foldStream(sportModule(this.sport), this.cfg, f.home_entrant_id!, f.away_entrant_id!, next);
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, typeof code === "string" ? code : null, (e as Error).message);
      }
      f.events = next;
      f.outcome = folded.outcome;
      f.status = folded.outcome === null ? "in_play" : f.events.some((e) => e.type === "core.forfeit") ? "forfeited" : "decided";
      out.push({ seq: f.events.length, status: f.status, outcome: f.outcome, event_id: `${id}-${f.events.length}` });
    }
    return out;
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
  async completeStage(): Promise<CompleteOut> {
    this.log("completeStage");
    this.completed = this.fixtures.every((f) => f.status !== "scheduled" && f.status !== "in_play");
    return { completed: this.completed, events: [] };
  }
  /** The table the product folds: [home, away] deltas from standingsDelta over
   *  each result, and a one-sided award (bye) scored the way
   *  engine-db/competition.ts awardByeDelta does it. */
  async standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
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
        const state = m.init(this.cfg as never, lineupsFor(home ? o.winner : BYE_PHANTOM, home ? BYE_PHANTOM : o.winner));
        const pair = m.standingsDelta(o, this.cfg as never, ctx, state as never);
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
  }
  async publicStandings(): Promise<PublicStandingsOut> {
    this.log("publicStandings");
    return { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: (await this.standings("s1", null)).rows }] };
  }
  /** divisions.ts:795-870: once fixtures exist, a config that does not parse or
   *  changes anything but `entrants` is 409 FORMAT_LOCKED; otherwise it saves. */
  async patchDivisionConfig(_d: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
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
  }
  #f(id: string): FakeFixture { const f = this.fixtures.find((x) => x.id === id); if (!f) throw new Error(`fake: no fixture ${id}`); return f; }
}

/** A single swiss stage: round r is paired only once every earlier fixture is
 *  finished (the product's swiss gate), from the circle method so no pair
 *  repeats; an odd field or a withdrawn opponent becomes a one-sided forfeited
 *  AWARD row (engine competition/stage.ts:30-34). Swiss never expunges
 *  (withdrawal.ts:6-8). */
export class FakeSwissDriver extends FakeLeagueDriver {
  schedule: [string, string][][] = [];
  paired = 0;
  override acceptsStage(kind: string): boolean { return kind === "swiss"; }
  override refuseStages(): never { throw new Error("fake: swiss only"); }
  override expungesEarly(): boolean { return false; }
  get budget(): number { return Number(this.stage!.config.rounds); }
  /** Who no longer gets paired (the withdrawn). */
  sittingOut(): Set<string> { return new Set(this.entrants.filter((e) => e.status === "withdrawn").map((e) => e.id)); }
  pairNext(): number {
    const r = this.paired + 1;
    const pairs = this.schedule[r - 1];
    if (pairs === undefined || r > this.budget) return 0;
    const out = this.sittingOut();
    const before = this.fixtures.length;
    for (const [h, a] of pairs) {
      const hOut = h === "BYE" || out.has(h);
      const aOut = a === "BYE" || out.has(a);
      if (hOut && aOut) continue;
      if (hOut || aOut) {
        const who = hOut ? a : h;
        this.seat(r, who, null, { status: "forfeited", outcome: { kind: "award", winner: who, method: "bye" } });
      } else this.seat(r, h, a);
    }
    this.paired = r;
    return this.fixtures.length - before;
  }
  override async start(): Promise<StartOut> {
    this.log("start");
    this.schedule = this.circle();
    this.pairNext();
    this.stage!.status = "active";
    return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
  }
  override async generate(): Promise<GenerateOut> {
    this.log("generate");
    const allDone = this.fixtures.every((f) => !PENDING.has(f.status));
    const created = allDone ? this.pairNext() : 0;
    return { created, existing: this.fixtures.length - created, fixtures: this.rows() };
  }
}
