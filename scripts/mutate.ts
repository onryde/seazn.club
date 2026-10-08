// Hand-mutant runner (W2a Task 0a; R17, RULES.md "report the killer list"). For EACH mutant, alone: apply exactly one
// edit, run ONLY its named killers, record KILLED (with the killing tests' names), SURVIVED, or COLLECT_FAILED (the
// killer could not even collect, so no assertion judged the mutant), write the saved original bytes back and verify
// them, then the next. Never two mutants at once: a grouped mutant hides a survivor.
// Restores by writing the bytes it read, never `git checkout`: the file under test is usually the task's own
// UNCOMMITTED work, which a checkout would discard.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { isMainModule } from "./lib/main-module.ts";

export interface Killer { cwd: string; files: string[]; name?: string }
/** `collectFailOk`: why this mutant is MEANT to stop its killers collecting (a deliberate type-level change). Without it a
 *  collection failure fails the run: a syntax error from a bad `replace` is not evidence about the guard. */
export interface Mutant { id: string; file: string; find: string; replace: string; killers: Killer[]; collectFailOk?: string }
export type Verdict =
  | { id: string; state: "KILLED"; killedBy: string[] }
  | { id: string; state: "SURVIVED" }
  | { id: string; state: "COLLECT_FAILED"; detail: string; accepted?: string };
export interface RunResult { exitCode: 0 | 1 | 2; verdicts: Verdict[]; error?: string }

interface VitestJson {
  numTotalTests: number; numPassedTests: number; numFailedTests: number; numFailedTestSuites: number;
  testResults: { name: string; status?: string; message?: string; assertionResults: { title: string; fullName: string; status: string }[] }[];
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

/** vitest colours its transform errors (ESC [ ... m); a terminal or a markdown cell wants plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Why a suite failed to COLLECT: the first file-level failure message, on one line, safe inside a markdown table cell. */
function collectDetail(r: VitestJson): string {
  const message = r.testResults.find((f) => f.assertionResults.length === 0 && f.message !== undefined && f.message !== "")?.message;
  return (message ?? "a suite failed to collect").replace(ANSI, "").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 160);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const statOf = (path: string) => { try { return statSync(path); } catch { return undefined; } };

/** Every check that needs no spawn, before anything is touched. Exported so its refusals are tested without a vitest run.
 *  A killer's SHAPE decides what vitest runs: files [""] and a bare "t" are positional filters that match every test file
 *  in the cwd (the whole suite; owner-forbidden), and a string `files` spreads into one filter per character. So `files` must
 *  be an array of names of files that exist under the killer's cwd, and the list a JSON array: it may be hand-written JSON. */
export function validateMutants(mutants: unknown, repo: string): asserts mutants is readonly Mutant[] {
  if (!Array.isArray(mutants)) throw new Refused("the mutant list must be a JSON array of mutants");
  if (mutants.length === 0) throw new Refused("zero mutants: an empty list proves nothing (anti-vacuity)");
  const ids = new Set<string>();
  for (const [i, m] of (mutants as unknown[]).entries()) {
    if (!isObject(m)) throw new Refused(`mutant #${i} is not an object`);
    if (typeof m.id !== "string") throw new Refused(`mutant #${i}: id must be a string`);
    const id = m.id;
    if (ids.has(id)) throw new Refused(`duplicate mutant id ${id}`);
    ids.add(id);
    for (const field of ["file", "find", "replace"] as const) {
      if (typeof m[field] !== "string") throw new Refused(`${id}: ${field} must be a string`);
    }
    if (m.collectFailOk !== undefined && (typeof m.collectFailOk !== "string" || m.collectFailOk === "")) throw new Refused(`${id}: collectFailOk must be a non-empty string saying why a collection failure is intended`);
    if (!Array.isArray(m.killers)) throw new Refused(`${id}: killers must be an array`);
    if (m.killers.length === 0) throw new Refused(`${id}: names no killer`);
    for (const k of m.killers as unknown[]) {
      if (!isObject(k)) throw new Refused(`${id}: a killer must be an object`);
      if (typeof k.cwd !== "string") throw new Refused(`${id}: a killer's cwd must be a string`);
      if (!Array.isArray(k.files)) throw new Refused(`${id}: a killer's files must be an array of file names (a string spreads into one filter per character)`);
      if (k.files.length === 0) throw new Refused(`${id}: a killer with no files would run the WHOLE suite (never; AGENTS.md) — name the test files`);
      if (k.name !== undefined && (typeof k.name !== "string" || k.name === "")) throw new Refused(`${id}: a killer's -t name must be a non-empty string`);
      const cwd = resolve(repo, k.cwd);
      if (statOf(cwd)?.isDirectory() !== true) throw new Refused(`${id}: killer cwd ${k.cwd} is not a directory`);
      for (const file of k.files as unknown[]) {
        if (typeof file !== "string" || file === "") throw new Refused(`${id}: a killer file must be a non-empty string (the empty string is a filter that matches EVERY test file)`);
        const found = statOf(resolve(cwd, file));
        if (found === undefined) throw new Refused(`${id}: killer file ${file} does not exist under ${k.cwd} (a typo'd path is not a kill)`);
        if (!found.isFile()) throw new Refused(`${id}: killer file ${file} under ${k.cwd} is not a file (a directory is a filter that matches everything below it)`);
      }
    }
    if (statOf(resolve(repo, m.file as string))?.isFile() !== true) throw new Refused(`${id}: mutant file ${m.file as string} does not exist (or is not a file)`);
    const n = occurrences(readFileSync(resolve(repo, m.file as string), "utf8"), m.find as string);
    if (n !== 1) throw new Refused(`${id}: find ${JSON.stringify(m.find)} matches ${n} times in ${m.file as string} (exactly 1 required)`);
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
        let collectFailure: string | undefined;
        for (const k of m.killers) {
          const r = await runKiller(opts.repo, k);
          if (r.numPassedTests === 0 && r.numFailedTests === 0 && r.numFailedTestSuites === 0) throw new Refused(`${m.id}: killer ran no test under the mutant`);
          killedBy.push(...failedNames(r));
          // A failed suite beside no failed test is a suite that never collected. Only read when nothing else killed the mutant.
          if (r.numFailedTestSuites > 0) collectFailure ??= collectDetail(r);
        }
        verdicts.push(
          killedBy.length > 0 ? { id: m.id, state: "KILLED", killedBy }
          : collectFailure !== undefined ? { id: m.id, state: "COLLECT_FAILED", detail: collectFailure, ...(m.collectFailOk === undefined ? {} : { accepted: m.collectFailOk }) }
          : { id: m.id, state: "SURVIVED" },
        );
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        restore();
      }
    }
    const settled = (v: Verdict) => v.state === "KILLED" || (v.state === "COLLECT_FAILED" && v.accepted !== undefined);
    return { exitCode: verdicts.every(settled) ? 0 : 1, verdicts };
  } catch (e) {
    if (e instanceof Refused) return { exitCode: 2, verdicts, error: e.message };
    throw e;
  }
}

function verdictCell(v: Verdict): string {
  if (v.state === "KILLED") return `KILLED by ${v.killedBy.join("; ")}`;
  if (v.state === "SURVIVED") return "**SURVIVED**";
  return v.accepted === undefined ? `**COLLECT_FAILED** — ${v.detail}` : `COLLECT_FAILED (accepted: ${v.accepted}) — ${v.detail}`;
}

export function table(verdicts: readonly Verdict[]): string {
  return ["| mutant | verdict |", "|---|---|", ...verdicts.map((v) => `| ${v.id} | ${verdictCell(v)} |`)].join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const list = at("--list");
  if (list === undefined) { console.error("usage: pnpm mutate --list <mutants.json> [--json-out <file>]"); process.exit(2); }
  const repo = resolve(import.meta.dirname, "..");
  const r = await runMutants(JSON.parse(readFileSync(resolve(list), "utf8")) as Mutant[], { repo }); // validateMutants checks the real shape
  console.log(table(r.verdicts));
  if (r.error) console.error(`REFUSED: ${r.error}`);
  const out = at("--json-out");
  if (out !== undefined) writeFileSync(out, JSON.stringify(r, null, 2));
  process.exit(r.exitCode);
}
