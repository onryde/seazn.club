// Changed-lines Stryker (W2a Task 0b). `STRYKER_MUTATE` names `src/<file>:<a>-<b>` ranges; stryker.config.mjs mutates
// exactly those (perTest coverage, never incremental, report reports/mutation/changed.json), so an engine task mutates the
// lines it changed. Unset, nothing changes: test/stryker-changed-lines.test.ts holds every group's config equal to the
// committed pre-0b snapshot (test/stryker-config-groups.snap.json, written by `--snapshot` below from the unedited config).
//
//   node scripts/stryker-changed.mjs --base <ref>            the STRYKER_MUTATE value for `git diff -U0 <ref> -- src`, plus
//                                                            every NEW untracked src file whole (git diff cannot see those)
//   node scripts/stryker-changed.mjs --report <changed.json> one row per mutant with its killers by name; exits 1 on any
//                                                            Survived or NoCoverage, 2 on a report that holds no mutant
//   node scripts/stryker-changed.mjs --snapshot <out.json>   every group's config in snapshot form (snapshotForm)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveGroup } from "./stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";

const TEST_FILE = /\.test\.tsx?$/;

/** `STRYKER_MUTATE` → the `mutate` list, every entry checked. @param {string} value @param {string} engine @returns {string[]} */
export function parseMutateRanges(value, engine) {
  const entries = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) throw new Error("STRYKER_MUTATE is set but names no range: refusing a run that mutates nothing");
  return entries.map((e) => {
    const m = /^(.+):(\d+)-(\d+)$/.exec(e);
    if (m === null) throw new Error(`STRYKER_MUTATE entry "${e}" is not <src path>:<a>-<b>`);
    const [, file, a, b] = /** @type {[string, string, string, string]} */ (m);
    if (!file.startsWith("src/")) throw new Error(`STRYKER_MUTATE entry "${e}" is outside src/`);
    if (TEST_FILE.test(file)) throw new Error(`STRYKER_MUTATE entry "${e}" is a test file`);
    if (!existsSync(join(engine, file))) throw new Error(`STRYKER_MUTATE entry "${e}": ${file} does not exist`);
    if (Number(a) < 1 || Number(b) < Number(a)) throw new Error(`STRYKER_MUTATE entry "${e}" is reversed or starts before line 1`);
    return `${file}:${a}-${b}`;
  });
}

/** `git diff -U0` text → the new-side line ranges of non-test files under packages/engine/src. @param {string} diff */
export function rangesFromDiff(diff) {
  /** @type {string[]} */ const out = [];
  /** @type {string | null} */ let file = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/packages\/engine\/(src\/.+)$/.exec(line);
    if (f) { file = TEST_FILE.test(f[1]) ? null : f[1]; continue; }
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

/** Untracked src files (new in the working tree, so `git diff <ref>` cannot see them) → whole-file ranges.
 *  @param {{ path: string; lines: number }[]} files */
export function rangesFromUntracked(files) {
  return files.filter((f) => !TEST_FILE.test(f.path) && f.lines > 0).map((f) => `${f.path}:1-${f.lines}`);
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
    const diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", base, "--", "src"], { cwd: engine, encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], { cwd: engine, encoding: "utf8" })
      .split("\n").filter((p) => p !== "").map((p) => ({ path: p, lines: lineCount(readFileSync(join(engine, p), "utf8")) }));
    const ranges = [...rangesFromDiff(diff), ...rangesFromUntracked(untracked)];
    if (ranges.length === 0) { process.stderr.write(`no changed engine src lines against ${base}\n`); process.exit(2); }
    process.stdout.write(ranges.join(","));
  } else if (report !== undefined) {
    const v = verdictsFromReport(JSON.parse(readFileSync(report, "utf8")));
    if (v.rows.length === 0) { process.stderr.write("the report holds zero mutants: refusing a vacuous pass\n"); process.exit(2); }
    for (const r of v.rows) process.stdout.write(`${r.file}:${r.line} ${r.mutator} ${r.status}${r.killedBy.length ? ` by ${r.killedBy.join("; ")}` : ""}\n`);
    const count = (s) => v.rows.filter((r) => r.status === s).length;
    process.stdout.write(`${JSON.stringify({ mutants: v.rows.length, killed: count("Killed"), timeout: count("Timeout"), survived: count("Survived"), noCoverage: count("NoCoverage") })}\n`);
    process.exit(v.failures === 0 ? 0 : 1);
  } else {
    process.stderr.write("usage: stryker-changed.mjs --base <ref> | --report <changed.json> | --snapshot <out.json>\n");
    process.exit(2);
  }
}
