// The model the fast-check commands mutate, and the check that runs after
// every command (design §7.5 item 1):
//  - the step-safe invariants (I6, I7, I8 — invariants.ts STEP_INVARIANTS)
//    over what the product shows now, reused unchanged;
//  - the orientation check, which sees the duplicate I7 cannot at legs ≥ 2;
//  - fold parity for every fixture whose whole ledger the model knows;
//  - and, in the commands, every refusal named.
import type { FixtureRow, OrganiserDriver } from "../driver/types.ts";
import { stagesForRow, type RowKey } from "../catalogue.ts";
import { evaluateStepInvariants } from "../invariants.ts";
import { sameOutcome, toObservedOutcome, type GenerateObs, type ObservedFixture, type ObservedOutcome, type ObservedRun } from "../observed.ts";
import { entrantKindFor, resolveSportCfg } from "../sport-cfg.ts";
import { foldLedger, type LedgerEntry } from "./ledger-fold.ts";

export const COMMAND_KINDS = ["Start", "AddEntrant", "Withdraw", "Score", "Walkover", "Void", "Correct", "Generate", "Rebuild", "Complete"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** One fixture as the model knows it. `ledger` is every event the model
 *  posted to it, in order — or null once events the model did not write may
 *  exist (a withdrawal cascade, a refused post, a fixture first seen under
 *  way). Fold parity judges only a known, non-empty ledger. */
export interface FixtureModel { id: string; home: string | null; away: string | null; status: string; ledger: LedgerEntry[] | null }

export class ModelViolation extends Error {
  readonly check: string;
  readonly evidence: string[];
  constructor(check: string, evidence: string[]) {
    super(`${check}: ${evidence.slice(0, 3).join("; ")}`);
    this.name = "ModelViolation";
    this.check = check;
    this.evidence = evidence;
  }
}

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
  /** An entrant was added after Start (#879's trigger). */
  lateEntry: boolean;
  /** Posts made, for idempotency prefixes unique within the run. */
  posts: number;
  fixtures: Map<string, FixtureModel>;
  generates: GenerateObs[];
  counts: Record<CommandKind, { ran: number; accepted: number; refused: number }>;
  /** Items each step check judged, summed over steps (R25: a cell owes > 0). */
  stepChecks: Map<string, number>;
  /** Fixtures whose product outcome matched the engine's fold of the known ledger, summed over steps. */
  foldParity: number;
  fenced: Map<string, number>;
  history: string[];
}

/** The fixture statuses the product reads as VOID — not a meeting, dropped
 *  from the table (lib/fixture-engine-status.ts engineFixtureStatus; pinned by
 *  model-core.test.ts). A void fixture's ad-hoc replay (stages.ts addFixture:
 *  "a replay, a friendly, …") is then the pair's one meeting (carry d). */
export const VOID_STATUSES: readonly string[] = Object.freeze(["abandoned", "cancelled"]);

/** The model's own step check beside I7 (carry c). */
export const ORIENTATION_CHECK = "model-rr-orientation";

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

/** A fresh division (not started) with `entrants` entrants on the row's single
 *  stage, built from the builder's own bodies (stagesForRow). */
export async function newModelState(input: { driver: OrganiserDriver; row: RowKey; sport: string; variant: string; entrants: number; tag: string; competitionId?: string; knobs?: Knobs }): Promise<ModelState> {
  const bodies = stagesForRow(input.row, input.knobs);
  if (bodies.length !== 1) throw new Error(`model: ${input.row} is multi-stage — the model drives single-stage rows (W1a's slice)`);
  const cfg = resolveSportCfg(input.sport, input.variant);
  const kind = entrantKindFor(input.sport, cfg);
  if (kind === "team") throw new Error(`model: ${input.sport} fields teams — rosters are W1-driving`);
  const d = input.driver;
  const competitionId = input.competitionId ?? (await d.createCompetition({ name: `Matrix model ${input.tag}`, slug: slugOf(`m-${input.tag}`) })).id;
  const division = await d.createDivision(competitionId, { name: `Matrix model ${input.tag}`, slug: slugOf(`d-${input.tag}`), sportKey: input.sport, variantKey: input.variant });
  const [stage] = await d.postStages(division.id, bodies);
  if (stage === undefined) throw new Error("model: postStages answered no stage");
  const added = await d.addEntrants(division.id, Array.from({ length: input.entrants }, (_, i) => ({ displayName: `Matrix Player ${i + 1}`, seed: i + 1, kind })));
  const zero = () => ({ ran: 0, accepted: 0, refused: 0 });
  return {
    sport: input.sport, variant: input.variant, cfg, kind, stageKind: stage.kind, stageConfig: stage.config,
    divisionId: division.id, stageId: stage.id, tag: input.tag,
    entrants: added.map((e) => e.id), withdrawn: new Set(), started: false, completed: false, lateEntry: false, posts: 0,
    fixtures: new Map(), generates: [],
    counts: Object.fromEntries(COMMAND_KINDS.map((k) => [k, zero()])) as ModelState["counts"],
    stepChecks: new Map(), foldParity: 0, fenced: new Map(), history: [],
  };
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
      m.fixtures.set(r.id, { id: r.id, home: r.home_entrant_id, away: r.away_entrant_id, status: r.status, ledger: known ? [] : null });
    } else {
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

/** Carry (c): I7 counts meetings per pair, so at legs ≥ 2 a duplicate that
 *  coincides with a missing meeting of the same pair nets to `legs` and
 *  passes. Counting per orientation sees both — the duplicate and the
 *  missing mirror — in one line. League and group stages only. */
function orientationCheck(m: ModelState, meetings: readonly FixtureRow[]): { checked: number; fails: string[] } {
  if (m.stageKind !== "league" && m.stageKind !== "group") return { checked: 0, fails: [] };
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
    if (c.verdict === "fail") throw new ModelViolation(c.id, c.evidence.length > 0 ? c.evidence : [c.reason]);
  }
  const o = orientationCheck(m, meetings);
  add(m, ORIENTATION_CHECK, o.checked);
  if (o.fails.length > 0) throw new ModelViolation(ORIENTATION_CHECK, o.fails);
  for (const r of mine) {
    const f = m.fixtures.get(r.id);
    if (f === undefined || f.ledger === null || f.ledger.length === 0 || r.home_entrant_id === null || r.away_entrant_id === null) continue;
    const want = engineOutcome(m, r.home_entrant_id, r.away_entrant_id, f.ledger);
    const got = toObservedOutcome(r.outcome);
    if (want.refused === null && sameOutcome(want.out, got)) { m.foldParity++; continue; }
    // Events the model did not post (a retry, a cascade) make the ledger
    // unknown, not wrong: re-read the tip before calling it a lie.
    const st = await d.fixtureState(r.id);
    if (st.last_seq !== f.ledger.length) { f.ledger = null; continue; }
    const engine = want.refused === null ? JSON.stringify(want.out) : `a refusal (${want.refused})`;
    throw new ModelViolation("model-fold-parity", [`fixture ${r.id}: product ${JSON.stringify(got)}, engine fold of the ledger ${engine} (${f.ledger.length} events)`]);
  }
}
