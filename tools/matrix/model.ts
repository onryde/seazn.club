// The fast-check model over the format×sport grid, run live (design §7.5,
// R29). --cell takes any grid cell (W1-driving Task 14); with none, a run
// takes W1a's slice (SLICE_CELLS) and a --regressions replay takes every cell
// a committed case names (T14-R2). Either way a cell on a row the model does
// not drive is refused by family before anything runs (D6, ModelUnsupported):
//
//   pnpm run matrix:model --
//     --run-id ID [--report-dir DIR] [--cell row|sport]... [--runs N]
//     [--max-commands N] [--seed N [--path P [--replay-path R]]] [--no-fences]
//     [--regressions] [--time-limit MS] [--base URL] [--root DIR]
//
// --seed takes a negative seed as `--seed -N` as well as `--seed=-N`: the
// run prints `seed=-N`, and a copied seed must replay. --root redirects where
// regressions.json is read from (default: this checkout), like gen-catalogue's.
//
// Each cell gets one case org and a competition; each property run builds a
// fresh division in it (runCell), and the cell moves to a fresh competition
// before the plan's per-competition division cap (DIVISION_CAP_KEY). A cell's seed is FNV-1a of `${runId}|${cell}`
// — derived, logged and written, never read from a clock. --regressions
// replays every committed regression on the cells instead (a case on a cell
// --cell left out is a skip said aloud: printed, counted, listed), each at its own
// seed, path, replayPath and command bound (its maxCommands, W1b carry b), one
// run, with the fences it was found at unless it names a fence of its own
// (replayFences, W1c T2 ruling Q1).
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
//      — read first, before the base); no base URL, or one that is not an
//      http(s) URL (BaseNotUrl, FB-1); no own-DB proof
//      (BENCH_EXPECTED_DATA_DIR unset, or a data_directory mismatch at any
//      point); a failed preflight; a committed regression whose variant is not
//      its sport's (carry G-2); a live builder default that is not the offline
//      one (BuilderDefaultDrift, Review Focus 5); a case-org plan that allows
//      no division per competition (PlanAllowsNoDivision, final batch F-6 —
//      read before any case org).
//   3  aborted after the start gates: git, the DB, sign-in, a case org, or a
//      report that cannot be written or still holds a secret after redaction;
//      or, report written, some cell's request did not answer (RequestTimedOut:
//      environmental, not a regression — a TIMEOUT line, no stub, re-run it).
//      It outranks 1: the run is incomplete, whatever else it found (RR-2).
//   (3 also: a crash while the CLI LOADS, before any of its code runs — a
//   strip-types parse error, a missing export, a module that throws — through
//   `pnpm run matrix:model`, whose preload scripts/lib/crash-exit.ts maps it. Run it
//   only through that script: without the preload a load crash exits 1
//   (cli-invocation.test.ts refuses a documented run that skips it). Final
//   batch F-6, W1b carry e.)
//
// Every line printed, and every string written, passes through redact() (R14a).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROW_KEYS, SPORT_KEYS, builderDefaultVariant, cellId, type RowKey } from "./lib/catalogue.ts";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { productMessageOf, type OrganiserDriver } from "./lib/driver/types.ts";
import { newModelState } from "./lib/model/commands.ts";
import { runCell, type CellReport } from "./lib/model/run-cell.ts";
import { modelRowRefusal } from "./lib/model/state.ts";
import { BaseNotUrl, baseScrubber, findSecrets, mapStrings, redact } from "./lib/redact.ts";
import { SecretInResults, stringsIn } from "./lib/results.ts";
import { MATCH_MIN_LENGTH, MATCH_REQUIRED_CHECKS, loadRegressions, replayFences, type RegressionCase } from "./lib/scenario-catalogue.ts";
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

export const MODEL_USAGE = "usage: model.ts --run-id ID [--report-dir DIR] [--cell row|sport]... [--runs N] [--max-commands N] [--seed N [--path P [--replay-path R]]] [--no-fences] [--regressions] [--time-limit MS] [--base URL] [--root DIR]";

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

/** The cells a run takes with no --cell: W1a's slice, in registry order. */
const SLICE_CELLS: ReadonlyMap<string, { row: RowKey; sport: string }> = new Map(
  SLICE_ROWS.flatMap((row) => SLICE_SPORTS.map((sport) => [cellId(row, sport), { row, sport }] as const)),
);
/** Every grid cell: `--cell` may name any of them (W1-driving Task 14), and a
 *  committed regression may too. A row the model does not drive is refused
 *  by family before the run (runModel, D6). */
const GRID_CELLS: ReadonlyMap<string, { row: RowKey; sport: string }> = new Map(ROW_KEYS.flatMap((row) => SPORT_KEYS.map((sport) => [cellId(row, sport), { row, sport }] as const)));
const GRID_SPORT: ReadonlyMap<string, string> = new Map([...GRID_CELLS].map(([cell, { sport }]) => [cell, sport] as const));

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
  runId: string; reportDir: string; cells: SliceCell[]; cellsGiven: boolean; runs: number; maxCommands: number; timeLimitMs: number;
  seed: number | undefined; path: string | undefined; replayPath: string | undefined; fences: boolean; regressions: boolean; base: string | undefined;
  root: string | undefined;
}

/** `--seed -N` → `--seed=-N`: parseArgs reads a value starting with `-` as an
 *  option, and the run prints negative seeds (T15 fix round 2). Only an
 *  integer is joined; anything else is left for parseArgs to refuse. */
function joinNegativeSeed(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === undefined) continue;
    if (a === "--seed" && next !== undefined && /^-\d+$/.test(next)) {
      out.push(`--seed=${next}`);
      i++;
    } else out.push(a);
  }
  return out;
}

function parseCli(argv: string[]): Cli | { usage: string } {
  // pnpm passes one `--` through to the script; npm swallows it.
  const args = joinNegativeSeed(argv[0] === "--" ? argv.slice(1) : argv);
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
    const parts = GRID_CELLS.get(cell);
    if (parts === undefined) return { usage: `unknown cell '${cell}' (not a grid cell: row|sport, a builder row and a registry sport; with no --cell the model runs the slice cells: ${[...SLICE_CELLS.keys()].join(", ")})` };
    cells.push({ cell, ...parts });
  }
  // fast-check seeds are 32-bit ints; a longer number is a typo, not a seed.
  const seed = v.seed === undefined ? undefined : Number(v.seed);
  if (v.seed !== undefined && !(/^-?\d+$/.test(v.seed) && seed === ((seed ?? 0) | 0))) return { usage: "--seed takes a 32-bit integer" };
  if (v.path !== undefined && (v.seed === undefined || !/^\d+(:\d+)*$/.test(v.path))) return { usage: "--path takes a fast-check path (0:1:…) and needs --seed" };
  if (v["replay-path"] !== undefined && v.path === undefined) return { usage: "--replay-path needs --path (and --seed)" };
  if (v.regressions === true && (v.seed !== undefined || v.path !== undefined || v["replay-path"] !== undefined || v["max-commands"] !== undefined)) return { usage: "--regressions replays each committed case at its own seed, path and command bound; it takes no --seed, --path, --replay-path or --max-commands" };
  // Final batch F-5: no default. The case orgs' slugs (m-<runId>-<n>, unique
  // in organizations) and every cell's seed (seedFor) derive from the run id,
  // so a constant default made a second run abort on a duplicate slug, or
  // re-walk the same seeds on a fresh DB.
  if (v["run-id"] === undefined) return { usage: "--run-id is required: the case orgs' slugs and every cell's seed derive from it, so each run needs its own" };
  const slugged = v["run-id"].toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const runId = slugged.length > RUN_ID_MAX ? "" : slugged.replace(/^-+|-+$/g, "");
  if (runId === "") return { usage: `--run-id must slug to 1-${RUN_ID_MAX} characters of [a-z0-9-]` };
  return {
    runId, reportDir: v["report-dir"] ?? "matrix-report", cells, cellsGiven: v.cell !== undefined, runs, maxCommands, timeLimitMs,
    seed, path: v.path, replayPath: v["replay-path"], fences: v["no-fences"] !== true, regressions: v.regressions === true, base: v.base, root: v.root,
  };
}

/** The case orgs' plan allows no division per competition (DIVISION_CAP_KEY):
 *  the model builds one per property run, so nothing could run. A refusal,
 *  before any case org (final batch F-6; was a plain Error, read as aborted). */
export class PlanAllowsNoDivision extends Error {
  readonly plan: string;
  readonly cap: number;
  constructor(plan: string, cap: number) {
    super(`the case orgs' plan ${plan} allows ${cap} division(s) per competition (${DIVISION_CAP_KEY}) — the model builds one per property run`);
    this.name = "PlanAllowsNoDivision";
    this.plan = plan;
    this.cap = cap;
  }
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

interface Job extends SliceCell { seed: number; path?: string; replayPath?: string; runs: number; maxCommands: number; fences: boolean; replay: RegressionCase | null }

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
  // A replay walks one path; coverage is the exploring runs' business. A
  // known failure never excuses a vacuous cell (final batch F-1(a)).
  if (replay === null && rep.vacuous.length > 0) return "vacuous";
  if (rep.failure !== null) return "known-failure";
  return "ok";
}

/** Every string in a value, redacted (R14a) — before it is kept, so one
 *  secret-shaped string cannot throw away a whole report. The run's base is
 *  scrubbed only when the report is written, after its secret scan (FB-1). */
const redactAll = <T>(v: T): T => mapStrings(v, redact);

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
  // Final batch FB-12: an aborted cell is not tallied NEW, so a NEW failure
  // found before its timeout says so here, under the FAILURE line above.
  if (c.verdict === "aborted" && f !== null && f.known === null) say(`  the NEW ${f.check} above was found before the timeout cut its shrink — no stub: re-run the cell to shrink and stub it`);
  if (c.verdict === "not-reproduced" && c.replayOf !== null) {
    say(`  NOT REPRODUCED ${c.replayOf}: the replay ${f === null ? "ran clean" : `failed on ${f.check}${f.known === null ? "" : ` (known ${f.known})`} instead`} — fixed, or the replay no longer walks the committed path`);
  }
  // Final batch F-1(c): every judged cell says how far its walk got — a
  // failure, known or NEW, ends fast-check's walk at the run that found it.
  if (c.verdict !== "not-reproduced" && c.verdict !== "aborted") {
    const head = c.verdict === "vacuous" ? `VACUOUS: ${c.vacuous.join("; ")}` : c.verdict === "known-failure" ? "known" : c.verdict === "new-failure" ? "NEW" : "ok";
    say(`  ${head} — ${c.numRuns}/${c.runs} runs (${c.executions} executions), ${c.informativeSteps} informative steps, parity ${c.foldParity}, fenced ${JSON.stringify(c.fenced)}, unknowns ${JSON.stringify(c.unknowns)}${c.interrupted ? ", TIME BOX HIT" : ""}`);
  }
  for (const [id, x] of Object.entries(c.findings)) say(`  finding ${id} ×${x.count}${x.evidence[0] === undefined ? "" : ` — ${x.evidence[0]}`}`);
  if (Object.keys(c.masked).length > 0) say(`  masked while shrinking ${JSON.stringify(c.masked)}`);
}

/** The stub a person completes into regressions.json. "MB-NNN", "YYYY-MM-DD",
 *  the empty title and — on a check that requires one — the empty match are ON
 *  PURPOSE: parseRegressions refuses them until someone names, dates, titles
 *  and matches the case. Never `match: null` there: null would name every
 *  failure on the check (T15 fix round 3, I-2). */
function printStub(c: ModelCell, runId: string): void {
  const f = c.failure;
  if (f === null) return;
  // A NEW check passed over while shrinking has no path of its own to replay.
  for (const check of Object.keys(c.maskedNew)) say(`  no stub for ${check}: it was passed over while shrinking toward ${f.check}, so it has no replay path — re-find it once ${f.check} is fixed or fenced`);
  if (f.known !== null) return;
  const matchRequired = (MATCH_REQUIRED_CHECKS as readonly string[]).includes(f.check);
  // maxCommands and fencesOn: how this run found it (W1b carry b), from the cell's own settings.
  say(`regression stub for tools/matrix/catalogue/regressions.json (name it, date it, link its issue):\n${JSON.stringify({ id: "MB-NNN", title: "", issue: null, cell: c.cell, variant: c.variant, check: f.check, seed: f.seed, path: f.path, replayPath: f.replayPath, maxCommands: c.maxCommands, fencesOn: c.fences, fence: null, match: matchRequired ? "" : null, status: "open", found: "YYYY-MM-DD", runId }, null, 2)}`);
  if (matchRequired) {
    // Final batch FB-3: a match reads the product's own words alone, so the
    // owed line quotes those — never RefusedCall's request line around them.
    const words = f.said === null ? null : productMessageOf(f.said);
    if (f.said === null) say(`  match owed: ${f.check} names no single failure, and this one carries no product answer to match — it is the harness's to fix, not a case to commit`);
    else if (words === null) say(`  match owed: ${f.check} names no single failure, and the product's answer carries no words past its request line to match — it cannot be committed as a case: ${f.said}`);
    else say(`  match owed: ${f.check} names no single failure — set "match" to at least ${MATCH_MIN_LENGTH} characters of the product's own words below (never the request line, never the model's own line), or regressions.json is refused: ${words}`);
  }
  // A replay regenerates the counterexample from the seed. The committed case
  // records the bound and the fences it was found at (W1b carry b), and
  // --regressions replays at that bound with those fences — unless the case
  // names a fence, which then replays unfenced (replayFences, ruling Q1: a
  // fence named for a case post-dates it and would fence out its own
  // command). Unfenced replays a SHRUNK counterexample the same (it holds
  // only commands that ran, and a fence only ever stops one) — not an
  // unshrunk one the time box cut short, so that one is caveated.
  const caveats = [
    ...(f.path === "" ? ["it has no replay path"] : []),
    ...(c.fences && c.interrupted ? ["it was found with fences on and never shrunk (the time box): --regressions replays it fenced only while its \"fence\" is null — name one and it replays unfenced, which may not reproduce it"] : []),
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
  // T14-R2: with no --cell, a replay takes every cell a committed case names —
  // T14 opened --cell to the grid, so a case may sit outside the slice, and a
  // slice-only default would drop it unseen. Otherwise the cells given (or the slice).
  let runCells: SliceCell[] = cli.cells;
  if (cli.regressions && !cli.cellsGiven) {
    runCells = [];
    for (const cell of new Set(regressions.map((r) => r.cell))) {
      const parts = GRID_CELLS.get(cell);
      // checkRegressionVariants refused an off-grid cell above; reaching here without one is a harness fault.
      if (parts === undefined) { warn(`model: regressions.json names cell '${cell}', which is not on the grid`); return EXIT.REFUSED; }
      runCells.push({ cell, ...parts });
    }
  }
  // D6: a row the model does not drive is refused by family, before anything
  // is asked of the environment — never a cell that fails every run, never a
  // committed case skipped unseen.
  for (const c of runCells) {
    let refused: Error | null;
    try { refused = modelRowRefusal(c.row); } catch (e) { refused = e instanceof Error ? e : new Error(String(e)); }
    if (refused !== null) { warn(`model: refused ${c.cell} — ${errText(refused)}`); return EXIT.REFUSED; }
  }
  const base = cli.base ?? deps.env.SMOKE_BASE;
  if (!base) { warn("model: no --base and no SMOKE_BASE (seazn-local-env `env`)"); return EXIT.REFUSED; }
  // FB-1: the report is written with this base as LOCAL_BASE; one that is no URL is refused before anything runs.
  let scrubBase: (text: string) => string;
  try { scrubBase = baseScrubber(base); } catch (e) { if (!(e instanceof BaseNotUrl)) throw e; warn(`model: ${errText(e)}`); return EXIT.REFUSED; }
  // RF3: the own-DB proof is mandatory, and comes before the preflight.
  try { requireOwnDataDir(deps.env); } catch (e) { warn(`model: ${errText(e)}`); return EXIT.REFUSED; }
  let pf: Awaited<ReturnType<ModelDeps["preflight"]>>;
  try { pf = await deps.preflight(base); } catch (e) { warn(`model: preflight: ${errText(e)}`); return EXIT.REFUSED; }
  if (!pf.ok) { for (const r of pf.refusals) warn(`preflight refused: ${r.reason} — ${r.detail}`); return EXIT.REFUSED; }

  const chosen = new Map(runCells.map((c) => [c.cell, c]));
  const jobs: Job[] = cli.regressions
    ? regressions.flatMap((r) => {
      const c = chosen.get(r.cell);
      // W1b carry (b): the bound the case was found at — the counterexample is
      // regenerated from the seed, and the bound shapes what it generates. The
      // fences: ruling Q1 (replayFences).
      return c === undefined ? [] : [{ ...c, seed: r.seed, path: r.path, replayPath: r.replayPath ?? undefined, runs: 1, maxCommands: r.maxCommands, fences: replayFences(r), replay: r }];
    })
    : runCells.map((c) => ({ ...c, seed: cli.seed ?? seedFor(cli.runId, c.cell), path: cli.path, replayPath: cli.replayPath, runs: cli.runs, maxCommands: cli.maxCommands, fences: cli.fences, replay: null }));
  // T14-R2: a committed case on a cell the run did not take is a verdict, said
  // aloud — printed here, counted in the summary, listed in the report.
  const skipped = cli.regressions ? regressions.filter((r) => !chosen.has(r.cell)) : [];
  for (const r of skipped) say(`  skipped ${r.id} ${r.cell} — not among the --cell cells (${[...chosen.keys()].join(", ")})`);
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
      // Final batch F-6: the plan's division cap is read once, before any
      // case org — a plan that allows none is a refusal, like run.ts's PlanLacksGate.
      const cap = await db.planLimit(plan, DIVISION_CAP_KEY);
      if (cap !== null && cap < 1) throw new PlanAllowsNoDivision(plan, cap);
      for (const [i, job] of jobs.entries()) {
        const variant = job.replay?.variant ?? variantOf.get(job.sport);
        if (variant === undefined) throw new Error(`model: no variant read for ${job.sport}`);
        const org = await deps.prepareCaseOrg({ base, session, userId, plan }, { name: `Matrix model ${cli.runId} ${i + 1}`, slug: caseOrgSlug(cli.runId, i + 1) });
        const real = deps.driverFor(base, session, org.orgId);
        const competitionFor = await competitionSlots(real, cap, (k) => ({ name: `Matrix model ${job.cell}`, slug: `mm-${cli.runId}-${i + 1}${k === 1 ? "" : `-${k}`}` }));
        say(`[${i + 1}/${jobs.length}] ${job.cell} (${variant}) seed=${job.seed}${job.path === undefined ? "" : ` path=${job.path}`}${job.replayPath === undefined ? "" : ` replayPath=${job.replayPath}`} maxCommands=${job.maxCommands} fences=${job.fences ? "on" : "off"}${job.replay === null ? "" : ` — replay of ${job.replay.id}`}`);
        // T16 fix round 1: a replay offers its own case to the matcher first.
        // Two open cases may share cell, check and match — one bug reached by
        // two triggers (MB-007, MB-010) — and the first in the file would
        // otherwise claim the other's replay, which verdictOf then calls NOT
        // REPRODUCED although it failed as itself. Every other case stays, so
        // a failure as ANOTHER case is still named as that case.
        const replay = job.replay;
        const ranked = replay === null ? regressions : [replay, ...regressions.filter((r) => r.id !== replay.id)];
        const rep = await runCell({
          cell: job.cell, row: job.row, sport: job.sport, variant, runs: job.runs, maxCommands: job.maxCommands, seed: job.seed, fences: job.fences,
          timeLimitMs: cli.timeLimitMs, regressions: ranked,
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
    const refused = e instanceof DataDirMismatch || e instanceof DataDirUnset || e instanceof BuilderDefaultDrift || e instanceof PlanAllowsNoDivision;
    warn(`model: ${refused ? "refused" : "aborted"} — ${errText(e)}`);
    return refused ? EXIT.REFUSED : EXIT.ABORTED;
  }

  // A replay has no run-wide bound: each cell records the one its case was found at (W1b carry b).
  const out = { schemaVersion: 1, runId: cli.runId, harnessCommit, settings: { maxCommands: cli.regressions ? null : cli.maxCommands, timeLimitMs: cli.timeLimitMs, regressions: cli.regressions }, cells, skipped: skipped.map((r) => ({ id: r.id, cell: r.cell })) };
  // The secret scan reads the report BEFORE the base is scrubbed (FB-1).
  const secrets = stringsIn(out).flatMap((s) => findSecrets(s));
  if (secrets.length > 0) { warn(`model: ${new SecretInResults(secrets.length).message}`); return EXIT.ABORTED; }
  const dir = join(cli.reportDir, cli.runId);
  const file = join(dir, "model-report.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(mapStrings(out, scrubBase), null, 2)}\n`);
  } catch (e) { warn(`model: the report could not be written — ${errText(e)}`); return EXIT.ABORTED; }
  say(`model report → ${file}`);
  for (const c of cells) if (c.verdict === "new-failure") printStub(c, cli.runId);
  const tally = (v: Verdict) => cells.filter((c) => c.verdict === v).length;
  const abortedNew = cells.filter((c) => c.verdict === "aborted" && c.failure !== null && c.failure.known === null).length;
  say(`model: ${cells.length} cell(s) — ${tally("ok")} ok, ${tally("known-failure")} known, ${tally("new-failure")} NEW, ${tally("vacuous")} vacuous, ${tally("not-reproduced")} not reproduced, ${tally("aborted")} aborted${abortedNew === 0 ? "" : ` (${abortedNew} with a NEW failure found before its timeout)`}, ${cells.filter((c) => c.interrupted).length} TIME BOX HIT${cli.regressions ? `, ${skipped.length} committed case(s) skipped` : ""}`);
  if (cells.some((c) => c.verdict === "aborted")) return EXIT.ABORTED;
  return cells.some((c) => FAILING.includes(c.verdict)) ? EXIT.NO_SIGNAL : EXIT.OK;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runModel(realDeps(), process.argv.slice(2));
}
