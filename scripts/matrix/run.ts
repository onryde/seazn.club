// The runner: own-DB guard → preflight → ONE sign-in → per case: SQL org +
// plan seeding, the scenario over its driver, the invariants → one redacted
// results.json → MATRIX.md. L3 drives HttpDriver; `--driver browser --width W`
// (W1c Task 6) drives each case through the organiser UI in one chromium
// per run and one context per case (BrowserDriver), at width W — recorded as
// W's layer: L1 at 1280, L2 at a phone width (layerOfWidth; T12 fix round 1).
// `--driver browser --layer L1|L2` (W1c Task 12, ruling 39) runs a LAYERED
// plan (lib/layers.ts): L1 is the slice at 1280 only; L2 is the committed
// l2-pairs.json runs, each at its own width — the scripted ones driven, the
// rest recorded 🚫/░ with no driver, org or check. `--set width-sweep` and
// `--set api-only-browser` are layered too. The browser opens at the first
// driven browser case, so a plan that only records opens none.
//
//   pnpm run matrix:l3 --
//     [--base URL] [--run-id ID] [--report-dir DIR]
//     [--only row|sport] [--scenario KEY]   |   [--canary KEY]   |   [--set NAME]
//   pnpm run matrix:browser -- --width W   (the same flags; W one of BROWSER_WIDTHS)
//   pnpm run matrix:browser -- --layer L1|L2 [--only row|sport] [--scenario KEY (L1)]
//
// pnpm 10 passes that `--` through into argv — for matrix:browser AFTER the
// script's own `--driver browser`, so mid-list (measured, W1c Task 6 fix
// round 1) — and parseArgs reads everything after a `--` as a positional.
// parseCli drops every bare `--` (withoutBareDashes), so the `-- …` form above
// and `pnpm matrix:browser --width W` both reach the same flags.
//
// The browser layer is loaded LAZILY (realDeps.openBrowserRun's dynamic
// import), so an L3 run never loads lib/browser (boundary.test.ts pins that
// edge as the only one).
//
// Exit codes, each with one meaning:
//   0  results written — reds are DATA, not a crash. In canary mode: the
//      canary went red on its OWN check, as designed.
//   1  zero cases (results.json and the MATRIX.md banner are still written),
//      or a canary that did NOT go red on its own check: a harness that
//      cannot see the deliberate break (R17).
//   2  refused, reason on stderr, nothing written: a usage error (unknown
//      flag, a positional, --canary with --only/--scenario, --set with any
//      filter, a run id that is empty or too long once slugged; an unknown
//      --driver, --driver browser without --width, a --width outside
//      BROWSER_WIDTHS, or a --width on an http run; --layer other than L1/L2,
//      without --driver browser, beside --set or --canary, L2 with --scenario;
//      a layered plan given any --width but its own — L1 and api-only-browser
//      take 1280 only, L2 and width-sweep none; a layered set over http); a
//      layered plan with no case (NothingPlanned) or with one result id twice
//      (DuplicateCaseId) — both after sign-in, before any case; a run id whose
//      <report-dir>/<run-id>/results.json already exists (RunIdReused, W1c
//      Task 8 E-2 — its evidence is kept, never overwritten); an unknown
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
//      not declare (UndeclaredDeny), no browser for a --driver browser run
//      (openBrowserRun rejects: no chromium; or the served build's hold window
//      is not this shell's, HoldMismatch, or cannot be read, ServedHoldUnreadable
//      — carry M-6, before any case), a case whose browser cannot be
//      set up (BrowserCaseAborted), or writeResults refusing a secret
//      (nothing written); or MATRIX.md failing to render (results.json kept,
//      the PF4 summary already printed).
//   (3 also: a crash while the CLI LOADS, before any of its code runs — a
//   strip-types parse error, a missing export, a module that throws — through
//   `pnpm run matrix:l3`, whose preload lib/crash-exit.ts maps it. Run it only
//   through that script: without the preload a load crash exits 1
//   (cli-invocation.test.ts refuses a documented run that skips it). Final
//   batch F-6, W1b carry e.)
// An uncaught throw would exit 1 — the "zero cases" code — and print an
// unredacted stack, so every failure is caught here.
//
// Every line printed passes through redact(), and so does every string that
// reaches results.json (R14a). Never print DATABASE_URL, cookies or links.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { newSession, raw, signIn, type Session } from "../bench/lib/http.ts";
import { createRealPlanSql, provisionPlan } from "../bench/lib/plan.ts";
import { createRealPreflightProbes, runPreflight } from "../bench/lib/env.ts";
import { ROW_KEYS, RowBuildDeferred, SPORT_KEYS, builderDefaultVariant, stagesForRow } from "./lib/catalogue.ts";
import { expectedGates, type GateStage } from "./lib/format-gates-copy.ts";
import { HttpDriver } from "./lib/driver/http-driver.ts";
import { NoOrganiserPath, RefusedCall, type OrganiserDriver } from "./lib/driver/types.ts";
import { evaluateInvariants } from "./lib/invariants.ts";
import { isMainModule } from "./lib/main-module.ts";
import {
  API_ONLY_BROWSER_SET, LAYER_PLANNERS, WIDTH_SWEEP_SET, apiOnlyBrowserPlanner, atWidth, identityOf, layerCaseId, layerOfWidth, widthSweepPlanner,
  type LayerCase, type PlannedLayerCase,
} from "./lib/layers.ts";
import { PAD_PROOF_SET, padProofPlanner } from "./lib/pad-proof-set.ts";
import { PROBE_SET, probePlanner } from "./lib/probe-set.ts";
import { BaseNotUrl, baseScrubber, redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { decideState, writeResults, type CaseResult, type CheckResult, type Layer, type RunResults } from "./lib/results.ts";
import { CANARY_MARK } from "./lib/scenarios/assertions.ts";
import { SCENARIOS } from "./lib/scenarios/index.ts";
import { ScenarioUnsupported, type CaseSpec } from "./lib/scenarios/types.ts";
import {
  DataDirMismatch, DataDirUnset, caseOrgSlug, chooseTopPublicPlan, createRealMatrixSql, ownerEmail, prepareCaseOrg, requireOwnDataDir,
} from "./lib/seed-org.ts";
import { resolveSportCfg } from "./lib/sport-cfg.ts";
import { CANARY_CHECK, SLICE_SPORTS, checkCanary, checkSliceFilter, planCanaryCase, planSliceCases } from "./lib/slice.ts";
import { offlineBuilderDefault } from "./lib/variants.ts";
import { BROWSER_WIDTHS, type BrowserWidth } from "./lib/widths.ts";

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
  /** Defaults to `slicePlanner`, or to `SETS[--set]`, or to the `--layer`'s planner. */
  planCases?: PlanCases | PlanLayers;
  /** The run's browser, for `--driver browser` (W1c Task 6). realDeps loads
   *  lib/browser/browser-run.ts lazily here; a runner without one aborts a
   *  browser run. `base` is the run's own: the hold preflight reads the build
   *  served there (carry M-6). */
  openBrowserRun?(base: string): Promise<BrowserRun>;
}

/** What a case's browser driver is built from. `reportDir` is the run's own
 *  report directory (the case's pictures go under it); `evidenceId` names the
 *  case's shots directory — a plain segment, since a caseId carries `|`. */
export interface CaseDriverOptions {
  base: string;
  session: Session;
  orgId: string;
  orgSlug: string;
  spec: CaseSpec;
  width: BrowserWidth;
  padPolicy: "first" | "all";
  reportDir: string;
  evidenceId: string;
}
/** One case's driver and the close that releases its browser context. */
export interface CaseBrowserDriver { driver: OrganiserDriver & { checks(): CheckResult[] }; close(): Promise<void> }
/** One browser per run: a driver per case, then one close. */
export interface BrowserRun {
  caseDriver(o: CaseDriverOptions): Promise<CaseBrowserDriver>;
  close(): Promise<void>;
}

/** A case whose browser could not be set up (no context, a refused cookie):
 *  the environment, never a product red — the run aborts. */
export class BrowserCaseAborted extends Error {
  constructor(caseId: string, cause: unknown) {
    super(`matrix: case ${caseId}: its browser could not be set up — ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
    this.name = "BrowserCaseAborted";
  }
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
  /** W1c Task 7: the set scores on the pad, so it runs under --driver browser
   *  only; runSlice refuses it over HTTP before the DB. Default false. */
  readonly needsBrowser?: boolean;
  plan(variantFor: (sport: string) => string): CaseSpec[];
}
export type PlanCases = (cli: PlannerCli) => CasePlanner;

/** W1c Task 12: a planner that places every case itself — its layer, its
 *  browser width, and whether it is DRIVEN or PLANNED 🚫/░ (recorded without
 *  a driver, an org or a check). `--layer L1|L2` and the layered sets build
 *  one; it runs under --driver browser only. lib/layers.ts. */
export interface LayeredPlanner {
  readonly sports: readonly string[];
  readonly deniesFeatures: boolean;
  /** The run's layer (results.json's run-level `layer`). */
  readonly layer: "L1" | "L2";
  /** How the command line chose it, for its refusals: "--layer L1", "--set width-sweep". */
  readonly label: string;
  /** The one --width it accepts — its own, ruling 39's 1280 for an L1 plan —
   *  or null: it sets each case's width, and every --width is refused. */
  readonly acceptsWidth: BrowserWidth | null;
  layered(variantFor: (sport: string) => string): LayerCase[];
}
export type PlanLayers = (cli: PlannerCli) => LayeredPlanner;
const isLayered = (p: CasePlanner | LayeredPlanner): p is LayeredPlanner => "layered" in p;

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
export const SETS: Readonly<Record<string, PlanCases | PlanLayers>> = Object.freeze({
  [PROBE_SET]: probePlanner, [PAD_PROOF_SET]: padProofPlanner,
  // W1c Task 12 (ruling 39 / D7): layered — each places its own widths.
  [WIDTH_SWEEP_SET]: widthSweepPlanner, [API_ONLY_BROWSER_SET]: apiOnlyBrowserPlanner,
});

export class UnknownSet extends Error {
  constructor(v: string) {
    super(`matrix: unknown --set '${v}' (allowed: ${Object.keys(SETS).join(", ")})`);
    this.name = "UnknownSet";
  }
}

/** W1c Task 8 review E-2: a run id names its evidence directory
 *  (<report-dir>/<run-id>/, which writeResults and MATRIX.md overwrite
 *  unconditionally) AND every case org's slug (seed-org.ts caseOrgSlug). A
 *  run under a finished run's id would destroy that run's results and red
 *  every case on a duplicate slug — so a results.json already there refuses
 *  the run before anything else touches the DB or the server. */
export class RunIdReused extends Error {
  readonly runId: string;
  readonly path: string;
  constructor(runId: string, path: string) {
    super(`run id ${runId} already has results at ${path} — a run under it would overwrite that evidence (results.json, MATRIX.md) and red every case on the case-org slugs its id derives; pass a fresh --run-id`);
    this.name = "RunIdReused";
    this.runId = runId;
    this.path = path;
  }
}

/** W1c Task 12: a layered plan with no case at all (`--layer L2 --only` a cell
 *  with no committed run). A layer that runs nothing must never read as a run,
 *  so it is refused (exit 2) and nothing is written. */
export class NothingPlanned extends Error {
  constructor(label: string) {
    super(`${label}: nothing planned — the plan holds no case (driven or recorded), so there is no run to write`);
    this.name = "NothingPlanned";
  }
}

/** W1c Task 12: a layered plan names one result id twice. results.json,
 *  MATRIX.md and parity key every case by its id, so one would hide the other. */
export class DuplicateCaseId extends Error {
  readonly ids: readonly string[];
  constructor(label: string, ids: readonly string[]) {
    super(`${label} plans ${ids.join(", ")} more than once — every case is keyed by its id, so one would hide the other`);
    this.name = "DuplicateCaseId";
    this.ids = ids;
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

const USAGE = `usage: run.ts [--base URL] [--run-id ID] [--report-dir DIR] [--driver http|browser] [--width ${BROWSER_WIDTHS.join("|")}] [--layer L1|L2] [--only row|sport] [--scenario KEY] | [--canary KEY] | [--set NAME]`;

const say = (s: string): void => { process.stdout.write(`${redact(s)}\n`); };
const warn = (s: string): void => { process.stderr.write(`${redact(s)}\n`); };
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** `driver` and `widthArg` (W1c Task 6), `layer` (Task 12). The width is
 *  kept as typed until the plan is chosen: a plain browser run needs one
 *  (resolved by plainBrowserWidth), a layered plan sets its own and refuses
 *  any other (layeredWidthRefusal). */
interface Cli { base: string | undefined; runId: string; reportDir: string; only: string | undefined; scenario: string | undefined; canary: string | undefined; set: string | undefined; driver: "http" | "browser"; layer: "L1" | "L2" | undefined; widthArg: string | undefined }

/** The driver the command line asked for, or the usage refusal. A width is a
 *  browser run's only. */
function parseDriver(driver: string | undefined, width: string | undefined): { driver: "http" | "browser" } | { usage: string } {
  const d = driver ?? "http";
  if (d !== "http" && d !== "browser") return { usage: `--driver must be http or browser, got ${d}` };
  if (d === "http" && width !== undefined) return { usage: "--width is a browser run's width; it takes --driver browser" };
  return { driver: d };
}

/** A plain (unlayered) browser run's one width: required, one of BROWSER_WIDTHS. */
function plainBrowserWidth(width: string | undefined): { width: BrowserWidth } | { usage: string } {
  if (width === undefined) return { usage: `--driver browser needs --width (one of ${BROWSER_WIDTHS.join(", ")})` };
  // Digits only: Number("") is 0 and Number(" 320") is 320 — neither was asked for.
  const w = /^\d+$/.test(width) ? BROWSER_WIDTHS.find((x) => x === Number(width)) : undefined;
  if (w === undefined) return { usage: `--width must be one of ${BROWSER_WIDTHS.join(", ")}, got ${width}` };
  return { width: w };
}

/** A layered plan sets every case's width (ruling 39: L1 at 1280 only; L2
 *  from l2-pairs.json; the sets their own), so a --width is only ever the
 *  plan's own, typed exactly — anything else is refused by name. */
function layeredWidthRefusal(p: LayeredPlanner, width: string | undefined): string | null {
  if (width === undefined) return null;
  if (p.acceptsWidth !== null && width === String(p.acceptsWidth)) return null;
  return p.acceptsWidth !== null
    ? `${p.label} runs at ${p.acceptsWidth} only (ruling 39); got --width ${width}`
    : `${p.label} takes no --width (the plan sets each case's width); got --width ${width}`;
}

/** The argv parseCli reads: every bare `--` dropped (pnpm 10 forwards the one
 *  in `pnpm run <script> -- <flags>`, mid-list for a script that carries flags
 *  of its own). Nothing is lost: this runner takes no positional, and a bare
 *  `--` is never a flag's value (parseArgs refuses `--run-id --` as ambiguous
 *  with or without it; `--run-id=--` is one token and is kept). */
export function withoutBareDashes(argv: readonly string[]): string[] {
  return argv.filter((a) => a !== "--");
}

function parseCli(argv: string[]): Cli | { usage: string } {
  let values: { base?: string; "run-id"?: string; "report-dir"?: string; only?: string; scenario?: string; canary?: string; set?: string; driver?: string; width?: string; layer?: string };
  try {
    ({ values } = parseArgs({ args: withoutBareDashes(argv), options: {
      base: { type: "string" }, "run-id": { type: "string" }, "report-dir": { type: "string" },
      only: { type: "string" }, scenario: { type: "string" }, canary: { type: "string" }, set: { type: "string" },
      driver: { type: "string" }, width: { type: "string" }, layer: { type: "string" },
    } }));
  } catch (e) {
    return { usage: e instanceof Error ? e.message : String(e) };
  }
  const how = parseDriver(values.driver, values.width);
  if ("usage" in how) return how;
  // W1c Task 12: --layer chooses the plan, and it is a browser plan.
  let layer: Cli["layer"];
  if (values.layer !== undefined) {
    if (values.layer !== "L1" && values.layer !== "L2") return { usage: `--layer must be L1 or L2, got ${values.layer}` };
    if (how.driver !== "browser") return { usage: "--layer runs a browser layer; it takes --driver browser" };
    if (values.set !== undefined) return { usage: "--layer and --set each choose the plan; pass one" };
    if (values.canary !== undefined) return { usage: "--layer takes no --canary" };
    if (values.layer === "L2" && values.scenario !== undefined) return { usage: "--layer L2 plans the committed l2-pairs.json runs; it takes no --scenario" };
    layer = values.layer;
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
  return { base: values.base, runId, reportDir: values["report-dir"] ?? "matrix-report", only: values.only, scenario: values.scenario, canary: values.canary, set: values.set, driver: how.driver, layer, widthArg: values.width };
}

/** PF4: `vacuous` is every case that is neither an error red nor deferred and
 *  has no applied check over at least one item.
 *  - An error red (decideState's only `error:` reason — a driver or product
 *    refusal) is a finding, not vacuity, so it is listed apart with the
 *    refused call.
 *  - A deferred case (⏳ `later`: ScenarioUnsupported / RowBuildDeferred) is an
 *    honest owner-assigned state naming its wave, not vacuity (controller
 *    ruling, Task 9 fix round 1) — and so is 🚫 `no_path` (NoOrganiserPath,
 *    W1c Task 6 M-4 ruling). */
export function summariseRun(cases: readonly CaseResult[], refusals: ReadonlyMap<string, CallRefusal>): RunSummary {
  const isErrorRed = (c: CaseResult) => c.reason.startsWith("error:");
  // W1c Task 12: ░ not_run is a planned case no script runs yet — honest, not vacuous.
  const deferred = (c: CaseResult) => c.state === "later" || c.state === "no_path" || c.state === "not_run";
  return {
    vacuous: cases.filter((c) => !deferred(c) && !isErrorRed(c) && !c.checks.some((k) => k.verdict !== "abstain" && k.checked > 0)).map((c) => c.caseId),
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

/** `reportDir`: the run's own report directory. */
interface RunCtx { base: string; session: Session; userId: string; plan: string; runId: string; reportDir: string }

/** One case the runner DRIVES: its spec, the layer it records, and its browser
 *  and width — null over HTTP. A plain run gives every case the CLI's width
 *  (D9); a layered plan gives each its own (W1c Task 12). */
interface DrivenCase { spec: CaseSpec; layer: Layer; browser: { run: BrowserRun; width: BrowserWidth } | null }

async function runCase(deps: RunDeps, run: RunCtx, item: DrivenCase, i: number): Promise<{ result: CaseResult; refusal: CallRefusal | null }> {
  const { spec } = item;
  const t0 = Date.now();
  let checks: CheckResult[] = [];
  let deferred: { wave: string; reason: string } | null = null;
  let mandated: string | null = null;
  let error: string | null = null;
  let noPath: { wave: string; reason: string } | null = null;
  let refusal: CallRefusal | null = null;
  let driver: OrganiserDriver | null = null;
  let caseBrowser: CaseBrowserDriver | null = null;
  let counts = { calls: 0, fixtures: 0, events: 0 };
  let notes: string[] = [];
  try {
    const org = await deps.prepareCaseOrg(
      { base: run.base, session: run.session, userId: run.userId, plan: run.plan },
      { name: `Matrix ${run.runId} ${i + 1}`, slug: caseOrgSlug(run.runId, i + 1), deny: spec.deny },
    );
    const scenario = SCENARIOS[spec.scenario];
    if (item.browser === null) {
      driver = deps.driverFor(run.base, run.session, org.orgId);
    } else {
      // After the org switch, so the context carries the case org's cookie.
      // The scenario says which scores go to the pad (W1c Task 7; default "first").
      const o: CaseDriverOptions = { base: run.base, session: run.session, orgId: org.orgId, orgSlug: org.orgSlug, spec, width: item.browser.width, padPolicy: scenario.padPolicy ?? "first", reportDir: run.reportDir, evidenceId: `case-${i + 1}` };
      try { caseBrowser = await item.browser.run.caseDriver(o); } catch (e) { throw new BrowserCaseAborted(spec.caseId, e); }
      driver = caseBrowser.driver;
    }
    // W1b Task 10: a variant case scores under preset + its override, as the
    // division it creates stores it (setUpDivision posts the override).
    const cfg = resolveSportCfg(spec.sport, spec.variant, { ...(spec.overrides ?? {}) });
    const out = await scenario.run({ driver, spec, orgSlug: org.orgSlug, cfg, tag: `${run.runId}-${i + 1}`, denied: org.denied });
    // ⛔ (Task 9): a scenario that builds no stage opts out of the fixture
    // invariants, and one whose expected state is a refusal says so. A
    // browser case adds its driver's own checks after them (W1c Task 6).
    checks = [
      ...(scenario.evaluatesInvariants === false ? [] : evaluateInvariants(out.observed)), ...out.assertions,
      ...(caseBrowser === null ? [] : caseBrowser.driver.checks()),
    ].map(redactCheck);
    mandated = scenario.mandatedRefusal?.(spec) ?? null;
    counts = { calls: driver.callCount, fixtures: out.observed.stages.reduce((n, s) => n + s.fixtures.length, 0), events: out.events };
    notes = keepNotes(out.notes);
  } catch (e) {
    // The DB stopped proving it is ours, or the case's browser could not be
    // set up: that is the environment, not this case. Abort the run rather
    // than record it as a product red.
    if (e instanceof DataDirMismatch || e instanceof DataDirUnset || e instanceof BrowserCaseAborted) throw e;
    if (e instanceof ScenarioUnsupported || e instanceof RowBuildDeferred) deferred = { wave: e.wave, reason: e.message };
    // M-4 ruling: a path this layer does not drive is 🚫 naming its wave, never an error red.
    else if (e instanceof NoOrganiserPath) noPath = { wave: e.wave, reason: e.reason };
    else {
      error = errText(e);
      if (e instanceof RefusedCall) refusal = { method: e.method, path: e.path, status: e.status, code: e.code };
    }
    if (driver !== null) counts = { ...counts, calls: driver.callCount };
    // M-2: a thrown case keeps what its browser driver recorded before the
    // throw (its screenshots' checks among them); reading them must not
    // replace the case's own outcome. N-3 (W1c Task 12): an ERROR red only —
    // a ⏳ or 🚫 case is deferred, and a deferred row carries no check (it
    // would read "2/2 checks applied" on a case nothing judged).
    if (caseBrowser !== null && error !== null) {
      try { checks = caseBrowser.driver.checks().map(redactCheck); } catch (k) { warn(`matrix: case ${spec.caseId}: its driver's checks could not be read — ${errText(k)}`); }
    }
  } finally {
    // Every case's context is closed, whatever the scenario did; a failed
    // close is warned, never allowed to replace the case's own outcome.
    if (caseBrowser !== null) {
      try { await caseBrowser.close(); } catch (e) { warn(`matrix: case ${spec.caseId}: closing its browser failed — ${errText(e)}`); }
    }
  }
  const { state, reason } = decideState({ checks, deferred, error, mandated, noPath });
  const b = item.browser;
  const result: CaseResult = {
    caseId: atWidth(spec.caseId, b === null ? null : b.width), row: spec.row, sport: spec.sport, variant: spec.variant, scenario: spec.scenario, canary: spec.canary,
    state, reason: redact(reason), checks, counts, durationMs: Date.now() - t0, notes,
    // D9: the layer, driver and width the case ran at.
    ...(b === null ? { layer: item.layer, driver: "http", width: null } as const : { layer: item.layer, driver: "browser", width: b.width } as const),
  };
  return { result, refusal };
}

/** W1c Task 12: a layered plan's 🚫/░ case, recorded as its state — no
 *  driver, no org, no check (N-3), zero counts — so it reaches results.json
 *  and MATRIX.md and is never dropped (R13). */
function recordPlanned(c: PlannedLayerCase): CaseResult {
  const id = identityOf(c);
  const { state, reason } = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
  return {
    caseId: layerCaseId(c), row: id.row, sport: id.sport, variant: id.variant, scenario: id.scenario, canary: false,
    state, reason: redact(reason), checks: [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [],
    layer: c.layer, driver: "browser", width: c.width,
  };
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

/** One item of a run, in plan order: a case the runner drives at its layer
 *  and width (null over HTTP), or a layered plan's 🚫/░ case, recorded. */
type RunItem =
  | { readonly kind: "driven"; readonly spec: CaseSpec; readonly layer: Layer; readonly width: BrowserWidth | null }
  | { readonly kind: "planned"; readonly case: PlannedLayerCase };

/** A plain plan's specs all run at the CLI's width (null over HTTP; D9); a
 *  layered plan places each of its cases itself. */
function runItems(planner: CasePlanner | LayeredPlanner, variantFor: (sport: string) => string, width: BrowserWidth | null): RunItem[] {
  if (!isLayered(planner)) return planner.plan(variantFor).map((spec) => ({ kind: "driven", spec, layer: width === null ? "L3" : layerOfWidth(width), width }));
  const items = planner.layered(variantFor).map((c: LayerCase): RunItem => (c.spec !== null ? { kind: "driven", spec: c.spec, layer: c.layer, width: c.width } : { kind: "planned", case: c }));
  if (items.length === 0) throw new NothingPlanned(planner.label);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of items.map(itemId)) (seen.has(id) ? dupes : seen).add(id);
  if (dupes.size > 0) throw new DuplicateCaseId(planner.label, [...dupes]);
  return items;
}

/** The id the item's result is keyed by (results.json, MATRIX.md, parity). */
const itemId = (it: RunItem): string => (it.kind === "planned" ? layerCaseId(it.case) : atWidth(it.spec.caseId, it.width));

async function execute(deps: RunDeps, cli: Cli, base: string, planner: CasePlanner | LayeredPlanner, width: BrowserWidth | null): Promise<number> {
  const harnessCommit = await deps.harnessCommit(); // before the DB: a failure here costs nothing
  const dir = join(cli.reportDir, cli.runId);
  const owner = ownerEmail(cli.runId);
  const startedAt = new Date().toISOString();
  const cases: CaseResult[] = [];
  const refusals = new Map<string, CallRefusal>();
  // A holder, not a `let`: it is opened inside browserFor, and the `finally`
  // must see that (a `let` assigned only in a closure narrows to null there).
  const opened: { run: BrowserRun | null } = { run: null };
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
    const items = runItems(planner, variantFor, width);
    const specs = items.flatMap((it) => (it.kind === "driven" ? [it.spec] : []));
    const undeclared = planner.deniesFeatures ? [] : specs.filter((s) => (s.deny ?? []).length > 0).map((s) => s.caseId);
    if (undeclared.length > 0) throw new UndeclaredDeny(undeclared);
    // RR-1: before any case's DB work, the plan must grant every gate a case touches.
    const needed = gatesNeeded(specs);
    if (needed.length > 0) {
      const grants = new Set(await db.planGrants(plan));
      const gaps = needed.filter((n) => !grants.has(n.gate));
      if (gaps.length > 0) throw new PlanLacksGate(plan, gaps);
    }
    // W1c Task 6: one browser per run, opened after every start gate has
    // passed. No browser is the environment: the run aborts, and no case is
    // ever recorded as a product red for it. Task 12: opened at the first
    // DRIVEN browser case, so a plan that records only 🚫/░ opens none.
    const browserFor = async (): Promise<BrowserRun> => {
      if (opened.run === null) {
        if (deps.openBrowserRun === undefined) throw new Error("matrix: --driver browser, and this runner has no browser (RunDeps.openBrowserRun)");
        opened.run = await deps.openBrowserRun(base);
      }
      return opened.run;
    };
    const ctx: RunCtx = { base, session, userId, plan, runId: cli.runId, reportDir: dir };
    for (const [i, item] of items.entries()) {
      let result: CaseResult;
      if (item.kind === "planned") {
        result = recordPlanned(item.case);
      } else {
        // Outside runCase's try: a browser that cannot open aborts the run (above).
        const browser = item.width === null ? null : { run: await browserFor(), width: item.width };
        const ran = await runCase(deps, ctx, { spec: item.spec, layer: item.layer, browser }, i);
        result = ran.result;
        if (ran.refusal !== null) refusals.set(result.caseId, ran.refusal);
      }
      cases.push(result);
      say(`[${i + 1}/${items.length}] ${result.caseId} → ${result.state} ${result.reason}`);
    }
  } finally {
    // A failed close must not throw away the cases that already ran. The
    // browser is closed exactly once, after the last case or the abort.
    if (opened.run !== null) {
      try { await opened.run.close(); } catch (e) { warn(`matrix: browser close failed — ${errText(e)}`); }
    }
    try { await db.dispose(); } catch (e) { warn(`matrix: db dispose failed — ${errText(e)}`); }
  }

  // The grid is snapshotted into the results (T11 review M4), so MATRIX.md
  // renders from results.json alone however the catalogue moves later.
  const grid = { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] };
  // writeResults scans, THEN writes the run's base as LOCAL_BASE (final batch
  // FB-1); MATRIX.md renders what it wrote, so the two files agree.
  const results: RunResults = {
    schemaVersion: 3, runId: cli.runId, harnessCommit, startedAt, finishedAt: new Date().toISOString(), grid,
    // A layered plan names its layer; a plain one is its width's (layerOfWidth:
    // 1280 L1, a phone width L2), L3 over HTTP.
    layer: isLayered(planner) ? planner.layer : width === null ? "L3" : layerOfWidth(width), driver: cli.driver, cases,
  };
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
  let planner: CasePlanner | LayeredPlanner;
  try {
    // Own keys only: `toString` or `__proto__` would otherwise name a "set".
    if (cli.set !== undefined && !Object.prototype.hasOwnProperty.call(SETS, cli.set)) throw new UnknownSet(cli.set);
    // W1c Task 12: --layer chooses a layered plan (parseCli refused it beside --set).
    const choose = deps.planCases ?? (cli.layer !== undefined ? LAYER_PLANNERS[cli.layer] : cli.set === undefined ? slicePlanner : SETS[cli.set]);
    planner = choose({ only: cli.only, scenario: cli.scenario, canary: cli.canary, set: cli.set });
  } catch (e) {
    warn(`matrix: ${errText(e)}`);
    return EXIT.REFUSED;
  }
  // The width, once the plan is known (ruling 39): a layered plan places its
  // cases and refuses any --width but its own; a plain browser run needs one.
  let width: BrowserWidth | null = null;
  if (isLayered(planner)) {
    if (cli.driver !== "browser") { warn(`matrix: ${planner.label} places browser cases; it runs with --driver browser only`); return EXIT.REFUSED; }
    const refusal = layeredWidthRefusal(planner, cli.widthArg);
    if (refusal !== null) { warn(`matrix: ${refusal}\n${USAGE}`); return EXIT.REFUSED; }
  } else {
    // W1c Task 7: a set that proves the pad has nothing to prove over HTTP.
    if (planner.needsBrowser === true && cli.driver !== "browser") { warn(`matrix: --set ${cli.set ?? "(injected)"} scores every fixture on the pad; it runs with --driver browser only`); return EXIT.REFUSED; }
    if (cli.driver === "browser") {
      const w = plainBrowserWidth(cli.widthArg);
      if ("usage" in w) { warn(`matrix: ${w.usage}\n${USAGE}`); return EXIT.REFUSED; }
      width = w.width;
    }
  }
  // E-2: a finished run's evidence is never overwritten. Only results.json
  // marks a finished run — an aborted one leaves at most its shots.
  const prior = join(cli.reportDir, cli.runId, "results.json");
  if (existsSync(prior)) { warn(`matrix: ${errText(new RunIdReused(cli.runId, prior))}`); return EXIT.REFUSED; }
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
    return await execute(deps, cli, base, planner, width);
  } catch (e) {
    const refused = e instanceof DataDirMismatch || e instanceof DataDirUnset || e instanceof BuilderDefaultDrift || e instanceof PlanLacksGate
      || e instanceof NothingPlanned || e instanceof DuplicateCaseId;
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
    // LAZY (ruling A): the browser layer is loaded only when a browser run
    // opens, so an L3 run never loads it (boundary.test.ts pins this edge).
    openBrowserRun: async (base) => (await import("./lib/browser/browser-run.ts")).openBrowserRun(base),
  };
}

export async function main(argv: string[]): Promise<number> {
  return runSlice(realDeps(), argv);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
