// Changed-lines Stryker (W2a Task 0b). `STRYKER_MUTATE` names `src/<file>:<a>-<b>` ranges; stryker.config.mjs mutates
// exactly those (perTest coverage, never incremental, report reports/mutation/changed.json), so an engine task mutates the
// lines it changed. Unset, nothing changes: test/stryker-changed-lines.test.ts holds every group's config equal to the
// committed pre-0b snapshot (test/stryker-config-groups.snap.json, written by `--snapshot` below from the unedited config).
//
//   node scripts/stryker-changed.mjs --base <ref>            the STRYKER_MUTATE value for `git diff -U0 <ref> -- src`, plus
//                                                            every NEW untracked src file whole (git diff cannot see those);
//                                                            only measured source (notMutable), each skipped file on stderr
//   node scripts/stryker-changed.mjs --report <changed.json> --expect "<ranges>"
//                                                            one row per mutant with its killers by name; exits 1 on any
//                                                            Survived or NoCoverage, 2 on a report that holds no mutant or
//                                                            is not the run of <ranges> (reportScopeProblems)
//   node scripts/stryker-changed.mjs --snapshot <out.json>   every group's config in snapshot form (snapshotForm)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join, matchesGlob } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveGroup } from "./stryker-cuts.mjs";
import { STRYKER_EXCLUDED, STRYKER_GROUPS, STRYKER_PLACEMENT_OUT_OF_SCOPE, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";

const TEST_FILE = /\.test\.tsx?$/;
/** What Stryker can parse and mutate: it has no parser for .json or .md ("No parser registered"), and a declaration file has no code. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const TESTS_DIR = /(?:^|\/)__tests__\//;
/** What the weekly legs never measure, read from stryker.groups.mjs (one source): its named exclusions and ruling 67's placement files. */
const NOT_MEASURED = [...Object.keys(STRYKER_EXCLUDED), ...Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE)];

/** Why `file` (relative to packages/engine) is never mutated, or null when it is measured source. @param {string} file */
function notMutable(file) {
  if (!file.startsWith("src/")) return "outside src/";
  if (TEST_FILE.test(file)) return "a test file";
  if (!SOURCE.test(file) || DECLARATION.test(file)) return "not mutable source (.ts/.tsx/.mts/.cts/.js/.mjs, never a declaration file)";
  if (TESTS_DIR.test(file)) return "a __tests__ helper";
  const glob = NOT_MEASURED.find((g) => matchesGlob(file, g));
  if (glob !== undefined) return `excluded from mutation by stryker.groups.mjs (${glob})`;
  return null;
}

/** `STRYKER_MUTATE` → the `mutate` list, every entry checked. @param {string} value @param {string} engine @returns {string[]} */
export function parseMutateRanges(value, engine) {
  const entries = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) throw new Error("STRYKER_MUTATE is set but names no range: refusing a run that mutates nothing");
  return entries.map((e) => {
    const m = /^(.+):(\d+)-(\d+)$/.exec(e);
    if (m === null) throw new Error(`STRYKER_MUTATE entry "${e}" is not <src path>:<a>-<b>`);
    const [, file, a, b] = /** @type {[string, string, string, string]} */ (m);
    const why = notMutable(file);
    if (why !== null) throw new Error(`STRYKER_MUTATE entry "${e}" is ${why}`);
    if (!existsSync(join(engine, file))) throw new Error(`STRYKER_MUTATE entry "${e}": ${file} does not exist`);
    if (Number(a) < 1 || Number(b) < Number(a)) throw new Error(`STRYKER_MUTATE entry "${e}" is reversed or starts before line 1`);
    return `${file}:${a}-${b}`;
  });
}

/** `git diff -U0` text → the new-side line ranges of the measured source files under packages/engine/src; every other file
 *  the diff names is handed to `onSkip` with the reason. @param {string} diff @param {(file: string, why: string) => void} [onSkip] */
export function rangesFromDiff(diff, onSkip = () => {}) {
  /** @type {string[]} */ const out = [];
  /** @type {string | null} */ let file = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/packages\/engine\/(src\/.+)$/.exec(line);
    if (f) {
      const why = notMutable(f[1]);
      if (why !== null) onSkip(f[1], why);
      file = why === null ? f[1] : null;
      continue;
    }
    if (line.startsWith("+++ ")) { file = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file !== null) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) out.push(`${file}:${start}-${start + count - 1}`);
    }
  }
  return out;
}

/** Untracked src files (new in the working tree, so `git diff <ref>` cannot see them) → whole-file ranges of the measured
 *  source among them; the rest go to `onSkip`. @param {{ path: string; lines: number }[]} files
 *  @param {(file: string, why: string) => void} [onSkip] */
export function rangesFromUntracked(files, onSkip = () => {}) {
  /** @type {string[]} */ const out = [];
  for (const f of files) {
    const why = notMutable(f.path);
    if (why !== null) { onSkip(f.path, why); continue; }
    if (f.lines > 0) out.push(`${f.path}:1-${f.lines}`);
  }
  return out;
}

/** A group's config as the snapshot holds it. Two of its values are not the config's own text: `mutate` resolves a split file's
 *  parts to line ranges from that file's CURRENT source (scripts/stryker-cuts.mjs), so any edit to boardgame.ts moves them, and
 *  `concurrency` comes from this machine's cores and memory (CI's runner gets another figure). Each is replaced by the expression
 *  that produced it, and only when it equals that expression's value here; any other value is kept, so the comparison sees it.
 *  @param {Record<string, unknown>} config @param {string} group @param {string} engine @returns {Record<string, unknown>} */
export function snapshotForm(config, group, engine) {
  const out = { ...config };
  if (isDeepStrictEqual(out.mutate, resolveGroup(group, engine))) out.mutate = `<resolveGroup(${group})>`;
  const machine = strykerConcurrency({ cores: availableParallelism(), memBytes: totalmem(), workersPerSandbox: STRYKER_VITEST_WORKERS });
  if (out.concurrency === machine) out.concurrency = "<strykerConcurrency(this machine)>";
  return out;
}

/** Every group's config in snapshot form, loaded in THIS process as Stryker loads it (plain node), one fresh evaluation of the
 *  config per group (a query string re-evaluates the module, as test/stryker-groups.test.ts loads it), STRYKER_MUTATE unset.
 *  It sets process.env, so only the --snapshot CLI calls it, in a process of its own. @param {string} engine */
async function groupConfigs(engine) {
  delete process.env.STRYKER_MUTATE;
  /** @type {Record<string, string>} */ const out = {};
  for (const g of Object.keys(STRYKER_GROUPS)) {
    process.env.STRYKER_GROUP = g;
    const config = (await import(`${pathToFileURL(join(engine, "stryker.config.mjs")).href}?g=${encodeURIComponent(g)}`)).default;
    out[g] = JSON.stringify(snapshotForm(config, g, engine));
  }
  return out;
}

/** The ways a Stryker report is not the run of `ranges` (`file:a-b`, as parseMutateRanges returns them): a mutant outside every
 *  range, or a range whose file the report holds no entry for. Stryker writes the report only when a run completes and reports/
 *  is gitignored, so a report left by an EARLIER run stays until the next run finishes. @param {string[]} ranges @returns {string[]} */
export function reportScopeProblems(report, ranges) {
  const files = report.files ?? {};
  const parsed = ranges.map((r) => {
    const [, file, a, b] = /** @type {[string, string, string, string]} */ (/^(.+):(\d+)-(\d+)$/.exec(r));
    return { file, a: Number(a), b: Number(b) };
  });
  const problems = [];
  for (const [file, f] of Object.entries(files)) for (const m of f.mutants ?? []) {
    const line = m.location.start.line;
    if (!parsed.some((r) => r.file === file && line >= r.a && line <= r.b)) problems.push(`mutant ${m.id} at ${file}:${line} lies outside every expected range`);
  }
  for (const r of parsed) if (!Object.hasOwn(files, r.file)) problems.push(`expected range ${r.file}:${r.a}-${r.b}: the report holds no entry for ${r.file}`);
  return problems;
}

/** Stryker's mutation-testing-report JSON → one row per mutant, killers by NAME. */
export function verdictsFromReport(report) {
  const names = new Map();
  for (const tf of Object.values(report.testFiles ?? {})) for (const t of tf.tests ?? []) names.set(t.id, t.name);
  const rows = [];
  for (const [file, f] of Object.entries(report.files ?? {})) for (const m of f.mutants ?? [])
    rows.push({ file, line: m.location.start.line, mutator: m.mutatorName, status: m.status, killedBy: (m.killedBy ?? []).map((id) => names.get(id) ?? id) });
  return { rows, failures: rows.filter((r) => r.status === "Survived" || r.status === "NoCoverage").length };
}

/** @param {string} text */
const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

// No top-level await below: --snapshot imports stryker.config.mjs, which imports this file, and a module still awaiting at its
// top level would be a dependency that never finishes evaluating.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
  const base = at("--base");
  const report = at("--report");
  const snapshot = at("--snapshot");
  const engine = join(import.meta.dirname, "..");
  if (snapshot !== undefined) {
    groupConfigs(engine).then(
      (configs) => writeFileSync(snapshot, JSON.stringify(configs, null, 2) + "\n"),
      (e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); },
    );
  } else if (base !== undefined) {
    // The prefixes and colour are stated, so a user's diff.noprefix / color.ui setting cannot hide every hunk from the parser.
    // A golden-corpus append is megabytes of diff: execFileSync's 1 MB default dies with ENOBUFS (measured: 2.4 MB against ae22fbab7^).
    const git = { cwd: engine, encoding: "utf8", maxBuffer: 1024 ** 3 };
    const diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", base, "--", "src"], git);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], git)
      .split("\n").filter((p) => p !== "").map((p) => ({ path: p, lines: lineCount(readFileSync(join(engine, p), "utf8")) }));
    const skip = (file, why) => process.stderr.write(`skipped ${file}: ${why}\n`);
    const ranges = [...rangesFromDiff(diff, skip), ...rangesFromUntracked(untracked, skip)];
    if (ranges.length === 0) { process.stderr.write(`no changed engine src lines against ${base}\n`); process.exit(2); }
    process.stdout.write(ranges.join(","));
  } else if (report !== undefined) {
    const expected = at("--expect");
    if (expected === undefined) {
      process.stderr.write(`--report needs --expect "<this run's STRYKER_MUTATE ranges>": without it a changed.json left by an earlier run would be judged as this one\n`);
      process.exit(2);
    }
    let ranges;
    try { ranges = parseMutateRanges(expected, engine); } catch (e) { process.stderr.write(`--expect: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); }
    const json = JSON.parse(readFileSync(report, "utf8"));
    const problems = reportScopeProblems(json, ranges);
    if (problems.length > 0) {
      process.stderr.write(`${report} is not this run's report (--expect ${expected}): ${problems.length} problem(s)\n${problems.slice(0, 10).map((p) => `  ${p}\n`).join("")}`);
      process.exit(2);
    }
    const v = verdictsFromReport(json);
    if (v.rows.length === 0) { process.stderr.write("the report holds zero mutants: refusing a vacuous pass\n"); process.exit(2); }
    for (const r of v.rows) process.stdout.write(`${r.file}:${r.line} ${r.mutator} ${r.status}${r.killedBy.length ? ` by ${r.killedBy.join("; ")}` : ""}\n`);
    const count = (s) => v.rows.filter((r) => r.status === s).length;
    process.stdout.write(`${JSON.stringify({ mutants: v.rows.length, killed: count("Killed"), timeout: count("Timeout"), survived: count("Survived"), noCoverage: count("NoCoverage") })}\n`);
    process.exit(v.failures === 0 ? 0 : 1);
  } else {
    process.stderr.write("usage: stryker-changed.mjs --base <ref> | --report <changed.json> --expect <ranges> | --snapshot <out.json>\n");
    process.exit(2);
  }
}
