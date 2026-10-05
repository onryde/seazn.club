// W1d Task 15 (D14; rulings 66, 67): scripts/stryker-matrix.mjs derives mutation.yml's job matrix, one entry per Stryker
// group with its job timeout. It is SPAWNED here per event (the workflow runs it as a plain `node` step, so what is proven
// is the process's stdout and exit code, not a function a test imported), and again from a copy in a scratch tree whose
// timeouts file is broken, to reach the refusals the real file never triggers.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";
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
function parsed(o: Out): { group: string; timeout: number }[] {
  expect(o.status, o.stderr).toBe(0);
  expect(o.stderr).toBe("");
  const lines = o.stdout.split("\n").filter((l) => l !== "");
  expect(lines, "exactly one output line").toHaveLength(1);
  expect(lines[0]).toMatch(/^matrix=\{"include":\[/);
  const m = JSON.parse(lines[0]!.slice("matrix=".length)) as { include: { group: string; timeout: number }[] };
  expect(Object.keys(m)).toEqual(["include"]);
  for (const e of m.include) expect(Object.keys(e).sort(), "an entry is exactly {group, timeout}").toEqual(["group", "timeout"]);
  return m.include;
}
const groupsOf = (o: Out) => parsed(o).map((e) => e.group);

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
    // 69 legs and the probe are 70 jobs, 3.7x under the limit; a matrix over it is refused by GitHub when the plan job hands it
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
    copyFileSync(join(ENGINE, "stryker.groups.mjs"), join(root, "stryker.groups.mjs"));
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
    expect(parsed(edge)).toEqual([{ group: "competition-1", timeout: 300 }]);
    const one = copy(tree(full({ "competition-1": 1 })), "workflow_dispatch", "competition-1");
    expect(parsed(one)).toEqual([{ group: "competition-1", timeout: 1 }]);
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
    writeFileSync(join(root, "stryker.groups.mjs"), 'export const STRYKER_GROUPS = { probe: ["src/scheduling/roundrobin.ts"] };\n');
    const r = copy(root, "schedule", "");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the matrix is empty");
    // the pair: the same tree answers a pull_request with the probe
    expect(parsed(copy(root, "pull_request", "")).map((e) => e.group)).toEqual(["probe"]);
  });

  spawnIt(1)("the timeout comes from the file, not from the script: changing a value changes the matrix", () => {
    const r = copy(tree(full({ probe: 7 })), "pull_request", "");
    expect(parsed(r)).toEqual([{ group: "probe", timeout: 7 }]);
  });
});
