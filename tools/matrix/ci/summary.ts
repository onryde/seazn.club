// CLI: pnpm --silent run matrix:summary --merged <dir> [--judge <json>]... [--previous-run auto|none] [--require-complete] --out <file>
// W1d Task 8 (D1a, D5, D20), reshaped by T9-HG: SUMMARY.md, the one page a run leaves for a reader — also appended to the job
// summary. It spans the three layers: the previous complete run (so a skipped week shows), this run's harness faults and its
// verdict, a histogram per layer, the planned ░ per atom, per-layer timings, and the weekly diff against the previous run's
// merged results. `--merged` holds one `<layer>/results.json` per layer (what merge-shards writes).
//
// ONE workflow run never says "Harness-green: yes" or "no": ruling 61's "identical across three runs" spans three WORKFLOW
// runs (ruling 62: PR-B's three dispatches). The page states the per-run half instead, "Run complete: yes|no" — every
// layer's merge was accepted (merge-shards refuses a short shard, so a merged run means every shard completed), no merged
// case is a harness fault (so every driven case reports a state), and a `judge faults` verdict is BOUND to each layer's
// merged run (the file's `layer` is the layer and its `runs` name the merged run's id — so a stale file from an earlier run
// is no verdict of this one) with exit 0 — and a fixed line saying harness-green needs three runs and `matrix:judge across`.
// The verdict is mechanical and fails SAFE (PF-1): a judge file that is missing, unparsable or inconsistent is "judge refused"
// and the run is not complete (a refused judge writes no file, so its absence is the refusal, never a pass). A layer with no
// merged run is a line saying so, never a silent omission. The faults of THIS run are also counted here from its merged cases,
// by the judge's own harnessFaults (the same authority, not a copy).
// A `judge across` verdict, when one is passed in, is still read and its ruling-61 check kept (exactly 3 runs, exit 0), but only
// as a note under "Judge verdicts": it never moves "Run complete" and nothing in production passes one until PR-B Task 17.
//
// The page never fails the run on a gh failure (D20 is informational): any `gh` failure becomes a line, "previous run
// unavailable: <reason>". `--require-complete` is how the workflow's colour follows the per-run verdict: the page is written
// first, then a run that is not complete exits 1.
// Exit codes, each with one meaning (the one convention, D8):
//   0  written: SUMMARY.md is at --out, whatever it says (a missing layer and an unavailable previous run are lines in it; without
//      --require-complete the steps that judge decide the job's colour);
//   1  a negative signal, after SUMMARY.md is written: --require-complete was given and the run is not complete;
//   2  refused, nothing written: usage; --out cannot be written;
//   3  a crash while it loads, through `pnpm run matrix:summary` (its preload, scripts/lib/crash-exit.ts).
//      Run it only through that script: without the preload a load crash exits 1, which reads as a verdict.
// Every line of the page passes through redact(): a case's reason is free text and may carry what a secret looks like.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../../scripts/lib/main-module.ts";
import { harnessFaults, parseJudgeOut, type Fault, type JudgeOut } from "../lib/judge.ts";
import { redact } from "../lib/redact.ts";
import { CASE_STATES, GLYPH, LAYERS, parseResults, type CaseResult, type CaseState, type Layer, type RunResults } from "../lib/results.ts";
import { GhFailed, downloadMerged, realGh, successfulRuns, weeklySuccesses, type GhRunner } from "./gh.ts";

const USAGE = "usage: summary.ts --merged <dir> [--judge <json>]... [--previous-run auto|none] [--require-complete] --out <file>";
const DAY_MS = 86_400_000;
/** Ruling 61: harness-green is identical states across exactly this many WORKFLOW runs (PR-B's `matrix:judge across`). */
export const GREEN_RUNS = 3;
/** The most list lines a section prints (the rest are counted): the page goes to a job summary with a size cap. */
const LIST_CAP = 25;

// --- inputs ----------------------------------------------------------------------------------------------------

/** One `--judge` file, read: its verdict, or why it is no verdict. */
export type JudgeInput = { readonly path: string; readonly out: JudgeOut } | { readonly path: string; readonly refused: string };
/** The previous complete run (the newest successful weekly run): its id, when it began, and the layers its merged artifact held. */
export interface Previous { readonly runId: number; readonly date: string; readonly layers: Partial<Record<Layer, RunResults>> }
/** `null`: there is no previous run. `{ unavailable }`: there is one that could not be read (D20 never fails on it). */
export type PreviousInput = Previous | null | { readonly unavailable: string };

// --- small pure helpers ----------------------------------------------------------------------------------------

const clip = (s: string, n = 160): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** A markdown table cell: GFM splits on `|` even in a code span, and a newline ends the row. */
const cell = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ").replace(/\|/g, "\\|");
const drivenOf = (run: RunResults): CaseResult[] => run.cases.filter((c) => c.planned !== true);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The nearest-rank percentile (`pct` a whole number, 1..100) of an ascending list: the smallest value with at least pct
 *  percent of the list at or below it. Whole-number arithmetic, so no rounding error can move a rank across a boundary. */
export function percentile(sortedAsc: readonly number[], pct: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile: an empty list has none (a layer that drove nothing has no timings)");
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new Error(`percentile: ${pct} is not a whole percent in 1..100`);
  return sortedAsc[Math.ceil((pct * sortedAsc.length) / 100) - 1];
}
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Whether a verdict file agrees with itself: exit 0 means nothing was found, exit 1 means something was. */
function consistent(o: JudgeOut): string | null {
  const found = o.faults.length + o.differing.length + o.regressed.length + o.absent.length;
  if (o.exit === 0 && found > 0) return `exit 0 but it lists ${found} finding(s)`;
  if (o.exit === 1 && found === 0) return "exit 1 but it lists no finding";
  return null;
}

// --- the page --------------------------------------------------------------------------------------------------

interface LayerView { readonly layer: Layer; readonly run: RunResults | null; readonly faults: Fault[] }

function previousLine(previous: PreviousInput, now: Date): string {
  if (previous === null) return "Previous complete run: none yet";
  if ("unavailable" in previous) return `Previous run unavailable: ${previous.unavailable}`;
  const when = Date.parse(previous.date);
  const days = Number.isNaN(when) ? "an unknown number of" : String(Math.max(0, Math.floor((now.getTime() - when) / DAY_MS)));
  return `Previous complete run: ${previous.date.slice(0, 10)} (${days} days ago) — run ${previous.runId}`;
}

/** How each layer's merged run stands against the judge files, and the reasons the run is not complete (T9-HG). */
function assess(views: readonly LayerView[], judges: readonly JudgeInput[]): { complete: boolean; reasons: string[]; lines: string[] } {
  const reasons: string[] = [];
  const lines: string[] = [];
  const refused = judges.filter((j): j is { path: string; refused: string } => "refused" in j);
  const given = judges.filter((j): j is { path: string; out: JudgeOut } => "out" in j);
  for (const j of refused) reasons.push(`judge refused: ${j.path} — ${j.refused}`);
  for (const v of views) {
    if (v.run === null) { reasons.push(`${v.layer}: no merged run to judge`); continue; }
    const mine = given.filter((j) => j.out.layer === v.layer);
    const bound = mine.filter((j) => j.out.runs.includes(v.run!.runId));
    for (const j of mine.filter((x) => !bound.includes(x))) lines.push(`- \`${j.path}\` judged ${v.layer} runs ${j.out.runs.join(", ")}, not this run (${v.run.runId}): a stale verdict, ignored`);
    for (const j of bound) lines.push(`- \`${j.path}\`: ${v.layer} ${j.out.mode} over ${plural(j.out.runs.length, "run")} (${j.out.runs.join(", ")}) — exit ${j.out.exit}, ${j.out.compared} cases compared, ${plural(j.out.faults.length, "fault")}, ${j.out.differing.length} differing, ${j.out.regressed.length} regressed`);
    // The per-run claim: a `judge faults` verdict bound to this merged run, exit 0.
    const faultsJudges = bound.filter((j) => j.out.mode === "faults");
    if (faultsJudges.length === 0) {
      reasons.push(`${v.layer}: no \`judge faults\` verdict is bound to run ${v.run.runId}${mine.length > bound.length ? " (a judge file for this layer judged other runs)" : ""}`);
    }
    for (const j of faultsJudges.filter((x) => x.out.exit !== 0)) reasons.push(`${v.layer}: ${plural(j.out.faults.length, "harness fault")} in this run`);
    if (v.faults.length > 0) reasons.push(`${v.layer}: this run's merged results hold ${plural(v.faults.length, "harness fault")}`);
    // The ruling-61 check on an `across` verdict stays as T8 wrote it, but it is a note: harness-green is three workflow runs
    // judged by PR-B Task 17, so it never decides whether THIS run is complete.
    for (const j of bound.filter((x) => x.out.mode === "across")) {
      if (j.out.runs.length !== GREEN_RUNS) lines.push(`- ${v.layer}: judged ${plural(j.out.runs.length, "run")}; harness-green needs exactly ${GREEN_RUNS} (ruling 61) — a note; it does not change "Run complete"`);
      if (j.out.exit !== 0) lines.push(`- ${v.layer}: ${j.out.differing.length} differing, ${plural(j.out.faults.length, "harness fault")} across the runs — a note; it does not change "Run complete"`);
    }
  }
  return { complete: reasons.length === 0, reasons, lines };
}

/** Each layer's merged run beside the faults the judge's own authority counts in it. */
function viewsOf(merged: Record<Layer, RunResults | null>): LayerView[] {
  return LAYERS.map((layer) => {
    const run = merged[layer];
    return { layer, run, faults: run === null ? [] : harnessFaults(run, { plannedNotRun: "allow" }) };
  });
}

/** Whether this run is complete (T9-HG): the per-run half of ruling 61, the same predicate the page prints as "Run complete". */
export function runComplete(merged: Record<Layer, RunResults | null>, judges: readonly JudgeInput[]): boolean {
  return assess(viewsOf(merged), judges).complete;
}

/** The weekly diff of one layer: every case both runs hold whose state moved. */
function diffLayer(now: RunResults, prev: RunResults): { compared: number; moves: Map<string, string[]>; added: number; removed: number } {
  const before = new Map(prev.cases.map((c) => [c.caseId, c.state]));
  const moves = new Map<string, string[]>();
  let compared = 0;
  let added = 0;
  for (const c of now.cases) {
    const was = before.get(c.caseId);
    if (was === undefined) { added++; continue; }
    compared++;
    if (was !== c.state) {
      const key = `${GLYPH[was]}→${GLYPH[c.state]}`;
      moves.set(key, [...(moves.get(key) ?? []), c.caseId]);
    }
  }
  return { compared, moves, added, removed: before.size - compared };
}

/** SUMMARY.md. `merged`: each layer's merged run, or null when its merge was refused or no shard ran. */
export function summary(merged: Record<Layer, RunResults | null>, judges: readonly JudgeInput[], previous: PreviousInput, now: Date): string {
  const views = viewsOf(merged);
  const out: string[] = ["# Matrix truth run summary", "", previousLine(previous, now), ""];

  // The verdict.
  const v = assess(views, judges);
  const present = views.filter((x) => x.run !== null);
  const faultTotal = views.reduce((n, x) => n + x.faults.length, 0);
  out.push(`Harness faults in this run: ${faultTotal === 0 ? `none (${present.length} of ${LAYERS.length} layers present)` : `${faultTotal} (${views.filter((x) => x.faults.length > 0).map((x) => `${x.layer} ${x.faults.length}`).join(", ")})`}.`, "");
  if (v.complete) out.push("**Run complete: yes** — every layer merged, no merged case is a harness fault, and a `judge faults` verdict (exit 0) is bound to each layer's merged run.", "");
  else out.push(`**Run complete: no** — ${v.reasons.join("; ")}.`, "");
  // Fixed text: ruling 61's three-run claim belongs to PR-B's `matrix:judge across`, never to one workflow run.
  out.push(`Harness-green: needs ${GREEN_RUNS} runs — \`matrix:judge across\` (PR-B Task 17)`, "");

  // The layers.
  out.push("## Layers", "", `| layer | scope | run | shards | cases | driven | ${CASE_STATES.filter((s) => s !== "not_run").map((s) => `${GLYPH[s]} ${s}`).join(" | ")} | ${GLYPH.not_run} planned | ${GLYPH.not_run} unplanned |`,
    `|${"---|".repeat(6 + CASE_STATES.length + 1)}`);
  for (const x of views) {
    if (x.run === null) { out.push(`| ${x.layer} | — | — | — | — | — | ${CASE_STATES.filter((s) => s !== "not_run").map(() => "—").join(" | ")} | — | — |`); continue; }
    const r = x.run;
    const count = (s: CaseState): number => r.cases.filter((c) => c.state === s).length;
    const planned = r.cases.filter((c) => c.state === "not_run" && c.planned === true).length;
    out.push(`| ${x.layer} | ${cell(r.scope ?? "—")} | ${cell(r.runId)} | ${r.shards ?? 1} | ${r.cases.length} | ${drivenOf(r).length} | ${CASE_STATES.filter((s) => s !== "not_run").map((s) => String(count(s))).join(" | ")} | ${planned} | ${count("not_run") - planned} |`);
  }
  out.push("");
  for (const x of views.filter((y) => y.run === null)) out.push(`- ${x.layer}: no merged run — its merge was refused, no shard ran, or its results are not a valid results file (see the merge step's log). A missing layer is never a pass.`);
  if (views.some((y) => y.run === null)) out.push("");

  // Planned ░ per atom (an atom is a case's scenario).
  out.push(`## Planned ${GLYPH.not_run} by atom`, "");
  let atomRows = 0;
  for (const x of present) {
    const byAtom = new Map<string, number>();
    for (const c of x.run!.cases) if (c.state === "not_run" && c.planned === true) byAtom.set(c.scenario, (byAtom.get(c.scenario) ?? 0) + 1);
    if (byAtom.size === 0) { out.push(`- ${x.layer}: no planned ${GLYPH.not_run} (every planned case is a 🚫, or the plan drives all it holds)`); continue; }
    const rows = [...byAtom].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.push(`**${x.layer}** — ${[...byAtom.values()].reduce((a, b) => a + b, 0)} planned ${GLYPH.not_run} across ${plural(byAtom.size, "atom")}:`, "", "| atom | planned |", "|---|---|");
    for (const [atom, n] of rows.slice(0, LIST_CAP * 4)) { out.push(`| ${cell(atom)} | ${n} |`); atomRows++; }
    if (rows.length > LIST_CAP * 4) out.push(`| … and ${rows.length - LIST_CAP * 4} more atoms | |`);
    out.push("");
  }
  if (atomRows === 0) out.push("");

  // Harness faults.
  out.push("## Harness faults", "");
  if (faultTotal === 0) out.push(`None in the ${plural(present.length, "layer")} present: no crash, harness error, vacuous red, setup refusal or unplanned ${GLYPH.not_run} (D6; planned ${GLYPH.not_run} allowed, ruling 65).`, "");
  for (const x of views.filter((y) => y.faults.length > 0)) {
    const kinds = new Map<string, number>();
    for (const f of x.faults) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    out.push(`**${x.layer}** — ${plural(x.faults.length, "fault")}: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}`, "");
    for (const f of x.faults.slice(0, LIST_CAP)) out.push(`- [${f.kind}] \`${f.caseId}\` — ${clip(f.reason)}`);
    if (x.faults.length > LIST_CAP) out.push(`- … and ${x.faults.length - LIST_CAP} more`);
    out.push("");
  }

  // Timings: driven cases only (a planned case has durationMs 0 and is not a measurement).
  out.push("## Timings (driven cases only)", "", "| layer | driven | p50 | p90 | max |", "|---|---|---|---|---|");
  for (const x of views) {
    const ms = x.run === null ? [] : drivenOf(x.run).map((c) => c.durationMs).sort((a, b) => a - b);
    out.push(ms.length === 0 ? `| ${x.layer} | ${ms.length} | — | — | — |` : `| ${x.layer} | ${ms.length} | ${seconds(percentile(ms, 50))} | ${seconds(percentile(ms, 90))} | ${seconds(ms[ms.length - 1])} |`);
  }
  out.push("");

  // The judge verdicts.
  out.push("## Judge verdicts", "");
  if (judges.length === 0) out.push("No `--judge` file was given.");
  for (const j of judges) {
    if ("refused" in j) out.push(`- \`${j.path}\`: judge refused — ${j.refused}. It is no verdict, and the run is not complete.`);
    else if (j.out.layer === null) out.push(`- \`${j.path}\`: ${j.out.mode} names no layer; it binds to none of this run's layers.`);
  }
  for (const line of v.lines) out.push(line);
  out.push("");

  // The weekly diff (D20).
  out.push("## Weekly diff (informational)", "");
  if (previous === null) out.push("No weekly diff: there is no previous complete run yet.");
  else if ("unavailable" in previous) out.push("No weekly diff this time: the previous run could not be read.");
  else {
    let compared = 0;
    let moved = 0;
    const lines: string[] = [];
    for (const x of present) {
      const prev = previous.layers[x.layer];
      if (prev === undefined) { lines.push(`- ${x.layer}: the previous run's merged results hold no ${x.layer}, so nothing compares.`); continue; }
      const d = diffLayer(x.run!, prev);
      compared += d.compared;
      moved += [...d.moves.values()].reduce((n, ids) => n + ids.length, 0);
      lines.push(`- ${x.layer}: ${d.compared} cases in both runs${d.added + d.removed > 0 ? `, ${d.added} added and ${d.removed} removed since` : ""}${d.moves.size === 0 ? ", no state changed" : ""}`);
      for (const [key, ids] of [...d.moves].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
        lines.push(`  - ${key} (${ids.length}): ${ids.slice(0, LIST_CAP).map((id) => `\`${id}\``).join(", ")}${ids.length > LIST_CAP ? `, … and ${ids.length - LIST_CAP} more` : ""}`);
      }
    }
    if (compared === 0) out.push(`Nothing to compare with run ${previous.runId}: it shares no case with this run.`, "");
    else if (moved === 0) out.push(`No state changed in the ${compared} cases both runs hold (compared with run ${previous.runId}).`, "");
    else out.push(`${plural(moved, "case")} changed state since run ${previous.runId} (${compared} compared):`, "");
    out.push(...lines);
  }
  out.push("");
  return redact(out.join("\n"));
}

// --- the CLI ---------------------------------------------------------------------------------------------------

export interface SummaryDeps { gh: GhRunner; env: Readonly<Record<string, string | undefined>>; now: () => Date }
const realDeps = (): SummaryDeps => ({ gh: realGh, env: process.env, now: () => new Date() });

/** Each layer's `<dir>/<layer>/results.json`, or null with why. Only a v3 run is a layer's merged run. */
function readLayers(dir: string): { layers: Record<Layer, RunResults | null>; notes: string[] } {
  const layers = { L1: null, L2: null, L3: null } as Record<Layer, RunResults | null>;
  const notes: string[] = [];
  for (const layer of LAYERS) {
    const file = join(dir, layer, "results.json");
    try {
      const run = parseResults(JSON.parse(readFileSync(file, "utf8")));
      if (run.schemaVersion !== 3) throw new Error("not a v3 run");
      if (run.layer !== layer) throw new Error(`holds layer ${run.layer}, not ${layer}`);
      layers[layer] = run;
    } catch (e) {
      notes.push(`${layer}: ${file} — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return { layers, notes };
}

function readJudge(path: string): JudgeInput {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch {
    return { path, refused: "the file is missing — a refused judge writes none, so this run has no verdict from it" };
  }
  try {
    const out = parseJudgeOut(JSON.parse(text));
    const bad = consistent(out);
    return bad === null ? { path, out } : { path, refused: `the verdict contradicts itself (${bad})` };
  } catch {
    return { path, refused: "the file is not a judge verdict (--json-out of matrix:judge)" };
  }
}

/** `--previous-run auto`: the newest successful scheduled/dispatch run that is not this one, its merged artifact read. */
function previousAuto(deps: SummaryDeps): PreviousInput {
  let tmp: string | null = null;
  try {
    const repo = deps.env.GITHUB_REPOSITORY;
    const thisRun = Number(deps.env.GITHUB_RUN_ID);
    const prev = weeklySuccesses(successfulRuns(deps.gh, repo)).find((r) => r.id !== thisRun);
    if (prev === undefined) return null;
    tmp = mkdtempSync(join(tmpdir(), "matrix-prev-"));
    downloadMerged(deps.gh, repo, prev.id, tmp);
    const { layers } = readLayers(tmp);
    const read = Object.fromEntries(LAYERS.flatMap((l) => (layers[l] === null ? [] : [[l, layers[l]]]))) as Partial<Record<Layer, RunResults>>;
    if (Object.keys(read).length === 0) return { unavailable: `run ${prev.id}'s merged artifact holds no layer results (expired, or not a merged artifact)` };
    return { runId: prev.id, date: prev.created_at, layers: read };
  } catch (e) {
    if (e instanceof GhFailed) return { unavailable: redact(e.message) };
    throw e;
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }
}

export function main(argv: readonly string[], deps: SummaryDeps = realDeps()): number {
  const fail = (msg: string): number => { process.stderr.write(`${redact(`summary: ${msg}`)}\n`); return 2; };
  let args: { merged: string; judge: string[]; previous: "auto" | "none"; require: boolean; out: string };
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:summary -- <flags>`; a bare one is never a value.
    const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { merged: { type: "string" }, judge: { type: "string", multiple: true }, "previous-run": { type: "string" }, "require-complete": { type: "boolean" }, out: { type: "string" } }, strict: true, allowPositionals: false });
    const previous = values["previous-run"] ?? "none";
    if (values.merged === undefined || values.out === undefined) throw new Error("--merged and --out are both required");
    if (previous !== "auto" && previous !== "none") throw new Error(`--previous-run is auto or none, got ${previous}`);
    args = { merged: values.merged, judge: values.judge ?? [], previous, require: values["require-complete"] === true, out: values.out };
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const { layers, notes } = readLayers(args.merged);
  for (const n of notes) process.stderr.write(`${redact(`summary: no merged run — ${n}`)}\n`);
  const judges = args.judge.map(readJudge);
  const text = summary(layers, judges, args.previous === "auto" ? previousAuto(deps) : null, deps.now());
  try {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text);
  } catch (e) {
    return fail(`${args.out} cannot be written — ${e instanceof Error ? e.message : String(e)}`);
  }
  process.stdout.write(`summary: wrote ${args.out} (${LAYERS.filter((l) => layers[l] !== null).length} of ${LAYERS.length} layers)\n`);
  if (args.require && !runComplete(layers, judges)) {
    process.stderr.write("summary: the run is not complete (exit 1: --require-complete); the reasons are on the page\n");
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
