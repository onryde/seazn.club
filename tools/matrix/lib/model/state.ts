// The model the fast-check commands mutate, and the check that runs after
// every command (design §7.5 item 1):
//  - the step-safe invariants (I6, I7, I8 — invariants.ts STEP_INVARIANTS)
//    over what the product shows now, reused unchanged;
//  - the orientation check, which sees the duplicate I7 cannot at legs ≥ 2;
//  - fold parity for every fixture whose whole ledger the model knows;
//  - and, in the commands, every refusal named, every refusal of a command
//    the model holds legal a violation, and the roster lock an EXPECTED
//    refusal — as is a knockout take-back once the match it feeds has
//    started (NEXT_MATCH_LOCK, ruling RR-1).
// Every ledger that goes unknown is counted (`unknowns`), every step is
// classed (`steps`), and informativeSteps() fails a cell with none that told
// the model anything (R25).
// W1-driving Task 14 (ruling 49, D6): a team division fields full catalog
// rosters and PUTs a lineup per fixture side before its first post — by the
// scenario harness's own rule (lineup-plan.ts, shared with ensureLineups;
// fix round 1, T14-R3) — and a row the model does not drive is refused by
// family (ModelUnsupported).
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { nextMatchFixtureId, type EntrantInput, type EntrantMember, type EntrantRow, type FixtureRow, type FixtureStateOut, type OrganiserDriver, type RefusedCall } from "../driver/types.ts";
import { stagesForRow, type RowKey, type StagePostBody } from "../catalogue.ts";
import { evaluateStepInvariants } from "../invariants.ts";
import type { CheckResult } from "../results.ts";
import { sameOutcome, toObservedOutcome, type GenerateObs, type ObservedFixture, type ObservedOutcome, type ObservedRun } from "../observed.ts";
import { NotAWave, WAVE_ID, type Route } from "../routing.ts";
import { lineupItems, lineupWarningLine, putOwedLineups, type LineupSink } from "../scenarios/lineup-plan.ts";
import { entrantName, rosterMembers, rosterSize } from "../scenarios/rosters.ts";
import { entrantKindFor, resolveSportCfg } from "../sport-cfg.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "./ledger-fold.ts";

export const COMMAND_KINDS = ["Start", "AddEntrant", "Withdraw", "Score", "Walkover", "Void", "Correct", "Generate", "Rebuild", "Complete"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** One fixture as the model knows it. `ledger` is every event the model
 *  posted to it, in order — or null once events the model did not write may
 *  exist (a withdrawal cascade, a refused post, a fixture first seen under
 *  way). Fold parity judges only a known, non-empty ledger. `round` is the
 *  product's round_no, which a bracket's feeds run up (nextMatchMayHaveStarted). */
export interface FixtureModel { id: string; round: number | null; home: string | null; away: string | null; status: string; ledger: LedgerEntry[] | null }

export class ModelViolation extends Error {
  readonly check: string;
  readonly evidence: string[];
  /** The product's own answer when the product refused (RefusedCall.message,
   *  redacted), appended to the evidence as its last line; null for a
   *  violation the harness judged on its own. The ONLY text a committed
   *  case's `match` is tested against (T15 fix round 3, M-3): never the
   *  harness's own lines. */
  readonly said: string | null;
  constructor(check: string, evidence: string[], said: string | null = null) {
    const all = said === null ? evidence : [...evidence, said];
    super(`${check}: ${all.slice(0, 3).join("; ")}`);
    this.name = "ModelViolation";
    this.check = check;
    this.evidence = all;
    this.said = said;
  }
}

/** How a step ended. Only an accepted step whose ledgers stayed known is
 *  informative: a refusal (ordinary or expected) changed nothing, and an
 *  "unknown" step left a ledger the model can no longer fold. */
export type StepVerdict = "accepted" | "refused" | "expected-refusal" | "unknown";
export interface StepRecord { cmd: string; verdict: StepVerdict }
/** A ledger that went unknown because the product's event count stopped
 *  matching the model's: a post answered on the SEQ_CONFLICT retry, or a tip
 *  that moved under the model (a second writer) — or a fed match whose events
 *  the model cannot see, so a NEXT_MATCH_STARTED refusal over it could be
 *  judged neither right nor wrong (ruling RR-1, fix round 3). */
export interface UnknownLedger { cause: "retried" | "tip-moved" | "next-match-unverified"; fixture: string; detail: string }
export interface CommandCounts { ran: number; accepted: number; refused: number; expected: number; unexpected: number }

export interface ModelState {
  readonly sport: string;
  readonly variant: string;
  readonly cfg: unknown;
  readonly kind: "individual" | "pair" | "team";
  readonly stageKind: string;
  readonly stageConfig: Readonly<Record<string, unknown>>;
  readonly divisionId: string;
  readonly stageId: string;
  readonly tag: string;
  entrants: string[];
  withdrawn: Set<string>;
  started: boolean;
  completed: boolean;
  /** An entrant arrived while the stage already had fixtures (#879's trigger —
   *  pre-Start: Generate, AddEntrant, Generate). Cleared by the event that
   *  re-seats the grown field: an accepted Generate or Rebuild. */
  lateEntry: boolean;
  /** Posts made, for idempotency prefixes unique within the run. */
  posts: number;
  fixtures: Map<string, FixtureModel>;
  generates: GenerateObs[];
  counts: Record<CommandKind, CommandCounts>;
  /** Items each step check judged, summed over steps (R25: a cell owes > 0). */
  stepChecks: Map<string, number>;
  /** Fixtures whose product outcome matched the engine's fold of the known ledger, summed over steps. */
  foldParity: number;
  fenced: Map<string, number>;
  history: string[];
  /** One per step that completed its check, in order. */
  steps: StepRecord[];
  unknowns: UnknownLedger[];
  /** Known product findings met on the way, by id: counted, never a stop. */
  findings: Map<string, { count: number; evidence: string[] }>;
  /** Each team entrant's roster as the product read it back (Task 14); empty on any other kind. */
  rosters: Map<string, readonly EntrantMember[]>;
  /** fixture id → the sides whose lineup the model PUT: ensureLineups'
   *  rec.lineupSides, keyed on fixture AND side (T45-R2). */
  lineupSides: Map<string, Set<string>>;
  /** fixture id → the division entrants it seated when the model posted to
   *  it: decideFixture's rec.teamPosts. Team divisions only. */
  teamPosts: Map<string, string[]>;
  /** Lineups PUT, summed (ensureLineups' rec.lineupsPut). */
  lineupsPut: number;
}

/** The fixture statuses the product reads as VOID — not a meeting, dropped
 *  from the table (lib/fixture-engine-status.ts engineFixtureStatus; pinned by
 *  model-core.test.ts). A void fixture's ad-hoc replay (stages.ts addFixture:
 *  "a replay, a friendly, …") is then the pair's one meeting (carry d). */
export const VOID_STATUSES: readonly string[] = Object.freeze(["abandoned", "cancelled"]);

/** The model's own step check beside I7 (carry c). */
export const ORIENTATION_CHECK = "model-rr-orientation";
/** The stage kinds ORIENTATION_CHECK judges (round robins); on any other it counts nothing. */
export const ORIENTATION_STAGE_KINDS: readonly string[] = Object.freeze(["league", "group"]);
/** A named refusal of a command the model holds legal (ruling I-1). */
export const UNEXPECTED_REFUSAL = "model-unexpected-refusal";
/** A refusal the product did not name (isNamedRefusal: any 5xx, a code-less
 *  or generic-code 4xx) where no known finding explains it. */
export const REFUSAL_NAMED = "model-refusal-named";
/** The roster lock: a latecomer accepted after Start, or a refusal that still changed the roster. */
export const ROSTER_LOCK_CHECK = "model-roster-lock";
/** The roster lock's refusal carries no domain code (entrants.ts: a bare
 *  HttpError(422), which api-v1 stamps "ERROR"). Routed to W9. */
export const ROSTER_LOCK_FINDING = "CD-T13b";
/** A NEXT_MATCH_STARTED refusal named a fed match the model does not hold
 *  (fedCandidates): counted, and the take-back is judged on the model's own
 *  candidates instead (W1c Task 2, ruling Q2). */
export const NEXT_MATCH_UNHELD_FINDING = "model-next-match-unheld";
export const VACUITY_CHECK = "model-informative-steps";
/** T45-R1 (assertions.ts lineupsPut, "life-lineups-put"), on the shared
 *  items (lineup-plan.ts lineupItems): every side of every team fixture the
 *  model posted to had its lineup PUT, one item per side, re-judged after
 *  every step. A team cell owes > 0 (vacuityOf). */
export const LINEUPS_CHECK = "model-lineups-put";
/** The product warned on a lineup the model PUT, and the warning is not the
 *  known side-size finding (the harness's LineupWarned, in the same words). */
export const LINEUP_WARNED_CHECK = "model-lineup-warned";
/** The known side-size finding on its own row (rosters.ts SIDE_SIZE_FOUND,
 *  routed by SIDE_SIZE_ROUTE): counted, never a stop. */
export const LINEUP_SIDE_SIZE_FINDING = "lineup-side-size-warning";
/** A team fixture already past scheduled when the model came to post to it:
 *  the product locks its lineups, so none is PUT (the harness's note). Counted
 *  — and not a stop on its own, but not a pass either: the post still goes
 *  ahead, so the same step's model-lineups-put reds on that fixture's sides,
 *  as the harness's note is followed by life-lineups-put's red (review m-8;
 *  model-core.test.ts drives it through a Score). */
export const LINEUP_LOCKED_FINDING = "model-lineup-past-scheduled";

/** entrants.ts createEntrants: once the division is `active` or `completed`
 *  (Start, then completion) the entrant list is locked with a 422, unless a
 *  stage is an open-window format. Pinned against entrants.ts's text by
 *  model-core.test.ts, so a product change turns the pin red. */
export const ROSTER_LOCK: { readonly status: number; readonly openKinds: readonly string[] } = Object.freeze({
  status: 422,
  openKinds: Object.freeze(["ladder", "americano"]),
});

/** The product refuses an entrant here. The model's single stage is the
 *  division's only stage, and Start is what moves the division to `active`. */
export function rosterLocked(m: ModelState): boolean {
  return m.started && !ROSTER_LOCK.openKinds.includes(m.stageKind);
}

/** A take-back refused under NEXT_MATCH_LOCK that still moved the product's tip. */
export const NEXT_MATCH_CHECK = "model-next-match-lock";

/** fed-seats.ts planRelease, which append-event.ts runs on EVERY append (a
 *  void included), before the first write: a write that changes who a
 *  decision advances is refused, 409 NEXT_MATCH_STARTED, when the fixture it
 *  feeds seats one of its entrants and `!reset && hasStarted(t)` —
 *  hasStarted: `status` not `notStarted`, an outcome, or a live event; reset:
 *  isCascadeWalkover, the walkover the system awarded (`cascade.status`, an
 *  outcome of `cascade.outcomeKind`, no live event), which is put back rather
 *  than refused. Only a bracket has feeds: the engine's BRACKET_STAGE_KINDS,
 *  whose generators are the only ones that emit homeFrom/awayFrom. Pinned
 *  against fed-seats.ts's text by model-core.test.ts. */
export const NEXT_MATCH_LOCK: {
  readonly status: number; readonly code: string; readonly notStarted: string;
  readonly cascade: { readonly status: string; readonly outcomeKind: string }; readonly kinds: readonly string[];
} = Object.freeze({
  status: 409,
  code: "NEXT_MATCH_STARTED",
  notStarted: "scheduled",
  cascade: Object.freeze({ status: "forfeited", outcomeKind: "award" }),
  kinds: Object.freeze([...BRACKET_STAGE_KINDS]),
});

/** The fixtures a take-back of `f` could be refused over. The model sees no
 *  feed edges, so it takes the structural superset: on a bracket kind, every
 *  fixture in a LATER round (every feed runs to a later round_no — engine
 *  bracket.ts through stages.ts bracketToGen, pinned) that seats one of f's
 *  entrants. Whether any of them has STARTED is judged on the driver's
 *  answer when the refusal comes (fedMatchStarted), never on the model's
 *  memory. Empty on a round robin: there the take-back must be accepted.
 *
 *  Given the refusal (W1c Task 2, ruling Q2): the product names the fed match
 *  itself (`next_match`, nextMatchFixtureId). One the model holds is the whole
 *  answer, exactly that fixture; one it does not hold is recorded
 *  (NEXT_MATCH_UNHELD_FINDING) and the superset judged instead; a refusal
 *  naming none leaves the superset as it was. */
export function fedCandidates(m: ModelState, f: FixtureModel, refusal?: RefusedCall): FixtureModel[] {
  const named = refusal === undefined ? null : nextMatchFixtureId(refusal);
  if (named !== null) {
    const held = m.fixtures.get(named);
    if (held !== undefined) return [held];
    recordFinding(m, NEXT_MATCH_UNHELD_FINDING, `product named next match ${named}, which the model does not hold — ${f.id}'s take-back judged on the model's own candidates`);
  }
  const round = f.round;
  if (!NEXT_MATCH_LOCK.kinds.includes(m.stageKind) || round === null) return [];
  const mine = [f.home, f.away].filter((e): e is string => e !== null);
  const holds = (g: FixtureModel) => (g.home !== null && mine.includes(g.home)) || (g.away !== null && mine.includes(g.away));
  return [...m.fixtures.values()].filter((g) => g.round !== null && g.round > round && holds(g));
}

/** fed-seats.ts `!isCascadeWalkover(t) && hasStarted(t)` for one candidate,
 *  on the driver's answer (`st`) and the model's ledger for it. Live events
 *  are known when the product has none at all (last_seq 0), or when the
 *  model's ledger is the product's whole ledger; otherwise, where the answer
 *  turns on them, the candidate is "unverified" — a ledger the model lost is
 *  no evidence either way. */
export function fedMatchStarted(st: FixtureStateOut, ledger: readonly LedgerEntry[] | null): "started" | "not-started" | "unverified" {
  const live = st.last_seq === 0 ? 0 : ledger !== null && ledger.length === st.last_seq ? liveEntries(ledger).length : null;
  const outcome: unknown = st.outcome ?? null;
  if (st.status === NEXT_MATCH_LOCK.cascade.status && (outcome as { kind?: unknown } | null)?.kind === NEXT_MATCH_LOCK.cascade.outcomeKind) {
    if (live === null) return "unverified";
    return live === 0 ? "not-started" : "started";
  }
  if (st.status !== NEXT_MATCH_LOCK.notStarted || outcome !== null) return "started";
  if (live === null) return "unverified";
  return live > 0 ? "started" : "not-started";
}

export function recordFinding(m: ModelState, id: string, line: string): void {
  const f = m.findings.get(id) ?? { count: 0, evidence: [] };
  f.count++;
  if (f.evidence.length < 3) f.evidence.push(line);
  m.findings.set(id, f);
}

/** A ledger the model can no longer fold: counted with its cause, then dropped. */
export function markUnknown(m: ModelState, f: FixtureModel, cause: UnknownLedger["cause"], detail: string): void {
  m.unknowns.push({ cause, fixture: f.id, detail });
  f.ledger = null;
}

/** R25 for a model cell: the number of informative steps, and zero is a
 *  failure — a cell whose every step was refused, expected to be refused, or
 *  left a ledger unknown proved nothing. */
export function informativeSteps(m: ModelState): CheckResult {
  const n = (v: StepVerdict) => m.steps.filter((s) => s.verdict === v).length;
  const informative = n("accepted");
  const reason = `${informative} of ${m.steps.length} steps informative (${n("refused")} refused, ${n("expected-refusal")} expected refusals, ${n("unknown")} unknown)`;
  return {
    id: VACUITY_CHECK, kind: "assertion", verdict: informative > 0 ? "pass" : "fail", checked: informative, reason,
    evidence: informative > 0 ? [] : [`vacuous (R25): ${reason}`, ...m.steps.slice(0, 11).map((s) => `${s.cmd}: ${s.verdict}`)],
  };
}

/** How often one orientation (home→away) of a round-robin pair may meet: each
 *  leg seats the pair once and even legs mirror (engine scheduling/
 *  roundrobin.ts, "even legs mirror (Jul3/08 §2)") — pinned against
 *  generateRoundRobin by model-core.test.ts. Exact at legs 1 and 2 (the
 *  builder's only choices); at legs ≥ 3 a duplicate of the MINORITY
 *  orientation that coincides with a missing majority meeting still nets
 *  inside the bound. */
export function orientationBound(legs: number): number {
  return Math.ceil(legs / 2);
}

type Knobs = Parameters<typeof stagesForRow>[1];

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);

/** D6 (owner ruling 52, amending ruling 49): a row the model does not drive,
 *  routed to the family wave that owns it. Every construction names its wave
 *  as a LITERAL (MODEL_FAMILY below), so the Q-A guard reads each one (PF-3);
 *  the wave is checked against the programme's ids here, as routeTo would. */
export class ModelUnsupported extends Error {
  readonly wave: string;
  readonly reason: string;
  constructor(wave: string, reason: string) {
    if (!WAVE_ID.test(wave)) throw new NotAWave(wave);
    if (reason.trim() === "") throw new Error(`model: a refusal routed to ${wave} needs a reason`);
    super(`model: ${reason} → ${wave}`);
    this.name = "ModelUnsupported";
    this.wave = wave;
    this.reason = reason;
  }
}

const SINGLE = "the model drives single-stage rows";
/** D6's families, one literal wave each (PF-3). The model drives one stage
 *  with a fixed field: a multi-stage row is its family's, and the ladder
 *  family (an open-window roster, rounds the organiser calls) is W7's. */
const roundRobinFamily = (row: string) => new ModelUnsupported("W5", `${row} is multi-stage — a round robin or group stage seeding a later stage; ${SINGLE}`);
const knockoutFamily = (row: string) => new ModelUnsupported("W4", `${row} is multi-stage — a knockout feeding a plate or a main draw; ${SINGLE}`);
const swissFamily = (row: string) => new ModelUnsupported("W3", `${row} is multi-stage — a swiss seeding a playoff or knockout; ${SINGLE}`);
const ladderFamily = (row: string) => new ModelUnsupported("W7", `${row} is an open-window format — its roster never locks and its rounds are the organiser's to call; the model's commands assume a fixed field and a generated schedule`);
const MODEL_FAMILY: Readonly<Record<string, (row: string) => ModelUnsupported>> = Object.freeze({
  league_ko: roundRobinFamily, groups_ko: roundRobinFamily, group_stepladder: roundRobinFamily, group_playoffs: roundRobinFamily, group_group_ko: roundRobinFamily,
  ko_plate: knockoutFamily, qualifying_main: knockoutFamily,
  swiss_playoff: swissFamily, swiss_knockout: swissFamily,
  ladder: ladderFamily, americano: ladderFamily, mexicano: ladderFamily,
});
/** Each model-refused row and the route its refusal carries (D6), read off
 *  MODEL_FAMILY — the one authority. */
export const MODEL_FAMILY_ROUTE: Readonly<Record<string, Route>> = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_FAMILY).map(([row, refuse]) => {
    const e = refuse(row);
    return [row, Object.freeze({ wave: e.wave, why: e.reason })];
  }),
));

/** The refusal for a row the model does not drive, or null for one it does.
 *  Assumptions are guards: a multi-stage row, or an open-window stage
 *  (ROSTER_LOCK.openKinds), that no family routes is a named error — never
 *  admitted, never refused to no wave. */
export function modelRowRefusal(row: RowKey, bodies: readonly StagePostBody[] = stagesForRow(row)): ModelUnsupported | null {
  const family = MODEL_FAMILY[row];
  if (family !== undefined) return family(row);
  if (bodies.length !== 1) throw new Error(`model: ${row} is multi-stage and routes to no family (MODEL_FAMILY_ROUTE) — a new multi-stage row must be routed before the model refuses it`);
  const kind = bodies[0]?.kind ?? "";
  if (ROSTER_LOCK.openKinds.includes(kind)) throw new Error(`model: ${row} builds a ${kind} stage, an open-window format that routes to no family (MODEL_FAMILY_ROUTE) — route it before the model runs it`);
  return null;
}

/** The model's n-th entrant. A team carries its full catalog roster inline
 *  (rosters.ts rosterMembers), as the scenario harness's setUpDivision posts it. */
export function entrantInput(m: { sport: string; cfg: unknown; kind: ModelState["kind"] }, n: number): EntrantInput {
  return m.kind === "team"
    ? { displayName: entrantName(m.kind, n), seed: n, kind: m.kind, members: rosterMembers(m.sport, m.cfg, n) }
    : { displayName: entrantName(m.kind, n), seed: n, kind: m.kind };
}

/** A team entrant's roster as the product stored it — read back, never the
 *  input. One short of the catalog's size would play short: refused by name,
 *  in the scenario harness's own words (common.ts setUpDivision). */
export async function readRoster(d: OrganiserDriver, m: { sport: string; cfg: unknown }, e: EntrantRow): Promise<EntrantMember[]> {
  const size = rosterSize(m.sport, m.cfg);
  const stored = await d.entrantMembers(e.id);
  if (stored.length !== size) throw new Error(`model: entrant ${e.id} (seed ${e.seed ?? "none"}) reads back ${stored.length} roster member(s), ${size} posted — a short roster would play short`);
  return stored;
}

/** A fresh division (not started) with `entrants` entrants on the row's single
 *  stage, built from the builder's own bodies (stagesForRow). A row the model
 *  does not drive is refused by family before any driver call (D6). */
export async function newModelState(input: { driver: OrganiserDriver; row: RowKey; sport: string; variant: string; entrants: number; tag: string; competitionId?: string; knobs?: Knobs }): Promise<ModelState> {
  const bodies = stagesForRow(input.row, input.knobs);
  const refused = modelRowRefusal(input.row, bodies);
  if (refused !== null) throw refused;
  const cfg = resolveSportCfg(input.sport, input.variant);
  const kind = entrantKindFor(input.sport, cfg);
  const who = { sport: input.sport, cfg, kind };
  const d = input.driver;
  const competitionId = input.competitionId ?? (await d.createCompetition({ name: `Matrix model ${input.tag}`, slug: slugOf(`m-${input.tag}`) })).id;
  const division = await d.createDivision(competitionId, { name: `Matrix model ${input.tag}`, slug: slugOf(`d-${input.tag}`), sportKey: input.sport, variantKey: input.variant });
  const [stage] = await d.postStages(division.id, bodies);
  if (stage === undefined) throw new Error("model: postStages answered no stage");
  const added = await d.addEntrants(division.id, Array.from({ length: input.entrants }, (_, i) => entrantInput(who, i + 1)));
  const rosters = new Map<string, readonly EntrantMember[]>();
  if (kind === "team") for (const e of added) rosters.set(e.id, await readRoster(d, who, e));
  const zero = (): CommandCounts => ({ ran: 0, accepted: 0, refused: 0, expected: 0, unexpected: 0 });
  return {
    sport: input.sport, variant: input.variant, cfg, kind, stageKind: stage.kind, stageConfig: stage.config,
    divisionId: division.id, stageId: stage.id, tag: input.tag,
    entrants: added.map((e) => e.id), withdrawn: new Set(), started: false, completed: false, lateEntry: false, posts: 0,
    fixtures: new Map(), generates: [],
    counts: Object.fromEntries(COMMAND_KINDS.map((k) => [k, zero()])) as ModelState["counts"],
    stepChecks: new Map(), foldParity: 0, fenced: new Map(), history: [], steps: [], unknowns: [], findings: new Map(),
    rosters, lineupSides: new Map(), teamPosts: new Map(), lineupsPut: 0,
  };
}

/** The model's sinks for the shared lineup planner: every message a finding,
 *  every unexpected warning a model-lineup-warned violation. An americano
 *  stage cannot reach the model (D6 refuses the ladder family), so a
 *  product-minted pair side is a named refusal here, never a skip. */
function modelLineupSink(m: ModelState): LineupSink {
  return {
    prefix: "model", actor: "model",
    locked: (line) => recordFinding(m, LINEUP_LOCKED_FINDING, line),
    pairSideSkipped: (line) => { throw new Error(`model: ${line} — the model drives no americano stage (D6 refuses the ladder family before any run)`); },
    knownWarning: (line) => recordFinding(m, LINEUP_SIDE_SIZE_FINDING, line),
    warned: (w) => new ModelViolation(LINEUP_WARNED_CHECK, [lineupWarningLine(w.row, w.fixtureId, w.entrantId, w.kind, w.warning)]),
  };
}

/** The scenario harness's lineup rule (lineup-plan.ts putOwedLineups — the
 *  one ensureLineups runs, T14-R3) over the model's own division, ledger and
 *  sinks: each side of `f` gets its lineup PUT once, keyed on fixture AND
 *  side, while `f` is still scheduled, before the model posts to it.
 *  `f.status` is the status the model last read. */
export async function ensureModelLineups(m: ModelState, d: OrganiserDriver, f: FixtureModel): Promise<void> {
  await putOwedLineups(d, {
    sport: m.sport, variant: m.variant, cfg: m.cfg, kind: m.kind, rosterless: false,
    entrantIds: new Set(m.entrants), rosters: m.rosters, stageKindOf: (id) => (id === m.stageId ? m.stageKind : undefined),
  }, m, { id: f.id, stageId: m.stageId, home: f.home, away: f.away, status: f.status }, modelLineupSink(m));
}

/** Folds the product's fixture list into the model. A fixture first seen
 *  scheduled with no result starts with a known empty ledger; one first seen
 *  under way (someone else wrote to it) starts unknown; one gone from the list
 *  (a rebuild) leaves the model. */
export function absorbFixtures(m: ModelState, rows: readonly FixtureRow[]): void {
  const mine = rows.filter((r) => r.stage_id === m.stageId);
  const ids = new Set(mine.map((r) => r.id));
  for (const id of [...m.fixtures.keys()]) if (!ids.has(id)) m.fixtures.delete(id);
  for (const r of mine) {
    const f = m.fixtures.get(r.id);
    if (f === undefined) {
      const known = r.status === "scheduled" && r.outcome === null;
      m.fixtures.set(r.id, { id: r.id, round: r.round_no, home: r.home_entrant_id, away: r.away_entrant_id, status: r.status, ledger: known ? [] : null });
    } else {
      f.round = r.round_no;
      f.status = r.status;
      f.home = r.home_entrant_id;
      f.away = r.away_entrant_id;
    }
  }
}

const toObserved = (r: FixtureRow): ObservedFixture => ({
  id: r.id, stageId: r.stage_id, poolId: r.pool_id, roundNo: r.round_no, home: r.home_entrant_id, away: r.away_entrant_id,
  status: r.status, outcome: toObservedOutcome(r.outcome), declared: null,
});

const add = (m: ModelState, id: string, n: number) => m.stepChecks.set(id, (m.stepChecks.get(id) ?? 0) + n);

/** evaluateInvariant's R25 line (invariants.ts): a spec that PASSED on zero
 *  items. Only that line reads as nothing-to-judge; any other zero-item
 *  failure (no stage observed at all) still fails — fail closed. */
export const R25_ZERO_ITEMS = "checked 0 items (vacuous, R25)";
const nothingToJudgeYet = (c: CheckResult): boolean => c.verdict === "fail" && c.checked === 0 && c.evidence[0] === R25_ZERO_ITEMS;

/** Carry (c): I7 counts meetings per pair, so at legs ≥ 2 a duplicate that
 *  coincides with a missing meeting of the same pair nets to `legs` and
 *  passes. Counting per orientation sees both — the duplicate and the
 *  missing mirror — in one line. League and group stages only. */
function orientationCheck(m: ModelState, meetings: readonly FixtureRow[]): { checked: number; fails: string[] } {
  if (!ORIENTATION_STAGE_KINDS.includes(m.stageKind)) return { checked: 0, fails: [] };
  const legs = typeof m.stageConfig.legs === "number" ? m.stageConfig.legs : 1;
  const bound = orientationBound(legs);
  const seen = new Map<string, string[]>();
  const pairs = new Map<string, [string, string]>();
  for (const r of meetings) {
    if (r.home_entrant_id === null || r.away_entrant_id === null) continue;
    const [h, a] = [r.home_entrant_id, r.away_entrant_id];
    seen.set(`${h}→${a}`, [...(seen.get(`${h}→${a}`) ?? []), r.id]);
    pairs.set(h < a ? `${h}~${a}` : `${a}~${h}`, h < a ? [h, a] : [a, h]);
  }
  const fails: string[] = [];
  for (const [, [x, y]] of [...pairs].sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) {
    for (const [h, a] of [[x, y], [y, x]] as const) {
      const ids = seen.get(`${h}→${a}`) ?? [];
      const mirror = seen.get(`${a}→${h}`) ?? [];
      if (ids.length > bound) fails.push(`${h}→${a} meets ${ids.length}× (at most ${bound} per orientation at legs ${legs}) while ${a}→${h} meets ${mirror.length}×: ${ids.join(", ")}`);
    }
  }
  return { checked: pairs.size, fails: fails.slice(0, 12) };
}

/** assertions.ts lineupsPut's items (lineup-plan.ts lineupItems) over the
 *  model's posts: one per side posted to, ok iff that side's lineup was PUT. */
function lineupsCheck(m: ModelState): { checked: number; fails: string[] } {
  const items = lineupItems(m.teamPosts, m.lineupSides);
  return { checked: items.length, fails: items.filter((i) => !i.ok).map((i) => i.note).slice(0, 12) };
}

/** The engine's fold of a known ledger, or why it refused one. */
function engineOutcome(m: ModelState, home: string, away: string, ledger: readonly LedgerEntry[]): { out: ObservedOutcome | null; refused: string | null } {
  try {
    return { out: toObservedOutcome(foldLedger(m.sport, m.cfg, home, away, ledger)), refused: null };
  } catch (e) {
    return { out: null, refused: e instanceof Error ? e.message : String(e) };
  }
}

export async function checkStep(m: ModelState, d: OrganiserDriver): Promise<void> {
  const rows = await d.listFixtures(m.divisionId);
  absorbFixtures(m, rows);
  const mine = rows.filter((r) => r.stage_id === m.stageId);
  // Carry (d): only a meeting can duplicate a pair. A void fixture is none.
  const meetings = mine.filter((r) => !VOID_STATUSES.includes(r.status));
  const run: ObservedRun = {
    caseId: m.tag,
    facts: [...(m.lateEntry ? (["late_entry"] as const) : []), ...(m.withdrawn.size > 0 ? (["withdrawn"] as const) : [])],
    stages: [{
      id: m.stageId, seq: 1, kind: m.stageKind, config: { ...m.stageConfig }, field: [...m.entrants], fieldSource: "division",
      fixtures: meetings.map(toObserved), standings: [], generates: [...m.generates], pairRounds: [], complete: null,
    }],
    withdrawal: null, configEdit: null,
  };
  for (const c of evaluateStepInvariants(run)) {
    add(m, c.id, c.checked);
    // Nothing to judge YET is an abstain for this step, never a failure: a
    // swiss Start mints its rounds as unpaired shells, so I6 sees no pair
    // until a Generate seats one. The cell's own R25 (vacuityOf) still fails
    // a cell where a step invariant it owes abstained on every step.
    if (nothingToJudgeYet(c)) continue;
    if (c.verdict === "fail") throw new ModelViolation(c.id, c.evidence.length > 0 ? c.evidence : [c.reason]);
  }
  const o = orientationCheck(m, meetings);
  add(m, ORIENTATION_CHECK, o.checked);
  if (o.fails.length > 0) throw new ModelViolation(ORIENTATION_CHECK, o.fails);
  if (m.kind === "team") {
    const l = lineupsCheck(m);
    add(m, LINEUPS_CHECK, l.checked);
    if (l.fails.length > 0) throw new ModelViolation(LINEUPS_CHECK, l.fails);
  }
  for (const r of mine) {
    const f = m.fixtures.get(r.id);
    if (f === undefined || f.ledger === null || f.ledger.length === 0 || r.home_entrant_id === null || r.away_entrant_id === null) continue;
    const want = engineOutcome(m, r.home_entrant_id, r.away_entrant_id, f.ledger);
    const got = toObservedOutcome(r.outcome);
    if (want.refused === null && sameOutcome(want.out, got)) { m.foldParity++; continue; }
    // Events the model did not post (a retry, a cascade) make the ledger
    // unknown, not wrong: re-read the tip before calling it a lie — and count it.
    const st = await d.fixtureState(r.id);
    if (st.last_seq !== f.ledger.length) { markUnknown(m, f, "tip-moved", `product last_seq ${st.last_seq}, model ledger ${f.ledger.length}`); continue; }
    const engine = want.refused === null ? JSON.stringify(want.out) : `a refusal (${want.refused})`;
    throw new ModelViolation("model-fold-parity", [`fixture ${r.id}: product ${JSON.stringify(got)}, engine fold of the ledger ${engine} (${f.ledger.length} events)`]);
  }
}
