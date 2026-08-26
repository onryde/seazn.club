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

const execFileAsync = promisify(execFile);

const ENGINES = ["optimized", "greedy", "both"] as const;
type Engine = (typeof ENGINES)[number];

export interface BenchConfig {
  suites: string[];
  engine: Engine;
  keep: boolean;
  reportDir: string;
  base: string;
  runId?: string;
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
    },
    allowPositionals: false,
    strict: true,
  });

  const engine = values.engine as string;
  if (!(ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`--engine must be one of ${ENGINES.join("|")}, got "${engine}"`);
  }
  if (values.keep && values.wipe) {
    throw new Error("--keep and --wipe are mutually exclusive");
  }

  return {
    suites: values.suite as string[],
    engine: engine as Engine,
    keep: !values.wipe,
    reportDir: values["report-dir"] as string,
    base: values.base ?? process.env.SMOKE_BASE ?? "http://localhost:3000",
    runId: values["run-id"] as string | undefined,
  };
}

async function gitSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function runSuite(key: string, config: BenchConfig): Promise<SuiteReport> {
  if (key === "_tiny") {
    return runTinySuite({ base: config.base, keep: config.keep, log: suiteLogger("_tiny") });
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

  const suites: SuiteReport[] = [];
  for (const key of config.suites) {
    const result = await runSuite(key, config);
    suites.push(result);
    log.info({ suite: key, gate: result.gate }, "suite_completed");
  }

  const preflightReport = { ok: true, refusals: [], placement: preflight.placement };
  const gate = gateOf({ preflight: preflightReport, suites });
  const report: BenchReport = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    engine: config.engine,
    base: config.base,
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
