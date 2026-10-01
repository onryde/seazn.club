// In-memory MULTI-STAGE OrganiserDriver for the seed advance (W1-driving
// Task 6). Like fake-driver.ts it proves WIRING, never product truth: results
// fold the posted stream through the real engine module, the later stages'
// TBD shape and the seed resolution are the ENGINE's own (expandSources,
// placeDescriptors, resolveProgression, the bracket and round-robin
// generators), and every product rule it mirrors is cited. What it cannot
// show is anything the product decides that the engine does not: a live
// smoke owns that (Task 12 Step 7).
//
// The shape it mirrors (usecases/stages.ts, pinned at ebf7ec040):
//  - Start draws stage 1 only (schedule.ts:3857-3888). Stage 1 is a league or
//    a group; a later stage is a knockout, group, stepladder or page playoff
//    body with `progression.timing: "setup"`.
//  - A later stage's generate draws TBD rows over synthetic `slot:k` seeds
//    (generateProgressionSetupFixtures, :3203). It is IDEMPOTENT and never
//    refuses after the source completes (false premise FP-1): it inserts only
//    what is missing and answers the whole stage.
//  - /complete commits, THEN computes the next stage's draft proposal
//    (progressCompletedStage :4178, computeSeedProposal :4774). A compute that
//    fails — no TBD rows yet among them — is 409
//    STAGE_COMPLETED_SEEDING_FAILED with the stage already complete
//    (:4222-4252). A second /complete is the harness's DriverMisuse, as
//    HttpDriver's guard makes it (FP-4).
//  - A departed (withdrawn) qualifier is never offered, and her SEAT IS LEFT
//    EMPTY: nobody is promoted (:4889-4905, FP-2). A one-sided line becomes a
//    walkover to the seated side, a line with neither side becomes abandoned
//    (confirm :5178-5207, resolveBracketSeats).
//  - Confirm (:4997): 404 unknown id, 409 SEEDING_ALREADY_CONFIRMED, 409
//    SEEDING_PROPOSAL_STALE, 422 SEEDING_TIE_UNRESOLVED (+ slots, entrantIds),
//    422 SEEDING_ENTRANT_WITHDRAWN for a draft computed before a withdrawal,
//    422 SEEDING_NOTHING_TO_FILL; it answers the WHOLE target stage.
//  - Withdraw (withdrawal.ts:128-232) runs per stage: a table stage by the
//    50% rule, a bracket-walkover kind forfeits each pending line to the
//    opponent (a TBD opponent voids it), any other kind voids. A repeat is
//    409 "entrant is already withdrawn", codeless on the wire.
import { EngineError, type MatchOutcome, type StageKind } from "@seazn/engine/core";
import { expandSources, placeDescriptors, resolveProgression, type PoolTable, type ProgressionSpec, type StandingsRow } from "@seazn/engine/competition";
import { generateAmericano, generatePagePlayoff, generateRoundRobin, generateSingleElim, generateStepladder, pairMexicanoRound, type AmericanoRound, type GeneratedBracket } from "@seazn/engine/scheduling";
import type { StagePostBody } from "../lib/catalogue.ts";
import { engineHttpStatus } from "../lib/driver/engine-http.ts";
import { declaredPoints, foldStream, lineupsFor } from "../lib/fold.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import {
  DriverMisuse, RefusedCall, inSquadOrder,
  type AmericanoViewOut, type ChallengeOut, type CompleteOut, type EntrantMember, type EntrantRow, type FixtureRow, type MemberInput, type GenerateOut, type PostedEvent, type PublicStandingsOut, type SeedConfirmOut, type SeedProposalOut, type SeedTie,
  type StageRef, type StandingsOut, type StartOut, type WithdrawOut,
} from "../lib/driver/types.ts";
import { isTerminal } from "../lib/observed.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";
import { departedStatusesText, ladderText, wireCodeFor } from "./product-text.ts";

export interface FakeMultiStageOptions {
  /** The TARGET stage seq whose proposals flag a tie between seeds 2 and 3,
   *  the two entrants listed in REVERSE rank order, so taking the product's
   *  listed order is a different seating from the default one. */
  readonly tieAt?: number;
  /** Stage 1's generate is refused by name, so stage 1 never drains. */
  readonly refuseGenerateOnStage1?: boolean;
  /** A deliberately WRONG product (FP-2's opposite): a withdrawn entrant is
   *  seeded anyway, in the last seat. Only the advance-seeded-as-declared
   *  guard's own test uses it. */
  readonly seedWithdrawn?: boolean;
  /** Only the FIRST proposal for `tieAt` flags its tie; a recompute lists
   *  none (fix round 1, m-9: a tie refusal whose recompute has nothing left
   *  to pick). */
  readonly tieOnlyOnFirst?: boolean;
  /** A deliberately WRONG product (fix round 1, m-1): confirm leaves the
   *  highest offered seed's seat EMPTY for no departed qualifier — it walks
   *  over like a vacancy. */
  readonly dropLastSeat?: boolean;
  /** Every confirm is refused 422 with this code (fix round 1, m-4). */
  readonly refuseConfirm?: string;
  /** The stage at this seq commits on /complete and then answers 409
   *  STAGE_COMPLETED_SEEDING_FAILED, as a failed compute does after the
   *  commit (stages.ts:4239-4252; fix round 1, m-7). */
  readonly failSeedingOnComplete?: number;
}

type Side = "home" | "away";
const SIDES: readonly Side[] = ["home", "away"];
const KEY: Readonly<Record<Side, "home_entrant_id" | "away_entrant_id">> = { home: "home_entrant_id", away: "away_entrant_id" };
// stages.ts POOL_KEYS.
const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TABLE = new Set(["league", "group"]);
const LATER = new Set(["knockout", "group", "stepladder", "page_playoff"]);
const BRACKETS = new Set(["knockout", "stepladder", "page_playoff"]);
// stages.ts:880 BRACKET_WALKOVER_KINDS, the part of it this fake draws.
const BRACKET_WALKOVER = new Set(["knockout", "stepladder"]);
const PENDING = new Set(["scheduled", "in_play"]);
const PLAYED = new Set(["decided", "finalized", "forfeited"]);
const BYE_PHANTOM = "__bye__"; // engine-db/competition.ts:79

interface MultiStage extends StageRef { body: StagePostBody; poolKeys: string[] }
interface Offered { seed: number; entrantId: string }
interface Proposal { id: string; seq: number; status: "draft" | "stale" | "confirmed"; offered: Offered[]; ties: SeedTie[] }

/** Seeded snake (stages.ts:1579 snakeDistribute): 1..N, then N..1. */
function snake<T>(ordered: readonly T[], count: number): T[][] {
  const pools: T[][] = Array.from({ length: count }, () => []);
  for (const [i, x] of ordered.entries()) {
    const lap = Math.floor(i / count);
    const pos = i % count;
    pools[lap % 2 === 0 ? pos : count - 1 - pos].push(x);
  }
  return pools;
}

function settle<T>(body: () => T): Promise<T> {
  return new Promise<T>((resolve) => { resolve(body()); });
}

export class FakeMultiStageDriver extends FakeLeagueDriver {
  readonly opts: FakeMultiStageOptions;
  stages: MultiStage[] = [];
  /** TBD row → the seed each of its sides waits for (`slot:k` → k). */
  readonly slotsOf = new Map<string, Partial<Record<Side, number>>>();
  /** A bracket's bye line (the generator's `award`): decided by its one seed. */
  readonly byeLines = new Set<string>();
  readonly feeds = new Map<string, { to: string; side: Side }>();
  readonly loserFeeds = new Map<string, { to: string; side: Side }>();
  /** A side whose seed departed: the product's BYE label. */
  readonly vacant = new Map<string, Set<Side>>();
  /** pool key (`<stage>:<pool id or "">`) → its members, as drawn. */
  readonly members2 = new Map<string, string[]>();
  readonly proposals: Proposal[] = [];
  readonly completedStages = new Set<string>();
  /** Every /complete that COMMITTED, in order (a not-ready one answers
   *  `completed: false` and commits nothing, stages.ts completeStageIfReady). */
  readonly commits: string[] = [];
  /** target seq → the entrants confirm seated, in row order. */
  readonly seated = new Map<number, string[]>();
  /** Ids of every proposal confirm accepted. */
  readonly confirmedProposalIds: string[] = [];
  #lastPicks: readonly { slots: readonly string[]; order: readonly string[] }[] | null = null;
  #lastRecomputedTies: readonly SeedTie[] = [];

  constructor(opts: FakeMultiStageOptions = {}, orgId = "org-fake") {
    super(orgId);
    this.opts = opts;
  }

  // ---- what the tests read -------------------------------------------------
  stageIdAt(seq: number): string {
    const s = this.stages.find((x) => x.seq === seq);
    if (s === undefined) throw new Error(`fake: no stage at seq ${seq}`);
    return s.id;
  }
  /** The proposal id /complete handed out for the stage at `seq` (the first one). */
  proposalIssuedFor(seq: number): string {
    const p = this.proposals.find((x) => x.seq === seq);
    if (p === undefined) throw new Error(`fake: no proposal was issued for stage ${seq}`);
    return p.id;
  }
  seededInto(seq: number): string[] { return [...(this.seated.get(seq) ?? [])]; }
  lastTiePicks(): readonly { slots: readonly string[]; order: readonly string[] }[] | null { return this.#lastPicks; }
  tiesListed(): readonly SeedTie[] { return this.#lastRecomputedTies; }
  fixturesOfStage(seq: number): FixtureRow[] { return this.rowsOf(this.stageIdAt(seq)); }
  seedOf(entrantId: string): number {
    const e = this.entrants.find((x) => x.id === entrantId);
    if (e === undefined || e.seed === null) throw new Error(`fake: entrant ${entrantId} has no seed`);
    return e.seed;
  }
  rowsOf(stageId: string): FixtureRow[] { return this.rows().filter((f) => f.stage_id === stageId); }

  // ---- the product ---------------------------------------------------------
  override acceptsStage(kind: string): boolean { return TABLE.has(kind); }
  override refuseStages(): never { throw new Error("fake: multi-stage only — stage 1 league|group, later knockout|group|stepladder|page_playoff with timing 'setup'"); }
  override postStages(_d: string, bodies: readonly StagePostBody[]): Promise<StageRef[]> {
    return settle(() => {
      this.log("postStages");
      const ok = bodies.length >= 2 && TABLE.has(bodies[0].kind)
        && bodies.slice(1).every((b) => LATER.has(b.kind) && (b.progression as { timing?: unknown } | null)?.timing === "setup");
      if (!ok) this.refuseStages();
      this.stages = bodies.map((b, i) => ({
        id: `s${i + 1}`, seq: i + 1, kind: b.kind, config: { ...b.config }, status: "pending", body: b,
        poolKeys: b.kind === "group" ? [...POOL_KEYS.slice(0, this.#poolCount(b.config))] : [],
      }));
      this.stage = this.#ref(this.stages[0]);
      return this.stages.map((s) => this.#ref(s));
    });
  }
  override listStages(): Promise<StageRef[]> { return settle(() => { this.log("listStages"); return this.stages.map((s) => this.#ref(s)); }); }
  #ref(s: MultiStage): StageRef { return { id: s.id, seq: s.seq, kind: s.kind, config: { ...s.config }, status: s.status }; }
  #poolCount(cfg: Record<string, unknown>): number {
    const n = (cfg.pools as { count?: unknown } | undefined)?.count;
    return typeof n === "number" ? n : 1;
  }
  #stage(method: string, stageId: string): MultiStage {
    const s = this.stages.find((x) => x.id === stageId);
    if (s === undefined) throw new RefusedCall(method, `/api/v1/stages/${stageId}`, 404, wireCodeFor(404), "stage not found");
    return s;
  }
  #engine<T>(method: string, path: string, body: () => T): T {
    try {
      return body();
    } catch (e) {
      // http.ts: an EngineError reaches the wire as its own code and status.
      if (!EngineError.is(e)) throw e;
      throw new RefusedCall(method, path, engineHttpStatus(e.code), e.code, e.message);
    }
  }

  /** A table stage's rows: snake into pools by seed, a round robin per pool
   *  (stages.ts generate :1632-1646, roundRobinGen). `tbd`: the seeds are
   *  synthetic `slot:k` ids, so the rows wait for confirm. */
  #tableRows(stage: MultiStage, seeded: readonly { id: string; seed: number }[], tbd: boolean): void {
    const ordered = [...seeded].sort((a, b) => a.seed - b.seed);
    const count = stage.kind === "group" ? this.#poolCount(stage.config) : 1;
    const pools = count === 1 ? [ordered] : snake(ordered, count);
    const legs = typeof stage.config.legs === "number" ? stage.config.legs : 1;
    pools.forEach((members, i) => {
      const poolId = count === 1 ? null : `${stage.id}-${POOL_KEYS[i]}`;
      if (!tbd) this.members2.set(`${stage.id}:${poolId ?? ""}`, members.map((m) => m.id));
      const seedOf = new Map(members.map((m) => [m.id, m.seed]));
      const rr = generateRoundRobin({ entrants: members.map((m) => m.id), seeds: seedOf, config: { legs } });
      for (const g of rr.fixtures) {
        const ext = `${count === 1 ? "" : `p${POOL_KEYS[i]}-`}${g.id}`;
        const f = this.seat(g.roundNo, tbd ? null : g.home, tbd ? null : g.away, { stage_id: stage.id, pool_id: poolId, ext_key: ext });
        if (tbd) this.slotsOf.set(f.id, { home: seedOf.get(g.home)!, away: seedOf.get(g.away)! });
      }
    });
  }
  /** A bracket stage's TBD rows from the engine's generator (stages.ts
   *  generate :1648-1675); its round r is round_no r + 1. */
  #bracketRows(stage: MultiStage, seeded: readonly { id: string; seed: number }[]): void {
    const ids = seeded.map((s) => s.id);
    const seeds = new Map(seeded.map((s) => [s.id, s.seed]));
    const b: GeneratedBracket = stage.kind === "knockout" ? generateSingleElim({ entrants: ids, seeds, thirdPlace: stage.config.thirdPlace === true })
      : stage.kind === "stepladder" ? generateStepladder({ entrants: ids, seeds })
      : generatePagePlayoff({ entrants: ids, seeds });
    const rowOf = new Map<string, string>();
    for (const g of b.fixtures) {
      const f = this.seat(g.round + 1, null, null, { stage_id: stage.id, ext_key: g.id, is_final: g.isFinal === true, ...(g.thirdPlace === true ? { third_place: true } : {}) });
      rowOf.set(g.id, f.id);
      const slot: Partial<Record<Side, number>> = {};
      if (g.home !== undefined) slot.home = seeds.get(g.home)!;
      if (g.away !== undefined) slot.away = seeds.get(g.away)!;
      if (g.award !== undefined) { this.byeLines.add(f.id); slot.home ??= seeds.get(g.award)!; }
      this.slotsOf.set(f.id, slot);
    }
    for (const g of b.fixtures) {
      for (const [ref, side] of [[g.homeFrom, "home"], [g.awayFrom, "away"]] as const) {
        if (ref === undefined) continue;
        (ref.side === "winner" ? this.feeds : this.loserFeeds).set(rowOf.get(ref.fixtureId)!, { to: rowOf.get(g.id)!, side });
      }
    }
  }

  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      const first = this.stages[0];
      this.#tableRows(first, this.entrants.map((e) => ({ id: e.id, seed: e.seed ?? Number.MAX_SAFE_INTEGER })), false);
      first.status = "active";
      this.stage = this.#ref(first);
      return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
    });
  }

  // The base fake's generate takes no stage (one stage); this one is asked per stage.
  override generate(stageId: string = this.stages[0]?.id ?? ""): Promise<GenerateOut> {
    return settle(() => {
      this.log("generate", stageId);
      const path = `/api/v1/stages/${stageId}/generate`;
      const stage = this.#stage("POST", stageId);
      if (stage.seq === 1) {
        if (this.opts.refuseGenerateOnStage1 === true) throw new RefusedCall("POST", path, engineHttpStatus("STAGE_NOT_READY"), "STAGE_NOT_READY", "fake: stage 1's generate refused (refuseGenerateOnStage1)");
        const rows = this.rowsOf(stageId);
        return { created: 0, existing: rows.length, fixtures: rows };
      }
      const had = this.rowsOf(stageId).length;
      if (had === 0) {
        this.#engine("POST", path, () => {
          const source = this.stages[stage.seq - 2];
          const spec = stage.body.progression as unknown as ProgressionSpec;
          const placed = placeDescriptors(expandSources(spec.sources, () => ({ poolKeys: [...source.poolKeys] })), spec.placement, spec.map, stage.kind);
          // generateProgressionSetupFixtures: fewer than 2 qualifiers is STAGE_NOT_READY.
          if (placed.length < 2) throw new EngineError("STAGE_NOT_READY", "this stage's progression rules produce fewer than 2 qualifiers");
          const slots = placed.map((_, i) => ({ id: `slot:${i + 1}`, seed: i + 1 }));
          if (TABLE.has(stage.kind)) this.#tableRows(stage, slots, true);
          else this.#bracketRows(stage, slots);
        });
      }
      const rows = this.rowsOf(stageId);
      return { created: rows.length - had, existing: had, fixtures: rows };
    });
  }

  /** The members of a stage's pool: stage 1 as drawn (withdrawn ones kept —
   *  the product's tables still carry a departed entrant, stages.ts
   *  departedEntrantIds), a later stage as confirm seated it. */
  #members(stage: MultiStage, poolId: string | null): string[] {
    if (stage.seq === 1) return this.members2.get(`${stage.id}:${poolId ?? ""}`) ?? [];
    const out: string[] = [];
    for (const f of this.fixtures.filter((x) => x.stage_id === stage.id && x.pool_id === poolId)) {
      for (const e of [f.home_entrant_id, f.away_entrant_id]) if (e !== null && !out.includes(e)) out.push(e);
    }
    return out;
  }
  /** fake-driver.ts standings, per stage and pool: standingsDelta over each
   *  result, a one-sided award scored as awardByeDelta does. */
  #table(stage: MultiStage, poolId: string | null): { entrantId: string; rank: number; points: number }[] {
    const pts = new Map(this.#members(stage, poolId).map((e) => [e, 0]));
    const m = sportModule(this.sport);
    const kind = stage.kind as StageKind;
    for (const f of this.fixtures.filter((x) => x.stage_id === stage.id && x.pool_id === poolId)) {
      if (f.outcome === null) continue;
      const ctx = { kind, ...(f.pool_id ? { poolId: f.pool_id } : {}), ...(f.round_no ? { roundNo: f.round_no } : {}) };
      if (f.home_entrant_id === null || f.away_entrant_id === null) {
        const o = f.outcome as MatchOutcome;
        if (o.kind !== "award" || !pts.has(o.winner)) continue;
        const home = f.home_entrant_id === o.winner;
        const state: unknown = m.init(this.cfg, lineupsFor(home ? o.winner : BYE_PHANTOM, home ? BYE_PHANTOM : o.winner));
        const won = m.standingsDelta(o, this.cfg, ctx, state).find((d) => d.entrantId === o.winner)!;
        pts.set(o.winner, pts.get(o.winner)! + won.points);
        continue;
      }
      const d = declaredPoints(m, this.cfg, ctx, f.home_entrant_id, f.away_entrant_id, f.events);
      if (d === null) continue;
      if (pts.has(f.home_entrant_id)) pts.set(f.home_entrant_id, pts.get(f.home_entrant_id)! + d.home);
      if (pts.has(f.away_entrant_id)) pts.set(f.away_entrant_id, pts.get(f.away_entrant_id)! + d.away);
    }
    return [...pts].sort((a, b) => b[1] - a[1]).map(([entrantId, points], i) => ({ entrantId, rank: i + 1, points }));
  }
  #poolIdsOf(stage: MultiStage): (string | null)[] {
    const ids = [...new Set(this.fixtures.filter((f) => f.stage_id === stage.id).map((f) => f.pool_id))];
    return ids.length > 0 ? ids : [null];
  }
  override standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    return settle(() => {
      this.log("standings", stageId);
      return { stage_id: stageId, pool_id: poolId, rows: this.#table(this.#stage("GET", stageId), poolId) };
    });
  }
  override publicStandings(): Promise<PublicStandingsOut> {
    return settle(() => {
      this.log("publicStandings");
      return { division_id: "d1", standings: this.stages.flatMap((s) => this.#poolIdsOf(s).map((poolId) => ({ stage_id: s.id, pool_id: poolId, rows: this.#table(s, poolId) }))) };
    });
  }

  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const out = await super.postStream(id, events, prefix);
    const f = this.fixtures.find((x) => x.id === id)!;
    if (f.outcome !== null) this.#feed(f);
    return out;
  }
  /** scoring.ts → fillSlot: a decided line's winner (and a page playoff's
   *  pp-q1 loser) fills the line it feeds. */
  #feed(f: FakeFixture): void {
    const w = (f.outcome as { winner?: unknown } | null)?.winner;
    if (typeof w !== "string") return;
    const to = this.feeds.get(f.id);
    if (to !== undefined) Object.assign(this.fixtures.find((x) => x.id === to.to)!, { [KEY[to.side]]: w });
    const lo = this.loserFeeds.get(f.id);
    const loser = w === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id;
    if (lo !== undefined && loser !== null) Object.assign(this.fixtures.find((x) => x.id === lo.to)!, { [KEY[lo.side]]: loser });
  }
  #markVacant(fixtureId: string, side: Side): void {
    this.vacant.set(fixtureId, (this.vacant.get(fixtureId) ?? new Set<Side>()).add(side));
  }
  /** confirm's vacated-slot pass and resolveBracketSeats: a line with both
   *  sides vacant is abandoned (and what it fed is vacant too); a bye line,
   *  or one side vacant, walks over to the seated side. */
  #resolveSeats(stage: MultiStage): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const f of this.fixtures.filter((x) => x.stage_id === stage.id && x.status === "scheduled")) {
        const vac = this.vacant.get(f.id) ?? new Set<Side>();
        const bye = this.byeLines.has(f.id);
        if (vac.size === 2 || (bye && vac.has("home"))) {
          f.status = "abandoned";
          for (const feed of [this.feeds.get(f.id), this.loserFeeds.get(f.id)]) if (feed !== undefined) this.#markVacant(feed.to, feed.side);
          changed = true;
          continue;
        }
        const lone = bye ? f.home_entrant_id : vac.has("away") ? f.home_entrant_id : vac.has("home") ? f.away_entrant_id : null;
        if (lone === null) continue;
        f.status = "forfeited";
        f.outcome = { kind: "award", winner: lone };
        this.#feed(f);
        changed = true;
      }
    }
  }

  #departed(): Set<string> { return new Set(this.entrants.filter((e) => e.status === "withdrawn" || e.status === "disqualified").map((e) => e.id)); }
  /** The first destination slot of a seed, `<fixture>:<side>` (computeSeedProposal's display slot). */
  #slotOf(stage: MultiStage, seed: number): string {
    for (const f of this.fixtures.filter((x) => x.stage_id === stage.id)) {
      const s = this.slotsOf.get(f.id) ?? {};
      for (const side of SIDES) if (s[side] === seed) return `${f.id}:${side}`;
    }
    return "";
  }
  #seedOfSlot(slot: string): number | null {
    const [fixtureId, side] = slot.split(":");
    return this.slotsOf.get(fixtureId ?? "")?.[side as Side] ?? null;
  }
  #compute(target: MultiStage, method: string, path: string): Proposal {
    const source = this.stages[target.seq - 2];
    if (source === undefined) throw new RefusedCall(method, path, 422, "SEEDING_RULES_MISSING", "this stage has no progression rules");
    if (this.proposals.some((p) => p.seq === target.seq && p.status === "confirmed")) throw new RefusedCall(method, path, 409, "SEEDING_ALREADY_CONFIRMED", "this stage's slots are already filled from a confirmed proposal");
    if (!this.completedStages.has(source.id)) throw new RefusedCall(method, path, 409, "SEEDING_SOURCE_INCOMPLETE", "the source stage is not complete yet");
    if (this.rowsOf(target.id).length === 0) throw new RefusedCall(method, path, 422, "SEEDING_RULES_MISSING", "this stage has no generated TBD fixtures yet — generate its fixtures first");
    const spec = target.body.progression as unknown as ProgressionSpec;
    const pools: PoolTable[] = this.#poolIdsOf(source).map((poolId) => ({
      pool: poolId === null ? "" : poolId.slice(poolId.lastIndexOf("-") + 1),
      rows: this.#table(source, poolId).map((r): StandingsRow => ({ entrantId: r.entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: r.points, metrics: {}, rank: r.rank })),
    }));
    const { qualifiers } = this.#engine(method, path, () => resolveProgression(spec, [{ poolKeys: [...source.poolKeys] }], [{ pools }], target.kind));
    const departed = this.#departed();
    let offered: Offered[] = qualifiers.map((q) => ({ seed: q.seed, entrantId: q.entrantId }));
    if (this.opts.seedWithdrawn === true) {
      // The wrong product: each departed entrant of the source field takes the last seat.
      for (const d of departed) if (!offered.some((q) => q.entrantId === d) && offered.length > 0) offered[offered.length - 1] = { ...offered[offered.length - 1], entrantId: d };
    } else {
      offered = offered.filter((q) => !departed.has(q.entrantId));
    }
    const ties: SeedTie[] = [];
    if (this.opts.tieAt === target.seq && !(this.opts.tieOnlyOnFirst === true && this.proposals.some((x) => x.seq === target.seq))) {
      const two = offered.find((q) => q.seed === 2);
      const three = offered.find((q) => q.seed === 3);
      if (two !== undefined && three !== undefined) ties.push({ slots: [this.#slotOf(target, 2), this.#slotOf(target, 3)], entrantIds: [three.entrantId, two.entrantId], reason: "points" });
    }
    for (const p of this.proposals) if (p.seq === target.seq && p.status === "draft") p.status = "stale";
    const p: Proposal = { id: `sp-${target.seq}-${this.proposals.filter((x) => x.seq === target.seq).length + 1}`, seq: target.seq, status: "draft", offered, ties };
    this.proposals.push(p);
    return p;
  }

  /** Bracket finish order (fake-driver.ts FakeKnockoutDriver): the champion,
   *  then losers by the round they went out in, later first. */
  #finalRanks(stage: MultiStage): string[] {
    const out: { id: string; round: number }[] = [];
    let champion: string | null = null;
    for (const f of this.fixtures.filter((x) => x.stage_id === stage.id)) {
      const w = (f.outcome as { winner?: unknown } | null)?.winner;
      if (typeof w !== "string" || f.home_entrant_id === null || f.away_entrant_id === null) continue;
      if (!this.loserFeeds.has(f.id)) out.push({ id: w === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id, round: f.round_no ?? 0 });
      if (!this.feeds.has(f.id)) champion = w;
    }
    out.sort((a, b) => b.round - a.round || this.seedOf(a.id) - this.seedOf(b.id));
    return [...(champion === null ? [] : [champion]), ...out.map((x) => x.id)];
  }

  override completeStage(stageId: string = this.stages[0]?.id ?? ""): Promise<CompleteOut> {
    return settle(() => {
      const path = `/api/v1/stages/${stageId}/complete`;
      const stage = this.#stage("POST", stageId);
      // HttpDriver's guard (FP-4): a repeat never reaches the product.
      if (this.completedStages.has(stageId)) throw new DriverMisuse(`driver: stage ${stageId} already completed — /complete is never repeated (design §6.4)`);
      this.log("completeStage", stageId);
      const mine = this.fixtures.filter((f) => f.stage_id === stageId);
      if (mine.length === 0 || mine.some((f) => PENDING.has(f.status))) return { completed: false, events: [] };
      this.completedStages.add(stageId);
      this.commits.push(stageId);
      stage.status = "complete";
      const events = BRACKETS.has(stage.kind) ? [{ type: "stage_completed", finalRanks: this.#finalRanks(stage) }] : [];
      const next = this.stages.find((s) => s.seq === stage.seq + 1);
      if (next === undefined) return { completed: true, events, division_completed: this.stages.every((s) => this.completedStages.has(s.id)) };
      if (this.opts.failSeedingOnComplete === stage.seq) {
        throw new RefusedCall("POST", path, 409, "STAGE_COMPLETED_SEEDING_FAILED", "fake: the next stage's seeding failed (failSeedingOnComplete)", null, { stageId, nextStageId: next.id });
      }
      let p: Proposal;
      try {
        p = this.#compute(next, "POST", path);
      } catch (e) {
        if (!(e instanceof RefusedCall)) throw e;
        // :4239-4252 — the completion has committed; the failed compute is wrapped.
        throw new RefusedCall("POST", path, 409, "STAGE_COMPLETED_SEEDING_FAILED", e.message, null, { stageId, nextStageId: next.id });
      }
      return { completed: true, events, seed_proposal: { id: p.id, status: p.status } };
    });
  }

  override recomputeSeedProposal(stageId: string): Promise<SeedProposalOut> {
    return settle(() => {
      this.log("recomputeSeedProposal", stageId);
      const target = this.#stage("POST", stageId);
      const p = this.#compute(target, "POST", `/api/v1/stages/${stageId}/seed-proposal`);
      this.#lastRecomputedTies = p.ties;
      return { id: p.id, status: p.status, qualifiers: p.offered.map((q) => ({ rank: q.seed, entrantId: q.entrantId, destinationSlot: this.#slotOf(target, q.seed) })), ties: p.ties };
    });
  }

  override confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut> {
    return settle(() => {
      this.log("confirmSeedProposal", stageId, body.proposalId);
      const path = `/api/v1/stages/${stageId}/seed-proposal/confirm`;
      const target = this.#stage("POST", stageId);
      if (this.opts.refuseConfirm !== undefined) throw new RefusedCall("POST", path, 422, this.opts.refuseConfirm, "fake: confirm refused (refuseConfirm)");
      const p = this.proposals.find((x) => x.id === body.proposalId && x.seq === target.seq);
      if (p === undefined) throw new RefusedCall("POST", path, 404, wireCodeFor(404), "seed proposal not found");
      if (p.status === "confirmed") throw new RefusedCall("POST", path, 409, "SEEDING_ALREADY_CONFIRMED", "this stage's slots are already filled from a confirmed proposal");
      if (p.status === "stale") throw new RefusedCall("POST", path, 409, "SEEDING_PROPOSAL_STALE", "standings changed since this proposal was computed — recompute it first");
      const picked = new Set((body.tiePicks ?? []).map((t) => [...t.slots].sort().join(",")));
      for (const tie of p.ties) {
        if (!picked.has([...tie.slots].sort().join(","))) {
          throw new RefusedCall("POST", path, 422, "SEEDING_TIE_UNRESOLVED", "a flagged tie is not resolved — supply an edit or a tiePick for every tied slot", null, { slots: [...tie.slots], entrantIds: [...tie.entrantIds] });
        }
      }
      const bySeed = new Map(p.offered.map((q) => [q.seed, q.entrantId]));
      for (const pick of body.tiePicks ?? []) {
        pick.slots.forEach((slot, i) => {
          const seed = this.#seedOfSlot(slot);
          const e = pick.order[i];
          if (seed !== null && e !== undefined) bySeed.set(seed, e);
        });
      }
      const gone = [...bySeed.values()].filter((e) => this.#departed().has(e));
      if (gone.length > 0 && this.opts.seedWithdrawn !== true) throw new RefusedCall("POST", path, 422, "SEEDING_ENTRANT_WITHDRAWN", "a qualifier has withdrawn from this division — recompute the proposal", null, { entrantIds: gone });
      if (bySeed.size === 0) throw new RefusedCall("POST", path, 422, "SEEDING_NOTHING_TO_FILL", "nobody is left to seed into this stage — recompute the proposal once the field is settled");
      if (this.opts.dropLastSeat === true) bySeed.delete(Math.max(...bySeed.keys()));
      const rows = this.fixtures.filter((f) => f.stage_id === target.id);
      const vacated = rows.some((f) => SIDES.some((side) => { const seed = this.slotsOf.get(f.id)?.[side]; return seed !== undefined && !bySeed.has(seed); }));
      if (vacated && TABLE.has(target.kind)) throw new Error(`fake: a vacated seat in a ${target.kind} target is not modelled`);
      let filled = 0;
      for (const f of rows) {
        for (const side of SIDES) {
          const seed = this.slotsOf.get(f.id)?.[side];
          if (seed === undefined) continue;
          const e = bySeed.get(seed);
          if (e === undefined) { this.#markVacant(f.id, side); continue; }
          if (f[KEY[side]] !== null) throw new RefusedCall("POST", path, 409, "SEEDING_FIXTURES_ALREADY_FILLED", `slot ${f.id}:${side} is already filled`);
          f[KEY[side]] = e;
          filled++;
        }
      }
      this.#resolveSeats(target);
      p.status = "confirmed";
      target.status = "active";
      this.#lastPicks = body.tiePicks ?? null;
      this.confirmedProposalIds.push(p.id);
      const seatedNow: string[] = [];
      for (const f of this.fixtures.filter((x) => x.stage_id === target.id)) for (const e of [f.home_entrant_id, f.away_entrant_id]) if (e !== null && !seatedNow.includes(e)) seatedNow.push(e);
      this.seated.set(target.seq, seatedNow);
      return { proposalId: p.id, filled, fixtures: this.rowsOf(target.id) };
    });
  }

  override async withdraw(entrantId: string): Promise<WithdrawOut> {
    this.log("withdraw", entrantId);
    const path = `/api/v1/entrants/${entrantId}/withdraw`;
    const e = this.entrants.find((x) => x.id === entrantId);
    if (e === undefined) throw new RefusedCall("POST", path, 404, wireCodeFor(404), "entrant not found");
    // withdrawal.ts:133-135: a codeless HttpError(409) — CONFLICT on the wire.
    if (e.status === "withdrawn") throw new RefusedCall("POST", path, 409, wireCodeFor(409), "entrant is already withdrawn");
    let policy: WithdrawOut["policy"] = "none";
    let walkovers = 0;
    let voided = 0;
    let skipped = 0;
    const plan: { f: FakeFixture; walkover: boolean }[] = [];
    for (const stage of this.stages) {
      const mine = this.fixtures.filter((f) => f.stage_id === stage.id && (f.home_entrant_id === entrantId || f.away_entrant_id === entrantId));
      if (mine.length === 0) continue;
      if (TABLE.has(stage.kind)) {
        // stage.ts withdrawTableEntrant: under half played expunges.
        const played = mine.filter((f) => PLAYED.has(f.status) && f.outcome !== null);
        const pending = mine.filter((f) => PENDING.has(f.status));
        const total = played.length + pending.length;
        const expunge = (total === 0 ? 0 : played.length / total) < 0.5;
        policy = expunge ? "expunge" : policy === "expunge" ? "expunge" : "walkover";
        for (const f of expunge ? [...played, ...pending] : pending) plan.push({ f, walkover: !expunge });
      } else if (BRACKET_WALKOVER.has(stage.kind)) {
        if (policy === "none") policy = "walkover";
        for (const f of mine.filter((x) => PENDING.has(x.status))) plan.push({ f, walkover: true });
      } else {
        const pending = mine.filter((x) => PENDING.has(x.status));
        for (const f of pending) plan.push({ f, walkover: false });
        if (policy === "none" && plan.length > 0) policy = "walkover";
      }
    }
    for (const { f, walkover } of plan) {
      if (f.status === "finalized" || f.status === "cancelled") { skipped++; continue; }
      const opponent = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
      if (walkover && opponent !== null) { await this.walkoverFixture(f, entrantId); walkovers++; continue; }
      await this.abandonFixture(f);
      voided++;
    }
    e.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy, walkovers, voided, skipped_finalized: skipped };
  }
}

// --- W1-driving Task 7: a single LADDER stage (D8, D14) ---------------------------------------------
//
// The shape it mirrors (usecases/stages.ts, pinned at 88b233484):
//  - Start and generate create NOTHING: a ladder's generator is `gen = []`
//    (stages.ts:2397-2398). Its fixtures come from challenges only.
//  - issueChallenge (:5503-5657), in its order: 404 an unknown stage; 422
//    (codeless) a non-ladder stage; on first use `ladder_order` is written
//    from the field (status registered/confirmed) by seed (:5538-5551) and is
//    NEVER pruned afterwards; LADDER_ENTRANT_FOREIGN when either side is off
//    the raw order; LADDER_ENTRANT_WITHDRAWN when either is departed
//    (departedEntrantIds, :4750); LADDER_CHALLENGE_NOT_UPWARD on RAW indices;
//    LADDER_CHALLENGE_OUT_OF_RANGE when the LIVE distance exceeds
//    config.challengeRange ?? DEFAULT (:5601-5640, extra `{range}`). Then ONE
//    scheduled fixture, challenger home, round_no = count + 1, ext_key
//    `ch-<n>`; the answer is `{fixture_id, ladder_order}` as it stood at issue.
//    No guard stops an entrant holding two open challenges.
//  - A decided WIN whose winner sits below its loser in the raw order swaps
//    the two (scoring.ts:774-786). An award (forfeit) has no loser
//    (fed-seats.ts advancingSides), so it moves nobody; nor does a draw.
//  - Complete (engine-db/competition.ts:590-618): not complete with no
//    fixture or any scheduled/in_play one; else finalRanks = the RAW order.
//  - Withdraw (withdrawal.ts:213-217, the open-format branch): every pending
//    fixture of the entrant is voided → abandoned and counted in `voided`;
//    nothing is forfeited; the policy is `walkover` only when something was
//    pending, else `none`. A repeat is a codeless 409 (:133-135).

/** The product's ladder rules, read from its text once (product-text.ts). */
const LADDER = ladderText();
const DEPARTED = new Set(departedStatusesText());
const FIELD = new Set(LADDER.fieldStatuses);
/** The four refusal codes, by name — each asserted to be one the product throws. */
const LADDER_CODE = ((): Readonly<Record<"foreign" | "withdrawn" | "notUpward" | "outOfRange", string>> => {
  const named = { foreign: "LADDER_ENTRANT_FOREIGN", withdrawn: "LADDER_ENTRANT_WITHDRAWN", notUpward: "LADDER_CHALLENGE_NOT_UPWARD", outOfRange: "LADDER_CHALLENGE_OUT_OF_RANGE" } as const;
  for (const c of Object.values(named)) if (!LADDER.codes.includes(c)) throw new Error(`fake: ${c} is not a code stages.ts issueChallenge throws (${LADDER.codes.join(", ")})`);
  return named;
})();

export interface FakeLadderOptions {
  /** The reach the fake ENFORCES, in place of the stage config's (stages.ts
   *  reads config.challengeRange ?? DEFAULT_LADDER_CHALLENGE_RANGE). A test
   *  seam: 1 makes every non-adjacent challenge refuse. */
  readonly challengeRange?: number;
  /** Refuse EVERY challenge with this code: a product that lets nothing be played. */
  readonly refuseAll?: string;
  /** Seed 3's FIRST challenge takes the harness's events but its result never
   *  lands (in_play, no outcome): a challenge still under way when seed 3
   *  withdraws (D14's differing case). */
  readonly withdrawWhilePending?: boolean;
  /** Every challenge answer carries the SEED order, however the ladder has
   *  moved — staler than the product's own (issue-time) answer — so only a
   *  re-list of the stage sees the live order. */
  readonly staleLadderOrderInAnswer?: boolean;
}

/** One challenge the fake ISSUED, with the product's rule judged on the
 *  fake's own order at issue time (never playLadder's). */
export interface IssuedChallenge {
  readonly step: number;
  readonly fixtureId: string;
  readonly challenger: string;
  readonly opponent: string;
  /** Adjacent on the LIVE order (raw minus departed) when issued. */
  readonly liveAdjacentAtIssue: boolean;
  /** Below its opponent on the RAW order when issued. */
  readonly upward: boolean;
  /** Either side departed when issued. */
  readonly seatedDeparted: boolean;
}
/** A challenge whose fixture finished with a result: `winner` null for a draw. */
export interface DecidedChallenge extends IssuedChallenge { readonly kind: string; readonly winner: string | null }

interface LadderWithdrawal { readonly entrantId: string; readonly afterStep: number; readonly rawOrder: readonly string[] }

export class FakeLadderDriver extends FakeLeagueDriver {
  readonly opts: FakeLadderOptions;
  /** stage.config.ladder_order: RAW, written on the first challenge, never pruned. */
  #raw: string[] | null = null;
  readonly #issued: IssuedChallenge[] = [];
  readonly #refused: { challenger: string; opponent: string; code: string | null }[] = [];
  readonly #swapped = new Set<string>();
  readonly #withdrawals: LadderWithdrawal[] = [];
  /** withdrawWhilePending: the challenge whose result is withheld. */
  #held: string | null = null;
  constructor(opts: FakeLadderOptions = {}, orgId = "org-fake") {
    super(orgId);
    this.opts = opts;
  }
  override acceptsStage(kind: string): boolean { return kind === "ladder"; }
  override refuseStages(): never { throw new Error("fake: ladder only"); }
  /** stages.ts:2397-2398: a ladder's start draws nothing. */
  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      this.stage!.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: 0 };
    });
  }
  /** A COPY of the config, ladder_order included once written: a caller's
   *  earlier read never changes under it. */
  override listStages(): Promise<StageRef[]> {
    return settle(() => {
      this.log("listStages");
      if (this.stage === null) return [];
      return [{ ...this.stage, config: { ...this.stage.config, ...(this.#raw !== null ? { ladder_order: [...this.#raw] } : {}) } }];
    });
  }
  /** Entrant ids by seed (the order the product's first challenge writes). */
  entrantsBySeed(): string[] {
    return [...this.entrants].sort((a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1)).map((e) => e.id);
  }
  /** The RAW ladder_order, as the product stores it ([] before any challenge). */
  ladderOrder(): string[] { return [...(this.#raw ?? [])]; }
  refusedChallenges(): { challenger: string; opponent: string; code: string | null }[] { return this.#refused.map((r) => ({ ...r })); }
  issuedChallenges(): IssuedChallenge[] { return this.#issued.map((c) => ({ ...c })); }
  /** Issued challenges whose fixture finished WITH a result, in issue order. */
  decidedChallenges(): DecidedChallenge[] {
    return this.#issued.flatMap((c) => {
      const f = this.fixtures.find((x) => x.id === c.fixtureId)!;
      const o = f.outcome as { kind?: string; winner?: string } | null;
      if (o === null || typeof o.kind !== "string" || f.status === "abandoned") return [];
      return [{ ...c, kind: o.kind, winner: typeof o.winner === "string" ? o.winner : null }];
    });
  }
  withdrawnIds(): Set<string> { return new Set(this.entrants.filter((e) => DEPARTED.has(e.status)).map((e) => e.id)); }
  /** Challenges issued when the FIRST withdrawal answered; null if none. */
  withdrawnAfterStep(): number | null { return this.#withdrawals[0]?.afterStep ?? null; }
  /** The same, as a bound: Infinity when nobody withdrew. */
  firstWithdrawalStep(): number { return this.#withdrawals[0]?.afterStep ?? Number.POSITIVE_INFINITY; }
  /** The raw order the moment the FIRST withdrawal answered ([] if none). */
  rawOrderAtWithdrawal(): string[] { return [...(this.#withdrawals[0]?.rawOrder ?? [])]; }
  #range(): number {
    if (this.opts.challengeRange !== undefined) return this.opts.challengeRange;
    const r = this.stage?.config.challengeRange;
    return typeof r === "number" ? r : LADDER.defaultRange;
  }
  override challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut> {
    return settle(() => {
      this.log("challenge", stageId, challengerId, opponentId);
      const path = `/api/v1/stages/${stageId}/challenges`;
      const refuse = (status: number, code: string | null, message: string, extra: Readonly<Record<string, unknown>> | null = null): never => {
        this.#refused.push({ challenger: challengerId, opponent: opponentId, code });
        throw new RefusedCall("POST", path, status, code, message, null, extra);
      };
      if (this.stage === null || this.stage.id !== stageId) return refuse(404, wireCodeFor(404), "stage not found");
      if (this.opts.refuseAll !== undefined) return refuse(422, this.opts.refuseAll, "fake: every challenge refused");
      // Written on first use INSIDE the product's transaction: a refusal rolls it back, so only an issued challenge keeps it.
      const raw = this.#raw !== null && this.#raw.length > 0 ? this.#raw : this.entrantsBySeed().filter((id) => FIELD.has(this.entrants.find((e) => e.id === id)!.status));
      const departed = this.withdrawnIds();
      const ci = raw.indexOf(challengerId);
      const oi = raw.indexOf(opponentId);
      if (ci < 0 || oi < 0) return refuse(422, LADDER_CODE.foreign, "both players must be on the ladder");
      const seatedDeparted = departed.has(challengerId) || departed.has(opponentId);
      if (seatedDeparted) return refuse(422, LADDER_CODE.withdrawn, "a player who has withdrawn from this division can neither issue nor receive a challenge");
      if (oi >= ci) return refuse(422, LADDER_CODE.notUpward, "you can only challenge upward");
      const live = raw.filter((id) => !departed.has(id));
      const range = this.#range();
      const distance = live.indexOf(challengerId) - live.indexOf(opponentId);
      if (distance > range) return refuse(422, LADDER_CODE.outOfRange, `challenges reach at most ${range} places up the ladder, counting only players still in the field`, { range });
      this.#raw = raw;
      const n = this.fixtures.length;
      const f = this.seat(n + 1, challengerId, opponentId, { ext_key: `ch-${n + 1}` });
      this.#issued.push({ step: this.#issued.length + 1, fixtureId: f.id, challenger: challengerId, opponent: opponentId, liveAdjacentAtIssue: distance === 1, upward: oi < ci, seatedDeparted });
      return { fixture_id: f.id, ladder_order: this.opts.staleLadderOrderInAnswer === true ? this.entrantsBySeed() : [...raw] };
    });
  }
  /** withdrawWhilePending: seed 3's FIRST challenge, still open. */
  #withholds(f: FakeFixture): boolean {
    if (this.opts.withdrawWhilePending !== true || PLAYED.has(f.status) || f.status === "abandoned") return false;
    if (this.#held !== null) return this.#held === f.id;
    const seed3 = this.entrants.find((e) => e.seed === 3)?.id;
    if (seed3 === undefined || (f.home_entrant_id !== seed3 && f.away_entrant_id !== seed3)) return false;
    this.#held = f.id;
    return true;
  }
  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const f = this.fixtures.find((x) => x.id === id);
    if (f !== undefined && this.#withholds(f)) {
      this.log("postStream", id);
      const base = f.events.length;
      f.events = [...f.events, ...events];
      f.status = "in_play";
      f.outcome = null;
      return events.map((_, k) => ({ seq: base + k + 1, status: "in_play", outcome: null, event_id: `${id}-${base + k + 1}` }));
    }
    const out = await super.postStream(id, events, prefix);
    this.#swapOnWin(id);
    return out;
  }
  /** scoring.ts:774-786: once per decided challenge, a WIN whose winner sits
   *  below its loser on the raw order swaps them. */
  #swapOnWin(id: string): void {
    const f = this.fixtures.find((x) => x.id === id);
    const o = f?.outcome as { kind?: string; winner?: string; loser?: string } | null | undefined;
    if (f === undefined || this.#raw === null || this.#swapped.has(id) || o?.kind !== "win" || o.winner === undefined || o.loser === undefined) return;
    this.#swapped.add(id);
    const wi = this.#raw.indexOf(o.winner);
    const li = this.#raw.indexOf(o.loser);
    if (wi >= 0 && li >= 0 && wi > li) [this.#raw[wi], this.#raw[li]] = [this.#raw[li], this.#raw[wi]];
  }
  override async withdraw(entrantId: string): Promise<WithdrawOut> {
    this.log("withdraw", entrantId);
    const path = `/api/v1/entrants/${entrantId}/withdraw`;
    const e = this.entrants.find((x) => x.id === entrantId);
    if (e === undefined) throw new RefusedCall("POST", path, 404, wireCodeFor(404), "entrant not found");
    if (e.status === "withdrawn") throw new RefusedCall("POST", path, 409, wireCodeFor(409), "entrant is already withdrawn");
    let voided = 0;
    for (const f of this.fixtures.filter((x) => (x.home_entrant_id === entrantId || x.away_entrant_id === entrantId) && PENDING.has(x.status))) {
      await this.abandonFixture(f);
      voided++;
    }
    e.status = "withdrawn";
    this.#withdrawals.push({ entrantId, afterStep: this.#issued.length, rawOrder: [...(this.#raw ?? [])] });
    return { entrant_id: entrantId, status: "withdrawn", policy: voided > 0 ? "walkover" : "none", walkovers: 0, voided, skipped_finalized: 0 };
  }
  override completeStage(): Promise<CompleteOut> {
    return settle(() => {
      this.log("completeStage");
      if (this.fixtures.length === 0 || this.fixtures.some((f) => PENDING.has(f.status))) return { completed: false, events: [] };
      this.completed = true;
      return { completed: true, events: [{ type: "stage_completed", finalRanks: [...(this.#raw ?? [])] }] };
    });
  }
}

// ---------------------------------------------------------------------------
// FakeAmericanoDriver (W1-driving Task 8, D9): ONE americano stage, shaped like
// the product's (usecases/stages.ts americanoGen :734-811 and pairEntrantsFor
// :681-732, pinned at ebf7ec040; Task 8 Step 0 in task-8-report.md):
//  - The stage is `{ kind: "americano", config: { mode, courtCount, rounds } }`.
//    Mexicano is the SAME kind with config.mode "mexicano"
//    (format-templates.ts:261); the product reads anything else as americano
//    (:756). The fake stores the posted body, so it serves exactly that shape.
//  - players: one person per ACTIVE entrant, in the active read's order —
//    status registered/confirmed, NO kind filter, `order by seed nulls last,
//    created_at, id` (:2290-2293). Each entrant's person is its LAST member
//    row (:744-747: a Map over every row, no ORDER BY). An individual has one
//    row, a team its whole roster (one arbitrary member, false premise 10),
//    and from mexicano round 2 a pair entrant round 1 minted has two (false
//    premise 17). The fake returns rows in storage order — a roster in squad
//    order, a pair's two persons sorted ascending as :722-728 inserts them —
//    so a pair reads as its HIGHER person id. Fewer than 4 players is 422
//    STAGE_NOT_READY.
//  - americano: the first generate (Start's, schedule.ts:3888) plans every
//    round (generateAmericano). A later one plans again over the players of
//    that moment and inserts only the fixtures whose ext_key is new (:2436).
//  - mexicano: each generate plans ONE round (pairMexicanoRound, points then
//    person id, americano.ts:93-95) — unless any fixture of the stage is not
//    WAIT_UNLESS (:769: a forfeited walkover and a void both block, false
//    premise 14), or `rounds` rounds exist (:770). A person's points: the
//    folded state's score.home/away of each DECIDED fixture, credited to every
//    member of that side (:774-783; null → 0, and only generic's fold carries
//    a score).
//  - Each planned team of two persons is the pair entrant holding exactly
//    them (:694-703), else a new one minted `pe<n>` (kind pair, status
//    registered, seed null). A team that is ONE person twice — a self-pair,
//    which false premise 17 makes reachable — writes two member rows with the
//    same key: the entrant_members primary key (V213:9) refuses the insert and
//    the whole generate is a 500 INTERNAL with nothing written.
//  - Complete (engine-db/competition.ts:39, :399, :575-583): a table stage
//    folded as a league — not complete with no fixture or any open one; else
//    finalRanks = the stage's SIDES (the pair entrants, :360-365) by points.
//  - Withdraw (withdrawal.ts open-format branch): only the entrant's OWN
//    fixtures are voided; an individual seats none here, so the policy is
//    "none" and the pair entrants holding their person play on.
//  - The entrant list carries every entrant, the minted pairs included
//    (entrants.ts listEntrants has no kind filter), each with its `kind`.

/** stages.ts:769 — the mexicano wait: a fixture in any other status blocks the next round. */
export const WAIT_UNLESS = "decided";
/** stages.ts:2290-2293 — the active read has no kind filter, so from mexicano
 *  round 2 the pair entrants an earlier round minted are players too (false
 *  premise 17). The fake's default IS that shape; `individualsOnly` models
 *  the corrected product, and the default is derived from this constant. */
export const FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT = true;
/** stages.ts:2292 — the statuses the active read keeps. */
const AMERICANO_ACTIVE = new Set(["registered", "confirmed"]);

export interface FakeAmericanoOptions {
  /** The mode the test means the harness to post; a body of the other mode is a test bug, thrown. */
  readonly mode: "americano" | "mexicano";
  /** From round 2 the active set holds the division's own entrants only (the
   *  corrected product: no pair entrant counted as a player). */
  readonly individualsOnly?: boolean;
  /** Mexicano: once this many rounds exist, a generate creates nothing even
   *  with every fixture decided — a product that stops early. */
  readonly stallAfter?: number;
  /** A product that DID drop a withdrawn player from what follows: americano
   *  deletes every pending fixture seating a pair entrant that holds their
   *  person; mexicano's later plans leave out the withdrawn individual AND
   *  every pair entrant holding their person. */
  readonly dropWithdrawnFromPlan?: boolean;
  /** americanoView answers this mode whatever the stage's config says — a
   *  product whose read model disagrees with its own generator. */
  readonly viewMode?: "americano" | "mexicano";
  /** Person ids sort in SEED order (e1's person first). The default is the
   *  reverse (m-e, adversarial). The product's ids are UUIDs, so which order
   *  holds live is chance — and with it whether a withdrawn player's person
   *  is the row a round-1 pair is read as (stages.ts:744-747): a test that
   *  needs one outcome names the order that gives it. */
  readonly seedOrderedPersons?: boolean;
}

/** One minted pair entrant: its persons sorted, as stored. */
interface PairEntrant { readonly id: string; readonly members: readonly [string, string] }

export class FakeAmericanoDriver extends FakeLeagueDriver {
  readonly opts: FakeAmericanoOptions;
  readonly individualsOnly: boolean;
  readonly #pairs: PairEntrant[] = [];
  /** Round numbers in the order a generate (Start's included) created them. */
  readonly #generated: number[] = [];
  /** Round numbers in the order their last open fixture finished. */
  readonly #decidedOrder: number[] = [];
  /** round → the self-pairs its plan held (a refused plan included). */
  readonly #selfPairs = new Map<number, number>();
  /** Every generate's answer: created, or the refusal's status. */
  readonly generates: { created: number | null; status: number }[] = [];
  constructor(opts: FakeAmericanoOptions, orgId = "org-fake") {
    super(orgId);
    this.opts = opts;
    this.individualsOnly = opts.individualsOnly ?? !FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT;
  }
  override acceptsStage(kind: string): boolean { return kind === "americano"; }
  override refuseStages(): never { throw new Error("fake: americano only"); }
  override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    return super.postStages(d, stages).then((out) => {
      if (this.mode !== this.opts.mode) throw new Error(`fake: built for ${this.opts.mode}, posted a ${this.mode} stage`);
      return out;
    });
  }
  /** The product's reading of the stage's mode (stages.ts:756). */
  get mode(): "americano" | "mexicano" { return this.stage?.config.mode === "mexicano" ? "mexicano" : "americano"; }
  /** m-e (adversarial): by default person ids sort in REVERSE seed order —
   *  entrant e1's person sorts last — so nothing can pass by reading a
   *  person's place from its id or a seed from a person. */
  override rosterOf(entrantId: string, ms: readonly MemberInput[]): EntrantMember[] {
    const i = Number(entrantId.slice(1));
    const rank = String(this.opts.seedOrderedPersons === true ? i : 100 - i).padStart(2, "0");
    return inSquadOrder(ms.map((m, k) => ({ person_id: `p${rank}-${k + 1}`, squad_number: m.squadNumber, is_captain: m.isCaptain })));
  }
  #pair(id: string): PairEntrant | undefined { return this.#pairs.find((p) => p.id === id); }
  /** An entrant's member rows in storage order (the order the product's read returns them here). */
  #rows(entrantId: string): string[] {
    const pair = this.#pair(entrantId);
    if (pair !== undefined) return [...pair.members];
    return (this.members.get(entrantId) ?? []).map((m) => m.person_id);
  }
  override entrantMembers(entrantId: string): Promise<EntrantMember[]> {
    return settle(() => {
      this.log("entrantMembers", entrantId);
      const pair = this.#pair(entrantId);
      if (pair !== undefined) return pair.members.map((person_id) => ({ person_id, squad_number: null, is_captain: false }));
      if (!this.entrants.some((e) => e.id === entrantId)) throw new RefusedCall("GET", `/api/v1/entrants/${entrantId}`, 404, wireCodeFor(404), "entrant not found");
      return (this.members.get(entrantId) ?? []).map((m) => ({ ...m }));
    });
  }
  override listEntrants(): Promise<EntrantRow[]> {
    return settle(() => {
      this.log("listEntrants");
      return [
        ...this.entrants.map((e) => ({ ...e })),
        ...this.#pairs.map((p) => ({ id: p.id, display_name: p.members.join(" / "), seed: null, status: "registered", kind: "pair" })),
      ];
    });
  }
  #withdrawnPersons(): Set<string> {
    return new Set(this.entrants.filter((e) => e.status === "withdrawn").flatMap((e) => this.#rows(e.id)));
  }
  /** stages.ts:2290-2293 then :744-750: the players, one per active entrant. */
  players(): string[] {
    const individuals = this.entrants.filter((e) => AMERICANO_ACTIVE.has(e.status))
      .sort((a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1)).map((e) => e.id);
    const gone = this.#withdrawnPersons();
    const pairs = this.individualsOnly ? [] : this.#pairs
      .filter((p) => this.opts.dropWithdrawnFromPlan !== true || !p.members.some((m) => gone.has(m)))
      .map((p) => p.id);
    return [...individuals, ...pairs].flatMap((id) => {
      const rows = this.#rows(id);
      return rows.length === 0 ? [] : [rows[rows.length - 1]];
    });
  }
  #cfgNumber(key: "courtCount" | "rounds", fallback: number): number {
    const v = this.stage!.config[key];
    return typeof v === "number" ? v : fallback;
  }
  /** stages.ts:774-783: a person's points over the stage's DECIDED fixtures —
   *  each member row of a side takes that side's score (the home score when
   *  the row's entrant is the home side), a missing score counting nothing. */
  personalPoints(): Map<string, number> {
    const pts = new Map<string, number>();
    for (const f of this.fixtures.filter((x) => x.status === "decided" && x.home_entrant_id !== null && x.away_entrant_id !== null)) {
      const home = f.home_entrant_id!;
      const away = f.away_entrant_id!;
      const score = (foldStream(sportModule(this.sport), this.cfg, home, away, f.events).state as { score?: { home?: unknown; away?: unknown } | null }).score ?? null;
      const of = (v: unknown): number => (typeof v === "number" ? v : 0);
      const credit = (side: string, n: number) => { for (const p of this.#rows(side)) pts.set(p, (pts.get(p) ?? 0) + n); };
      credit(home, of(score?.home));
      if (away !== home) credit(away, of(score?.away));
    }
    return pts;
  }
  /** One plan, written whole or refused whole (the generate's transaction). */
  #write(path: string, initial: boolean): number {
    const players = this.players();
    if (players.length < 4) throw new RefusedCall("POST", path, engineHttpStatus("STAGE_NOT_READY"), "STAGE_NOT_READY", "americano needs at least 4 individual players with linked persons");
    const courtCount = this.#cfgNumber("courtCount", Math.max(1, Math.floor(players.length / 4)));
    const rounds = this.#cfgNumber("rounds", Math.max(3, players.length - 1));
    let planned: AmericanoRound[];
    if (this.mode === "americano") {
      planned = generateAmericano(players, { mode: "americano", courtCount, rounds });
    } else {
      const played = this.fixtures.length > 0 ? Math.max(...this.fixtures.map((f) => f.round_no ?? 0)) : 0;
      if (this.fixtures.some((f) => f.status !== WAIT_UNLESS)) return 0;
      if (played >= rounds) return 0;
      if (!initial && this.opts.stallAfter !== undefined && played >= this.opts.stallAfter) return 0;
      const pts = this.personalPoints();
      planned = [pairMexicanoRound(players.map((p) => ({ playerId: p, points: pts.get(p) ?? 0 })), { courtCount }, played + 1)];
    }
    let selfPairs = 0;
    for (const r of planned) {
      const n = r.matches.flatMap((m) => [m.team1, m.team2]).filter(([a, b]) => a === b).length;
      if (n > 0) this.#selfPairs.set(r.roundNo, (this.#selfPairs.get(r.roundNo) ?? 0) + n);
      selfPairs += n;
    }
    // V213:9: two member rows for one entrant with the same person — the insert fails, the transaction with it.
    if (selfPairs > 0) throw new RefusedCall("POST", path, 500, wireCodeFor(500), 'duplicate key value violates unique constraint "entrant_members_pkey"');
    const idFor = (team: readonly [string, string]): string => {
      const sorted = [...team].sort() as [string, string];
      const found = this.#pairs.find((p) => p.members[0] === sorted[0] && p.members[1] === sorted[1]);
      if (found !== undefined) return found.id;
      const minted: PairEntrant = { id: `pe${this.#pairs.length + 1}`, members: sorted };
      this.#pairs.push(minted);
      return minted.id;
    };
    const keys = new Set(this.fixtures.map((f) => f.ext_key));
    let created = 0;
    for (const r of planned) {
      let fresh = 0;
      for (const m of r.matches) {
        if (keys.has(m.id)) continue;
        this.seat(m.roundNo, idFor(m.team1), idFor(m.team2), { ext_key: m.id });
        fresh++;
      }
      if (fresh > 0) this.#generated.push(r.roundNo);
      created += fresh;
    }
    return created;
  }
  override start(): Promise<StartOut> {
    return settle(() => {
      this.log("start");
      const created = this.#write("/api/v1/divisions/d1/start", true);
      this.stage!.status = "active";
      return { division_id: "d1", status: "active", started: true, generated: created };
    });
  }
  override generate(stageId = "s1"): Promise<GenerateOut> {
    return settle(() => {
      this.log("generate", stageId);
      const existing = this.fixtures.length;
      let created: number;
      try {
        created = this.#write(`/api/v1/stages/${stageId}/generate`, false);
      } catch (e) {
        if (e instanceof RefusedCall) this.generates.push({ created: null, status: e.status });
        throw e;
      }
      this.generates.push({ created, status: 200 });
      return { created, existing, fixtures: this.rows() };
    });
  }
  override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    const out = await super.postStream(id, events, prefix);
    this.#noteDecided(id);
    return out;
  }
  /** Records a round the moment its last open fixture finishes. */
  #noteDecided(id: string): void {
    const round = this.fixtures.find((f) => f.id === id)?.round_no ?? null;
    if (round === null || this.#decidedOrder.includes(round)) return;
    const inRound = this.fixtures.filter((f) => f.round_no === round);
    if (inRound.every((f) => isTerminal(f.status))) this.#decidedOrder.push(round);
  }
  override async withdraw(entrantId: string): Promise<WithdrawOut> {
    this.log("withdraw", entrantId);
    const path = `/api/v1/entrants/${entrantId}/withdraw`;
    const e = this.entrants.find((x) => x.id === entrantId);
    if (e === undefined) throw new RefusedCall("POST", path, 404, wireCodeFor(404), "entrant not found");
    if (e.status === "withdrawn") throw new RefusedCall("POST", path, 409, wireCodeFor(409), "entrant is already withdrawn");
    let voided = 0;
    for (const f of this.fixtures.filter((x) => (x.home_entrant_id === entrantId || x.away_entrant_id === entrantId) && PENDING.has(x.status))) {
      await this.abandonFixture(f);
      voided++;
    }
    e.status = "withdrawn";
    if (this.opts.dropWithdrawnFromPlan === true && this.mode === "americano") {
      const gone = this.#withdrawnPersons();
      this.fixtures = this.fixtures.filter((f) => !(PENDING.has(f.status) && [f.home_entrant_id, f.away_entrant_id].some((s) => s !== null && this.#rows(s).some((p) => gone.has(p)))));
    }
    return { entrant_id: entrantId, status: "withdrawn", policy: voided > 0 ? "walkover" : "none", walkovers: 0, voided, skipped_finalized: 0 };
  }
  /** The table folds over the stage's SIDES (engine-db/competition.ts:360-365). */
  override tableEntrants(): string[] {
    return [...new Set(this.fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null))];
  }
  #ranked(): string[] {
    const m = sportModule(this.sport);
    const pts = new Map(this.tableEntrants().map((id) => [id, 0]));
    for (const f of this.fixtures) {
      if (f.outcome === null || f.home_entrant_id === null || f.away_entrant_id === null) continue;
      const d = declaredPoints(m, this.cfg, { kind: "americano", ...(f.round_no ? { roundNo: f.round_no } : {}) }, f.home_entrant_id, f.away_entrant_id, f.events);
      if (d === null) continue;
      pts.set(f.home_entrant_id, pts.get(f.home_entrant_id)! + d.home);
      pts.set(f.away_entrant_id, pts.get(f.away_entrant_id)! + d.away);
    }
    return [...pts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  }
  override completeStage(): Promise<CompleteOut> {
    return settle(() => {
      this.log("completeStage");
      if (this.completed) return { completed: true, events: [] };
      if (this.fixtures.length === 0 || this.fixtures.some((f) => !isTerminal(f.status))) return { completed: false, events: [] };
      this.completed = true;
      return { completed: true, events: [{ type: "stage_completed", finalRanks: this.#ranked() }] };
    });
  }
  override americanoView(stageId: string): Promise<AmericanoViewOut> {
    return settle(() => {
      this.log("americanoView", stageId);
      if (this.stage === null || this.stage.id !== stageId) throw new RefusedCall("GET", `/api/v1/stages/${stageId}/americano`, 404, wireCodeFor(404), "stage not found");
      const rounds = [...new Set(this.fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b).map((round_no) => ({
        round_no,
        matches: this.fixtures.filter((f) => (f.round_no ?? 0) === round_no).map((f) => ({ fixture_id: f.id, status: f.status, team1: { entrant_id: f.home_entrant_id ?? "" }, team2: { entrant_id: f.away_entrant_id ?? "" } })),
      }));
      const pts = this.personalPoints();
      return { mode: this.opts.viewMode ?? this.mode, rounds, leaderboard: [...pts].map(([person_id, points]) => ({ person_id, points, games: 0 })) };
    });
  }
  // --- the test oracle: the fake's OWN rows, never the harness's ---
  stageIdAt(seq: number): string {
    if (seq !== 1 || this.stage === null) throw new Error(`fake: one americano stage, no stage ${seq}`);
    return this.stage.id;
  }
  stageAt(seq: number): StageRef {
    if (seq !== 1 || this.stage === null) throw new Error(`fake: one americano stage, no stage ${seq}`);
    return { ...this.stage, config: { ...this.stage.config } };
  }
  /** Rounds in the order each one's last open fixture finished. */
  roundsDecided(): number[] { return [...this.#decidedOrder]; }
  /** Rounds in the order a generate created them (Start's included). */
  roundsGenerated(): number[] { return [...this.#generated]; }
  fixturesOfRound(r: number): FixtureRow[] { return this.rows().filter((f) => f.round_no === r); }
  fixturesAfterRound(r: number): FixtureRow[] { return this.rows().filter((f) => (f.round_no ?? 0) > r); }
  /** The person the entrant holding `seed` plays as (its last member row). */
  personOfSeed(seed: number): string {
    const e = this.entrants.find((x) => x.seed === seed);
    const rows = e === undefined ? [] : this.#rows(e.id);
    if (rows.length === 0) throw new Error(`fake: no person for seed ${seed}`);
    return rows[rows.length - 1];
  }
  /** An entrant's persons: a pair's two, a division entrant's member rows. */
  membersOf(entrantId: string): string[] { return this.#rows(entrantId); }
  pairEntrantIds(): string[] { return this.#pairs.map((p) => p.id); }
  selfPairsIn(round: number): number { return this.#selfPairs.get(round) ?? 0; }
  /** The first person a round ≥ 2 seats twice, with a pair entrant an EARLIER
   *  round seated that holds them (the signature's evidence). */
  firstDuplicate(): { round_no: number; person: string; viaPairEntrant: string } {
    const rounds = [...new Set(this.fixtures.map((f) => f.round_no ?? 0))].filter((r) => r >= 2).sort((a, b) => a - b);
    for (const r of rounds) {
      const seen = new Map<string, number>();
      for (const f of this.fixturesOfRound(r)) for (const side of [f.home_entrant_id, f.away_entrant_id]) {
        if (side !== null) for (const p of this.#rows(side)) seen.set(p, (seen.get(p) ?? 0) + 1);
      }
      for (const [person, n] of seen) {
        if (n < 2) continue;
        const via = this.rows().find((f) => (f.round_no ?? 0) < r && [f.home_entrant_id, f.away_entrant_id].some((s) => s !== null && this.#pair(s) !== undefined && this.#rows(s).includes(person)));
        const pair = via === undefined ? undefined : [via.home_entrant_id, via.away_entrant_id].find((s) => s !== null && this.#pair(s) !== undefined && this.#rows(s).includes(person));
        if (pair !== undefined && pair !== null) return { round_no: r, person, viaPairEntrant: pair };
      }
    }
    throw new Error("fake: no round seats a person twice with an earlier pair entrant to explain it");
  }
}
