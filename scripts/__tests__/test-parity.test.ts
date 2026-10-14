// scripts/__tests__/test-parity.test.ts
// Single-sport reason: no sport is involved — this compares lists of test ids.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { diffIds, testIds, type LedgerEntry } from "../lib/test-parity.mjs";

type T = { path: string[]; status?: string };
const report = (root: string, files: Record<string, T[]>) => ({
  numTotalTests: Object.values(files).reduce((n, t) => n + t.length, 0),
  testResults: Object.entries(files).map(([name, tests]) => ({
    name: `${root}/${name}`,
    assertionResults: tests.map(({ path, status = "skipped" }) => ({ ancestorTitles: path.slice(0, -1), title: path.at(-1)!, status })),
  })),
});

describe("test-parity", () => {
  it("names a test by root-relative file, describe chain and title", () => {
    const r = report("/x/packages/engine", { "src/a.test.ts": [{ path: ["A", "b"] }] });
    expect(testIds(r, "/x/packages/engine")).toEqual(["src/a.test.ts › A › b"]);
  });

  it("keeps a test that is skipped in its own file (it.skip / skipIf), not only filter-skipped ones", () => {
    const r = report("/x", { "a.test.ts": [{ path: ["live"], status: "skipped" }, { path: ["todo"], status: "todo" }] });
    expect(testIds(r, "/x")).toEqual(["a.test.ts › live", "a.test.ts › todo"]);
  });

  it("reports nothing unaccounted when both sides hold the same ids under different roots", () => {
    const a = testIds(report("/mono/packages/engine", { "t.test.ts": [{ path: ["x"] }] }), "/mono/packages/engine");
    const b = testIds(report("/engine", { "t.test.ts": [{ path: ["x"] }] }), "/engine");
    expect(diffIds(a, b, { entries: [] }).unaccounted).toEqual([]);
  });

  it("flags an id that vanished without a ledger entry", () => {
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [] }).unaccounted).toEqual(["f › b"]);
  });

  it("accepts a rehome whose target exists after, and only that one", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed" as const, to: "g › b", reason: "reads apps/web" }] };
    expect(diffIds(["f › a", "f › b", "f › c"], ["f › a", "g › b"], ledger).unaccounted).toEqual(["f › c"]);
  });

  it("refuses a rehome whose target does not exist after (a deleted test passing as moved)", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed" as const, to: "g › b", reason: "x" }] };
    expect(diffIds(["f › b"], [], ledger).unaccounted).toEqual(["f › b", "LEDGER-TARGET-MISSING g › b"]);
  });

  it("flags an id that appeared from nowhere, and accepts it as `added`", () => {
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [] }).unaccounted).toEqual(["f › new"]);
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [{ id: "f › new", fate: "added", reason: "new guard" }] }).unaccounted).toEqual([]);
  });

  it("refuses an empty report rather than passing it", () => {
    expect(() => testIds({ numTotalTests: 0, testResults: [] }, "/x")).toThrow(/zero tests/);
  });
});

// The ledger is checked against BOTH sides: a before-only id may be accounted by an entry that names an
// after-only target, once per target. Anything weaker lets a deleted test pass as "moved" (review M-2).
describe("diffIds — what a ledger entry may account for", () => {
  const entry = (id: string, fate: LedgerEntry["fate"], to?: string, reason = "why"): LedgerEntry => ({ id, fate, to, reason });

  it.each(["moved", "rehomed", "rewritten"] as const)("`%s` accounts one before-only id and its after-only target, and the three sets are reported", (fate) => {
    const d = diffIds(["f › a", "f › b"], ["f › a", "g › b"], { entries: [entry("f › b", fate, "g › b")] });
    expect(d.unaccounted).toEqual([]);
    expect(d.onlyBefore).toEqual(["f › b"]);
    expect(d.onlyAfter).toEqual(["g › b"]);
    expect(d.both).toEqual(["f › a"]);
  });

  it("`split` fans one before-only id out to several after-only targets, one entry per target", () => {
    const ledger = { entries: [entry("f › b", "split", "g › b1"), entry("f › b", "split", "g › b2")] };
    expect(diffIds(["f › b"], ["g › b1", "g › b2"], ledger).unaccounted).toEqual([]);
    // Only one half ledgered: the other target is an unexplained new test.
    expect(diffIds(["f › b"], ["g › b1", "g › b2"], { entries: [entry("f › b", "split", "g › b1")] }).unaccounted).toEqual(["g › b2"]);
  });

  it("refuses a rehome whose id is still present after: a deleted test cannot hide behind a target that already existed", () => {
    // before has f › b AND g › b; after keeps only g › b. f › b was deleted; the entry claims it moved onto g › b.
    expect(diffIds(["f › b", "g › b"], ["g › b"], { entries: [entry("f › b", "rehomed", "g › b")] }).unaccounted).toEqual([
      "f › b",
      "LEDGER-INVALID f › b -> g › b",
    ]);
  });

  it("refuses an entry whose own id is not before-only (it is still there after, so nothing moved)", () => {
    expect(diffIds(["f › a"], ["f › a", "g › a"], { entries: [entry("f › a", "moved", "g › a")] }).unaccounted).toEqual([
      "g › a",
      "LEDGER-INVALID f › a -> g › a",
    ]);
  });

  it("refuses an entry whose id is in neither set", () => {
    expect(diffIds(["f › a"], ["f › a", "g › x"], { entries: [entry("f › ghost", "moved", "g › x")] }).unaccounted).toEqual([
      "g › x",
      "LEDGER-INVALID f › ghost -> g › x",
    ]);
  });

  it("lets one target be claimed by only one entry: the second id is still unaccounted", () => {
    const ledger = { entries: [entry("f › a", "moved", "g › t"), entry("f › b", "moved", "g › t")] };
    expect(diffIds(["f › a", "f › b"], ["g › t"], ledger).unaccounted).toEqual(["f › b", "LEDGER-INVALID f › b -> g › t"]);
  });

  it("names a missing target as such, and a rehome with no target at all", () => {
    expect(diffIds(["f › a"], [], { entries: [entry("f › a", "moved", "g › a")] }).unaccounted).toEqual(["f › a", "LEDGER-TARGET-MISSING g › a"]);
    expect(diffIds(["f › a"], [], { entries: [entry("f › a", "moved")] }).unaccounted).toEqual(["f › a", "LEDGER-TARGET-MISSING (none)"]);
  });

  it("`retired` accounts a before-only id when it carries a reason", () => {
    const d = diffIds(["f › a", "f › b"], ["f › a"], { entries: [entry("f › b", "retired", undefined, "obsolete since X")] });
    expect(d.unaccounted).toEqual([]);
    expect(d.onlyBefore).toEqual(["f › b"]);
  });

  it("refuses `retired` without a reason, and the id stays unaccounted", () => {
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [entry("f › b", "retired", undefined, "")] }).unaccounted).toEqual([
      "f › b",
      "LEDGER-UNUSED f › b",
    ]);
  });

  it("refuses `retired` for an id that is still present after", () => {
    expect(diffIds(["f › a"], ["f › a"], { entries: [entry("f › a", "retired", undefined, "obsolete")] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
  });

  it("refuses `added` for an id that was already there before, or that is nowhere", () => {
    expect(diffIds(["f › a"], ["f › a"], { entries: [entry("f › a", "added")] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
    expect(diffIds(["f › a"], ["f › a"], { entries: [entry("f › ghost", "added")] }).unaccounted).toEqual(["LEDGER-UNUSED f › ghost"]);
  });

  it("fails an entry for an id the ledger has already accounted: a second `added`/`retired`, or `added` on a move target", () => {
    const added = entry("f › new", "added");
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [added, added] }).unaccounted).toEqual(["LEDGER-UNUSED f › new"]);
    const retired = entry("f › b", "retired", undefined, "obsolete");
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [retired, retired] }).unaccounted).toEqual(["LEDGER-UNUSED f › b"]);
    // g › b is already accounted as the target of the move, so calling it `added` too accounts nothing.
    const moved = entry("f › b", "moved", "g › b");
    expect(diffIds(["f › b"], ["g › b"], { entries: [moved, entry("g › b", "added")] }).unaccounted).toEqual(["LEDGER-UNUSED g › b"]);
    // ... and in the other order the move's target is already claimed, so the move is the entry refused.
    expect(diffIds(["f › b"], ["g › b"], { entries: [entry("g › b", "added"), moved] }).unaccounted).toEqual(["f › b", "LEDGER-INVALID f › b -> g › b"]);
  });

  it("fails a stale ledger entry that accounts nothing, even alongside entries that do", () => {
    const ledger = { entries: [entry("f › b", "moved", "g › b"), entry("f › gone", "retired", undefined, "removed in an earlier PR")] };
    expect(diffIds(["f › a", "f › b"], ["f › a", "g › b"], ledger).unaccounted).toEqual(["LEDGER-UNUSED f › gone"]);
  });

  // A ledger that is not `{ entries: [{ id, fate, ... }] }` is a refusal, never an empty ledger: reading a typo'd
  // file as "no entries" would make the comparison stricter, but reading an unknown fate as "accounts nothing" hides
  // which entry is wrong. (Distinct from LEDGER-UNUSED, which is a well-formed entry that does not apply.)
  it.each([
    ["undefined", undefined, /ledger must be/],
    ["null", null, /ledger must be/],
    ["an array", [], /ledger must be/],
    ["an object with no `entries`", {}, /ledger must hold an "entries" array/],
    ["`entries` that is not an array", { entries: {} }, /ledger must hold an "entries" array/],
    ["`entries` under another key", { entry: [] }, /ledger must hold an "entries" array/],
    ["an entry that is not an object", { entries: ["f › a"] }, /ledger entry #0 .*not an object/],
    ["an entry with no id", { entries: [{ fate: "added", reason: "x" }] }, /ledger entry #0 .*no id/],
    ["an entry with an empty id", { entries: [{ id: "", fate: "added", reason: "x" }] }, /ledger entry #0 .*no id/],
    ["an entry with no fate", { entries: [{ id: "f › a", reason: "x" }] }, /ledger entry #0 .*unknown fate undefined/],
    ["an entry with an unknown fate", { entries: [entry("f › ok", "added"), { id: "f › a", fate: "bogus", reason: "x" }] }, /ledger entry #1 .*unknown fate "bogus"/],
  ])("refuses a malformed ledger: %s", (_name, ledger, message) => {
    expect(() => diffIds(["f › a"], ["f › a"], ledger as unknown as { entries: LedgerEntry[] })).toThrow(message);
  });

  it("accepts a well-formed ledger of every fate (the positive pair of the refusals above)", () => {
    const entries = [
      entry("f › b", "moved", "g › b"),
      entry("f › c", "rehomed", "g › c"),
      entry("f › d", "split", "g › d"),
      entry("f › e", "rewritten", "g › e"),
      entry("f › n", "added"),
      entry("f › r", "retired", undefined, "obsolete"),
    ];
    const before = ["f › a", "f › b", "f › c", "f › d", "f › e", "f › r"];
    const after = ["f › a", "g › b", "g › c", "g › d", "g › e", "f › n"];
    const d = diffIds(before, after, { entries });
    expect(d.unaccounted).toEqual([]);
    // Anti-vacuity: the entries were checked against five vanished ids and five new ones, not against nothing.
    expect(d.onlyBefore).toEqual(["f › b", "f › c", "f › d", "f › e", "f › r"]);
    expect(d.onlyAfter).toEqual(["g › b", "g › c", "g › d", "g › e", "f › n"]);
  });

});

// Ids are a MULTISET: a test file may hold two tests with the same title (scripts/__tests__/mutate.test.ts and
// the retirement-drift test beside it do), and that must neither block a run nor let a deleted twin hide (engine-split 1d-0).
describe("diffIds — duplicate ids are counted, not refused", () => {
  const entry = (id: string, fate: LedgerEntry["fate"], to?: string, reason = "why"): LedgerEntry => ({ id, fate, to, reason });
  const none = { entries: [] };

  it("a duplicate that exists identically before and after is `both`, copy for copy, and nothing is unaccounted", () => {
    const d = diffIds(["f › a", "f › a", "f › b"], ["f › a", "f › a", "f › b"], none);
    expect(d.unaccounted).toEqual([]);
    expect(d.both).toEqual(["f › a", "f › a", "f › b"]); // three, not two: the twin is counted
    expect(d.onlyBefore).toEqual([]);
    expect(d.onlyAfter).toEqual([]);
  });

  it("one of two copies removed is before-only 1 (the id itself, not a suffixed twin), and stays unaccounted without a ledger", () => {
    const d = diffIds(["f › a", "f › a"], ["f › a"], none);
    expect(d.onlyBefore).toEqual(["f › a"]);
    expect(d.onlyAfter).toEqual([]);
    expect(d.both).toEqual(["f › a"]);
    expect(d.unaccounted).toEqual(["f › a"]);
  });

  it("a duplicate added is after-only 1, and stays unaccounted without a ledger", () => {
    const d = diffIds(["f › a"], ["f › a", "f › a"], none);
    expect(d.onlyAfter).toEqual(["f › a"]);
    expect(d.onlyBefore).toEqual([]);
    expect(d.both).toEqual(["f › a"]);
    expect(d.unaccounted).toEqual(["f › a"]);
  });

  it("accounts exactly one copy per ledger entry: a surplus of two needs two `retired` entries, and a third accounts nothing", () => {
    const retired = entry("f › a", "retired", undefined, "obsolete");
    const before = ["f › a", "f › a", "f › a"];
    expect(diffIds(before, ["f › a"], { entries: [retired] }).unaccounted).toEqual(["f › a"]);
    expect(diffIds(before, ["f › a"], { entries: [retired, retired] }).unaccounted).toEqual([]);
    expect(diffIds(before, ["f › a"], { entries: [retired, retired, retired] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
  });

  it("accounts exactly one added copy per `added` entry", () => {
    const added = entry("f › a", "added");
    const after = ["f › a", "f › a", "f › a"];
    expect(diffIds(["f › a"], after, { entries: [added] }).unaccounted).toEqual(["f › a"]);
    expect(diffIds(["f › a"], after, { entries: [added, added] }).unaccounted).toEqual([]);
    expect(diffIds(["f › a"], after, { entries: [added, added, added] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
  });

  it("refuses `added`/`retired` for a duplicate whose count did not change (the id is `both`, nothing was added or retired)", () => {
    const same = ["f › a", "f › a"];
    expect(diffIds(same, same, { entries: [entry("f › a", "added")] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
    expect(diffIds(same, same, { entries: [entry("f › a", "retired", undefined, "obsolete")] }).unaccounted).toEqual(["LEDGER-UNUSED f › a"]);
  });

  it("a `moved` entry moves ONE copy of a duplicated id: the copy that stayed is `both`, the one that left is accounted", () => {
    const d = diffIds(["f › a", "f › a"], ["f › a", "g › a"], { entries: [entry("f › a", "moved", "g › a")] });
    expect(d.unaccounted).toEqual([]);
    expect(d.onlyBefore).toEqual(["f › a"]);
    expect(d.onlyAfter).toEqual(["g › a"]);
    expect(d.both).toEqual(["f › a"]);
  });

  it("both copies of a duplicate moving needs two entries; one entry leaves the other copy and its twin target unaccounted", () => {
    const moved = entry("f › a", "moved", "g › a");
    const before = ["f › a", "f › a"];
    const after = ["g › a", "g › a"];
    expect(diffIds(before, after, { entries: [moved, moved] }).unaccounted).toEqual([]);
    expect(diffIds(before, after, { entries: [moved] }).unaccounted).toEqual(["f › a", "g › a"]);
  });

  it("a target with a surplus of one cannot be claimed twice, even when its id also exists as an unchanged duplicate", () => {
    // g › a: one copy before, two after -> surplus 1. Two entries both claiming it: the second is refused.
    const ledger = { entries: [entry("f › a", "moved", "g › a"), entry("f › b", "moved", "g › a")] };
    expect(diffIds(["f › a", "f › b", "g › a"], ["g › a", "g › a"], ledger).unaccounted).toEqual(["f › b", "LEDGER-INVALID f › b -> g › a"]);
  });

  it("a `split` of a duplicated id still fans one copy out to several targets", () => {
    const ledger = { entries: [entry("f › a", "split", "g › a1"), entry("f › a", "split", "g › a2")] };
    expect(diffIds(["f › a", "f › a"], ["f › a", "g › a1", "g › a2"], ledger).unaccounted).toEqual([]);
  });
});

describe("testIds — a collection that did not collect is not a collection", () => {
  const healthy = { numFailedTestSuites: 0, numTotalTests: 1, testResults: [{ name: "/x/ok.test.ts", status: "passed", assertionResults: [{ ancestorTitles: ["A"], title: "t", status: "skipped" }] }] };

  it("returns the ids of a healthy report (the positive pair of the two refusals below)", () => {
    expect(testIds(healthy, "/x")).toEqual(["ok.test.ts › A › t"]);
  });

  it("throws, naming the file, when a file failed to collect even though other files listed tests", () => {
    const broken = { ...healthy, testResults: [...healthy.testResults, { name: "/x/broken.test.ts", status: "failed", assertionResults: [] }] };
    expect(() => testIds(broken, "/x")).toThrow(/broken\.test\.ts/);
  });

  it("throws, naming the file, when a file failed AFTER registering some of its tests (a partial collect lists only part)", () => {
    const partial = { ...healthy, testResults: [{ name: "/x/partial.test.ts", status: "failed", assertionResults: [{ ancestorTitles: ["A"], title: "t", status: "skipped" }] }] };
    expect(() => testIds(partial, "/x")).toThrow(/partial\.test\.ts/);
  });

  it("throws when the report counts a failed suite, whichever file it was", () => {
    expect(() => testIds({ ...healthy, numFailedTestSuites: 1 }, "/x")).toThrow(/failed/);
  });

  it("keeps both copies of a duplicate id within one report: the report is a multiset, not a set", () => {
    const dup = { testResults: [{ name: "/x/d.test.ts", assertionResults: [{ ancestorTitles: ["A"], title: "t" }, { ancestorTitles: ["A"], title: "t" }, { ancestorTitles: ["A"], title: "u" }] }] };
    expect(testIds(dup, "/x")).toEqual(["d.test.ts › A › t", "d.test.ts › A › t", "d.test.ts › A › u"]);
  });
});

// The CLI is the product: the library functions are exercised above, but exit codes, the `--ledger` plumbing, the
// argument grammar and the entry-script check are only real when the script is spawned.
describe("test-parity CLI (spawned)", () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "test-parity.mjs");
  // One spawn's cap, and the budget derived from it (AGENTS.md class 20): a flat test timeout beside a derived cost is a latent red.
  const SPAWN_MS = 25_000;
  const SLACK_MS = 5_000;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "test-parity-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ROOT = "/r";
  let n = 0;
  const write = (obj: unknown, sub = ""): string => {
    const d = join(dir, sub);
    mkdirSync(d, { recursive: true });
    const f = join(d, `f${n++}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const rep = (files: Record<string, T[]>) => write(report(ROOT, files));
  const run = (args: string[], script = SCRIPT) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  const two = { "a.test.ts": [{ path: ["A", "one"] }, { path: ["A", "two"] }] };
  const lessOne = { "a.test.ts": [{ path: ["A", "one"] }] };

  it("exit 0 and a non-vacuous count when nothing changed", () => {
    const f = rep(two);
    const r = run(["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/both ([1-9]\d*) · unaccounted 0/);
  }, SPAWN_MS + SLACK_MS);

  it("exit 1, naming the id, when a test vanished without a ledger entry", () => {
    const r = run(["--before", `${rep(two)}=${ROOT}`, "--after", `${rep(lessOne)}=${ROOT}`]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("UNACCOUNTED a.test.ts › A › two");
  }, SPAWN_MS + SLACK_MS);

  it("`--ledger` is read: the same difference exits 0 once a valid entry accounts it, 1 once the entry is invalid", () => {
    const before = rep(two);
    const after = rep({ "a.test.ts": [{ path: ["A", "one"] }], "b.test.ts": [{ path: ["A", "two"] }] });
    const ok = write({ entries: [{ id: "a.test.ts › A › two", fate: "rehomed", to: "b.test.ts › A › two", reason: "moved file" }] });
    const bad = write({ entries: [{ id: "a.test.ts › A › two", fate: "rehomed", to: "b.test.ts › A › nope", reason: "moved file" }] });
    const args = ["--before", `${before}=${ROOT}`, "--after", `${after}=${ROOT}`];
    const withOk = run([...args, "--ledger", ok]);
    expect(withOk.status, withOk.stdout + withOk.stderr).toBe(0);
    expect(withOk.stdout).toMatch(/both 1 /);
    expect(run(args).status).toBe(1);
    const withBad = run([...args, "--ledger", bad]);
    expect(withBad.status).toBe(1);
    expect(withBad.stdout).toContain("LEDGER-TARGET-MISSING b.test.ts › A › nope");
  }, SPAWN_MS + SLACK_MS);

  it("sums several `--before` reports into one side", () => {
    const x = rep({ "x.test.ts": [{ path: ["x"] }] });
    const y = rep({ "y.test.ts": [{ path: ["y"] }] });
    const r = run(["--before", `${x}=${ROOT}`, "--before", `${y}=${ROOT}`, "--after", `${y}=${ROOT}`, "--after", `${x}=${ROOT}`]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/both 2 /);
  }, SPAWN_MS + SLACK_MS);

  it("exit 2 on an empty report (zero tests is vacuous, not a pass)", () => {
    const empty = write({ numTotalTests: 0, testResults: [] });
    const r = run(["--before", `${empty}=${ROOT}`, "--after", `${rep(two)}=${ROOT}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/zero tests/);
  }, SPAWN_MS + SLACK_MS);

  it("exit 2 on a report with a file that failed to collect", () => {
    const broken = write({ numFailedTestSuites: 1, testResults: [...report(ROOT, two).testResults, { name: `${ROOT}/broken.test.ts`, status: "failed", assertionResults: [] }] });
    const r = run(["--before", `${broken}=${ROOT}`, "--after", `${rep(two)}=${ROOT}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/broken\.test\.ts/);
  }, SPAWN_MS + SLACK_MS);

  // A duplicate title INSIDE one test file is legitimate (it is a multiset), whereas the same id arriving from two reports of one
  // side is an operator error (a report listed twice, or two roots whose relative paths collide) and must still be refused.
  const dup = { "a.test.ts": [{ path: ["A", "one"] }, { path: ["A", "one"] }, { path: ["A", "two"] }] };
  const dupLess = { "a.test.ts": [{ path: ["A", "one"] }, { path: ["A", "two"] }] };

  it("exit 0, counting every copy, when a duplicate title exists identically before and after", () => {
    const f = rep(dup);
    const r = run(["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/before-only 0 · after-only 0 · both 3 · unaccounted 0/);
  }, SPAWN_MS + SLACK_MS);

  it("exit 1, naming the id, when one copy of a duplicate title vanished; `--ledger` retired accounts that one copy", () => {
    const args = ["--before", `${rep(dup)}=${ROOT}`, "--after", `${rep(dupLess)}=${ROOT}`];
    const bare = run(args);
    expect(bare.status, bare.stderr).toBe(1);
    expect(bare.stdout).toMatch(/before-only 1 · after-only 0 · both 2 · unaccounted 1/);
    expect(bare.stdout).toContain("UNACCOUNTED a.test.ts › A › one");
    const ledger = write({ entries: [{ id: "a.test.ts › A › one", fate: "retired", reason: "the twin was a copy-paste" }] });
    const accounted = run([...args, "--ledger", ledger]);
    expect(accounted.status, accounted.stdout + accounted.stderr).toBe(0);
  }, 2 * SPAWN_MS + SLACK_MS);

  it("exit 1 when a duplicate title was added", () => {
    const r = run(["--before", `${rep(dupLess)}=${ROOT}`, "--after", `${rep(dup)}=${ROOT}`]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/before-only 0 · after-only 1 · both 2 · unaccounted 1/);
  }, SPAWN_MS + SLACK_MS);

  it("exit 2 on a duplicate id across the reports of one side", () => {
    const f = rep(two);
    const r = run(["--before", `${f}=${ROOT}`, "--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/duplicate/);
  }, SPAWN_MS + SLACK_MS);

  it("exit 2 on a missing flag", () => {
    const r = run(["--before", `${rep(two)}=${ROOT}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing --after/);
  }, SPAWN_MS + SLACK_MS);

  it.each([
    ["a pair with no root (`<file>` alone)", (f: string) => ["--before", f, "--after", `${f}=${ROOT}`], /--before wants <report\.json>=<root>/],
    ["a pair with an empty root (`<file>=`)", (f: string) => ["--before", `${f}=`, "--after", `${f}=${ROOT}`], /--before wants <report\.json>=<root>/],
    ["a pair with an empty file (`=<root>`)", (f: string) => ["--before", `=${ROOT}`, "--after", `${f}=${ROOT}`], /--before wants <report\.json>=<root>/],
    ["a flag with no value at the end of the line", (f: string) => ["--after", `${f}=${ROOT}`, "--before"], /--before needs a value/],
    ["a flag whose value is the next flag", (f: string) => ["--before", "--after", `${f}=${ROOT}`], /--before needs a value/],
    ["`--ledger` with no value", (f: string) => ["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`, "--ledger"], /--ledger needs a value/],
  ])("exit 2 on %s, with a message that says what is wrong", (_name, args, message) => {
    const r = run(args(rep(two)));
    expect(r.status, r.stdout).toBe(2);
    expect(r.stderr).toMatch(message);
  }, SPAWN_MS + SLACK_MS);

  it.each([
    ["a file with no `entries` key", { entry: [] }, /ledger must hold an "entries" array/],
    ["`entries` that is not an array", { entries: {} }, /ledger must hold an "entries" array/],
    ["an entry with no id", { entries: [{ fate: "added", reason: "x" }] }, /ledger entry #0 .*no id/],
    ["an entry with an unknown fate", { entries: [{ id: "a.test.ts › A › one", fate: "bogus", reason: "x" }] }, /ledger entry #0 .*unknown fate "bogus"/],
  ])("exit 2 on a malformed `--ledger`: %s (never read as an empty ledger)", (_name, ledger, message) => {
    const f = rep(two);
    const r = run(["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`, "--ledger", write(ledger)]);
    expect(r.status, r.stdout).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe(""); // refused before comparing anything
  }, SPAWN_MS + SLACK_MS);

  it("splits `<file>=<root>` at the LAST `=`: a report path may contain one", () => {
    const f = write(report(ROOT, two), "has=equals");
    const r = run(["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/both 2 /);
  }, SPAWN_MS + SLACK_MS);

  it("runs when started through a symlink: the entry-script check must not fail open (a silent exit 0)", () => {
    const via = join(dir, "link-test-parity.mjs");
    symlinkSync(SCRIPT, via);
    const f = rep(two);
    const ok = run(["--before", `${f}=${ROOT}`, "--after", `${f}=${ROOT}`], via);
    expect(ok.stdout, `no output through a symlink: main never ran (stderr: ${ok.stderr})`).toMatch(/both 2 /);
    expect(ok.status, ok.stderr).toBe(0);
    // And it still refuses through the symlink: a silent 0 would also have passed a failing comparison.
    const bad = run(["--before", `${f}=${ROOT}`, "--after", `${rep(lessOne)}=${ROOT}`], via);
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stdout).toContain("UNACCOUNTED");
  }, SPAWN_MS + SLACK_MS);
});
