// L3 runner: own-DB guard → preflight → ONE sign-in → per case: SQL org +
// plan seeding, the scenario over HttpDriver, the invariants → one redacted
// results.json → MATRIX.md.
//
//   node --experimental-strip-types scripts/matrix/run.ts
//     [--base URL] [--run-id ID] [--report-dir DIR]
//     [--only row|sport] [--scenario KEY]   |   [--canary KEY]   |   [--set NAME]
//
// Exit codes, each with one meaning:
//   0  results written — reds are DATA, not a crash. In canary mode: the
//      canary went red on its OWN check, as designed.
//   1  zero cases (results.json and the MATRIX.md banner are still written),
//      or a canary that did NOT go red on its own check: a harness that
//      cannot see the deliberate break (R17).
//   2  refused, reason on stderr, nothing written: a usage error (unknown
//      flag, a positional, --canary with --only/--scenario, --set with any
//      filter, a run id that is empty or too long once slugged); an unknown
//      filter value (UnknownFilter — checked before anything else, PF13); an
//      unknown --set (UnknownSet) or a planner that refuses to be built (a
//      bound variant case the engine cannot score, BoundVariantUnscorable; a
//      row whose stages cannot be derived, ProbeRowUnderivable);
//      a planner that plants entitlement denies while REDIS_URL is set
//      (RedisHidesDeny, Review Focus 4); no base URL, or one that is not an
//      http(s) URL (BaseNotUrl, FB-1); no own-DB proof
//      (BENCH_EXPECTED_DATA_DIR unset, or a data_directory mismatch at ANY
//      point of the run — an environment fault is never recorded as a
//      product red); a failed preflight; a live builder default that differs
//      from the offline one the committed catalogue assumes
//      (BuilderDefaultDrift, Review Focus 5 — found after sign-in, before any
//      case); a case orgs' plan that does not grant a gate a planned case
//      touches (PlanLacksGate, RR-1 — after the plan read, before any case).
//      BuilderDefaultDrift is an environment refusal, not catalogue
//      drift (gen-catalogue's exit 1): the codes are per CLI, so a wrapper
//      switches on the CLI, never on the code alone.
//   3  aborted after the start gates, reason on stderr: the harness commit,
//      the DB, sign-in, a planning read, a planner that plans a deny it did
//      not declare (UndeclaredDeny), or writeResults refusing a secret
//      (nothing written); or MATRIX.md failing to render (results.json kept,
//      the PF4 summary already printed).
//   (3 also: a crash while the CLI LOADS, before any of its code runs — a
//   strip-types parse error, a missing export, a module that throws — through
//   `pnpm matrix:l3`, whose preload lib/crash-exit.ts maps it; a bare `node …`
//   run exits 1 on one. Final batch F-6.)
// An uncaught throw would exit 1 — the "zero cases" code — and print an
// unredacted stack, so every failure is caught here.
//
// Every line printed passes through redact(), and so does every string that
// reaches results.json (R14a). Never print DATABASE_URL, cookies or links.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { newSession, raw, signIn, type Session } from "../bench/lib/http.ts";
import { createRealPlanSql, provisionPlan } from "../bench/lib/plan.ts";
import { createRealPreflightProbes, runPreflight } from "../bench/lib/env.ts";
import { ROW_KEYS, RowBuildDeferred, SPORT_KEYS, builderDefaultVariant, stagesForRow } from "./lib/catalogue.ts";
import { expectedGates, type GateStage } from "./lib/format-gates-copy.ts";
import { HttpDriver } from "./lib/driver/http-driver.ts";
import { RefusedCall, type OrganiserDriver } from "./lib/driver/types.ts";
import { evaluateInvariants } from "./lib/invariants.ts";
import { isMainModule } from "./lib/main-module.ts";
import { PROBE_SET, probePlanner } from "./lib/probe-set.ts";
import { BaseNotUrl, baseScrubber, redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { decideState, writeResults, type CaseResult, type CheckResult, type RunResults } from "./lib/results.ts";
import { CANARY_MARK } from "./lib/scenarios/assertions.ts";
import { SCENARIOS } from "./lib/scenarios/index.ts";
import { ScenarioUnsupported, type CaseSpec } from "./lib/scenarios/types.ts";
import {
  DataDirMismatch, DataDirUnset, caseOrgSlug, chooseTopPublicPlan, createRealMatrixSql, ownerEmail, prepareCaseOrg, requireOwnDataDir,
} from "./lib/seed-org.ts";
import { resolveSportCfg } from "./lib/sport-cfg.ts";
import { CANARY_CHECK, SLICE_SPORTS, checkCanary, checkSliceFilter, planCanaryCase, planSliceCases } from "./lib/slice.ts";
import { offlineBuilderDefault } from "./lib/variants.ts";

export const EXIT = Object.freeze({ OK: 0, NO_SIGNAL: 1, REFUSED: 2, ABORTED: 3 });

/** A run id names the report directory, the owner's email and every case's
 *  org slug (`m-<id>-<n>`), so it must be slug-safe and short enough that no
 *  slug is ever cut — a cut slug would drop the case number and collide. */
export const RUN_ID_MAX = 40;

export interface RunDb {
  userIdForEmail(email: string): Promise<string>;
  variantKeysInBuilderOrder(sport: string): Promise<string[]>;
  chooseTopPublicPlan(): Promise<string>;
  /** The feature keys `planKey` grants (seed-org.ts MatrixSql.planGrants). */
  planGrants(planKey: string): Promise<readonly string[]>;
  /** `planKey`'s numeric limit for `featureKey`, null = unlimited (seed-org.ts MatrixSql.planLimit). */
  planLimit(planKey: string, featureKey: string): Promise<number | null>;
  dispose(): Promise<void>;
}

export interface RunDeps {
  env: Readonly<Record<string, string | undefined>>;
  harnessCommit(): Promise<string>;
  preflight(base: string): Promise<{ ok: boolean; refusals: { reason: string; detail: string }[] }>;
  openDb(): Promise<RunDb>;
  signIn(base: string, email: string): Promise<Session>;
  /** `deny` (ruling 24): feature keys the case org is denied after provisioning;
   *  `denied` is what was applied, and it is what the scenario judges. */
  prepareCaseOrg(ctx: { base: string; session: Session; userId: string; plan: string }, input: { name: string; slug: string; deny?: readonly string[] }): Promise<{ orgId: string; orgSlug: string; denied: readonly string[] }>;
  driverFor(base: string, session: Session, orgId: string): OrganiserDriver;
  /** MATRIX.md from the results just written (realDeps: renderMatrix). A seam
   *  so the render-failure path is testable without bending shared state. */
  render(results: RunResults): string;
  /** Defaults to `slicePlanner`, or to `SETS[--set]`. */
  planCases?: PlanCases;
}

/** What a planner may read from the command line. */
export interface PlannerCli { only?: string; scenario?: string; canary?: string; set?: string }

/** A case list and the sports whose builder variant order it needs from the DB
 *  (read once each, before planning). W1a carry 4: tests inject one instead of
 *  editing SLICE_ROWS in place. `deniesFeatures` (W1b Task 10): whether any
 *  case it plans carries a `deny` — declared up front, because the Redis
 *  guard must refuse before the DB, and a spec needs the DB's variant order. */
export interface CasePlanner {
  readonly sports: readonly string[];
  readonly deniesFeatures: boolean;
  plan(variantFor: (sport: string) => string): CaseSpec[];
}
export type PlanCases = (cli: PlannerCli) => CasePlanner;

/** A planner asked `variantFor` about a sport it did not declare in `sports`,
 *  so its variant order was never read. Named, so the abort blames the planner
 *  and not the catalogue or the DB (which were never asked). */
export class UndeclaredPlannerSport extends Error {
  readonly sport: string;
  constructor(sport: string, declared: readonly string[]) {
    super(`planner: sport '${sport}' was planned but is not in the planner's sports (declared: ${declared.length === 0 ? "none" : declared.join(", ")}), so its variant order was never read`);
    this.name = "UndeclaredPlannerSport";
    this.sport = sport;
  }
}

export const slicePlanner: PlanCases = (cli) => ({
  sports: SLICE_SPORTS,
  deniesFeatures: false,
  plan: (variantFor) => (cli.canary !== undefined
    ? [planCanaryCase(variantFor, cli.canary)]
    : planSliceCases(variantFor, { only: cli.only, scenario: cli.scenario })),
});

/** The named sets `--set` chooses from. */
export const SETS: Readonly<Record<string, PlanCases>> = Object.freeze({ [PROBE_SET]: probePlanner });

export class UnknownSet extends Error {
  constructor(v: string) {
    super(`matrix: unknown --set '${v}' (allowed: ${Object.keys(SETS).join(", ")})`);
    this.name = "UnknownSet";
  }
}

/** Review Focus 4: lib/entitlements.ts caches through @/lib/cache, which is a
 *  no-op without REDIS_URL. With Redis on, a cached allow (`ent:<org>:*`,
 *  300 s) can hide the SQL deny, and the ⛔ case would read the Pro plan.
 *  Fix round 1, m-2: this proves the HARNESS shell's environment only. The
 *  cache lives in the SERVER process, and no endpoint reports whether it has
 *  REDIS_URL (/api/health answers db only), so a live run must also confirm
 *  the server was started without it (the Task 15 runbook step). */
export class RedisHidesDeny extends Error {
  constructor() {
    super("matrix: this run plants entitlement denies, and REDIS_URL is set in the harness's own environment — lib/entitlements.ts caches through Redis, so a cached allow can hide the deny. Unset REDIS_URL (seazn-local-env: no Redis) and rerun. Note: the server's environment is not visible to this check; start the server without REDIS_URL too.");
    this.name = "RedisHidesDeny";
  }
}

/** Review Focus 5: the committed catalogue (drop list, variant bindings)
 *  assumes the OFFLINE builder default (codepoint order of the titled names);
 *  the live builder orders by the DB collation. Where they differ, every
 *  default-config decision is about the wrong variant. */
export class BuilderDefaultDrift extends Error {
  readonly sport: string;
  constructor(sport: string, live: string, offline: string) {
    super(`matrix: ${sport}: the live builder default is '${live}' but the committed catalogue assumes '${offline}' — the DB collation orders the system variants differently from codepoint order. Fix the ordering or BUILDER_PREFERRED_VARIANT (catalogue.ts); regenerating the catalogue cannot fix it, because the offline default is derived from the engine at run time.`);
    this.name = "BuilderDefaultDrift";
    this.sport = sport;
  }
}

/** One planned case whose gate the case orgs' plan does not grant. */
export interface GateGap { caseId: string; gate: string; path: "allowed" | "denied" }

/** RR-1 (W1b Task 10 fix round 2): the case orgs' plan is chosen by privilege
 *  COUNT (chooseTopPublicPlan), not for holding any gate. An allowed case on a
 *  gated row would read the plan's 402 as a product red; a DENIED case whose
 *  gate the plan lacks would read ⛔ on the plan's 402, not the planted deny's —
 *  a denied case is evidence only when the deny is the sole cause. */
export class PlanLacksGate extends Error {
  readonly plan: string;
  readonly gaps: readonly GateGap[];
  constructor(plan: string, gaps: readonly GateGap[]) {
    const gates = [...new Set(gaps.map((g) => g.gate))].join(", ");
    const why = (g: GateGap) => (g.path === "allowed"
      ? "allowed path: the plan's 402 would read as a product red"
      : "denied path: its refusal would come from the plan, not the deny under test");
    super(`matrix: the case orgs' plan '${plan}' does not grant ${gates} — ${gaps.map((g) => `${g.caseId} (${why(g)})`).join("; ")}`);
    this.name = "PlanLacksGate";
    this.plan = plan;
    this.gaps = gaps;
  }
}

/** Every gate a planned case needs its org's plan to grant: a DENIED case, the
 *  keys its deny removes; any other case, EVERY gate its row's stages fire
 *  (the text-pinned product gate map; final batch FB-7). `stagesOf` exists so
 *  a test can reach a row that fires both — none in today's catalogue does. */
export function gatesNeeded(specs: readonly CaseSpec[], stagesOf: (row: string) => readonly GateStage[] = stagesForRow): GateGap[] {
  const out: GateGap[] = [];
  for (const s of specs) {
    const deny = s.deny ?? [];
    if (deny.length > 0) {
      for (const gate of deny) out.push({ caseId: s.caseId, gate, path: "denied" });
      continue;
    }
    let gates: readonly string[] = [];
    // A row that cannot be derived is not this guard's to judge: the case
    // derives it again in setUpDivision and reds on its own error there.
    try { gates = expectedGates(stagesOf(s.row)); } catch { gates = []; }
    for (const gate of gates) out.push({ caseId: s.caseId, gate, path: "allowed" });
  }
  return out;
}

/** A planner planned a deny it did not declare: the Redis guard (which reads
 *  only the declaration, before the DB) would have been bypassed. */
export class UndeclaredDeny extends Error {
  constructor(caseIds: readonly string[]) {
    super(`planner: ${caseIds.join(", ")} carr${caseIds.length === 1 ? "ies" : "y"} a deny, but the planner declared deniesFeatures false — the REDIS_URL guard never ran`);
    this.name = "UndeclaredDeny";
  }
}

/** The product refusal behind an error red (PF4): what a reader needs to find the call. */
export interface CallRefusal { method: string; path: string; status: number; code: string | null }
export interface ErrorRed { caseId: string; error: string; refusal: CallRefusal | null }
export interface RunSummary { vacuous: string[]; errorReds: ErrorRed[] }

const USAGE = "usage: run.ts [--base URL] [--run-id ID] [--report-dir DIR] [--only row|sport] [--scenario KEY] | [--canary KEY] | [--set NAME]";

const say = (s: string): void => { process.stdout.write(`${redact(s)}\n`); };
const warn = (s: string): void => { process.stderr.write(`${redact(s)}\n`); };
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

interface Cli { base: string | undefined; runId: string; reportDir: string; only: string | undefined; scenario: string | undefined; canary: string | undefined; set: string | undefined }

function parseCli(argv: string[]): Cli | { usage: string } {
  let values: { base?: string; "run-id"?: string; "report-dir"?: string; only?: string; scenario?: string; canary?: string; set?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: {
      base: { type: "string" }, "run-id": { type: "string" }, "report-dir": { type: "string" },
      only: { type: "string" }, scenario: { type: "string" }, canary: { type: "string" }, set: { type: "string" },
    } }));
  } catch (e) {
    return { usage: e instanceof Error ? e.message : String(e) };
  }
  if (values.set !== undefined && (values.only !== undefined || values.scenario !== undefined || values.canary !== undefined)) {
    return { usage: "--set runs a named set; it takes no --only, --scenario or --canary" };
  }
  if (values.canary !== undefined && (values.only !== undefined || values.scenario !== undefined)) {
    return { usage: "--canary runs league|generic alone; it takes no --only or --scenario" };
  }
  const slugged = (values["run-id"] ?? `w1a-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const runId = slugged.length > RUN_ID_MAX ? "" : slugged.replace(/^-+|-+$/g, "");
  if (runId === "") return { usage: `--run-id must slug to 1-${RUN_ID_MAX} characters of [a-z0-9-]` };
  return { base: values.base, runId, reportDir: values["report-dir"] ?? "matrix-report", only: values.only, scenario: values.scenario, canary: values.canary, set: values.set };
}

/** PF4: `vacuous` is every case that is neither an error red nor deferred and
 *  has no applied check over at least one item.
 *  - An error red (decideState's only `error:` reason — a driver or product
 *    refusal) is a finding, not vacuity, so it is listed apart with the
 *    refused call.
 *  - A deferred case (⏳ `later`: ScenarioUnsupported / RowBuildDeferred) is an
 *    honest owner-assigned state naming its wave, not vacuity (controller
 *    ruling, Task 9 fix round 1). */
export function summariseRun(cases: readonly CaseResult[], refusals: ReadonlyMap<string, CallRefusal>): RunSummary {
  const isErrorRed = (c: CaseResult) => c.reason.startsWith("error:");
  return {
    vacuous: cases.filter((c) => c.state !== "later" && !isErrorRed(c) && !c.checks.some((k) => k.verdict !== "abstain" && k.checked > 0)).map((c) => c.caseId),
    errorReds: cases.filter(isErrorRed).map((c) => ({ caseId: c.caseId, error: c.reason.replace(/^error: ?/, ""), refusal: refusals.get(c.caseId) ?? null })),
  };
}

function printSummary(s: RunSummary): void {
  say(`vacuous: ${s.vacuous.length === 0 ? "none" : s.vacuous.join(", ")}`);
  say(`error reds: ${s.errorReds.length === 0 ? "none" : s.errorReds.length}`);
  for (const r of s.errorReds) {
    say(`  error-red ${r.caseId}: ${r.refusal === null ? r.error : `${r.refusal.method} ${r.refusal.path} → ${r.refusal.status} ${r.refusal.code ?? "(no code)"}`}`);
  }
}

/** m-5: how many notes a case keeps. A loop that notes every fixture would
 *  otherwise swell results.json; the count of the rest is kept instead. */
export const NOTES_CAP = 24;

/** m-5: a scenario's notes as a case keeps them — each redacted (R14a),
 *  at most NOTES_CAP, then one line saying how many more there were. */
export function keepNotes(notes: readonly string[]): string[] {
  const kept = notes.slice(0, NOTES_CAP).map((n) => redact(n));
  return notes.length > NOTES_CAP ? [...kept, `… ${notes.length - NOTES_CAP} more note(s) not kept`] : kept;
}

/** PF6: every check is redacted BEFORE it is kept, so one secret-shaped string
 *  never makes writeResults throw the whole run away (it still refuses, as the backstop). */
const redactCheck = (c: CheckResult): CheckResult => ({ ...c, reason: redact(c.reason), evidence: c.evidence.map((x) => redact(x)) });

interface RunCtx { base: string; session: Session; userId: string; plan: string; runId: string }

async function runCase(deps: RunDeps, run: RunCtx, spec: CaseSpec, i: number): Promise<{ result: CaseResult; refusal: CallRefusal | null }> {
  const t0 = Date.now();
  let checks: CheckResult[] = [];
  let deferred: { wave: string; reason: string } | null = null;
  let mandated: string | null = null;
  let error: string | null = null;
  let refusal: CallRefusal | null = null;
  let driver: OrganiserDriver | null = null;
  let counts = { calls: 0, fixtures: 0, events: 0 };
  let notes: string[] = [];
  try {
    const org = await deps.prepareCaseOrg(
      { base: run.base, session: run.session, userId: run.userId, plan: run.plan },
      { name: `Matrix ${run.runId} ${i + 1}`, slug: caseOrgSlug(run.runId, i + 1), deny: spec.deny },
    );
    driver = deps.driverFor(run.base, run.session, org.orgId);
    const scenario = SCENARIOS[spec.scenario];
    // W1b Task 10: a variant case scores under preset + its override, as the
    // division it creates stores it (setUpDivision posts the override).
    const cfg = resolveSportCfg(spec.sport, spec.variant, { ...(spec.overrides ?? {}) });
    const out = await scenario.run({ driver, spec, orgSlug: org.orgSlug, cfg, tag: `${run.runId}-${i + 1}`, denied: org.denied });
    // ⛔ (Task 9): a scenario that builds no stage opts out of the fixture
    // invariants, and one whose expected state is a refusal says so.
    checks = [...(scenario.evaluatesInvariants === false ? [] : evaluateInvariants(out.observed)), ...out.assertions].map(redactCheck);
    mandated = scenario.mandatedRefusal?.(spec) ?? null;
    counts = { calls: driver.callCount, fixtures: out.observed.stages.reduce((n, s) => n + s.fixtures.length, 0), events: out.events };
    notes = keepNotes(out.notes);
  } catch (e) {
    // The DB stopped proving it is ours: that is the environment, not this
    // case. Abort the run rather than record it as a product red.
    if (e instanceof DataDirMismatch || e instanceof DataDirUnset) throw e;
    if (e instanceof ScenarioUnsupported || e instanceof RowBuildDeferred) deferred = { wave: e.wave, reason: e.message };
    else {
      error = errText(e);
      if (e instanceof RefusedCall) refusal = { method: e.method, path: e.path, status: e.status, code: e.code };
    }
    if (driver !== null) counts = { ...counts, calls: driver.callCount };
  }
  const { state, reason } = decideState({ checks, deferred, error, mandated });
  const result: CaseResult = {
    caseId: spec.caseId, row: spec.row, sport: spec.sport, variant: spec.variant, scenario: spec.scenario, canary: spec.canary,
    state, reason: redact(reason), checks, counts, durationMs: Date.now() - t0, notes,
  };
  return { result, refusal };
}

/** m-1: a canary is green only when its case is red on EXACTLY its own check,
 *  and for the deliberately wrong expectation: every failing line of that
 *  check carries CANARY_MARK (withCanary puts the right-answer items first,
 *  so an unmarked failure — the right answer not holding, or nothing to judge
 *  — is never hidden behind the evidence cap). A red on another check, an
 *  error, a vacuous own check, or an own check red for another reason exits 1. */
export function canaryVerdict(key: string, c: CaseResult | undefined): number {
  const want = CANARY_CHECK[checkCanary(key)];
  const failed = (c?.checks ?? []).filter((k) => k.verdict === "fail").map((k) => k.id);
  const own = c?.checks.find((k) => k.id === want);
  const unmarked = own === undefined ? [] : own.evidence.filter((l) => !l.startsWith(CANARY_MARK));
  const ownReason = own === undefined || own.verdict !== "fail" ? null
    : own.evidence.length === 0 ? `; ${want} failed with no evidence: ${own.reason}`
    : unmarked.length > 0 ? `; ${want} failed for another reason: ${unmarked[0]}`
    : null;
  const ok = c?.state === "red" && want !== null && failed.length === 1 && failed[0] === want && own !== undefined && own.evidence.length > 0 && unmarked.length === 0;
  say(ok
    ? `canary ${key}: red on ${want}, as designed`
    : `canary ${key}: did NOT go red on ${want} (failed: ${failed.join(", ") || "none"}; state ${c?.state ?? "none"})${ownReason ?? ""}`);
  return ok ? EXIT.OK : EXIT.NO_SIGNAL;
}

async function execute(deps: RunDeps, cli: Cli, base: string, planner: CasePlanner): Promise<number> {
  const harnessCommit = await deps.harnessCommit(); // before the DB: a failure here costs nothing
  const dir = join(cli.reportDir, cli.runId);
  const owner = ownerEmail(cli.runId);
  const startedAt = new Date().toISOString();
  const cases: CaseResult[] = [];
  const refusals = new Map<string, CallRefusal>();
  const db = await deps.openDb();
  try {
    // LOAD-BEARING (final review gap hunt): the data-dir guard proves the
    // harness's OWN SQL connection, never the server's. That the server at
    // SMOKE_BASE writes the same DB is proven only by these two, each of which
    // fails when it does not:
    //   1. userIdForEmail must find the owner the server's magic-link sign-in
    //      just created (a server on another DB leaves no such row here);
    //   2. every case's switchToCaseOrg (seed-org.ts, the seazn_org cookie)
    //      passes only if the server's membership lookup sees the org this
    //      harness has just inserted through the gated SQL.
    // The sign-in is the one HTTP write before either proof. Switching orgs by
    // any other route (an API token, say) silently drops proof 2 — replace it
    // with an equivalent server-reads-our-write check before doing that.
    const session = await deps.signIn(base, owner); // ONE sign-in per run (single worker)
    const userId = await db.userIdForEmail(owner);
    const plan = await db.chooseTopPublicPlan();
    const order = new Map<string, string[]>();
    for (const s of planner.sports) order.set(s, await db.variantKeysInBuilderOrder(s));
    // Review Focus 5: every declared sport, before any case.
    for (const s of planner.sports) {
      const live = builderDefaultVariant(s, order.get(s) ?? []);
      const offline = offlineBuilderDefault(s);
      if (live !== offline) throw new BuilderDefaultDrift(s, live, offline);
    }
    const variantFor = (s: string) => {
      const keys = order.get(s);
      if (keys === undefined) throw new UndeclaredPlannerSport(s, planner.sports);
      return builderDefaultVariant(s, keys);
    };
    const specs = planner.plan(variantFor);
    const undeclared = planner.deniesFeatures ? [] : specs.filter((s) => (s.deny ?? []).length > 0).map((s) => s.caseId);
    if (undeclared.length > 0) throw new UndeclaredDeny(undeclared);
    // RR-1: before any case's DB work, the plan must grant every gate a case touches.
    const needed = gatesNeeded(specs);
    if (needed.length > 0) {
      const grants = new Set(await db.planGrants(plan));
      const gaps = needed.filter((n) => !grants.has(n.gate));
      if (gaps.length > 0) throw new PlanLacksGate(plan, gaps);
    }
    for (const [i, spec] of specs.entries()) {
      const { result, refusal } = await runCase(deps, { base, session, userId, plan, runId: cli.runId }, spec, i);
      cases.push(result);
      if (refusal !== null) refusals.set(spec.caseId, refusal);
      say(`[${i + 1}/${specs.length}] ${spec.caseId} → ${result.state} ${result.reason}`);
    }
  } finally {
    // A failed close must not throw away the cases that already ran.
    try { await db.dispose(); } catch (e) { warn(`matrix: db dispose failed — ${errText(e)}`); }
  }

  // The grid is snapshotted into the results (T11 review M4), so MATRIX.md
  // renders from results.json alone however the catalogue moves later.
  const grid = { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] };
  // writeResults scans, THEN writes the run's base as LOCAL_BASE (final batch
  // FB-1); MATRIX.md renders what it wrote, so the two files agree.
  const results: RunResults = { schemaVersion: 2, runId: cli.runId, harnessCommit, startedAt, finishedAt: new Date().toISOString(), grid, cases };
  const { path: resultsPath, written } = writeResults(dir, results, base);
  say(`results → ${resultsPath}`);
  if (cli.canary !== undefined) return canaryVerdict(cli.canary, cases[0]);
  // The summary is printed before MATRIX.md is rendered, so a render failure
  // (renderMatrix refuses a case off the run's grid) cannot lose it.
  printSummary(summariseRun(cases, refusals));
  try {
    writeFileSync(join(dir, "MATRIX.md"), deps.render(written));
  } catch (e) {
    warn(`matrix: results.json kept at ${resultsPath}; MATRIX.md failed — ${errText(e)}`);
    return EXIT.ABORTED;
  }
  return cases.length === 0 ? EXIT.NO_SIGNAL : EXIT.OK;
}

export async function runSlice(deps: RunDeps, argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  if ("usage" in cli) { warn(`matrix: ${cli.usage}\n${USAGE}`); return EXIT.REFUSED; }
  // PF13: the keys are static, so a typo is refused before anything touches the DB or the server.
  try {
    if (cli.canary !== undefined) checkCanary(cli.canary);
    else checkSliceFilter({ only: cli.only, scenario: cli.scenario });
  } catch (e) {
    warn(`matrix: ${errText(e)}`);
    return EXIT.REFUSED;
  }
  // W1b Task 10: the planner is chosen — and built — before anything touches
  // the DB or the server: an unknown set and a set that cannot be built are
  // refusals, and whether the run plants denies must be known for the next guard.
  let planner: CasePlanner;
  try {
    // Own keys only: `toString` or `__proto__` would otherwise name a "set".
    if (cli.set !== undefined && !Object.prototype.hasOwnProperty.call(SETS, cli.set)) throw new UnknownSet(cli.set);
    const choose = deps.planCases ?? (cli.set === undefined ? slicePlanner : SETS[cli.set]);
    planner = choose({ only: cli.only, scenario: cli.scenario, canary: cli.canary, set: cli.set });
  } catch (e) {
    warn(`matrix: ${errText(e)}`);
    return EXIT.REFUSED;
  }
  if (planner.deniesFeatures && (deps.env.REDIS_URL ?? "").trim() !== "") { warn(errText(new RedisHidesDeny())); return EXIT.REFUSED; }
  const base = cli.base ?? deps.env.SMOKE_BASE;
  if (!base) { warn("matrix: no --base and no SMOKE_BASE (seazn-local-env `env`)"); return EXIT.REFUSED; }
  // FB-1: the committed writers scrub this base; one that is no URL is refused before anything runs.
  try { baseScrubber(base); } catch (e) { if (!(e instanceof BaseNotUrl)) throw e; warn(`matrix: ${errText(e)}`); return EXIT.REFUSED; }
  // RF3: the own-DB proof is mandatory, and comes before the preflight.
  try { requireOwnDataDir(deps.env); } catch (e) { warn(`matrix: ${errText(e)}`); return EXIT.REFUSED; }
  let pf: Awaited<ReturnType<RunDeps["preflight"]>>;
  try { pf = await deps.preflight(base); } catch (e) { warn(`matrix: preflight: ${errText(e)}`); return EXIT.REFUSED; }
  if (!pf.ok) { for (const r of pf.refusals) warn(`preflight refused: ${r.reason} — ${r.detail}`); return EXIT.REFUSED; }
  try {
    return await execute(deps, cli, base, planner);
  } catch (e) {
    const refused = e instanceof DataDirMismatch || e instanceof DataDirUnset || e instanceof BuilderDefaultDrift || e instanceof PlanLacksGate;
    warn(`matrix: ${refused ? "refused" : "aborted"} — ${errText(e)}`);
    return refused ? EXIT.REFUSED : EXIT.ABORTED;
  }
}

/** Closes every handle, even when one throws, and never throws itself: a
 *  close that threw from a `finally` would leak the other connection and
 *  REPLACE the in-flight error — turning a DataDirMismatch (exit 2, run
 *  refused) into an ordinary case red. Each failure is warned, redacted. */
export async function closeHandles(...handles: readonly { dispose: () => Promise<void> }[]): Promise<void> {
  const settled = await Promise.allSettled(handles.map(async (h) => h.dispose()));
  for (const s of settled) if (s.status === "rejected") warn(`matrix: dispose failed — ${errText(s.reason)}`);
}

/** The two DB handle factories realDeps opens. Injectable only so the unit
 *  suite can witness the open/close wiring without a database. */
export interface DbFactories {
  matrixSql(): ReturnType<typeof createRealMatrixSql>;
  planSql(): ReturnType<typeof createRealPlanSql>;
}

const REAL_DB: DbFactories = {
  // Task 7 M3: NO argument, so it reads the same process.env DATABASE_URL as
  // createRealPlanSql (pinned by run-cli.test.ts).
  matrixSql: () => createRealMatrixSql(),
  planSql: () => createRealPlanSql(),
};

/** Final review m-6: the commit that produced the evidence, and whether the
 *  tree matched it — `<sha>-dirty` when a TRACKED file differs from HEAD, so
 *  evidence never names a commit that did not produce it. Untracked files do
 *  not count (as with `git describe --dirty`): the worktree's own tooling
 *  leaves some, and they are not the harness. */
export function describeCommit(git: (args: string[]) => string): string {
  const sha = git(["rev-parse", "--short", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  return dirty ? `${sha}-dirty` : sha;
}

export function realDeps(dbf: DbFactories = REAL_DB): RunDeps {
  return {
    env: process.env,
    // harnessCommit and openDb do no async work. Each body runs inside a
    // Promise executor, whose throw REJECTS — exactly what the `async` arrow
    // with no `await` did — so a failing git or handle open still reaches the
    // caller as a rejection, never a synchronous throw.
    render: renderMatrix,
    harnessCommit: () => new Promise<string>((resolve) => { resolve(describeCommit((args) => execFileSync("git", args, { encoding: "utf8" }))); }),
    preflight: async (base) => {
      const { probes, dispose } = createRealPreflightProbes();
      try { return await runPreflight(base, probes); } finally { await dispose(); }
    },
    // createRealPlanSql has no data-dir gate of its own. Every plan.ts call
    // follows a gated MatrixSql call: the plan read below waits on
    // listPlanKeys' data_directory proof, and prepareCaseOrg's provision (the
    // plan.ts WRITES) runs only after insertCaseOrg re-proved the DB inside
    // its own transaction.
    openDb: () => new Promise<RunDb>((resolve) => {
      const m = dbf.matrixSql();
      const p = dbf.planSql();
      const db: RunDb = {
        userIdForEmail: (e) => m.sql.userIdForEmail(e),
        variantKeysInBuilderOrder: (s) => m.sql.variantKeysInBuilderOrder(s),
        chooseTopPublicPlan: async () => chooseTopPublicPlan(await p.sql.planCandidateInfo(await m.sql.listPlanKeys())),
        planGrants: (k) => m.sql.planGrants(k),
        planLimit: (k, f) => m.sql.planLimit(k, f),
        dispose: () => closeHandles(m, p),
      };
      resolve(db);
    }),
    signIn: async (base, email) => { const s = newSession(); await signIn(base, s, email); return s; },
    // Per-case connections, opened and closed here: each case's SQL runs on a
    // fresh max:1 client, and its data_directory proof is its own.
    prepareCaseOrg: async (ctx, input) => {
      const m = dbf.matrixSql();
      const p = dbf.planSql();
      try {
        return await prepareCaseOrg({
          sql: m.sql, transport: { raw }, base: ctx.base, session: ctx.session, userId: ctx.userId, plan: ctx.plan,
          provision: (orgId, plan) => provisionPlan({ base: ctx.base, orgId, plan, ownerSession: ctx.session, sql: p.sql }),
        }, input);
      } finally { await closeHandles(m, p); }
    },
    driverFor: (base, session, orgId) => new HttpDriver({ base, session, expectedOrgId: orgId }),
  };
}

export async function main(argv: string[]): Promise<number> {
  return runSlice(realDeps(), argv);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
