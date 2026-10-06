// W1d Task 15 (D14; rulings 66, 67; T15-CUT): the Stryker floor. scripts/stryker-floor.ts judges a FAMILY's legs' mutation
// reports against stryker-floor.json (a floor that only rises, kept per family and never per leg, so a re-split of a file
// cannot remove a key), lists survivors, and refuses to read an empty report as a pass. The pure functions are tested directly;
// the CLI, and above all `--check-file-against`'s empty cases, are tested by SPAWNING it in a throwaway git repo (a function
// test cannot see the git plumbing that PR-A's own first run depends on).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_FAMILIES, STRYKER_GROUPS, STRYKER_SPLITS } from "../stryker.groups.mjs";
import { parseEntry, selected } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { check, floorDiff, mergeReports, missingFloors, parseEquivalents, parseFloors, parseReport, setFloor, survivorsMarkdown, type LegReports, type Report } from "../scripts/stryker-floor.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ENGINE, "scripts/stryker-floor.ts");

// ---- fixtures: a mutation-testing-elements report (the schema Stryker 10 writes: files[path].mutants[].status) ------------

interface Counts { killed?: number; survived?: number; timeout?: number; noCoverage?: number; ignored?: number; compileError?: number; runtimeError?: number }
const STATUS_OF: Record<keyof Counts, string> = { killed: "Killed", survived: "Survived", timeout: "Timeout", noCoverage: "NoCoverage", ignored: "Ignored", compileError: "CompileError", runtimeError: "RuntimeError" };

/** The family most verdict tests use: `core`. It is more than one leg since the hosted sizing (T20-PRE: 1,002 mutants, more than a
 *  leg may hold at the measured cost of one mutant), so a report set for it is one report per leg. `one(c)` gives EVERY leg the same counts `c`, each at a
 *  whole file of its own: the family's score is then the ratio `c` alone, and every COUNT is `CORE_LEGS.length` times larger. */
const CORE_LEGS = STRYKER_FAMILIES.core;
/** A whole file each core leg selects, for fixtures only (guarded by the first test below). */
const CORE_FILES: Record<string, string> = { "core-1": "src/core/clock.ts", "core-2": "src/core/errors.ts", "core-3": "src/core/rng.ts" };
const CORE_FILE = "src/core/clock.ts";
const N = CORE_LEGS.length;
const fileOf = (leg: string): string => CORE_FILES[leg] ?? "";

/** A report with `n` mutants of each status in ONE file; mutant i sits at line `firstLine + i`, column 1, in the order
 *  killed, survived, timeout, noCoverage, ignored, compileError, runtimeError. */
function report(c: Counts, file = CORE_FILE, firstLine = 1): Report {
  const mutants: Report["files"][string]["mutants"] = [];
  let line = firstLine;
  for (const k of Object.keys(STATUS_OF) as (keyof Counts)[]) {
    for (let i = 0; i < (c[k] ?? 0); i++) {
      mutants.push({ id: String(line), mutatorName: "ConditionalExpression", replacement: "true", status: STATUS_OF[k], location: { start: { line, column: 1 }, end: { line, column: 9 } } });
      line++;
    }
  }
  return { files: { [file]: { mutants } } };
}
/** The reports of the family `core`: every leg with the same counts, at its own file (or all at `file`, for the wrong-report tests). */
const one = (c: Counts, file?: string): LegReports => Object.fromEntries(CORE_LEGS.map((leg) => [leg, report(c, file ?? fileOf(leg))]));
const floors = (g: Record<string, number>) => g;
// Equivalent mutants are identified by `file:line:col mutator → replacement` (written here as literals, never produced by the code under test).
const EQ = (line: number) => `${CORE_FILE}:${line}:1 ConditionalExpression → true`;
/** The same equivalent in every core leg's file: a replicated report needs the equivalent replicated for the arithmetic to hold. */
const EQS = (line: number, mutator = "ConditionalExpression", replacement = "true", column = 1): string[] => CORE_LEGS.map((leg) => `${fileOf(leg)}:${line}:${column} ${mutator} → ${replacement}`);

/** A file and a line each leg of a family selects, for FIXTURES only (a valid report needs a mutant in the leg's own files and
 *  line ranges): the first file the leg's resolved `mutate` list selects, and the first line of its first range. Every verdict
 *  expected below is typed from the rulebook, never read from here. */
function placeOf(leg: string): { file: string; line: number } {
  const [file, sel] = [...selected(ENGINE, resolveGroup(leg))][0]!;
  return { file, line: sel === "all" ? 1 : sel[0]![0] };
}
/** A valid report set for `family`: every leg gets its own counts (default one Killed mutant) at its own place. */
function legSet(family: string, per: Record<string, Counts> = {}): LegReports {
  const out: LegReports = {};
  for (const leg of STRYKER_FAMILIES[family as keyof typeof STRYKER_FAMILIES]) {
    const { file, line } = placeOf(leg);
    out[leg] = report(per[leg] ?? { killed: 1 }, file, line);
  }
  return out;
}

describe("the fixtures' premise: core is several legs, and each holds the whole file the fixtures put in it", () => {
  it("core has more than one leg and the fixture file of each is selected WHOLE by that leg (else `one()` would test a refusal, not a verdict)", () => {
    expect(N, "legs of core").toBeGreaterThan(1);
    expect(Object.keys(CORE_FILES)).toEqual([...CORE_LEGS]);
    let checked = 0;
    for (const leg of CORE_LEGS) {
      expect(selected(ENGINE, resolveGroup(leg)).get(fileOf(leg)), `${leg} selects ${fileOf(leg)} whole`).toBe("all");
      checked++;
    }
    expect(checked).toBe(N);
  });
});

describe("check: the verdict (zero mutants is a refusal, never a pass)", () => {
  it("zero mutants is a refusal (vacuous), never a pass", () => {
    expect(check("core", one({ killed: 0, survived: 0 }), floors({ core: 50 }))).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("a report of nothing but ignored and error mutants has zero VALID mutants: refused too, whatever the floor", () => {
    const r = check("core", one({ ignored: 5, compileError: 3, runtimeError: 2 }), floors({ core: 0 }));
    expect(r).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("a report with no files at all is zero mutants (the empty case first)", () => {
    const hollow = Object.fromEntries(CORE_LEGS.map((leg) => [leg, { files: {} }]));
    expect(check("core", hollow, floors({ core: 0 }))).toEqual({ exit: 2, why: expect.stringContaining("zero mutants") });
  });

  it("no reports at all is refused too: a family judged on none of its legs is not a pass", () => {
    const r = check("core", {}, floors({ core: 0 }));
    expect(r).toEqual({ exit: 2, why: expect.stringContaining("missing core") });
  });

  it("a score below the floor fails and lists survivors; at the floor passes", () => {
    const below = check("core", one({ killed: 49, survived: 51 }), floors({ core: 50 }));
    expect(below.exit).toBe(1);
    if (below.exit !== 1) throw new Error("unreachable");
    expect(below.survivors).toHaveLength(51 * N);
    expect(below.survivors[0]).toBe(`${CORE_FILE}:50:1 ConditionalExpression → true`);
    expect(check("core", one({ killed: 50, survived: 50 }), floors({ core: 50 })).exit).toBe(0);
    expect(check("core", one({ killed: 51, survived: 49 }), floors({ core: 50 })).exit).toBe(0);
  });

  it("the score is exact: 66.6% against a 66.7 floor fails, however the float rounds (2 of 3 killed)", () => {
    // 2/3 = 66.666…%: floor(…, 1 dp) = 66.6, so a 66.7 floor is unmet and a 66.6 floor is met
    expect(check("core", one({ killed: 2, survived: 1 }), floors({ core: 66.7 })).exit).toBe(1);
    expect(check("core", one({ killed: 2, survived: 1 }), floors({ core: 66.6 })).exit).toBe(0);
    // 7340 of 10000 is exactly 73.4: a float quotient can read 73.39999…, which must not fail a 73.4 floor
    expect(check("core", one({ killed: 7340, survived: 2660 }), floors({ core: 73.4 })).exit).toBe(0);
  });

  it("Timeout counts as detected, NoCoverage as undetected (an uncovered line is a survivor), and Ignored / CompileError / RuntimeError are not in the denominator", () => {
    // detected = 30 killed + 20 timeout = 50; undetected = 25 survived + 25 noCoverage = 50 → 50.0%
    expect(check("core", one({ killed: 30, timeout: 20, survived: 25, noCoverage: 25 }), floors({ core: 50 })).exit).toBe(0);
    expect(check("core", one({ killed: 30, timeout: 20, survived: 25, noCoverage: 26 }), floors({ core: 50 })).exit).toBe(1); // 50/101
    // NoCoverage alone drags the score: 50 killed, 0 survived, 1 noCoverage = 50/51 = 98.0%, below a 99 floor
    expect(check("core", one({ killed: 50, noCoverage: 1 }), floors({ core: 99 })).exit).toBe(1);
    expect(check("core", one({ killed: 50 }), floors({ core: 99 })).exit).toBe(0);
    // 49 killed, 51 survived is 49%; a thousand ignored / compile / runtime mutants change nothing
    expect(check("core", one({ killed: 49, survived: 51, ignored: 400, compileError: 300, runtimeError: 300 }), floors({ core: 50 })).exit).toBe(1);
    expect(check("core", one({ killed: 50, survived: 50, ignored: 400, compileError: 300, runtimeError: 300 }), floors({ core: 50 })).exit).toBe(0);
  });

  it("an equivalent mutant listed by file:line:col and mutator is excluded from the denominator", () => {
    // in each leg, 49 killed (lines 1-49), 51 survived (lines 50-100): 49/100 = 49.0 → exit 1. One equivalent listed (in every leg)
    // → 49/99 = 49.4 → still < 50 → exit 1; two equivalents listed → 49/98 = 50.0 → exit 0
    const rep = one({ killed: 49, survived: 51 });
    expect(check("core", rep, floors({ core: 50 }), []).exit).toBe(1);
    expect(check("core", rep, floors({ core: 50 }), EQS(50)).exit).toBe(1);
    const two = check("core", rep, floors({ core: 50 }), [...EQS(50), ...EQS(51)]);
    expect(two.exit).toBe(0);
    if (two.exit !== 0) throw new Error("unreachable");
    expect(two.survivors).toHaveLength(49 * N); // the two equivalents are not survivors either
    expect(two.survivors).not.toContain(EQ(50));
    expect(two.survivors).toContain(EQ(52));
  });

  it("an equivalent entry only forgives a SURVIVOR at that exact location: not a killed mutant, not another mutator, not another replacement", () => {
    const rep = one({ killed: 49, survived: 51 });
    // lines 1 and 2 are Killed: listing them changes nothing (49/100 = 49.0%)
    expect(check("core", rep, floors({ core: 50 }), [...EQS(1), ...EQS(2)]).exit).toBe(1);
    // a different mutator or replacement or column or file at a survivor's location is a different mutant: with line 51 alone it is 49/99 = 49.4 → 1
    // (each wrong entry is written for every leg's file, so a check that matched it anyway would forgive one survivor per leg and pass)
    const wrongs: [string, string[]][] = [
      ["another mutator", EQS(50, "EqualityOperator")],
      ["another replacement", EQS(50, "ConditionalExpression", "false")],
      ["another column", EQS(50, "ConditionalExpression", "true", 2)],
      ["a file no report has", ["src/core/events.ts:50:1 ConditionalExpression → true"]],
    ];
    for (const [why, wrong] of wrongs) {
      expect(check("core", rep, floors({ core: 50 }), [...wrong, ...EQS(51)]).exit, why).toBe(1);
    }
    // the same two, spelt right, do pass (the loop above would be vacuous if nothing could ever forgive)
    expect(check("core", rep, floors({ core: 50 }), [...EQS(50), ...EQS(51)]).exit).toBe(0);
  });

  it("no floor for a family is a refusal until PR-B sets one", () => {
    expect(check("core", one({ killed: 1, survived: 0 }), floors({})).exit).toBe(2);
    expect(check("core", one({ killed: 1, survived: 0 }), floors({ competition: 10 })).exit).toBe(2);
  });

  it("the probe has no floor to check against: --check probe is a refusal even when floors exist", () => {
    const r = check("probe", { probe: report({ killed: 1 }, "src/scheduling/roundrobin.ts") }, floors({ probe: 10 }));
    expect(r.exit).toBe(2);
    expect(r.why).toContain("the probe has no floor");
  });

  it("a report that mutated files outside the leg is the wrong report: refused, never judged against this family's floor", () => {
    const wrong = one({ killed: 100 }, "src/competition/standings.ts");
    const r = check("core", wrong, floors({ core: 50 }));
    expect(r.exit).toBe(2);
    expect(r.why).toContain("src/competition/standings.ts");
    // the same file is fine for the leg that owns it (the family `competition` has several legs: each gets a report of its own files)
    const owner = STRYKER_FAMILIES.competition.find((leg) => selected(ENGINE, resolveGroup(leg)).get("src/competition/standings.ts") === "all");
    expect(owner, "a competition leg selects standings.ts whole").toBeDefined();
    const own = { ...legSet("competition"), [owner as string]: report({ killed: 100 }, "src/competition/standings.ts") };
    expect(check("competition", own, floors({ competition: 50 })).exit).toBe(0);
  });

  it("an unknown family is a refusal, and a LEG is not a family: floors are kept per family, so a re-split can never remove one", () => {
    const unknown = check("nosuch", one({ killed: 1 }), floors({ nosuch: 1 }));
    expect(unknown.exit).toBe(2);
    expect(unknown.why).toContain('unknown family "nosuch"');
    // a leg of a split file is named for its family and a suffix; judging or setting a floor by that name is refused, saying why
    for (const leg of ["sports-cricket-1", "draws-1", "competition-1", "sports-other-1"]) {
      const r = check(leg, { [leg]: report({ killed: 1 }, placeOf(leg).file, placeOf(leg).line) }, floors({ [leg]: 1 }));
      expect(r.exit, leg).toBe(2);
      expect(r.why, leg).toMatch(/unknown family .* is a leg of "[\w-]+": floors are kept per family, never per leg/);
      expect(setFloor(leg, { [leg]: report({ killed: 1 }, placeOf(leg).file, placeOf(leg).line) }, floors({})).exit, `setFloor ${leg}`).toBe(2);
    }
  });
});

describe("a family is the SUM of its legs: one score over all their mutants, judged on every leg", () => {
  // draws has several legs. The first scores 90.0% over 100 mutants, the second 10.0% over 10, and every other one 50.0% over 2.
  // The family holds (91 + extra) of (110 + 2 x extra) detected, `extra` the legs past the second. The mean of the legs' scores
  // is 50.0% for every `extra` and the weakest leg is 10.0%, so a floor of 80 (the family scores 81 to 82) separates the sum from
  // both of the ways a per-leg floor could be read.
  const DRAWS = STRYKER_FAMILIES.draws;
  const A: Counts = { killed: 90, survived: 10 };
  const B: Counts = { killed: 1, survived: 9 };
  const E: Counts = { killed: 1, survived: 1 };
  const extra = DRAWS.length - 2;
  const detected = 91 + extra;
  const total = 110 + 2 * extra;
  /** Floor to one decimal, as scripts/stryker-floor.ts writes a score, in plain arithmetic. */
  const SCORE = Math.floor((detected / total) * 1000) / 10;
  const per = (): Record<string, Counts> => Object.fromEntries(DRAWS.map((leg, i) => [leg, i === 0 ? A : i === 1 ? B : E]));
  const sets = () => legSet("draws", per());

  it("the family's score counts all its legs' mutants together, not the mean of the legs' scores (50.0) and not the weakest leg (10.0)", () => {
    expect(DRAWS.length, "draws has more than two legs, so the fixture's two named legs are not the whole family").toBeGreaterThan(2);
    expect(SCORE, "the floor of 80 below is between the mean (50.0) and the sum").toBeGreaterThan(80);
    const reports = sets();
    expect(Object.keys(reports)).toEqual([...DRAWS]);
    expect(check("draws", reports, floors({ draws: SCORE })).exit).toBe(0);
    expect(check("draws", reports, floors({ draws: Math.round((SCORE + 0.1) * 10) / 10 })).exit).toBe(1);
    expect(check("draws", reports, floors({ draws: 80 })).exit).toBe(0);
    const verdict = check("draws", reports, floors({ draws: 80 }));
    expect(verdict.why).toContain(`${SCORE.toFixed(1)}% (${detected} of ${total} detected`);
    expect(verdict.why).toContain(`over ${DRAWS.length} leg(s)`);
    // the survivors listed on a miss are those of EVERY leg (10 + 9 + 1 each of the others), in as many files as legs
    const miss = check("draws", reports, floors({ draws: 90 }));
    expect(miss.exit).toBe(1);
    if (miss.exit !== 1) throw new Error("unreachable");
    expect(miss.survivors).toHaveLength(19 + extra);
    expect(new Set(miss.survivors.map((x) => x.split(":")[0])).size, "the survivors name the files of every leg").toBe(DRAWS.length);
  });

  it("setFloor writes the family's summed score, and refuses to lower it", () => {
    const reports = sets();
    expect(setFloor("draws", reports, floors({ core: 10 }))).toMatchObject({ exit: 0, floors: { core: 10, draws: SCORE } });
    expect(setFloor("draws", reports, floors({ draws: Math.round((SCORE + 0.1) * 10) / 10 })).exit).toBe(2);
    expect(setFloor("draws", reports, floors({ draws: SCORE }))).toMatchObject({ exit: 0, floors: { draws: SCORE } });
  });

  it("every leg must be there, no other leg may be, and each must have measured something: a family is never judged on part of its mutants", () => {
    const full = sets();
    const [first, second, ...rest] = DRAWS as unknown as [string, string, ...string[]];
    const missing = check("draws", { [first]: full[first]! }, floors({ draws: 0 }));
    expect(missing).toEqual({ exit: 2, why: expect.stringContaining(`missing ${[second, ...rest].join(", ")}`) });
    const extraLeg = check("draws", { ...full, core: report({ killed: 1 }) }, floors({ draws: 0 }));
    expect(extraLeg).toEqual({ exit: 2, why: expect.stringContaining("unexpected core") });
    const last = rest[rest.length - 1] as string;
    const bothWrong = check("draws", { [last]: full[last]!, core: report({ killed: 1 }) }, floors({ draws: 0 }));
    expect(bothWrong.why).toContain(`missing ${DRAWS.filter((l) => l !== last).join(", ")}; unexpected core`);
    // a leg that measured nothing is refused even when the other legs carry the family past the floor
    const hollow = check("draws", { ...full, [second]: { files: {} } }, floors({ draws: 0 }));
    expect(hollow).toEqual({ exit: 2, why: expect.stringMatching(new RegExp(`zero mutants counted for leg "${second}" of family "draws"`)) });
    const ignoredOnly = check("draws", { ...full, [second]: report({ ignored: 4 }, placeOf(second).file) }, floors({ draws: 0 }));
    expect(ignoredOnly.exit).toBe(2);
    expect(setFloor("draws", { [first]: full[first]! }, floors({})).exit).toBe(2);
  });

  it("a leg's report must be of THAT leg's files: the other leg's report under this leg's name is refused", () => {
    const full = sets();
    const [first, second] = DRAWS as unknown as [string, string];
    const swapped = check("draws", { ...full, [first]: full[second]!, [second]: full[first]! }, floors({ draws: 0 }));
    expect(swapped.exit).toBe(2);
    expect(swapped.why).toContain(`is not leg "${first}"'s`);
  });

  it("mergeReports concatenates the mutants of a file two legs both report, and keeps the files of each", () => {
    const merged = mergeReports({ a: report({ killed: 2 }, "src/x.ts", 1), b: { files: { ...report({ survived: 3 }, "src/x.ts", 10).files, ...report({ killed: 1 }, "src/y.ts").files } } });
    expect(Object.keys(merged.files).sort()).toEqual(["src/x.ts", "src/y.ts"]);
    expect(merged.files["src/x.ts"]!.mutants).toHaveLength(5);
    expect(merged.files["src/y.ts"]!.mutants).toHaveLength(1);
    expect(mergeReports({})).toEqual({ files: {} });
  });

  it("the legs of a split file are told apart by LINE: a leg accepts the mutants of its own range and refuses another leg's report of the same file (the file name alone cannot)", () => {
    const FILE = "src/sports/cricket/cricket.ts";
    const family = "sports-cricket";
    // every range of cricket.ts a cricket leg holds, read back from the resolved groups, never typed (a leg may hold two)
    const ranges = STRYKER_FAMILIES[family].flatMap((g) =>
      resolveGroup(g).map(parseEntry).filter((e) => e.glob === FILE && e.lines !== null).map((e) => ({ g, from: (e.lines as readonly [number, number])[0], to: (e.lines as readonly [number, number])[1] })),
    );
    expect(new Set(ranges.map((r) => r.g)).size, "the cricket module is split across more than one leg").toBeGreaterThan(1);
    // every leg of the family at its own place, one Killed mutant: the baseline that must pass
    const base = legSet(family);
    expect(check(family, base, floors({ [family]: 50 })).exit, "the baseline").toBe(0);
    let accepted = 0;
    let refused = 0;
    for (const own of ranges) {
      for (const line of [own.from, own.to === 99999 ? own.from + 5 : own.to]) {
        expect(check(family, { ...base, [own.g]: report({ killed: 1 }, FILE, line) }, floors({ [family]: 50 })).exit, `${own.g} at its own line ${line}`).toBe(0);
        accepted++;
      }
      for (const other of ranges.filter((r) => r.g !== own.g)) {
        const r = check(family, { ...base, [own.g]: report({ killed: 2 }, FILE, other.from) }, floors({ [family]: 50 }));
        expect(r.exit, `${own.g} given ${other.g}'s mutant at line ${other.from}`).toBe(2);
        expect(r.why).toContain(`${FILE}:${other.from}`);
        expect(r.why).toContain(`leg "${own.g}"`);
        refused++;
      }
    }
    expect(accepted).toBe(ranges.length * 2);
    expect(refused, "other legs' lines refused").toBeGreaterThan(ranges.length);
  });

  it("a leg that negates a file and then ranges it is read in order: the file counts, but only through its range (and its directory's other files whole)", () => {
    const family = "sports-nested";
    const [first, second] = STRYKER_FAMILIES[family] as [string, string];
    expect(STRYKER_FAMILIES[family].length).toBeGreaterThan(1);
    const kernel = "src/sports/nested/kernel.ts";
    // the first leg is the directory glob, the kernel negated, and then the kernel's first range; the second is a range alone
    const rangeOf = (leg: string) => parseEntry(resolveGroup(leg).find((e) => parseEntry(e).lines !== null) as string).lines as readonly [number, number];
    const secondFrom = rangeOf(second)[0];
    const firstTo = rangeOf(first)[1];
    expect(secondFrom, "the second leg's range follows the first's").toBe(firstTo + 1);
    const base = legSet(family);
    const fl = floors({ [family]: 50 });
    const withSecond = (r: Report) => check(family, { ...base, [second]: r }, fl);
    const withFirst = (r: Report) => check(family, { ...base, [first]: r }, fl);
    expect(withSecond(report({ killed: 1 }, kernel, secondFrom)).exit, "the second leg's own range").toBe(0);
    expect(withSecond(report({ killed: 1 }, kernel, secondFrom - 1)).exit, "the line just before it belongs to the leg before").toBe(2);
    expect(withSecond(report({ killed: 1 }, "src/sports/nested/index.ts", 1)).exit, "a whole file of the directory glob is the first leg's, not the second's").toBe(2);
    expect(withFirst(report({ killed: 1 }, "src/sports/nested/index.ts", 1)).exit, "the first leg holds the directory's other files whole").toBe(0);
    expect(withFirst(report({ killed: 1 }, kernel, 1)).exit, "and the kernel through its range").toBe(0);
    expect(withFirst(report({ killed: 1 }, kernel, secondFrom)).exit, "but not past it: the kernel was negated and then ranged").toBe(2);
    expect(withSecond(report({ killed: 1 }, "src/sports/period/kernel.ts", secondFrom)).exit, "another sport").toBe(2);
  });
});

describe("the family table is what floors are keyed by: ruling 66's ten, none of them a leg that a re-split could drop", () => {
  it("every family has legs, the legs are real groups, and cutting a file again changes a family's legs and never its key", () => {
    const keys = Object.keys(STRYKER_FAMILIES);
    expect(keys).toEqual(["competition", "core", "modules", "draws", "sports-cricket", "sports-football", "sports-period", "sports-setbased", "sports-nested", "sports-other"]);
    let legs = 0;
    for (const [family, members] of Object.entries(STRYKER_FAMILIES)) {
      expect(members.length, family).toBeGreaterThan(0);
      for (const leg of members) {
        expect(Object.keys(STRYKER_GROUPS), `${leg} of ${family}`).toContain(leg);
        legs++;
      }
    }
    expect(legs, "every non-probe leg is in a family").toBe(Object.keys(STRYKER_GROUPS).length - 1);
    // no family key is a leg's name (a leg is `<family>-<n>`): the floors survive a re-split, and a family can be judged by its name
    const legNames = Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe");
    expect(legNames.length).toBeGreaterThan(keys.length);
    for (const leg of legNames) expect(keys, leg).not.toContain(leg);
    expect(Object.keys(STRYKER_SPLITS).length).toBeGreaterThan(0);
  });
});

describe("parsing: a malformed input is a refusal, and so is a status nobody counted", () => {
  const ok = JSON.stringify(report({ killed: 1 }));
  it("parseReport reads a real report and refuses garbage, a missing files map, a Pending mutant and an unknown status", () => {
    expect(Object.keys(parseReport(ok).files)).toEqual([CORE_FILE]);
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

  it("parseFloors: families is a map of numbers 0-100 with at most one decimal; the note is optional; the old per-leg `groups` map is no floor file", () => {
    expect(parseFloors('{"note": "n", "families": {"draws": 50.5, "core": 0, "x": 100}}')).toEqual({ draws: 50.5, core: 0, x: 100 });
    expect(parseFloors('{"families": {}}')).toEqual({});
    for (const bad of ["{", "[]", "{}", '{"groups": {}}', '{"families": []}', '{"families": {"draws": "50"}}', '{"families": {"draws": 101}}', '{"families": {"draws": -1}}', '{"families": {"draws": 50.55}}', '{"families": {"draws": null}}']) {
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
  it("the floor never falls: --check-file-against flags a lowered or removed family", () => {
    expect(floorDiff({ draws: 50, competition: 40 }, { draws: 49.9, competition: 40 })).toEqual([{ family: "draws", was: 50, now: 49.9 }]);
    expect(floorDiff({ draws: 50 }, {})).toEqual([{ family: "draws", was: 50, now: null }]);
    expect(floorDiff({}, { draws: 50 })).toEqual([]); // a new family may be added
  });

  it("an equal or raised floor is no difference, and every removed or lowered family is listed in the order it was", () => {
    expect(floorDiff({ draws: 50, core: 10 }, { draws: 50, core: 10.1 })).toEqual([]);
    expect(floorDiff({ a: 5, b: 6, c: 7, d: 8 }, { a: 5, b: 5.9, d: 9 })).toEqual([{ family: "b", was: 6, now: 5.9 }, { family: "c", was: 7, now: null }]);
    expect(floorDiff({}, {})).toEqual([]);
  });

  it("setFloor writes floor(score, 1 dp), never a rounded-up value (2 of 3 killed = 66.6, not 66.7)", () => {
    const r = setFloor("core", one({ killed: 2, survived: 1 }), floors({}));
    expect(r).toMatchObject({ exit: 0, floors: { core: 66.6 } });
    // 4 of 7 = 57.142…
    expect(setFloor("core", one({ killed: 4, survived: 3 }), floors({ draws: 10 }))).toMatchObject({ exit: 0, floors: { draws: 10, core: 57.1 } });
    // an exact score is written as is
    expect(setFloor("core", one({ killed: 3, survived: 1 }), floors({}))).toMatchObject({ exit: 0, floors: { core: 75 } });
  });

  it("setFloor refuses lowering, a zero-mutant report, the probe, an unknown family and the wrong report; raising and holding are fine", () => {
    expect(setFloor("core", one({ killed: 2, survived: 1 }), floors({ core: 70 })).exit).toBe(2); // 66.6 < 70
    expect(setFloor("core", one({ killed: 2, survived: 1 }), floors({ core: 66.6 }))).toMatchObject({ exit: 0, floors: { core: 66.6 } });
    expect(setFloor("core", one({ killed: 3, survived: 1 }), floors({ core: 66.6 }))).toMatchObject({ exit: 0, floors: { core: 75 } });
    expect(setFloor("core", one({}), floors({})).exit).toBe(2);
    expect(setFloor("probe", { probe: report({ killed: 1 }, "src/scheduling/roundrobin.ts") }, floors({})).exit).toBe(2);
    expect(setFloor("nosuch", one({ killed: 1 }), floors({})).exit).toBe(2);
    expect(setFloor("core", one({ killed: 1 }, "src/scheduling/bracket.ts"), floors({})).exit).toBe(2);
  });

  it("setFloor honours the equivalents the same way check does (the floor is set on the score check will compute)", () => {
    const rep = one({ killed: 49, survived: 51 });
    // 49/98 = 50.0 with two equivalents; 49/99 = 49.4 with one; 49/100 = 49.0 with none
    expect(setFloor("core", rep, floors({}), [...EQS(50), ...EQS(51)])).toMatchObject({ exit: 0, floors: { core: 50 } });
    expect(setFloor("core", rep, floors({}), EQS(50))).toMatchObject({ exit: 0, floors: { core: 49.4 } });
    expect(setFloor("core", rep, floors({}), [])).toMatchObject({ exit: 0, floors: { core: 49 } });
  });

  it("once any floor exists every family needs one: a missing entry is a failure, never a skip (review 4, R4-m3)", () => {
    const names = ["competition", "core", "draws"];
    expect(missingFloors(names, {})).toEqual([]); // no floors yet: PR-A's state, nothing is missing
    expect(missingFloors(names, { draws: 50 })).toEqual(["competition", "core"]);
    expect(missingFloors(names, { draws: 50, core: 10, competition: 5 })).toEqual([]);
  });

  it("the committed floor file satisfies it for every real family, and names only real families (the real-tree case)", () => {
    const committed = parseFloors(readFileSync(join(ENGINE, "stryker-floor.json"), "utf8"));
    const families = Object.keys(STRYKER_FAMILIES);
    expect(families.length).toBe(10);
    expect(missingFloors(families, committed)).toEqual([]);
    // whatever is committed names only real families (a stale or misspelt name, or a LEG's name, would otherwise never be checked)
    for (const f of Object.keys(committed)) {
      expect(families, f).toContain(f);
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
    const md = survivorsMarkdown("draws-3", rep, []);
    const listed = md.split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toEqual([
      "src/scheduling/bracket.ts:3:7 ConditionalExpression → false",
      "src/scheduling/bracket.ts:30:2 StringLiteral → \"\"",
      "src/scheduling/bracket.ts:41:1 StringLiteral → line one\\nline two", // a multi-line replacement stays on one line
      "src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b",
    ]);
    expect(md).toContain("# Survivors: draws-3");
    expect(md).toContain("4 listed");
  });

  it("an equivalent survivor is left out and counted; the key it is matched by is the listed line, verbatim", () => {
    const md = survivorsMarkdown("draws-3", rep, ["src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b"]);
    const listed = md.split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toHaveLength(3);
    expect(listed).not.toContain("src/scheduling/swiss.ts:9:4 ArithmeticOperator → a - b");
    expect(md).toContain("3 listed");
    expect(md).toContain("1 equivalent");
  });

  it("no survivors says so, and a report with nothing valid is still renderable (it is the CLI's check that refuses it)", () => {
    expect(survivorsMarkdown("draws-3", report({ killed: 3 }), [])).toContain("No survivors");
    expect(survivorsMarkdown("draws-3", { files: {} }, [])).toContain("No survivors");
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
const floorFile = (f: Record<string, number>, note = "test") => `${JSON.stringify({ note, families: f }, null, 2)}\n`;

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
    for (const working of [floorFile({}), floorFile({ "draws": 50, core: 40 })]) {
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

  spawnIt(2)("present at the ref and LOWER in the working file: exit 1, naming the family, and it counted what it compared (a CLI that exits 0 without reading fails here)", () => {
    const r = againstRef({ atRef: floorFile({ "draws": 50, core: 40 }), working: floorFile({ "draws": 49.9, core: 40 }) });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("compared 2 floor(s) against HEAD: 1 lowered or removed");
    expect(r.stdout).toContain("draws: 50 -> 49.9");
    expect(r.stdout).not.toContain("core:");
  });

  spawnIt(4)("equal or higher: exit 0, and the count is printed", () => {
    const equal = againstRef({ atRef: floorFile({ "draws": 50, core: 40 }), working: floorFile({ "draws": 50, core: 40 }) });
    expect({ status: equal.status, stderr: equal.stderr }).toEqual({ status: 0, stderr: "" });
    expect(equal.stdout).toContain("compared 2 floor(s) against HEAD: 0 lowered or removed");
    const higher = againstRef({ atRef: floorFile({ "draws": 50, core: 40 }), working: floorFile({ "draws": 55, core: 40.1, competition: 5 }) });
    expect(higher.status).toBe(0);
    expect(higher.stdout).toContain("compared 2 floor(s) against HEAD: 0 lowered or removed");
  });

  spawnIt(6)("a family REMOVED from the working file is exit 1 (an empty families map included); a family ADDED is fine", () => {
    const removed = againstRef({ atRef: floorFile({ "draws": 50, core: 40 }), working: floorFile({ "draws": 50 }) });
    expect(removed.status).toBe(1);
    expect(removed.stdout).toContain("core: 40 -> (removed)");
    expect(removed.stdout).toContain("compared 2 floor(s) against HEAD: 1 lowered or removed");
    const emptied = againstRef({ atRef: floorFile({ "draws": 50 }), working: floorFile({}) });
    expect(emptied.status).toBe(1);
    expect(emptied.stdout).toContain("compared 1 floor(s)");
    const added = againstRef({ atRef: floorFile({ "draws": 50 }), working: floorFile({ "draws": 50, core: 40 }) });
    expect(added.status).toBe(0);
  });

  spawnIt(2)("the file present at the ref with no floors in it compares nothing and passes, and says that", () => {
    const r = againstRef({ atRef: floorFile({}), working: floorFile({ "draws": 50 }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("compared 0 floor(s) against HEAD: 0 lowered or removed");
  });

  spawnIt(4)("the working file deleted while the ref has it: exit 2; deleted while the ref lacks it: exit 2 too (after PR-B a deleted file must never read as no floors)", () => {
    const had = againstRef({ atRef: floorFile({ "draws": 50 }), working: null });
    expect(had.status).toBe(2);
    expect(had.stderr).toContain("stryker-floor.json");
    const lacked = againstRef({ atRef: null, working: null });
    expect(lacked.status).toBe(2);
    expect(lacked.stdout).not.toContain("no floors");
  });

  spawnIt(6)("a nonexistent ref, a ref that is not a commit, and HEAD^1 of a root commit: each exit 2", () => {
    for (const ref of ["no-such-ref", "HEAD:packages", "HEAD^1"]) {
      const r = againstRef({ atRef: floorFile({ "draws": 50 }), working: floorFile({ "draws": 50 }), ref });
      expect({ ref, status: r.status }).toEqual({ ref, status: 2 });
      expect(r.stdout, ref).not.toContain("no floors");
      expect(r.stdout, ref).not.toContain("compared");
    }
  });

  spawnIt(2)("a ref that looks like an option is refused as a ref, before git sees it (--check-file-against=-x reaches the CLI as the value -x)", () => {
    const base = againstRef({ atRef: floorFile({ "draws": 50 }), working: floorFile({ "draws": 50 }) });
    for (const arg of ["--check-file-against=-x", "--check-file-against=--output=/tmp/x", "--check-file-against="]) {
      const r = run(join(base.root, "packages/engine"), [arg]);
      expect({ arg, status: r.status }).toEqual({ arg, status: 2 });
      expect(r.stderr, arg).toContain("is not a ref");
      expect(r.stdout, arg).toBe("");
    }
  });

  spawnIt(10)("malformed JSON at the ref, or in the working file, or a wrong shape: exit 2", () => {
    expect(againstRef({ atRef: "{ not json", working: floorFile({ "draws": 50 }) }).status).toBe(2);
    expect(againstRef({ atRef: floorFile({ "draws": 50 }), working: "{ not json" }).status).toBe(2);
    expect(againstRef({ atRef: null, working: "{ not json" }).status).toBe(2); // absent at the ref does not excuse a broken working file
    expect(againstRef({ atRef: floorFile({ "draws": 50 }), working: '{"families": []}' }).status).toBe(2);
    expect(againstRef({ atRef: '{"families": {"draws": "fifty"}}', working: floorFile({ "draws": 50 }) }).status).toBe(2);
  });

  spawnIt(2)("the file is found relative to the CLI's cwd, not the repo root: a decoy at the root with other floors changes nothing", () => {
    // reading the root's decoy ({draws: 99}) against the working {draws: 50} would be exit 1
    const r = againstRef({ atRef: floorFile({ "draws": 50 }), working: floorFile({ "draws": 50 }), decoyRoot: floorFile({ "draws": 99 }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("compared 1 floor(s)");
  });
});

describe("the CLI's other modes and its refusals", () => {
  const BRACKET = "src/scheduling/bracket.ts";
  /** The draws leg that selects bracket.ts whole (the survivors tests judge ONE leg), read from the groups, not typed. */
  const BRACKET_LEG = STRYKER_FAMILIES.draws.find((leg) => selected(ENGINE, resolveGroup(leg)).get(BRACKET) === "all") as string;
  const DRAWS = STRYKER_FAMILIES.draws;
  const CORE0 = CORE_LEGS[0] as string;
  type Reports = Record<string, Report | string>;
  /** A working directory holding the floor file, optional equivalents, and one report per leg: flat, as a local run writes them
   *  (reports/mutation/<leg>.json), or as `download-artifact` unpacks mutation.yml's (all/mutation-<leg>/reports/mutation/<leg>.json). */
  function workdir(o: { floors?: Record<string, number>; equivalents?: unknown[]; reports?: Reports; layout?: "flat" | "artifacts" }) {
    const cwd = fresh();
    if (o.floors !== undefined) writeFileSync(join(cwd, "stryker-floor.json"), floorFile(o.floors));
    if (o.equivalents !== undefined) writeFileSync(join(cwd, "stryker-equivalent.json"), JSON.stringify({ note: "n", equivalent: o.equivalents }));
    const artifacts = o.layout === "artifacts";
    const pathOf = (leg: string) => (artifacts ? join("all", `mutation-${leg}`, "reports/mutation", `${leg}.json`) : join("reports/mutation", `${leg}.json`));
    for (const [leg, rep] of Object.entries(o.reports ?? {})) {
      mkdirSync(dirname(join(cwd, pathOf(leg))), { recursive: true });
      writeFileSync(join(cwd, pathOf(leg)), typeof rep === "string" ? rep : JSON.stringify(rep));
    }
    return { cwd, dir: artifacts ? "all" : "reports/mutation", pathOf };
  }
  /** The legs of `core`, as reports: every leg the same counts, so the family scores the ratio alone (see `one`). */
  const coreOnly = (c: Counts): Reports => one(c);
  /** The legs of `draws`, as reports: the first leg scores 90.0% over 100 mutants, the second 10.0% over 10, each other one 50.0% over 2:
   *  the family holds (91 + extra) of (110 + 2 x extra) detected, `extra` the legs past the second. */
  const drawsExtra = DRAWS.length - 2;
  const drawsDetected = 91 + drawsExtra;
  const drawsTotal = 110 + 2 * drawsExtra;
  const drawsScore = Math.floor((drawsDetected / drawsTotal) * 1000) / 10;
  const drawsReports = (): Reports => legSet("draws", Object.fromEntries(DRAWS.map((leg, i) => [leg, i === 0 ? { killed: 90, survived: 10 } : i === 1 ? { killed: 1, survived: 9 } : { killed: 1, survived: 1 }])));
  /** Writes every core leg's report again with `c` (a worse run of the same family). */
  const rewriteCore = (w: { cwd: string; pathOf: (leg: string) => string }, c: Counts) => { for (const leg of CORE_LEGS) writeFileSync(join(w.cwd, w.pathOf(leg)), JSON.stringify(report(c, fileOf(leg)))); };

  spawnIt(2)("--check: at or above the floor is exit 0 and prints the score; below is exit 1 and lists the survivors", () => {
    const pass = workdir({ floors: { core: 50 }, reports: coreOnly({ killed: 50, survived: 50 }) });
    const p = run(pass.cwd, ["--check", "core", pass.dir]);
    expect({ status: p.status, stderr: p.stderr }).toEqual({ status: 0, stderr: "" });
    expect(p.stdout).toContain("core: score 50.0%");
    const fail = workdir({ floors: { core: 50 }, reports: coreOnly({ killed: 49, survived: 51 }) });
    const f = run(fail.cwd, ["--check", "core", fail.dir]);
    expect(f.status).toBe(1);
    expect(f.stdout).toContain("core: score 49.0%");
    expect(f.stdout).toContain(`${CORE_FILE}:50:1 ConditionalExpression → true`);
    expect(f.stdout.split("\n").filter((l) => l.startsWith("src/core/"))).toHaveLength(51 * N);
  });

  spawnIt(3)("--check on a family of several legs sums them (not their mean, 50.0%), found in the flat layout and in download-artifact's, and a floor one tenth above the sum fails", () => {
    expect(drawsScore, "the sum is far from the mean of the legs' scores").toBeGreaterThan(80);
    for (const layout of ["flat", "artifacts"] as const) {
      const w = workdir({ floors: { draws: drawsScore }, reports: drawsReports(), layout });
      const r = run(w.cwd, ["--check", "draws", w.dir]);
      expect({ layout, status: r.status, stderr: r.stderr }).toEqual({ layout, status: 0, stderr: "" });
      expect(r.stdout, layout).toContain(`draws: score ${drawsScore.toFixed(1)}% (${drawsDetected} of ${drawsTotal} detected`);
      expect(r.stdout, layout).toContain(`over ${DRAWS.length} leg(s)`);
    }
    const miss = workdir({ floors: { draws: Math.round((drawsScore + 0.1) * 10) / 10 }, reports: drawsReports() });
    expect(run(miss.cwd, ["--check", "draws", miss.dir]).status).toBe(1);
  });

  spawnIt(2)("--check reads stryker-equivalent.json from the cwd: two recorded equivalents in each leg turn 49/99 into a pass", () => {
    const eq = [...EQS(50), ...EQS(51)].map((mutant) => ({ mutant, reason: "dead branch: the guard above already returned" }));
    const w = workdir({ floors: { core: 50 }, equivalents: eq, reports: coreOnly({ killed: 49, survived: 50 }) });
    expect(run(w.cwd, ["--check", "core", w.dir]).status).toBe(0);
    const none = workdir({ floors: { core: 50 }, equivalents: [], reports: coreOnly({ killed: 49, survived: 50 }) });
    expect(run(none.cwd, ["--check", "core", none.dir]).status).toBe(1);
  });

  spawnIt(12)("--check refuses (exit 2): zero mutants, no floor for the family, a leg with no report, an unreadable or malformed report or floor file, a bad equivalents file, an unknown family, a leg, the probe", () => {
    const zero = workdir({ floors: { core: 50 }, reports: coreOnly({}) });
    const z = run(zero.cwd, ["--check", "core", zero.dir]);
    expect(z.status).toBe(2);
    expect(z.stderr).toContain("zero mutants");
    const nofloor = workdir({ floors: { competition: 50 }, reports: coreOnly({ killed: 5 }) });
    expect(run(nofloor.cwd, ["--check", "core", nofloor.dir]).status).toBe(2);
    const noReport = workdir({ floors: { core: 50 }, reports: {} });
    const nr = run(noReport.cwd, ["--check", "core", noReport.dir]);
    expect(nr.status).toBe(2);
    // the directory itself missing is a refusal too; and one leg of two missing names the leg, never judging the other alone
    expect(run(noReport.cwd, ["--check", "core", "no/such/dir"]).status).toBe(2);
    const half = workdir({ floors: { draws: 0 }, reports: { [DRAWS[0] as string]: drawsReports()[DRAWS[0] as string]! } });
    const h = run(half.cwd, ["--check", "draws", half.dir]);
    expect(h.status).toBe(2);
    expect(h.stderr).toContain(`no report for leg "${DRAWS[1]}"`);
    const badReport = workdir({ floors: { core: 50 }, reports: { ...coreOnly({ killed: 5 }), [CORE0]: "{ nope" } });
    expect(run(badReport.cwd, ["--check", "core", badReport.dir]).status).toBe(2);
    const noFloorFile = workdir({ reports: coreOnly({ killed: 5 }) });
    expect(run(noFloorFile.cwd, ["--check", "core", noFloorFile.dir]).status).toBe(2);
    const badEq = workdir({ floors: { core: 50 }, equivalents: [{ mutant: EQ(1) }], reports: coreOnly({ killed: 5 }) });
    expect(run(badEq.cwd, ["--check", "core", badEq.dir]).status).toBe(2);
    const ok = workdir({ floors: { core: 50, probe: 10 }, reports: { ...coreOnly({ killed: 5 }), "sports-cricket-1": report({ killed: 1 }, "src/sports/cricket/cricket.ts", 1) } });
    const unknown = run(ok.cwd, ["--check", "nosuch", ok.dir]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown family "nosuch"');   // not the missing-report refusal it would fall through to
    const leg = run(ok.cwd, ["--check", "sports-cricket-1", ok.dir]);
    expect(leg.status).toBe(2);
    expect(leg.stderr).toContain('is a leg of "sports-cricket"');
    const probe = run(ok.cwd, ["--check", "probe", ok.dir]);
    expect(probe.status).toBe(2);
    expect(probe.stderr).toContain("the probe has no floor");
    expect(run(ok.cwd, ["--check", "core"]).status).toBe(2); // the reports directory is required
  });

  spawnIt(2)("two reports named for one leg are refused (which is the leg's?), and a leg's report of another leg's files is refused with the files it mutated", () => {
    const dup = workdir({ floors: { core: 50 }, reports: coreOnly({ killed: 5 }) });
    mkdirSync(join(dup.cwd, "reports/mutation/old"), { recursive: true });
    writeFileSync(join(dup.cwd, `reports/mutation/old/${CORE0}.json`), JSON.stringify(report({ killed: 5 }, fileOf(CORE0))));
    const d = run(dup.cwd, ["--check", "core", dup.dir]);
    expect(d.status).toBe(2);
    expect(d.stderr).toContain(`2 reports named ${CORE0}.json`);
    const wrong = workdir({ floors: { core: 50 }, reports: { ...coreOnly({ killed: 5 }), [CORE0]: report({ killed: 5 }, BRACKET) } });
    const w = run(wrong.cwd, ["--check", "core", wrong.dir]);
    expect(w.status).toBe(2);
    expect(w.stderr).toContain(`it mutated ${BRACKET}`);
  });

  spawnIt(3)("--check --skip-if-no-floors: PR-A's state (no floor anywhere) prints `no floor yet: PR-B sets it` and passes, but once ANY floor exists a family without one is exit 2", () => {
    const pra = workdir({ floors: {}, reports: coreOnly({ killed: 3, survived: 1 }) });
    const a = run(pra.cwd, ["--check", "core", pra.dir, "--skip-if-no-floors"]);
    expect({ status: a.status, stderr: a.stderr }).toEqual({ status: 0, stderr: "" });
    expect(a.stdout).toContain("no floor yet: PR-B sets it");
    expect(a.stdout).toContain("75.0%"); // the log still says what the family scored
    const prb = workdir({ floors: { competition: 40 }, reports: coreOnly({ killed: 3, survived: 1 }) });
    const b = run(prb.cwd, ["--check", "core", prb.dir, "--skip-if-no-floors"]);
    expect(b.status).toBe(2);
    expect(b.stdout).not.toContain("no floor yet");
    // and a floor that exists is still judged: the flag skips only an EMPTY floor file
    const judged = workdir({ floors: { core: 90 }, reports: coreOnly({ killed: 3, survived: 1 }) });
    expect(run(judged.cwd, ["--check", "core", judged.dir, "--skip-if-no-floors"]).status).toBe(1);
  });

  spawnIt(5)("--skip-if-no-floors does not excuse a report that proves nothing: zero mutants, a missing report, the wrong leg's files, a leg that measured nothing are still exit 2", () => {
    const zero = workdir({ floors: {}, reports: coreOnly({}) });
    expect(run(zero.cwd, ["--check", "core", zero.dir, "--skip-if-no-floors"]).status).toBe(2);
    const missing = workdir({ floors: {}, reports: {} });
    expect(run(missing.cwd, ["--check", "core", missing.dir, "--skip-if-no-floors"]).status).toBe(2);
    const wrong = workdir({ floors: {}, reports: { ...coreOnly({ killed: 5 }), [CORE0]: report({ killed: 5 }, BRACKET) } });
    expect(run(wrong.cwd, ["--check", "core", wrong.dir, "--skip-if-no-floors"]).status).toBe(2);
    const hollow = workdir({ floors: {}, reports: { ...drawsReports(), [DRAWS[1] as string]: { files: {} } } });
    expect(run(hollow.cwd, ["--check", "draws", hollow.dir, "--skip-if-no-floors"]).status).toBe(2);
    const noFile = workdir({ reports: coreOnly({ killed: 5 }) });
    expect(run(noFile.cwd, ["--check", "core", noFile.dir, "--skip-if-no-floors"]).status).toBe(2); // a deleted floor file is not "no floors yet"
  });

  spawnIt(4)("--set-floor writes floor(score, 1 dp) into the file, keeps the note and the other families, and refuses lowering without touching the file", () => {
    const w = workdir({ floors: { draws: 12.5 }, reports: coreOnly({ killed: 2, survived: 1 }) });
    const r = run(w.cwd, ["--set-floor", "core", w.dir]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const written = JSON.parse(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")) as { note: string; families: Record<string, number> };
    expect(written).toEqual({ note: "test", families: { draws: 12.5, core: 66.6 } });
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8").endsWith("\n")).toBe(true);
    // lowering: a worse report against the 66.6 just written
    const before = readFileSync(join(w.cwd, "stryker-floor.json"), "utf8");
    rewriteCore(w, { killed: 1, survived: 1 });
    const lower = run(w.cwd, ["--set-floor", "core", w.dir]);
    expect(lower.status).toBe(2);
    expect(lower.stderr).toContain("lower");
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")).toBe(before);
    // the probe and zero mutants never get a floor
    const probe = workdir({ floors: {}, reports: { probe: report({ killed: 1 }, "src/scheduling/roundrobin.ts") } });
    expect(run(probe.cwd, ["--set-floor", "probe", probe.dir]).status).toBe(2);
    const zero = workdir({ floors: {}, reports: coreOnly({}) });
    expect(run(zero.cwd, ["--set-floor", "core", zero.dir]).status).toBe(2);
    expect(existsSync(join(zero.cwd, "stryker-floor.json"))).toBe(true);
    expect((JSON.parse(readFileSync(join(zero.cwd, "stryker-floor.json"), "utf8")) as { families: object }).families).toEqual({});
  });

  spawnIt(2)("--set-floor of a family of several legs writes the family's summed score under the FAMILY's key, and a leg's name is refused", () => {
    const w = workdir({ floors: {}, reports: drawsReports() });
    expect(run(w.cwd, ["--set-floor", "draws", w.dir]).status).toBe(0);
    expect((JSON.parse(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")) as { families: object }).families).toEqual({ draws: drawsScore });
    const leg = run(w.cwd, ["--set-floor", DRAWS[0] as string, w.dir]);
    expect(leg.status).toBe(2);
    expect(leg.stderr).toContain('is a leg of "draws"');
    expect((JSON.parse(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")) as { families: object }).families).toEqual({ draws: drawsScore });
  });

  describe("--check-all: every family whose legs the run planned, from the directory the artifacts unpacked into", () => {
    const planned = (...legs: string[]) => legs.join(",");
    const coreLegs = (): string[] => [...CORE_LEGS];
    const drawsLegs = (): string[] => [...DRAWS];

    spawnIt(2)("judges each fully planned family on its legs' summed score, prints each verdict and the count, and exits 0 when none is below", () => {
      const w = workdir({ floors: { core: 50, draws: drawsScore }, reports: { ...coreOnly({ killed: 3, survived: 1 }), ...drawsReports() }, layout: "artifacts" });
      const r = run(w.cwd, ["--check-all", w.dir, "--legs", planned(...coreLegs(), ...drawsLegs())]);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      expect(r.stdout).toContain("core: score 75.0%");
      expect(r.stdout).toContain(`draws: score ${drawsScore.toFixed(1)}% (${drawsDetected} of ${drawsTotal} detected`);
      expect(r.stdout).toContain("2 famil(ies) judged, 0 below the floor; 0 not judged (partly planned), 0 refused");
      // the same run with the draws floor one tenth higher: exit 1, and the count says which
      const miss = workdir({ floors: { core: 50, draws: Math.round((drawsScore + 0.1) * 10) / 10 }, reports: { ...coreOnly({ killed: 3, survived: 1 }), ...drawsReports() }, layout: "artifacts" });
      const m = run(miss.cwd, ["--check-all", miss.dir, "--legs", planned(...coreLegs(), ...drawsLegs())]);
      expect(m.status).toBe(1);
      expect(m.stdout).toContain("2 famil(ies) judged, 1 below the floor");
    });

    spawnIt(2)("a family with only some of its legs planned is printed as NOT judged, never judged on part of its mutants (a dispatch of one leg)", () => {
      const d0 = DRAWS[0] as string;
      const w = workdir({ floors: { core: 50, draws: 99 }, reports: { ...coreOnly({ killed: 3, survived: 1 }), [d0]: drawsReports()[d0]! }, layout: "artifacts" });
      const r = run(w.cwd, ["--check-all", w.dir, "--legs", planned(...coreLegs(), d0)]);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      expect(r.stdout).toContain(`draws: not judged, only 1 of its ${DRAWS.length} legs were planned (${DRAWS.slice(1).join(", ")} not)`);
      expect(r.stdout).toContain("1 famil(ies) judged, 0 below the floor; 1 not judged (partly planned), 0 refused");
      // a family nothing of which was planned is not mentioned at all (it is not a partial run of that family)
      expect(r.stdout).not.toContain("competition");
      // only a partly planned family: nothing judged, exit 0, and it says so
      const only = run(w.cwd, ["--check-all", w.dir, "--legs", planned(d0)]);
      expect(only.status).toBe(0);
      expect(only.stdout).toContain("0 famil(ies) judged, 0 below the floor; 1 not judged (partly planned), 0 refused");
    });

    spawnIt(2)("a planned leg with no report refuses its family (exit 2, naming the leg) while the other families are still judged and printed", () => {
      const d0 = DRAWS[0] as string;
      const w = workdir({ floors: { core: 50, draws: 0 }, reports: { ...coreOnly({ killed: 3, survived: 1 }), [d0]: drawsReports()[d0]! }, layout: "artifacts" });
      const r = run(w.cwd, ["--check-all", w.dir, "--legs", planned(...coreLegs(), ...drawsLegs())]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`draws: no report for leg "${DRAWS[1]}"`);
      expect(r.stdout).toContain("core: score 75.0%");
      expect(r.stdout).toContain("1 famil(ies) judged, 0 below the floor; 0 not judged (partly planned), 1 refused");
    });

    spawnIt(3)("--skip-if-no-floors with an empty floor file prints `no floor yet` for each family and passes; without the flag the same run is refused (no floor for the family)", () => {
      const reports = { ...coreOnly({ killed: 3, survived: 1 }), ...drawsReports() };
      const w = workdir({ floors: {}, reports, layout: "artifacts" });
      const legs = planned(...coreLegs(), ...drawsLegs());
      const skip = run(w.cwd, ["--check-all", w.dir, "--legs", legs, "--skip-if-no-floors"]);
      expect({ status: skip.status, stderr: skip.stderr }).toEqual({ status: 0, stderr: "" });
      expect(skip.stdout.match(/no floor yet: PR-B sets it/g)).toHaveLength(2);
      expect(skip.stdout).toContain("2 famil(ies) judged");
      const strict = run(w.cwd, ["--check-all", w.dir, "--legs", legs]);
      expect(strict.status).toBe(2);
      expect(strict.stderr).toContain('no floor for family "core"');
      // a report that measured nothing is still refused while the floors are empty
      const hollow = workdir({ floors: {}, reports: { ...reports, [DRAWS[1] as string]: { files: {} } }, layout: "artifacts" });
      expect(run(hollow.cwd, ["--check-all", hollow.dir, "--legs", legs, "--skip-if-no-floors"]).status).toBe(2);
    });

    spawnIt(6)("--legs is refused when empty, with an empty entry, naming an unknown leg, the probe or a leg twice; it belongs to --check-all and --check-all needs it", () => {
      const w = workdir({ floors: {}, reports: coreOnly({ killed: 1 }), layout: "artifacts" });
      const cases: [string[], RegExp][] = [
        [["--check-all", w.dir], /--check-all needs --legs/],
        [["--check-all", w.dir, "--legs", ""], /--check-all needs --legs/],
        [["--check-all", w.dir, "--legs", `${CORE0},,${DRAWS[0]}`], /empty entry/],
        [["--check-all", w.dir, "--legs", `${CORE0},nosuch`], /unknown leg\(s\) nosuch/],
        [["--check-all", w.dir, "--legs", "probe"], /names the probe/],
        [["--check-all", w.dir, "--legs", `${CORE0},${CORE0}`], /names a leg twice/],
        [["--check", "core", w.dir, "--legs", "core"], /--legs belongs to --check-all/],
      ];
      for (const [args, why] of cases) {
        const r = run(w.cwd, args);
        expect({ args, status: r.status }).toEqual({ args, status: 2 });
        expect(r.stderr, args.join(" ")).toMatch(why);
        expect(r.stdout, args.join(" ")).toBe("");
      }
    });
  });

  spawnIt(4)("--survivors writes SURVIVORS.md at --out and says how many it listed; the report path and --out are required", () => {
    const w = workdir({ floors: {}, equivalents: [{ mutant: `${BRACKET}:50:1 ConditionalExpression → true`, reason: "dead branch: the guard above already returned" }], reports: { [BRACKET_LEG]: report({ killed: 3, survived: 2, noCoverage: 1 }, BRACKET) } });
    const reportPath = join(w.cwd, w.pathOf(BRACKET_LEG));
    const out = join(w.cwd, "SURVIVORS.md");
    const r = run(w.cwd, ["--survivors", BRACKET_LEG, reportPath, "--out", out]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const md = readFileSync(out, "utf8");
    // killed lines 1-3, survived 4-5, noCoverage 6; the equivalent is line 50, which this report does not have, so nothing is forgiven
    expect(md.split("\n").filter((l) => /^src\//.test(l))).toEqual([
      `${BRACKET}:4:1 ConditionalExpression → true`,
      `${BRACKET}:5:1 ConditionalExpression → true`,
      `${BRACKET}:6:1 ConditionalExpression → true`,
    ]);
    expect(r.stdout).toContain("3 listed");
    expect(run(w.cwd, ["--survivors", BRACKET_LEG, reportPath]).status).toBe(2);
    expect(run(w.cwd, ["--survivors", BRACKET_LEG, "--out", out]).status).toBe(2);
    const missing = run(w.cwd, ["--survivors", BRACKET_LEG, join(w.cwd, "nope.json"), "--out", join(w.cwd, "S2.md")]);
    expect(missing.status).toBe(2);
    expect(existsSync(join(w.cwd, "S2.md"))).toBe(false);
  });

  spawnIt(1)("--survivors honours stryker-equivalent.json: the recorded equivalent is not listed", () => {
    const w = workdir({ floors: {}, equivalents: [{ mutant: `${BRACKET}:4:1 ConditionalExpression → true`, reason: "dead branch: the guard above already returned" }], reports: { [BRACKET_LEG]: report({ killed: 3, survived: 2 }, BRACKET) } });
    const out = join(w.cwd, "SURVIVORS.md");
    expect(run(w.cwd, ["--survivors", BRACKET_LEG, join(w.cwd, w.pathOf(BRACKET_LEG)), "--out", out]).status).toBe(0);
    const listed = readFileSync(out, "utf8").split("\n").filter((l) => /^src\//.test(l));
    expect(listed).toEqual([`${BRACKET}:5:1 ConditionalExpression → true`]);
  });

  spawnIt(3)("--survivors refuses an unknown leg and another leg's report, and writes nothing", () => {
    const w = workdir({ floors: {}, reports: { [BRACKET_LEG]: report({ killed: 3, survived: 2 }, BRACKET) } });
    const reportPath = join(w.cwd, w.pathOf(BRACKET_LEG));
    const unknown = run(w.cwd, ["--survivors", "nosuch", reportPath, "--out", join(w.cwd, "U.md")]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown group "nosuch"');
    expect(existsSync(join(w.cwd, "U.md"))).toBe(false);
    // the bracket leg's report (src/scheduling/bracket.ts) is not a core leg's
    const wrong = run(w.cwd, ["--survivors", CORE0, reportPath, "--out", join(w.cwd, "W.md")]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain(`is not group "${CORE0}"'s`);
    expect(existsSync(join(w.cwd, "W.md"))).toBe(false);
    // and the right leg's own report is still written (the pair: these are not refusals of everything)
    expect(run(w.cwd, ["--survivors", BRACKET_LEG, reportPath, "--out", join(w.cwd, "R.md")]).status).toBe(0);
    expect(existsSync(join(w.cwd, "R.md"))).toBe(true);
  });

  spawnIt(5)("--out belongs to --survivors and --skip-if-no-floors to --check: each given to another mode is exit 2, and the mode does not run", () => {
    const w = workdir({ floors: { core: 50 }, reports: coreOnly({ killed: 50, survived: 50 }) });
    const before = readFileSync(join(w.cwd, "stryker-floor.json"), "utf8");
    const out = run(w.cwd, ["--check", "core", w.dir, "--out", join(w.cwd, "X.md")]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--out belongs to --survivors");
    expect(out.stdout).toBe("");
    const skipSet = run(w.cwd, ["--set-floor", "core", w.dir, "--skip-if-no-floors"]);
    expect(skipSet.status).toBe(2);
    expect(skipSet.stderr).toContain("--skip-if-no-floors belongs to --check");
    expect(readFileSync(join(w.cwd, "stryker-floor.json"), "utf8")).toBe(before);
    const reportPath = join(w.cwd, w.pathOf(CORE0));
    const skipSurvivors = run(w.cwd, ["--survivors", CORE0, reportPath, "--out", join(w.cwd, "S.md"), "--skip-if-no-floors"]);
    expect(skipSurvivors.status).toBe(2);
    expect(existsSync(join(w.cwd, "S.md"))).toBe(false);
    // the pair: each flag with its own mode is accepted
    expect(run(w.cwd, ["--check", "core", w.dir, "--skip-if-no-floors"]).status).toBe(0);
    expect(run(w.cwd, ["--survivors", CORE0, reportPath, "--out", join(w.cwd, "S.md")]).status).toBe(0);
  });

  spawnIt(8)("usage: no mode, two modes, an unknown mode or flag, and a missing ref are each exit 2 with a usage line on stderr and nothing on stdout", () => {
    const cwd = fresh();
    for (const args of [[], ["--check"], ["--check", "core", "reports", "--survivors"], ["--frobnicate"], ["--check-file-against"], ["--set-floor"], ["--check", "core", "reports", "--nosuch"], ["--check", "core"]]) {
      const r = run(cwd, args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stderr, args.join(" ")).toContain("usage:");
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });
});

describe("the real engine floor files", () => {
  it("stryker-floor.json and stryker-equivalent.json are present, parse, and say what the score counts", () => {
    const f = JSON.parse(readFileSync(join(ENGINE, "stryker-floor.json"), "utf8")) as { note: string; families: Record<string, number> };
    expect(typeof f.families).toBe("object");
    // the note names the scoring rule (Stryker's TOTAL score: an uncovered line is a survivor), that the floor only rises, and that it is per family
    expect(f.note).toMatch(/NoCoverage/);
    expect(f.note).toMatch(/never (falls|lower)/i);
    expect(f.note).toMatch(/per-family/i);
    expect(parseFloors(JSON.stringify(f))).toEqual(f.families);
    const e = readFileSync(join(ENGINE, "stryker-equivalent.json"), "utf8");
    expect(JSON.parse(e)).toHaveProperty("note");
    expect(parseEquivalents(e)).toEqual([]);
  });
});
