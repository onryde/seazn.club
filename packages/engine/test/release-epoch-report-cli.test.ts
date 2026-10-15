// A release's engine-epoch report (scripts/release-epoch-report.ts): the CLI, SPAWNED against real git history. The rule is
// release-epoch-report.test.ts; what only a real repository shows is here: that `--from`/`--to` read the table AT each ref (a tag, HEAD) and
// not the working tree, that a ref without the file, a ref git cannot read, a table that does not parse, a shallow clone and a git that is
// not there each end in one line and exit 0 (a report must never fail a deploy), that `--annotate` and `--summary` write what GitHub reads,
// and that a flag mistake is exit 2 and a crash exit 3.
//
// The scratch repositories hold the REAL script and its helper, copied from this tree, and a SYNTHETIC src/sport/fold-epoch.ts per release
// (every epoch 1, edited the way a rule change edits it): the live table's epochs move with every bump, and a fixture copied from them would
// compare equal tables, or throw, from the first real one. The sports are the golden corpora on disk, which the epoch guard holds equal to the
// table's keys, and the expected sport count is that, never the report's own output. Nothing here imports src/ (the spawned script reads files
// and git only), so a Stryker related-mode run of a sport file does not run these spawns.
//
// Single-sport reason: the registry sweep is release-epoch-report.test.ts; this file proves wiring (refs, git, flags, exit codes), for which
// football, badminton and tennis stand in for "a sport".
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/release-epoch-report.ts";
const TABLE = "src/sport/fold-epoch.ts";
/** The files a scratch checkout always holds: the real script and the helper it imports, and the real package.json (type: module). */
const FILES = [SCRIPT, "scripts/lib/main-module.ts", "package.json"];
const KEYS = (readdirSync(join(ENGINE, "src/sports"), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).map((f) => basename(f, ".golden.json")).sort();

/** The line the owner approved for a raised epoch (2026-10-15). */
const raisedLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_EPOCH ${a} -> ${b} — capture apps older than this engine will be refused for ${sport} (426 ENGINE_OUTDATED)`;
const tally = (n: number, from: string, to: string, c: { raised?: number; lowered?: number; minor?: number; added?: number; removed?: number } = {}): string =>
  `${n} sport(s) compared between ${from} and ${to}: ${c.raised ?? 0} FOLD_EPOCH raised, ${c.lowered ?? 0} lowered, ${c.minor ?? 0} FOLD_MINOR changed, ${c.added ?? 0} added, ${c.removed ?? 0} removed`;

// ------------------------------------------------------------------------------------------------------------- the tables of the tags

/** A table source shaped the way src/sport/fold-epoch.ts writes its own (frozen, `as const satisfies`) over the registry's sports (KEYS: the golden
 *  corpora on disk), every epoch 1 unless `over` says, `drop` removed and `add` appended. SYNTHETIC on purpose: a fixture copied from the live
 *  table would hold whatever its epochs are today, and the first real epoch bump would make every scenario below compare equal tables or throw.
 *  The real table's own source is read by release-epoch-report.test.ts. */
function tableSource(over: Record<string, number> = {}, drop: string[] = [], add: Record<string, number> = {}): string {
  for (const k of [...Object.keys(over), ...drop]) if (!KEYS.includes(k)) throw new Error(`${k} is not a sport (the corpora on disk name ${KEYS.join(", ")})`);
  const epochs = { ...Object.fromEntries(KEYS.filter((k) => !drop.includes(k)).map((k) => [k, 1])), ...over, ...add };
  return `export const FOLD_EPOCH = Object.freeze({ ${Object.entries(epochs).map(([k, n]) => `${k}: ${n}`).join(", ")} } as const satisfies Readonly<Record<string, number>>);\n`;
}
const minorSource = (minors: Record<string, number>): string =>
  `export const FOLD_MINOR = Object.freeze({ ${KEYS.map((k) => `${k}: ${minors[k] ?? 0}`).join(", ")} } as const satisfies Readonly<Record<string, number>>);\n`;
const BASE_TABLE = tableSource();

interface Release { tag: string; table: string | null }
/** One tagged commit each, in order. Every tag differs from the one before it in exactly the way its name says. */
const RELEASES: Release[] = [
  { tag: "v0.9.0", table: null }, //                                                                  no src/sport/fold-epoch.ts yet
  { tag: "v1.0.0", table: BASE_TABLE }, //                                                            every epoch 1
  { tag: "v1.0.1", table: tableSource({ football: 2 }) }, //                                          football raised
  { tag: "v1.0.2", table: tableSource({ football: 2, badminton: 3, tennis: 2 }) }, //                 badminton and tennis raised on top of v1.0.1
  { tag: "v1.0.3", table: tableSource({ football: 2 }) + minorSource({}) }, //                         v1.0.1's epochs, and FOLD_MINOR introduced with every minor 0
  { tag: "v1.0.4", table: tableSource({ football: 2 }) + minorSource({ football: 1 }) }, //           football's minor 0 -> 1
  { tag: "v1.0.5", table: tableSource({ football: 2 }, ["carrom"], { curling: 1 }) }, //              v1.0.1's epochs, carrom gone, curling new
  { tag: "v1.0.6", table: "export const FOLD_EPOCH = {{{\n" }, //                                    does not load
  { tag: "v1.0.6-injection", table: 'export const FOLD_EPOCH = { "football\\n::error::pwned": 1, tennis: 1 };\n' }, // a sport key with a newline and a workflow command in it
  { tag: "v1.0.7", table: null }, //                                                                   the table deleted
  { tag: "v1.0.8", table: BASE_TABLE }, //                                                             every epoch 1 again (HEAD of the scratch repository)
];

// ------------------------------------------------------------------------------------------------------------------ the scratch repos

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k]; // a hook's GIT_DIR must not point git at the parent repository
  return env;
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=epoch@example.invalid", "-c", "user.name=Epoch", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8", env: cleanEnv(), timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const NO_AUTO_PACK: ReadonlyArray<readonly [string, string]> = [["gc.auto", "0"], ["maintenance.auto", "false"], ["core.autocrlf", "false"]];
interface Repo { top: string; eng: string }
let scratch = "";
let mono: Repo; //   the engine at packages/engine, as in the monorepo
let rooted: Repo; // the engine at the repository root, as in its own repo

function makeRepo(name: string, prefix: string): Repo {
  const top = join(scratch, name);
  const eng = join(top, prefix);
  mkdirSync(eng, { recursive: true });
  for (const f of FILES) {
    mkdirSync(dirname(join(eng, f)), { recursive: true });
    cpSync(join(ENGINE, f), join(eng, f));
  }
  git(top, "init", "-q", "-b", "main");
  // scratch repositories never pack their objects: how many loose objects make git pack on its own depends on its version and timing
  for (const [key, value] of NO_AUTO_PACK) git(top, "config", key, value);
  for (const { tag, table } of RELEASES) {
    const file = join(eng, TABLE);
    rmSync(file, { force: true });
    if (table !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, table);
    }
    git(top, "add", "-A");
    git(top, "commit", "-q", "--allow-empty", "-m", tag);
    git(top, "tag", tag);
  }
  return { top, eng };
}

/** Runs the reporter copied into `engineDir` (or through another path to it, `via`) the way prod.yml does: node, strip-types, a cwd of its own. */
function run(engineDir: string, args: string[], extra: { cwd?: string; env?: NodeJS.ProcessEnv; via?: string } = {}) {
  const script = join(extra.via ?? engineDir, SCRIPT);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: extra.cwd ?? engineDir, encoding: "utf8", timeout: SPAWN_MS, env: { ...cleanEnv(), ...extra.env } });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split("\n").filter((l) => l !== "") };
}
const report = (repo: Repo, from: string, to: string, ...more: string[]) => run(repo.eng, ["--from", from, "--to", to, ...more]);
const warnings = (lines: string[]): string[] => lines.filter((l) => l.startsWith("::warning::"));

const BUILD_MS = 60_000 + RELEASES.length * 4_000;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "release-epoch-report-"));
  mono = makeRepo("mono", "packages/engine");
  rooted = makeRepo("rooted", "");
}, BUILD_MS);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A test that spawns about `n` processes (CLI runs and git commands). */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

describe("release-epoch-report CLI: the scratch repositories are the real tree's", () => {
  it("hold the real script byte for byte and a synthetic table of every sport, and one tag per release, counted (a rig with none would pass every red test below for the wrong reason)", () => {
    expect(KEYS.length).toBeGreaterThan(1);
    expect(new Set(KEYS).size).toBe(KEYS.length);
    for (const repo of [mono, rooted]) {
      expect(git(repo.top, "tag", "--list").split("\n").sort()).toEqual(RELEASES.map((r) => r.tag).sort());
      expect(git(repo.top, "show", `v1.0.0:${repo.eng === repo.top ? "" : "packages/engine/"}${TABLE}`)).toBe(BASE_TABLE.trimEnd());
      expect(readFileSync(join(repo.eng, SCRIPT), "utf8"), `${repo.eng}: the script under test is the real one`).toBe(readFileSync(join(ENGINE, SCRIPT), "utf8"));
    }
    expect(BASE_TABLE.match(/\b[a-z]+: 1\b/g)).toHaveLength(KEYS.length); // one epoch per sport, every one 1
    // every release but the first differs from the one before it
    for (let i = 1; i < RELEASES.length; i++) expect(RELEASES[i]!.table, RELEASES[i]!.tag).not.toBe(RELEASES[i - 1]!.table);
    expect(RELEASES.filter((r) => r.table === null).length).toBeGreaterThanOrEqual(2);
  });
});

describe("release-epoch-report CLI: a release that raises an epoch", () => {
  spawnIt(2)("names the sport whose epoch rose between two TAGS, from the table each tag held, and prints no workflow command unless asked", () => {
    const r = report(mono, "v1.0.0", "v1.0.1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })]);
    expect(warnings(r.lines)).toEqual([]);
    expect(r.stderr).toBe("");
  });

  spawnIt(2)("prints one ::warning:: per raised sport with --annotate, after the report", () => {
    const r = report(mono, "v1.0.0", "v1.0.1", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 }), `::warning::${raisedLine("football", 1, 2)}`]);
  });

  spawnIt(2)("names every sport that rose, and only those, when several did", () => {
    const r = report(mono, "v1.0.1", "v1.0.2", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([
      raisedLine("badminton", 1, 3),
      raisedLine("tennis", 1, 2),
      tally(KEYS.length, "v1.0.1", "v1.0.2", { raised: 2 }),
      `::warning::${raisedLine("badminton", 1, 3)}`,
      `::warning::${raisedLine("tennis", 1, 2)}`,
    ]);
  });

  spawnIt(3)("reads each table AT its ref and never the working tree: an uncommitted edit of the table changes nothing", () => {
    const file = join(mono.eng, TABLE);
    writeFileSync(file, tableSource({ football: 9 }));
    try {
      const r = report(mono, "v1.0.0", "v1.0.1");
      expect(r.lines).toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })]);
      // HEAD is the last commit, v1.0.8 (every epoch 1), not the football 9 in the working tree
      expect(report(mono, "v1.0.0", "HEAD").lines).toEqual([tally(KEYS.length, "v1.0.0", "HEAD")]);
    } finally {
      git(mono.top, "checkout", "-q", "--", ".");
    }
    expect(readFileSync(file, "utf8")).toBe(BASE_TABLE);
  });

  spawnIt(2)("a tag and HEAD are refs like any other: v1.0.1 -> HEAD is football 2 -> 1, which is LOWERED, not raised, and warned about", () => {
    const r = report(mono, "v1.0.1", "HEAD", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    const line = "football: FOLD_EPOCH 2 -> 1 — LOWERED; an epoch only rises (fold-epoch:check refuses this)";
    expect(r.lines).toEqual([line, tally(KEYS.length, "v1.0.1", "HEAD", { lowered: 1 }), `::warning::${line}`]);
  });

  spawnIt(2)("an unchanged table reports the number of sports compared (the registry's, from the corpora on disk) and no warning", () => {
    const same = report(mono, "v1.0.1", "v1.0.1", "--annotate");
    expect(same.status, same.stderr).toBe(0);
    expect(same.lines).toEqual([tally(KEYS.length, "v1.0.1", "v1.0.1")]);
    // two different commits with the same table
    const apart = report(mono, "v1.0.0", "v1.0.8", "--annotate");
    expect(apart.lines).toEqual([tally(KEYS.length, "v1.0.0", "v1.0.8")]);
  });

  spawnIt(4)("works with the engine at the repository root as well as at packages/engine, and from any working directory", () => {
    for (const repo of [mono, rooted]) {
      const r = report(repo, "v1.0.0", "v1.0.1");
      expect(r.lines, repo.eng).toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })]);
      const base = report(repo, "v0.9.0", "v1.0.0");
      expect(base.lines, repo.eng).toEqual(["no FOLD_EPOCH at v0.9.0; nothing to compare"]);
    }
    const elsewhere = run(mono.eng, ["--from", "v1.0.0", "--to", "v1.0.1"], { cwd: tmpdir() });
    expect(elsewhere.status, elsewhere.stderr).toBe(0);
    expect(elsewhere.lines[0]).toBe(raisedLine("football", 1, 2));
  });
});

describe("release-epoch-report CLI: sports added, removed, and FOLD_MINOR", () => {
  spawnIt(2)("lists a sport added and one removed between two tags, without a warning for either", () => {
    const r = report(mono, "v1.0.1", "v1.0.5", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([
      "curling: sport added (FOLD_EPOCH 1)",
      "carrom: sport removed (was FOLD_EPOCH 1)",
      tally(KEYS.length - 1, "v1.0.1", "v1.0.5", { added: 1, removed: 1 }),
    ]);
    expect(warnings(r.lines)).toEqual([]);
  });

  spawnIt(3)("FOLD_MINOR introduced with every minor 0 changes nothing; a minor that rose is information, with no ::warning::", () => {
    const introduced = report(mono, "v1.0.1", "v1.0.3", "--annotate");
    expect(introduced.lines).toEqual([tally(KEYS.length, "v1.0.1", "v1.0.3")]);
    const rose = report(mono, "v1.0.3", "v1.0.4", "--annotate");
    expect(rose.status, rose.stderr).toBe(0);
    expect(rose.lines).toEqual([
      "football: FOLD_MINOR 0 -> 1 — no app update needed (older capture apps are not refused for a minor change)",
      tally(KEYS.length, "v1.0.3", "v1.0.4", { minor: 1 }),
    ]);
    expect(warnings(rose.lines)).toEqual([]);
  });
});

describe("release-epoch-report CLI: a comparison that cannot be made is one line and exit 0", () => {
  spawnIt(3)("a baseline without the table (a tag from before fold-epoch.ts) is the one approved line, and no warning even with --annotate", () => {
    const r = report(mono, "v0.9.0", "v1.0.1", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("no FOLD_EPOCH at v0.9.0; nothing to compare\n");
    expect(r.stderr).toBe("");
  });

  spawnIt(2)("a target without the table is a warning", () => {
    const r = report(mono, "v1.0.0", "v1.0.7", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(["no FOLD_EPOCH at v1.0.7; nothing to compare", "::warning::no FOLD_EPOCH at v1.0.7; nothing to compare"]);
  });

  spawnIt(3)("a table that does not parse, on either side, is a warning naming the tag, and the exit is still 0", () => {
    for (const [from, to, bad] of [["v1.0.5", "v1.0.6", "v1.0.6"], ["v1.0.6", "v1.0.8", "v1.0.6"]] as const) {
      const r = report(mono, from, to, "--annotate");
      expect(r.status, r.stderr).toBe(0);
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]).toMatch(new RegExp(`^FOLD_EPOCH at ${bad} could not be parsed \\(does not load: .+\\); nothing to compare$`));
      expect(r.lines[1]).toBe(`::warning::${r.lines[0]}`);
    }
  });

  spawnIt(3)("a table whose sport key carries a newline and a workflow command is unparseable, and no line of the output can start one", () => {
    for (const [from, to] of [["v1.0.0", "v1.0.6-injection"], ["v1.0.6-injection", "v1.0.0"]] as const) {
      const r = report(mono, from, to, "--annotate");
      expect(r.status, r.stderr).toBe(0);
      const at = from === "v1.0.0" ? to : from;
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]).toBe(`FOLD_EPOCH at ${at} could not be parsed (FOLD_EPOCH has the sport key "football\\n::error::pwned", and a sport key is lower-case letters, digits, "_" or "-"); nothing to compare`);
      expect(r.lines[1]).toBe(`::warning::${r.lines[0]}`);
      // the one thing GitHub would act on: a command that is not ours, from the start of a line
      expect(r.stdout.split("\n").filter((l) => /^::(?!warning::)/.test(l))).toEqual([]);
    }
  });

  spawnIt(2)("a ref that is not a commit is a warning naming it", () => {
    const r = report(mono, "v9.9.9", "v1.0.1", "--annotate");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0]).toBe('could not read FOLD_EPOCH at v9.9.9: "v9.9.9" is not a commit in this repository; nothing to compare');
    expect(r.lines[1]).toBe(`::warning::${r.lines[0]}`);
    const target = report(mono, "v1.0.0", "v9.9.9");
    expect(target.lines[0]).toContain("could not read FOLD_EPOCH at v9.9.9");
  });

  spawnIt(4)("a shallow clone that lacks the baseline's history says so, and still exits 0", () => {
    const clone = join(scratch, "shallow");
    git(scratch, "clone", "-q", "--depth", "1", `file://${mono.top}`, clone);
    const eng = join(clone, "packages/engine");
    const r = report({ top: clone, eng }, "v1.0.0", "HEAD");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0]).toBe('could not read FOLD_EPOCH at v1.0.0: "v1.0.0" is not a commit in this repository (this is a shallow clone: fetch the history, e.g. git fetch --unshallow --tags); nothing to compare');
    // HEAD itself is readable in the clone: the shallow note is only for a ref that is missing
    const head = report({ top: clone, eng }, "HEAD", "HEAD");
    expect(head.lines).toEqual([tally(KEYS.length, "HEAD", "HEAD")]);
  });

  spawnIt(8)("a table whose blob or tree git cannot read is unreadable, naming the git command that failed, and is never taken for 'no table'", () => {
    // a clone holding one more release whose table is unique to it, so its blob and its src/sport tree are loose objects nothing else shares
    const clone = join(scratch, "damaged");
    git(scratch, "clone", "-q", `file://${mono.top}`, clone);
    for (const [key, value] of NO_AUTO_PACK) git(clone, "config", key, value);
    writeFileSync(join(clone, "packages/engine", TABLE), tableSource({ football: 5 }));
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "v2.0.0");
    git(clone, "tag", "v2.0.0");
    const loose = (sha: string): string => {
      const file = join(clone, ".git", "objects", sha.slice(0, 2), sha.slice(2));
      if (!existsSync(file)) throw new Error(`object ${sha} is not loose in ${clone}: git packed it, so the rig cannot damage it`);
      return file;
    };
    const remove = (file: string): void => { chmodSync(dirname(file), 0o755); chmodSync(file, 0o644); rmSync(file); };
    const eng = join(clone, "packages/engine");
    const read = () => report({ top: clone, eng }, "v1.0.0", "v2.0.0", "--annotate");

    const intact = read();
    expect(intact.lines[0], "the control: undamaged, the rise is reported").toBe(raisedLine("football", 1, 5));

    remove(loose(git(clone, "rev-parse", "v2.0.0:packages/engine/src/sport/fold-epoch.ts")));
    const noBlob = read();
    expect(noBlob.status, noBlob.stderr).toBe(0);
    expect(noBlob.lines[0]).toMatch(/^could not read FOLD_EPOCH at v2\.0\.0: git cat-file v2\.0\.0:src\/sport\/fold-epoch\.ts failed: .+; nothing to compare$/);
    expect(noBlob.lines[0]).toContain("git cat-file v2.0.0:src/sport/fold-epoch.ts failed");
    expect(noBlob.lines[1]).toBe(`::warning::${noBlob.lines[0]}`);

    remove(loose(git(clone, "rev-parse", "v2.0.0:packages/engine/src/sport")));
    const noTree = read();
    expect(noTree.status, noTree.stderr).toBe(0);
    expect(noTree.lines[0]).toMatch(/^could not read FOLD_EPOCH at v2\.0\.0: git ls-tree v2\.0\.0 failed: .+; nothing to compare$/);
    expect(noTree.lines[1]).toBe(`::warning::${noTree.lines[0]}`);
  });

  spawnIt(1)("git missing from PATH is a warning that git could not run, and still exit 0", () => {
    const r = run(mono.eng, ["--from", "v1.0.0", "--to", "v1.0.1", "--annotate"], { env: { PATH: join(scratch, "no-such-bin") } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0]).toMatch(/^could not read FOLD_EPOCH at v1\.0\.0: could not run git rev-parse: .*ENOENT.*; nothing to compare$/);
    expect(r.lines[1]).toBe(`::warning::${r.lines[0]}`);
  });
});

describe("release-epoch-report CLI: the step summary", () => {
  spawnIt(3)("appends a Markdown section to the file, and a second run adds a second section instead of replacing the first", () => {
    const file = join(scratch, "summary.md");
    writeFileSync(file, "# existing\n");
    const first = report(mono, "v1.0.0", "v1.0.1", "--summary", file);
    expect(first.status, first.stderr).toBe(0);
    expect(first.lines, "the summary is in addition to stdout, not instead of it").toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })]);
    const second = report(mono, "v0.9.0", "v1.0.0", "--summary", file);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      `# existing\n### Engine fold epoch: v1.0.0 -> v1.0.1\n\n- ${raisedLine("football", 1, 2)}\n- ${tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })}\n` +
        `### Engine fold epoch: v0.9.0 -> v1.0.0\n\n- no FOLD_EPOCH at v0.9.0; nothing to compare\n`,
    );
  });

  spawnIt(1)("a summary file that cannot be written is said so on stderr and does not change the exit code or stdout", () => {
    const r = report(mono, "v1.0.0", "v1.0.1", "--summary", join(scratch, "no-such-dir", "summary.md"));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^release-epoch: could not write the summary file .*no-such-dir.*summary\.md: /);
    expect(r.lines[0]).toBe(raisedLine("football", 1, 2));
  });
});

describe("release-epoch-report CLI: invocation", () => {
  spawnIt(2)("runs when started through a symlink to the engine (a main-module guard that compared paths as typed would print nothing and exit 0)", () => {
    const link = join(scratch, "engine-link");
    symlinkSync(mono.eng, link);
    const r = run(mono.eng, ["--from", "v1.0.0", "--to", "v1.0.1"], { via: link });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([raisedLine("football", 1, 2), tally(KEYS.length, "v1.0.0", "v1.0.1", { raised: 1 })]);
  });

  spawnIt(8)("a flag mistake is exit 2 with the usage on stderr and nothing on stdout", () => {
    const cases: string[][] = [[], ["--from", "v1.0.0"], ["--to", "v1.0.1"], ["--from", "v1.0.0", "--to", "v1.0.1", "--bogus"], ["--from", "v1.0.0", "--to", "v1.0.1", "extra"], ["--from=-x", "--to", "v1.0.1"], ["--from", "v1.0.0", "--to="], ["--from", "v1.0.0", "--to", "v1.0.1", "--summary="]];
    for (const args of cases) {
      const r = run(mono.eng, args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toContain("usage: release-epoch-report.ts --from <ref> --to <ref> [--annotate] [--summary <file>]");
    }
    expect(cases).toHaveLength(8);
  });

  spawnIt(1)("a crash of the reporter itself (here: no writable temp directory to evaluate a table in) is exit 3 and says so", () => {
    const r = report(mono, "v1.0.0", "v1.0.1");
    expect(r.status).toBe(0); // the control: the same command is fine with a temp directory
    const broken = run(mono.eng, ["--from", "v1.0.0", "--to", "v1.0.1"], { env: { TMPDIR: join(scratch, "no-such-tmp") } });
    expect(broken.status, broken.stderr).toBe(3);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toContain("release-epoch: the reporter itself crashed (this is not a verdict)");
  });
});
