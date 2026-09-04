// Scheduler bench CLI entry point. Runs pre-flight, then each requested
// suite, then writes bench-report/<run-id>/{report.json,report.md}. Exits
// non-zero on any gate red (pre-flight refusal, or any suite gate).
//
// Run exactly like scripts/smoke.ts: `node --experimental-strip-types
// scripts/bench/bench.ts` (package.json's "bench:scheduler" script wraps
// this). Flags use node:util's parseArgs rather than smoke.ts's ad-hoc
// `process.argv.find(...)` convention (scripts/seed-demo.ts:754) — smoke.ts
// has no flags of its own to follow, and parseArgs is the better fit for a
// repeatable `--suite` flag plus several string/boolean options; it is a
// Node builtin, so this adds no new dependency.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createRealPreflightProbes, runPreflight, type PreflightResult } from "./lib/env.ts";
import { log, suiteLogger } from "./lib/log.ts";
import { gateOf, resolveRunId, writeReport, type BenchReport, type SuiteReport } from "./lib/report.ts";
import { runTinySuite } from "./lib/suites/tiny.ts";
import { createRealPlanSql, type PlanSql } from "./lib/plan.ts";
import type { SeedTransport } from "./lib/seed.ts";
import type { ProbeTransport } from "./lib/dls-gate.ts";
import type { CliEntryFlag } from "./lib/register.ts";

const execFileAsync = promisify(execFile);

const ENGINES = ["optimized", "greedy", "both"] as const;
type Engine = (typeof ENGINES)[number];

const KNOWN_SUITES = ["_tiny"] as const;

// B03r task 6: `--entry admin|registration` (design §3) — the CLI's own
// narrower vocabulary; `register.ts`'s `resolveEntryMode` is what turns
// "registration" into the concrete `registration-api`/`registration-ui`
// per suite (suite 13 is the one exception). Only PARSED here — nothing in
// `runSuite` below wires it into a live suite yet: `_tiny` doesn't accept
// an `entry` override until a later task gives it a registration division
// (B03r ladder item 7), and `suites/` is out of this task's scope.
const ENTRY_FLAGS = ["admin", "registration"] as const;

export interface BenchConfig {
  suites: string[];
  engine: Engine;
  keep: boolean;
  reportDir: string;
  base: string;
  runId?: string;
  entry?: CliEntryFlag;
}

/**
 * `--base`'s default deliberately DOES read `SMOKE_BASE` (mirroring
 * smoke.ts:24's own env convention, per the B01 brief's own instruction) —
 * this is the ONE place in the whole bench that touches that name, and only
 * as a fallback a caller can override with `--base`. lib/http.ts never
 * reads it (or any env var) itself; every http.ts function takes `base` as
 * an explicit parameter threaded from here, so there is exactly one source
 * of truth for the value and no way for the two to disagree — which is what
 * "don't reuse the exact var name" (brief's lib/http.ts section) protects
 * against in practice.
 */
export function parseCliArgs(argv: string[]): BenchConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      suite: { type: "string", multiple: true, default: [] },
      engine: { type: "string", default: "optimized" },
      keep: { type: "boolean", default: false },
      wipe: { type: "boolean", default: false },
      "report-dir": { type: "string", default: "bench-report" },
      base: { type: "string" },
      "run-id": { type: "string" },
      entry: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const engine = values.engine;
  if (!(ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`--engine must be one of ${ENGINES.join("|")}, got "${engine}"`);
  }
  if (values.keep && values.wipe) {
    throw new Error("--keep and --wipe are mutually exclusive");
  }

  const suites = values.suite;
  const unknown = suites.filter((s) => !(KNOWN_SUITES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    // Validated up front, not inside the run loop: a typo in one of several
    // --suite flags must never lose already-completed earlier suites'
    // results because no report gets written until the whole loop finishes
    // (bench.ts's main()) — failing here, before pre-flight or any suite
    // runs, means nothing was lost because nothing ran yet.
    throw new Error(`unknown --suite value(s): ${unknown.join(", ")} — known suites: ${KNOWN_SUITES.join(", ")}`);
  }

  // NO "http://localhost:3000" fallback here (there was one; it collided
  // with lib/env.ts's own FORBIDDEN_BASE_PORTS, which makes it a real
  // dev-server port, not a placeholder — so the CLI's own default invocation
  // could never pass pre-flight). The bench always owns its own throwaway
  // server; there is no port a default could safely guess, so an unset
  // --base/SMOKE_BASE is a clear parse-time error instead of a silently
  // wrong default that fails identically on every run.
  const base = values.base ?? process.env.SMOKE_BASE;
  if (!base) {
    throw new Error("--base is required (or set SMOKE_BASE) — point it at the bench's own throwaway server, never :3000.");
  }

  if (values.entry !== undefined && !(ENTRY_FLAGS as readonly string[]).includes(values.entry)) {
    throw new Error(`--entry must be one of ${ENTRY_FLAGS.join("|")}, got "${values.entry}"`);
  }

  return {
    suites,
    engine: engine as Engine,
    keep: !values.wipe,
    reportDir: values["report-dir"],
    base,
    ...(values.entry === undefined ? {} : { entry: values.entry as CliEntryFlag }),
    runId: values["run-id"],
  };
}

async function gitSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * `sql` is REQUIRED here (never defaulted inside this function), mirroring
 * `runPreflight(base, probes)`'s own "the DI param is mandatory, the CALLER
 * decides real-vs-fake" idiom rather than `runTinySuite`'s OWN "optional,
 * defaults to real" one for `transport` — `main()` below is the ONE
 * production caller and it always constructs the real thing
 * (`createRealPlanSql`), so a live `_tiny` run always drives B03 T7's
 * plan-provisioning + DLS-gate probe; `lib/__tests__/bench-cli.test.ts`
 * proves this specific forwarding line exists by injecting a fake `sql` (and
 * a fake `transport`) and asserting `runTinySuite` actually receives them —
 * removing either the `sql:` or the `transport:` forward below reds that
 * test, independent of `lib/__tests__/tiny-suite-plan.test.ts`'s own
 * coverage of what `runTinySuite` DOES once it has one.
 */
export async function runSuite(
  key: string,
  config: BenchConfig,
  sql: PlanSql,
  transport?: SeedTransport,
  probeTransport?: ProbeTransport,
): Promise<SuiteReport> {
  if (key === "_tiny") {
    return runTinySuite({
      base: config.base,
      engine: config.engine,
      keep: config.keep,
      log: suiteLogger("_tiny"),
      sql,
      /* The whole point of `--entry`. Parsed into `BenchConfig` by task 6 and
       * consumed by `runTinySuite`'s `resolveEntryMode` since task 9 — but
       * unforwarded until now, which made the flag inert end to end: every run
       * took each division's own declared `entry` no matter what the CLI said,
       * and `report.entryMode` stayed undefined so "Registration at volume"
       * could never render. Both halves existed, were typed, and were unit
       * green. Nothing joined them. */
      ...(config.entry === undefined ? {} : { cliEntry: config.entry }),
      ...(transport === undefined ? {} : { transport }),
      ...(probeTransport === undefined ? {} : { probeTransport }),
    });
  }
  throw new Error(`unknown suite "${key}" — only "_tiny" exists until B02+ lands real packs`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = parseCliArgs(argv);
  const startedAt = new Date().toISOString();
  log.info({ suites: config.suites, engine: config.engine, keep: config.keep, base: config.base }, "bench_started");

  const runId = resolveRunId(config.runId, await gitSha());

  const { probes, dispose } = createRealPreflightProbes();
  let preflight: PreflightResult;
  try {
    preflight = await runPreflight(config.base, probes);
  } finally {
    await dispose();
  }

  if (!preflight.ok) {
    log.error({ refusals: preflight.refusals }, "preflight_refused");
    const report: BenchReport = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      engine: config.engine,
      base: config.base,
      preflight: { ok: false, refusals: preflight.refusals, placement: preflight.placement },
      suites: [],
      gate: "red",
    };
    const written = await writeReport(config.reportDir, report);
    log.info({ gate: "red", reportDir: written.dir }, "bench_finished");
    return 1;
  }
  log.info({ placement: preflight.placement }, "preflight_passed");

  // B03 T7: the plan/entitlement-provisioning SQL seam, constructed once
  // per run and disposed after every suite is done with it — same
  // construct/dispose shape as `createRealPreflightProbes` above. Always
  // wired (never behind a flag): a real `_tiny` run always drives the
  // DLS-gate probe and `officials.auto` derivation from here on.
  const { sql: planSql, dispose: disposePlanSql } = createRealPlanSql();
  const suites: SuiteReport[] = [];
  try {
    for (const key of config.suites) {
      const result = await runSuite(key, config, planSql);
      suites.push(result);
      log.info({ suite: key, gate: result.gate }, "suite_completed");
    }
  } finally {
    await disposePlanSql();
  }

  const preflightReport = { ok: true, refusals: [], placement: preflight.placement };
  const gate = gateOf({ preflight: preflightReport, suites });
  const report: BenchReport = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    engine: config.engine,
    base: config.base,
    /* `report.ts:306` gates the "Registration at volume" section on this being
     * exactly `"registration"`. Without this line it is always undefined, so
     * that section never renders and the run silently reports nothing about
     * the volume pass it just performed — the report agreeing with a broken
     * run rather than contradicting it. */
    ...(config.entry === undefined ? {} : { entryMode: config.entry }),
    preflight: preflightReport,
    suites,
    gate,
  };
  const written = await writeReport(config.reportDir, report);
  log.info({ gate, reportDir: written.dir }, "bench_finished");
  return gate === "red" ? 1 : 0;
}

// Only run when executed directly (node scripts/bench/bench.ts), not when
// imported by a test — same guard scripts/backfill-pass-credit-redemptions.ts:424
// already uses.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log.error({ err }, "bench crashed");
      process.exitCode = 1;
    });
}
