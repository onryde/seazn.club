// The fast-check model over W1a's slice, run live (design §7.5, R29):
//
//   node --experimental-strip-types scripts/matrix/model.ts
//     [--run-id ID] [--report-dir DIR] [--cell row|sport]... [--runs N]
//     [--max-commands N] [--seed N [--path P [--replay-path R]]] [--no-fences]
//     [--regressions] [--time-limit MS] [--base URL] [--root DIR]
//
// --root redirects where regressions.json is read from (default: this
// checkout), like gen-catalogue's.
//
// Each cell gets one case org and a competition; each property run builds a
// fresh division in it (runCell), and the cell moves to a fresh competition
// before the plan's per-competition division cap (DIVISION_CAP_KEY). A cell's seed is FNV-1a of `${runId}|${cell}`
// — derived, logged and written, never read from a clock. --regressions
// replays every committed regression on the cells instead, each at its own
// seed, path and replayPath, one run, fences off.
//
// Exit codes, each with one meaning:
//   0  report written, and every cell is ok: no failure, nothing vacuous, or a
//      failure an OPEN committed regression names (known). A known product
//      finding met on the way (CD-T13b) never changes it.
//   1  report written, and some cell is a verdict: a NEW failure (including
//      any unexpected refusal, and a NEW check the shrink passed over), a
//      vacuous cell (R25), or a replayed OPEN regression that no longer
//      reproduces; or nothing to run (--regressions with no committed case on
//      the cells — decided before the DB, nothing written).
//   2  refused, nothing written: a usage error; a regressions.json the loader
//      refuses (a case on a generic check without its `match`, T15 fix round 2
//      — read first, before the base); no base URL; no own-DB proof
//      (BENCH_EXPECTED_DATA_DIR unset, or a data_directory mismatch at any
//      point); a failed preflight; a committed regression whose variant is not
//      its sport's (carry G-2); a live builder default that is not the offline
//      one (BuilderDefaultDrift, Review Focus 5).
//   3  aborted after the start gates: git, the DB, sign-in, a case org, or a
//      report that cannot be written or still holds a secret after redaction;
//      or, report written, some cell's request did not answer (RequestTimedOut:
//      environmental, not a regression — a TIMEOUT line, no stub, re-run it).
//      It outranks 1: the run is incomplete, whatever else it found (RR-2).
//
// Every line printed, and every string written, passes through redact() (R14a).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROW_KEYS, SPORT_KEYS, builderDefaultVariant, cellId, type RowKey } from "./lib/catalogue.ts";
import { isMainModule } from "./lib/main-module.ts";
import type { OrganiserDriver } from "./lib/driver/types.ts";
import { newModelState } from "./lib/model/commands.ts";
import { runCell, type CellReport } from "./lib/model/run-cell.ts";
import { findSecrets, redact } from "./lib/redact.ts";
import { SecretInResults, stringsIn } from "./lib/results.ts";
import { MATCH_REQUIRED_CHECKS, loadRegressions, type RegressionCase } from "./lib/scenario-catalogue.ts";
import { DataDirMismatch, DataDirUnset, caseOrgSlug, ownerEmail, requireOwnDataDir } from "./lib/seed-org.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "./lib/slice.ts";
import { variantKeys } from "./lib/sport-cfg.ts";
import { offlineBuilderDefault } from "./lib/variants.ts";
import { BuilderDefaultDrift, EXIT, RUN_ID_MAX, realDeps, type RunDeps } from "./run.ts";

export type ModelDeps = Pick<RunDeps, "env" | "harnessCommit" | "preflight" | "openDb" | "signIn" | "prepareCaseOrg" | "driverFor"> & {
  /** The committed regressions (default: regressions.json under --root, or this checkout). A seam for the unit suite. */
  loadRegressions?: (root?: string) => RegressionCase[];
  /** The time box's clock (default Date.now). A seam for the unit suite. */
  now?: () => number;
};

export const MODEL_USAGE = "usage: model.ts [--run-id ID] [--report-dir DIR] [--cell row|sport]... [--runs N] [--max-commands N] [--seed N [--path P [--replay-path R]]] [--no-fences] [--regressions] [--time-limit MS] [--base URL] [--root DIR]";

/** The defaults, chosen on the model fake (Task 14 report): fast-check's own
 *  size gives ~1.6 accepted steps per run; `size: "max"` (run-cell.ts) with 30
 *  commands gives ~6.3, and ran every command kind within 20 runs on every
 *  seed probed. The time box is per cell. */
export const MODEL_DEFAULTS = Object.freeze({ runs: 20, maxCommands: 30, timeLimitMs: 300_000 });

/** The product's per-competition division quota: the key createDivision's
 *  gate reads (divisions.ts getLimit; pinned by model-cli.test.ts). */
export const DIVISION_CAP_KEY = "divisions.per_competition.max";

/** Hands each property run a competition with a division slot left. The
 *  first is created up front; a fresh one replaces it before `cap` divisions
 *  (null = unlimited) — the 402 at cap+1 would otherwise surface as a
 *  model-error and silently truncate the cell's shrink (T15 fix round 1). */
async function competitionSlots(d: OrganiserDriver, cap: number | null, input: (k: number) => { name: string; slug: string }): Promise<() => Promise<string>> {
  let k = 1;
  let current = (await d.createCompetition(input(k))).id;
  let used = 0;
  return async () => {
    if (cap !== null && used >= cap) {
      current = (await d.createCompetition(input(++k))).id;
      used = 0;
    }
    used++;
    return current;
  };
}

/** Every model cell: W1a's slice, in registry order. */
const SLICE_CELLS: ReadonlyMap<string, { row: RowKey; sport: string }> = new Map(
  SLICE_ROWS.flatMap((row) => SLICE_SPORTS.map((sport) => [cellId(row, sport), { row, sport }] as const)),
);
/** Every grid cell's sport: a committed regression may name any of them. */
const GRID_SPORT: ReadonlyMap<string, string> = new Map(ROW_KEYS.flatMap((row) => SPORT_KEYS.map((sport) => [cellId(row, sport), sport] as const)));

/** FNV-1a, 32-bit, over UTF-8 bytes, as a signed int (fast-check seeds are ints). */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function seedFor(runId: string, cell: string): number {
  return fnv1a32(`${runId}|${cell}`);
}

const say = (s: string): void => { process.stdout.write(`${redact(s)}\n`); };
const warn = (s: string): void => { process.stderr.write(`${redact(s)}\n`); };
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

interface SliceCell { cell: string; row: RowKey; sport: string }
interface Cli {
  runId: string; reportDir: string; cells: SliceCell[]; runs: number; maxCommands: number; timeLimitMs: number;
  seed: number | undefined; path: string | undefined; replayPath: string | undefined; fences: boolean; regressions: boolean; base: string | undefined;
  root: string | undefined;
}

function parseCli(argv: string[]): Cli | { usage: string } {
  // pnpm passes one `--` through to the script; npm swallows it.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const parse = (a: string[]) => parseArgs({ args: a, options: {
    "run-id": { type: "string" }, "report-dir": { type: "string" }, cell: { type: "string", multiple: true },
    runs: { type: "string" }, "max-commands": { type: "string" }, seed: { type: "string" }, path: { type: "string" }, "replay-path": { type: "string" },
    "no-fences": { type: "boolean" }, regressions: { type: "boolean" }, "time-limit": { type: "string" }, base: { type: "string" }, root: { type: "string" },
  } });
  let v: ReturnType<typeof parse>["values"];
  try { v = parse(args).values; } catch (e) { return { usage: errText(e) }; }
  const int = (s: string | undefined, dflt: number, min: number): number | null => {
    if (s === undefined) return dflt;
    const n = Number(s);
    return /^\d+$/.test(s) && Number.isSafeInteger(n) && n >= min ? n : null;
  };
  const runs = int(v.runs, MODEL_DEFAULTS.runs, 1);
  const maxCommands = int(v["max-commands"], MODEL_DEFAULTS.maxCommands, 1);
  const timeLimitMs = int(v["time-limit"], MODEL_DEFAULTS.timeLimitMs, 1000);
  if (runs === null || maxCommands === null || timeLimitMs === null) return { usage: "--runs and --max-commands take an integer ≥ 1, --time-limit an integer ≥ 1000 (ms)" };
  const cells: SliceCell[] = [];
  for (const cell of v.cell ?? [...SLICE_CELLS.keys()]) {
    const parts = SLICE_CELLS.get(cell);
    if (parts === undefined) return { usage: `unknown cell '${cell}' (the model runs W1a's slice: ${[...SLICE_CELLS.keys()].join(", ")})` };
    cells.push({ cell, ...parts });
  }
  // fast-check seeds are 32-bit ints; a longer number is a typo, not a seed.
  const seed = v.seed === undefined ? undefined : Number(v.seed);
  if (v.seed !== undefined && !(/^-?\d+$/.test(v.seed) && seed === ((seed ?? 0) | 0))) return { usage: "--seed takes a 32-bit integer" };
  if (v.path !== undefined && (v.seed === undefined || !/^\d+(:\d+)*$/.test(v.path))) return { usage: "--path takes a fast-check path (0:1:…) and needs --seed" };
  if (v["replay-path"] !== undefined && v.path === undefined) return { usage: "--replay-path needs --path (and --seed)" };
  if (v.regressions === true && (v.seed !== undefined || v.path !== undefined || v["replay-path"] !== undefined)) return { usage: "--regressions replays each committed case at its own seed and path; it takes no --seed, --path or --replay-path" };
  const slugged = (v["run-id"] ?? "w1b-model").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const runId = slugged.length > RUN_ID_MAX ? "" : slugged.replace(/^-+|-+$/g, "");
  if (runId === "") return { usage: `--run-id must slug to 1-${RUN_ID_MAX} characters of [a-z0-9-]` };
  return {
    runId, reportDir: v["report-dir"] ?? "matrix-report", cells, runs, maxCommands, timeLimitMs,
    seed, path: v.path, replayPath: v["replay-path"], fences: v["no-fences"] !== true, regressions: v.regressions === true, base: v.base, root: v.root,
  };
}

/** A regression case whose variant is not one its sport declares (carry G-2):
 *  its replay would build a division the product refuses, and read as a failure. */
class RegressionVariantUnknown extends Error {
  constructor(r: RegressionCase, sport: string, known: readonly string[]) {
    super(`regressions.json: ${r.id} names variant '${r.variant}', which ${sport} does not declare (${known.join(", ")})`);
    this.name = "RegressionVariantUnknown";
  }
}
function checkRegressionVariants(regressions: readonly RegressionCase[]): void {
  for (const r of regressions) {
    const sport = GRID_SPORT.get(r.cell);
    if (sport === undefined) throw new Error(`regressions.json: ${r.id} names cell '${r.cell}', which is not on the grid`);
    const known = variantKeys(sport);
    if (!known.includes(r.variant)) throw new RegressionVariantUnknown(r, sport, known);
  }
}

interface Job extends SliceCell { seed: number; path?: string; replayPath?: string; runs: number; fences: boolean; replay: RegressionCase | null }

export type Verdict = "ok" | "vacuous" | "known-failure" | "new-failure" | "not-reproduced" | "aborted";
export type ModelCell = CellReport & { replayOf: string | null; verdict: Verdict };
const FAILING: readonly Verdict[] = ["vacuous", "new-failure", "not-reproduced"];

function verdictOf(rep: CellReport, replay: RegressionCase | null): Verdict {
  // The product did not answer: nothing this cell found is a verdict on it (fix round 2, RR-2).
  if (rep.timeout !== null) return "aborted";
  if (rep.failure !== null && rep.failure.known === null) return "new-failure";
  // A NEW check the shrink passed over is a new failure too (fix round 1, I-1).
  if (Object.keys(rep.maskedNew).length > 0) return "new-failure";
  // An OPEN case whose replay no longer fails AS ITSELF (its check and its
  // match, T15 fix round 2) did not reproduce: fixed, or the replay drifted.
  if (replay !== null && replay.status === "open" && rep.failure?.known !== replay.id) return "not-reproduced";
  if (rep.failure !== null) return "known-failure";
  // A replay walks one path; coverage is the exploring runs' business.
  if (replay === null && rep.vacuous.length > 0) return "vacuous";
  return "ok";
}

/** Every string in a value, redacted (R14a) — before it is kept, so one
 *  secret-shaped string cannot throw away a whole report. */
const redactAll = <T>(v: T): T => JSON.parse(JSON.stringify(v), (_k, x: unknown) => (typeof x === "string" ? redact(x) : x)) as T;

function printCell(c: ModelCell): void {
  const f = c.failure;
  if (f !== null) {
    say(`  FAILURE ${f.check} ${f.known === null ? "(NEW)" : `(known ${f.known})`}: ${f.commands.length === 0 ? "(no command list)" : f.commands.join(" → ")}`);
    say(`    seed=${f.seed} path=${f.path === "" ? "(none)" : f.path} replayPath=${f.replayPath ?? "(none)"}${c.interrupted ? ", TIME BOX HIT (unshrunk)" : ""}`);
    for (const e of f.evidence.slice(0, 3)) say(`    evidence: ${e}`);
    for (const [check, cmds] of Object.entries(c.maskedNew)) {
      say(`  NEW ${check} (passed over while shrinking toward ${f.check}): ${cmds.length === 0 ? "(no command list)" : cmds.join(" → ")}`);
    }
  }
  if (c.timeout !== null) say(`  TIMEOUT: ${c.timeout} — environmental, not a regression: no stub; re-run the cell`);
  if (c.verdict === "not-reproduced" && c.replayOf !== null) {
    say(`  NOT REPRODUCED ${c.replayOf}: the replay ${f === null ? "ran clean" : `failed on ${f.check}${f.known === null ? "" : ` (known ${f.known})`} instead`} — fixed, or the replay no longer walks the committed path`);
  }
  if (f === null && c.verdict !== "not-reproduced" && c.verdict !== "aborted") {
    const head = c.verdict === "vacuous" ? `VACUOUS: ${c.vacuous.join("; ")}` : "ok";
    say(`  ${head} — ${c.numRuns} runs (${c.executions} executions), ${c.informativeSteps} informative steps, parity ${c.foldParity}, fenced ${JSON.stringify(c.fenced)}, unknowns ${JSON.stringify(c.unknowns)}${c.interrupted ? ", TIME BOX HIT" : ""}`);
  }
  for (const [id, x] of Object.entries(c.findings)) say(`  finding ${id} ×${x.count}${x.evidence[0] === undefined ? "" : ` — ${x.evidence[0]}`}`);
  if (Object.keys(c.masked).length > 0) say(`  masked while shrinking ${JSON.stringify(c.masked)}`);
}

/** The stub a person completes into regressions.json. "MB-NNN", "YYYY-MM-DD"
 *  and the empty title are ON PURPOSE: parseRegressions refuses them until
 *  someone names, dates and titles the case. */
function printStub(c: ModelCell, runId: string): void {
  const f = c.failure;
  if (f === null) return;
  // A NEW check passed over while shrinking has no path of its own to replay.
  for (const check of Object.keys(c.maskedNew)) say(`  no stub for ${check}: it was passed over while shrinking toward ${f.check}, so it has no replay path — re-find it once ${f.check} is fixed or fenced`);
  if (f.known !== null) return;
  say(`regression stub for scripts/matrix/catalogue/regressions.json (name it, date it, link its issue):\n${JSON.stringify({ id: "MB-NNN", title: "", issue: null, cell: c.cell, variant: c.variant, check: f.check, seed: f.seed, path: f.path, replayPath: f.replayPath, fence: null, match: null, status: "open", found: "YYYY-MM-DD", runId }, null, 2)}`);
  if ((MATCH_REQUIRED_CHECKS as readonly string[]).includes(f.check)) {
    say(`  match owed: ${f.check} names no single failure — set "match" to text from the evidence that does (the product's message), or regressions.json is refused`);
  }
  // A replay regenerates the counterexample from the seed; the committed case
  // records neither --max-commands nor the fences. --regressions honours
  // --max-commands and always runs fences off, which replays a SHRUNK
  // counterexample the same (it holds only commands that ran, and a fence
  // only ever stops one) — not an unshrunk one the time box cut short.
  const caveats = [
    ...(f.path === "" ? ["it has no replay path"] : []),
    ...(c.maxCommands === MODEL_DEFAULTS.maxCommands ? [] : [`it was found at --max-commands ${c.maxCommands}, and the committed case does not record it: replay it with --regressions --max-commands ${c.maxCommands}`]),
    ...(c.fences && c.interrupted ? ["it was found with fences on and never shrunk (the time box), and --regressions replays with fences off"] : []),
  ];
  if (caveats.length > 0) say(`  replay caveat: ${caveats.join("; ")} — check that --regressions reproduces it before committing it`);
}

export async function runModel(deps: ModelDeps, argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  if ("usage" in cli) { warn(`model: ${cli.usage}\n${MODEL_USAGE}`); return EXIT.REFUSED; }
  // The committed cases first: a file the loader refuses is refused before
  // anything else is asked of the environment (T15 fix round 2).
  let regressions: RegressionCase[];
  try {
    regressions = (deps.loadRegressions ?? loadRegressions)(cli.root);
    checkRegressionVariants(regressions);
  } catch (e) { warn(`model: ${errText(e)}`); return EXIT.REFUSED; }
  const base = cli.base ?? deps.env.SMOKE_BASE;
  if (!base) { warn("model: no --base and no SMOKE_BASE (seazn-local-env `env`)"); return EXIT.REFUSED; }
  // RF3: the own-DB proof is mandatory, and comes before the preflight.
  try { requireOwnDataDir(deps.env); } catch (e) { warn(`model: ${errText(e)}`); return EXIT.REFUSED; }
  let pf: Awaited<ReturnType<ModelDeps["preflight"]>>;
  try { pf = await deps.preflight(base); } catch (e) { warn(`model: preflight: ${errText(e)}`); return EXIT.REFUSED; }
  if (!pf.ok) { for (const r of pf.refusals) warn(`preflight refused: ${r.reason} — ${r.detail}`); return EXIT.REFUSED; }

  const chosen = new Map(cli.cells.map((c) => [c.cell, c]));
  const jobs: Job[] = cli.regressions
    ? regressions.flatMap((r) => {
      const c = chosen.get(r.cell);
      return c === undefined ? [] : [{ ...c, seed: r.seed, path: r.path, replayPath: r.replayPath ?? undefined, runs: 1, fences: false, replay: r }];
    })
    : cli.cells.map((c) => ({ ...c, seed: cli.seed ?? seedFor(cli.runId, c.cell), path: cli.path, replayPath: cli.replayPath, runs: cli.runs, fences: cli.fences, replay: null }));
  if (jobs.length === 0) { warn("model: nothing to run — --regressions found no committed case on these cells"); return EXIT.NO_SIGNAL; }

  const cells: ModelCell[] = [];
  let harnessCommit: string;
  try {
    harnessCommit = await deps.harnessCommit();
    const db = await deps.openDb();
    try {
      const owner = ownerEmail(cli.runId);
      const session = await deps.signIn(base, owner);
      const userId = await db.userIdForEmail(owner);
      const plan = await db.chooseTopPublicPlan();
      // Review Focus 5: the variant a cell builds is the LIVE builder default,
      // and it must be the one the committed catalogue assumes.
      const variantOf = new Map<string, string>();
      for (const sport of [...new Set(jobs.filter((j) => j.replay === null).map((j) => j.sport))]) {
        const live = builderDefaultVariant(sport, await db.variantKeysInBuilderOrder(sport));
        const offline = offlineBuilderDefault(sport);
        if (live !== offline) throw new BuilderDefaultDrift(sport, live, offline);
        variantOf.set(sport, live);
      }
      for (const [i, job] of jobs.entries()) {
        const variant = job.replay?.variant ?? variantOf.get(job.sport);
        if (variant === undefined) throw new Error(`model: no variant read for ${job.sport}`);
        const org = await deps.prepareCaseOrg({ base, session, userId, plan }, { name: `Matrix model ${cli.runId} ${i + 1}`, slug: caseOrgSlug(cli.runId, i + 1) });
        const real = deps.driverFor(base, session, org.orgId);
        const cap = await db.planLimit(plan, DIVISION_CAP_KEY);
        if (cap !== null && cap < 1) throw new Error(`the case org's plan ${plan} allows ${cap} division(s) per competition (${DIVISION_CAP_KEY}) — the model builds one per property run`);
        const competitionFor = await competitionSlots(real, cap, (k) => ({ name: `Matrix model ${job.cell}`, slug: `mm-${cli.runId}-${i + 1}${k === 1 ? "" : `-${k}`}` }));
        say(`[${i + 1}/${jobs.length}] ${job.cell} (${variant}) seed=${job.seed}${job.path === undefined ? "" : ` path=${job.path}`}${job.replayPath === undefined ? "" : ` replayPath=${job.replayPath}`} fences=${job.fences ? "on" : "off"}${job.replay === null ? "" : ` — replay of ${job.replay.id}`}`);
        const rep = await runCell({
          cell: job.cell, row: job.row, sport: job.sport, variant, runs: job.runs, maxCommands: cli.maxCommands, seed: job.seed, fences: job.fences,
          timeLimitMs: cli.timeLimitMs, regressions,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(job.path === undefined ? {} : { path: job.path }),
          ...(job.replayPath === undefined ? {} : { replayPath: job.replayPath }),
          newDriverState: async (n) => ({ real, model: await newModelState({ driver: real, row: job.row, sport: job.sport, variant, entrants: 4, tag: `${cli.runId}-${i + 1}-${n}`, competitionId: await competitionFor() }) }),
        });
        const cell: ModelCell = redactAll({ ...rep, replayOf: job.replay?.id ?? null, verdict: verdictOf(rep, job.replay) });
        cells.push(cell);
        printCell(cell);
      }
    } finally {
      try { await db.dispose(); } catch (e) { warn(`model: db dispose failed — ${errText(e)}`); }
    }
  } catch (e) {
    const refused = e instanceof DataDirMismatch || e instanceof DataDirUnset || e instanceof BuilderDefaultDrift;
    warn(`model: ${refused ? "refused" : "aborted"} — ${errText(e)}`);
    return refused ? EXIT.REFUSED : EXIT.ABORTED;
  }

  const out = { schemaVersion: 1, runId: cli.runId, harnessCommit, settings: { maxCommands: cli.maxCommands, timeLimitMs: cli.timeLimitMs, regressions: cli.regressions }, cells };
  const secrets = stringsIn(out).flatMap((s) => findSecrets(s));
  if (secrets.length > 0) { warn(`model: ${new SecretInResults(secrets.length).message}`); return EXIT.ABORTED; }
  const dir = join(cli.reportDir, cli.runId);
  const file = join(dir, "model-report.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  } catch (e) { warn(`model: the report could not be written — ${errText(e)}`); return EXIT.ABORTED; }
  say(`model report → ${file}`);
  for (const c of cells) if (c.verdict === "new-failure") printStub(c, cli.runId);
  const tally = (v: Verdict) => cells.filter((c) => c.verdict === v).length;
  say(`model: ${cells.length} cell(s) — ${tally("ok")} ok, ${tally("known-failure")} known, ${tally("new-failure")} NEW, ${tally("vacuous")} vacuous, ${tally("not-reproduced")} not reproduced, ${tally("aborted")} aborted, ${cells.filter((c) => c.interrupted).length} TIME BOX HIT`);
  if (cells.some((c) => c.verdict === "aborted")) return EXIT.ABORTED;
  return cells.some((c) => FAILING.includes(c.verdict)) ? EXIT.NO_SIGNAL : EXIT.OK;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runModel(realDeps(), process.argv.slice(2));
}
