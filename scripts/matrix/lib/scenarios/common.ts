// The organiser steps every scenario shares, and the Recorder that turns what
// the harness did and saw into an ObservedRun. Expected values are derived
// (R9): points from the module's standingsDelta over the folded stream, draw
// reachability from supportsDraws.
import type { MatchOutcome, StageCtx, StageKind } from "@seazn/engine/core";
import { stagesForRow, type StagePostBody } from "../catalogue.ts";
import { RefusedCall, type CompetitionRef, type DivisionRef, type EntrantRow, type FixtureRow, type StageRef } from "../driver/types.ts";
import { declaredPoints, foldStream, lineupsFor } from "../fold.ts";
import {
  isTerminal, snap, toObservedOutcome,
  type CaseFact, type CompleteObs, type ConfigEditObs, type GenerateObs, type ObservedDeclared, type ObservedFixture,
  type ObservedOutcome, type ObservedRun, type ObservedStage, type PairRoundObs, type WithdrawalObs,
} from "../observed.ts";
import { drawsAllowed, entrantKindFor, sportModule } from "../sport-cfg.ts";
import { generateStream, matchesRequest, type RequestMatch } from "../streams/index.ts";
import { START, type RequestedOutcome, type StreamEvent } from "../streams/types.ts";
import { ScenarioUnsupported, type ScenarioContext } from "./types.ts";

/** Final review I-2: what the harness POSTED beside what the product says it
 *  built, read back after start rather than taken from the create/add
 *  answers. life-built-as-posted compares the two. */
export interface BuiltReadback {
  posted: { sport: string; variant: string; stages: readonly StagePostBody[]; entrants: readonly { displayName: string; seed: number }[] };
  division: DivisionRef;
  stages: StageRef[];
  entrants: EntrantRow[];
  /** addEntrants' own answer — what the rest of the scenario keys on. */
  echo: EntrantRow[];
}

export interface DivisionSetup {
  competition: CompetitionRef;
  division: DivisionRef;
  stage: StageRef;
  entrants: EntrantRow[];
  built: BuiltReadback;
  seedOf: (id: string) => number;
  idOfSeed: (seed: number) => string;
}

export interface ParityObs {
  fixtureId: string;
  local: ObservedOutcome | null;
  product: ObservedOutcome | null;
  /** The product's event count minus the harness's own, before this post: 0
   *  when the harness knows the whole stream. Non-zero leaves `local` null. */
  foreign: number;
  /** Final review I-1: the status the fixture ALREADY held when the harness
   *  came to decide it — finished by a write the harness never made, on a
   *  fixture that seats no recorded withdrawn entrant. null: it posted. */
  finishedBefore: string | null;
  /** m-4: whether the local fold is the outcome the harness ASKED for
   *  (streams matchesRequest); null when nothing was folded. */
  request: RequestMatch | null;
}

/** Why playStage stopped (I-1). Only "drained" — generate answered and no
 *  seated fixture was left open, or the swiss budget was paired through — is a
 *  loop that ran to its end; life-loop-bounded reds every other exit, and a
 *  drained loop that still leaves a fixture open. */
export type LoopExit = "drained" | "cap" | "refused_generate" | "empty_pair_round";

export class Recorder {
  exit: LoopExit | null = null;
  readonly generates: GenerateObs[] = [];
  readonly pairRounds: PairRoundObs[] = [];
  readonly declared = new Map<string, ObservedDeclared>();
  readonly parity: ParityObs[] = [];
  /** Every event the harness posted, per fixture, in order: the fixture's
   *  whole stream as far as the harness knows it (Task 6 ruling). */
  readonly streams = new Map<string, StreamEvent[]>();
  readonly facts = new Set<CaseFact>();
  /** Entrants a recorded withdrawal took out: their fixtures may be finished
   *  by the product's cascade, not the harness (R4 sets it). */
  readonly withdrawn = new Set<string>();
  readonly notes: string[] = [];
  drawsPosted = 0;
  decided = 0;
  events = 0;
}

/** Ruling 28 (Q-A): driving breadth W1a deferred — ladder /
 *  americano / mexicano, multi-stage seeding, team rosters — is its own wave.
 *  A deferral names a wave that is not done (scenario-catalogue.test.ts). */
export const DRIVING_WAVE = "W1-driving";

const FORMAT_LATER = new Set(["ladder", "americano", "mexicano"]);
/** The non-swiss generate loop's hard cap; hitting it records `cut_short`. */
export const MAX_ITERATIONS = 64;
/** engine-db/competition.ts:79 — the seat a bye's award is scored against. */
const BYE_PHANTOM = "__bye__";

export async function setUpDivision(ctx: ScenarioContext, rec: Recorder, entrantCount: number): Promise<DivisionSetup> {
  // Every deferral fires before the first driver call.
  if (FORMAT_LATER.has(ctx.spec.row)) throw new ScenarioUnsupported(DRIVING_WAVE, `${ctx.spec.row}: challenge/rotation driving lands in ${DRIVING_WAVE}`);
  const bodies = stagesForRow(ctx.spec.row);
  if (bodies.length > 1) throw new ScenarioUnsupported(DRIVING_WAVE, "multi-stage rows need seed-proposal handling");
  const kind = entrantKindFor(ctx.spec.sport, ctx.cfg);
  if (kind === "team") throw new ScenarioUnsupported(DRIVING_WAVE, "team rosters");
  const slug = `m-${ctx.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60).replace(/-+$/, "");
  const competition = await ctx.driver.createCompetition({ name: `Matrix ${ctx.spec.caseId}`, slug });
  const division = await ctx.driver.createDivision(competition.id, { name: `Matrix ${ctx.spec.sport}`, slug: "d", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
  await ctx.driver.postStages(division.id, bodies);
  const inputs = Array.from({ length: entrantCount }, (_, i) => ({ displayName: `Matrix Player ${i + 1}`, seed: i + 1 }));
  const entrants = await ctx.driver.addEntrants(division.id, inputs.map((e) => ({ ...e, kind })));
  await ctx.driver.start(division.id);
  const stages = await ctx.driver.listStages(division.id);
  const stage = stages[0];
  if (stage === undefined) throw new Error(`scenario: division ${division.id} has no stage after start`);
  const built: BuiltReadback = {
    posted: { sport: ctx.spec.sport, variant: ctx.spec.variant, stages: bodies, entrants: inputs },
    division: await ctx.driver.getDivision(division.id),
    stages,
    entrants: await ctx.driver.listEntrants(division.id),
    echo: entrants,
  };
  const seeds = new Map(entrants.map((e) => [e.id, e.seed ?? Number.MAX_SAFE_INTEGER]));
  rec.notes.push(`stage ${stage.kind} status after start: ${stage.status}`);
  return {
    competition, division, stage, entrants, built,
    seedOf: (id) => seeds.get(id) ?? Number.MAX_SAFE_INTEGER,
    idOfSeed: (seed) => {
      const e = entrants.find((x) => x.seed === seed);
      if (e === undefined) throw new Error(`scenario: no entrant holds seed ${seed}`);
      return e.id;
    },
  };
}

export async function recordGenerate(ctx: ScenarioContext, rec: Recorder, stageId: string): Promise<FixtureRow[] | null> {
  try {
    const g = await ctx.driver.generate(stageId);
    rec.generates.push({ status: 200, code: null, total: g.fixtures.length, created: g.created });
    return g.fixtures;
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.generates.push({ status: e.status, code: e.code, total: 0, created: 0 });
    return null;
  }
}

const seatedOpen = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null && !isTerminal(f.status);

export function defaultPolicy(setup: DivisionSetup, f: FixtureRow, drawOk: boolean, ordinal: number): RequestedOutcome {
  if (drawOk && ordinal % 3 === 2) return { kind: "draw" };
  return { kind: "win", winner: setup.seedOf(f.home_entrant_id!) <= setup.seedOf(f.away_entrant_id!) ? "home" : "away" };
}

const stageCtx = (kind: string, f: { pool_id: string | null; round_no: number | null }): StageCtx =>
  ({ kind: kind as StageKind, ...(f.pool_id ? { poolId: f.pool_id } : {}), ...(f.round_no ? { roundNo: f.round_no } : {}) });

export async function decideFixture(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, outcome: RequestedOutcome): Promise<void> {
  const state = await ctx.driver.fixtureState(f.id);
  const home = f.home_entrant_id!;
  const away = f.away_entrant_id!;
  if (isTerminal(state.status)) {
    // Final review I-1: only the harness's own earlier post (M1's forfeit) or
    // a RECORDED withdrawal's cascade may have finished it. Anything else is a
    // result nobody the harness can name wrote — a failing parity item, never
    // a silent return.
    if (rec.streams.has(f.id) || rec.withdrawn.has(home) || rec.withdrawn.has(away)) return;
    rec.parity.push({ fixtureId: f.id, local: null, product: toObservedOutcome(state.outcome), foreign: state.last_seq, finishedBefore: state.status, request: null });
    rec.notes.push(`${f.id}: already ${state.status} before the harness posted`);
    return;
  }
  const generated = generateStream({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: setup.stage.kind as StageKind, home, away, outcome });
  // What the driver actually sends: a forfeit on a fixture already under way
  // is the bare core.forfeit (http-driver.ts forfeit), so START only when the
  // fixture is still scheduled.
  const now = outcome.kind === "forfeit" && state.status !== "scheduled" ? generated.filter((e) => e.type !== START.type) : generated;
  const prior = rec.streams.get(f.id) ?? [];
  const posted = outcome.kind === "forfeit"
    ? await ctx.driver.forfeit(f.id, outcome.by === "home" ? home : away, outcome.reason, `${ctx.tag}:${f.id}`)
    : await ctx.driver.postStream(f.id, now, `${ctx.tag}:${f.id}`);
  const whole = [...prior, ...now];
  rec.streams.set(f.id, whole);
  // Parked Task 6 (b): a post that raced another writer is traced, not silent.
  const retried = posted.filter((p) => p.retried === true).length;
  if (retried > 0) rec.notes.push(`${f.id}: ${retried} event(s) landed on a SEQ_CONFLICT retry`);
  const productOutcome = toObservedOutcome(posted.at(-1)?.outcome ?? null);
  rec.events += now.length;
  rec.decided++;
  if (outcome.kind === "draw") rec.drawsPosted++;
  const foreign = state.last_seq - prior.length;
  if (foreign !== 0) {
    rec.parity.push({ fixtureId: f.id, local: null, product: productOutcome, foreign, finishedBefore: null, request: null });
    rec.notes.push(`${f.id}: product held ${state.last_seq} event(s), the harness had posted ${prior.length}`);
    return;
  }
  const m = sportModule(ctx.spec.sport);
  const folded = foldStream(m, ctx.cfg, home, away, whole).outcome;
  const request = matchesRequest({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: setup.stage.kind as StageKind, home, away, outcome }, folded);
  rec.parity.push({ fixtureId: f.id, local: toObservedOutcome(folded), product: productOutcome, foreign: 0, finishedBefore: null, request });
  const dp = declaredPoints(m, ctx.cfg, stageCtx(setup.stage.kind, f), home, away, whole);
  if (dp !== null) rec.declared.set(f.id, { home: dp.home, away: dp.away, forOutcome: toObservedOutcome(dp.forOutcome)! });
}

export type RoundHook = (round: number, batch: FixtureRow[]) => Promise<void>;

export async function playStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook } = {}): Promise<void> {
  const stage = setup.stage;
  const drawOk = drawsAllowed(ctx.spec.sport, ctx.cfg, stage.kind as StageKind);
  const decideBatch = async (round: number, batch: FixtureRow[]) => {
    await hooks.beforeRound?.(round, batch);
    for (const f of [...batch].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))) {
      await decideFixture(ctx, rec, setup, f, defaultPolicy(setup, f, drawOk, rec.decided));
    }
    await hooks.afterRound?.(round, batch);
  };
  if (stage.kind === "swiss") {
    const rounds = Number(stage.config.rounds);
    for (let r = 1; r <= rounds; r++) {
      const fixtures = await recordGenerate(ctx, rec, stage.id);
      const batch = (fixtures ?? []).filter((f) => f.round_no === r && seatedOpen(f));
      rec.pairRounds.push({ roundNo: r, seated: batch.length });
      if (batch.length === 0) { // I4 fails on the empty pair round
        rec.exit = fixtures === null ? "refused_generate" : "empty_pair_round";
        return;
      }
      await decideBatch(r, batch);
    }
    rec.exit = "drained";
    return;
  }
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const fixtures = await recordGenerate(ctx, rec, stage.id);
    // A named refusal is NOT "nothing left to play" (I-1): it stops the loop
    // with the stage unfinished, and life-loop-bounded says so.
    if (fixtures === null) { rec.exit = "refused_generate"; return; }
    const open = fixtures.filter(seatedOpen);
    if (open.length === 0) { rec.exit = "drained"; return; }
    const round = Math.min(...open.map((f) => f.round_no ?? 0));
    await decideBatch(round, open.filter((f) => (f.round_no ?? 0) === round));
  }
  rec.exit = "cap";
  rec.facts.add("cut_short");
  rec.notes.push(`loop cap ${MAX_ITERATIONS} reached`);
}

function toFixture(f: FixtureRow): Omit<ObservedFixture, "declared"> {
  return { id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome) };
}

export async function configProbe(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<ConfigEditObs> {
  const read = async () => (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === setup.stage.id && isTerminal(f.status)).map((f) => snap({ ...toFixture(f), declared: null }));
  const before = await read();
  // Both saves spread the division's CURRENT config (Task 6 ruling): the lock
  // compares everything but `entrants` against what is stored, so a body
  // missing a stored override would read as a format change.
  const division = await ctx.driver.getDivision(setup.division.id);
  const attempts: ConfigEditObs["attempts"] = [];
  const cfg = ctx.cfg as Record<string, unknown>;
  // A format field this sport declares; divisions.ts:814-857 locks it once fixtures exist.
  const formatDelta = typeof cfg.allowDraws === "boolean" ? { allowDraws: !cfg.allowDraws }
    : typeof cfg.setTo === "number" ? { setTo: cfg.setTo === 15 ? 11 : 15, finalSetTo: cfg.setTo === 15 ? 11 : 15 }
    : null;
  if (formatDelta !== null) attempts.push({ kind: "format", ...(await ctx.driver.patchDivisionConfig(division.id, { ...division.config, ...formatDelta })) });
  // The one save the lock lets through (entrants-only).
  attempts.push({ kind: "entrants_only", ...(await ctx.driver.patchDivisionConfig(division.id, { ...division.config, entrants: { kinds: [entrantKindFor(ctx.spec.sport, ctx.cfg)] } })) });
  rec.notes.push(...attempts.map((a) => `config ${a.kind}: ${a.status} ${a.code ?? ""}`.trim()));
  return { attempts, before, after: await read() };
}

/** A refused complete is recorded for I4 (which accepts a NAMED refusal) and
 *  noted; whether the stage was left unfinished is life-loop-bounded's call. */
export async function finishStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<CompleteObs> {
  try {
    const c = await ctx.driver.completeStage(setup.stage.id);
    const done = c.events.find((e) => e.type === "stage_completed");
    return { status: 200, code: null, completed: c.completed, finalRanks: done?.finalRanks ?? null };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.notes.push(`complete refused ${e.status} ${e.code ?? "(no code)"}`);
    return { status: e.status, code: e.code, completed: false, finalRanks: null };
  }
}

/** A one-sided forfeited AWARD row — the engine's odd-field Swiss bye or a KO
 *  seeded bye (competition/stage.ts:30-34) — is a result the harness never
 *  posted. What the sport declares it worth is standingsDelta for that award,
 *  on the seated side, against the empty seat (the product's awardByeDelta,
 *  engine-db/competition.ts:87-116). Without this, a 5-entrant 5-round Swiss
 *  gives every entrant an undeclared bye and I3 checks nobody (Task 5 carry). */
export function byeDeclared(sport: string, cfg: unknown, stageKind: string, f: ObservedFixture): ObservedDeclared | null {
  if ((f.home === null) === (f.away === null) || f.outcome?.kind !== "award") return null;
  const winner = f.outcome.winner;
  const seatedHome = f.home === winner;
  if (!seatedHome && f.away !== winner) return null;
  const m = sportModule(sport);
  const state: unknown = m.init(cfg, lineupsFor(seatedHome ? winner : BYE_PHANTOM, seatedHome ? BYE_PHANTOM : winner));
  const award = { kind: "award", winner, ...(f.outcome.method !== undefined ? { method: f.outcome.method } : {}) } as MatchOutcome;
  const pair = m.standingsDelta(award, cfg, stageCtx(stageKind, { pool_id: f.poolId, round_no: f.roundNo }), state);
  const won = pair.find((d) => d.entrantId === winner);
  if (won === undefined) return null;
  return { home: seatedHome ? won.points : 0, away: seatedHome ? 0 : won.points, forOutcome: f.outcome };
}

export async function snapshot(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, extra: { complete: CompleteObs; configEdit: ConfigEditObs | null; withdrawal: WithdrawalObs | null }): Promise<ObservedRun> {
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === setup.stage.id);
  const fixtures: ObservedFixture[] = rows.map((f) => {
    const base = { ...toFixture(f), declared: null };
    return { ...base, declared: rec.declared.get(f.id) ?? byeDeclared(ctx.spec.sport, ctx.cfg, setup.stage.kind, base) };
  });
  // One table per pool, each keeping its poolId (a merged table reds I1/I3).
  const poolIds = [...new Set(rows.map((f) => f.pool_id))];
  const standings: ObservedStage["standings"] = [];
  for (const poolId of poolIds.length > 0 ? poolIds : [null]) {
    const s = await ctx.driver.standings(setup.stage.id, poolId);
    standings.push({ poolId, rows: s.rows.map((r) => ({ entrantId: r.entrantId, rank: r.rank, points: typeof r.points === "number" ? r.points : null })) });
  }
  return {
    caseId: ctx.spec.caseId,
    facts: [...rec.facts],
    stages: [{
      id: setup.stage.id, seq: setup.stage.seq, kind: setup.stage.kind, config: setup.stage.config,
      // W1a snapshots the single root stage only (multi-stage is deferred in
      // setUpDivision), so the division's entrants ARE its field. A later
      // stage snapshotted this way reds I1 by name (W1a carry 1).
      field: setup.entrants.map((e) => e.id), fieldSource: "division", fixtures, standings,
      generates: rec.generates, pairRounds: rec.pairRounds, complete: extra.complete,
    }],
    withdrawal: extra.withdrawal,
    configEdit: extra.configEdit,
  };
}
