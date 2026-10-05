// The organiser steps every scenario shares, and the Recorder that turns what
// the harness did and saw into an ObservedRun. Expected values are derived
// (R9): points from the module's standingsDelta over the folded stream, draw
// reachability from supportsDraws.
import { EngineError, type MatchOutcome, type StageCtx, type StageKind } from "@seazn/engine/core";
import { stagesForRow, type StagePostBody } from "../catalogue.ts";
import { templateBodies, templateField, templateRow } from "../templates.ts";
import {
  RefusedCall, SEEDING_FAILED_AFTER_COMMIT, SetupRefused, type CompetitionRef, type DivisionRef, type EntrantKind, type EntrantMember, type EntrantRow, type FixtureRow, type MemberInput, type StageRef,
} from "../driver/types.ts";
import { declaredPoints, foldStream, lineupsFor } from "../fold.ts";
import { redact } from "../redact.ts";
import { routeTo } from "../routing.ts";
import {
  DEPARTED_STATUSES, isTerminal, snap, toObservedOutcome,
  type CaseFact, type CompleteObs, type ConfigEditObs, type GenerateObs, type LoopExit, type ObservedDeclared, type ObservedFixture,
  type ObservedOutcome, type ObservedRun, type ObservedStage, type PairRoundObs, type WithdrawalObs,
} from "../observed.ts";
import { drawsAllowed, entrantKindFor, sportModule } from "../sport-cfg.ts";
import { generateStream, matchesRequest, type RequestMatch } from "../streams/index.ts";
import { START, type RequestedOutcome, type StreamEvent } from "../streams/types.ts";
import { confirmAdvance, sourcePoolCount, type AdvanceObs } from "./advance.ts";
import { playAmericano, playMexicano } from "./americano-loop.ts";
import { playLadder } from "./ladder-loop.ts";
import { lineupWarningLine, postedTeamSides, putOwedLineups, type LineupSink } from "./lineup-plan.ts";
import { rosterMembers, rosterSize } from "./rosters.ts";
import { STRUCTURAL_FINAL_KINDS, terminalFinalKeys } from "./terminal-finals.ts";
import type { ScenarioContext } from "./types.ts";

/** Final review I-2: what the harness POSTED beside what the product says it
 *  built, read back after start rather than taken from the create/add
 *  answers. life-built-as-posted compares the two. */
export interface BuiltReadback {
  /** `config`: the rule override the division was created with (W1b Task 10;
   *  `{}` for a default case). */
  posted: { sport: string; variant: string; stages: readonly StagePostBody[]; entrants: readonly { displayName: string; seed: number }[]; config: Readonly<Record<string, unknown>> };
  division: DivisionRef;
  stages: StageRef[];
  entrants: EntrantRow[];
  /** addEntrants' own answer — what the rest of the scenario keys on. */
  echo: EntrantRow[];
}

export interface DivisionSetup {
  competition: CompetitionRef;
  division: DivisionRef;
  /** The root stage (stages[0]). */
  stage: StageRef;
  /** W1-driving Task 6: every stage the product built, by seq. A later stage
   *  is generated (TBD) right after start and seeded by the advance. */
  stages: StageRef[];
  entrants: EntrantRow[];
  built: BuiltReadback;
  seedOf: (id: string) => number;
  idOfSeed: (seed: number) => string;
  /** The division's entrant kind (entrantKindFor on the case cfg). */
  kind: EntrantKind;
  /** The ids addEntrants answered: the division's own entrants. A fixture
   *  side outside it is one the product minted (an americano pair entrant,
   *  stages.ts pairEntrantsFor). */
  entrantIds: ReadonlySet<string>;
  /** PADPROOF's rosterless team entrants (SetUpOptions.rosterlessTeams, D3):
   *  no members posted, no lineup PUT. */
  rosterless: boolean;
  /** TEAM entrant → its roster as the product stored it (entrantMembers, in
   *  squad order): what ensureLineups builds each lineup from. Empty for a
   *  non-team or rosterless division; never an individual's persons. */
  rosters: ReadonlyMap<string, readonly EntrantMember[]>;
  /** W1-driving Task 5: on an americano row (personsNeeded), division entrant
   *  → its person ids as entrantMembers answered them — one for an
   *  individual, the whole roster for a team. Empty on any other row. Kept
   *  apart from `rosters` (plan review 1 I-1), so nothing that reads rosters
   *  ever sees an individual. Read by the americano loop (Task 8), M1's
   *  pair-entrant target (D14) and I10 (Task 9). */
  persons: ReadonlyMap<string, readonly string[]>;
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

/** Why playStage stopped (observed.ts, where W1-driving Task 6 moved it so
 *  each ObservedStage carries its own). */
export type { LoopExit } from "../observed.ts";

/** W1-driving Task 6: one stage's own loop record, so each later stage is
 *  observed on what ITS loop did, not the run's. */
export class StageTrack {
  exit: LoopExit | null = null;
  readonly generates: GenerateObs[] = [];
  readonly pairRounds: PairRoundObs[] = [];
}

export class Recorder {
  /** The run's exit: a single stage's own, or (playDivision) "drained" only
   *  when every stage drained, else the first stage's that did not. */
  exit: LoopExit | null = null;
  /** Run-wide, every stage's in call order (each stage's own is in `tracks`). */
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
  /** W1c Task 7: fixtures whose stream is the ledger's stored rows (the pad
   *  path), not the events the harness meant to send. PADPROOF requires every
   *  fixture it decides to be one. */
  readonly storedFixtures = new Set<string>();
  readonly notes: string[] = [];
  /** W1-driving Task 4: fixture → the sides ensureLineups has PUT a lineup
   *  for — once per SIDE, since a second PUT is a replacement nobody meant.
   *  Keyed on fixture AND side (W1-driving T6, T45-R2): confirm seats a later
   *  stage's TBD row under the SAME id, so a row first met empty must still
   *  get its lineups once seated. */
  readonly lineupSides = new Map<string, Set<string>>();
  /** W1-driving T6 (T45-R1): every team fixture the harness scored → its
   *  division-entrant sides, which life-lineups-put holds to a PUT each. */
  readonly teamPosts = new Map<string, string[]>();
  /** W1-driving Task 8: an americano stage id → every entrant its fixtures
   *  seat → that entrant's persons as entrantMembers answered (recordPersons);
   *  snapshot writes it, with the division entrants' own, to
   *  ObservedStage.persons. */
  readonly stagePersons = new Map<string, Record<string, readonly string[]>>();
  /** W1-driving Task 7 (D8): every challenge playLadder issued, by its step —
   *  what r4-not-challenged-later reads (a challenge's product round_no is
   *  never relied on). */
  readonly ladderSteps: { step: number; fixtureId: string }[] = [];
  /** W1-driving Task 4: lineup PUTs made, one per division-entrant side. */
  lineupsPut = 0;
  drawsPosted = 0;
  decided = 0;
  events = 0;
  /** W1-driving Task 6: stage id → its own loop record. */
  readonly tracks = new Map<string, StageTrack>();
  track(stageId: string): StageTrack {
    let t = this.tracks.get(stageId);
    if (t === undefined) { t = new StageTrack(); this.tracks.set(stageId, t); }
    return t;
  }
}

/** W1-driving Task 13: the end date a template case's competition is
 *  created with. Synthetic and far past any run (the product requires one,
 *  schemas.ts CreateFromTemplate `ends_on`), and the same day the builder
 *  path's createCompetition sends (http-driver.ts), so both create paths end
 *  on one day. Ruling 28's DRIVING_ROUTE / DRIVING_WAVE are gone: no route
 *  names the driving wave any more (scenario-catalogue.test.ts). */
export const TEMPLATE_ENDS_ON = "2030-12-31";
/** T12-R1: the product's withdraw-first guard (divisions.ts:857-871) refuses
 *  an entrants model that drops a kind an ACTIVE entrant holds, and an
 *  americano or mexicano stage MINTS pair entrants (stages.ts pairEntrantsFor)
 *  that the organiser never registered and cannot withdraw. A predicted
 *  product finding, written as a note: the signature words are verbatim, for
 *  Task 15's triage rule. */
export const MINTED_PAIRS_KIND_ROUTE = routeTo("W7", "americano-minted-pairs-block-kind-edit: organiser cannot narrow entrant kinds on a running americano (minted pairs block) (divisions.ts:857-871)");
/** The non-swiss generate loop's hard cap; hitting it records `cut_short`. */
export const MAX_ITERATIONS = 64;
/** engine-db/competition.ts:79 — the seat a bye's award is scored against. */
const BYE_PHANTOM = "__bye__";

/** W1d Task 6 (D6): runs one SETUP-PHASE driver call and tags a refusal from it. A
 *  RefusedCall out of `f` is rethrown as a SetupRefused (a subclass, so every existing
 *  `instanceof RefusedCall` catch still catches it): the harness asked the product to
 *  build something it will not build. Anything else — a result, any other error, an
 *  already-tagged refusal — passes through as it was. The tag is by PHASE, never by
 *  route (review 2, R2-I2): `setUpDivision` wraps every driver call it makes before
 *  `start`, and DENIED wraps its own four; `start` and the action under test stay
 *  outside, because their refusals are the product answering. */
export async function inSetup<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RefusedCall && !(e instanceof SetupRefused)) throw SetupRefused.from(e);
    throw e;
  }
}

/** `rosterlessTeams`: a team-kind sport plays on team entrants with no members
 *  and no lineups. Only PADPROOF asks for it (W1c Tasks 9–11): Step 0 saw the
 *  pad score a rosterless team fixture (volleyball beach), and the plan's D3
 *  proves the team sports' pads there. Every other scenario seats full
 *  rosters and PUTs lineups (W1-driving Task 4). */
export interface SetUpOptions { readonly rosterlessTeams?: boolean }

/** W1-driving Task 5: the product plays the PERSONS behind an americano
 *  stage's entrants (stages.ts americanoGen: one linked person per entrant, at
 *  least 4, else STAGE_NOT_READY). Americano and mexicano are one stage kind;
 *  the stage's mode decides. */
export function personsNeeded(bodies: readonly StagePostBody[]): boolean {
  return bodies.some((b) => b.kind === "americano");
}

/** W1-driving Task 8: every catalogue row is driven — americano and mexicano
 *  reach the driver like any other (FORMAT_LATER is gone, and Task 5's
 *  `buildDivision` is folded back in here). */
export async function setUpDivision(ctx: ScenarioContext, rec: Recorder, entrantCount: number, o: SetUpOptions = {}): Promise<DivisionSetup> {
  // Every refusal fires before the first driver call.
  const template = ctx.spec.template;
  const kind = entrantKindFor(ctx.spec.sport, ctx.cfg);
  // W1-driving Task 13 (ruling 47, D11): a template case's stages are the
  // catalog's, built by the product in the same act as its competition and
  // division; the case "posts" exactly that shape, so life-built-as-posted
  // judges the build against the catalog JSON.
  const bodies = template === undefined ? stagesForRow(ctx.spec.row) : templateCase(ctx, kind, template, entrantCount);
  const rosterless = o.rosterlessTeams === true;
  const persons = personsNeeded(bodies);
  // No case drives a pair kind (no sport defaults to one; only a cfg entrants
  // override makes one), and the harness has no pair members to post.
  if (persons && kind === "pair") throw new Error(`scenario: ${ctx.spec.row} on a pair-kind division — americano plays one person per entrant (stages.ts americanoGen) and the harness posts no pair members`);
  // The override crosses the wire as the division's config, as the editor
  // sends it; a template case carries none (the card takes no rule —
  // templateCase refuses one by name).
  const config: Record<string, unknown> = { ...(ctx.spec.overrides ?? {}) };
  let competition: CompetitionRef;
  let division: DivisionRef;
  if (template !== undefined) {
    // ONE organiser act: the card. It creates no entrant (templates.ts:351-366),
    // and its stages are never posted.
    ({ competition, division } = await inSetup(() => ctx.driver.createFromTemplate(template, { name: `Matrix ${ctx.spec.caseId}`, endsOn: TEMPLATE_ENDS_ON })));
  } else {
    const slug = `m-${ctx.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60).replace(/-+$/, "");
    competition = await inSetup(() => ctx.driver.createCompetition({ name: `Matrix ${ctx.spec.caseId}`, slug }));
    division = await inSetup(() => ctx.driver.createDivision(competition.id, { name: `Matrix ${ctx.spec.sport}`, slug: "d", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant, config }));
    await inSetup(() => ctx.driver.postStages(division.id, bodies));
  }
  const inputs = Array.from({ length: entrantCount }, (_, i) => ({ displayName: `Matrix Player ${i + 1}`, seed: i + 1 }));
  // Task 4 (fold-in beneath ruling 49): a team entrant carries the catalog's
  // full roster (D2). Task 5: on an americano row an individual carries one
  // linked person, named as the entrant. Any other entrant carries no
  // `members` key at all, so its add is byte for byte what it was.
  const seated = kind === "team" && !rosterless;
  const linked = persons && kind === "individual";
  const membersOf = (e: { displayName: string; seed: number }): readonly MemberInput[] | undefined => {
    if (seated) return rosterMembers(ctx.spec.sport, ctx.cfg, e.seed);
    if (linked) return [{ fullName: e.displayName, squadNumber: 1, isCaptain: true }];
    return undefined;
  };
  const entrants = await inSetup(() => ctx.driver.addEntrants(division.id, inputs.map((e) => {
    const members = membersOf(e);
    return { ...e, kind, ...(members !== undefined ? { members } : {}) };
  })));
  // The members are the PRODUCT's person ids, read back for every entrant it
  // answered — never the inputs. A roster that is not the full declared size
  // would play short, and an americano individual with no person is no
  // player, so each is refused by name. (An entrant the product never stored
  // is life-built-as-posted's red, not this guard's.)
  const rosters = new Map<string, readonly EntrantMember[]>();
  const personsOf = new Map<string, readonly string[]>();
  const size = seated ? rosterSize(ctx.spec.sport, ctx.cfg) : linked ? 1 : 0;
  if (size > 0) {
    for (const e of entrants) {
      const stored = await inSetup(() => ctx.driver.entrantMembers(e.id));
      if (stored.length !== size) {
        throw new Error(seated
          ? `scenario: entrant ${e.id} (seed ${e.seed ?? "none"}) reads back ${stored.length} roster member(s), ${size} posted — a short roster would play short`
          : `scenario: entrant ${e.id} (seed ${e.seed ?? "none"}) reads back ${stored.length} linked person(s), ${size} posted — americano plays the person behind each entrant (stages.ts americanoGen)`);
      }
      if (seated) rosters.set(e.id, stored);
      if (persons) personsOf.set(e.id, stored.map((m) => m.person_id));
    }
  }
  await ctx.driver.start(division.id);
  const stages = [...await ctx.driver.listStages(division.id)].sort((a, b) => a.seq - b.seq);
  const stage = stages[0];
  if (stage === undefined) throw new Error(`scenario: division ${division.id} has no stage after start`);
  const built: BuiltReadback = {
    posted: { sport: ctx.spec.sport, variant: ctx.spec.variant, stages: bodies, entrants: inputs, config },
    division: await ctx.driver.getDivision(division.id),
    stages,
    entrants: await ctx.driver.listEntrants(division.id),
    echo: entrants,
  };
  const seeds = new Map(entrants.map((e) => [e.id, e.seed ?? Number.MAX_SAFE_INTEGER]));
  rec.notes.push(`stage ${stage.kind} status after start: ${stage.status}`);
  return {
    competition, division, stage, stages, entrants, built,
    kind, entrantIds: new Set(entrants.map((e) => e.id)), rosterless, rosters, persons: personsOf,
    seedOf: (id) => seeds.get(id) ?? Number.MAX_SAFE_INTEGER,
    idOfSeed: (seed) => {
      const e = entrants.find((x) => x.seed === seed);
      if (e === undefined) throw new Error(`scenario: no entrant holds seed ${seed}`);
      return e.id;
    },
  };
}

/** A template case's guards and bodies (W1-driving Task 13), before any
 *  driver call: the template must build the case's row (templateRow, which
 *  also refuses a drifted catalog), the case must run on the template's own
 *  sport and variant (its cfg was resolved for them), and the case's entrant
 *  kind must be the one the template seeds. T13-R1 m-1: the card takes no
 *  rule, so a case carrying overrides is refused (run.ts resolves the cfg
 *  with them, and the case would score under a rule the product never set);
 *  and the field is the template's own entrantCount (D11), never another. */
function templateCase(ctx: ScenarioContext, kind: EntrantKind, key: string, entrantCount: number): StagePostBody[] {
  const overrides = Object.keys(ctx.spec.overrides ?? {});
  if (overrides.length > 0) throw new Error(`scenario: catalog template ${key} takes no overrides (its card sets no rule); case ${ctx.spec.caseId} carries ${overrides.join(", ")}`);
  const builds = templateRow(key);
  if (builds !== ctx.spec.row) throw new Error(`scenario: catalog template ${key} builds ${builds}, not ${ctx.spec.row} (case ${ctx.spec.caseId})`);
  const t = templateField(key);
  if (t.sport !== ctx.spec.sport || t.variant !== ctx.spec.variant) {
    throw new Error(`scenario: catalog template ${key} builds ${t.sport}/${t.variant}; case ${ctx.spec.caseId} runs ${ctx.spec.sport}/${ctx.spec.variant} — its cfg would score another variant`);
  }
  if (t.entrantKind !== kind) throw new Error(`scenario: catalog template ${key} seeds ${t.entrantKind} entrants; case ${ctx.spec.caseId}'s cfg plays ${kind}`);
  if (entrantCount !== t.entrantCount) throw new Error(`scenario: catalog template ${key} seats ${t.entrantCount} entrants (D11); case ${ctx.spec.caseId} asked for ${entrantCount}`);
  return templateBodies(key);
}

/** The lineup-issue text and its kind reader live in rosters.ts beside the
 *  side-size finding (W1-driving Task 14 fix round 1, m-4); re-exported for
 *  the harness's own callers. */
export { LINEUP_ISSUE_TEXT, lineupWarningKind } from "./rosters.ts";

/** T3-R1: the product checked a lineup the harness PUT and warned, and the
 *  warning is not the known side-size finding. The lineup was built to pass
 *  the engine's validateLineup on the case cfg (rosters.test.ts sweeps every
 *  team preset), so a warning means the product judged it against something
 *  else — red, by name. */
export class LineupWarned extends Error {
  readonly fixtureId: string;
  readonly entrantId: string;
  readonly kind: string | null;
  readonly warning: string;
  constructor(row: string, fixtureId: string, entrantId: string, kind: string | null, warning: string) {
    super(redact(`scenario: ${lineupWarningLine(row, fixtureId, entrantId, kind, warning)}`));
    this.name = "LineupWarned";
    this.fixtureId = fixtureId;
    this.entrantId = entrantId;
    this.kind = kind;
    this.warning = redact(warning);
  }
}

/** Fold-in beneath ruling 49: a team fixture's lineups are PUT while it is
 *  still scheduled, before the harness posts anything to it — members alone
 *  never reach the engine, which reads per-fixture lineups only (engine-db
 *  loadLineupPair). Once per fixture SIDE (rec.lineupSides), because a second
 *  PUT is a replacement the scenario never meant — keyed on the side too
 *  (T45-R2), since confirm seats a later stage's TBD row under the same id: a
 *  side met empty gets its lineup once it is seated. `f.status` is the status
 *  the caller just read (decideFixture's fixtureState).
 *  Plan review 1 I-1: gated on TEAM kind AND the side being one of the
 *  division's own entrants. An americano/mexicano fixture seats ephemeral
 *  PAIR entrants the product minted (stages.ts pairEntrantsFor), which are in
 *  no roster; such a side is skipped with a named note — once per stage
 *  (PF-5) — never PUT. A side outside the division on any OTHER stage kind
 *  is thrown by name (T45-R3): nothing else mints entrants. A DIVISION entrant with no recorded
 *  roster is still a harness bug, named. A fixture already past scheduled
 *  (a foreign write started it) takes no PUT — the product would refuse it —
 *  and is noted; its parity is already the unjudgeable item. */
export async function ensureLineups(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow): Promise<void> {
  // The rule is the shared planner's (lineup-plan.ts, T14-R3); the harness
  // supplies its division and its sinks — notes, once each, and LineupWarned.
  // D3: a PADPROOF rosterless setup scores team fixtures with no lineup (W1c D-T9-2): the planner returns first.
  await putOwedLineups(ctx.driver, {
    sport: ctx.spec.sport, variant: ctx.spec.variant, cfg: ctx.cfg, kind: setup.kind, rosterless: setup.rosterless,
    entrantIds: setup.entrantIds, rosters: setup.rosters, stageKindOf: (id) => setup.stages.find((s) => s.id === id)?.kind,
  }, rec, { id: f.id, stageId: f.stage_id, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status }, harnessLineupSink(rec));
}

/** The harness's sinks: every message a note (once per case), every unexpected warning a LineupWarned. */
function harnessLineupSink(rec: Recorder): LineupSink {
  const noteOnce = (note: string) => { if (!rec.notes.includes(note)) rec.notes.push(note); };
  return {
    prefix: "scenario", actor: "harness",
    locked: (line) => noteOnce(`lineups: ${line}`),
    pairSideSkipped: (line) => noteOnce(`lineups: ${line}`),
    knownWarning: (line) => noteOnce(`lineup-side-size-warning: ${line}`),
    warned: (w) => new LineupWarned(w.row, w.fixtureId, w.entrantId, w.kind, w.warning),
  };
}

/** Records each generate run-wide AND on the stage's own track (W1-driving
 *  Task 6), so a later stage is judged on its own generates. */
export async function recordGenerate(ctx: ScenarioContext, rec: Recorder, stageId: string): Promise<FixtureRow[] | null> {
  const push = (g: GenerateObs) => { rec.generates.push(g); rec.track(stageId).generates.push(g); };
  try {
    const g = await ctx.driver.generate(stageId);
    push({ status: 200, code: null, total: g.fixtures.length, created: g.created });
    return g.fixtures;
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    // T8-R1: the message is kept — a 5xx's cause is read from it (americano-loop.ts).
    push({ status: e.status, code: e.code, total: 0, created: 0, message: e.message });
    return null;
  }
}

export const seatedOpen = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null && !isTerminal(f.status);

export function defaultPolicy(setup: DivisionSetup, f: FixtureRow, drawOk: boolean, ordinal: number): RequestedOutcome {
  if (drawOk && ordinal % 3 === 2) return { kind: "draw" };
  return { kind: "win", winner: setup.seedOf(f.home_entrant_id!) <= setup.seedOf(f.away_entrant_id!) ? "home" : "away" };
}

const stageCtx = (kind: string, f: { pool_id: string | null; round_no: number | null }): StageCtx =>
  ({ kind: kind as StageKind, ...(f.pool_id ? { poolId: f.pool_id } : {}), ...(f.round_no ? { roundNo: f.round_no } : {}) });

/** `stage` (W1-driving Task 6): the stage `f` belongs to — its kind shapes
 *  the stream, the request match and the declared points. */
export async function decideFixture(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, outcome: RequestedOutcome, stage: StageRef = setup.stage): Promise<void> {
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
  // Task 4: a team fixture's lineups go in first, on the score branch and the
  // forfeit branch alike (M1's walkover comes through here).
  await ensureLineups(ctx, rec, setup, { ...f, status: state.status });
  const generated = generateStream({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: stage.kind as StageKind, home, away, outcome });
  // What the driver actually sends: a forfeit on a fixture already under way
  // is the bare core.forfeit (http-driver.ts forfeit), so START only when the
  // fixture is still scheduled.
  const now = outcome.kind === "forfeit" && state.status !== "scheduled" ? generated.filter((e) => e.type !== START.type) : generated;
  const prior = rec.streams.get(f.id) ?? [];
  const posted = outcome.kind === "forfeit"
    ? await ctx.driver.forfeit(f.id, outcome.by === "home" ? home : away, outcome.reason, `${ctx.tag}:${f.id}`)
    : await ctx.driver.postStream(f.id, now, `${ctx.tag}:${f.id}`);
  // W1c Task 7: the pad path answers each event with the ledger row the
  // product actually stored. Fold those rows, so a browser run is judged on
  // what the product holds and never on what the harness meant to send. A
  // driver answers every event from the ledger or none of them, and one that
  // answered nothing for a non-empty stream folds nothing: the stream it meant
  // to send is not evidence of anything.
  const stored = posted.filter((p) => p.stored !== undefined);
  if (stored.length > 0 && stored.length < posted.length) {
    throw new Error(`scenario: ${f.id}: ${stored.length} of ${posted.length} answered event(s) carry the stored row — a driver answers every event from the ledger, or none`);
  }
  const answeredNothing = posted.length === 0 && now.length > 0;
  if (answeredNothing) rec.notes.push(`${f.id}: the driver answered no event for the ${now.length} sent`);
  const sent = stored.length > 0 ? stored.map((p) => p.stored!) : answeredNothing ? [] : now;
  if (stored.length > 0) rec.storedFixtures.add(f.id);
  const whole = [...prior, ...sent];
  rec.streams.set(f.id, whole);
  // Parked Task 6 (b): a post that raced another writer is traced, not silent.
  const retried = posted.filter((p) => p.retried === true).length;
  if (retried > 0) rec.notes.push(`${f.id}: ${retried} event(s) landed on a SEQ_CONFLICT retry`);
  const productOutcome = toObservedOutcome(posted.at(-1)?.outcome ?? null);
  // T45-R1: a scored team fixture owes a lineup per division-entrant side
  // (life-lineups-put holds every one of them to a PUT). A rosterless setup
  // (PADPROOF, D3) owes none — the harness's own skip, kept here explicitly.
  if (setup.kind === "team" && !setup.rosterless) rec.teamPosts.set(f.id, postedTeamSides(home, away, (e) => setup.entrantIds.has(e)));
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
  const request = matchesRequest({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: stage.kind as StageKind, home, away, outcome }, folded);
  rec.parity.push({ fixtureId: f.id, local: toObservedOutcome(folded), product: productOutcome, foreign: 0, finishedBefore: null, request });
  const dp = declaredPoints(m, ctx.cfg, stageCtx(stage.kind, f), home, away, whole);
  if (dp !== null) rec.declared.set(f.id, { home: dp.home, away: dp.away, forOutcome: toObservedOutcome(dp.forOutcome)! });
}

export type RoundHook = (round: number, batch: FixtureRow[]) => Promise<void>;

/** One round's batch, decided in fixture order between the round hooks —
 *  playStage's own, lifted to take the stage (W1-driving Task 8) so the
 *  americano loops decide a round exactly as every other loop does. */
export async function decideRound(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, round: number, batch: FixtureRow[], hooks: { beforeRound?: RoundHook; afterRound?: RoundHook }): Promise<void> {
  const drawOk = stageDrawsOk(ctx, stage);
  await hooks.beforeRound?.(round, batch);
  for (const f of [...batch].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))) {
    await decideFixture(ctx, rec, setup, f, defaultPolicy(setup, f, drawOk, rec.decided), stage);
  }
  await hooks.afterRound?.(round, batch);
}

/** T6-R3 (m-12): whether the engine declares a draw reachable on THIS
 *  stage's kind (supportsDraws, via drawsAllowed). Decided per stage — a
 *  later bracket never inherits the root's draws. */
export function stageDrawsOk(ctx: ScenarioContext, stage: Pick<StageRef, "kind">): boolean {
  return drawsAllowed(ctx.spec.sport, ctx.cfg, stage.kind as StageKind);
}

/** …and for the run (life-draw-path-exercised): some stage the run REACHED —
 *  asked to complete, which every reached stage is — declares a draw. */
export function drawsDeclaredOnReached(ctx: ScenarioContext, plays: readonly StagePlay[]): boolean {
  return plays.some((p) => p.complete !== null && stageDrawsOk(ctx, p.stage));
}

/** Plays one stage to its loop exit. `stage` (W1-driving Task 6) defaults to
 *  the root; the exit lands on the stage's own track and on the run alike. */
export async function playStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook } = {}, stage: StageRef = setup.stage): Promise<void> {
  // W1-driving Task 7 (D8): a ladder generates nothing (stages.ts ladder gen
  // is []); it is driven through challenges.
  if (stage.kind === "ladder") return playLadder(ctx, rec, setup, stage, hooks);
  // W1-driving Task 8 (D9): americano and mexicano are ONE stage kind; the
  // stage's config.mode decides, read as the product reads it (stages.ts:756).
  if (stage.kind === "americano") return stage.config.mode === "mexicano" ? playMexicano(ctx, rec, setup, stage, hooks) : playAmericano(ctx, rec, setup, stage, hooks);
  const track = rec.track(stage.id);
  const exit = (e: LoopExit) => { track.exit = e; rec.exit = e; };
  const decideBatch = (round: number, batch: FixtureRow[]) => decideRound(ctx, rec, setup, stage, round, batch, hooks);
  if (stage.kind === "swiss") {
    const rounds = Number(stage.config.rounds);
    for (let r = 1; r <= rounds; r++) {
      const fixtures = await recordGenerate(ctx, rec, stage.id);
      const batch = (fixtures ?? []).filter((f) => f.round_no === r && seatedOpen(f));
      const pr = { roundNo: r, seated: batch.length };
      rec.pairRounds.push(pr);
      track.pairRounds.push(pr);
      if (batch.length === 0) { // I4 fails on the empty pair round
        exit(fixtures === null ? "refused_generate" : "empty_pair_round");
        return;
      }
      await decideBatch(r, batch);
    }
    exit("drained");
    return;
  }
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const fixtures = await recordGenerate(ctx, rec, stage.id);
    // A named refusal is NOT "nothing left to play" (I-1): it stops the loop
    // with the stage unfinished, and life-loop-bounded says so.
    if (fixtures === null) { exit("refused_generate"); return; }
    const open = fixtures.filter(seatedOpen);
    if (open.length === 0) { exit("drained"); return; }
    const round = Math.min(...open.map((f) => f.round_no ?? 0));
    await decideBatch(round, open.filter((f) => (f.round_no ?? 0) === round));
  }
  exit("cap");
  rec.facts.add("cut_short");
  rec.notes.push(`loop cap ${MAX_ITERATIONS} reached`);
}

/** One stage as the division played it: the stage, its field (the division's
 *  entrants for the root, the entrants the advance seated for a later stage;
 *  null before a stage was reached), the advance into it, and its /complete. */
export interface StagePlay {
  readonly stage: StageRef;
  readonly field: readonly string[] | null;
  readonly advance: AdvanceObs | null;
  readonly complete: CompleteObs | null;
}

/** The run's exit is "drained" only if every stage drained; otherwise the
 *  first stage's that did not. */
const worstExit = (exits: readonly (LoopExit | null)[]): LoopExit | null => (exits.length === 0 ? null : exits.find((e) => e !== "drained") ?? "drained");

/** W1-driving Task 6: every stage of the division, in the product's own
 *  sequence. Each later "setup" stage gets its TBD rows right after start,
 *  before any play (generate is idempotent; a /complete whose next stage has
 *  no TBD rows commits and then answers 409 STAGE_COMPLETED_SEEDING_FAILED —
 *  FP-1). Then per stage: play it, complete it ONCE, and confirm the draft
 *  proposal that /complete returned on the next stage. The hooks run on stage
 *  1 only (D12). A stage after one that did not complete, or that completed
 *  with no proposal (409 STAGE_COMPLETED_SEEDING_FAILED, m-7), or whose
 *  advance was refused, is recorded `not_reached`.
 *  Every REACHED stage is asked to complete once its loop ends, drained or
 *  not, as W1a's root always was (scenarios.test.ts "I-1": I4 judges the
 *  answer; life-loop-bounded reds the early stop). That is still "once": a
 *  stage that is not ready answers `completed: false` and commits nothing
 *  (stages.ts completeStageIfReady), and the drivers refuse a repeat only
 *  after a commit. */
export async function playDivision(
  ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup,
  hooks: { beforeRound?: RoundHook; afterRound?: RoundHook; beforeComplete?: (stage: StageRef) => Promise<void> } = {},
): Promise<StagePlay[]> {
  for (const s of setup.stages.slice(1)) await recordGenerate(ctx, rec, s.id);
  const plays: StagePlay[] = [];
  for (const [i, stage] of setup.stages.entries()) {
    let advance: AdvanceObs | null = null;
    let field: readonly string[] | null = i === 0 ? setup.entrants.map((e) => e.id) : null;
    if (i > 0) {
      const prev = plays[i - 1];
      const proposal = prev.complete?.seedProposal ?? null;
      if (prev.complete?.completed !== true || proposal === null) {
        rec.track(stage.id).exit = "not_reached";
        const why = prev.complete === null ? "never completed" : `completed=${prev.complete.completed}, proposal ${proposal === null ? "none" : proposal.id}`;
        rec.notes.push(`stage ${stage.seq}: not reached (stage ${prev.stage.seq} ${why})`);
        plays.push({ stage, field: null, advance: null, complete: null });
        continue;
      }
      // m-11: by seq, as builtAsPosted pairs them — never by array position.
      const body = setup.built.posted.stages.find((b) => b.seq === stage.seq);
      if (body === undefined) throw new Error(`scenario: stage ${stage.seq} has no posted body — ${setup.built.posted.stages.length} posted, ${setup.stages.length} built`);
      // Final review m-5: the source's pool count is its posted body's, checked against the pool ids its fixtures name
      // over the field it was generated on (stage 1's entrants; a later stage's confirmed slots — no byes in a table).
      const prevBody = setup.built.posted.stages.find((b) => b.seq === prev.stage.seq);
      if (prevBody === undefined) throw new Error(`scenario: stage ${prev.stage.seq} has no posted body — ${setup.built.posted.stages.length} posted, ${setup.stages.length} built`);
      const sourceField = i === 1 ? setup.entrants.length : prev.advance?.filled;
      if (sourceField === undefined) throw new Error(`scenario: stage ${prev.stage.seq} was reached with no advance to size its field`);
      const named = new Set((await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === prev.stage.id && f.pool_id !== null).map((f) => f.pool_id!));
      const pools = sourcePoolCount(prevBody, sourceField, named);
      advance = await confirmAdvance(ctx, rec, stage, proposal, body, pools);
      field = advance.seeded;
      if (advance.status !== 200) {
        rec.track(stage.id).exit = "not_reached";
        rec.notes.push(`stage ${stage.seq}: not reached (its seed advance was refused ${advance.status} ${advance.code ?? "(no code)"})`);
        plays.push({ stage, field, advance, complete: null });
        continue;
      }
    }
    await playStage(ctx, rec, setup, i === 0 ? hooks : {}, stage); // D12: hooks on stage 1 only
    if (i === 0) await hooks.beforeComplete?.(stage);
    const complete = await finishStage(ctx, rec, stage.id);
    plays.push({ stage, field, advance, complete });
  }
  rec.exit = worstExit(setup.stages.map((s) => rec.track(s.id).exit));
  if (setup.kind === "team" && !setup.rosterless) {
    rec.notes.push(`lineups: ${rec.lineupsPut} PUT across ${rec.teamPosts.size} team fixture(s) scored`);
  }
  return plays;
}

function toFixture(f: FixtureRow): Omit<ObservedFixture, "declared"> {
  return {
    id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome),
    // T3 review G1: only a row the product flags carries it.
    ...(f.third_place === true ? { thirdPlace: true } : {}),
    // W1-driving Task 6: kept only where the source serves them.
    ...(f.ext_key !== undefined ? { extKey: f.ext_key } : {}),
    ...(f.is_final === true ? { isFinal: true } : {}),
  };
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
  // The one save the lock lets through (entrants-only). T12-R1: its kinds are
  // the ones the product's ACTIVE entrants hold, read from the product's own
  // list — divisions.ts:857-871 refuses any model missing one of them, so
  // this is the narrowest entrants save the product can accept.
  const active = (await ctx.driver.listEntrants(division.id)).filter((e) => !DEPARTED_STATUSES.includes(e.status));
  const kinds = [...new Set(active.flatMap((e) => (e.kind === undefined ? [] : [e.kind])))];
  if (kinds.length > 0) attempts.push({ kind: "entrants_only", ...(await ctx.driver.patchDivisionConfig(division.id, { ...division.config, entrants: { kinds } })) });
  rec.notes.push(...attempts.map((a) => `config ${a.kind}: ${a.status} ${a.code ?? ""}`.trim()));
  // None to save is not a pass: life-entrants-edit-accepted fails on 0 attempts.
  if (kinds.length === 0) rec.notes.push("config entrants_only: not sent — the product lists no active entrant with a kind");
  // The kinds held only by entrants the harness never posted (the stage's
  // minted pairs): those are what keep an organiser from narrowing.
  const posted = new Set(active.filter((e) => setup.entrantIds.has(e.id)).flatMap((e) => (e.kind === undefined ? [] : [e.kind])));
  const minted = active.filter((e) => !setup.entrantIds.has(e.id) && e.kind !== undefined && !posted.has(e.kind));
  if (minted.length > 0) {
    rec.notes.push(`americano-minted-pairs-block-kind-edit: organiser cannot narrow entrant kinds on a running americano (minted pairs block) — ${minted.length} minted pair entrant(s) active on this ${ctx.spec.row}, kinds saved ${kinds.join("+")} — predicted product red → ${MINTED_PAIRS_KIND_ROUTE.wave}`);
  }
  return { attempts, before, after: await read() };
}

/** A refused complete is recorded for I4 (which accepts a NAMED refusal) and
 *  noted; whether the stage was left unfinished is life-loop-bounded's call.
 *  W1-driving Task 6: takes the stage id (any stage), and carries the next
 *  stage's draft proposal /complete minted — the only place its id is
 *  served. A 409 STAGE_COMPLETED_SEEDING_FAILED is the product saying the
 *  stage COMMITTED and only the next stage's seeding failed (stages.ts
 *  :4239-4252): recorded complete, with no proposal and a named note
 *  (fix round 1, m-7; advance-seeded-as-declared fails on it). Its body
 *  carries no events, so finalRanks stay null. The driver never repeats it
 *  (FP-3). */
export async function finishStage(ctx: ScenarioContext, rec: Recorder, stageId: string): Promise<CompleteObs> {
  try {
    const c = await ctx.driver.completeStage(stageId);
    const done = c.events.find((e) => e.type === "stage_completed");
    return { status: 200, code: null, completed: c.completed, finalRanks: done?.finalRanks ?? null, seedProposal: c.seed_proposal ?? null };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    if (e.code === SEEDING_FAILED_AFTER_COMMIT) {
      rec.notes.push(`complete committed, but the next stage's seeding failed: ${e.status} ${e.code}`);
      return { status: e.status, code: e.code, completed: true, finalRanks: null, seedProposal: null };
    }
    rec.notes.push(`complete refused ${e.status} ${e.code ?? "(no code)"}`);
    return { status: e.status, code: e.code, completed: false, finalRanks: null, seedProposal: null };
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

/** W1-driving Task 9: a ladder's `ladder_order` is the raw stored order — the
 *  product writes it at the first challenge and on every decided swap
 *  (stages.ts:5538-5551, scoring.ts:774-786) and never prunes it; it is NOT
 *  ruling 53's "live" (pruned) order. The StageRef a play carries is the
 *  setup-time copy, which predates both writes. I9 compares finalRanks with
 *  the raw stored order as the product holds it at the end of the run, so it
 *  is read once, for the ladder stages only — every other kind keeps the copy
 *  it was played with (a config edit probe must not leak into
 *  abstainOnStageConfig). A ladder the product lists without an order keeps
 *  none, and I9 says so by name. */
async function storedLadderOrders(ctx: ScenarioContext, setup: DivisionSetup, plays: readonly StagePlay[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!plays.some((p) => p.stage.kind === "ladder")) return out;
  for (const s of await ctx.driver.listStages(setup.division.id)) {
    const order: unknown = s.config.ladder_order;
    if (s.kind === "ladder" && Array.isArray(order) && plays.some((p) => p.stage.id === s.id)) out.set(s.id, [...(order as readonly unknown[])]);
  }
  return out;
}

/** W1-driving Task 9 (ruling 45): the terminal final keys of a structural
 *  bracket, sized as the product laid it out. A root stage is Start's over
 *  its field; a setup-timing later stage was generated over its DECLARED
 *  slots (stages.ts generateProgressionSetupFixtures), and a withdrawn
 *  qualifier's seat stays empty (FP-2), so the seeded field can be smaller
 *  than the bracket. The ids are placeholders: only the size shapes the keys.
 *  null off the structural kinds, and for a stage with no field observed. A
 *  size the engine refuses to lay out (a page playoff of anything but 4) has
 *  no keys: the product's own generator refuses it too, so such a stage never
 *  completes, and if one ever did I2 names the missing keys — never a throw
 *  that would cost the case every other observation. */
function terminalFinalsOf(stage: StageRef, play: StagePlay): readonly string[] | null {
  if (!STRUCTURAL_FINAL_KINDS.includes(stage.kind) || play.field === null) return null;
  const size = Math.max(play.field.length, play.advance?.declared ?? 0);
  const slots = [...play.field, ...Array.from({ length: size - play.field.length }, (_, k) => `vacant:${k}`)];
  try {
    return terminalFinalKeys(stage.kind, slots, stage.config);
  } catch (e) {
    if (EngineError.is(e)) return [];
    throw e;
  }
}

/** One ObservedStage per play (W1-driving Task 6), each on its OWN rows,
 *  tables, generates, pair rounds and exit. The root's field is the
 *  division's entrants ("division"); a later stage's is the entrants the
 *  advance seated ("seeded") — I1 refuses a later stage judged on a
 *  division-wide field (W1a carry 1). */
export async function snapshot(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, plays: readonly StagePlay[], extra: { configEdit: ConfigEditObs | null; withdrawal: WithdrawalObs | null }): Promise<ObservedRun> {
  if (plays.length === 0) throw new Error("scenario: snapshot of a division with no stage played — a run observes at least its root stage");
  const all = await ctx.driver.listFixtures(setup.division.id);
  const stored = await storedLadderOrders(ctx, setup, plays);
  const stages: ObservedStage[] = [];
  for (const [i, play] of plays.entries()) {
    const stage = play.stage;
    const config = stored.has(stage.id) ? { ...stage.config, ladder_order: stored.get(stage.id) } : stage.config;
    const rows = all.filter((f) => f.stage_id === stage.id);
    const fixtures: ObservedFixture[] = rows.map((f) => {
      const base = { ...toFixture(f), declared: null };
      return { ...base, declared: rec.declared.get(f.id) ?? byeDeclared(ctx.spec.sport, ctx.cfg, stage.kind, base) };
    });
    // One table per pool, each keeping its poolId (a merged table reds I1/I3).
    const poolIds = [...new Set(rows.map((f) => f.pool_id))];
    const standings: ObservedStage["standings"] = [];
    for (const poolId of poolIds.length > 0 ? poolIds : [null]) {
      const s = await ctx.driver.standings(stage.id, poolId);
      standings.push({ poolId, rows: s.rows.map((r) => ({ entrantId: r.entrantId, rank: r.rank, points: typeof r.points === "number" ? r.points : null })) });
    }
    const track = rec.track(stage.id);
    // W1-driving Task 8: an americano stage carries its persons — the pair
    // entrants recordPersons read, beside the division entrants' own (Task 5).
    const pairs = rec.stagePersons.get(stage.id);
    const finals = terminalFinalsOf(stage, play);
    stages.push({
      id: stage.id, seq: stage.seq, kind: stage.kind, config,
      field: [...(play.field ?? [])], fieldSource: i === 0 ? "division" : "seeded", fixtures, standings,
      generates: track.generates, pairRounds: track.pairRounds, complete: play.complete, exit: track.exit,
      ...(pairs !== undefined ? { persons: { ...Object.fromEntries(setup.persons), ...pairs } } : {}),
      ...(finals !== null ? { terminalFinals: finals } : {}),
    });
  }
  return {
    caseId: ctx.spec.caseId,
    facts: [...rec.facts],
    stages,
    withdrawal: extra.withdrawal,
    configEdit: extra.configEdit,
  };
}
