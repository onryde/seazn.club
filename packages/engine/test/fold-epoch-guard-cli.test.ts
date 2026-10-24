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
const STATS_FILE = "src/stats/stats.ts";

interface Corpus { key: string; format?: number; configs: Record<string, Record<string, unknown>>; streams: Array<Record<string, unknown>> }

/** Every corpus file under src/sports, relative to it (`setbased/badminton.golden.json`). */
const CORPORA = (readdirSync(join(ENGINE, SPORTS_DIR), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).sort();
const KEYS = CORPORA.map((f) => basename(f, ".golden.json"));
const FIRST = KEYS[0] as string;
const LAST = KEYS[KEYS.length - 1] as string;
/** The files a scratch checkout needs: the real guard and the helper it imports, the real package.json (type: module), the real table, the real
 *  stats module (the guard READS its STATS_FOLD_VERSION line, never imports it, so its own imports need not exist here), the real corpora. */
const FILES = [GUARD, "scripts/lib/main-module.ts", "package.json", EPOCH_FILE, STATS_FILE, ...CORPORA.map((f) => join(SPORTS_DIR, f))];

// Git must not see the parent's repository (a hook sets GIT_DIR) or its identity.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
/** Every git process this file starts through `git()`: a rig's budget is checked against what it really spawned. */
let gitSpawns = 0;
function git(cwd: string, ...args: string[]): string {
  gitSpawns++;
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
// A beforeAll's budget is derived from the work it does (AGENTS.md class 20: a flat timeout beside a derived cost is a latent red - the
// old flat 60 s / 120 s timed out at load 100+): the repositories it builds times the git spawns each costs, at the spawn cap the other
// tests here use.
/** git spawns to build one scratch repository (`makeRepo`): init, one config per NO_AUTO_PACK entry, add, commit, tag. */
const REPO_SPAWNS = 4 + NO_AUTO_PACK.length;
/** ... and what `makeFormatRepo` adds on top of that: three `commit`s (add, commit, rev-parse each) and three tags. */
const FORMAT_REPO_EXTRA_SPAWNS = 3 * 3 + 3;
const BUILD_MS = spawnBudget(2 * REPO_SPAWNS); // mono and rooted
const FORMAT_BUILD_MS = spawnBudget(2 * (REPO_SPAWNS + FORMAT_REPO_EXTRA_SPAWNS)); // fmtMono and fmtRooted
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
/** The table file keeps FOLD_EPOCH first and FOLD_MINOR after it (each a literal of `sport: n` entries): an edit is made inside one of them. */
const MINOR_DECL = "export const FOLD_MINOR =";
function setEntry(repo: Repo, table: "FOLD_EPOCH" | "FOLD_MINOR", sport: string, n: number): void {
  const file = join(repo.eng, EPOCH_FILE);
  const text = readFileSync(file, "utf8");
  const cut = text.indexOf(MINOR_DECL);
  if (cut < 0) throw new Error(`${EPOCH_FILE} declares no FOLD_MINOR`);
  const [from, to] = table === "FOLD_EPOCH" ? [0, cut] : [cut, text.length];
  const re = new RegExp(`\\b${sport}: \\d+`);
  const part = text.slice(from, to);
  if (!re.test(part)) throw new Error(`${sport} has no entry in ${table} (${EPOCH_FILE})`);
  writeFileSync(file, text.slice(0, from) + part.replace(re, `${sport}: ${n}`) + text.slice(to));
}
const setEpoch = (repo: Repo, sport: string, n: number): void => setEntry(repo, "FOLD_EPOCH", sport, n);
const setMinor = (repo: Repo, sport: string, n: number): void => setEntry(repo, "FOLD_MINOR", sport, n);
/** What the REAL table (the one the scratch repositories start from) holds for a sport. */
function realEntry(table: "FOLD_EPOCH" | "FOLD_MINOR", sport: string): number {
  const text = readFileSync(join(ENGINE, EPOCH_FILE), "utf8");
  const cut = text.indexOf(MINOR_DECL);
  const part = table === "FOLD_EPOCH" ? text.slice(0, cut) : text.slice(cut);
  const found = new RegExp(`\\b${sport}: (\\d+)`).exec(part)?.[1];
  if (found === undefined) throw new Error(`${sport} has no entry in ${table}`);
  return Number(found);
}
/** The one line that declares STATS_FOLD_VERSION, as the real stats module spells it (this file imports nothing under src/, so it is read). */
const STATS_DECL = /^export const STATS_FOLD_VERSION = ([0-9]+);$/m;
/** STATS_FOLD_VERSION as the REAL stats module declares it: the number every scratch repository starts at. */
function realStatsVersion(): number {
  const found = STATS_DECL.exec(readFileSync(join(ENGINE, STATS_FILE), "utf8"))?.[1];
  if (found === undefined) throw new Error(`${STATS_FILE} no longer declares STATS_FOLD_VERSION on a line of its own`);
  return Number(found);
}
/** Sets the constant in a scratch checkout's stats module (every other byte of the file is left alone). */
function setStatsVersion(repo: Repo, n: number): void {
  const file = join(repo.eng, STATS_FILE);
  const text = readFileSync(file, "utf8");
  if (!STATS_DECL.test(text)) throw new Error(`${STATS_FILE} in the scratch checkout declares no STATS_FOLD_VERSION to set`);
  writeFileSync(file, text.replace(STATS_DECL, `export const STATS_FOLD_VERSION = ${n};`));
}
/** Raises the constant above the live one (what a PR does that bumps it). */
const bumpStats = (repo: Repo, by = 1): void => setStatsVersion(repo, realStatsVersion() + by);
/** A change to the stats module's code that leaves its constant alone: fold source touched, nothing declared different. */
function touchStats(repo: Repo, marker = 1): void {
  const file = join(repo.eng, STATS_FILE);
  writeFileSync(file, `${readFileSync(file, "utf8")}\nexport const statsRuleChange${marker} = (n: number): number => n + ${marker};\n`);
}
/** The live entries, read when asked. A fixture below never holds a literal for what the table says: the first real bump (boardgame 1 -> 2
 *  in W2c, the lineup follow-up after it) would falsify it, and the scratch repositories start from the live table. */
const epochOf = (sport: string): number => realEntry("FOLD_EPOCH", sport);
const minorOf = (sport: string): number => realEntry("FOLD_MINOR", sport);
/** `epoch a -> b, minor c -> d` as the report spells it for a sport that starts at the live entries and moves by the given steps. */
const move = (sport: string, epochBy = 0, minorBy = 0): string =>
  `epoch ${epochOf(sport)} -> ${epochOf(sport) + epochBy}, minor ${minorOf(sport)} -> ${minorOf(sport) + minorBy}`;
/** The table as it was before FOLD_MINOR existed: no FOLD_MINOR declaration at all. */
function withoutMinor(text: string): string {
  const from = text.indexOf(MINOR_DECL);
  const end = text.indexOf(");", from);
  if (from < 0 || end < 0) throw new Error("the table declares no FOLD_MINOR to remove");
  return text.slice(0, from) + text.slice(end + 3);
}
/** A deltas-only change written by hand into a scratch corpus: the first stream's recorded standings deltas are different, every state, outcome
 *  and summary the same. It stands in for the shapes that really are deltas-only (GOLDEN-POLICY: `standingsDelta` code, credit on a metric that
 *  is not displayed, a default that only adds a key); a changed default VALUE is NOT one of them, it moves states and is a major. */
const moveDeltas = (repo: Repo, sport: string): void => editCorpus(repo, sport, (c) => { c.streams[0]!.deltas = `${String(c.streams[0]!.deltas)} `; });
function editTable(repo: Repo, fn: (text: string) => string): void {
  const file = join(repo.eng, EPOCH_FILE);
  writeFileSync(file, fn(readFileSync(file, "utf8")));
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
    expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`${move(FIRST)}, matched \\d+ changed 1 deltas-only 0 removed 0 added 0 recorded 0 - VIOLATION: major owed.*1 stream\\(s\\) fold differently`));
    expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 1));
    expect(r.stderr).toBe("");
    // and what to do about it: the entry, the number (read from the baseline's own table, not typed here), the file as git spells it, the command
    const was = realEntry("FOLD_EPOCH", FIRST);
    expect(lineOf(r.stdout, FIRST)).toContain(`raise FOLD_EPOCH.${FIRST} to ${was + 1} in src/sport/fold-epoch.ts`);
    expect(r.stdout).toContain(`fold-epoch: to clear the violation(s) above, raise the sport's entry in ${relPrefix(mono)}src/sport/fold-epoch.ts in this same change`);
    expect(r.stdout).toContain("fold-epoch:check --against origin/main");
  });

  spawnIt(3)("the same change with that sport's bump is green, and the report shows the epoch moving", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    setEpoch(mono, FIRST, epochOf(FIRST) + 1);
    commit(mono, "rule fix with bump");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`${move(FIRST, 1)}, matched \\d+ changed 1 deltas-only 0 removed 0 added 0 recorded 0$`));
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
      expect(lineOf(red.stdout, "badminton"), knob).toMatch(/changed 0 deltas-only 0 removed [1-9]\d* added [1-9]\d* recorded 0 - VIOLATION: major owed/);

      atBase(mono);
      launder();
      setEpoch(mono, "badminton", epochOf("badminton") + 1);
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
    expect(lineOf(red.stdout, FIRST)).toMatch(/changed 0 deltas-only 0 removed 1 added 0 recorded 0 - VIOLATION: major owed/);

    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.pop(); });
    setEpoch(mono, FIRST, epochOf(FIRST) + 1);
    commit(mono, "stream removed, bumped");
    expect(guard(mono).status).toBe(0);

    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.push({ ...c.streams[0]!, seed: 424242424 }); });
    commit(mono, "stream added");
    const added = guard(mono);
    expect(added.status).toBe(0);
    expect(lineOf(added.stdout, FIRST)).toMatch(/changed 0 deltas-only 0 removed 0 added 1 recorded 0$/);
  });

  spawnIt(4)("a sport added by the PR (absent from the baseline entirely) needs no bump, and the other sports are still compared", () => {
    atBase(mono);
    // the baseline commit has no trace of LAST: no corpus file, no table entry
    rmSync(corpusPath(mono, LAST));
    const tablePath = join(mono.eng, EPOCH_FILE);
    writeFileSync(tablePath, readFileSync(tablePath, "utf8").replace(new RegExp(`\\s*\\b${LAST}: \\d+,?`, "g"), "")); // from FOLD_EPOCH and from FOLD_MINOR
    const without = commit(mono, "engine without the last sport");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    const withIt = commit(mono, "the last sport arrives");
    expect(git(mono.top, "rev-parse", "HEAD^1")).toBe(without);
    expect(withIt).not.toBe(without);
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, LAST)).toMatch(new RegExp(`epoch \\(none\\) -> ${epochOf(LAST)}, minor \\(none\\) -> ${minorOf(LAST)}, matched 0 changed 0 deltas-only 0 removed 0 added \\d+ recorded 0$`));
    expect(r.stdout).toContain(`${realSports - 1} sports checked`);
    expect(violated(r.stdout)).toEqual([]);
  });

  spawnIt(4)("an epoch lowered is red, even though nothing in any corpus moved", () => {
    atBase(mono);
    const top = epochOf(FIRST) + 2; // two above the live entry, so the lowering below is still above it
    setEpoch(mono, FIRST, top);
    commit(mono, `raise to ${top}`);
    setEpoch(mono, FIRST, top - 1);
    commit(mono, `lower to ${top - 1}`);
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([FIRST]);
    expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`epoch ${top} -> ${top - 1}, .* - VIOLATION: .*went down`));
  });

  spawnIt(3)("two sports changed, only one bumped: red for the other sport alone", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    moveOutcome(mono, LAST);
    setEpoch(mono, FIRST, epochOf(FIRST) + 1);
    commit(mono, "two rule fixes, one bump");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout)).toEqual([LAST]);
    expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`${move(FIRST, 1)}, matched \\d+ changed 1 .* added 0 recorded 0$`));
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

describe("fold-epoch-guard CLI: the pair (major, minor) in a real git history (D34)", () => {
  /** The first corpus's report line, after one commit on the base. */
  const minorLine = (r: { stdout: string }, sport = FIRST): string => lineOf(r.stdout, sport);

  spawnIt(6)("a deltas-only change (every state, outcome and summary the same) owes a MINOR: red unbumped naming FOLD_MINOR and its number, green with the minor bump, green with the major bump", () => {
    atBase(mono);
    moveDeltas(mono, FIRST);
    commit(mono, "standings deltas changed, no bump");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    expect(minorLine(red)).toMatch(new RegExp(`${move(FIRST)}, matched \\d+ changed 0 deltas-only 1 removed 0 added 0 recorded 0 - VIOLATION: minor owed`));
    const was = realEntry("FOLD_MINOR", FIRST);
    expect(minorLine(red)).toContain(`raise FOLD_MINOR.${FIRST} to ${was + 1} in src/sport/fold-epoch.ts`);
    expect(red.stdout).not.toContain("raise FOLD_EPOCH");
    expect(red.stderr).toBe("");

    atBase(mono);
    moveDeltas(mono, FIRST);
    setMinor(mono, FIRST, was + 1);
    commit(mono, "standings deltas changed, minor bumped");
    const minor = guard(mono);
    expect({ status: minor.status, stderr: minor.stderr }).toEqual({ status: 0, stderr: "" });
    expect(minorLine(minor)).toMatch(new RegExp(`${move(FIRST, 0, 1)}, matched \\d+ changed 0 deltas-only 1 removed 0 added 0 recorded 0$`));
    expect(violated(minor.stdout)).toEqual([]);

    atBase(mono);
    moveDeltas(mono, FIRST);
    setEpoch(mono, FIRST, epochOf(FIRST) + 1);
    commit(mono, "standings deltas changed, major bumped");
    const major = guard(mono);
    expect({ status: major.status, stderr: major.stderr }).toEqual({ status: 0, stderr: "" });
    expect(minorLine(major)).toMatch(new RegExp(`${move(FIRST, 1)}, matched \\d+ changed 0 deltas-only 1 removed 0 added 0 recorded 0$`));
  });

  spawnIt(5)("a change a phone computes, with only the minor bumped, is still red and says the MAJOR is owed (and that the minor does not stand in); the major bump, with the minor reset, is green", () => {
    atBase(mono);
    moveOutcome(mono, FIRST);
    setMinor(mono, FIRST, minorOf(FIRST) + 1);
    commit(mono, "outcome changed, only the minor bumped");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    expect(minorLine(red)).toMatch(new RegExp(`${move(FIRST, 0, 1)}, matched \\d+ changed 1 deltas-only 0 removed 0 added 0 recorded 0 - VIOLATION: major owed`));
    expect(minorLine(red)).toContain(`raise FOLD_EPOCH.${FIRST} to ${epochOf(FIRST) + 1} in src/sport/fold-epoch.ts`);
    expect(minorLine(red)).toContain(`FOLD_MINOR ${minorOf(FIRST)} -> ${minorOf(FIRST) + 1} does not stand in for it`);

    atBase(mono);
    moveOutcome(mono, FIRST);
    setEpoch(mono, FIRST, epochOf(FIRST) + 1);
    commit(mono, "outcome changed, major bumped");
    expect(guard(mono).status).toBe(0);
  });

  spawnIt(5)("both kinds in one sport owe the major; and a stream REMOVED, with only the minor bumped, owes it too", () => {
    atBase(mono);
    moveOutcome(mono, FIRST); // stream 0: a phone computes it
    editCorpus(mono, FIRST, (c) => { c.streams[1]!.deltas = `${String(c.streams[1]!.deltas)} `; }); // stream 1: deltas only
    setMinor(mono, FIRST, minorOf(FIRST) + 1);
    commit(mono, "an outcome and a deltas change in one sport, minor bumped");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(minorLine(red)).toMatch(/matched \d+ changed 1 deltas-only 1 removed 0 added 0 recorded 0 - VIOLATION: major owed/);

    atBase(mono);
    editCorpus(mono, FIRST, (c) => { c.streams.pop(); });
    setMinor(mono, FIRST, minorOf(FIRST) + 1);
    commit(mono, "stream removed, only the minor bumped");
    const removed = guard(mono);
    expect(removed.status).toBe(1);
    expect(minorLine(removed)).toMatch(/changed 0 deltas-only 0 removed 1 added 0 recorded 0 - VIOLATION: major owed/);
  });

  spawnIt(8)("two sports, one owing a minor and one a major: each judged by its own pair; a bump in the other sport settles neither", () => {
    atBase(mono);
    moveDeltas(mono, FIRST);
    moveOutcome(mono, LAST);
    setMinor(mono, FIRST, minorOf(FIRST) + 1);
    setMinor(mono, LAST, minorOf(LAST) + 1); // wrong half for LAST
    commit(mono, "FIRST: deltas + minor bump; LAST: outcome + minor bump");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([LAST]);
    expect(minorLine(red, FIRST)).toMatch(/deltas-only 1 removed 0 added 0 recorded 0$/);

    atBase(mono);
    moveDeltas(mono, FIRST);
    moveOutcome(mono, LAST);
    setEpoch(mono, LAST, epochOf(LAST) + 1);
    setMinor(mono, FIRST, minorOf(FIRST) + 1);
    commit(mono, "FIRST: deltas + minor bump; LAST: outcome + major bump");
    expect(guard(mono).status).toBe(0);

    atBase(mono);
    moveDeltas(mono, FIRST);
    moveOutcome(mono, LAST);
    setEpoch(mono, LAST, epochOf(LAST) + 1); // LAST is paid; FIRST's own minor is not
    commit(mono, "FIRST: deltas, nothing; LAST: outcome + major bump");
    const first = guard(mono);
    expect(first.status).toBe(1);
    expect(violated(first.stdout)).toEqual([FIRST]);
    expect(minorLine(first, FIRST)).toContain("VIOLATION: minor owed");
  });

  spawnIt(9)("the pair only goes up: a minor that fell, a major that fell with the minor up, are red; a major up with the minor reset to 0 is green", () => {
    /** Main at `from`, then a PR that sets `to`, nothing else moved: the guard's verdict on that PR. */
    const pr = (from: readonly [number, number], to: readonly [number, number]) => {
      atBase(mono);
      setEpoch(mono, FIRST, from[0]);
      setMinor(mono, FIRST, from[1]);
      commit(mono, `main at (${from.join(", ")})`);
      setEpoch(mono, FIRST, to[0]);
      setMinor(mono, FIRST, to[1]);
      commit(mono, `the PR sets (${to.join(", ")})`);
      return guard(mono);
    };
    const minorDown = pr([3, 2], [3, 1]);
    expect(minorDown.status).toBe(1);
    expect(violated(minorDown.stdout)).toEqual([FIRST]);
    expect(minorLine(minorDown)).toMatch(/epoch 3 -> 3, minor 2 -> 1, .* - VIOLATION: FOLD_MINOR went down \(2 -> 1\)/);
    expect(minorLine(minorDown)).toContain(`set FOLD_MINOR.${FIRST} back to at least 2`);

    const majorDown = pr([3, 2], [2, 9]);
    expect(majorDown.status).toBe(1);
    expect(minorLine(majorDown)).toMatch(/epoch 3 -> 2, minor 2 -> 9, .* - VIOLATION: FOLD_EPOCH went down \(3 -> 2\)/);

    const reset = pr([3, 2], [4, 0]);
    expect({ status: reset.status, stderr: reset.stderr }).toEqual({ status: 0, stderr: "" });
    expect(minorLine(reset)).toMatch(/epoch 3 -> 4, minor 2 -> 0, /);
    expect(violated(reset.stdout)).toEqual([]);

    const same = pr([3, 2], [3, 2]);
    expect(same.status).toBe(0);
  });

  spawnIt(10)("a config object changed with every result the same (the laundering route) owes the MAJOR whatever the minor does", () => {
    expect(KEYS).toContain("badminton");
    const launder = (): void => editCorpus(mono, "badminton", (c) => { for (const cfg of Object.values(c.configs)) if (!("cap" in cfg)) cfg.cap = 30; });
    atBase(mono);
    launder();
    setMinor(mono, "badminton", minorOf("badminton") + 5);
    commit(mono, "cap written out explicitly, only the minor bumped");
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual(["badminton"]);
    expect(minorLine(red, "badminton")).toMatch(/changed 0 deltas-only 0 removed [1-9]\d* added [1-9]\d* recorded 0 - VIOLATION: major owed/);

    atBase(mono);
    launder();
    setEpoch(mono, "badminton", epochOf("badminton") + 1);
    commit(mono, "cap written out explicitly, major bumped");
    expect(guard(mono).status).toBe(0);
  });

  spawnIt(6)("the PR that introduces FOLD_MINOR (the baseline's table has none) reads as minor 0 for every sport: green when nothing moved, minor owed for a deltas-only change, settled by the minor", () => {
    const introduce = (edit: () => void): void => {
      atBase(mono);
      editTable(mono, withoutMinor);
      commit(mono, "main before FOLD_MINOR existed");
      git(mono.top, "checkout", "-q", "base", "--", ".");
      setMinor(mono, FIRST, 0); // the baseline reads every sport's minor as 0: a live entry above 0 would itself BE the bump this scenario withholds
      edit();
      commit(mono, "the PR that introduces FOLD_MINOR");
    };
    introduce(() => {});
    const quiet = guard(mono);
    expect({ status: quiet.status, stderr: quiet.stderr }).toEqual({ status: 0, stderr: "" });
    // the baseline's table has no minor (read as 0) and the PR's FIRST is set to 0 above: the major is the live entry on both sides
    expect(minorLine(quiet)).toContain(`epoch ${epochOf(FIRST)} -> ${epochOf(FIRST)}, minor 0 -> 0, `);
    expect(quiet.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0));

    introduce(() => moveDeltas(mono, FIRST));
    const red = guard(mono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    expect(minorLine(red)).toContain(`raise FOLD_MINOR.${FIRST} to 1 in src/sport/fold-epoch.ts`);

    introduce(() => { moveDeltas(mono, FIRST); setMinor(mono, FIRST, minorOf(FIRST) + 1); });
    expect(guard(mono).status).toBe(0);
  });

  spawnIt(4)("the engine at the repository root gives the same verdicts for a deltas-only change (the file is named as that repository spells it)", () => {
    atBase(rooted);
    moveDeltas(rooted, FIRST);
    commit(rooted, "standings deltas changed, no bump");
    const red = guard(rooted);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    expect(minorLine(red)).toContain(`raise FOLD_MINOR.${FIRST} to ${realEntry("FOLD_MINOR", FIRST) + 1} in src/sport/fold-epoch.ts`);
    atBase(rooted);
    moveDeltas(rooted, FIRST);
    setMinor(rooted, FIRST, minorOf(FIRST) + 1);
    commit(rooted, "standings deltas changed, minor bumped");
    expect(guard(rooted).status).toBe(0);
  });

  spawnIt(8)("a tree whose table has no FOLD_MINOR, declares one for other sports than FOLD_EPOCH's, or holds a minor that is not a non-negative integer, is refused (exit 2), never judged", () => {
    atBase(mono);
    editTable(mono, withoutMinor);
    commit(mono, "table without FOLD_MINOR");
    const none = guard(mono);
    expect(none.status).toBe(2);
    expect(none.stdout).toBe("");
    expect(none.stderr).toMatch(/src\/sport\/fold-epoch\.ts does not load: it has no FOLD_MINOR object export/);

    const inMinor = (fn: (literal: string) => string) => (text: string): string => {
      const from = text.indexOf(MINOR_DECL);
      const to = text.indexOf("} as const", from);
      return text.slice(0, from) + fn(text.slice(from, to)) + text.slice(to);
    };
    for (const [why, edit, message] of [
      ["a sport missing", inMinor((lit) => lit.replace(new RegExp(`\\b${FIRST}: \\d+,?\\s*`), "")), new RegExp(`FOLD_MINOR and FOLD_EPOCH must name the same sports.*${FIRST}`)],
      ["a sport nobody has", inMinor((lit) => lit.replace(/\{/, "{ quidditch: 0,")), /FOLD_MINOR and FOLD_EPOCH must name the same sports.*quidditch/],
      ["a negative minor", inMinor((lit) => lit.replace(new RegExp(`\\b${FIRST}: \\d+`), `${FIRST}: -1`)), new RegExp(`FOLD_MINOR\\.${FIRST} is -1, and a minor is a non-negative integer`)],
      ["a fractional minor", inMinor((lit) => lit.replace(new RegExp(`\\b${FIRST}: \\d+`), `${FIRST}: 1.5`)), new RegExp(`FOLD_MINOR\\.${FIRST} is 1\\.5, and a minor is a non-negative integer`)],
    ] as const) {
      atBase(mono);
      editTable(mono, edit);
      commit(mono, why);
      const r = guard(mono);
      expect(r.status, why).toBe(2);
      expect(r.stdout, why).toBe("");
      expect(r.stderr, why).toMatch(message);
    }
  });

  spawnIt(5)("a BASELINE table whose FOLD_MINOR is malformed is refused too, and says it is the baseline's", () => {
    atBase(mono);
    editTable(mono, (text) => text.replace(new RegExp(`(${MINOR_DECL}[^}]*?)\\b${FIRST}: \\d+`), `$1${FIRST}: -3`));
    commit(mono, "main with a broken FOLD_MINOR");
    git(mono.top, "checkout", "-q", "base", "--", ".");
    commit(mono, "the table is repaired");
    const r = guard(mono);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`src/sport/fold-epoch\\.ts at HEAD\\^1: FOLD_MINOR\\.${FIRST} is -3`));
  });

  spawnIt(3)("every sport's report line shows its own minor on both sides, as the table declares it (counted)", () => {
    atBase(mono);
    commit(mono, "docs only");
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const swept = KEYS.filter((k) => lineOf(r.stdout, k).includes(`, minor ${realEntry("FOLD_MINOR", k)} -> ${realEntry("FOLD_MINOR", k)}, `));
    expect(swept.length).toBe(realSports);
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
    if (bumpTheLast) setEpoch(mono, LAST, epochOf(LAST) + 1);
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
    expect(lineOf(r.stdout, FIRST)).toMatch(/changed 0 deltas-only 0 removed 0 added 0 recorded 0$/);
    // ... and would be red if the comparison were against the merge base, which is not what HEAD^1 is
    const wrong = guard(mono, "base");
    expect(violated(wrong.stdout).sort()).toEqual([FIRST, LAST].sort());
  });

  spawnIt(5)("the same merge ref with the PR's bump is green", () => {
    mergeRef("green", true);
    const r = guard(mono);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(lineOf(r.stdout, LAST)).toMatch(new RegExp(`${move(LAST, 1)}, matched \\d+ changed 1 `));
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

  spawnIt(3)("a stream that stores a key no format records is refused in a format-1 corpus too (the check is not a format-2 or 3 rule), and the key is named", () => {
    atBase(mono);
    editCorpus(mono, FIRST, (c) => {
      delete c.format;
      c.streams.forEach((st) => { for (const key of ["summaries", "overlay", "playerStats"]) delete st[key]; });
      c.streams[0]!.dense = { initial: {}, steps: {} };
    });
    commit(mono, "a format-1 stream that stores dense");
    const r = guard(mono);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
    expect(r.stderr).toMatch(/stream #0 carries a key no format records \("dense"\)/);
  });

  spawnIt(3)("every corpus deleted in the tree is red for every sport (an entry with no corpus), not a crash and not a pass", () => {
    atBase(mono);
    rmSync(join(mono.eng, SPORTS_DIR), { recursive: true });
    commit(mono, "src/sports deleted");
    const r = guard(mono);
    expect(r.status).toBe(1);
    expect(violated(r.stdout).sort()).toEqual([...KEYS].sort());
    expect(lineOf(r.stdout, FIRST)).toMatch(/matched 0 changed 0 deltas-only 0 removed \d+ added 0 recorded 0 - VIOLATION: .*FOLD_EPOCH entry but no golden corpus/);
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

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-2 T2: corpus format 2, in a real git history. The base here is a FORMAT-1 tree (the real corpora with the format-2 fields stripped,
// whatever the tree under test holds) and the "PR" adds the fields the way REFORMAT_GOLDEN does (placeholder digests: the guard compares
// strings and lengths, and the recorder itself is the engine's testkit, which a spawned script does not import). The scratch tree also
// holds stand-ins for the files the owner's rule is about: a kernel source file, a testkit file, a doc, the engine's package.json (the
// real one) and a root lockfile.

const KERNEL_FILE = "src/core/events.ts";
const TESTKIT_FILE = "src/testkit/helper.ts";
const DOC_FILE = "src/core/README.md";
const TEST_FILE = "src/core/events.test.ts";
const LOCKFILE = "pnpm-lock.yaml";

/** Rewrites every corpus of a scratch checkout. */
function eachCorpus(repo: Repo, fn: (c: Corpus) => Corpus): void {
  for (const f of CORPORA) {
    const file = join(repo.eng, SPORTS_DIR, f);
    writeFileSync(file, `${JSON.stringify(fn(JSON.parse(readFileSync(file, "utf8")) as Corpus), null, 0)}\n`); // the format golden.ts writes
  }
}
/** A corpus as format 1: no `format` key, no `summaries`, no `overlay`, no `playerStats`. */
function asFormat1(c: Corpus): Corpus {
  const { format: _format, ...rest } = c;
  return { ...rest, streams: c.streams.map(({ summaries: _s, overlay: _o, playerStats: _p, ...plain }) => plain) };
}
/** A corpus as format 2: `format: 2` just before `streams`, and every stream gains its two fields (one placeholder digest per event). */
function asFormat2(c: Corpus): Corpus {
  const { streams, ...rest } = asFormat1(c);
  return { ...rest, format: 2, streams: streams.map((s) => ({ ...s, summaries: (s.events as unknown[]).map((_, i) => `#${c.key}${i}`), overlay: "{}" })) };
}
/** A corpus as format 3 (GF-2 T4): format 2 plus `playerStats` on every stream (a placeholder row per stream: the guard compares text). */
function asFormat3(c: Corpus): Corpus {
  const { streams, ...rest } = asFormat2(c);
  return { ...rest, format: 3, streams: streams.map((s) => ({ ...s, playerStats: statsText(s) })) };
}
/** The placeholder stats of a stream: one row whose count is the stream's event count, so streams differ from each other. */
const statsText = (s: Record<string, unknown>): string => JSON.stringify([{ personId: "p", stats: { goals: (s.events as unknown[]).length } }]);
const recordFields = (repo: Repo): void => eachCorpus(repo, asFormat2);
const recordStats = (repo: Repo): void => eachCorpus(repo, asFormat3);
const put = (repo: Repo, rel: string, text: string, top = false): void => {
  const file = join(top ? repo.top : repo.eng, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (repo: Repo, rel: string): string => readFileSync(join(repo.eng, rel), "utf8");

let fmtMono: Repo; // format-1 base `f1`, its reformat `f2`
let fmtRooted: Repo;
const STREAMS = new Map<string, number>();
/** The git processes each format repository took to build (see FORMAT_BUILD_MS). */
const formatRepoSpawns: number[] = [];

function makeFormatRepo(name: string, prefix: string): Repo {
  const repo = makeRepo(name, prefix);
  eachCorpus(repo, asFormat1);
  put(repo, KERNEL_FILE, "export const settled = (m: string): string => `settled_${m}`;\n");
  put(repo, TESTKIT_FILE, "export const helper = 1;\n");
  put(repo, DOC_FILE, "# core\n");
  put(repo, TEST_FILE, "export {};\n");
  put(repo, LOCKFILE, "lockfileVersion: '9.0'\n", true);
  commit(repo, "format 1 base");
  git(repo.top, "tag", "f1");
  recordFields(repo);
  commit(repo, "the corpora gain their format-2 fields");
  git(repo.top, "tag", "f2");
  recordStats(repo);
  commit(repo, "the corpora gain their format-3 playerStats");
  git(repo.top, "tag", "f3");
  return repo;
}
const atF1 = (repo: Repo): void => {
  git(repo.top, "checkout", "-q", "--detach", "f1");
  git(repo.top, "reset", "-q", "--hard", "f1");
  git(repo.top, "clean", "-fdq");
};
const atF2 = (repo: Repo): void => {
  git(repo.top, "checkout", "-q", "--detach", "f2");
  git(repo.top, "reset", "-q", "--hard", "f2");
  git(repo.top, "clean", "-fdq");
};
const atF3 = (repo: Repo): void => {
  git(repo.top, "checkout", "-q", "--detach", "f3");
  git(repo.top, "reset", "-q", "--hard", "f3");
  git(repo.top, "clean", "-fdq");
};
/** The sports a run named VIOLATION for, sorted (the report is in the registry's alphabetical order, KEYS in file order). */
const violatedSorted = (out: string): string[] => violated(out).sort();
/** The `recorded N` of a sport's report line. */
const recordedOf = (out: string, sport: string): number => Number(/ recorded (\d+)(?: - |$)/.exec(lineOf(out, sport))?.[1] ?? Number.NaN);
const recordedTotal = (out: string): number => KEYS.reduce((n, k) => n + recordedOf(out, k), 0);
const bumpAll = (repo: Repo, keys: readonly string[] = KEYS): void => { for (const k of keys) setEpoch(repo, k, realEntry("FOLD_EPOCH", k) + 1); };

// The format repositories are built at FILE level, not inside one describe: both the GF-2 (format 2) and the GF-2 T4 (format 3) blocks
// read fmtMono/fmtRooted, and a `-t "GF-2 T4"` run skips the earlier block's hooks along with its tests, leaving them undefined.
beforeAll(() => {
  for (const f of CORPORA) {
    const c = JSON.parse(readFileSync(join(ENGINE, SPORTS_DIR, f), "utf8")) as Corpus;
    STREAMS.set(c.key, c.streams.length);
  }
  for (const [name, prefix] of [["fmt-mono", "packages/engine"], ["fmt-rooted", ""]] as const) {
    const before = gitSpawns;
    const repo = makeFormatRepo(name, prefix);
    formatRepoSpawns.push(gitSpawns - before);
    if (prefix === "") fmtRooted = repo;
    else fmtMono = repo;
  }
}, FORMAT_BUILD_MS);

describe("fold-epoch-guard CLI: GF-2 - corpus format 2 (Q1: a reformat owes nothing only while no fold source changes)", () => {
  // one `git show` per corpus per tag per layout: it spawns, so it states its budget like every spawning test here (a flat 5 s default
  // measured 4.3 s on an idle machine and 5.1 s on a loaded one: a latent red, found by raising a real epoch under load)
  spawnIt(KEYS.length * 6)("the rig: the base is format 1, its reformat is format 2 and the next is format 3, in every sport and layout (counted)", () => {
    // the beforeAll's budget is derived from these spawn counts: a repository that costs more than the budget assumes is a latent timeout
    expect(formatRepoSpawns, "one count per format repository").toEqual([REPO_SPAWNS + FORMAT_REPO_EXTRA_SPAWNS, REPO_SPAWNS + FORMAT_REPO_EXTRA_SPAWNS]);
    expect(STREAMS.size).toBe(realSports);
    let checked = 0;
    for (const repo of [fmtMono, fmtRooted]) {
      for (const [tag, format] of [["f1", undefined], ["f2", 2], ["f3", 3]] as const) {
        for (const f of CORPORA) {
          const c = JSON.parse(git(repo.top, "show", `${tag}:${relative(repo.top, join(repo.eng, SPORTS_DIR, f))}`)) as Corpus;
          expect(c.format, `${tag} ${f}`).toBe(format);
          expect(c.streams.every((st) => (st.summaries !== undefined) === (format !== undefined) && (st.overlay !== undefined) === (format !== undefined)), `${tag} ${f}`).toBe(true);
          expect(c.streams.every((st) => (st.playerStats !== undefined) === (format === 3)), `${tag} ${f}`).toBe(true);
          expect(c.streams.length, `${tag} ${f}`).toBe(STREAMS.get(c.key));
          checked++;
        }
      }
    }
    expect(checked).toBe(realSports * 6);
  });

  describe("(a) a reformat-only change", () => {
    for (const [layout, repo] of [["monorepo (packages/engine)", () => fmtMono], ["engine at a repository root", () => fmtRooted]] as const) {
      spawnIt(3)(`${layout}: is green, records every stream of every sport, and moves nothing - even beside edits to testkit, a doc and a test file`, () => {
        const r0 = repo();
        atF1(r0);
        recordFields(r0);
        put(r0, TESTKIT_FILE, "export const helper = 2;\n");
        put(r0, DOC_FILE, "# core, reworded\n");
        put(r0, TEST_FILE, "export const x = 1;\n");
        commit(r0, "reformat the corpora; harness, doc and test edits beside it");
        const r = guard(r0);
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
        expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0));
        for (const k of KEYS) {
          expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed 0 deltas-only 0 removed 0 added 0 recorded ${STREAMS.get(k)}$`));
        }
        expect(recordedTotal(r.stdout)).toBe(realStreams);
        expect(violated(r.stdout)).toEqual([]);
      });
    }

    spawnIt(3)("a change that gains the fields in TWO commits is judged on its net diff against the base, not commit by commit", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      commit(fmtMono, "reformat");
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      commit(fmtMono, "a kernel change on top");
      expect(guard(fmtMono).status, "the last commit alone records nothing and touches the kernel: green").toBe(0);
      const net = guard(fmtMono, "f1");
      expect(net.status, "the net diff gains the fields AND touches the kernel").toBe(1);
      expect(violatedSorted(net.stdout)).toEqual([...KEYS].sort());
    });
  });

  describe("(b) a reformat plus a kernel rule change in one diff", () => {
    spawnIt(5)("is red in EVERY sport, names the file and the way out, and is settled by each sport's own bump (the 'settled_' rename of the design note)", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      commit(fmtMono, "reformat + a kernel rule change");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
      for (const k of KEYS) {
        expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed ${STREAMS.get(k)} deltas-only 0 removed 0 added 0 recorded ${STREAMS.get(k)} - VIOLATION: major owed`));
        expect(lineOf(r.stdout, k), k).toContain(`${STREAMS.get(k)} newly recorded stream(s) while the change touches fold source: packages/engine/${KERNEL_FILE}`);
        expect(lineOf(r.stdout, k), k).toContain("land the format bump alone, or raise FOLD_EPOCH");
        expect(lineOf(r.stdout, k), k).toContain(`raise FOLD_EPOCH.${k} to ${realEntry("FOLD_EPOCH", k) + 1} in src/sport/fold-epoch.ts`);
      }
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", realSports));

      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      bumpAll(fmtMono);
      commit(fmtMono, "reformat + a kernel rule change, every sport bumped");
      const paid = guard(fmtMono);
      expect({ status: paid.status, stderr: paid.stderr }).toEqual({ status: 0, stderr: "" });
      expect(violated(paid.stdout)).toEqual([]);
      expect(recordedTotal(paid.stdout)).toBe(realStreams);

      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      bumpAll(fmtMono, KEYS.slice(1));
      commit(fmtMono, "reformat + a kernel rule change, all but one sport bumped");
      const part = guard(fmtMono);
      expect(part.status).toBe(1);
      expect(violatedSorted(part.stdout), "only the sport that was not bumped").toEqual([FIRST]);
    });

    spawnIt(3)("an UNTRACKED fold-source file in the working tree counts too (it is part of what the tree would ship), and so does a file moved OUT of src/", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      commit(fmtMono, "reformat");
      expect(guard(fmtMono).status, "control: the reformat alone is green").toBe(0);
      put(fmtMono, "src/core/untracked-rule.ts", "export const rule = 1;\n");
      const untracked = guard(fmtMono);
      expect(untracked.status).toBe(1);
      expect(lineOf(untracked.stdout, FIRST)).toContain("packages/engine/src/core/untracked-rule.ts");

      atF1(fmtMono);
      recordFields(fmtMono);
      git(fmtMono.top, "mv", join(fmtMono.eng, KERNEL_FILE), join(fmtMono.eng, "src/testkit/events.ts"));
      commit(fmtMono, "reformat + the kernel file moved into testkit");
      const moved = guard(fmtMono);
      expect(moved.status, "the OLD path of a rename is a touched path: moving a file out of src/ does not hide it").toBe(1);
      expect(lineOf(moved.stdout, FIRST)).toContain(`packages/engine/${KERNEL_FILE}`);
    });
  });

  describe("the change list is read in the repository's own spelling", () => {
    spawnIt(3)("a repository configured with diff.relative=true still reports repository-relative paths, so a kernel edit is not lost to the prefix", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      commit(fmtMono, "reformat + a kernel rule change");
      git(fmtMono.top, "config", "diff.relative", "true");
      try {
        const r = guard(fmtMono);
        expect(r.status, "red whatever the repository's diff.relative says").toBe(1);
        expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
        expect(lineOf(r.stdout, FIRST)).toContain(`packages/engine/${KERNEL_FILE}`);
      } finally {
        git(fmtMono.top, "config", "--unset", "diff.relative");
      }
    });
  });

  describe("a git that cannot list the change", () => {
    spawnIt(3)("is a refusal (exit 2, nothing judged), never a pass: here an unreadable index, with streams that need the change list", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      commit(fmtMono, "reformat alone");
      expect(guard(fmtMono).status, "control: the same tree is green with a readable index").toBe(0);
      const index = join(fmtMono.top, ".git", "index");
      const saved = readFileSync(index);
      try {
        writeFileSync(index, "not an index");
        const r = guard(fmtMono);
        expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
        expect(r.stderr).toMatch(/git diff --name-only HEAD\^1 \(or git ls-files --others\) failed/);
      } finally {
        writeFileSync(index, saved);
      }
    });
  });

  describe("(c) a reformat plus a change to the engine's package.json, or to the root lockfile", () => {
    spawnIt(4)("the engine's package.json (zod and the toolchain fold too) owes the major in every sport; so does the root lockfile; the ROOT package.json does not", () => {
      atF1(fmtMono);
      recordFields(fmtMono);
      const pkg = JSON.parse(read(fmtMono, "package.json")) as Record<string, unknown>;
      put(fmtMono, "package.json", `${JSON.stringify({ ...pkg, "x-probe": 1 }, null, 2)}\n`);
      commit(fmtMono, "reformat + engine package.json");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
      expect(lineOf(r.stdout, FIRST)).toContain("packages/engine/package.json");

      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, LOCKFILE, "lockfileVersion: '9.0'\nimporters: {}\n", true);
      commit(fmtMono, "reformat + root lockfile");
      const lock = guard(fmtMono);
      expect(lock.status).toBe(1);
      expect(violatedSorted(lock.stdout)).toEqual([...KEYS].sort());
      expect(lineOf(lock.stdout, FIRST)).toContain(LOCKFILE);

      atF1(fmtMono);
      recordFields(fmtMono);
      put(fmtMono, "package.json", "{\"name\": \"root-not-the-engine\"}\n", true);
      commit(fmtMono, "reformat + the ROOT package.json (not the engine's)");
      expect(guard(fmtMono).status, "outside the owner's list").toBe(0);
    });

    spawnIt(2)("with the engine at a repository root, package.json and the lockfile beside it are both the engine's", () => {
      atF1(fmtRooted);
      recordFields(fmtRooted);
      put(fmtRooted, LOCKFILE, "lockfileVersion: '9.0'\nimporters: {}\n");
      commit(fmtRooted, "reformat + lockfile, engine at the root");
      const r = guard(fmtRooted);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
      expect(lineOf(r.stdout, FIRST)).toContain(` ${LOCKFILE}`);
    });
  });

  describe("(d) on a format-2 base, a recorded kernel field that moves is a MAJOR owed", () => {
    const TWO = [FIRST, LAST] as const;
    const SCENARIOS: ReadonlyArray<readonly [string, (c: Corpus) => void]> = [
      ["overlay (how a suspension folds: its stoppage changed)", (c) => { c.streams[0]!.overlay = '{"stoppage":[[0,{"reason":"x"}]]}'; }],
      ["one per-step summary digest", (c) => { const sums = c.streams[0]!.summaries as string[]; sums[sums.length - 1] = "#moved"; }],
    ];
    for (const [label, edit] of SCENARIOS) {
      spawnIt(4)(`${label}, in two sports: exactly those two are red (nothing else in the corpus moved), and each is settled by its own bump`, () => {
        atF2(fmtMono);
        for (const k of TWO) editCorpus(fmtMono, k, edit);
        commit(fmtMono, "a kernel rule change re-recorded by a re-baseline, no bump");
        const r = guard(fmtMono);
        expect(r.status).toBe(1);
        expect(violatedSorted(r.stdout)).toEqual([...TWO].sort());
        for (const k of TWO) {
          expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed 1 deltas-only 0 removed 0 added 0 recorded 0 - VIOLATION: major owed, a phone computes this: 1 stream\\(s\\) fold differently`));
        }

        atF2(fmtMono);
        for (const k of TWO) editCorpus(fmtMono, k, edit);
        setEpoch(fmtMono, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1);
        commit(fmtMono, "same, one sport bumped");
        expect(violatedSorted(guard(fmtMono).stdout), "the bumped sport is settled, the other is not").toEqual([LAST]);

        atF2(fmtMono);
        for (const k of TWO) editCorpus(fmtMono, k, edit);
        bumpAll(fmtMono, TWO);
        commit(fmtMono, "same, both bumped");
        expect(guard(fmtMono).status).toBe(0);
      });
    }

    spawnIt(2)("a kernel SOURCE change with no corpus change owes nothing: the freeze only decides what a newly recorded stream owes", () => {
      atF2(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      commit(fmtMono, "a kernel edit that moves no recorded value");
      const r = guard(fmtMono);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      expect(recordedTotal(r.stdout)).toBe(0);
    });
  });

  describe("(e) a pre-existing field changed during the reformat", () => {
    for (const [field, edit] of [
      ["outcome", (c: Corpus) => { c.streams[0]!.outcome = `${String(c.streams[0]!.outcome)} `; }],
      ["summary", (c: Corpus) => { c.streams[0]!.summary = `${String(c.streams[0]!.summary)} `; }],
      ["a mid-match state", (c: Corpus) => { const st = c.streams[0]!.states as string[]; st[0] = `${st[0]} `; }],
    ] as const) {
      spawnIt(4)(`${field}: the frozen source does not hide it - that sport alone is red with a major owed (Q6), the others record cleanly`, () => {
        atF1(fmtMono);
        recordFields(fmtMono);
        editCorpus(fmtMono, FIRST, edit);
        commit(fmtMono, `reformat, and ${field} of ${FIRST} re-recorded`);
        const r = guard(fmtMono);
        expect(r.status).toBe(1);
        expect(violated(r.stdout)).toEqual([FIRST]);
        expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`matched ${STREAMS.get(FIRST)} changed 1 deltas-only 0 removed 0 added 0 recorded ${STREAMS.get(FIRST)} - VIOLATION: major owed`));
        expect(lineOf(r.stdout, LAST)).toMatch(new RegExp(`changed 0 .* recorded ${STREAMS.get(LAST)}$`));
        // paying it means editing src/sport/fold-epoch.ts, which IS fold source: the other sports' newly recorded streams then owe too,
        // so the one bump settles that sport only; the reformat has to land alone, or every sport has to be bumped
        setEpoch(fmtMono, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1);
        commit(fmtMono, "bumped");
        const oneBump = guard(fmtMono, "f1");
        expect(oneBump.status, "the table edit makes every other sport's recorded streams owe").toBe(1);
        expect(violatedSorted(oneBump.stdout)).toEqual(KEYS.filter((k) => k !== FIRST).sort());
        expect(lineOf(oneBump.stdout, FIRST), "the bumped sport is settled").toMatch(/recorded \d+$/);
        bumpAll(fmtMono, KEYS.filter((k) => k !== FIRST));
        commit(fmtMono, "every sport bumped");
        expect(guard(fmtMono, "f1").status, "every sport bumped").toBe(0);
      });
    }
  });

  describe("the format never falls, and a malformed format is a refusal", () => {
    spawnIt(3)("a format-2 corpus rewritten as format 1 is red in every sport, and no bump settles it", () => {
      atF2(fmtMono);
      eachCorpus(fmtMono, asFormat1);
      commit(fmtMono, "the fields dropped");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
      expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`corpus format fell \\(2 -> 1\\): ${STREAMS.get(FIRST)} stream\\(s\\)`));
      bumpAll(fmtMono);
      commit(fmtMono, "dropped and bumped");
      expect(guard(fmtMono, "f2").status, "a bump does not restore a dropped pin").toBe(1);
    });

    spawnIt(4)("the fall is judged on the CORPUS, not on the streams that happen to match: format 1 with every stream re-recorded, and the bump paid, is still red", () => {
      const sport = "badminton"; // the sport of the reviewer's reproduction: 22 streams
      expect(KEYS).toContain(sport);
      const rerecord = (c: Corpus): void => { for (const s of c.streams) s.seed = Number(s.seed) + 1_000_003; };
      // the control: re-recorded but still format 2, with the bump, is green - so what is red below IS the format
      atF2(fmtMono);
      editCorpus(fmtMono, sport, rerecord);
      setEpoch(fmtMono, sport, realEntry("FOLD_EPOCH", sport) + 1);
      commit(fmtMono, `${sport} re-recorded in format 2, bumped`);
      const control = guard(fmtMono);
      expect({ status: control.status, stderr: control.stderr, violated: violated(control.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      // the reproduction: format 1, every stream re-recorded (nothing matches), the epoch raised
      atF2(fmtMono);
      editCorpus(fmtMono, sport, (c) => {
        rerecord(c);
        delete c.format;
        for (const s of c.streams) { delete s.summaries; delete s.overlay; }
      });
      setEpoch(fmtMono, sport, realEntry("FOLD_EPOCH", sport) + 1);
      commit(fmtMono, `${sport} rewritten as format 1, re-recorded, bumped`);
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violated(r.stdout)).toEqual([sport]);
      const n = STREAMS.get(sport)!;
      expect(lineOf(r.stdout, sport)).toMatch(new RegExp(`matched 0 changed 0 deltas-only 0 removed ${n} added ${n} recorded 0 - VIOLATION: .*corpus format fell \\(2 -> 1\\): ${n} stream\\(s\\)`));
      // and the other sports, untouched, are not blamed
      expect(violated(r.stdout)).not.toContain(FIRST === sport ? LAST : FIRST);
    });

    const BAD: ReadonlyArray<readonly [string, (c: Corpus) => void, RegExp]> = [
      ["an unknown format", (c) => { c.format = 4; }, /declares corpus format 4; this guard reads formats 1, 2 and 3/],
      ["a format-2 stream that carries playerStats (a hybrid)", (c) => { c.streams[0]!.playerStats = "[]"; }, /stream #0 records playerStats, but the corpus is format 2/],
      // GF-2 batch review M-1: `dense` is the recorder's probe-only form, and a spread of a recomputation writes it into a corpus unnoticed
      ["a stream that stores a key no format records (the probe-only dense overlay)", (c) => { c.streams[0]!.dense = { initial: {}, steps: {} }; }, /stream #0 carries a key no format records \("dense"\)/],
      ["a format-2 stream without summaries", (c) => { delete c.streams[1]!.summaries; }, /stream #1 is malformed \(a format-2 stream needs summaries/],
      ["a format-2 stream without an overlay", (c) => { delete c.streams[0]!.overlay; }, /stream #0 is malformed \(a format-2 stream needs summaries/],
      ["summaries with fewer digests than events", (c) => { (c.streams[0]!.summaries as string[]).pop(); }, /stream #0 is malformed/],
      ["a non-string digest", (c) => { (c.streams[0]!.summaries as unknown[])[0] = 7; }, /stream #0 is malformed/],
      ["an overlay that is not JSON", (c) => { c.streams[0]!.overlay = "{nope"; }, /stream #0 is malformed/],
      ["an overlay that is JSON but not an object", (c) => { c.streams[0]!.overlay = "[]"; }, /stream #0 is malformed/],
      // JSON.parse coerces its argument to a string, so an ARRAY holding the text of an object parses as that object: only the typeof check refuses it
      ["an overlay that is an array holding the text of an object", (c) => { c.streams[0]!.overlay = ["{}"]; }, /stream #0 is malformed/],
    ];
    spawnIt(BAD.length + 2)("each malformed format-2 corpus is refused (exit 2, nothing judged), whichever side holds it", () => {
      for (const [label, edit, message] of BAD) {
        atF2(fmtMono);
        editCorpus(fmtMono, FIRST, edit);
        commit(fmtMono, `current side: ${label}`);
        const r = guard(fmtMono, "f2");
        expect({ label, status: r.status, stdout: r.stdout }, label).toEqual({ label, status: 2, stdout: "" });
        expect(r.stderr, label).toMatch(message);
      }
      // the same corpus as the BASELINE: refused too, with the baseline named
      atF2(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { delete c.streams[0]!.overlay; });
      const bad = commit(fmtMono, "a baseline with a half-recorded stream");
      atF2(fmtMono);
      const r = guard(fmtMono, bad);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`at ${bad}: stream #0 is malformed`));
    });

    spawnIt(2)("a format-1 corpus that already holds a format-2 field is refused: a half-converted corpus is not 'unrecorded'", () => {
      atF1(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { c.streams[0]!.overlay = "{}"; });
      commit(fmtMono, "a hybrid");
      const r = guard(fmtMono);
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/stream #0 records summaries or an overlay, but the corpus is format 1/);
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-2 T4: corpus format 3 (`playerStats`), in a real git history. The tags above give the history `f1` (format 1) -> `f2` (format 2) ->
// `f3` (format 3, one placeholder stats row per stream). The classifier of "does this change touch fold source" is the SAME one (Q1): what
// differs is only what a newly recorded `playerStats` owes when it does - the MINOR, because a phone never computes a player stat (owner
// ruling Q2, 2026-10-15) - and that a recorded stat that moves is a minor too.

/** A stats move written by hand into a scratch corpus: the first stream's recorded final rows are different. */
const moveStats = (repo: Repo, sport: string, goals = 999): void => editCorpus(repo, sport, (c) => { c.streams[0]!.playerStats = `[{"personId":"p","stats":{"goals":${goals}}}]`; });
/** The name a STATS_FOLD_VERSION violation goes by in `violated()` (the report line is `fold-epoch: STATS_FOLD_VERSION: a -> b, ...`). */
const STATS_NAME = "STATS_FOLD_VERSION";
/** The `stats-only N` of a sport's report line (absent when 0, which is how the guard prints it). */
const statsOnlyOf = (out: string, sport: string): number => Number(/ stats-only (\d+)(?: - |$)/.exec(lineOf(out, sport))?.[1] ?? 0);
const bumpMinorAll = (repo: Repo, keys: readonly string[] = KEYS): void => { for (const k of keys) setMinor(repo, k, realEntry("FOLD_MINOR", k) + 1); };

describe("fold-epoch-guard CLI: GF-2 T4 - corpus format 3 (player stats are a minor)", () => {
  describe("(a) a 2 -> 3 reformat-only change", () => {
    for (const [layout, repo] of [["monorepo (packages/engine)", () => fmtMono], ["engine at a repository root", () => fmtRooted]] as const) {
      spawnIt(3)(`${layout}: is green, records every stream of every sport, and moves nothing - even beside edits to testkit, a doc and a test file`, () => {
        const r0 = repo();
        atF2(r0);
        recordStats(r0);
        put(r0, TESTKIT_FILE, "export const helper = 3;\n");
        put(r0, DOC_FILE, "# core, reworded again\n");
        put(r0, TEST_FILE, "export const y = 2;\n");
        commit(r0, "reformat to format 3; harness, doc and test edits beside it");
        const r = guard(r0);
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
        expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0));
        for (const k of KEYS) {
          expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed 0 deltas-only 0 removed 0 added 0 recorded ${STREAMS.get(k)}$`));
        }
        expect(recordedTotal(r.stdout)).toBe(realStreams);
        expect(violated(r.stdout)).toEqual([]);
      });
    }

    spawnIt(28)("a change that goes from format 1 straight to format 3 follows the kernel rule: green while no fold source moves, a MAJOR when it does (a minor bump does not stand in); the stats version is owed beside it, and a major does not pay it (GF-3 T1)", () => {
      atF1(fmtMono);
      recordStats(fmtMono);
      commit(fmtMono, "format 1 -> 3 in one step");
      const green = guard(fmtMono);
      expect({ status: green.status, stderr: green.stderr, violated: violated(green.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(recordedTotal(green.stdout)).toBe(realStreams);

      atF1(fmtMono);
      recordStats(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      bumpMinorAll(fmtMono);
      commit(fmtMono, "format 1 -> 3 and a kernel change, every minor bumped");
      const red = guard(fmtMono);
      expect(red.status).toBe(1);
      expect(violatedSorted(red.stdout), "every sport's major, and the stats version beside them").toEqual([...KEYS, STATS_NAME].sort());
      expect(lineOf(red.stdout, FIRST)).toContain("major owed, a phone computes this");

      atF1(fmtMono);
      recordStats(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      bumpAll(fmtMono);
      commit(fmtMono, "format 1 -> 3 and a kernel change, every major bumped");
      const majors = guard(fmtMono);
      expect({ status: majors.status, violated: violated(majors.stdout) }, "a major settles every sport and not the stats version").toEqual({ status: 1, violated: [STATS_NAME] });

      atF1(fmtMono);
      recordStats(fmtMono);
      put(fmtMono, KERNEL_FILE, "export const settled = (m: string): string => `settled-${m}`;\n");
      bumpAll(fmtMono);
      bumpStats(fmtMono);
      commit(fmtMono, "format 1 -> 3 and a kernel change, every major bumped and the stats version raised");
      expect(guard(fmtMono).status).toBe(0);
    });
  });

  describe("(b) a 2 -> 3 reformat plus a change to fold source in the same diff: the MINOR is owed", () => {
    spawnIt(35)("is red in EVERY sport as a minor, names the file and the way out, and is settled by each sport's own FOLD_MINOR (or FOLD_EPOCH) bump, with the stats version raised beside it (GF-3 T1)", () => {
      atF2(fmtMono);
      recordStats(fmtMono);
      touchStats(fmtMono);
      commit(fmtMono, "reformat to format 3 + a stats rule change");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(violatedSorted(r.stdout), "every sport's minor, and the stats version beside them").toEqual([...KEYS, STATS_NAME].sort());
      for (const k of KEYS) {
        expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed 0 deltas-only 0 removed 0 added 0 recorded ${STREAMS.get(k)} - VIOLATION: minor owed, only the server computes this`));
        expect(lineOf(r.stdout, k), k).toContain(`${STREAMS.get(k)} newly recorded stream(s) of player stats while the change touches fold source: packages/engine/src/stats/stats.ts`);
        expect(lineOf(r.stdout, k), k).toContain("land the stats field alone, or raise FOLD_MINOR");
        expect(lineOf(r.stdout, k), k).toContain(`raise FOLD_MINOR.${k} to ${realEntry("FOLD_MINOR", k) + 1} in src/sport/fold-epoch.ts`);
      }
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", realSports + 1));

      atF2(fmtMono);
      recordStats(fmtMono);
      touchStats(fmtMono);
      bumpMinorAll(fmtMono);
      commit(fmtMono, "same, every FOLD_MINOR bumped");
      const minors = guard(fmtMono);
      expect({ status: minors.status, violated: violated(minors.stdout) }, "the minors do not pay the stats version").toEqual({ status: 1, violated: [STATS_NAME] });

      atF2(fmtMono);
      recordStats(fmtMono);
      touchStats(fmtMono);
      bumpMinorAll(fmtMono);
      bumpStats(fmtMono);
      commit(fmtMono, "same, every FOLD_MINOR bumped and the stats version raised");
      const paid = guard(fmtMono);
      expect({ status: paid.status, stderr: paid.stderr, violated: violated(paid.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(recordedTotal(paid.stdout)).toBe(realStreams);

      atF2(fmtMono);
      recordStats(fmtMono);
      touchStats(fmtMono);
      bumpAll(fmtMono);
      bumpStats(fmtMono);
      commit(fmtMono, "same, every FOLD_EPOCH bumped and the stats version raised");
      expect(guard(fmtMono).status, "a major settles a minor").toBe(0);

      atF2(fmtMono);
      recordStats(fmtMono);
      touchStats(fmtMono);
      bumpMinorAll(fmtMono, KEYS.slice(1));
      bumpStats(fmtMono);
      commit(fmtMono, "same, all but one sport's minor bumped, the stats version raised");
      const part = guard(fmtMono);
      expect(part.status).toBe(1);
      expect(violatedSorted(part.stdout), "only the sport that was not bumped").toEqual([FIRST]);
    });

    spawnIt(2)("an UNTRACKED fold-source file counts too, and the minor still does not become a major", () => {
      atF2(fmtMono);
      recordStats(fmtMono);
      commit(fmtMono, "reformat to format 3");
      expect(guard(fmtMono).status, "control: the reformat alone is green").toBe(0);
      put(fmtMono, "src/stats/untracked-rule.ts", "export const rule = 1;\n");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(lineOf(r.stdout, FIRST)).toContain("packages/engine/src/stats/untracked-rule.ts");
      expect(lineOf(r.stdout, FIRST)).toContain("minor owed");
      expect(lineOf(r.stdout, FIRST)).not.toContain("major owed");
    });

    spawnIt(2)("with the engine at a repository root the same verdicts hold", () => {
      atF2(fmtRooted);
      recordStats(fmtRooted);
      touchStats(fmtRooted);
      commit(fmtRooted, "reformat to format 3 + a stats rule change, engine at the root");
      const r = guard(fmtRooted);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout), "every sport's minor, and the stats version beside them").toEqual([...KEYS, STATS_NAME].sort());
      expect(statsLine(r.stdout), "the engine at the root: the touched path has no prefix").toContain("newly record player stats while the change touches fold source: src/stats/stats.ts (");
      expect(lineOf(r.stdout, FIRST)).toContain(" src/stats/stats.ts");
      expect(lineOf(r.stdout, FIRST)).toContain("minor owed");
    });
  });

  describe("(c) on a format-3 base, a recorded stat that moves is a MINOR owed", () => {
    const TWO = [FIRST, LAST] as const;
    spawnIt(5)("in two sports: exactly those two are red (stats-only 1), each is settled by its own minor bump, and a major settles it too", () => {
      atF3(fmtMono);
      for (const k of TWO) moveStats(fmtMono, k);
      commit(fmtMono, "a stats rule change re-recorded by a re-baseline, no bump");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout), "the two sports' minors, and (GF-3 T1) the stats version beside them").toEqual([...TWO, STATS_NAME].sort());
      for (const k of TWO) {
        expect(lineOf(r.stdout, k), k).toMatch(new RegExp(`matched ${STREAMS.get(k)} changed 0 deltas-only 0 removed 0 added 0 recorded 0 stats-only 1 - VIOLATION: minor owed, only the server computes this: 1 stream\\(s\\) differ in their player stats`));
        expect(lineOf(r.stdout, k), k).toContain(`raise FOLD_MINOR.${k} to ${realEntry("FOLD_MINOR", k) + 1}`);
        expect(statsOnlyOf(r.stdout, k), k).toBe(1);
      }
      for (const k of KEYS.filter((x) => !TWO.includes(x as never))) expect(statsOnlyOf(r.stdout, k), `${k} did not move`).toBe(0);

      atF3(fmtMono);
      for (const k of TWO) moveStats(fmtMono, k);
      setMinor(fmtMono, FIRST, realEntry("FOLD_MINOR", FIRST) + 1);
      commit(fmtMono, "same, one sport's minor bumped");
      expect(violatedSorted(guard(fmtMono).stdout), "the bumped sport is settled, the other is not (and neither bump is the stats version's)").toEqual([LAST, STATS_NAME].sort());

      atF3(fmtMono);
      for (const k of TWO) moveStats(fmtMono, k);
      bumpMinorAll(fmtMono, TWO);
      bumpStats(fmtMono);
      commit(fmtMono, "same, both minors bumped, and the stats version");
      const paid = guard(fmtMono);
      expect(paid.status).toBe(0);
      expect(lineOf(paid.stdout, FIRST)).toMatch(/stats-only 1$/);

      atF3(fmtMono);
      for (const k of TWO) moveStats(fmtMono, k);
      bumpAll(fmtMono, TWO);
      bumpStats(fmtMono);
      commit(fmtMono, "same, both majors bumped, and the stats version");
      expect(guard(fmtMono).status, "a major settles a minor").toBe(0);
    });

    spawnIt(3)("a stat that moves beside a state: a MAJOR is owed, the minor bump does not settle it, and the line counts it once as changed", () => {
      atF3(fmtMono);
      moveStats(fmtMono, FIRST);
      moveOutcome(fmtMono, FIRST);
      commit(fmtMono, "stats and outcome moved");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(lineOf(r.stdout, FIRST)).toMatch(/changed 1 deltas-only 0 removed 0 added 0 recorded 0 - VIOLATION: major owed/);
      expect(statsOnlyOf(r.stdout, FIRST), "a changed stream is not also stats-only").toBe(0);
      atF3(fmtMono);
      moveStats(fmtMono, FIRST);
      moveOutcome(fmtMono, FIRST);
      setMinor(fmtMono, FIRST, realEntry("FOLD_MINOR", FIRST) + 1);
      bumpStats(fmtMono);
      commit(fmtMono, "same, minor bumped, and the stats version");
      expect(violated(guard(fmtMono).stdout), "a minor does not stand in for the major").toEqual([FIRST]);
      atF3(fmtMono);
      moveStats(fmtMono, FIRST);
      moveOutcome(fmtMono, FIRST);
      setEpoch(fmtMono, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1);
      bumpStats(fmtMono);
      commit(fmtMono, "same, major bumped, and the stats version");
      expect(guard(fmtMono).status).toBe(0);
    });

    spawnIt(3)("nothing moved but a FOLD_MINOR bump is not a violation, and stats re-recorded to the same text are no move", () => {
      atF3(fmtMono);
      setMinor(fmtMono, FIRST, realEntry("FOLD_MINOR", FIRST) + 1);
      commit(fmtMono, "a minor raised with nothing moved");
      expect(guard(fmtMono).status).toBe(0);
      atF3(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { c.streams[0]!.playerStats = String(c.streams[0]!.playerStats); });
      commit(fmtMono, "stats rewritten as the same text");
      const same = guard(fmtMono);
      expect({ status: same.status, violated: violated(same.stdout) }).toEqual({ status: 0, violated: [] });
    });

    spawnIt(2)("with the engine at a repository root the same verdict holds", () => {
      atF3(fmtRooted);
      moveStats(fmtRooted, FIRST);
      commit(fmtRooted, "a stats move, engine at the root");
      const r = guard(fmtRooted);
      expect(r.status).toBe(1);
      expect(violated(r.stdout)).toEqual([FIRST, STATS_NAME]);
      expect(lineOf(r.stdout, FIRST)).toMatch(/stats-only 1 - VIOLATION: minor owed/);
    });
  });

  describe("(d) the format never falls, and a malformed format 3 is a refusal", () => {
    spawnIt(5)("format 3 rewritten as format 2, or as format 1, is red in every sport, and no bump settles it", () => {
      atF3(fmtMono);
      eachCorpus(fmtMono, asFormat2);
      commit(fmtMono, "the playerStats dropped");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout)).toEqual([...KEYS].sort());
      expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`corpus format fell \\(3 -> 2\\): ${STREAMS.get(FIRST)} stream\\(s\\) recorded their player stats at the baseline`));
      bumpAll(fmtMono);
      bumpMinorAll(fmtMono);
      commit(fmtMono, "dropped and bumped");
      expect(guard(fmtMono, "f3").status, "a bump does not restore a dropped pin").toBe(1);

      atF3(fmtMono);
      eachCorpus(fmtMono, asFormat1);
      commit(fmtMono, "all the new fields dropped");
      const r1 = guard(fmtMono);
      expect(r1.status).toBe(1);
      expect(lineOf(r1.stdout, FIRST)).toMatch(new RegExp(`corpus format fell \\(3 -> 1\\): ${STREAMS.get(FIRST)} stream\\(s\\) recorded their summaries, overlay and player stats`));
    });

    spawnIt(4)("the fall is judged on the CORPUS: format 2 with every stream re-recorded, and the bump paid, is still red", () => {
      const sport = "badminton";
      expect(KEYS).toContain(sport);
      const rerecord = (c: Corpus): void => { for (const s of c.streams) s.seed = Number(s.seed) + 1_000_003; };
      atF3(fmtMono);
      editCorpus(fmtMono, sport, rerecord);
      setEpoch(fmtMono, sport, realEntry("FOLD_EPOCH", sport) + 1);
      commit(fmtMono, `${sport} re-recorded in format 3, bumped`);
      const control = guard(fmtMono);
      expect({ status: control.status, violated: violated(control.stdout) }, "the control: still format 3, bumped: green").toEqual({ status: 0, violated: [] });
      atF3(fmtMono);
      editCorpus(fmtMono, sport, (c) => {
        rerecord(c);
        c.format = 2;
        for (const s of c.streams) delete s.playerStats;
      });
      setEpoch(fmtMono, sport, realEntry("FOLD_EPOCH", sport) + 1);
      commit(fmtMono, `${sport} rewritten as format 2, re-recorded, bumped`);
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violated(r.stdout)).toEqual([sport]);
      const n = STREAMS.get(sport)!;
      expect(lineOf(r.stdout, sport)).toMatch(new RegExp(`matched 0 changed 0 deltas-only 0 removed ${n} added ${n} recorded 0 - VIOLATION: .*corpus format fell \\(3 -> 2\\): ${n} stream\\(s\\)`));
    });

    const BAD: ReadonlyArray<readonly [string, (c: Corpus) => void, RegExp]> = [
      ["a format-3 stream without playerStats", (c) => { delete c.streams[1]!.playerStats; }, /stream #1 is malformed \(a format-3 stream needs playerStats/],
      ["a stream that stores a key no format records (the probe-only dense overlay)", (c) => { c.streams[0]!.dense = { initial: {}, steps: {} }; }, /stream #0 carries a key no format records \("dense"\)/],
      ["playerStats that is not a string", (c) => { c.streams[0]!.playerStats = []; }, /stream #0 is malformed \(a format-3 stream needs playerStats/],
      // JSON.parse coerces its argument to a string, so an ARRAY holding the text of an array parses as that array: only the typeof check refuses it
      ["playerStats that is an array holding the text of an array", (c) => { c.streams[0]!.playerStats = ["[]"]; }, /stream #0 is malformed/],
      ["playerStats that is not JSON", (c) => { c.streams[0]!.playerStats = "{nope"; }, /stream #0 is malformed/],
      ["playerStats that is JSON but not an array", (c) => { c.streams[0]!.playerStats = "{}"; }, /stream #0 is malformed/],
      ["a row without a personId", (c) => { c.streams[0]!.playerStats = '[{"stats":{}}]'; }, /stream #0 is malformed/],
      ["a row whose stats is an array", (c) => { c.streams[0]!.playerStats = '[{"personId":"p","stats":[]}]'; }, /stream #0 is malformed/],
      ["a row whose stat is not a number", (c) => { c.streams[0]!.playerStats = '[{"personId":"p","stats":{"goals":"3"}}]'; }, /stream #0 is malformed/],
      // `1e999` is a valid JSON number that parses to Infinity: `typeof` accepts it, only `Number.isFinite` refuses it
      ["a row whose stat is not a finite number", (c) => { c.streams[0]!.playerStats = '[{"personId":"p","stats":{"goals":1e999}}]'; }, /stream #0 is malformed/],
      ["a row that is not an object", (c) => { c.streams[0]!.playerStats = "[1]"; }, /stream #0 is malformed/],
      ["a format-3 stream without its summaries", (c) => { delete c.streams[0]!.summaries; }, /stream #0 is malformed \(a format-3 stream needs summaries/],
      ["a format-3 stream without its overlay", (c) => { delete c.streams[0]!.overlay; }, /stream #0 is malformed \(a format-3 stream needs summaries/],
    ];
    spawnIt(BAD.length + 2)("each malformed format-3 corpus is refused (exit 2, nothing judged), whichever side holds it", () => {
      for (const [label, edit, message] of BAD) {
        atF3(fmtMono);
        editCorpus(fmtMono, FIRST, edit);
        commit(fmtMono, `current side: ${label}`);
        const r = guard(fmtMono, "f3");
        expect({ label, status: r.status, stdout: r.stdout }, label).toEqual({ label, status: 2, stdout: "" });
        expect(r.stderr, label).toMatch(message);
      }
      atF3(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { delete c.streams[0]!.playerStats; });
      const bad = commit(fmtMono, "a baseline with a half-recorded stream");
      atF3(fmtMono);
      const r = guard(fmtMono, bad);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`at ${bad}: stream #0 is malformed`));
    });

    spawnIt(3)("a format-1 or format-2 corpus that already holds playerStats is refused: a half-converted corpus is not 'unrecorded'", () => {
      atF1(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { c.streams[0]!.playerStats = "[]"; });
      commit(fmtMono, "a format-1 hybrid");
      const one = guard(fmtMono);
      expect({ status: one.status, stdout: one.stdout }).toEqual({ status: 2, stdout: "" });
      expect(one.stderr).toMatch(/stream #0 records playerStats, but the corpus is format 1/);
      atF2(fmtMono);
      editCorpus(fmtMono, FIRST, (c) => { c.streams[0]!.playerStats = "[]"; });
      commit(fmtMono, "a format-2 hybrid");
      const two = guard(fmtMono);
      expect({ status: two.status, stdout: two.stdout }).toEqual({ status: 2, stdout: "" });
      expect(two.stderr).toMatch(/stream #0 records playerStats, but the corpus is format 2/);
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-3 T1: STATS_FOLD_VERSION (src/stats/stats.ts) must RISE whenever the player stats a corpus records move, in the same diff. One number
// for the engine, read by its exact declaration from the baseline commit and the working tree, independent of every sport's epoch and
// minor. The scratch repositories hold the REAL stats module (its constant is whatever it is today: every expectation below reads it with
// `realStatsVersion`, never a literal), and a "PR" is a commit that edits corpora, the table and the constant the way a re-baseline would.

/** git spawns of one `fromF3` scenario: back to f3 (checkout, reset, clean), the commit (add, commit, rev-parse), the guard run. */
const SCENARIO_SPAWNS = 3 + 3 + 1;
/** One PR on the format-3 base: the edit, a commit, and the guard against `ref` (HEAD^1 by default). */
function fromF3(repo: Repo, message: string, edit: (r: Repo) => void, ref = "HEAD^1") {
  atF3(repo);
  edit(repo);
  commit(repo, message);
  return guard(repo, ref);
}
/** The report line of the stats version (`fold-epoch: STATS_FOLD_VERSION: a -> b, player stats moved in N stream(s) ...`). */
const statsLine = (out: string): string => out.split("\n").find((l) => l.startsWith(`fold-epoch: ${STATS_NAME}: `)) ?? "";
/** The tail of the summary line. */
const statsTail = (before: number | string, after: number): string => `, STATS_FOLD_VERSION ${before} -> ${after}`;
const STATS_REL = "src/stats/stats.ts";

describe("fold-epoch-guard CLI: GF-3 T1 - STATS_FOLD_VERSION must rise when recorded player stats change", () => {
  describe("(a) the rule, in a real git history", () => {
    spawnIt(SCENARIO_SPAWNS)("a stats move with the sport's own minor paid and no STATS_FOLD_VERSION bump is red on the stats version ALONE: it names the constant, the file and both values", () => {
      const v = realStatsVersion();
      const r = fromF3(fmtMono, "stats move, the sport's minor paid, no stats bump", (m) => { moveStats(m, FIRST); setMinor(m, FIRST, realEntry("FOLD_MINOR", FIRST) + 1); });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(violated(r.stdout)).toEqual([STATS_NAME]);
      expect(lineOf(r.stdout, FIRST), "the sport itself is settled").toMatch(/stats-only 1$/);
      const line = statsLine(r.stdout);
      expect(line).toContain(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 1 stream(s) (${FIRST}) - VIOLATION: ${STATS_NAME} must rise: `);
      expect(line).toContain(`did not rise (${v} -> ${v})`);
      expect(line).toContain(`raise STATS_FOLD_VERSION to ${v + 1} in ${STATS_REL}`);
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 1) + statsTail(v, v));
      expect(r.stdout).toContain(`and STATS_FOLD_VERSION in ${relPrefix(fmtMono)}${STATS_REL} where its line says it must rise`);
    });

    spawnIt(SCENARIO_SPAWNS)("an unbumped stats move owes BOTH: the sport's minor and the stats version, each named on its own line", () => {
      const v = realStatsVersion();
      const r = fromF3(fmtMono, "stats move, nothing bumped", (m) => { moveStats(m, FIRST); });
      expect(r.status).toBe(1);
      expect(violatedSorted(r.stdout)).toEqual([FIRST, STATS_NAME].sort());
      expect(lineOf(r.stdout, FIRST)).toContain("minor owed, only the server computes this");
      expect(statsLine(r.stdout)).toContain(`${STATS_NAME} must rise`);
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 2) + statsTail(v, v));
    });

    spawnIt(3 * SCENARIO_SPAWNS)("each bump pays only its own debt: the minor alone leaves the stats version red, the stats bump alone leaves the sport red, both together are green", () => {
      const v = realStatsVersion();
      const minor = realEntry("FOLD_MINOR", FIRST) + 1;
      const only = fromF3(fmtMono, "the minor alone", (m) => { moveStats(m, FIRST); setMinor(m, FIRST, minor); });
      expect(violated(only.stdout)).toEqual([STATS_NAME]);
      const stats = fromF3(fmtMono, "the stats bump alone", (m) => { moveStats(m, FIRST); bumpStats(m); });
      expect(stats.status).toBe(1);
      expect(violated(stats.stdout)).toEqual([FIRST]);
      expect(statsLine(stats.stdout)).toContain(`${v} -> ${v + 1}, player stats moved in 1 stream(s) (${FIRST})`);
      expect(statsLine(stats.stdout)).not.toContain("VIOLATION");
      expect(stats.stdout, "the hint names no stats step when the stats version is fine").not.toContain("STATS_FOLD_VERSION in ");
      const both = fromF3(fmtMono, "both", (m) => { moveStats(m, FIRST); setMinor(m, FIRST, minor); bumpStats(m); });
      expect({ status: both.status, stderr: both.stderr, violated: violated(both.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(statsLine(both.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v + 1}, player stats moved in 1 stream(s) (${FIRST})`);
      expect(both.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0) + statsTail(v, v + 1));
    });

    spawnIt(2 * SCENARIO_SPAWNS)("a MAJOR bump does not settle it, with the stats beside a phone output that moved or not: the stats version is red whatever the epoch did", () => {
      const v = realStatsVersion();
      const apart = fromF3(fmtMono, "stats move, the sport's MAJOR bumped, no stats bump", (m) => { moveStats(m, FIRST); setEpoch(m, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1); });
      expect(violated(apart.stdout)).toEqual([STATS_NAME]);
      const beside = fromF3(fmtMono, "stats and outcome moved, the MAJOR bumped, no stats bump", (m) => { moveStats(m, FIRST); moveOutcome(m, FIRST); setEpoch(m, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1); });
      expect(beside.status).toBe(1);
      expect(violated(beside.stdout)).toEqual([STATS_NAME]);
      expect(lineOf(beside.stdout, FIRST), "the stream counts as changed (a phone output), and still as a stats move").toMatch(/changed 1 deltas-only 0 removed 0 added 0 recorded 0$/);
      expect(statsLine(beside.stdout)).toContain(`${v} -> ${v}, player stats moved in 1 stream(s) (${FIRST})`);
    });

    spawnIt(2 * SCENARIO_SPAWNS)("a sport-only violation leaves the stats line clean and the hint without a stats step (the control)", () => {
      const v = realStatsVersion();
      const r = fromF3(fmtMono, "an outcome move, no bump", (m) => { moveOutcome(m, FIRST); });
      expect(violated(r.stdout)).toEqual([FIRST]);
      expect(statsLine(r.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 0 stream(s)`);
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 1) + statsTail(v, v));
      expect(r.stdout).not.toContain("STATS_FOLD_VERSION in ");
      const quiet = fromF3(fmtMono, "docs only", (m) => { put(m, DOC_FILE, "# core, reworded\n"); });
      expect({ status: quiet.status, violated: violated(quiet.stdout) }).toEqual({ status: 0, violated: [] });
    });

    spawnIt(3 * SCENARIO_SPAWNS)("a bump with no stats change is green, and so is a change to the stats module's code that moved no recorded stat", () => {
      const v = realStatsVersion();
      const bump = fromF3(fmtMono, "stats version raised on its own", (m) => { bumpStats(m); });
      expect({ status: bump.status, stderr: bump.stderr, violated: violated(bump.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(statsLine(bump.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v + 1}, player stats moved in 0 stream(s)`);
      const code = fromF3(fmtMono, "stats module touched, constant and corpora alone", (m) => { touchStats(m); });
      expect({ status: code.status, violated: violated(code.stdout) }).toEqual({ status: 0, violated: [] });
      const big = fromF3(fmtMono, "stats version raised by several", (m) => { bumpStats(m, 5); });
      expect(big.status).toBe(0);
      expect(statsLine(big.stdout)).toContain(`${v} -> ${v + 5}`);
    });

    spawnIt(SCENARIO_SPAWNS + 3)("the version never falls: a fall is red with nothing else changed, and no sport bump settles it", () => {
      const v = realStatsVersion();
      atF3(fmtMono);
      bumpStats(fmtMono);
      commit(fmtMono, "stats version raised");
      setStatsVersion(fmtMono, v);
      for (const k of KEYS) setEpoch(fmtMono, k, realEntry("FOLD_EPOCH", k) + 1);
      commit(fmtMono, "stats version put back, every epoch raised");
      const r = guard(fmtMono);
      expect(r.status).toBe(1);
      expect(violated(r.stdout)).toEqual([STATS_NAME]);
      expect(statsLine(r.stdout)).toContain(`${v + 1} -> ${v}, player stats moved in 0 stream(s) - VIOLATION: ${STATS_NAME} went down (${v + 1} -> ${v}); a version only rises: set STATS_FOLD_VERSION back to at least ${v + 1} in ${STATS_REL}`);
    });
  });

  describe("(b) what owes nothing", () => {
    spawnIt(SCENARIO_SPAWNS)("a 2 -> 3 reformat that touches no fold source owes no stats bump: green with the version held (nothing stored was computed differently)", () => {
      const v = realStatsVersion();
      atF2(fmtMono);
      recordStats(fmtMono);
      commit(fmtMono, "reformat to format 3");
      const frozen = guard(fmtMono);
      expect({ status: frozen.status, violated: violated(frozen.stdout), recorded: recordedTotal(frozen.stdout) }).toEqual({ status: 0, violated: [], recorded: realStreams });
      expect(frozen.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0) + statsTail(v, v));
      expect(statsLine(frozen.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 0 stream(s)`);
    });

    spawnIt(3 * SCENARIO_SPAWNS)("a 2 -> 3 reformat that touches fold source (the stats module) owes the stats bump beside the sport's minor: each is paid on its own, and the line names the newly recorded streams", () => {
      const v = realStatsVersion();
      const reformat = (m: Repo, edits: (r: Repo) => void): void => { atF2(m); recordStats(m); touchStats(m); edits(m); commit(m, "reformat to format 3 beside a stats-module change"); };
      // the sport's minor paid, the version not: red on the version ALONE
      reformat(fmtMono, (m) => { bumpMinorAll(m); });
      const red = guard(fmtMono);
      expect({ status: red.status, stderr: red.stderr, violated: violated(red.stdout), recorded: recordedTotal(red.stdout) }).toEqual({ status: 1, stderr: "", violated: [STATS_NAME], recorded: realStreams });
      const sportsSorted = [...KEYS].sort().join(", ");
      expect(statsLine(red.stdout)).toContain(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 0 stream(s), newly recorded in ${realStreams} stream(s) (${sportsSorted}) under touched fold source - VIOLATION: ${STATS_NAME} must rise: ${realStreams} stream(s) (${sportsSorted}) newly record player stats while the change touches fold source: ${relPrefix(fmtMono)}${EPOCH_FILE}, ${relPrefix(fmtMono)}${STATS_REL} (land the stats field alone, or raise STATS_FOLD_VERSION), and ${STATS_NAME} did not rise (${v} -> ${v}): raise STATS_FOLD_VERSION to ${v + 1} in ${STATS_REL}`);
      expect(red.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 1) + statsTail(v, v));
      expect(red.stdout).toContain(`and STATS_FOLD_VERSION in ${relPrefix(fmtMono)}${STATS_REL} where its line says it must rise`);
      // the version paid, the sport's minors not: red on the sports, not on the version
      reformat(fmtMono, (m) => { bumpStats(m); });
      const sports = guard(fmtMono);
      expect(sports.status).toBe(1);
      expect(violatedSorted(sports.stdout)).toEqual([...KEYS].sort());
      expect(statsLine(sports.stdout)).toContain(`${v} -> ${v + 1}, player stats moved in 0 stream(s), newly recorded in ${realStreams} stream(s)`);
      expect(statsLine(sports.stdout)).not.toContain("VIOLATION");
      // both paid: green, and the line still says what was newly recorded
      reformat(fmtMono, (m) => { bumpMinorAll(m); bumpStats(m); });
      const green = guard(fmtMono);
      expect({ status: green.status, stderr: green.stderr, violated: violated(green.stdout), recorded: recordedTotal(green.stdout) }).toEqual({ status: 0, stderr: "", violated: [], recorded: realStreams });
      expect(statsLine(green.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v + 1}, player stats moved in 0 stream(s), newly recorded in ${realStreams} stream(s) (${sportsSorted}) under touched fold source`);
    });

    spawnIt(4 * SCENARIO_SPAWNS)("a stream removed or re-recorded owes no stats bump (its input changed, so its stats are not comparable): it owes its sport's MAJOR", () => {
      const v = realStatsVersion();
      const lineups = (c: Corpus): void => { c.streams[0]!.lineups = { home: [], away: [] }; c.streams[0]!.playerStats = '[{"personId":"p","stats":{"goals":777}}]'; };
      const seed = (c: Corpus): void => { c.streams[0]!.seed = Number(c.streams[0]!.seed) + 1_000_003; c.streams[0]!.playerStats = '[{"personId":"p","stats":{"goals":777}}]'; };
      for (const [name, edit] of [["other lineups", lineups], ["another seed", seed]] as const) {
        const red = fromF3(fmtMono, `re-recorded with ${name}, no bump`, (m) => { editCorpus(m, FIRST, edit); });
        expect(violated(red.stdout), name).toEqual([FIRST]);
        expect(lineOf(red.stdout, FIRST), name).toMatch(/removed 1 added 1 recorded 0 - VIOLATION: major owed/);
        const green = fromF3(fmtMono, `re-recorded with ${name}, major bumped`, (m) => { editCorpus(m, FIRST, edit); setEpoch(m, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1); });
        expect({ status: green.status, violated: violated(green.stdout) }, name).toEqual({ status: 0, violated: [] });
        expect(statsLine(green.stdout), name).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 0 stream(s)`);
      }
    });

    spawnIt(SCENARIO_SPAWNS)("a stream APPENDED already in format 3 (EXTEND_GOLDEN) owes no stats bump", () => {
      const r = fromF3(fmtMono, "a stream appended", (m) => {
        editCorpus(m, FIRST, (c) => {
          const copy = { ...c.streams[0]!, seed: Number(c.streams[0]!.seed) + 2_000_003 };
          c.streams.push(copy);
        });
      });
      expect({ status: r.status, stderr: r.stderr, violated: violated(r.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(lineOf(r.stdout, FIRST)).toMatch(/added 1 recorded 0$/);
    });
  });

  describe("(c) with the engine at a repository root", () => {
    spawnIt(2 * SCENARIO_SPAWNS)("the same verdicts hold, and the hint names the file without a prefix", () => {
      const v = realStatsVersion();
      const red = fromF3(fmtRooted, "stats move, the minor paid, no stats bump", (m) => { moveStats(m, FIRST); setMinor(m, FIRST, realEntry("FOLD_MINOR", FIRST) + 1); });
      expect(red.status).toBe(1);
      expect(violated(red.stdout)).toEqual([STATS_NAME]);
      expect(red.stdout).toContain(`and STATS_FOLD_VERSION in ${STATS_REL} where its line says it must rise`);
      expect(red.stdout).not.toContain("packages/engine");
      const green = fromF3(fmtRooted, "same with the stats bump", (m) => { moveStats(m, FIRST); setMinor(m, FIRST, realEntry("FOLD_MINOR", FIRST) + 1); bumpStats(m); });
      expect({ status: green.status, violated: violated(green.stdout) }).toEqual({ status: 0, violated: [] });
      expect(green.stdout).toContain(statsTail(v, v + 1));
    });
  });

  describe("(d) the second call, and the next change", () => {
    spawnIt(SCENARIO_SPAWNS + 9)("the same run twice prints the same report, and a later change is judged against the bump already spent", () => {
      const v = realStatsVersion();
      const m0 = realEntry("FOLD_MINOR", FIRST);
      atF3(fmtMono);
      moveStats(fmtMono, FIRST);
      setMinor(fmtMono, FIRST, m0 + 1);
      bumpStats(fmtMono);
      commit(fmtMono, "PR 1: a stats move with both bumps");
      const first = guard(fmtMono, "f3");
      expect({ status: first.status, violated: violated(first.stdout) }).toEqual({ status: 0, violated: [] });
      const again = guard(fmtMono, "f3");
      expect({ status: again.status, stdout: again.stdout, stderr: again.stderr }, "the second call is the same").toEqual({ status: first.status, stdout: first.stdout, stderr: first.stderr });
      // PR 2 on top of PR 1: another move of the same stream, the minor raised again, the stats version left at what PR 1 made it
      moveStats(fmtMono, FIRST, 1000);
      setMinor(fmtMono, FIRST, m0 + 2);
      commit(fmtMono, "PR 2: another stats move, no new stats bump");
      const red = guard(fmtMono);
      expect(red.status).toBe(1);
      expect(violated(red.stdout)).toEqual([STATS_NAME]);
      expect(statsLine(red.stdout)).toContain(`did not rise (${v + 1} -> ${v + 1}): raise STATS_FOLD_VERSION to ${v + 2}`);
      // the working tree is what is judged: raising it there, uncommitted, is enough (and the dirty tree is cleaned up whatever the verdict,
      // or the next scenario's checkout aborts on it)
      try {
        setStatsVersion(fmtMono, v + 2);
        const paid = guard(fmtMono);
        expect({ status: paid.status, violated: violated(paid.stdout) }).toEqual({ status: 0, violated: [] });
        expect(statsLine(paid.stdout)).toContain(`${v + 1} -> ${v + 2}, player stats moved in 1 stream(s)`);
      } finally {
        git(fmtMono.top, "reset", "-q", "--hard", "HEAD");
      }
    });
  });

  describe("(e) fail closed: a number the guard cannot read is a refusal (exit 2, nothing judged), never a pass", () => {
    const declared = (v: number): string => `export const STATS_FOLD_VERSION = ${v};`;
    const REWRITES: ReadonlyArray<readonly [string, (text: string, v: number) => string, RegExp]> = [
      ["a type annotation", (t, v) => t.replace(declared(v), `export const STATS_FOLD_VERSION: number = ${v};`), /src\/stats\/stats\.ts declares no line `export const STATS_FOLD_VERSION = <integer>;`/],
      ["a deleted declaration", (t, v) => t.replace(`${declared(v)}\n`, ""), /declares no line/],
      ["the constant declared twice", (t, v) => `${t}\n${declared(v + 1)}\n`, /declares `STATS_FOLD_VERSION` 2 times/],
      ["zero", (t, v) => t.replace(declared(v), declared(0)), /STATS_FOLD_VERSION is 0, and a version is a positive integer/],
      ["a leading zero", (t, v) => t.replace(declared(v), `export const STATS_FOLD_VERSION = 0${v};`), /STATS_FOLD_VERSION is 0\d+, and a version is a positive integer/],
      ["a number beyond the safe integers", (t, v) => t.replace(declared(v), "export const STATS_FOLD_VERSION = 9007199254740993;"), /STATS_FOLD_VERSION is 9007199254740993, and a version is a positive integer/],
    ];
    spawnIt(REWRITES.length * SCENARIO_SPAWNS)("the tree's stats module: each unreadable declaration is refused even though nothing else changed (counted)", () => {
      const v = realStatsVersion();
      let refused = 0;
      for (const [name, rewrite, message] of REWRITES) {
        const r = fromF3(fmtMono, `the tree's stats module with ${name}`, (m) => { put(m, STATS_REL, rewrite(read(m, STATS_REL), v)); });
        expect({ name, status: r.status, stdout: r.stdout }, name).toEqual({ name, status: 2, stdout: "" });
        expect(r.stderr, name).toMatch(message);
        expect(r.stderr, name).toMatch(/^fold-epoch: src\/stats\/stats\.ts[: ]/);
        refused++;
      }
      expect(refused).toBe(REWRITES.length);
    });

    spawnIt(SCENARIO_SPAWNS)("the tree's stats module deleted is refused, naming the file", () => {
      const r = fromF3(fmtMono, "the stats module deleted", (m) => { rmSync(join(m.eng, STATS_REL)); });
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/^fold-epoch: src\/stats\/stats\.ts is missing: the guard cannot read STATS_FOLD_VERSION/);
    });

    spawnIt(SCENARIO_SPAWNS + 4)("a BASELINE that has the file must parse too: refused, and the message says it is the baseline's", () => {
      atF3(fmtMono);
      put(fmtMono, STATS_REL, read(fmtMono, STATS_REL).replace(`export const STATS_FOLD_VERSION = ${realStatsVersion()};`, `export const STATS_FOLD_VERSION: number = ${realStatsVersion()};`));
      commit(fmtMono, "main with an unreadable stats version");
      git(fmtMono.top, "checkout", "-q", "f3", "--", ".");
      commit(fmtMono, "the PR puts the declaration back");
      const r = guard(fmtMono);
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/^fold-epoch: src\/stats\/stats\.ts at HEAD\^1 declares no line/);
    });

    spawnIt(SCENARIO_SPAWNS + 10)("a trailing // comment on the declaration is read, on the tree's and on the baseline's alike; code after the semicolon is still refused", () => {
      const v = realStatsVersion();
      const plain = declared(v);
      const ok = fromF3(fmtMono, "the declaration carries a trailing comment", (m) => { put(m, STATS_REL, read(m, STATS_REL).replace(plain, `${plain} // bump when the stats fold changes`)); });
      expect({ status: ok.status, stderr: ok.stderr, violated: violated(ok.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(statsLine(ok.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v}, player stats moved in 0 stream(s)`);
      // both sides commented: main has the comment, the PR raises the number and keeps it
      atF3(fmtMono);
      put(fmtMono, STATS_REL, read(fmtMono, STATS_REL).replace(plain, `${plain} // c`));
      commit(fmtMono, "main with a commented declaration");
      put(fmtMono, STATS_REL, read(fmtMono, STATS_REL).replace(`${plain} // c`, `${declared(v + 1)} // c`));
      commit(fmtMono, "the PR raises the number and keeps the comment");
      const both = guard(fmtMono);
      expect({ status: both.status, stderr: both.stderr, violated: violated(both.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(statsLine(both.stdout)).toBe(`fold-epoch: ${STATS_NAME}: ${v} -> ${v + 1}, player stats moved in 0 stream(s)`);
    });

    spawnIt(SCENARIO_SPAWNS)("code after the semicolon, comment or not, is refused (the CLI end of the exact-declaration rule)", () => {
      const v = realStatsVersion();
      const r = fromF3(fmtMono, "code after the declaration", (m) => { put(m, STATS_REL, read(m, STATS_REL).replace(declared(v), `${declared(v)} export const B = 1; // c`)); });
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/declares no line/);
    });

    spawnIt(2 * (3 + 1 + 3 + 1 + 3 + 1))("the introducing-PR pass (no table, no guard at the baseline) still reads the tree's number: unreadable or missing is refused there too", () => {
      for (const [name, edit, message] of [
        ["unreadable", (m: Repo) => put(m, STATS_REL, read(m, STATS_REL).replace(/^export const STATS_FOLD_VERSION = \d+;$/m, "export const STATS_FOLD_VERSION = 'six';")), /declares no line/],
        ["deleted", (m: Repo) => rmSync(join(m.eng, STATS_REL)), /src\/stats\/stats\.ts is missing/],
      ] as const) {
        atBase(mono);
        git(mono.top, "rm", "-q", join(mono.eng, EPOCH_FILE), join(mono.eng, GUARD));
        commit(mono, "main before the table and the guard");
        git(mono.top, "checkout", "-q", "base", "--", ".");
        edit(mono);
        commit(mono, `the PR that introduces FOLD_EPOCH, with the stats module ${name}`);
        const r = guard(mono);
        expect({ name, status: r.status, stdout: r.stdout }, name).toEqual({ name, status: 2, stdout: "" });
        expect(r.stderr, name).toMatch(message);
      }
    });
  });

  describe("(f) a baseline with no stats module", () => {
    spawnIt(SCENARIO_SPAWNS + 5)("that records player stats is refused: the module moved, and nothing can be judged against a baseline that has no number", () => {
      atF3(fmtMono);
      git(fmtMono.top, "rm", "-q", join(fmtMono.eng, STATS_REL));
      commit(fmtMono, "main without the stats module (its corpora record stats)");
      git(fmtMono.top, "checkout", "-q", "f3", "--", ".");
      commit(fmtMono, "the PR brings the stats module back");
      const r = guard(fmtMono);
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/^fold-epoch: the baseline records player stats \(corpus format 3\) but declares no STATS_FOLD_VERSION \(no src\/stats\/stats\.ts\): the stats module was moved or renamed/);
    });

    spawnIt(SCENARIO_SPAWNS)("a stats module MOVED to another path, with the guard taught the new path and a stats move without any bump in the same PR, is refused", () => {
      atF3(fmtMono);
      const moved = "src/stats/moved-stats.ts";
      renameSync(join(fmtMono.eng, STATS_REL), join(fmtMono.eng, moved));
      const guardFile = join(fmtMono.eng, GUARD);
      const text = readFileSync(guardFile, "utf8");
      const taught = text.replace(`const STATS_FILE = "${STATS_REL}";`, `const STATS_FILE = "${moved}";`);
      expect(taught, "the copied guard names its stats module in one constant").not.toBe(text);
      writeFileSync(guardFile, taught);
      moveStats(fmtMono, FIRST);
      commit(fmtMono, "stats module moved, a stats move, no bump");
      const r = guard(fmtMono);
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toMatch(/the baseline records player stats .* declares no STATS_FOLD_VERSION \(no src\/stats\/moved-stats\.ts\)/);
    });

    spawnIt(SCENARIO_SPAWNS + 5)("that records NO player stats is the bootstrap: nothing was stored under a number, so nothing is owed, and the report says the baseline had none", () => {
      const v = realStatsVersion();
      atF2(fmtMono);
      git(fmtMono.top, "rm", "-q", join(fmtMono.eng, STATS_REL));
      commit(fmtMono, "main from before the stats module (format-2 corpora)");
      git(fmtMono.top, "checkout", "-q", "f2", "--", join(fmtMono.eng, STATS_REL));
      commit(fmtMono, "the PR that introduces the stats module");
      const r = guard(fmtMono);
      expect({ status: r.status, stderr: r.stderr, violated: violated(r.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
      expect(statsLine(r.stdout)).toBe(`fold-epoch: ${STATS_NAME}: (none) -> ${v}, player stats moved in 0 stream(s)`);
      expect(r.stdout).toContain(summary(realSports, realStreams, "HEAD^1", 0) + statsTail("(none)", v));
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-3 T2: a stream's `foldOptions` ({ "forfeitAward": [winner, loser] }, the server-only fold input), in a real git history. It is part of the
// stream's INPUT, in every format: a shape the recorder never writes is a refusal (exit 2, naming the stream), a valid one is read (it is not "a key
// no format records"), and an award that changed is a re-recorded stream - a major owed, not a moved output. The pure rule is in
// fold-epoch-guard.test.ts; what only a real repository shows is that the SCRIPT reads and refuses the field.
describe("fold-epoch-guard CLI: GF-3 T2 - foldOptions", () => {
  const AWARD = { forfeitAward: [5, 1] };
  const addAward = (award: unknown = AWARD) => (c: Corpus): void => { c.streams[0]!.foldOptions = award; };
  const BAD: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", [5, 1]],
    ["an empty object", {}],
    ["another key beside the award", { forfeitAward: [5, 1], strictFromSeq: 0 }],
    ["another key instead of the award", { strictFromSeq: 0 }],
    ["an award that is not a pair", { forfeitAward: [5] }],
    ["an award of three numbers", { forfeitAward: [5, 1, 0] }],
    ["a negative score", { forfeitAward: [-1, 0] }],
    ["a fractional score", { forfeitAward: [2.5, 0] }],
    ["a score that is not a number", { forfeitAward: ["5", 1] }],
  ];
  spawnIt(BAD.length + 3)("each malformed foldOptions is refused (exit 2, nothing judged), naming the stream, whichever side holds it", () => {
    let refused = 0;
    for (const [label, value] of BAD) {
      atF3(fmtMono);
      editCorpus(fmtMono, FIRST, addAward(value));
      commit(fmtMono, `current side: ${label}`);
      const r = guard(fmtMono, "f3");
      expect({ label, status: r.status, stdout: r.stdout }, label).toEqual({ label, status: 2, stdout: "" });
      expect(r.stderr, label).toMatch(/stream #0 \(\S+#\d+\) has malformed foldOptions \(.+\): the only fold option a corpus records is \{ "forfeitAward": \[winner, loser\] \}/);
      refused++;
    }
    expect(refused, "every malformed shape was tried").toBe(BAD.length);
    // the same corpus as the BASELINE is refused too, with the baseline named
    atF3(fmtMono);
    editCorpus(fmtMono, FIRST, addAward({ forfeitAward: [-1, 0] }));
    const bad = commit(fmtMono, "a baseline with a malformed foldOptions");
    atF3(fmtMono);
    const r = guard(fmtMono, bad);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`at ${bad}: stream #0 \\(\\S+#\\d+\\) has malformed foldOptions`));
  });

  spawnIt(4)("a valid foldOptions is read, not refused as a key no format records: the same award on both sides is green, matched, and owes nothing", () => {
    atF3(fmtMono);
    editCorpus(fmtMono, FIRST, addAward());
    commit(fmtMono, "an award on stream 0");
    editCorpus(fmtMono, FIRST, (c) => { c.streams[1]!.outcome = String(c.streams[1]!.outcome); }); // a commit that changes nothing in the corpus's meaning
    commit(fmtMono, "nothing moved");
    const r = guard(fmtMono);
    expect({ status: r.status, stderr: r.stderr, violated: violated(r.stdout) }).toEqual({ status: 0, stderr: "", violated: [] });
    expect(lineOf(r.stdout, FIRST)).toMatch(new RegExp(`matched ${STREAMS.get(FIRST)} changed 0 deltas-only 0 removed 0 added 0 recorded 0$`));
  });

  spawnIt(8)("an award that changed owes a MAJOR even though no recorded output moved: removed AND added, never 'changed'; a bump pays it", () => {
    atF3(fmtMono);
    editCorpus(fmtMono, FIRST, addAward());
    commit(fmtMono, "baseline: an award on stream 0");
    editCorpus(fmtMono, FIRST, addAward({ forfeitAward: [6, 1] }));
    commit(fmtMono, "the award changed, every recorded output the same");
    const red = guard(fmtMono);
    expect(red.status).toBe(1);
    expect(violated(red.stdout)).toEqual([FIRST]);
    const n = STREAMS.get(FIRST)!;
    expect(lineOf(red.stdout, FIRST)).toMatch(new RegExp(`matched ${n - 1} changed 0 deltas-only 0 removed 1 added 1 recorded 0 - VIOLATION: major owed`));
    setEpoch(fmtMono, FIRST, realEntry("FOLD_EPOCH", FIRST) + 1);
    commit(fmtMono, "the major, raised");
    const green = guard(fmtMono);
    expect({ status: green.status, violated: violated(green.stdout) }).toEqual({ status: 0, violated: [] });
    // gaining an award is a re-record too (the stream's fold changed), and so is losing one
    atF3(fmtMono);
    editCorpus(fmtMono, FIRST, addAward());
    commit(fmtMono, "an award appears on stream 0");
    const gained = guard(fmtMono, "f3");
    expect(gained.status).toBe(1);
    expect(lineOf(gained.stdout, FIRST)).toMatch(new RegExp(`removed 1 added 1 recorded 0 - VIOLATION: major owed`));
    const lost = guard(fmtMono, "HEAD");
    expect({ status: lost.status, violated: violated(lost.stdout) }, "nothing changed against itself").toEqual({ status: 0, violated: [] });
    editCorpus(fmtMono, FIRST, (c) => { delete c.streams[0]!.foldOptions; });
    commit(fmtMono, "the award is dropped again");
    const dropped = guard(fmtMono);
    expect(dropped.status).toBe(1);
    expect(lineOf(dropped.stdout, FIRST)).toMatch(/removed 1 added 1 recorded 0 - VIOLATION: major owed/);
  });
});
