// W1d Task 15 (D14; rulings 66, 67): the Stryker floor. scripts/stryker-floor.ts judges a group's mutation.json against
// stryker-floor.json (a floor that only rises), lists survivors, and refuses to read an empty report as a pass. The
// pure functions are tested directly; the CLI, and above all `--check-file-against`'s empty cases, are tested by SPAWNING
// it in a throwaway git repo (a function test cannot see the git plumbing that PR-A's own first run depends on).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";
import { parseEntry } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { check, floorDiff, missingFloors, parseEquivalents, parseFloors, parseReport, setFloor, survivorsMarkdown, type Report } from "../scripts/stryker-floor.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ENGINE, "scripts/stryker-floor.ts");

// ---- fixtures: a mutation-testing-elements report (the schema Stryker 10 writes: files[path].mutants[].status) ------------

interface Counts { killed?: number; survived?: number; timeout?: number; noCoverage?: number; ignored?: number; compileError?: number; runtimeError?: number }
const STATUS_OF: Record<keyof Counts, string> = { killed: "Killed", survived: "Survived", timeout: "Timeout", noCoverage: "NoCoverage", ignored: "Ignored", compileError: "CompileError", runtimeError: "RuntimeError" };

/** A report with `n` mutants of each status in ONE file of the `draws-bracket` group; mutant i sits at line i+1, column 1, in the
 *  order killed, survived, timeout, noCoverage, ignored, compileError, runtimeError. */
function report(c: Counts, file = "src/scheduling/bracket.ts"): Report {
  const mutants: Report["files"][string]["mutants"] = [];
  let line = 1;
  for (const k of Object.keys(STATUS_OF) as (keyof Counts)[]) {
    for (let i = 0; i < (c[k] ?? 0); i++) {
      mutants.push({ id: String(line), mutatorName: "ConditionalExpression", replacement: "true", status: STATUS_OF[k], location: { start: { line, column: 1 }, end: { line, column: 9 } } });
      line++;
    }
  }
  return { files: { [file]: { mutants } } };
}
const floors = (g: Record<string, number>) => g;
// Equivalent mutants are identified by `file:line:col mutator → replacement` (written here as literals, never produced by the code under test).
const EQ = (line: number) => `src/scheduling/bracket.ts:${line}:1 ConditionalExpression → true`;

describe("check: the verdict (zero mutants is a refusal, never a pass)", () => {
  it("zero mutants is a refusal (vacuous), never a pass", () => {
    expect(check("draws-bracket", report({ killed: 0, survived: 0 }), floors({ "draws-bracket": 50 }))).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("a report of nothing but ignored and error mutants has zero VALID mutants: refused too, whatever the floor", () => {
    const r = check("draws-bracket", report({ ignored: 5, compileError: 3, runtimeError: 2 }), floors({ "draws-bracket": 0 }));
    expect(r).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("a report with no files at all is zero mutants (the empty case first)", () => {
    expect(check("draws-bracket", { files: {} }, floors({ "draws-bracket": 0 }))).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("a score below the floor fails and lists survivors; at the floor passes", () => {
    const below = check("draws-bracket", report({ killed: 49, survived: 51 }), floors({ "draws-bracket": 50 }));
    expect(below.exit).toBe(1);
    if (below.exit !== 1) throw new Error("unreachable");
    expect(below.survivors).toHaveLength(51);
    expect(below.survivors[0]).toBe("src/scheduling/bracket.ts:50:1 ConditionalExpression → true");
    expect(check("draws-bracket", report({ killed: 50, survived: 50 }), floors({ "draws-bracket": 50 })).exit).toBe(0);
    expect(check("draws-bracket", report({ killed: 51, survived: 49 }), floors({ "draws-bracket": 50 })).exit).toBe(0);
  });

  it("the score is exact: 66.6% against a 66.7 floor fails, however the float rounds (2 of 3 killed)", () => {
    // 2/3 = 66.666…%: floor(…, 1 dp) = 66.6, so a 66.7 floor is unmet and a 66.6 floor is met
    expect(check("draws-bracket", report({ killed: 2, survived: 1 }), floors({ "draws-bracket": 66.7 })).exit).toBe(1);
    expect(check("draws-bracket", report({ killed: 2, survived: 1 }), floors({ "draws-bracket": 66.6 })).exit).toBe(0);
    // 7340 of 10000 is exactly 73.4: a float quotient can read 73.39999…, which must not fail a 73.4 floor
    expect(check("draws-bracket", report({ killed: 7340, survived: 2660 }), floors({ "draws-bracket": 73.4 })).exit).toBe(0);
  });

  it("Timeout counts as detected, NoCoverage as undetected (an uncovered line is a survivor), and Ignored / CompileError / RuntimeError are not in the denominator", () => {
    // detected = 30 killed + 20 timeout = 50; undetected = 25 survived + 25 noCoverage = 50 → 50.0%
    expect(check("draws-bracket", report({ killed: 30, timeout: 20, survived: 25, noCoverage: 25 }), floors({ "draws-bracket": 50 })).exit).toBe(0);
    expect(check("draws-bracket", report({ killed: 30, timeout: 20, survived: 25, noCoverage: 26 }), floors({ "draws-bracket": 50 })).exit).toBe(1); // 50/101
    // NoCoverage alone drags the score: 50 killed, 0 survived, 1 noCoverage = 50/51 = 98.0%, below a 99 floor
    expect(check("draws-bracket", report({ killed: 50, noCoverage: 1 }), floors({ "draws-bracket": 99 })).exit).toBe(1);
    expect(check("draws-bracket", report({ killed: 50 }), floors({ "draws-bracket": 99 })).exit).toBe(0);
    // 49 killed, 51 survived is 49%; a thousand ignored / compile / runtime mutants change nothing
    expect(check("draws-bracket", report({ killed: 49, survived: 51, ignored: 400, compileError: 300, runtimeError: 300 }), floors({ "draws-bracket": 50 })).exit).toBe(1);
    expect(check("draws-bracket", report({ killed: 50, survived: 50, ignored: 400, compileError: 300, runtimeError: 300 }), floors({ "draws-bracket": 50 })).exit).toBe(0);
  });

  it("an equivalent mutant listed by file:line:col and mutator is excluded from the denominator", () => {
    // 49 killed (lines 1-49), 51 survived (lines 50-100): 49/100 = 49.0 → exit 1. One equivalent listed → 49/99 = 49.4 → still < 50 → exit 1;
    // two equivalents listed → 49/98 = 50.0 → exit 0
    const rep = report({ killed: 49, survived: 51 });
    expect(check("draws-bracket", rep, floors({ "draws-bracket": 50 }), []).exit).toBe(1);
    expect(check("draws-bracket", rep, floors({ "draws-bracket": 50 }), [EQ(50)]).exit).toBe(1);
    const two = check("draws-bracket", rep, floors({ "draws-bracket": 50 }), [EQ(50), EQ(51)]);
    expect(two.exit).toBe(0);
    if (two.exit !== 0) throw new Error("unreachable");
    expect(two.survivors).toHaveLength(49); // the two equivalents are not survivors either
    expect(two.survivors).not.toContain(EQ(50));
    expect(two.survivors).toContain(EQ(52));
  });

  it("an equivalent entry only forgives a SURVIVOR at that exact location: not a killed mutant, not another mutator, not another replacement", () => {
    const rep = report({ killed: 49, survived: 51 });
    // lines 1 and 2 are Killed: listing them changes nothing (49/100 = 49.0%)
    expect(check("draws-bracket", rep, floors({ "draws-bracket": 50 }), [EQ(1), EQ(2)]).exit).toBe(1);
    // a different mutator or replacement or column or file at a survivor's location is a different mutant: with EQ(51) alone it is 49/99 = 49.4 → 1
    for (const wrong of ["src/scheduling/bracket.ts:50:1 EqualityOperator → true", "src/scheduling/bracket.ts:50:1 ConditionalExpression → false", "src/scheduling/bracket.ts:50:2 ConditionalExpression → true", "src/scheduling/swiss.ts:50:1 ConditionalExpression → true"]) {
      expect(check("draws-bracket", rep, floors({ "draws-bracket": 50 }), [wrong, EQ(51)]).exit, wrong).toBe(1);
    }
    // the same two, spelt right, do pass (the loop above would be vacuous if nothing could ever forgive)
    expect(check("draws-bracket", rep, floors({ "draws-bracket": 50 }), [EQ(50), EQ(51)]).exit).toBe(0);
  });

  it("no floor for a group is a refusal until PR-B sets one", () => {
    expect(check("draws-bracket", report({ killed: 1, survived: 0 }), floors({})).exit).toBe(2);
    expect(check("draws-bracket", report({ killed: 1, survived: 0 }), floors({ competition: 10 })).exit).toBe(2);
  });

  it("the probe has no floor to check against: --check probe is a refusal even when floors exist", () => {
    expect(check("probe", report({ killed: 1 }, "src/scheduling/roundrobin.ts"), floors({ probe: 10 })).exit).toBe(2);
  });

  it("a report that mutated files outside the group is the wrong report: refused, never judged against this group's floor", () => {
    const wrong = report({ killed: 100 }, "src/competition/standings.ts");
    const r = check("draws-bracket", wrong, floors({ "draws-bracket": 50 }));
    expect(r.exit).toBe(2);
    expect(r.why).toContain("src/competition/standings.ts");
    // the same report is fine for its own group
    expect(check("competition", wrong, floors({ competition: 50 })).exit).toBe(0);
  });

  /** A report of Killed mutants of one file, one at each of `lines` (column 1). */
  const killedAt = (file: string, lines: number[]): Report => ({
    files: { [file]: { mutants: lines.map((line) => ({ mutatorName: "ConditionalExpression", replacement: "true", status: "Killed", location: { start: { line, column: 1 } } })) } },
  });

  it("the legs of a split file are told apart by LINE: a leg accepts the mutants of its own range and refuses another leg's report of the same file (the file name alone cannot)", () => {
    const FILE = "src/sports/cricket/cricket.ts";
    const legs = Object.entries(STRYKER_GROUPS).filter(([g]) => g.startsWith("sports-cricket-kernel-"));
    // the ranges are the groups' own declaration, read back here, never typed
    const ranges = legs.map(([g, entries]) => {
      const { glob, lines } = parseEntry(entries[0] as string);
      expect(glob, g).toBe(FILE);
      return { g, from: (lines as readonly [number, number])[0], to: (lines as readonly [number, number])[1] };
    });
    expect(ranges.length, "the cricket kernel is split into more than one leg").toBeGreaterThan(1);
    let accepted = 0;
    let refused = 0;
    for (const own of ranges) {
      const fl = floors({ [own.g]: 50 });
      for (const line of [own.from, own.to]) {
        expect(check(own.g, killedAt(FILE, [line]), fl).exit, `${own.g} at its own line ${line}`).toBe(0);
        accepted++;
      }
      for (const other of ranges.filter((r) => r.g !== own.g)) {
        const r = check(own.g, killedAt(FILE, [own.from, other.from]), fl);
        expect(r.exit, `${own.g} given ${other.g}'s mutant at line ${other.from}`).toBe(2);
        expect(r.why).toContain(`${FILE}:${other.from}`);
        refused++;
      }
    }
    expect(accepted).toBe(ranges.length * 2);
    expect(refused).toBe(ranges.length * (ranges.length - 1));
  });

  it("a leg that negates a file and then ranges it is read in order: the file counts, but only through its range (and its directory's other files whole)", () => {
    const nested = Object.entries(STRYKER_GROUPS).filter(([g]) => g.startsWith("sports-nested-"));
    const [first, second] = nested.map(([g]) => g);
    expect(nested.length).toBe(2);
    const kernel = "src/sports/nested/kernel.ts";
    const tailFrom = (parseEntry(nested[1]?.[1].find((e) => parseEntry(e).lines !== null) as string).lines as readonly [number, number])[0];
    const fl = floors({ [second as string]: 50, [first as string]: 50 });
    expect(check(second as string, killedAt(kernel, [tailFrom]), fl).exit, "the tail's own range").toBe(0);
    expect(check(second as string, killedAt(kernel, [tailFrom - 1]), fl).exit, "the line just before it belongs to the leg before").toBe(2);
    expect(check(second as string, killedAt("src/sports/nested/index.ts", [1]), fl).exit, "a whole file of the directory glob").toBe(0);
    expect(check(first as string, killedAt("src/sports/nested/index.ts", [1]), fl).exit, "the first leg is the range alone").toBe(2);
    expect(check(second as string, killedAt("src/sports/period/kernel.ts", [tailFrom]), fl).exit, "another sport").toBe(2);
  });

  it("an unknown group is a refusal", () => {
    expect(check("nosuch", report({ killed: 1 }), floors({ nosuch: 1 })).exit).toBe(2);
  });
});

describe("parsing: a malformed input is a refusal, and so is a status nobody counted", () => {
  const ok = JSON.stringify(report({ killed: 1 }));
  it("parseReport reads a real report and refuses garbage, a missing files map, a Pending mutant and an unknown status", () => {
    expect(Object.keys(parseReport(ok).files)).toEqual(["src/scheduling/bracket.ts"]);
    for (const [name, text] of [
      ["not JSON", "{"],
      ["an array", "[]"],
      ["no files", "{}"],
      ["files not an object", '{"files": []}'],
      ["a file with no mutants array", '{"files": {"a.ts": {}}}'],
      ["a mutant with no status", '{"files": {"a.ts": {"mutants": [{"mutatorName": "x", "location": {"start": {"line": 1, "column": 1}}}]}}}'],
      ["a mutant with no location", '{"files": {"a.ts": {"mutants": [{"mutatorName": "x", "status": "Killed"}]}}}'],
    ] as const) expect(() => parseReport(text), name).toThrow();
    // Pending: the run did not finish; an unknown status would silently skew the score
    // Each says its own reason: a Pending report names the unfinished run, so the unknown-status refusal cannot stand in for it.
    for (const [status, reason] of [["Pending", "did not finish"], ["Frobnicated", "does not count"]] as const) {
      const text = JSON.stringify({ files: { "a.ts": { mutants: [{ mutatorName: "x", status, location: { start: { line: 1, column: 1 } } }] } } });
      expect(() => parseReport(text), status).toThrow(status);
      expect(() => parseReport(text), `${status}: ${reason}`).toThrow(reason);
    }
  });

  it("parseFloors: groups is a map of numbers 0-100 with at most one decimal; the note is optional", () => {
    expect(parseFloors('{"note": "n", "groups": {"draws-bracket": 50.5, "core": 0, "x": 100}}')).toEqual({ "draws-bracket": 50.5, core: 0, x: 100 });
    expect(parseFloors('{"groups": {}}')).toEqual({});
    for (const bad of ["{", "[]", "{}", '{"groups": []}', '{"groups": {"draws-bracket": "50"}}', '{"groups": {"draws-bracket": 101}}', '{"groups": {"draws-bracket": -1}}', '{"groups": {"draws-bracket": 50.55}}', '{"groups": {"draws-bracket": null}}']) {
      expect(() => parseFloors(bad), bad).toThrow();
    }
  });

  it("parseEquivalents: entries are {mutant, reason}, the reason is at least 10 characters, and a duplicate is refused", () => {
    expect(parseEquivalents('{"note": "n", "equivalent": []}')).toEqual([]);
    expect(parseEquivalents(JSON.stringify({ equivalent: [{ mutant: EQ(3), reason: "the guard is dead code on this path" }] }))).toEqual([EQ(3)]);
    for (const bad of ["{", "{}", '{"equivalent": [""]}', '{"equivalent": [{"mutant": "a:1:1 M → x"}]}', '{"equivalent": [{"mutant": "a:1:1 M → x", "reason": "short"}]}',
      JSON.stringify({ equivalent: [{ mutant: EQ(3), reason: "the guard is dead code" }, { mutant: EQ(3), reason: "the guard is dead code" }] })]) {
      expect(() => parseEquivalents(bad), bad).toThrow();
    }
  });
});

describe("the floor never falls: floorDiff, setFloor, missingFloors", () => {
  it("the floor never falls: --check-file-against flags a lowered or removed group", () => {
    expect(floorDiff({ "draws-bracket": 50, competition: 40 }, { "draws-bracket": 49.9, competition: 40 })).toEqual([{ group: "draws-bracket", was: 50, now: 49.9 }]);
    expect(floorDiff({ "draws-bracket": 50 }, {})).toEqual([{ group: "draws-bracket", was: 50, now: null }]);
    expect(floorDiff({}, { "draws-bracket": 50 })).toEqual([]); // a new group may be added
  });

  it("an equal or raised floor is no difference, and every removed or lowered group is listed in the order it was", () => {
    expect(floorDiff({ "draws-bracket": 50, core: 10 }, { "draws-bracket": 50, core: 10.1 })).toEqual([]);
    expect(floorDiff({ a: 5, b: 6, c: 7, d: 8 }, { a: 5, b: 5.9, d: 9 })).toEqual([{ group: "b", was: 6, now: 5.9 }, { group: "c", was: 7, now: null }]);
    expect(floorDiff({}, {})).toEqual([]);
  });

  it("setFloor writes floor(score, 1 dp), never a rounded-up value (2 of 3 killed = 66.6, not 66.7)", () => {
    const r = setFloor("draws-bracket", report({ killed: 2, survived: 1 }), floors({}));
    expect(r).toMatchObject({ exit: 0, floors: { "draws-bracket": 66.6 } });
    // 4 of 7 = 57.142…
    expect(setFloor("core", report({ killed: 4, survived: 3 }, "src/core/clock.ts"), floors({ "draws-bracket": 10 }))).toMatchObject({ exit: 0, floors: { "draws-bracket": 10, core: 57.1 } });
    // an exact score is written as is
    expect(setFloor("draws-bracket", report({ killed: 3, survived: 1 }), floors({}))).toMatchObject({ exit: 0, floors: { "draws-bracket": 75 } });
  });

  it("setFloor refuses lowering, a zero-mutant report, the probe, an unknown group and the wrong report; raising and holding are fine", () => {
    expect(setFloor("draws-bracket", report({ killed: 2, survived: 1 }), floors({ "draws-bracket": 70 })).exit).toBe(2); // 66.6 < 70
    expect(setFloor("draws-bracket", report({ killed: 2, survived: 1 }), floors({ "draws-bracket": 66.6 }))).toMatchObject({ exit: 0, floors: { "draws-bracket": 66.6 } });
    expect(setFloor("draws-bracket", report({ killed: 3, survived: 1 }), floors({ "draws-bracket": 66.6 }))).toMatchObject({ exit: 0, floors: { "draws-bracket": 75 } });
    expect(setFloor("draws-bracket", report({}), floors({})).exit).toBe(2);
    expect(setFloor("probe", report({ killed: 1 }, "src/scheduling/roundrobin.ts"), floors({})).exit).toBe(2);
    expect(setFloor("nosuch", report({ killed: 1 }), floors({})).exit).toBe(2);
    expect(setFloor("draws-bracket", report({ killed: 1 }, "src/core/clock.ts"), floors({})).exit).toBe(2);
  });

  it("setFloor honours the equivalents the same way check does (the floor is set on the score check will compute)", () => {
    const rep = report({ killed: 49, survived: 51 });
    // 49/98 = 50.0 with two equivalents; 49/99 = 49.4 with one; 49/100 = 49.0 with none
    expect(setFloor("draws-bracket", rep, floors({}), [EQ(50), EQ(51)])).toMatchObject({ exit: 0, floors: { "draws-bracket": 50 } });
    expect(setFloor("draws-bracket", rep, floors({}), [EQ(50)])).toMatchObject({ exit: 0, floors: { "draws-bracket": 49.4 } });
    expect(setFloor("draws-bracket", rep, floors({}), [])).toMatchObject({ exit: 0, floors: { "draws-bracket": 49 } });
  });

  it("once any floor exists every non-probe group needs one: a missing entry is a failure, never a skip (review 4, R4-m3)", () => {
    const names = ["competition", "core", "draws-bracket", "probe"];
    expect(missingFloors(names, {})).toEqual([]); // no floors yet: PR-A's state, nothing is missing
    expect(missingFloors(names, { "draws-bracket": 50 })).toEqual(["competition", "core"]); // the probe never has one
    expect(missingFloors(names, { "draws-bracket": 50, core: 10, competition: 5 })).toEqual([]);
  });

  it("the committed floor file satisfies it for every real group, and says what it covers (the real-tree case)", () => {
    const committed = parseFloors(readFileSync(join(ENGINE, "stryker-floor.json"), "utf8"));
    const names = Object.keys(STRYKER_GROUPS);
    expect(names.length).toBeGreaterThan(1);
    expect(missingFloors(names, committed)).toEqual([]);
    // whatever is committed names only real, non-probe groups (a stale or misspelt group name would otherwise never be checked)
    for (const g of Object.keys(committed)) {
      expect(names, g).toContain(g);
      expect(g).not.toBe("probe");
    }
  });
});

describe("survivors: file:line:col mutator → replacement, minus the recorded equivalents", () => {
  const rep: Report = {
    files: {
      "src/scheduling/swiss.ts": { mutants: [
        { mutatorName: "ArithmeticOperator", replacement: "a - b", status: "Survived", location: { start: { line: 9, column: 4 }, end: { line: 9, column: 9 } } },
        { mutatorName: "BlockStatement", replacement: "{}", status: "Killed", location: { start: { line: 2, column: 1 }, end: { line: 4, column: 2 } } },
      ] },
      "src/scheduling/bracket.ts": { mutants: [
        { mutatorName: "StringLiteral", replacement: "\"\"", status: "NoCoverage", location: { start: { line: 30, column: 2 }, end: { line: 30, column: 8 } } },
        { mutatorName: "ConditionalExpression", replacement: "false", status: "Survived", location: { start: { line: 3, column: 7 }, end: { line: 3, column: 12 } } },
        { mutatorName: "ConditionalExpression", replacement: "true", status: "Timeout", location: { start: { line: 3, column: 7 }, end: { line: 3, column: 12 } } },
        { mutatorName: "StringLiteral", replacement: "line one\nline two", status: "Survived", location: { start: { line: 41, column: 1 }, end: { line: 42, column: 9 } } },
      ] },
    },
  };

  it("lists each Survived and NoCoverage mutant, sorted by file, line and column; a killed or timed-out mutant is not listed", () => {
    const md = survivorsMarkdown("draws-bracket", rep, []);
    const listed = md.split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toEqual([
      "src/scheduling/bracket.ts:3:7 ConditionalExpression → false",
      "src/scheduling/bracket.ts:30:2 StringLiteral → \"\"",
      "src/scheduling/bracket.ts:41:1 StringLiteral → line one\\nline two", // a multi-line replacement stays on one line
      "src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b",
    ]);
    expect(md).toContain("# Survivors: draws-bracket");
    expect(md).toContain("4 listed");
  });

  it("an equivalent survivor is left out and counted; the key it is matched by is the listed line, verbatim", () => {
    const md = survivorsMarkdown("draws-bracket", rep, ["src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b"]);
    const listed = md.split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toHaveLength(3);
    expect(listed).not.toContain("src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b");
    expect(md).toContain("3 listed");
    expect(md).toContain("1 equivalent");
  });

  it("no survivors says so, and a report with nothing valid is still renderable (it is the CLI's check that refuses it)", () => {
    expect(survivorsMarkdown("draws-bracket", report({ killed: 3 }), [])).toContain("No survivors");
    expect(survivorsMarkdown("draws-bracket", { files: {} }, [])).toContain("No survivors");
  });
});

// ---- the CLI, spawned --------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "stryker-floor-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;
const fresh = (): string => { const d = join(scratch, String(++seq)); mkdirSync(d, { recursive: true }); return d; };

// Git must not see the parent's repository (a hook sets GIT_DIR) or its identity.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], { cwd, encoding: "utf8", timeout: SPAWN_MS, env: cleanEnv() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", root, "-c", "user.email=floor@example.invalid", "-c", "user.name=Floor", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const FLOOR_PATH = "packages/engine/stryker-floor.json";
const floorFile = (g: Record<string, number>, note = "test") => `${JSON.stringify({ note, groups: g }, null, 2)}\n`;

/** A repo whose commit has the engine's floor file with `atRef` content (null: the file is absent at that commit), and whose
 *  working tree then holds `working` (null: the file is deleted). Runs `--check-file-against <ref>` from packages/engine. */
function againstRef(o: { atRef: string | null; working: string | null; ref?: string; decoyRoot?: string }) {
  const root = fresh();
  mkdirSync(join(root, "packages/engine"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  if (o.decoyRoot !== undefined) writeFileSync(join(root, "stryker-floor.json"), o.decoyRoot);
  if (o.atRef !== null) writeFileSync(join(root, FLOOR_PATH), o.atRef);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ref");
  if (o.working === null) rmSync(join(root, FLOOR_PATH), { force: true });
  else writeFileSync(join(root, FLOOR_PATH), o.working);
  return { root, ...run(join(root, "packages/engine"), ["--check-file-against", o.ref ?? "HEAD"]) };
}

/** A test that spawns `n` CLIs, and builds `n` scratch repos for it (each repo: git init, add, commit, counted as one more spawn). */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

describe("--check-file-against: the empty cases, driven through git (review 7, R7-I1)", () => {
  spawnIt(4)("the file ABSENT at the ref means no floors yet: exit 0 and it says so, whatever the working file holds (PR-A's own first run)", () => {
    for (const working of [floorFile({}), floorFile({ "draws-bracket": 50, core: 40 })]) {
      const r = againstRef({ atRef: null, working });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      expect(r.stdout).toContain("no floors at HEAD: nothing to compare");
    }
  });

  spawnIt(2)("PR-A's own first run, as CI shapes it: the base commit lacks the file, the PR commit adds it, HEAD^1 is the base", () => {
    const root = fresh();
    mkdirSync(join(root, "packages/engine"), { recursive: true });
    writeFileSync(join(root, "README.md"), "x\n");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main");
    writeFileSync(join(root, FLOOR_PATH), floorFile({}));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "PR-A");
    const r = run(join(root, "packages/engine"), ["--check-file-against", "HEAD^1"]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain("no floors at HEAD^1: nothing to compare");
  });

  spawnIt(2)("present at the ref and LOWER in the working file: exit 1, naming the group, and it counted what it compared (a CLI that exits 0 without reading fails here)", () => {
    const r = againstRef({ atRef: floorFile({ "draws-bracket": 50, core: 40 }), working: floorFile({ "draws-bracket": 49.9, core: 40 }) });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("compared 2 group(s) against HEAD: 1 lowered or removed");
    expect(r.stdout).toContain("draws-bracket: 50 -> 49.9");
    expect(r.stdout).not.toContain("core:");
  });

  spawnIt(4)("equal or higher: exit 0, and the count is printed", () => {
    const equal = againstRef({ atRef: floorFile({ "draws-bracket": 50, core: 40 }), working: floorFile({ "draws-bracket": 50, core: 40 }) });
    expect({ status: equal.status, stderr: equal.stderr }).toEqual({ status: 0, stderr: "" });
    expect(equal.stdout).toContain("compared 2 group(s) against HEAD: 0 lowered or removed");
    const higher = againstRef({ atRef: floorFile({ "draws-bracket": 50, core: 40 }), working: floorFile({ "draws-bracket": 55, core: 40.1, competition: 5 }) });
    expect(higher.status).toBe(0);
    expect(higher.stdout).toContain("compared 2 group(s) against HEAD: 0 lowered or removed");
  });

  spawnIt(6)("a group REMOVED from the working file is exit 1 (an empty groups map included); a group ADDED is fine", () => {
    const removed = againstRef({ atRef: floorFile({ "draws-bracket": 50, core: 40 }), working: floorFile({ "draws-bracket": 50 }) });
    expect(removed.status).toBe(1);
    expect(removed.stdout).toContain("core: 40 -> (removed)");
    expect(removed.stdout).toContain("compared 2 group(s) against HEAD: 1 lowered or removed");
    const emptied = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: floorFile({}) });
    expect(emptied.status).toBe(1);
    expect(emptied.stdout).toContain("compared 1 group(s)");
    const added = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: floorFile({ "draws-bracket": 50, core: 40 }) });
    expect(added.status).toBe(0);
  });

  spawnIt(2)("the file present at the ref with no floors in it compares nothing and passes, and says that", () => {
    const r = againstRef({ atRef: floorFile({}), working: floorFile({ "draws-bracket": 50 }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("compared 0 group(s) against HEAD: 0 lowered or removed");
  });

  spawnIt(4)("the working file deleted while the ref has it: exit 2; deleted while the ref lacks it: exit 2 too (after PR-B a deleted file must never read as no floors)", () => {
    const had = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: null });
    expect(had.status).toBe(2);
    expect(had.stderr).toContain("stryker-floor.json");
    const lacked = againstRef({ atRef: null, working: null });
    expect(lacked.status).toBe(2);
    expect(lacked.stdout).not.toContain("no floors");
  });

  spawnIt(6)("a nonexistent ref, a ref that is not a commit, and HEAD^1 of a root commit: each exit 2", () => {
    for (const ref of ["no-such-ref", "HEAD:packages", "HEAD^1"]) {
      const r = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: floorFile({ "draws-bracket": 50 }), ref });
      expect({ ref, status: r.status }).toEqual({ ref, status: 2 });
      expect(r.stdout, ref).not.toContain("no floors");
      expect(r.stdout, ref).not.toContain("compared");
    }
  });

  spawnIt(2)("a ref that looks like an option is refused as a ref, before git sees it (--check-file-against=-x reaches the CLI as the value -x)", () => {
    const base = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: floorFile({ "draws-bracket": 50 }) });
    for (const arg of ["--check-file-against=-x", "--check-file-against=--output=/tmp/x", "--check-file-against="]) {
      const r = run(join(base.root, "packages/engine"), [arg]);
      expect({ arg, status: r.status }).toEqual({ arg, status: 2 });
      expect(r.stderr, arg).toContain("is not a ref");
      expect(r.stdout, arg).toBe("");
    }
  });

  spawnIt(10)("malformed JSON at the ref, or in the working file, or a wrong shape: exit 2", () => {
    expect(againstRef({ atRef: "{ not json", working: floorFile({ "draws-bracket": 50 }) }).status).toBe(2);
    expect(againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: "{ not json" }).status).toBe(2);
    expect(againstRef({ atRef: null, working: "{ not json" }).status).toBe(2); // absent at the ref does not excuse a broken working file
    expect(againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: '{"groups": []}' }).status).toBe(2);
    expect(againstRef({ atRef: '{"groups": {"draws-bracket": "fifty"}}', working: floorFile({ "draws-bracket": 50 }) }).status).toBe(2);
  });

  spawnIt(2)("the file is found relative to the CLI's cwd, not the repo root: a decoy at the root with other floors changes nothing", () => {
    // reading the root's decoy ({draws-bracket: 99}) against the working {draws-bracket: 50} would be exit 1
    const r = againstRef({ atRef: floorFile({ "draws-bracket": 50 }), working: floorFile({ "draws-bracket": 50 }), decoyRoot: floorFile({ "draws-bracket": 99 }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("compared 1 group(s)");
  });
});

describe("the CLI's other modes and its refusals", () => {
  /** A working directory holding the floor file, optional equivalents, and a mutation report. */
  function workdir(o: { floors?: Record<string, number>; equivalents?: unknown[]; report?: Report | string; reportName?: string }) {
    const cwd = fresh();
    if (o.floors !== undefined) writeFileSync(join(cwd, "stryker-floor.json"), floorFile(o.floors));
    if (o.equivalents !== undefined) writeFileSync(join(cwd, "stryker-equivalent.json"), JSON.stringify({ note: "n", equivalent: o.equivalents }));
    const reportPath = join(cwd, o.reportName ?? "mutation.json");
    if (o.report !== undefined) writeFileSync(reportPath, typeof o.report === "string" ? o.report : JSON.stringify(o.report));
    return { cwd, reportPath };
  }

  spawnIt(2)("--check: at or above the floor is exit 0 and prints the score; below is exit 1 and lists the survivors", () => {
    const pass = workdir({ floors: { "draws-bracket": 50 }, report: report({ killed: 50, survived: 50 }) });
    const p = run(pass.cwd, ["--check", "draws-bracket", pass.reportPath]);
    expect({ status: p.status, stderr: p.stderr }).toEqual({ status: 0, stderr: "" });
    expect(p.stdout).toContain("draws-bracket: score 50.0%");
    const fail = workdir({ floors: { "draws-bracket": 50 }, report: report({ killed: 49, survived: 51 }) });
    const f = run(fail.cwd, ["--check", "draws-bracket", fail.reportPath]);
    expect(f.status).toBe(1);
    expect(f.stdout).toContain("draws-bracket: score 49.0%");
    expect(f.stdout).toContain("src/scheduling/bracket.ts:50:1 ConditionalExpression → true");
    expect(f.stdout.split("\n").filter((l) => l.startsWith("src/scheduling/"))).toHaveLength(51);
  });

  spawnIt(2)("--check reads stryker-equivalent.json from the cwd: two recorded equivalents turn 49/99 into a pass", () => {
    const eq = [EQ(50), EQ(51)].map((mutant) => ({ mutant, reason: "dead branch: the guard above already returned" }));
    const w = workdir({ floors: { "draws-bracket": 50 }, equivalents: eq, report: report({ killed: 49, survived: 50 }) });
    expect(run(w.cwd, ["--check", "draws-bracket", w.reportPath]).status).toBe(0);
    const none = workdir({ floors: { "draws-bracket": 50 }, equivalents: [], report: report({ killed: 49, survived: 50 }) });
    expect(run(none.cwd, ["--check", "draws-bracket", none.reportPath]).status).toBe(1);
  });

  spawnIt(10)("--check refuses (exit 2): zero mutants, no floor for the group, an unreadable or malformed report or floor file, an unknown group, the probe", () => {
    const zero = workdir({ floors: { "draws-bracket": 50 }, report: report({}) });
    const z = run(zero.cwd, ["--check", "draws-bracket", zero.reportPath]);
    expect(z.status).toBe(2);
    expect(z.stderr).toContain("zero mutants");
    const nofloor = workdir({ floors: { competition: 50 }, report: report({ killed: 5 }) });
    expect(run(nofloor.cwd, ["--check", "draws-bracket", nofloor.reportPath]).status).toBe(2);
    const missingReport = workdir({ floors: { "draws-bracket": 50 } });
    expect(run(missingReport.cwd, ["--check", "draws-bracket", missingReport.reportPath]).status).toBe(2);
    const badReport = workdir({ floors: { "draws-bracket": 50 }, report: "{ nope" });
    expect(run(badReport.cwd, ["--check", "draws-bracket", badReport.reportPath]).status).toBe(2);
    const noFloorFile = workdir({ report: report({ killed: 5 }) });
    expect(run(noFloorFile.cwd, ["--check", "draws-bracket", noFloorFile.reportPath]).status).toBe(2);
    const badEq = workdir({ floors: { "draws-bracket": 50 }, equivalents: [{ mutant: EQ(1) }], report: report({ killed: 5 }) });
    expect(run(badEq.cwd, ["--check", "draws-bracket", badEq.reportPath]).status).toBe(2);
    const ok = workdir({ floors: { "draws-bracket": 50, probe: 10 }, report: report({ killed: 5 }) });
    const unknown = run(ok.cwd, ["--check", "nosuch", ok.reportPath]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown group "nosuch"');   // not the wrong-report refusal it would fall through to
    const probe = run(ok.cwd, ["--check", "probe", ok.reportPath]);
    expect(probe.status).toBe(2);
    expect(probe.stderr).toContain("the probe has no floor");
    expect(run(ok.cwd, ["--check", "draws-bracket"]).status).toBe(2); // the report path is required
  });

  spawnIt(3)("--check --skip-if-no-floors: PR-A's state (no floor anywhere) prints `no floor yet: PR-B sets it` and passes, but once ANY floor exists a group without one is exit 2", () => {
    const pra = workdir({ floors: {}, report: report({ killed: 3, survived: 1 }) });
    const a = run(pra.cwd, ["--check", "draws-bracket", pra.reportPath, "--skip-if-no-floors"]);
    expect({ status: a.status, stderr: a.stderr }).toEqual({ status: 0, stderr: "" });
    expect(a.stdout).toContain("no floor yet: PR-B sets it");
    expect(a.stdout).toContain("75.0%"); // the log still says what the group scored
    const prb = workdir({ floors: { competition: 40 }, report: report({ killed: 3, survived: 1 }) });
    const b = run(prb.cwd, ["--check", "draws-bracket", prb.reportPath, "--skip-if-no-floors"]);
    expect(b.status).toBe(2);
    expect(b.stdout).not.toContain("no floor yet");
    // and a floor that exists is still judged: the flag skips only an EMPTY floor file
    const judged = workdir({ floors: { "draws-bracket": 90 }, report: report({ killed: 3, survived: 1 }) });
    expect(run(judged.cwd, ["--check", "draws-bracket", judged.reportPath, "--skip-if-no-floors"]).status).toBe(1);
  });

  spawnIt(4)("--skip-if-no-floors does not excuse a report that proves nothing: zero mutants, an unreadable report or the wrong group's files are still exit 2", () => {
    const zero = workdir({ floors: {}, report: report({}) });
    expect(run(zero.cwd, ["--check", "draws-bracket", zero.reportPath, "--skip-if-no-floors"]).status).toBe(2);
    const missing = workdir({ floors: {} });
    expect(run(missing.cwd, ["--check", "draws-bracket", missing.reportPath, "--skip-if-no-floors"]).status).toBe(2);
    const wrong = workdir({ floors: {}, report: report({ killed: 5 }, "src/core/clock.ts") });
    expect(run(wrong.cwd, ["--check", "draws-bracket", wrong.reportPath, "--skip-if-no-floors"]).status).toBe(2);
    const noFile = workdir({ report: report({ killed: 5 }) });
    expect(run(noFile.cwd, ["--check", "draws-bracket", noFile.reportPath, "--skip-if-no-floors"]).status).toBe(2); // a deleted floor file is not "no floors yet"
  });

  spawnIt(4)("--set-floor writes floor(score, 1 dp) into the file, keeps the note and the other groups, and refuses lowering without touching the file", () => {
    const w = workdir({ floors: { core: 12.5 }, report: report({ killed: 2, survived: 1 }) });
    const r = run(w.cwd, ["--set-floor", "draws-bracket", w.reportPath]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const written = JSON.parse(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")) as { note: string; groups: Record<string, number> };
    expect(written).toEqual({ note: "test", groups: { core: 12.5, "draws-bracket": 66.6 } });
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8").endsWith("\n")).toBe(true);
    // lowering: a worse report against the 66.6 just written
    const before = readFileSync(join(w.cwd, "stryker-floor.json"), "utf8");
    writeFileSync(w.reportPath, JSON.stringify(report({ killed: 1, survived: 1 })));
    const lower = run(w.cwd, ["--set-floor", "draws-bracket", w.reportPath]);
    expect(lower.status).toBe(2);
    expect(lower.stderr).toContain("lower");
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")).toBe(before);
    // the probe and zero mutants never get a floor
    const probe = workdir({ floors: {}, report: report({ killed: 1 }, "src/scheduling/roundrobin.ts") });
    expect(run(probe.cwd, ["--set-floor", "probe", probe.reportPath]).status).toBe(2);
    const zero = workdir({ floors: {}, report: report({}) });
    expect(run(zero.cwd, ["--set-floor", "draws-bracket", zero.reportPath]).status).toBe(2);
    expect(existsSync(join(zero.cwd, "stryker-floor.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(zero.cwd, "stryker-floor.json"), "utf8")).groups).toEqual({});
  });

  spawnIt(4)("--survivors writes SURVIVORS.md at --out and says how many it listed; the report path and --out are required", () => {
    const w = workdir({ floors: {}, equivalents: [{ mutant: EQ(50), reason: "dead branch: the guard above already returned" }], report: report({ killed: 3, survived: 2, noCoverage: 1 }) });
    const out = join(w.cwd, "SURVIVORS.md");
    const r = run(w.cwd, ["--survivors", "draws-bracket", w.reportPath, "--out", out]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const md = readFileSync(out, "utf8");
    // killed lines 1-3, survived 4-5, noCoverage 6; the equivalent is line 50, which this report does not have, so nothing is forgiven
    expect(md.split("\n").filter((l) => /^src\//.test(l))).toEqual([
      "src/scheduling/bracket.ts:4:1 ConditionalExpression → true",
      "src/scheduling/bracket.ts:5:1 ConditionalExpression → true",
      "src/scheduling/bracket.ts:6:1 ConditionalExpression → true",
    ]);
    expect(r.stdout).toContain("3 listed");
    expect(run(w.cwd, ["--survivors", "draws-bracket", w.reportPath]).status).toBe(2);
    expect(run(w.cwd, ["--survivors", "draws-bracket", "--out", out]).status).toBe(2);
    const missing = run(w.cwd, ["--survivors", "draws-bracket", join(w.cwd, "nope.json"), "--out", join(w.cwd, "S2.md")]);
    expect(missing.status).toBe(2);
    expect(existsSync(join(w.cwd, "S2.md"))).toBe(false);
  });

  spawnIt(1)("--survivors honours stryker-equivalent.json: the recorded equivalent is not listed", () => {
    const w = workdir({ floors: {}, equivalents: [{ mutant: EQ(4), reason: "dead branch: the guard above already returned" }], report: report({ killed: 3, survived: 2 }) });
    const out = join(w.cwd, "SURVIVORS.md");
    expect(run(w.cwd, ["--survivors", "draws-bracket", w.reportPath, "--out", out]).status).toBe(0);
    const listed = readFileSync(out, "utf8").split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toEqual(["src/scheduling/bracket.ts:5:1 ConditionalExpression → true"]);
  });

  spawnIt(3)("--survivors refuses an unknown group and another group's report, and writes nothing", () => {
    const w = workdir({ floors: {}, report: report({ killed: 3, survived: 2 }) });
    const unknown = run(w.cwd, ["--survivors", "nosuch", w.reportPath, "--out", join(w.cwd, "U.md")]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown group "nosuch"');
    expect(existsSync(join(w.cwd, "U.md"))).toBe(false);
    // draws-bracket' report (src/scheduling/bracket.ts) is not core's
    const wrong = run(w.cwd, ["--survivors", "core", w.reportPath, "--out", join(w.cwd, "W.md")]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain("is not group \"core\"'s");
    expect(existsSync(join(w.cwd, "W.md"))).toBe(false);
    // and the right group's own report is still written (the pair: these are not refusals of everything)
    expect(run(w.cwd, ["--survivors", "draws-bracket", w.reportPath, "--out", join(w.cwd, "R.md")]).status).toBe(0);
    expect(existsSync(join(w.cwd, "R.md"))).toBe(true);
  });

  spawnIt(5)("--out belongs to --survivors and --skip-if-no-floors to --check: each given to another mode is exit 2, and the mode does not run", () => {
    const w = workdir({ floors: { "draws-bracket": 50 }, report: report({ killed: 50, survived: 50 }) });
    const before = readFileSync(join(w.cwd, "stryker-floor.json"), "utf8");
    const out = run(w.cwd, ["--check", "draws-bracket", w.reportPath, "--out", join(w.cwd, "X.md")]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--out belongs to --survivors");
    expect(out.stdout).toBe("");
    const skipSet = run(w.cwd, ["--set-floor", "draws-bracket", w.reportPath, "--skip-if-no-floors"]);
    expect(skipSet.status).toBe(2);
    expect(skipSet.stderr).toContain("--skip-if-no-floors belongs to --check");
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")).toBe(before);
    const skipSurvivors = run(w.cwd, ["--survivors", "draws-bracket", w.reportPath, "--out", join(w.cwd, "S.md"), "--skip-if-no-floors"]);
    expect(skipSurvivors.status).toBe(2);
    expect(existsSync(join(w.cwd, "S.md"))).toBe(false);
    // the pair: each flag with its own mode is accepted
    expect(run(w.cwd, ["--check", "draws-bracket", w.reportPath, "--skip-if-no-floors"]).status).toBe(0);
    expect(run(w.cwd, ["--survivors", "draws-bracket", w.reportPath, "--out", join(w.cwd, "S.md")]).status).toBe(0);
  });

  spawnIt(7)("usage: no mode, two modes, an unknown mode or flag, and a missing ref are each exit 2 with a usage line on stderr and nothing on stdout", () => {
    const cwd = fresh();
    for (const args of [[], ["--check"], ["--check", "draws-bracket", "a.json", "--survivors"], ["--frobnicate"], ["--check-file-against"], ["--set-floor"], ["--check", "draws-bracket", "a.json", "--nosuch"]]) {
      const r = run(cwd, args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stderr, args.join(" ")).toContain("usage:");
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });
});

describe("the real engine floor files", () => {
  it("stryker-floor.json and stryker-equivalent.json are present, parse, and say what the score counts", () => {
    const f = JSON.parse(readFileSync(join(ENGINE, "stryker-floor.json"), "utf8")) as { note: string; groups: Record<string, number> };
    expect(typeof f.groups).toBe("object");
    // the note names the scoring rule (Stryker's TOTAL score: an uncovered line is a survivor) and that the floor only rises
    expect(f.note).toMatch(/NoCoverage/);
    expect(f.note).toMatch(/never (falls|lower)/i);
    expect(parseFloors(JSON.stringify(f))).toEqual(f.groups);
    const e = readFileSync(join(ENGINE, "stryker-equivalent.json"), "utf8");
    expect(JSON.parse(e)).toHaveProperty("note");
    expect(parseEquivalents(e)).toEqual([]);
  });
});
