// W1d Task 15 (D14; rulings 66, 67): scripts/stryker-matrix.mjs derives mutation.yml's job matrix, one entry per Stryker
// group with its job timeout. It is SPAWNED here per event (the workflow runs it as a plain `node` step, so what is proven
// is the process's stdout and exit code, not a function a test imported), and again from a copy in a scratch tree whose
// timeouts file is broken, to reach the refusals the real file never triggers.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { filesOf, globMatches } from "../scripts/stryker-files.mjs";
import { STRYKER_GROUPS, STRYKER_SPLITS } from "../stryker.groups.mjs";
import { selected } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ENGINE, "..", "..");
const NON_PROBE = Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe");
const TIMEOUTS = JSON.parse(readFileSync(join(ENGINE, "stryker-timeouts.json"), "utf8")) as Record<string, number>;

interface Out { status: number | null; stdout: string; stderr: string }
function matrixCli(script: string, cwd: string, event: string | null, group: string | null): Out {
  const args = [script, ...(event === null ? [] : ["--event", event]), ...(group === null ? [] : ["--group", group])];
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: SPAWN_MS });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
// As the workflow runs it: from the repository root, by its path.
const REAL = join(ENGINE, "scripts/stryker-matrix.mjs");
const real = (event: string | null, group: string | null) => matrixCli(REAL, REPO, event, group);

/** The matrix a successful run printed: one `matrix=` line of JSON and nothing else (the line is appended to $GITHUB_OUTPUT). */
function parsed(o: Out): { group: string; timeout: number; cut: string }[] {
  expect(o.status, o.stderr).toBe(0);
  expect(o.stderr).toBe("");
  const lines = o.stdout.split("\n").filter((l) => l !== "");
  expect(lines, "exactly one output line").toHaveLength(1);
  expect(lines[0]).toMatch(/^matrix=\{"include":\[/);
  const m = JSON.parse(lines[0]!.slice("matrix=".length)) as { include: { group: string; timeout: number; cut: string }[] };
  expect(Object.keys(m)).toEqual(["include"]);
  for (const e of m.include) expect(Object.keys(e).sort(), "an entry is exactly {group, timeout, cut}").toEqual(["cut", "group", "timeout"]);
  return m.include;
}
const groupsOf = (o: Out) => parsed(o).map((e) => e.group);
/** An entry without its fingerprint (the tests of the timeout compare group and timeout; the fingerprint has its own tests). */
const slim = (es: { group: string; timeout: number }[]) => es.map(({ group, timeout }) => ({ group, timeout }));

/** Every file the real groups select, as an EMPTY file under `root`: the plan needs which files exist, never what they hold. (Never a
 *  link to the real tree: a test that wrote through it would write the real source.) */
function emptyCopiesOfRealFiles(root: string): void {
  const all = new Set(Object.values(STRYKER_GROUPS).flatMap((entries) => filesOf(entries, ENGINE)));
  if (all.size < 50) throw new Error(`the real groups select ${all.size} files: the fixture would be vacuous`);
  for (const f of all) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "");
  }
}

/** A test that spawns `n` processes. */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

describe("stryker-matrix.mjs derives one matrix per event (D14)", () => {
  spawnIt(3)("a pull_request runs the probe only, whatever group the (absent) input says", () => {
    expect(groupsOf(real("pull_request", ""))).toEqual(["probe"]);
    expect(groupsOf(real("pull_request", null))).toEqual(["probe"]);
    expect(groupsOf(real("pull_request", "competition-1"))).toEqual(["probe"]); // a PR has no group input; a stray value does not widen it
  });

  spawnIt(3)("a schedule and a dispatch of `all` give every group but the probe, in declaration order, and there is more than one", () => {
    for (const [event, group] of [["schedule", ""], ["schedule", null], ["workflow_dispatch", "all"]] as const) {
      const got = groupsOf(real(event, group));
      expect(got, `${event} ${String(group)}`).toEqual(NON_PROBE);
      expect(got.length).toBeGreaterThan(1);
      expect(got).not.toContain("probe");
    }
  });

  spawnIt(2)("the legs and the probe fit GitHub's 256-job matrix limit, and so does every matrix a run prints (T20-FIX1, M6)", () => {
    // 79 legs and the probe are 80 jobs (T20 step 2 cut seven legs into 17 parts), 3.2x under the limit; a matrix over it is refused by GitHub when the plan job hands it
    // over, after the dispatch was chosen and the guard and the plan jobs ran. The limit is GitHub's, typed here from its docs.
    const GITHUB_MATRIX_LIMIT = 256;
    const keys = Object.keys(STRYKER_GROUPS);
    const limit = `GitHub's limit of ${GITHUB_MATRIX_LIMIT} jobs per matrix: cut the legs into two workflows, or one leg at a time`;
    expect(keys.length, `${keys.length} jobs (the legs and the probe) exceed ${limit}`).toBeLessThanOrEqual(GITHUB_MATRIX_LIMIT);
    expect(keys.length, "the legs and the probe were counted").toBeGreaterThan(10);
    const widest = [["schedule", ""], ["workflow_dispatch", "all"]] as const;
    let checked = 0;
    for (const [event, group] of widest) {
      const n = groupsOf(real(event, group)).length;
      expect(n, `${event} ${group}: a matrix of ${n} jobs exceeds ${limit}`).toBeLessThanOrEqual(GITHUB_MATRIX_LIMIT);
      expect(n, `${event} ${group} printed a matrix`).toBeGreaterThan(10);
      checked++;
    }
    expect(checked).toBe(widest.length);
  });

  spawnIt(14)("a dispatch of one group gives that group alone, the probe included", () => {
    expect(groupsOf(real("workflow_dispatch", "probe"))).toEqual(["probe"]);
    let checked = 0;
    for (const g of Object.keys(STRYKER_GROUPS)) {
      expect(groupsOf(real("workflow_dispatch", g)), g).toEqual([g]);
      checked++;
    }
    expect(checked).toBe(Object.keys(STRYKER_GROUPS).length);
    expect(checked).toBeGreaterThan(1);
  });

  spawnIt(7)("an unknown group, an empty or missing dispatch group, an unknown event and a missing event are each exit 2, with nothing on stdout", () => {
    for (const [event, group] of [["workflow_dispatch", "nosuch"], ["workflow_dispatch", ""], ["workflow_dispatch", null], ["push", ""], ["workflow_call", "all"], [null, "all"], ["", ""]] as const) {
      const r = real(event, group);
      expect({ event, group, status: r.status }).toEqual({ event, group, status: 2 });
      expect(r.stdout, `${String(event)} ${String(group)}`).toBe("");
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  });

  spawnIt(4)("each refusal says its own reason (an unknown group, a dispatch with no group, an unknown event), so one guard cannot stand in for another", () => {
    const unknown = real("workflow_dispatch", "nosuch");
    expect(unknown.stderr).toContain('unknown group "nosuch"');
    for (const group of ["", null] as const) expect(real("workflow_dispatch", group).stderr, String(group)).toContain("needs --group");
    expect(real("push", "").stderr).toContain('unsupported event "push"');
  });

  spawnIt(2)("every entry carries the timeout stryker-timeouts.json holds for its group, a whole number of minutes in (0, 300]", () => {
    const all = [...parsed(real("workflow_dispatch", "all")), ...parsed(real("pull_request", ""))];
    expect(all.length).toBe(NON_PROBE.length + 1);
    for (const e of all) {
      expect(e.timeout, e.group).toBe(TIMEOUTS[e.group]);
      expect(Number.isInteger(e.timeout), e.group).toBe(true);
      expect(e.timeout, e.group).toBeGreaterThan(0);
      expect(e.timeout, e.group).toBeLessThanOrEqual(300);
    }
  });

  it("the timeouts file names exactly the groups, no more (a stale or misspelt group would never be read), each in (0, 300]", () => {
    expect(Object.keys(TIMEOUTS).sort()).toEqual(Object.keys(STRYKER_GROUPS).sort());
    for (const [g, t] of Object.entries(TIMEOUTS)) {
      expect(Number.isInteger(t), g).toBe(true);
      expect(t, g).toBeGreaterThan(0);
      expect(t, g).toBeLessThanOrEqual(300);
    }
  });

  spawnIt(1)("it does not depend on the directory it is run from", () => {
    const elsewhere = matrixCli(REAL, tmpdir(), "workflow_dispatch", "all");
    expect(groupsOf(elsewhere)).toEqual(NON_PROBE);
  });
});

describe("a broken timeouts file is a refusal, never a matrix", () => {
  const scratch = mkdtempSync(join(tmpdir(), "stryker-matrix-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let seq = 0;
  /** A copy of the script, the groups file and a timeouts file of the test's choosing, laid out as in the engine. */
  function tree(timeouts: string | null): string {
    const root = join(scratch, String(++seq));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(REAL, join(root, "scripts/stryker-matrix.mjs"));
    copyFileSync(join(ENGINE, "scripts/stryker-files.mjs"), join(root, "scripts/stryker-files.mjs"));
    copyFileSync(join(ENGINE, "stryker.groups.mjs"), join(root, "stryker.groups.mjs"));
    copyFileSync(join(ENGINE, "stryker-anchors.json"), join(root, "stryker-anchors.json"));
    emptyCopiesOfRealFiles(root); // the real groups name real files
    if (timeouts !== null) writeFileSync(join(root, "stryker-timeouts.json"), timeouts);
    return root;
  }
  const copy = (root: string, event: string, group: string) => matrixCli(join(root, "scripts/stryker-matrix.mjs"), root, event, group);
  const full = (over: Record<string, unknown> = {}) => JSON.stringify({ ...TIMEOUTS, ...over });

  spawnIt(1)("premise: an intact copy works (so each refusal below is the timeouts file's doing)", () => {
    const root = tree(full());
    expect(groupsOf(copy(root, "workflow_dispatch", "all"))).toEqual(NON_PROBE);
  });

  spawnIt(4)("a group with no timeout is a refusal naming it, but only for the groups the event selects", () => {
    const { "draws-1": _drop, ...without } = TIMEOUTS;
    const root = tree(JSON.stringify(without));
    const all = copy(root, "workflow_dispatch", "all");
    expect(all.status).toBe(2);
    expect(all.stderr).toContain("draws-1");
    expect(all.stdout).toBe("");
    expect(copy(root, "workflow_dispatch", "draws-1").status).toBe(2);
    expect(copy(root, "pull_request", "").status).toBe(0); // the probe's timeout is intact
    expect(copy(root, "workflow_dispatch", "core-1").status).toBe(0);
  });

  spawnIt(9)("a timeout over the 300-minute cap, zero, negative, fractional or not a number is a refusal; exactly 300 is fine", () => {
    for (const bad of [301, 0, -5, 12.5, "60", null, true]) {
      const r = copy(tree(full({ "competition-1": bad })), "workflow_dispatch", "competition-1");
      expect({ bad, status: r.status }).toEqual({ bad, status: 2 });
      expect(r.stdout).toBe("");
    }
    const edge = copy(tree(full({ "competition-1": 300 })), "workflow_dispatch", "competition-1");
    expect(slim(parsed(edge))).toEqual([{ group: "competition-1", timeout: 300 }]);
    const one = copy(tree(full({ "competition-1": 1 })), "workflow_dispatch", "competition-1");
    expect(slim(parsed(one))).toEqual([{ group: "competition-1", timeout: 1 }]);
  });

  spawnIt(6)("a missing, empty, malformed or non-object timeouts file is a refusal", () => {
    for (const text of [null, "", "{ nope", "[]", "null", "42"]) {
      const r = copy(tree(text), "workflow_dispatch", "all");
      expect({ text, status: r.status }).toEqual({ text, status: 2 });
      expect(r.stdout).toBe("");
    }
  });

  spawnIt(2)("an empty matrix is a refusal, never an empty-and-green job: a groups file whose only group is the probe, run for a schedule", () => {
    const root = tree(full());
    writeFileSync(join(root, "stryker.groups.mjs"), 'export const STRYKER_GROUPS = { probe: ["src/scheduling/roundrobin.ts"] };\nexport const STRYKER_SPLITS = {};\n');
    const r = copy(root, "schedule", "");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the matrix is empty");
    // the pair: the same tree answers a pull_request with the probe
    expect(parsed(copy(root, "pull_request", "")).map((e) => e.group)).toEqual(["probe"]);
  });

  spawnIt(1)("the timeout comes from the file, not from the script: changing a value changes the matrix", () => {
    const r = copy(tree(full({ probe: 7 })), "pull_request", "");
    expect(slim(parsed(r))).toEqual([{ group: "probe", timeout: 7 }]);
  });
});

// --- the fingerprint of a leg's cut (T20 fix, D14) ----------------------------------------------------------------------
// mutation.yml files a leg's Stryker incremental file under a key that carries this fingerprint, so a leg that is RE-CUT never
// restores the file another cut wrote. The first full re-run proved the need: four legs (sports-cricket-9 and -10, sports-period-2
// and -9) kept their names and changed their ranges, restored the old, wider cut's file, and reported mutants outside their own
// range, which the Survivors guard refused. The fingerprint is derived here (the plan step, before any install), so the tests
// spawn the real script, as the workflow does.
describe("each leg carries the fingerprint of its cut, the key its incremental cache is filed under", () => {
  const CUT = /^[0-9a-f]{16}$/;
  const scratch = mkdtempSync(join(tmpdir(), "stryker-cut-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let seq = 0;
  /** The script beside a groups file and a timeouts file of the test's choosing, laid out as in the engine. */
  function world(groups: Record<string, string[]>, splits: Record<string, string[]>, anchors: Record<string, unknown> = {}, files?: readonly string[]): string {
    const root = join(scratch, String(++seq));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(REAL, join(root, "scripts/stryker-matrix.mjs"));
    copyFileSync(join(ENGINE, "scripts/stryker-files.mjs"), join(root, "scripts/stryker-files.mjs"));
    writeFileSync(join(root, "stryker.groups.mjs"), `export const STRYKER_GROUPS = ${JSON.stringify(groups)};\nexport const STRYKER_SPLITS = ${JSON.stringify(splits)};\n`);
    writeFileSync(join(root, "stryker-timeouts.json"), JSON.stringify(Object.fromEntries(Object.keys(groups).map((g) => [g, 10]))));
    writeFileSync(join(root, "stryker-anchors.json"), JSON.stringify(anchors));
    // the files the entries select (a leg that selects none is refused): the ones the test names, else one per entry
    const here = files ?? Object.values(groups).flat().filter((e) => !e.startsWith("!")).map((e) => {
      const path = e.replace(/(?:#\d+|:\d+-\d+)$/, "");
      const at = path.indexOf("*");
      return at === -1 ? path : `${path.slice(0, path.lastIndexOf("/", at))}/default.ts`;
    });
    for (const f of here) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "export {};\n");
    }
    return root;
  }
  const run = (root: string, group = "all") => matrixCli(join(root, "scripts/stryker-matrix.mjs"), root, "workflow_dispatch", group);
  /** group -> fingerprint, for every leg a `workflow_dispatch all` selects. */
  const cutsIn = (root: string): Record<string, string> => Object.fromEntries(parsed(run(root)).map((e) => [e.group, e.cut]));
  /** The fingerprint of a leg whose only entry is `entry`, under `splits`. */
  const cutOfEntry = (entry: string, splits: Record<string, string[]>): string => cutsIn(world({ g: [entry] }, splits)).g!;

  spawnIt(2)("every leg of every event carries one: 16 hex characters, and exactly the three fields", () => {
    const entries = [...parsed(real("workflow_dispatch", "all")), ...parsed(real("pull_request", ""))];
    expect(entries.length).toBe(NON_PROBE.length + 1);
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) expect(e.cut, e.group).toMatch(CUT);
  });

  spawnIt(2)("no two legs share a fingerprint (a hash of a constant would give every leg the same key)", () => {
    const entries = [...parsed(real("workflow_dispatch", "all")), ...parsed(real("pull_request", ""))];
    expect(new Set(entries.map((e) => e.cut)).size).toBe(entries.length);
    expect(entries.length).toBeGreaterThan(10);
  });

  spawnIt(4)("the same cut gives the same fingerprint however it is asked for: a second run, a schedule, a dispatch of that one leg", () => {
    const first = Object.fromEntries(parsed(real("workflow_dispatch", "all")).map((e) => [e.group, e.cut]));
    const second = Object.fromEntries(parsed(real("workflow_dispatch", "all")).map((e) => [e.group, e.cut]));
    const schedule = Object.fromEntries(parsed(real("schedule", "")).map((e) => [e.group, e.cut]));
    expect(Object.keys(first).length).toBe(NON_PROBE.length);
    expect(second).toEqual(first);
    expect(schedule).toEqual(first);
    const one = parsed(real("workflow_dispatch", "sports-cricket-9"));
    expect(one).toHaveLength(1);
    expect(one[0]!.cut).toBe(first["sports-cricket-9"]);
  });

  spawnIt(2)("it is the cut and nothing else: a different timeout, or the same files in another directory, leave it alone", () => {
    const base = cutsIn(world({ "g-1": ["src/a.ts#2"], "g-2": ["src/b/**", "!src/**/*.test.ts"] }, { "src/a.ts": ["x", "y"] }));
    const again = cutsIn(world({ "g-1": ["src/a.ts#2"], "g-2": ["src/b/**", "!src/**/*.test.ts"] }, { "src/a.ts": ["x", "y"] }));
    expect(Object.keys(base)).toEqual(["g-1", "g-2"]);
    expect(again).toEqual(base);
    const root = world({ "g-1": ["src/a.ts#2"], "g-2": ["src/b/**", "!src/**/*.test.ts"] }, { "src/a.ts": ["x", "y"] });
    writeFileSync(join(root, "stryker-timeouts.json"), JSON.stringify({ "g-1": 99, "g-2": 3 }));
    expect(cutsIn(root)).toEqual(base);
  });

  spawnIt(2)("a re-cut leg whose entry text did NOT change gets a different fingerprint (the cricket-9 defect: part 2 was x..y, an anchor between them made it x..m)", () => {
    const before = cutOfEntry("src/a.ts#2", { "src/a.ts": ["x", "y"] });
    const after = cutOfEntry("src/a.ts#2", { "src/a.ts": ["x", "m", "y"] });
    expect(before).toMatch(CUT);
    expect(after).toMatch(CUT);
    expect(after).not.toBe(before);
  });

  // Each case is one leg's one part; `range` is what that part IS (the statement that starts it up to the statement that starts
  // the next), written by hand from STRYKER_SPLITS' own definition ("a cut is the statement that STARTS the next part"), never
  // from the script. Two cases with the same range must share a fingerprint, with different ranges must not.
  const CASES: { entry: string; splits: Record<string, string[]>; range: string }[] = [
    { entry: "src/a.ts#2", splits: { "src/a.ts": ["x", "y"] }, range: "a: x..y" },
    { entry: "src/a.ts#3", splits: { "src/a.ts": ["w", "x", "y"] }, range: "a: x..y" },          // renumbered, longer list, same range
    { entry: "src/a.ts#2", splits: { "src/a.ts": ["x", "m", "y"] }, range: "a: x..m" },          // an anchor inside it
    { entry: "src/a.ts#3", splits: { "src/a.ts": ["x", "m", "y"] }, range: "a: m..y" },
    { entry: "src/a.ts#1", splits: { "src/a.ts": ["x", "y"] }, range: "a: start..x" },
    { entry: "src/a.ts#1", splits: { "src/a.ts": ["x", "z"] }, range: "a: start..x" },          // the anchor AFTER the part moved: same range
    { entry: "src/a.ts#1", splits: { "src/a.ts": ["x"] }, range: "a: start..x" },
    { entry: "src/a.ts#1", splits: { "src/a.ts": ["w", "x", "y"] }, range: "a: start..w" },
    { entry: "src/a.ts#2", splits: { "src/a.ts": ["w", "x", "y"] }, range: "a: w..x" },
    { entry: "src/a.ts#3", splits: { "src/a.ts": ["x", "y"] }, range: "a: y..end" },
    { entry: "src/a.ts#4", splits: { "src/a.ts": ["w", "x", "y"] }, range: "a: y..end" },
    { entry: "src/a.ts#2", splits: { "src/a.ts": ["y"] }, range: "a: y..end" },
    { entry: "src/b.ts#1", splits: { "src/b.ts": ["x"] }, range: "b: start..x" },               // another file, the same anchor
  ];

  spawnIt(CASES.length)("a part's fingerprint is its range: equal for the same range however numbered, different for any other range or file", () => {
    const cuts = CASES.map((c) => ({ ...c, cut: cutOfEntry(c.entry, c.splits) }));
    let same = 0;
    let different = 0;
    for (const a of cuts) {
      for (const b of cuts) {
        if (a === b) continue;
        if (a.range === b.range) {
          expect(b.cut, `${a.entry} ${JSON.stringify(a.splits)} and ${b.entry} ${JSON.stringify(b.splits)} are both ${a.range}`).toBe(a.cut);
          same++;
        } else {
          expect(b.cut, `${a.range} (${a.entry}) vs ${b.range} (${b.entry})`).not.toBe(a.cut);
          different++;
        }
      }
    }
    expect(same, "ordered pairs with one range").toBeGreaterThan(0);
    expect(different, "ordered pairs with different ranges").toBeGreaterThan(0);
    expect(same + different).toBe(CASES.length * (CASES.length - 1));
  });

  spawnIt(2)("re-cutting one file moves only the legs that take a part of it", () => {
    const groups = { "g-1": ["src/a.ts#1"], "g-2": ["src/b.ts#2"], "g-3": ["src/c/**", "!src/**/*.test.ts"] };
    const before = cutsIn(world(groups, { "src/a.ts": ["x", "y"], "src/b.ts": ["p"] }));
    const after = cutsIn(world(groups, { "src/a.ts": ["w", "x", "y"], "src/b.ts": ["p"] }));
    expect(Object.keys(before)).toEqual(["g-1", "g-2", "g-3"]);
    expect(after["g-1"], "a.ts's part 1 was start..x and is start..w").not.toBe(before["g-1"]);
    expect(after["g-2"]).toBe(before["g-2"]);
    expect(after["g-3"]).toBe(before["g-3"]);
  });

  spawnIt(6)("a leg's own file list is part of the cut: another glob, a dropped negation, a reorder (negations apply last), a part in place of a whole file", () => {
    const splits = { "src/a.ts": ["x"] };
    const base = cutOfEntry("src/a.ts", splits);
    const variants = [
      cutOfEntry("src/a.ts#1", splits),
      cutOfEntry("src/other.ts", splits),
      cutsIn(world({ g: ["src/a.ts", "src/b.ts"] }, splits)).g!,
      cutsIn(world({ g: ["src/a.ts", "!src/a.test.ts"] }, splits)).g!,
      cutsIn(world({ g: ["!src/a.test.ts", "src/a.ts"] }, splits)).g!,
    ];
    for (const v of variants) expect(v).toMatch(CUT);
    expect(new Set([base, ...variants]).size, "six different cuts, six different fingerprints").toBe(6);
    expect(cutOfEntry("src/a.ts", splits), "and the same one twice is the same").toBe(base);
  });

  spawnIt(4)("an ordinal anchor (`if#7`, the 7th `if` of a body) is fingerprinted with the line recorded for it: re-recording the line moves the key of the legs cut at it, and of no other leg", () => {
    const groups = { "g-1": ["src/a.ts#1"], "g-2": ["src/a.ts#2"], "g-3": ["src/a.ts#3"], "g-4": ["src/b.ts#1"] };
    const splits = { "src/a.ts": ["h.f.if#3", "h.f.if#7"], "src/b.ts": ["x"] };
    const recorded = (third: string, seventh: string) => ({ "src/a.ts": { "h.f.if#3": { starts: third }, "h.f.if#7": { starts: seventh } } });
    const base = cutsIn(world(groups, splits, recorded("if (a) {", "if (b) {")));
    const seventh = cutsIn(world(groups, splits, recorded("if (a) {", "if (c) {")));
    const third = cutsIn(world(groups, splits, recorded("if (z) {", "if (b) {")));
    expect(Object.keys(base)).toEqual(["g-1", "g-2", "g-3", "g-4"]);
    // g-1 is start..if#3, g-2 is if#3..if#7, g-3 is if#7..end
    expect(seventh["g-1"], "g-1 does not touch the 7th").toBe(base["g-1"]);
    expect(seventh["g-2"], "g-2 ends at the 7th").not.toBe(base["g-2"]);
    expect(seventh["g-3"], "g-3 starts at the 7th").not.toBe(base["g-3"]);
    expect(seventh["g-4"], "another file").toBe(base["g-4"]);
    expect(third["g-1"], "g-1 ends at the 3rd").not.toBe(base["g-1"]);
    expect(third["g-2"], "g-2 starts at the 3rd").not.toBe(base["g-2"]);
    expect(third["g-3"], "g-3 does not touch the 3rd").toBe(base["g-3"]);
    expect(third["g-4"], "another file").toBe(base["g-4"]);
  });

  spawnIt(4)("an ordinal anchor with no recorded line is a refusal naming it (nothing on stdout) for a leg cut at it, and no refusal for a leg that is not", () => {
    const groups = { "g-1": ["src/a.ts#2"], "g-2": ["src/b.ts#1"] };
    const splits = { "src/a.ts": ["h.f.if#3"], "src/b.ts": ["x"] };
    const root = world(groups, splits, {});
    const r = run(root, "g-1");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('"g-1" is cut at the ordinal anchor "h.f.if#3" of src/a.ts');
    expect(r.stderr).toContain("no line recorded");
    expect(parsed(run(root, "g-2")).map((e) => e.group), "a leg that is not cut at it").toEqual(["g-2"]);
    // the pair: with a record it works
    expect(parsed(run(world(groups, splits, { "src/a.ts": { "h.f.if#3": { starts: "if (a) {" } } }), "g-1")).map((e) => e.group)).toEqual(["g-1"]);
    // an anchors file that is not an object is a refusal of its own
    const broken = world(groups, splits, {});
    writeFileSync(join(broken, "stryker-anchors.json"), "[]");
    expect(run(broken, "g-2").status).toBe(2);
  });

  spawnIt(2)("the real legs cut at an ordinal anchor take its recorded line into their fingerprint; every other leg's is untouched by it", () => {
    const realTree = (anchors: unknown): string => {
      const root = join(scratch, String(++seq));
      mkdirSync(join(root, "scripts"), { recursive: true });
      copyFileSync(REAL, join(root, "scripts/stryker-matrix.mjs"));
    copyFileSync(join(ENGINE, "scripts/stryker-files.mjs"), join(root, "scripts/stryker-files.mjs"));
      copyFileSync(join(ENGINE, "stryker.groups.mjs"), join(root, "stryker.groups.mjs"));
      copyFileSync(join(ENGINE, "stryker-timeouts.json"), join(root, "stryker-timeouts.json"));
      writeFileSync(join(root, "stryker-anchors.json"), JSON.stringify(anchors));
      emptyCopiesOfRealFiles(root);
      return root;
    };
    const anchors = JSON.parse(readFileSync(join(ENGINE, "stryker-anchors.json"), "utf8")) as Record<string, Record<string, { starts: string }>>;
    const moved = JSON.parse(JSON.stringify(anchors, (_k, v) => (typeof v === "string" ? `${v} // moved` : v))) as typeof anchors;
    // the legs cut at an ordinal anchor, from the groups and the splits themselves (an anchor with a '#' in it): the part N of a file
    // is bounded by anchors N-2 and N-1
    const atOrdinal = Object.entries(STRYKER_GROUPS).filter(([, entries]) => entries.some((e) => {
      const m = /^(.*)#(\d+)$/.exec(e);
      if (m === null) return false;
      const bounds = STRYKER_SPLITS[m[1] as string] ?? [];
      return [bounds[Number(m[2]) - 2], bounds[Number(m[2]) - 1]].some((a) => a !== undefined && a.includes("#"));
    })).map(([g]) => g).filter((g) => g !== "probe");
    const before = cutsIn(realTree(anchors));
    const after = cutsIn(realTree(moved));
    expect(atOrdinal.length, "legs cut at an ordinal anchor").toBeGreaterThan(2);
    for (const g of atOrdinal) expect(after[g], `${g} is cut at an ordinal anchor`).not.toBe(before[g]);
    const others = NON_PROBE.filter((g) => !atOrdinal.includes(g));
    expect(others.length, "legs not cut at one").toBeGreaterThan(10);
    for (const g of others) expect(after[g], `${g} is not`).toBe(before[g]);
  });

  // --- the files a leg's globs resolve to are part of its cut (T20 review, Minor 3) ------------------------------------------
  // A file added, removed or renamed inside a glob changes what the leg mutates while every entry stays the same: without the files
  // in the fingerprint a cache restored across it carries results for a file the leg no longer holds.
  const GLOB_GROUPS = { "g-1": ["src/dir/**/*.ts", "!src/dir/**/*.test.ts"], "g-2": ["src/other/**/*.ts"], "g-3": ["src/fixed.ts"] };
  const FILES = ["src/dir/a.ts", "src/dir/deep/b.ts", "src/dir/a.test.ts", "src/other/o.ts", "src/fixed.ts", "src/unrelated/u.ts"];
  const globWorld = (files: readonly string[]) => cutsIn(world(GLOB_GROUPS, {}, {}, files));

  spawnIt(7)("a file added, removed or renamed inside a leg's glob changes that leg's fingerprint and no other leg's; a file outside every glob, or one a negation removes, changes nothing", () => {
    const base = globWorld(FILES);
    expect(Object.keys(base)).toEqual(["g-1", "g-2", "g-3"]);
    // the same files again: the same fingerprints (the premise of every difference below)
    expect(globWorld(FILES)).toEqual(base);
    const added = globWorld([...FILES, "src/dir/new.ts"]);
    expect(added["g-1"], "a file added to g-1's glob").not.toBe(base["g-1"]);
    expect(added["g-2"]).toBe(base["g-2"]);
    expect(added["g-3"]).toBe(base["g-3"]);
    const addedDeep = globWorld([...FILES, "src/dir/deep/er/new.ts"]);
    expect(addedDeep["g-1"], "a file added two directories down").not.toBe(base["g-1"]);
    const removed = globWorld(FILES.filter((f) => f !== "src/dir/deep/b.ts"));
    expect(removed["g-1"], "a file removed from g-1's glob").not.toBe(base["g-1"]);
    expect(removed["g-2"]).toBe(base["g-2"]);
    const renamed = globWorld(FILES.map((f) => (f === "src/dir/a.ts" ? "src/dir/renamed.ts" : f)));
    expect(renamed["g-1"], "a file renamed inside g-1's glob").not.toBe(base["g-1"]);
    expect(renamed["g-1"], "and the rename is a different set from the removal").not.toBe(removed["g-1"]);
    expect(globWorld([...FILES, "src/unrelated/other.ts", "docs/readme.md"]), "files no glob selects").toEqual(base);
    expect(globWorld([...FILES, "src/dir/b.test.ts", "src/dir/deep/c.test.ts"]), "files g-1's own negation removes").toEqual(base);
    expect(globWorld([...FILES, "src/dir/data.json"]), "a file the glob's extension does not select").toEqual(base);
    // a literal entry's file: removed it selects nothing (the other legs still have files, so the matrix is built; g-3 itself is refused below)
    expect(globWorld([...FILES, "src/fixed.ts"]), "a file already there, listed twice").toEqual(base);
  });

  spawnIt(2)("a rename that keeps the leg's file COUNT still moves the fingerprint (the list, not its length)", () => {
    const a = globWorld(["src/dir/a.ts", "src/other/o.ts", "src/fixed.ts"]);
    const b = globWorld(["src/dir/z.ts", "src/other/o.ts", "src/fixed.ts"]);
    expect(b["g-1"]).not.toBe(a["g-1"]);
  });

  spawnIt(5)("a leg whose entries select no file is a refusal naming it, nothing on stdout; a glob the reader cannot read, or one that starts with a wildcard, is a refusal of its own", () => {
    const cases: [string, Record<string, string[]>, string[], RegExp][] = [
      ["selects nothing", { g: ["src/dir/**/*.ts"] }, [], /"g" selects no files/],
      ["only negated away", { g: ["src/dir/**/*.ts", "!src/dir/**/*.ts"] }, ["src/dir/a.ts"], /"g" selects no files/],
      ["a brace set", { g: ["src/{a,b}.ts"] }, ["src/a.ts"], /uses glob syntax this reader does not implement/],
      ["a leading wildcard", { g: ["**/*.ts"] }, ["src/a.ts"], /must start with a literal directory/],
    ];
    for (const [name, groups, files, why] of cases) {
      const r = run(world(groups, {}, {}, files));
      expect({ name, status: r.status }).toEqual({ name, status: 2 });
      expect(r.stdout, name).toBe("");
      expect(r.stderr, name).toMatch(why);
    }
    // the pair: with a file the same leg works
    expect(parsed(run(world({ g: ["src/dir/**/*.ts"] }, {}, {}, ["src/dir/a.ts"]))).map((e) => e.group)).toEqual(["g"]);
  });

  it("the reader finds exactly the files Stryker's own glob reading selects, for every real leg (the plan runs without node's glob; the tests do not)", () => {
    let legs = 0;
    let files = 0;
    for (const g of Object.keys(STRYKER_GROUPS)) {
      const theirs = [...selected(ENGINE, resolveGroup(g)).keys()].sort();
      const ours = filesOf(STRYKER_GROUPS[g as keyof typeof STRYKER_GROUPS], ENGINE);
      expect(ours, g).toEqual(theirs);
      legs++;
      files += ours.length;
    }
    expect(legs, "legs compared").toBe(Object.keys(STRYKER_GROUPS).length);
    expect(files, "files compared").toBeGreaterThan(100);
  }, 120_000);

  it("the glob reader agrees with node's own glob matcher on every case of a table (and the table has both answers)", () => {
    const CASES: [string, string][] = [
      ["src/a/**/*.ts", "src/a/x.ts"], ["src/a/**/*.ts", "src/a/b/c.ts"], ["src/a/**/*.ts", "src/a/b/c/d.ts"], ["src/a/**/*.ts", "src/a/x.js"],
      ["src/a/**/*.ts", "src/ax.ts"], ["src/a/**/*.ts", "src/b/x.ts"], ["src/a/*.ts", "src/a/x.ts"], ["src/a/*.ts", "src/a/b/x.ts"],
      ["src/**/*.test.ts", "src/x.test.ts"], ["src/**/*.test.ts", "src/a/b/x.test.ts"], ["src/**/*.test.ts", "src/a/x.ts"],
      ["src/**/__tests__/**", "src/a/__tests__/h.ts"], ["src/**/__tests__/**", "src/__tests__/h.ts"], ["src/**/__tests__/**", "src/a/b.ts"],
      ["src/a/**", "src/a/x.ts"], ["src/a/**", "src/a/b/x.ts"], ["src/a/**", "src/ax/x.ts"],
      ["src/a.ts", "src/a.ts"], ["src/a.ts", "src/b.ts"], ["src/*/x.ts", "src/a/x.ts"], ["src/*/x.ts", "src/a/b/x.ts"],
      ["src/a/**/*.ts", "src/a/.hidden/x.ts"], ["src/a/*.ts", "src/a/.x.ts"], ["src/a/**", "src/a/.hidden/x.ts"], ["src/a/**", "src/a/.x.ts"], ["src/a-*.ts", "src/a-b.ts"], ["src/a-*.ts", "src/a.ts"],
    ];
    let yes = 0;
    let no = 0;
    for (const [glob, file] of CASES) {
      const theirs = matchesGlob(file, glob);
      expect(globMatches(glob, file), `${glob} against ${file}`).toBe(theirs);
      if (theirs) yes++;
      else no++;
    }
    expect(yes, "cases that match").toBeGreaterThan(5);
    expect(no, "cases that do not").toBeGreaterThan(5);
    expect(yes + no).toBe(CASES.length);
  });

  it("filesOf reads a list in Stryker's order: a negation removes what came before, a later entry adds it back, a part or a range names its file", () => {
    const root = join(scratch, `files-${++seq}`);
    for (const f of ["src/a/x.ts", "src/a/y.ts", "src/a/y.test.ts", "src/b/z.ts"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "export {};\n");
    }
    expect(filesOf(["src/a/**/*.ts"], root)).toEqual(["src/a/x.ts", "src/a/y.test.ts", "src/a/y.ts"]);
    expect(filesOf(["src/a/**/*.ts", "!src/a/**/*.test.ts"], root)).toEqual(["src/a/x.ts", "src/a/y.ts"]);
    expect(filesOf(["!src/a/**/*.test.ts", "src/a/**/*.ts"], root), "a negation before the add removes nothing").toEqual(["src/a/x.ts", "src/a/y.test.ts", "src/a/y.ts"]);
    expect(filesOf(["src/a/**/*.ts", "!src/a/y.ts", "src/a/y.ts"], root), "added back").toEqual(["src/a/x.ts", "src/a/y.test.ts", "src/a/y.ts"]);
    expect(filesOf(["src/b/z.ts#2", "src/a/x.ts:3-9"], root), "a part and a range select their file").toEqual(["src/a/x.ts", "src/b/z.ts"]);
    expect(filesOf(["src/missing.ts", "src/nodir/**/*.ts"], root), "a missing file and a missing directory select nothing").toEqual([]);
    // a second root with the same directory names but other files: a listing kept from the first root would answer for it
    const other = join(scratch, `files-${++seq}`);
    mkdirSync(join(other, "src/a"), { recursive: true });
    writeFileSync(join(other, "src/a/q.ts"), "export {};\n");
    expect(filesOf(["src/a/**/*.ts"], other), "another root, the same directory").toEqual(["src/a/q.ts"]);
    expect(filesOf(["src/a/**/*.ts"], root), "and the first root again").toEqual(["src/a/x.ts", "src/a/y.test.ts", "src/a/y.ts"]);
    expect(() => filesOf(["src/{a,b}/x.ts"], root)).toThrow(/does not implement/);
    expect(() => filesOf(["/src/a/x.ts"], root)).toThrow(/relative path/);
    expect(() => filesOf(["src/a**/x.ts"], root)).toThrow(/whole segment/);
  });

  spawnIt(5)("a part the groups file cannot resolve is a refusal naming it, with nothing on stdout (a fingerprint of a broken cut would file a cache under it)", () => {
    const splits = { "src/a.ts": ["x", "y"] };
    for (const [entry, why] of [["src/a.ts#0", "has parts 1 to 3"], ["src/a.ts#4", "has parts 1 to 3"], ["src/nosplit.ts#1", "has no split in STRYKER_SPLITS"]] as const) {
      const r = run(world({ g: [entry] }, splits));
      expect({ entry, status: r.status }).toEqual({ entry, status: 2 });
      expect(r.stdout, entry).toBe("");
      expect(r.stderr, entry).toContain(why);
      expect(r.stderr, entry).toContain(entry);
    }
    // the pair: the first part and the last part of the same file are fine
    expect(cutOfEntry("src/a.ts#1", splits)).toMatch(CUT);
    expect(cutOfEntry("src/a.ts#3", splits)).toMatch(CUT);
  });
});
