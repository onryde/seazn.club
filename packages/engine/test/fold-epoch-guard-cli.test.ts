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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPORTS_DIR = "src/sports";
const EPOCH_FILE = "src/sport/fold-epoch.ts";
const GUARD = "scripts/fold-epoch-guard.ts";

interface Corpus { key: string; configs: Record<string, Record<string, unknown>>; streams: Array<Record<string, unknown>> }

/** Every corpus file under src/sports, relative to it (`setbased/badminton.golden.json`). */
const CORPORA = (readdirSync(join(ENGINE, SPORTS_DIR), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).sort();
const KEYS = CORPORA.map((f) => basename(f, ".golden.json"));
const FIRST = KEYS[0] as string;
const LAST = KEYS[KEYS.length - 1] as string;
/** The files a scratch checkout needs: the real guard and the helper it imports, the real package.json (type: module), the real table, the real corpora. */
const FILES = [GUARD, "scripts/lib/main-module.ts", "package.json", EPOCH_FILE, ...CORPORA.map((f) => join(SPORTS_DIR, f))];

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

/** Git packs loose objects on its own (`gc --auto` after a commit, `git maintenance run --auto`) once enough have piled up, and how many is
 *  "enough" depends on the machine's timing and git version: the same history stayed loose on a laptop and was packed on CI. The damage tests
 *  delete or cut a LOOSE object file, so every scratch repository is told to never pack, before its first commit. */
const NO_AUTO_PACK: ReadonlyArray<readonly [string, string]> = [["gc.auto", "0"], ["maintenance.auto", "false"], ["core.autocrlf", "false"]];
function noAutoPack(top: string): void {
  for (const [key, value] of NO_AUTO_PACK) git(top, "config", key, value);
}
/** Where git keeps `sha` when it is loose. */
const objectFile = (top: string, sha: string): string => join(top, ".git", "objects", sha.slice(0, 2), sha.slice(2));

/** The loose object file of `sha` in a scratch repository's object store. A packed object is a broken rig, not a case to skip: the test fails
 *  and says why. */
const looseObject = (repo: Repo, sha: string): string => {
  const file = objectFile(repo.top, sha);
  if (!existsSync(file)) {
    throw new Error(`object ${sha} is not loose in ${repo.top}: git packed it. The rig sets gc.auto=0 and maintenance.auto=false right after \`git init\` (noAutoPack); a repository built any other way, or a setting overridden, breaks every test that damages an object file`);
  }
  return file;
};

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
  noAutoPack(top);
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

describe("fold-epoch-guard CLI: the scratch repositories never pack their objects (the damage tests delete or cut a loose object file)", () => {
  /** A one-commit repository set up like the rig's (`pack`: false) or with git's defaults (`pack`: true), holding more than the 27 files
   *  objects/17 needs to look like a repository with thousands of loose objects (git estimates the loose count from that one directory), then
   *  given every chance to pack: `git maintenance run --auto` and `git gc --auto`, in the foreground. Reports where its one blob ended up. */
  function probe(name: string, defaults: boolean): { loose: boolean; packs: number; fakes: number } {
    const top = join(scratch, name);
    mkdirSync(top, { recursive: true });
    git(top, "init", "-q", "-b", "main");
    if (!defaults) noAutoPack(top);
    writeFileSync(join(top, "file.txt"), `${name}\n`);
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "one blob");
    const blob = git(top, "rev-parse", "HEAD:file.txt");
    mkdirSync(join(top, ".git", "objects", "17"), { recursive: true });
    const FAKES = 40;
    for (let i = 1; i <= FAKES; i++) writeFileSync(join(top, ".git", "objects", "17", i.toString(16).padStart(38, "0")), "");
    // not through git(): `maintenance run --auto` may exit non-zero on the empty objects, and what is asked is whether the blob moved
    for (const args of [["maintenance", "run", "--auto"], ["gc", "--auto"]]) spawnSync("git", ["-C", top, "-c", "gc.autoDetach=false", ...args], { encoding: "utf8", env: cleanEnv(), timeout: SPAWN_MS });
    const packs = readdirSync(join(top, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack")).length;
    return { loose: existsSync(objectFile(top, blob)), packs, fakes: readdirSync(join(top, ".git", "objects", "17")).length };
  }

  spawnIt(14)("every scratch repository is created with auto-gc and auto-maintenance off, and a repository like that stays loose where git's defaults would pack it", () => {
    for (const repo of [mono, rooted]) {
      for (const [key, value] of NO_AUTO_PACK) expect(git(repo.top, "config", "--get", key), `${key} in ${repo.top}`).toBe(value);
    }
    // the probe has teeth: with git's defaults the same repository IS packed (else it proves nothing about the setting)
    const control = probe("probe-defaults", true);
    expect(control.fakes).toBeGreaterThan(27);
    expect(control, "git's defaults pack this repository: the probe can see packing").toMatchObject({ loose: false });
    expect(control.packs).toBeGreaterThan(0);
    const rig = probe("probe-rig", false);
    expect(rig, "the rig's settings keep the blob loose through maintenance and gc --auto").toMatchObject({ loose: true, packs: 0 });
    expect(rig.fakes).toBe(control.fakes);
  });

  spawnIt(5)("looseObject refuses with the reason when the object is packed, and hands back the file when it is loose", () => {
    const top = join(scratch, "probe-packed");
    mkdirSync(top, { recursive: true });
    git(top, "init", "-q", "-b", "main");
    noAutoPack(top);
    writeFileSync(join(top, "file.txt"), "packed\n");
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "one blob");
    const sha = git(top, "rev-parse", "HEAD:file.txt");
    const repo: Repo = { top, eng: top };
    expect(looseObject(repo, sha)).toBe(objectFile(top, sha));
    git(top, "repack", "-ad", "-q");
    expect(existsSync(objectFile(top, sha)), "repack -ad packed it").toBe(false);
    expect(() => looseObject(repo, sha)).toThrow(/is not loose in .*: git packed it.*gc\.auto=0 and maintenance\.auto=false/);
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
    // and what to do about it: the entry, the number (read from the baseline's own table, not typed here), the file as git spells it, the command
    const was = new RegExp(`\\b${FIRST}: (\\d+)`).exec(readFileSync(join(ENGINE, EPOCH_FILE), "utf8"))?.[1];
    expect(was).toBeDefined();
    expect(lineOf(r.stdout, FIRST)).toContain(`raise FOLD_EPOCH.${FIRST} to ${Number(was) + 1} in src/sport/fold-epoch.ts`);
    expect(r.stdout).toContain(`fold-epoch: to clear the violation(s) above, raise the sport's entry in ${relPrefix(mono)}src/sport/fold-epoch.ts in this same change`);
    expect(r.stdout).toContain("fold-epoch:check --against origin/main");
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

  spawnIt(10)("a rule change laundered through the recorded configs (a default written out explicitly) is red: the config is part of a stream's input", () => {
    // The reviewer's reproduction. Badminton's default cap moves 30 -> 31 in the module; a REBASELINE then stays red, because the recorded
    // config is spliced back, and the way to green is to write `cap: 30` into every corpus config that lacked it. Every replay folds to the
    // same result: not one event, state, outcome, summary or delta below moves. The same with the points map.
    expect(KEYS).toContain("badminton");
    for (const [knob, value] of [["cap", 30], ["pointsMap", { "*": [2, 0] }]] as const) {
      const launder = (): number => {
        let edited = 0;
        editCorpus(mono, "badminton", (c) => { for (const cfg of Object.values(c.configs)) if (!(knob in cfg)) { cfg[knob] = value; edited++; } });
        return edited;
      };
      atBase(mono);
      expect(launder(), `${knob}: configs that lacked it`).toBeGreaterThan(0);
      commit(mono, `${knob} written out explicitly`);
      const red = guard(mono);
      expect(red.status, knob).toBe(1);
      expect(violated(red.stdout), knob).toEqual(["badminton"]);
      expect(lineOf(red.stdout, "badminton"), knob).toMatch(/changed 0 removed [1-9]\d* added [1-9]\d* - VIOLATION/);

      atBase(mono);
      launder();
      setEpoch(mono, "badminton", 2);
      commit(mono, `${knob} written out explicitly, with the bump`);
      expect(guard(mono).status, `${knob} with the bump`).toBe(0);
    }
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
    // the file is named as the repository spells it: with the engine at the root there is no packages/engine/ in front of it
    expect(relPrefix(rooted)).toBe("");
    expect(r.stdout).toContain(" raise the sport's entry in src/sport/fold-epoch.ts in this same change");
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
    git(scratch, "clone", "-q", "--depth", "1", "-c", "gc.auto=0", "-c", "maintenance.auto=false", `file://${mono.top}`, clone);
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    for (const [key, value] of NO_AUTO_PACK.slice(0, 2)) expect(git(clone, "config", "--get", key), `${key} in the clone`).toBe(value);
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

  spawnIt(4)("the introducing PR has no table and no guard at HEAD^1: nothing to compare yet, exit 0, and it says so (and still counts what it holds)", () => {
    atBase(mono);
    git(mono.top, "rm", "-q", join(mono.eng, EPOCH_FILE), join(mono.eng, GUARD));
    commit(mono, "main before the table and the guard");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the PR that introduces FOLD_EPOCH");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain(`fold-epoch: no ${EPOCH_FILE} at HEAD^1: nothing to compare yet (the tree holds ${realSports} sports, ${realStreams} streams)`);
  });
});

describe("fold-epoch-guard CLI: the introducing-PR pass cannot be reopened by moving the table or the engine", () => {
  spawnIt(6)("a table moved to another path, with the guard taught the new path and a fold changed without a bump, is refused: the baseline already has the guard", () => {
    atBase(mono);
    const moved = "src/sport/epoch/fold-epoch.ts";
    mkdirSync(join(mono.eng, "src/sport/epoch"), { recursive: true });
    renameSync(join(mono.eng, EPOCH_FILE), join(mono.eng, moved));
    const guardFile = join(mono.eng, GUARD);
    const text = readFileSync(guardFile, "utf8");
    const taught = text.replace(`const TABLE = "${EPOCH_FILE}";`, `const TABLE = "${moved}";`);
    expect(taught, "the copied guard names its table in one constant").not.toBe(text);
    writeFileSync(guardFile, taught);
    moveOutcome(mono, FIRST);
    commit(mono, "table moved, a fold changed, no bump");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/no src\/sport\/epoch\/fold-epoch\.ts at HEAD\^1, but the baseline already has scripts\/fold-epoch-guard\.ts/);
  });

  spawnIt(6)("the engine directory renamed, with a fold changed without a bump, is refused: the baseline holds no corpus at the new path", () => {
    atBase(mono);
    git(mono.top, "mv", "packages/engine", "packages/engine2");
    const renamed: Repo = { top: mono.top, eng: join(mono.top, "packages/engine2") };
    moveOutcome(renamed, FIRST);
    commit(renamed, "engine renamed, a fold changed, no bump");
    const r = guard(renamed);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/holds no golden corpus under src\/sports/);
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

  spawnIt(7)("a stream whose config is not one of the corpus's configs (an own key, not an inherited name), or a corpus with no configs object, is refused", () => {
    for (const name of ["nope", "constructor", "toString"]) {
      atBase(mono);
      editCorpus(mono, FIRST, (c) => { c.streams[0]!.config = name; });
      commit(mono, `stream names config ${name}`);
      const r = guard(mono);
      expect(r.status, name).toBe(2);
      expect(r.stdout, name).toBe("");
      expect(r.stderr, name).toMatch(new RegExp(`stream #0 names config "${name}", which is not one of the corpus's configs`));
    }
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { delete (c as Partial<Corpus>).configs; });
    commit(mono, "corpus without configs");
    const none = guard(mono);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/is not a golden corpus \(it needs a string key, a configs object and a streams array\)/);
  });

  spawnIt(8)("a stream that lacks a recorded result, or whose seed is a string, is refused as malformed, and so is a second corpus for one sport", () => {
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { delete c.streams[0]!.deltas; });
    commit(mono, "stream without deltas");
    const malformed = guard(mono);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toMatch(/stream #0 is malformed/);
    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams[0]!.seed = "1"; });
    commit(mono, "stream whose seed is a string");
    const seed = guard(mono);
    expect(seed.status).toBe(2);
    expect(seed.stderr).toMatch(/stream #0 is malformed/);
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

  spawnIt(8)("a baseline tree git cannot read is refused (exit 2, nothing printed on stdout): the sport inside it must not read as a new one", () => {
    atBase(mono);
    moveOutcome(mono, "football");
    const changed = commit(mono, "football corpus changed (this commit's football directory is a tree no other commit has)");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "football as it was");
    // control: the history reads, and football is compared like every other sport (the same run is red or green for the right reason)
    const control = guard(mono);
    expect({ status: control.status, stderr: control.stderr }).toEqual({ status: 1, stderr: "" });
    expect(violated(control.stdout)).toEqual(["football"]);

    const footballDir = git(mono.top, "rev-parse", `${changed}:${relPrefix(mono)}${SPORTS_DIR}/football`);
    const file = looseObject(mono, footballDir);
    chmodSync(dirname(file), 0o755);
    chmodSync(file, 0o644);
    rmSync(file);
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/git ls-tree HEAD\^1 failed/);
  });

  spawnIt(8)("a baseline file whose object is damaged is refused with git's own failure named (exit 2), not trusted half-read", () => {
    atBase(mono);
    moveOutcome(mono, LAST);
    const changed = commit(mono, `${LAST} corpus changed (its blob exists only in this commit)`);
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, `${LAST} as it was`);
    expect(guard(mono).status, "control: the history reads").toBe(1);

    const blob = git(mono.top, "rev-parse", `${changed}:${relative(mono.top, corpusPath(mono, LAST))}`);
    const file = looseObject(mono, blob);
    chmodSync(dirname(file), 0o755);
    chmodSync(file, 0o644);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length >> 1)); // cut in half: git can read its header and name it, and cannot read the rest
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr, "the message names git cat-file, not a JSON parse error that happens to follow").toMatch(/git cat-file --batch HEAD\^1 failed/);
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
