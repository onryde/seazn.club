// Engine-split Task 1e-2 (D15, D26): the fold-epoch guard's CLI, SPAWNED against real git history. The rule itself is
// fold-epoch-guard.test.ts; what only a real repository can show is here: that `--against HEAD^1` reads the REAL baseline commit (the
// first parent of a PR merge ref, the previous commit of a plain one), that a root commit, a shallow clone and a nonexistent ref are
// refused rather than passed, that a table or a corpus that does not load is a refusal, and that a run which compared nothing fails.
//
// The scratch repository holds the REAL guard script, the REAL src/sport/fold-epoch.ts and the REAL golden corpora of every sport,
// copied from this tree; a "PR" is a commit that edits those the way a re-baseline would. Nothing here imports src/ (the spawned script
// reads files and git only), so a Stryker related-mode run of a sport file does not run these spawns. Expected counts (sports, streams)
// are read from the corpora on disk by this file, never from the guard's own output.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPORTS_DIR = "src/sports";
const EPOCH_FILE = "src/sport/fold-epoch.ts";
const GUARD = "scripts/fold-epoch-guard.ts";

interface Corpus { key: string; streams: Array<Record<string, unknown>> }

/** Every corpus file under src/sports, relative to it (`setbased/badminton.golden.json`). */
const CORPORA = (readdirSync(join(ENGINE, SPORTS_DIR), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).sort();
const KEYS = CORPORA.map((f) => basename(f, ".golden.json"));
const FIRST = KEYS[0] as string;
const LAST = KEYS[KEYS.length - 1] as string;
/** The files a scratch checkout needs: the real guard, the real package.json (type: module), the real table, the real corpora. */
const FILES = [GUARD, "package.json", EPOCH_FILE, ...CORPORA.map((f) => join(SPORTS_DIR, f))];

// Git must not see the parent's repository (a hook sets GIT_DIR) or its identity.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=epoch@example.invalid", "-c", "user.name=Epoch", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Runs the guard copied into `engineDir` (or, with `via`, through another path to it) the way pnpm does: from the engine directory. */
function run(engineDir: string, args: string[], cwd = engineDir, extra: { env?: NodeJS.ProcessEnv; via?: string } = {}) {
  const script = join(extra.via ?? engineDir, GUARD);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd, encoding: "utf8", timeout: SPAWN_MS, env: { ...cleanEnv(), ...extra.env } });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

let scratch = "";
let realSports = 0;
let realStreams = 0;
interface Repo { top: string; eng: string }
let mono: Repo;   // the engine at packages/engine, as in the monorepo
let rooted: Repo; // the engine at the repository root, as in its own repo (engine-split 2b)

function makeRepo(name: string, prefix: string): Repo {
  const top = join(scratch, name);
  const eng = join(top, prefix);
  mkdirSync(eng, { recursive: true });
  for (const f of FILES) {
    mkdirSync(dirname(join(eng, f)), { recursive: true });
    cpSync(join(ENGINE, f), join(eng, f));
  }
  writeFileSync(join(top, "README.md"), "scratch\n");
  git(top, "init", "-q", "-b", "main");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "base");
  git(top, "tag", "base");
  return { top, eng };
}
const BUILD_MS = 60_000;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "fold-epoch-guard-"));
  for (const f of CORPORA) {
    const c = JSON.parse(readFileSync(join(ENGINE, SPORTS_DIR, f), "utf8")) as Corpus;
    realSports++;
    realStreams += c.streams.length;
  }
  mono = makeRepo("mono", "packages/engine");
  rooted = makeRepo("rooted", "");
}, BUILD_MS);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---- helpers that edit the checkout the way a PR would -----------------------------------------------------------------------

/** Back to the base commit with a clean tree (a scenario is one or two commits on top of it). */
function atBase(repo: Repo): void {
  git(repo.top, "checkout", "-q", "--detach", "base");
  git(repo.top, "reset", "-q", "--hard", "base");
  git(repo.top, "clean", "-fdq");
}
function commit(repo: Repo, message: string): string {
  git(repo.top, "add", "-A");
  git(repo.top, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo.top, "rev-parse", "HEAD");
}
const corpusPath = (repo: Repo, sport: string): string => {
  const rel = CORPORA.find((f) => basename(f) === `${sport}.golden.json`);
  if (rel === undefined) throw new Error(`no corpus for ${sport}`);
  return join(repo.eng, SPORTS_DIR, rel);
};
function editCorpus(repo: Repo, sport: string, fn: (c: Corpus) => void): void {
  const file = corpusPath(repo, sport);
  const c = JSON.parse(readFileSync(file, "utf8")) as Corpus;
  fn(c);
  writeFileSync(file, `${JSON.stringify(c, null, 0)}\n`); // the format golden.ts writes
}
/** What a rule fix does to one sport: the first stream's recorded outcome is different. */
const moveOutcome = (repo: Repo, sport: string): void => editCorpus(repo, sport, (c) => { c.streams[0]!.outcome = `${String(c.streams[0]!.outcome)} `; });
function setEpoch(repo: Repo, sport: string, n: number): void {
  const file = join(repo.eng, EPOCH_FILE);
  const text = readFileSync(file, "utf8");
  const re = new RegExp(`\\b${sport}: \\d+`);
  if (!re.test(text)) throw new Error(`${sport} has no entry in ${EPOCH_FILE}`);
  writeFileSync(file, text.replace(re, `${sport}: ${n}`));
}
/** The engine's path inside the repository, as git spells it ("packages/engine/" or ""). */
const relPrefix = (repo: Repo): string => (repo.eng === repo.top ? "" : `${relative(repo.top, repo.eng)}/`);
const guard = (repo: Repo, ref = "HEAD^1", cwd = repo.eng) => run(repo.eng, ["--against", ref], cwd);
/** The report line of one sport. */
const lineOf = (out: string, sport: string): string => out.split("\n").find((l) => l.startsWith(`fold-epoch: ${sport}: `)) ?? "";
const violated = (out: string): string[] => out.split("\n").filter((l) => l.includes("VIOLATION")).map((l) => /^fold-epoch: (\S+): /.exec(l)?.[1] ?? l);
const summary = (n: number, m: number, ref: string, v: number): string => `fold-epoch: ${n} sports checked, ${m} streams compared against ${ref}: ${v} violation(s)`;

/** A test that spawns about `n` processes (CLI runs and git commands). */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

describe("fold-epoch-guard CLI: the scratch repository is the real tree's", () => {
  it("holds the real corpora of every sport, counted (a scratch repo with none would pass every red test below for the wrong reason)", () => {
    expect(realSports).toBe(CORPORA.length);
    expect(realSports).toBeGreaterThan(1);
    expect(new Set(KEYS).size).toBe(KEYS.length);
    expect(FIRST).not.toBe(LAST);
    expect(realStreams).toBeGreaterThanOrEqual(realSports);
  });
});

describe("fold-epoch-guard CLI: the sequence of a PR against HEAD^1, in a real git history", () => {
  spawnIt(3)("no change: a PR that touches no golden and no epoch is green, and the report counts every sport and stream it compared", () => {
    atBase(mono);
    commit(mono, "docs only");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0));
    expect(KEYS.map((k) => lineOf(r.stdout, k)).filter((l) => l !== "").length).toBe(realSports);
    expect(violated(r.stdout)).toEqual([]);
  });

  spawnIt(3)("a golden outcome changed without a bump is red, naming that sport and its counts, and no other sport", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    commit(mono, "rule fix, no bump");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
    expect(lineOf(r.stdout, FIRST)).toMatch(/epoch 1 -> 1, matched \d+ changed 1 removed 0 added 0 - VIOLATION: 1 stream\(s\) fold differently/);
    expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 1));
    expect(r.stderr).toBe("");
  });

  spawnIt(3)("the same change with that sport's bump is green, and the report shows the epoch moving", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    setEpoch(mono, FIRST, 2);
    commit(mono, "rule fix with bump");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, FIRST)).toMatch(/epoch 1 -> 2, matched \d+ changed 1 removed 0 added 0$/);
    expect(violated(r.stdout)).toEqual([]);
  });

  spawnIt(3)("only a mid-match state changed (the final outcome is the same): still red", () => {
    atBase(mono);
    editCorpus(mono, LAST, (c) => { const s = c.streams[0]!; const st = s.states as string[]; st[0] = `${st[0]} `; });
    commit(mono, "state fix, no bump");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([LAST]);
  });

  spawnIt(5)("a corpus stream removed without a bump is red; with the bump it is green; an added stream needs no bump", () => {
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.pop(); });
    commit(mono, "stream removed");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    expect(lineOf(red.stdout, FIRST)).toMatch(/changed 0 removed 1 added 0 - VIOLATION/);

    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.pop(); });
    setEpoch(mono, FIRST, 2);
    commit(mono, "stream removed, bumped");
    expect(guard(mono).status).toBe(0);

    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.push({ ...c.streams[0]!, seed: 424242424 }); });
    commit(mono, "stream added");
    const added = guard(mono);
    expect(added.status).toBe(0);
    expect(lineOf(added.stdout, FIRST)).toMatch(/changed 0 removed 0 added 1$/);
  });

  spawnIt(4)("a sport added by the PR (absent from the baseline entirely) needs no bump, and the other sports are still compared", () => {
    atBase(mono);
    // the baseline commit has no trace of LAST: no corpus file, no table entry
    rmSync(corpusPath(mono, LAST));
    const tablePath = join(mono.eng, EPOCH_FILE);
    writeFileSync(tablePath, readFileSync(tablePath, "utf8").replace(new RegExp(`\\s*\\b${LAST}: \\d+,?`), ""));
    const without = commit(mono, "engine without the last sport");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    const withIt = commit(mono, "the last sport arrives");
    expect(git(mono.top, "rev-parse", "HEAD^1")).toBe(without);
    expect(withIt).not.toBe(without);
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, LAST)).toMatch(/epoch \(none\) -> 1, matched 0 changed 0 removed 0 added \d+$/);
    expect(r.stdout).toContain(`${realSports - 1} sports checked`);
    expect(violated(r.stdout)).toEqual([]);
  });

  spawnIt(4)("an epoch lowered is red, even though nothing in any corpus moved", () => {
    atBase(mono);
    setEpoch(mono, FIRST, 3);
    commit(mono, "raise to 3");
    setEpoch(mono, FIRST, 2);
    commit(mono, "lower to 2");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
    expect(lineOf(r.stdout, FIRST)).toMatch(/epoch 3 -> 2, .* - VIOLATION: .*went down/);
  });

  spawnIt(3)("two sports changed, only one bumped: red for the other sport alone", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    moveOutcome(mono, LAST);
    setEpoch(mono, FIRST, 2);
    commit(mono, "two rule fixes, one bump");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([LAST]);
    expect(lineOf(r.stdout, FIRST)).toMatch(/epoch 1 -> 2, matched \d+ changed 1 .* added 0$/);
  });

  spawnIt(3)("run from another working directory: the script finds its engine by its own location, not by the shell's cwd", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    commit(mono, "rule fix, no bump");
    const r = guard(mono, "HEAD^1", mono.top);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
  });

  spawnIt(4)("the engine at the repository root (its own repo, 2b) gives the same verdicts as inside the monorepo", () => {
    atBase(rooted);
    commit(rooted, "docs only");
    expect(guard(rooted).stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0));
    atBase(rooted);
    moveOutcome(rooted, FIRST);
    commit(rooted, "rule fix, no bump");
    const r = guard(rooted);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
  });

  spawnIt(3)("uncommitted work against HEAD is judged too: the way to check a re-baseline before committing it", () => {
    atBase(mono);
    expect(guard(mono, "HEAD").status).toBe(0);
    moveOutcome(mono, FIRST);
    const r = guard(mono, "HEAD");
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
  });
});

describe("fold-epoch-guard CLI: what CI's checkout gives (pull_request runs on the merge commit refs/pull/N/merge, fetch-depth 0)", () => {
  /** The shape of a PR merge ref: main moved on (C, an earlier change to FIRST that is already on main), the PR (B) changes LAST, and
   *  the checkout is their merge commit M, whose first parent is main's tip. */
  function mergeRef(id: string, bumpTheLast: boolean): { c: string; b: string; m: string } {
    atBase(mono);
    git(mono.top, "checkout", "-q", "-b", `main-${id}`);
    moveOutcome(mono, FIRST);
    const c = commit(mono, "main moved on: FIRST's outcome changed (already on main)");
    git(mono.top, "checkout", "-q", "-b", `pr-${id}`, "base");
    moveOutcome(mono, LAST);
    if (bumpTheLast) setEpoch(mono, LAST, 2);
    const b = commit(mono, "the PR");
    git(mono.top, "checkout", "-q", `main-${id}`);
    git(mono.top, "merge", "--no-ff", "-q", "-m", "merge ref", `pr-${id}`);
    const m = git(mono.top, "rev-parse", "HEAD");
    expect(git(mono.top, "rev-parse", "HEAD^1")).toBe(c);
    expect(git(mono.top, "rev-parse", "HEAD^2")).toBe(b);
    return { c, b, m };
  }

  spawnIt(8)("on the merge commit HEAD^1 is main's tip: what main already changed is not blamed on the PR, and the PR's own change is judged", () => {
    mergeRef("red", false);
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([LAST]);
    // FIRST differs from the merge BASE but not from main's tip, so it is clean here ...
    expect(lineOf(r.stdout, FIRST)).toMatch(/changed 0 removed 0 added 0$/);
    // ... and would be red if the comparison were against the merge base, which is not what HEAD^1 is
    const wrong = guard(mono, "base");
    expect(violated(wrong.stdout).sort()).toEqual([FIRST, LAST].sort());
  });

  spawnIt(5)("the same merge ref with the PR's bump is green", () => {
    mergeRef("green", true);
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, LAST)).toMatch(/epoch 1 -> 2, matched \d+ changed 1 /);
    expect(violated(r.stdout)).toEqual([]);
  });

  spawnIt(4)("a root commit has no HEAD^1: refused (exit 2), never passed", () => {
    atBase(mono);
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/"HEAD\^1" is not a commit in this repository/);
    expect(r.stdout).toBe("");
  });

  spawnIt(6)("a shallow checkout (fetch-depth 1) cannot reach HEAD^1: refused (exit 2) and the message says to fetch the history", () => {
    atBase(mono);
    commit(mono, "second commit");
    const clone = join(scratch, "shallow");
    git(scratch, "clone", "-q", "--depth", "1", `file://${mono.top}`, clone);
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    const r = guard({ top: clone, eng: join(clone, "packages/engine") });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not a commit/);
    expect(r.stderr).toMatch(/shallow.*fetch-depth: 0/);
  });

  spawnIt(3)("a ref that does not exist, and a ref that looks like a flag, are refused", () => {
    atBase(mono);
    commit(mono, "second commit");
    for (const [ref, why] of [["no-such-ref", /"no-such-ref" is not a commit in this repository/], ["--nope", /"--nope" is not a ref/]] as const) {
      const r = run(mono.eng, [`--against=${ref}`]);
      expect(r.status, ref).toBe(2);
      expect(r.stderr, ref).toMatch(why);
      expect(r.stdout, ref).toBe("");
    }
  });

  spawnIt(4)("the introducing PR has no table at HEAD^1: nothing to compare yet, exit 0, and it says so (and still counts what it holds)", () => {
    atBase(mono);
    git(mono.top, "rm", "-q", join(mono.eng, EPOCH_FILE));
    commit(mono, "main before the table");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the PR that introduces FOLD_EPOCH");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain(`fold-epoch: no ${EPOCH_FILE} at HEAD^1: nothing to compare yet (the tree holds ${realSports} sports, ${realStreams} streams)`);
  });
});

describe("fold-epoch-guard CLI: a run that compared nothing, or read something it cannot trust, is refused (exit 2)", () => {
  spawnIt(4)("a baseline with a table but no corpus proves nothing about any stream: refused, not green", () => {
    atBase(mono);
    for (const f of CORPORA) rmSync(join(mono.eng, SPORTS_DIR, f));
    commit(mono, "main with no corpora");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the corpora come back");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/compared no stream/);
  });

  spawnIt(3)("an empty table in the tree is refused: no sport declared, nothing checked", () => {
    atBase(mono);
    writeFileSync(join(mono.eng, EPOCH_FILE), "export const FOLD_EPOCH = {} as const;\n");
    commit(mono, "empty table");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/declares no sport/);
  });

  spawnIt(3)("a missing table in the tree is refused (a deletion must not read as 'no epochs')", () => {
    atBase(mono);
    rmSync(join(mono.eng, EPOCH_FILE));
    commit(mono, "table deleted");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/src\/sport\/fold-epoch\.ts is missing/);
  });

  spawnIt(6)("an epoch that is not a positive integer is refused", () => {
    for (const bad of ["0", "1.5", "-1"]) {
      atBase(mono);
      setEpoch(mono, FIRST, 1);
      const file = join(mono.eng, EPOCH_FILE);
      writeFileSync(file, readFileSync(file, "utf8").replace(new RegExp(`\\b${FIRST}: \\d+`), `${FIRST}: ${bad}`));
      commit(mono, `epoch ${bad}`);
      const r = guard(mono);
      expect(r.status, bad).toBe(2);
      expect(r.stderr, bad).toMatch(/positive integer/);
    }
  });

  spawnIt(5)("a baseline table that does not load (no FOLD_EPOCH export, or not TypeScript at all) is refused", () => {
    for (const text of ["export const OTHER = 1;\n", "export const FOLD_EPOCH = {;\n"]) {
      atBase(mono);
      writeFileSync(join(mono.eng, EPOCH_FILE), text);
      commit(mono, "main with a broken table");
      git(mono.top, "checkout", "-q", "base", "--", ".");
      commit(mono, "the table is repaired");
      const r = guard(mono);
      expect(r.status, text).toBe(2);
      expect(r.stderr, text).toMatch(/at HEAD\^1 does not load/);
    }
  });

  spawnIt(4)("a corpus that is not JSON, in the tree or in the baseline, is refused", () => {
    atBase(mono);
    writeFileSync(corpusPath(mono, FIRST), "{not json");
    commit(mono, "broken corpus");
    const inTree = guard(mono);
    expect(inTree.status).toBe(2);
    expect(inTree.stderr).toMatch(/not valid JSON/);
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "repaired");
    const inBase = guard(mono);
    expect(inBase.status).toBe(2);
    // the baseline's file is named as the engine spells it ("src/sports/..."), not by its path from the repository root
    expect(inBase.stderr).toMatch(new RegExp(`^fold-epoch: src/sports/[\\w/]*${FIRST}\\.golden\\.json at HEAD\\^1 is not valid JSON`));
  });

  spawnIt(3)("a corpus whose key is not its file name, or that repeats a stream's config and seed, is refused instead of compared", () => {
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.key = "somethingelse"; });
    commit(mono, "wrong key");
    const key = guard(mono);
    expect(key.status).toBe(2);
    expect(key.stderr).toMatch(/names sport "somethingelse"/);
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.push({ ...c.streams[0]! }); });
    commit(mono, "duplicate stream");
    const dup = guard(mono);
    expect(dup.status).toBe(2);
    expect(dup.stderr).toMatch(/duplicate stream identity/);
  });

  spawnIt(3)("a baseline table that declares no sport is refused too, and says it is the baseline's", () => {
    atBase(mono);
    writeFileSync(join(mono.eng, EPOCH_FILE), "export const FOLD_EPOCH = {} as const;\n");
    commit(mono, "main with an empty table");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the table is back");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/src\/sport\/fold-epoch\.ts at HEAD\^1 declares no sport/);
  });

  spawnIt(4)("a stream that lacks a recorded result is refused as malformed, and so is a second corpus for one sport", () => {
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { delete c.streams[0]!.deltas; });
    commit(mono, "stream without deltas");
    const malformed = guard(mono);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toMatch(/stream #0 is malformed/);
    atBase(mono);
    mkdirSync(join(mono.eng, SPORTS_DIR, "zz"), { recursive: true });
    cpSync(corpusPath(mono, FIRST), join(mono.eng, SPORTS_DIR, "zz", `${FIRST}.golden.json`));
    commit(mono, "a second corpus for one sport");
    const twice = guard(mono);
    expect(twice.status).toBe(2);
    expect(twice.stderr).toMatch(new RegExp(`two golden corpora for sport "${FIRST}"`));
  });

  spawnIt(3)("every corpus deleted in the tree is red for every sport (an entry with no corpus), not a crash and not a pass", () => {
    atBase(mono);
    rmSync(join(mono.eng, SPORTS_DIR), { recursive: true });
    commit(mono, "src/sports deleted");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout).sort()).toEqual([...KEYS].sort());
    expect(lineOf(r.stdout, FIRST)).toMatch(/matched 0 changed 0 removed \d+ added 0 - VIOLATION: .*FOLD_EPOCH entry but no golden corpus/);
  });

  spawnIt(3)("run through a symlink to the engine directory it still runs: a guard that compared the given path with the real one would print nothing and exit 0", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    commit(mono, "rule fix, no bump");
    const link = join(scratch, "engine-link");
    symlinkSync(mono.eng, link);
    const r = run(mono.eng, ["--against", "HEAD^1"], mono.eng, { via: link });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("sports checked");
    expect(violated(r.stdout)).toEqual([FIRST]);
  });

  spawnIt(3)("outside any git checkout (a source archive) it refuses: there is no HEAD^1 to compare with", () => {
    const loose = join(scratch, "not-a-checkout");
    for (const f of FILES) {
      mkdirSync(dirname(join(loose, f)), { recursive: true });
      cpSync(join(ENGINE, f), join(loose, f));
    }
    const r = run(loose, ["--against", "HEAD^1"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/"HEAD\^1" is not a commit in this repository/);
  });

  spawnIt(3)("without git it refuses (exit 2) and says git could not run, instead of blaming the ref", () => {
    atBase(mono);
    commit(mono, "docs only");
    const r = run(mono.eng, ["--against", "HEAD^1"], mono.eng, { env: { PATH: join(scratch, "no-such-bin") } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not run git/);
    expect(r.stderr).not.toMatch(/is not a commit/);
  });

  spawnIt(3)("a crash of the guard itself (no temp directory to load the table in) is exit 3, which is not a verdict", () => {
    atBase(mono);
    commit(mono, "docs only");
    const r = run(mono.eng, ["--against", "HEAD^1"], mono.eng, { env: { TMPDIR: join(scratch, "no-such-tmp") } });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/the guard itself crashed/);
    expect(r.stdout).toBe("");
  });

  spawnIt(8)("a baseline entry git cannot read as a file (a submodule, a path with a newline, the table itself) is refused rather than skipped", () => {
    atBase(mono);
    const sha = git(mono.top, "rev-parse", "HEAD");
    const rel = `${relPrefix(mono)}${SPORTS_DIR}/zz/zz.golden.json`;
    git(mono.top, "update-index", "--add", "--cacheinfo", `160000,${sha},${rel}`);
    git(mono.top, "commit", "-q", "-m", "main with a gitlink where a corpus would be"); // not commit(): its `add -A` would drop an entry with no file
    git(mono.top, "rm", "-q", "--cached", "-f", rel);
    git(mono.top, "commit", "-q", "-m", "the gitlink is gone");
    const gitlink = guard(mono);
    expect(gitlink.status).toBe(2);
    expect(gitlink.stderr).toMatch(/could not read HEAD\^1:.*zz\.golden\.json as a file/);

    atBase(mono);
    mkdirSync(join(mono.eng, SPORTS_DIR, "zz"), { recursive: true });
    writeFileSync(join(mono.eng, SPORTS_DIR, "zz", "a\nb.golden.json"), "{}\n");
    commit(mono, "main with a corpus whose name has a newline");
    rmSync(join(mono.eng, SPORTS_DIR, "zz"), { recursive: true });
    commit(mono, "it is gone");
    const newline = guard(mono);
    expect(newline.status).toBe(2);
    expect(newline.stderr).toMatch(/contains a newline/);

    // the TABLE itself unreadable at the ref is an error too: a table that is there but cannot be loaded is never "no table at the ref"
    atBase(mono);
    const table = `${relPrefix(mono)}${EPOCH_FILE}`;
    git(mono.top, "update-index", "--add", "--cacheinfo", `160000,${sha},${table}`);
    git(mono.top, "commit", "-q", "-m", "main whose table is a gitlink");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the table is a file again");
    const tableUnreadable = guard(mono);
    expect(tableUnreadable.status).toBe(2);
    expect(tableUnreadable.stderr).toMatch(/could not read HEAD\^1:.*fold-epoch\.ts as a file/);
    expect(tableUnreadable.stdout).not.toMatch(/nothing to compare yet/);
  });

  spawnIt(5)("usage: --against is required, takes a value, and nothing else is accepted", () => {
    atBase(mono);
    for (const args of [[], ["--against"], ["--against", ""], ["--nope"], ["--against", "HEAD", "extra"]]) {
      const r = run(mono.eng, args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.stderr, JSON.stringify(args)).toMatch(/usage: fold-epoch-guard\.ts --against <ref>/);
      expect(r.stdout, JSON.stringify(args)).toBe("");
    }
  });
});
