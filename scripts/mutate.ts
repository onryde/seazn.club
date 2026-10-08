// Hand-mutant runner (W2a Task 0a; R17, RULES.md "report the killer list"). For EACH mutant, alone: apply exactly one
// edit, run ONLY its named killers, record KILLED (with the killing tests' names) or SURVIVED, write the saved original
// bytes back and verify them, then the next. Never two mutants at once: a grouped mutant hides a survivor.
// Restores by writing the bytes it read, never `git checkout`: the file under test is usually the task's own
// UNCOMMITTED work, which a checkout would discard.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { isMainModule } from "./lib/main-module.ts";

export interface Killer { cwd: string; files: string[]; name?: string }
export interface Mutant { id: string; file: string; find: string; replace: string; killers: Killer[] }
export type Verdict = { id: string; state: "KILLED"; killedBy: string[] } | { id: string; state: "SURVIVED" };
export interface RunResult { exitCode: 0 | 1 | 2; verdicts: Verdict[]; error?: string }

interface VitestJson {
  numTotalTests: number; numPassedTests: number; numFailedTests: number; numFailedTestSuites: number;
  testResults: { name: string; assertionResults: { title: string; fullName: string; status: string }[] }[];
}

export class Refused extends Error {}

function occurrences(text: string, find: string): number {
  return find === "" ? 0 : text.split(find).length - 1;
}

/** The killer process in flight, so a signal can stop it before the file is restored. */
let inFlight: ChildProcess | undefined;
/** SIGTERM the whole process group: `pnpm exec vitest` and vitest's own workers, not only the direct child. */
function stopInFlight(): void {
  const pid = inFlight?.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
}

/** One vitest run of one killer: the engine's vitest binary at the repo root (CI's own recipe for scripts/ and
 *  tools/, ci.yml:257, :787), the workspace's own `pnpm exec vitest` inside a workspace. ASYNCHRONOUS on purpose: a
 *  synchronous spawn blocks the event loop for the whole run, so the SIGINT/SIGTERM handlers in runMutants could never
 *  fire while a killer was in flight and a `kill <pid>` was ignored until every mutant had finished. */
async function runKiller(repo: string, k: Killer): Promise<VitestJson> {
  const out = mkdtempSync(join(tmpdir(), "mutate-"));
  const file = join(out, "r.json");
  try {
    const cwd = resolve(repo, k.cwd);
    const args = ["run", ...k.files, ...(k.name === undefined ? [] : ["-t", k.name]), "--reporter=json", `--outputFile=${file}`, "--testTimeout=30000"];
    const [cmd, argv] = k.cwd === "." ? [join(repo, "packages/engine/node_modules/.bin/vitest"), args] : ["pnpm", ["exec", "vitest", ...args]];
    const ended = await new Promise<{ error?: Error; status: number | null; signal: NodeJS.Signals | null }>((done) => {
      // detached: the killer leads its own process group, which stopInFlight (and the timeout) signal as one.
      const child = spawn(cmd, argv, { cwd, stdio: "ignore", detached: true });
      inFlight = child;
      const timer = setTimeout(stopInFlight, 15 * 60_000);
      const finish = (r: { error?: Error; status: number | null; signal: NodeJS.Signals | null }) => { clearTimeout(timer); inFlight = undefined; done(r); };
      child.once("error", (error) => finish({ error, status: null, signal: null }));
      child.once("close", (status, signal) => finish({ status, signal }));
    });
    // Measured on vitest 4.1.11: a test-file filter that matches nothing STILL writes a report (zero tests), so a typo'd
    // path reaches the "passed no test" guard below. No report at all means the process never ran: a cwd that does not
    // exist (spawn ENOENT), a timeout, or a refused config.
    if (!existsSync(file)) throw new Refused(`killer ${k.cwd}:${k.files.join(",")} wrote no JSON report (${ended.error?.message ?? `exit ${ended.status}, signal ${ended.signal}`}: a cwd that does not exist, a timeout, or a refused config)`);
    return JSON.parse(readFileSync(file, "utf8")) as VitestJson;
  } finally { rmSync(out, { recursive: true, force: true }); }
}

function failedNames(r: VitestJson): string[] {
  return r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName));
}

/** Every check that needs no spawn, before anything is touched. Exported so its refusals are tested without a vitest run. */
export function validateMutants(mutants: readonly Mutant[], repo: string): void {
  if (mutants.length === 0) throw new Refused("zero mutants: an empty list proves nothing (anti-vacuity)");
  const ids = new Set<string>();
  for (const m of mutants) {
    if (ids.has(m.id)) throw new Refused(`duplicate mutant id ${m.id}`);
    ids.add(m.id);
    if (m.killers.length === 0) throw new Refused(`${m.id}: names no killer`);
    for (const k of m.killers) {
      if (k.files.length === 0) throw new Refused(`${m.id}: a killer with no files would run the WHOLE suite (never; AGENTS.md) — name the test files`);
    }
    const n = occurrences(readFileSync(resolve(repo, m.file), "utf8"), m.find);
    if (n !== 1) throw new Refused(`${m.id}: find ${JSON.stringify(m.find)} matches ${n} times in ${m.file} (exactly 1 required)`);
  }
}

export async function runMutants(mutants: readonly Mutant[], opts: { repo: string }): Promise<RunResult> {
  const verdicts: Verdict[] = [];
  try {
    validateMutants(mutants, opts.repo);
    // Baseline: every killer green and non-empty on the UNMUTATED tree, or every mutant would read KILLED.
    const seen = new Set<string>();
    for (const k of mutants.flatMap((m) => m.killers)) {
      const key = JSON.stringify(k);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await runKiller(opts.repo, k);
      if (r.numPassedTests === 0) throw new Refused(`killer ${k.cwd}:${k.files.join(",")}${k.name ? ` -t ${k.name}` : ""} passed no test on the baseline (a typo'd path or -t name)`);
      if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) throw new Refused(`killer baseline is red before any mutation: ${failedNames(r).join("; ") || "a suite failed to collect"}`);
    }
    for (const m of mutants) {
      const path = resolve(opts.repo, m.file);
      const original = readFileSync(path);
      const restore = () => {
        writeFileSync(path, original);
        if (!readFileSync(path).equals(original)) throw new Refused(`${m.file} was NOT restored byte-identical after ${m.id}`);
      };
      const onSignal = () => { stopInFlight(); try { restore(); } finally { process.exit(2); } };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        writeFileSync(path, original.toString("utf8").replace(m.find, () => m.replace));
        const killedBy: string[] = [];
        for (const k of m.killers) {
          const r = await runKiller(opts.repo, k);
          if (r.numPassedTests === 0 && r.numFailedTests === 0 && r.numFailedTestSuites === 0) throw new Refused(`${m.id}: killer ran no test under the mutant`);
          killedBy.push(...failedNames(r), ...(r.numFailedTestSuites > 0 && failedNames(r).length === 0 ? ["<suite failed to collect>"] : []));
        }
        verdicts.push(killedBy.length > 0 ? { id: m.id, state: "KILLED", killedBy } : { id: m.id, state: "SURVIVED" });
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        restore();
      }
    }
    return { exitCode: verdicts.every((v) => v.state === "KILLED") ? 0 : 1, verdicts };
  } catch (e) {
    if (e instanceof Refused) return { exitCode: 2, verdicts, error: e.message };
    throw e;
  }
}

function table(verdicts: readonly Verdict[]): string {
  return ["| mutant | verdict |", "|---|---|", ...verdicts.map((v) => `| ${v.id} | ${v.state === "KILLED" ? `KILLED by ${v.killedBy.join("; ")}` : "**SURVIVED**"} |`)].join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const list = at("--list");
  if (list === undefined) { console.error("usage: pnpm mutate --list <mutants.json> [--json-out <file>]"); process.exit(2); }
  const repo = resolve(import.meta.dirname, "..");
  const r = await runMutants(JSON.parse(readFileSync(resolve(list), "utf8")) as Mutant[], { repo });
  console.log(table(r.verdicts));
  if (r.error) console.error(`REFUSED: ${r.error}`);
  const out = at("--json-out");
  if (out !== undefined) writeFileSync(out, JSON.stringify(r, null, 2));
  process.exit(r.exitCode);
}
