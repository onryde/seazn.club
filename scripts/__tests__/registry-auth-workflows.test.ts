// Engine split 2b, Task A2 (plan Review Focus 1): @seazn/engine is `npm:@onryde/seazn-engine@^1.0.0`, served by GitHub
// Packages, so a `pnpm install` with no registry credential is a 401 on the first engine tarball. stg.yml and prod.yml run
// only after a merge or a tag, and e2e.yml only on a push to main or a dispatch, so an install left without one is first
// seen red on main. This sweep reads every workflow and holds every install step to the three things the credential needs:
//
//   1. a user-level npmrc that references it. pnpm 10.34 ignores an auth line in the project .npmrc ("Ignored project-level
//      auth setting"), so the job's actions/setup-node step writes one, with `registry-url` and `scope`, before the install;
//   2. the token itself, NODE_AUTH_TOKEN, in the install step's own `env:` (and nowhere wider: no workflow or job env);
//   3. a GITHUB_TOKEN that may read packages: `packages: read` in the job's permissions, or the workflow's when the job has
//      no block of its own (a job-level block replaces the workflow's, it does not add to it). A called workflow's token is
//      capped by its caller's job, so a job that calls a workflow which installs grants `packages: read` too.
//
// There is no YAML dependency at the repo root (and none is added: W1d review I8), so the parse accepts the one layout these
// workflows are written in. Every install line the raw text holds must be one the step parse found, so a step in a shape the
// parse does not read is a red here, never a silent skip.
//
// Single-sport reason: no sport is involved; this is the CI wiring of the registry credential.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIR = path.join(ROOT, ".github/workflows");
const REGISTRY = "https://npm.pkg.github.com";
const SCOPE = "@onryde";
/** The job's own GITHUB_TOKEN, by either of its two spellings. */
const TOKENS: ReadonlySet<string> = new Set(["${{ secrets.GITHUB_TOKEN }}", "${{ github.token }}"]);
/** A command that installs: pnpm or npm, any words, then `install`, `i`, `ci` or `add` as a word of its own. */
const INSTALL = /(?:^|[\s;&|(])p?npm\s+(?:[^\s;&|#]+\s+)*?(?:install|i|ci|add)(?=$|[\s;&|)])/;

type Perms = Readonly<Record<string, string>> | "read-all" | "write-all";
interface Step { line: number; uses: string | null; run: string[]; with: Record<string, string>; env: Record<string, string> }
interface Job { name: string; permissions: Perms | null; uses: string | null; env: Record<string, string>; steps: Step[] }
interface Workflow { file: string; permissions: Perms | null; env: Record<string, string>; jobs: Job[]; installLines: number }

const indentOf = (l: string): number => l.length - l.trimStart().length;
const isComment = (l: string): boolean => /^\s*#/.test(l);
/** A line with its trailing ` # comment` dropped (`uses: actions/setup-node@v5 # why` keeps only the action). */
const code = (l: string): string => l.replace(/\s+#.*$/, "");
const unquote = (v: string): string => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** The `key: value` lines at exactly `indent` under the block opened at `at`, until the block ends. */
function mapAt(lines: string[], at: number, indent: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" || isComment(l)) continue;
    if (indentOf(l) < indent) break;
    const m = new RegExp(`^ {${indent}}([\\w-]+):\\s*(.*)$`).exec(code(l));
    if (m !== null) out[m[1]!] = unquote(m[2]!);
  }
  return out;
}

/** A `permissions:` key at `indent`: a scalar (`read-all`, `{}`) or the map under it. null when the block has no such key. */
function permsAt(lines: string[], from: number, to: number, indent: number): Perms | null {
  for (let i = from; i < to; i++) {
    const m = new RegExp(`^ {${indent}}permissions:\\s*(.*)$`).exec(code(lines[i]!));
    if (m === null) continue;
    const scalar = unquote(m[1]!);
    if (scalar === "read-all" || scalar === "write-all") return scalar;
    if (scalar === "{}") return {};
    if (scalar !== "") throw new Error(`permissions: ${scalar} is not a shape this parse reads (line ${i + 1})`);
    return mapAt(lines, i, indent + 2);
  }
  return null;
}

function envAt(lines: string[], from: number, to: number, indent: number): Record<string, string> {
  for (let i = from; i < to; i++) if (new RegExp(`^ {${indent}}env:\\s*$`).test(code(lines[i]!))) return mapAt(lines, i, indent + 2);
  return {};
}

function parseSteps(lines: string[], from: number, to: number): Step[] {
  const heads: number[] = [];
  for (let i = from; i < to; i++) if (/^ {6}- /.test(lines[i]!)) heads.push(i);
  return heads.map((at, n) => {
    const end = heads[n + 1] ?? to;
    // The step's own lines: its head (rewritten as an ordinary key line) and everything deeper, comments dropped.
    const own = [`        ${lines[at]!.slice(8)}`, ...lines.slice(at + 1, end)];
    const step: Step = { line: at + 1, uses: null, run: [], with: {}, env: {} };
    for (let i = 0; i < own.length; i++) {
      const l = own[i]!;
      if (isComment(l)) continue;
      const m = /^ {8}([\w-]+):\s*(.*)$/.exec(code(l));
      if (m === null) continue;
      const [, key, value] = m as unknown as [string, string, string];
      if (key === "uses") step.uses = unquote(value);
      if (key === "with") step.with = mapAt(own, i, 10);
      if (key === "env") step.env = mapAt(own, i, 10);
      if (key === "run") {
        if (/^[|>][-+]?$/.test(value.trim())) {
          for (const r of own.slice(i + 1)) {
            if (r.trim() !== "" && indentOf(r) < 10) break;
            if (!isComment(r)) step.run.push(code(r));
          }
        } else step.run.push(value);
      }
    }
    return step;
  });
}

function parse(file: string): Workflow {
  const text = readFileSync(path.join(DIR, file), "utf8");
  const lines = text.split("\n");
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt === -1) throw new Error(`${file}: no \`jobs:\` key`);
  const topEnd = (from: number): number => {
    for (let i = from + 1; i < lines.length; i++) if (lines[i] !== "" && !lines[i]!.startsWith(" ") && !isComment(lines[i]!)) return i;
    return lines.length;
  };
  const jobsEnd = topEnd(jobsAt);
  const starts: number[] = [];
  for (let i = jobsAt + 1; i < jobsEnd; i++) if (/^ {2}[\w-]+:\s*$/.test(code(lines[i]!))) starts.push(i);
  if (starts.length === 0) throw new Error(`${file}: \`jobs:\` holds no job`);
  const jobs = starts.map((at, n): Job => {
    const end = starts[n + 1] ?? jobsEnd;
    const stepsAt = lines.slice(at, end).findIndex((l) => /^ {4}steps:\s*$/.test(code(l)));
    const usesLine = lines.slice(at, end).map(code).find((l) => /^ {4}uses:/.test(l));
    return {
      name: lines[at]!.trim().replace(/:.*$/, ""),
      permissions: permsAt(lines, at + 1, end, 4),
      uses: usesLine === undefined ? null : unquote(usesLine.replace(/^ {4}uses:/, "")),
      env: envAt(lines, at + 1, end, 4),
      steps: stepsAt === -1 ? [] : parseSteps(lines, at + stepsAt + 1, end),
    };
  });
  // Workflow-level keys sit at column 0, above `jobs:` or below it.
  const top = lines.map((l, i) => (/^[a-z]/.test(l) ? i : -1)).filter((i) => i !== -1 && i !== jobsAt);
  let permissions: Perms | null = null;
  let env: Record<string, string> = {};
  for (const i of top) {
    const p = permsAt(lines, i, i + 1, 0);
    if (p !== null) permissions = p;
    if (/^env:\s*$/.test(code(lines[i]!))) env = mapAt(lines, i, 2);
  }
  const installLines = lines.filter((l) => !isComment(l) && INSTALL.test(code(l))).length;
  return { file, permissions, env, jobs, installLines };
}

const grantsPackages = (p: Perms | null): boolean => p === "read-all" || p === "write-all" || (p !== null && (p.packages === "read" || p.packages === "write"));
const effective = (job: Job, wf: Workflow): Perms | null => job.permissions ?? wf.permissions;
const installs = (s: Step): number => s.run.filter((l) => INSTALL.test(l)).length;

const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const WORKFLOWS = FILES.map(parse);
const BY_FILE = new Map(WORKFLOWS.map((w) => [w.file, w]));

describe("every workflow install authenticates to GitHub Packages (engine split 2b, A2; plan Review Focus 1)", () => {
  it("every install step authenticates", () => {
    const problems: string[] = [];
    let checked = 0;
    let parsedLines = 0;
    const perFile: Record<string, number> = {};
    for (const wf of WORKFLOWS) {
      for (const job of wf.jobs) {
        job.steps.forEach((step, n) => {
          const k = installs(step);
          if (k === 0) return;
          parsedLines += k;
          checked++;
          perFile[wf.file] = (perFile[wf.file] ?? 0) + 1;
          const where = `${wf.file}:${step.line} (job ${job.name})`;
          const token = step.env.NODE_AUTH_TOKEN;
          if (token === undefined || !TOKENS.has(token)) problems.push(`${where}: the install step's env sets NODE_AUTH_TOKEN to ${token === undefined ? "nothing" : JSON.stringify(token)}, want the job's GITHUB_TOKEN`);
          if (!grantsPackages(effective(job, wf))) problems.push(`${where}: the job's token cannot read packages (${job.permissions === null ? "workflow" : "job"}-level permissions ${JSON.stringify(effective(job, wf))})`);
          const node = job.steps.slice(0, n).filter((s) => (s.uses ?? "").startsWith("actions/setup-node@")).at(-1);
          if (node === undefined) problems.push(`${where}: no actions/setup-node step before the install writes the user-level npmrc`);
          else if (node.with["registry-url"] !== REGISTRY || node.with.scope !== SCOPE) problems.push(`${where}: the setup-node step at line ${node.line} has registry-url ${JSON.stringify(node.with["registry-url"])} and scope ${JSON.stringify(node.with.scope)}, want ${REGISTRY} and ${SCOPE}`);
        });
      }
    }
    expect(problems).toEqual([]);
    // The step parse found every install line the raw text holds (a step in a shape it does not read would hide one).
    const rawLines = WORKFLOWS.reduce((n, w) => n + w.installLines, 0);
    expect(parsedLines, `install lines found in steps vs in the raw text, per file ${JSON.stringify(perFile)}`).toBe(rawLines);
    expect(checked, `install steps checked, per file ${JSON.stringify(perFile)}`).toBeGreaterThan(0);
  });

  it("a job that calls a workflow which installs grants packages: read (a called workflow's token is capped by its caller's job)", () => {
    const problems: string[] = [];
    let callers = 0;
    for (const wf of WORKFLOWS) {
      for (const job of wf.jobs) {
        const m = /^\.\/\.github\/workflows\/([^@\s]+)$/.exec(job.uses ?? "");
        if (m === null) continue;
        const called = BY_FILE.get(m[1]!);
        if (called === undefined) { problems.push(`${wf.file} job ${job.name} calls ${m[1]}, which is not in .github/workflows`); continue; }
        if (!called.jobs.some((j) => j.steps.some((s) => installs(s) > 0))) continue;
        callers++;
        if (!grantsPackages(effective(job, wf))) problems.push(`${wf.file} job ${job.name} calls ${called.file}, which installs, with permissions ${JSON.stringify(effective(job, wf))}`);
      }
    }
    expect(problems).toEqual([]);
    // Zero checked is a failure: ci.yml's matrix-sample calls matrix-truth.yml. If the last such call is removed, remove this test.
    expect(callers, "caller jobs of a workflow that installs").toBeGreaterThan(0);
  });

  it("the token reaches the install steps alone: no workflow-level or job-level env sets NODE_AUTH_TOKEN", () => {
    const wide: string[] = [];
    let scanned = 0;
    for (const wf of WORKFLOWS) {
      scanned++;
      if ("NODE_AUTH_TOKEN" in wf.env) wide.push(`${wf.file}: workflow env`);
      for (const job of wf.jobs) {
        scanned++;
        if ("NODE_AUTH_TOKEN" in job.env) wide.push(`${wf.file} job ${job.name}: job env`);
      }
    }
    expect(wide).toEqual([]);
    expect(scanned, "workflow and job env blocks scanned").toBeGreaterThan(FILES.length);
  });
});
