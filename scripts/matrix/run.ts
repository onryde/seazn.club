// L3 runner: own-DB guard → preflight → ONE sign-in → per case: SQL org +
// plan seeding, the scenario over HttpDriver, the invariants → one redacted
// results.json → MATRIX.md.
//
//   node --experimental-strip-types scripts/matrix/run.ts
//     [--base URL] [--run-id ID] [--report-dir DIR]
//     [--only row|sport] [--scenario KEY]   |   [--canary KEY]
//
// Exit codes, each with one meaning:
//   0  results written — reds are DATA, not a crash. In canary mode: the
//      canary went red on its OWN check, as designed.
//   1  zero cases (results.json and the MATRIX.md banner are still written),
//      or a canary that did NOT go red on its own check: a harness that
//      cannot see the deliberate break (R17).
//   2  refused, reason on stderr, nothing written: a usage error (unknown
//      flag, a positional, --canary with --only/--scenario, a run id that is
//      empty or too long once slugged); an unknown filter value
//      (UnknownFilter — checked before anything else, PF13); no base URL; no
//      own-DB proof (BENCH_EXPECTED_DATA_DIR unset, or a data_directory
//      mismatch at ANY point of the run — an environment fault is never
//      recorded as a product red); a failed preflight.
//   3  aborted after the start gates, reason on stderr: the harness commit,
//      the DB, sign-in, a planning read, or writeResults refusing a secret
//      (nothing written); or MATRIX.md failing to render (results.json kept,
//      the PF4 summary already printed).
// An uncaught throw would exit 1 — the "zero cases" code — and print an
// unredacted stack, so every failure is caught here.
//
// Every line printed passes through redact(), and so does every string that
// reaches results.json (R14a). Never print DATABASE_URL, cookies or links.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { newSession, raw, signIn, type Session } from "../bench/lib/http.ts";
import { createRealPlanSql, provisionPlan } from "../bench/lib/plan.ts";
import { createRealPreflightProbes, runPreflight } from "../bench/lib/env.ts";
import { RowBuildDeferred, builderDefaultVariant } from "./lib/catalogue.ts";
import { HttpDriver } from "./lib/driver/http-driver.ts";
import { RefusedCall, type OrganiserDriver } from "./lib/driver/types.ts";
import { evaluateInvariants } from "./lib/invariants.ts";
import { redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { decideState, writeResults, type CaseResult, type CheckResult, type RunResults } from "./lib/results.ts";
import { CANARY_MARK } from "./lib/scenarios/assertions.ts";
import { SCENARIOS } from "./lib/scenarios/index.ts";
import { ScenarioUnsupported, type CaseSpec } from "./lib/scenarios/types.ts";
import {
  DataDirMismatch, DataDirUnset, chooseTopPublicPlan, createRealMatrixSql, ownerEmail, prepareCaseOrg, requireOwnDataDir,
} from "./lib/seed-org.ts";
import { resolveSportCfg } from "./lib/sport-cfg.ts";
import { CANARY_CHECK, SLICE_SPORTS, checkCanary, checkSliceFilter, planCanaryCase, planSliceCases } from "./lib/slice.ts";

export const EXIT = Object.freeze({ OK: 0, NO_SIGNAL: 1, REFUSED: 2, ABORTED: 3 });

/** A run id names the report directory, the owner's email and every case's
 *  org slug (`m-<id>-<n>`), so it must be slug-safe and short enough that no
 *  slug is ever cut — a cut slug would drop the case number and collide. */
export const RUN_ID_MAX = 40;

export interface RunDb {
  userIdForEmail(email: string): Promise<string>;
  variantKeysInBuilderOrder(sport: string): Promise<string[]>;
  chooseTopPublicPlan(): Promise<string>;
  dispose(): Promise<void>;
}

export interface RunDeps {
  env: Readonly<Record<string, string | undefined>>;
  harnessCommit(): Promise<string>;
  preflight(base: string): Promise<{ ok: boolean; refusals: { reason: string; detail: string }[] }>;
  openDb(): Promise<RunDb>;
  signIn(base: string, email: string): Promise<Session>;
  prepareCaseOrg(ctx: { base: string; session: Session; userId: string; plan: string }, input: { name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
  driverFor(base: string, session: Session, orgId: string): OrganiserDriver;
}

/** The product refusal behind an error red (PF4): what a reader needs to find the call. */
export interface CallRefusal { method: string; path: string; status: number; code: string | null }
export interface ErrorRed { caseId: string; error: string; refusal: CallRefusal | null }
export interface RunSummary { vacuous: string[]; errorReds: ErrorRed[] }

const USAGE = "usage: run.ts [--base URL] [--run-id ID] [--report-dir DIR] [--only row|sport] [--scenario KEY] | [--canary KEY]";

const say = (s: string): void => { process.stdout.write(`${redact(s)}\n`); };
const warn = (s: string): void => { process.stderr.write(`${redact(s)}\n`); };
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

interface Cli { base: string | undefined; runId: string; reportDir: string; only: string | undefined; scenario: string | undefined; canary: string | undefined }

function parseCli(argv: string[]): Cli | { usage: string } {
  let values: { base?: string; "run-id"?: string; "report-dir"?: string; only?: string; scenario?: string; canary?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: {
      base: { type: "string" }, "run-id": { type: "string" }, "report-dir": { type: "string" },
      only: { type: "string" }, scenario: { type: "string" }, canary: { type: "string" },
    } }));
  } catch (e) {
    return { usage: e instanceof Error ? e.message : String(e) };
  }
  if (values.canary !== undefined && (values.only !== undefined || values.scenario !== undefined)) {
    return { usage: "--canary runs league|generic alone; it takes no --only or --scenario" };
  }
  const slugged = (values["run-id"] ?? `w1a-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const runId = slugged.length > RUN_ID_MAX ? "" : slugged.replace(/^-+|-+$/g, "");
  if (runId === "") return { usage: `--run-id must slug to 1-${RUN_ID_MAX} characters of [a-z0-9-]` };
  return { base: values.base, runId, reportDir: values["report-dir"] ?? "matrix-report", only: values.only, scenario: values.scenario, canary: values.canary };
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

/** PF6: every check is redacted BEFORE it is kept, so one secret-shaped string
 *  never makes writeResults throw the whole run away (it still refuses, as the backstop). */
const redactCheck = (c: CheckResult): CheckResult => ({ ...c, reason: redact(c.reason), evidence: c.evidence.map((x) => redact(x)) });

interface RunCtx { base: string; session: Session; userId: string; plan: string; runId: string }

async function runCase(deps: RunDeps, run: RunCtx, spec: CaseSpec, i: number): Promise<{ result: CaseResult; refusal: CallRefusal | null }> {
  const t0 = Date.now();
  let checks: CheckResult[] = [];
  let deferred: { wave: string; reason: string } | null = null;
  let error: string | null = null;
  let refusal: CallRefusal | null = null;
  let driver: OrganiserDriver | null = null;
  let counts = { calls: 0, fixtures: 0, events: 0 };
  try {
    const org = await deps.prepareCaseOrg(
      { base: run.base, session: run.session, userId: run.userId, plan: run.plan },
      { name: `Matrix ${run.runId} ${i + 1}`, slug: `m-${run.runId}-${i + 1}` },
    );
    driver = deps.driverFor(run.base, run.session, org.orgId);
    const out = await SCENARIOS[spec.scenario].run({ driver, spec, orgSlug: org.orgSlug, cfg: resolveSportCfg(spec.sport, spec.variant), tag: `${run.runId}-${i + 1}` });
    checks = [...evaluateInvariants(out.observed), ...out.assertions].map(redactCheck);
    counts = { calls: driver.callCount, fixtures: out.observed.stages.reduce((n, s) => n + s.fixtures.length, 0), events: out.events };
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
  const { state, reason } = decideState({ checks, deferred, error });
  const result: CaseResult = {
    caseId: spec.caseId, row: spec.row, sport: spec.sport, variant: spec.variant, scenario: spec.scenario, canary: spec.canary,
    state, reason: redact(reason), checks, counts, durationMs: Date.now() - t0,
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

async function execute(deps: RunDeps, cli: Cli, base: string): Promise<number> {
  const harnessCommit = await deps.harnessCommit(); // before the DB: a failure here costs nothing
  const dir = join(cli.reportDir, cli.runId);
  const owner = ownerEmail(cli.runId);
  const startedAt = new Date().toISOString();
  const cases: CaseResult[] = [];
  const refusals = new Map<string, CallRefusal>();
  const db = await deps.openDb();
  try {
    const session = await deps.signIn(base, owner); // ONE sign-in per run (single worker)
    const userId = await db.userIdForEmail(owner);
    const plan = await db.chooseTopPublicPlan();
    const order = new Map<string, string[]>();
    for (const s of SLICE_SPORTS) order.set(s, await db.variantKeysInBuilderOrder(s));
    const variantFor = (s: string) => builderDefaultVariant(s, order.get(s) ?? []);
    const specs = cli.canary !== undefined ? [planCanaryCase(variantFor, cli.canary)] : planSliceCases(variantFor, { only: cli.only, scenario: cli.scenario });
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

  const results: RunResults = { schemaVersion: 1, runId: cli.runId, harnessCommit, startedAt, finishedAt: new Date().toISOString(), cases };
  const resultsPath = writeResults(dir, results);
  say(`results → ${resultsPath}`);
  if (cli.canary !== undefined) return canaryVerdict(cli.canary, cases[0]);
  // The summary is printed before MATRIX.md is rendered, so a render failure
  // (renderMatrix refuses a case off the catalogue grid) cannot lose it.
  printSummary(summariseRun(cases, refusals));
  try {
    writeFileSync(join(dir, "MATRIX.md"), renderMatrix(results));
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
  const base = cli.base ?? deps.env.SMOKE_BASE;
  if (!base) { warn("matrix: no --base and no SMOKE_BASE (seazn-local-env `env`)"); return EXIT.REFUSED; }
  // RF3: the own-DB proof is mandatory, and comes before the preflight.
  try { requireOwnDataDir(deps.env); } catch (e) { warn(`matrix: ${errText(e)}`); return EXIT.REFUSED; }
  let pf: Awaited<ReturnType<RunDeps["preflight"]>>;
  try { pf = await deps.preflight(base); } catch (e) { warn(`matrix: preflight: ${errText(e)}`); return EXIT.REFUSED; }
  if (!pf.ok) { for (const r of pf.refusals) warn(`preflight refused: ${r.reason} — ${r.detail}`); return EXIT.REFUSED; }
  try {
    return await execute(deps, cli, base);
  } catch (e) {
    warn(`matrix: aborted — ${errText(e)}`);
    return e instanceof DataDirMismatch || e instanceof DataDirUnset ? EXIT.REFUSED : EXIT.ABORTED;
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

export function realDeps(dbf: DbFactories = REAL_DB): RunDeps {
  return {
    env: process.env,
    // harnessCommit and openDb do no async work. Each body runs inside a
    // Promise executor, whose throw REJECTS — exactly what the `async` arrow
    // with no `await` did — so a failing git or handle open still reaches the
    // caller as a rejection, never a synchronous throw.
    harnessCommit: () => new Promise<string>((resolve) => { resolve(execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()); }),
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
