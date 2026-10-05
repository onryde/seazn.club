// W1d Task 1 (item 1, D10): plans.lock.json is append-only. committed-matrix.test.ts
// proves a committed run HAS a lock entry; nothing proved an existing entry was
// not edited alongside its results. The re-review found exactly that tamper path.
// Every claim about the CLI is checked by RUNNING it, in a throwaway git repo
// (its two exit-1 and exit-2 families) and against this tree (the real lock).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lockChanges } from "../lib/lock-diff.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

// Not process.cwd(): vitest is run from the repo root in CI and from tools/matrix
// by hand, and the CLI path must resolve from both.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOCK_PATH = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json";
const CLI = join(REPO, "tools/matrix/lock-append-only.ts");
const REAL = JSON.parse(readFileSync(join(REPO, LOCK_PATH), "utf8"));
const SCRIPTS = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const entry = (plan: string) => ({ plan, layered: false, driven: ["a|b|c|LIFECYCLE"], planned: {} });

describe("lockChanges (item 1, D10)", () => {
  it("the empty case: two empty locks compare zero entries, and the CLI refuses that as vacuous", () => {
    expect(lockChanges({ runs: {} }, { runs: {} })).toEqual({ compared: 0, added: [], changed: [] });
  });
  it("adding entries is allowed, and every base entry is compared", () => {
    const base = { runs: { a: entry("slice") } };
    const head = { runs: { a: entry("slice"), b: entry("--set w1-driving") } };
    expect(lockChanges(base, head)).toEqual({ compared: 1, added: ["b"], changed: [] });
  });
  it("an edited entry is named — one changed character in a driven id", () => {
    const head = { runs: { a: { ...entry("slice"), driven: ["a|b|c|M1"] } } };
    expect(lockChanges({ runs: { a: entry("slice") } }, head).changed).toEqual([{ run: "a", kind: "edited" }]);
  });
  it("a removed entry is named", () => {
    expect(lockChanges({ runs: { a: entry("slice") } }, { runs: {} }).changed).toEqual([{ run: "a", kind: "removed" }]);
  });
  it("a reordered key inside an entry is NOT an edit — the comparison is by value, keys sorted", () => {
    const e = entry("slice");
    const reordered = { planned: e.planned, driven: e.driven, layered: e.layered, plan: e.plan };
    expect(lockChanges({ runs: { a: e } }, { runs: { a: reordered } }).changed).toEqual([]);
  });
  it("keys are sorted at every depth, but an ARRAY's order is its value — a reordered driven list is an edit", () => {
    const deep = (planned: object, driven: string[]) => ({ runs: { a: { plan: "slice", layered: false, driven, planned } } });
    const base = deep({ x: { p: 1, q: 2 }, y: [1, 2] }, ["a", "b"]);
    expect(lockChanges(base, deep({ y: [1, 2], x: { q: 2, p: 1 } }, ["a", "b"])).changed).toEqual([]);
    expect(lockChanges(base, deep({ x: { p: 1, q: 2 }, y: [1, 2] }, ["b", "a"])).changed).toEqual([{ run: "a", kind: "edited" }]);
    expect(lockChanges(base, deep({ x: { p: 1, q: 3 }, y: [1, 2] }, ["a", "b"])).changed).toEqual([{ run: "a", kind: "edited" }]);
  });
  it("every change in one call is named, in the base's order, beside what was added and what held", () => {
    const base = { runs: { a: entry("slice"), b: entry("slice"), c: entry("slice"), d: entry("slice") } };
    const head = { runs: { a: entry("slice"), b: entry("--layer L1"), d: entry("slice"), e: entry("slice"), f: entry("slice") } };
    expect(lockChanges(base, head)).toEqual({
      compared: 4,
      added: ["e", "f"],
      changed: [{ run: "b", kind: "edited" }, { run: "c", kind: "removed" }],
    });
  });
  it("a run named like an Object.prototype member is judged as a run, not as a property lookup", () => {
    // `"constructor" in {}` is true: a lookup that walked the prototype would see this
    // removal as an edit, and this addition as already present.
    const base = { runs: { constructor: entry("slice"), toString: entry("slice") } };
    expect(lockChanges(base, { runs: {} }).changed).toEqual([{ run: "constructor", kind: "removed" }, { run: "toString", kind: "removed" }]);
    expect(lockChanges({ runs: { a: entry("slice") } }, { runs: { a: entry("slice"), constructor: entry("slice") } }).added).toEqual(["constructor"]);
  });
  it("the real committed lock against itself: every entry compared, none changed", () => {
    const r = lockChanges(REAL, REAL);
    expect(r.compared).toBe(Object.keys(REAL.runs).length);
    expect(r.compared).toBeGreaterThanOrEqual(135);
    expect(r.changed).toEqual([]);
  });
  it("the real lock, one driven id changed in one real entry: that run — and only that run — is named", () => {
    const runs = Object.keys(REAL.runs);
    expect(runs.length).toBeGreaterThanOrEqual(135);
    let swept = 0;
    for (const run of runs) {
      const tampered = structuredClone(REAL) as { runs: Record<string, { driven: string[] }> };
      tampered.runs[run]!.driven = [...tampered.runs[run]!.driven, "tampered|case|id|M1"];
      expect(lockChanges(REAL, tampered).changed, run).toEqual([{ run, kind: "edited" }]);
      swept++;
    }
    expect(swept).toBe(runs.length);
  });
});

describe("lock-append-only CLI", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** Run the CLI as a bare `node --experimental-strip-types` (no crash-exit preload): its own main is what is judged. */
  const cli = (args: string[], cwd: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd, encoding: "utf8", timeout: SPAWN_MS });
  /** A throwaway repo whose commits hold `lock.json` as each of `versions`, oldest first (the last is also the working tree). */
  const repo = (...versions: (object | string)[]) => {
    const d = mkdtempSync(join(tmpdir(), "lock-"));
    dirs.push(d);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    versions.forEach((v, i) => {
      writeFileSync(join(d, "lock.json"), typeof v === "string" ? v : JSON.stringify(v));
      git("add", ".");
      git("commit", "-q", "--allow-empty", "-m", `v${i}`); // identical versions are legitimate: a head that changes nothing
    });
    return d;
  };
  const check = (d: string, against = "HEAD^1", lock = "lock.json") => cli(["--against", against, "--lock", lock], d);

  it("exit 1 and names the run when the head edits a base entry", () => {
    const d = repo({ runs: { w1c: entry("slice") } }, { runs: { w1c: entry("--layer L1") } });
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("w1c: edited");
    expect(r.stdout).toBe("");
  }, spawnBudget(1));
  it("exit 1 names a removed entry, and every changed entry — each on its own line", () => {
    const d = repo({ runs: { w1c: entry("slice"), w1d: entry("slice"), w1e: entry("slice") } }, { runs: { w1c: entry("--layer L1"), w1e: entry("slice") } });
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("w1c: edited");
    expect(r.stderr).toContain("w1d: removed");
    expect(r.stderr).not.toContain("w1e");
    expect(r.stderr.trim().split("\n")).toHaveLength(2);
  }, spawnBudget(1));
  it("exit 0 with the count when the head only adds", () => {
    const d = repo({ runs: { w1c: entry("slice") } }, { runs: { w1c: entry("slice"), w1d: entry("slice") } });
    const r = check(d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 entries compared, 1 added");
    expect(r.stderr).toBe("");
  }, spawnBudget(1));
  it("the sequence: an entry the last commit ADDED is frozen for the next one — a second change cannot edit it", () => {
    const v0 = { runs: { w1c: entry("slice") } };
    const v1 = { runs: { w1c: entry("slice"), w1d: entry("slice") } };
    const v2 = { runs: { w1c: entry("slice"), w1d: entry("--layer L1") } };
    const d = repo(v0, v1, v2);
    // v2 against v1: w1d (added by v1) is now a base entry and was edited.
    const edit = check(d);
    expect(edit.status).toBe(1);
    expect(edit.stderr).toContain("w1d: edited");
    // The same v2 against v0 sees w1d as an ADDITION: the gate judges against the base it is given.
    const added = check(d, "HEAD~2");
    expect(added.status).toBe(0);
    expect(added.stdout).toContain("1 entries compared, 1 added");
  }, spawnBudget(2));
  it("exit 2 when the base holds zero entries (vacuous), and on an unknown ref", () => {
    const vacuous = check(repo({ runs: {} }, { runs: {} }));
    expect(vacuous.status).toBe(2);
    expect(vacuous.stderr).toContain("vacuous");
    const unknown = check(repo({ runs: { a: entry("s") } }, { runs: { a: entry("s") } }), "no-such-ref");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("cannot read the locks");
  }, spawnBudget(2));
  it("exit 2 (never 1, never 0) when either lock is not a lock: not JSON, JSON null, no runs object, runs null, or the head file missing", () => {
    const good = { runs: { a: entry("s") } };
    // [what, the repo, the refusal's own words] — the words pin WHICH guard refused: a TypeError that
    // a surrounding catch turned into an exit 2 would otherwise pass for the validation it replaced
    const cases: [string, string, string][] = [
      ["base is not JSON", repo("{ not json", good), "cannot read the locks — "],
      ["base is JSON null", repo("null", good), "is not a plans lock"],
      ["base has no runs object", repo({ note: "x" }, good), "is not a plans lock"],
      ["base runs is null", repo({ runs: null }, good), "is not a plans lock"],
      ["head is not JSON", repo(good, "{ not json"), "cannot read the locks — "],
      ["head is JSON null", repo(good, "null"), "is not a plans lock"],
      ["head has no runs object", repo(good, []), "is not a plans lock"],
      ["head runs is null", repo(good, { runs: null }), "is not a plans lock"],
    ];
    let checked = 0;
    for (const [what, d, words] of cases) {
      const r = check(d);
      expect(r.status, `${what}: ${r.stderr}`).toBe(2);
      expect(r.stdout, what).toBe("");
      expect(r.stderr, what).toContain(words);
      checked++;
    }
    expect(checked).toBe(cases.length);
    const missingHead = check(repo(good, good), "HEAD^1", "no-such-lock.json");
    expect(missingHead.status).toBe(2);
    expect(missingHead.stderr).toContain("cannot read the locks");
  }, spawnBudget(9));
  it("exit 2 on usage: no --against, an unknown flag, a positional", () => {
    const d = repo({ runs: { a: entry("s") } }, { runs: { a: entry("s") } });
    // each is refused by the usage guard itself (its own message), not by a later git failure that would also exit 2
    const noRef = cli(["--lock", "lock.json"], d);
    expect([noRef.status, noRef.stderr]).toEqual([2, "lock-append-only: --against <git-ref> is required\n"]);
    const flag = cli(["--against", "HEAD^1", "--bogus"], d);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain("--bogus");
    expect(flag.stderr).not.toContain("cannot read the locks");
    const positional = cli(["--against", "HEAD^1", "extra"], d);
    expect(positional.status).toBe(2);
    expect(positional.stderr).toContain("extra");
    expect(positional.stderr).not.toContain("cannot read the locks");
    // and the same repo with a well-formed argv is judged, not refused
    expect(cli(["--against", "HEAD^1", "--lock", "lock.json"], d).status).toBe(0);
  }, spawnBudget(4));
  it("a crash inside its own main, run as its package script (the crash-exit preload), exits 3 and says so — never 1 (ruling T1-b)", () => {
    // JSON.parse reads nested arrays iteratively; canonical() recurses, so this lock parses and then overflows the stack
    // inside lockChanges — outside every try block the CLI has. The same input is the contrast: without the preload node's
    // own uncaught-exception exit is 1, which a gate would read as a verdict.
    const deep = `{"runs":{"a":${"[".repeat(100_000)}${"]".repeat(100_000)}}}`;
    const d = repo(deep, deep);
    const words = (SCRIPTS["matrix:lock-check"] ?? "").split(" ");
    expect(words.slice(0, 4)).toEqual(["node", "--experimental-strip-types", "--import", "./scripts/lib/crash-exit.ts"]);
    expect(words).toHaveLength(5);
    expect(words[4]).toBe("tools/matrix/lock-append-only.ts");
    const abs = (w: string) => (w.startsWith("./") || w.startsWith("tools/") ? join(REPO, w) : w);
    const viaScript = spawnSync(process.execPath, [...words.slice(1).map(abs), "--against", "HEAD^1", "--lock", "lock.json"], { cwd: d, encoding: "utf8", timeout: SPAWN_MS });
    expect(viaScript.status, viaScript.stderr.slice(0, 400)).toBe(3);
    expect(viaScript.stderr).toMatch(/^lock-append-only\.ts: crashed — nothing caught RangeError/m);
    const bare = cli(["--against", "HEAD^1", "--lock", "lock.json"], d);
    expect(bare.status).toBe(1);
    expect(bare.stderr).not.toContain("crashed");
  }, spawnBudget(2));
  it("the real lock, run the way CI runs it (no --lock): every entry the base commit holds is compared, and exit is 0", () => {
    const baseText = execFileSync("git", ["show", `HEAD:${LOCK_PATH}`], { cwd: REPO, encoding: "utf8" });
    const baseCount = Object.keys(JSON.parse(baseText).runs).length;
    expect(baseCount).toBeGreaterThanOrEqual(135);
    const r = cli(["--against", "HEAD"], REPO);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^lock-append-only: ${baseCount} entries compared, \\d+ added$`, "m"));
  }, spawnBudget(1));
});
