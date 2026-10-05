// W1d Task 15 (D14; rulings 66, 67): every engine source file has exactly one home among the Stryker groups, a named
// exclusion, or the ruling-67 placement exclusion; and the config, the concurrency formula and the .d.mts that types
// stryker.groups.mjs are held to what they claim. stryker.groups.mjs copies vitest.config.ts's worker bound (the second
// test below pins that copy against the original, so a moved formula reds here and not in an OOM on a Sunday).
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as groupsModule from "../stryker.groups.mjs";
import { lineCount, parseEntry, selected, type Selected } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_EXCLUDED, STRYKER_FAMILIES, STRYKER_GROUPS, STRYKER_PLACEMENT_OUT_OF_SCOPE, STRYKER_SPLITS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GB = 1024 ** 3; // as vitest.config.ts
/** What stryker.config.mjs's `dryRunTimeoutMinutes` must come to: D14's 344 s floor x CI's 8x slowdown, in whole minutes. */
const DRY_RUN_TIMEOUT_MINUTES = 46;
/** A test that spawns `n` processes. */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

// The universe: every non-test .ts under src/ (a test, a __tests__ helper or a declaration file is never product code).
const universe = () => globSync("src/**/*.ts", { cwd: ENGINE }).filter((f) => !/__tests__|\.test\.ts$|\.d\.ts$/.test(f));
// path.matchesGlob (node:path, Node 22+): minimatch is not a dependency of the engine or the root (review I11c).
const inMap = (map: Record<string, string>, f: string) => Object.keys(map).some((e) => matchesGlob(f, e));
// Ruling 66's ten groups, read here as FAMILIES now that the sizing (T15-SIZE) cut some of them into legs: a leg is named
// for its family, or `<family>-<suffix>`. The ten are the ruling's own list, typed here and never derived from the groups.
const FAMILIES = ["competition", "core", "modules", "draws", "sports-cricket", "sports-football", "sports-period", "sports-setbased", "sports-nested", "sports-other"] as const;
const familyOf = (leg: string) => FAMILIES.find((f) => leg === f || leg.startsWith(`${f}-`));
/** Every leg's `mutate` list with its `file#N` parts resolved to the `file:a-b` ranges Stryker reads (scripts/stryker-cuts.mjs). */
const RESOLVED: Record<string, string[]> = Object.fromEntries(Object.keys(STRYKER_GROUPS).map((g) => [g, resolveGroup(g)]));

/** How the groups home one file: the legs that select it, and whether they home it exactly once: one leg selecting the whole
 *  file, or legs that select ranges which tile it (the first starts at line 1, each next one at the line after the one
 *  before, and the last runs to the end of the file or past it). Returns the problem, or null when the file is homed once. */
function homingProblem(file: string, owners: { group: string; sel: Selected }[]): string | null {
  if (owners.length === 1 && owners[0]!.sel === "all") return null;
  const ranges: { group: string; from: number; to: number }[] = [];
  for (const o of owners) {
    if (o.sel === "all") return `${o.group} selects the whole file while ${owners.length - 1} other leg(s) select it too`;
    for (const [from, to] of o.sel) ranges.push({ group: o.group, from, to });
  }
  ranges.sort((a, b) => a.from - b.from);
  if (ranges[0]!.from !== 1) return `the first range starts at line ${ranges[0]!.from}, not line 1`;
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    if (ranges[i]!.from !== prev.to + 1) return `${prev.group} ends at line ${prev.to} and ${ranges[i]!.group} starts at line ${ranges[i]!.from}`;
  }
  const last = ranges[ranges.length - 1]!;
  const lines = lineCount(ENGINE, file);
  if (last.to < lines) return `the last range (${last.group}) ends at line ${last.to}, but the file has ${lines} lines`;
  return null;
}

describe("every engine source file has exactly one Stryker home (rulings 66, 67)", () => {
  it("every non-test .ts under src/ is homed once: whole in one group, or tiled by the ranges of several; or named in an exclusion or the ruling-67 placement exclusion. unclassified = 0", () => {
    const files = universe();
    const owners = new Map<string, { group: string; sel: Selected }[]>();
    for (const [g, globs] of Object.entries(RESOLVED)) {
      if (g === "probe") continue;
      for (const [f, sel] of selected(ENGINE, globs)) owners.set(f, [...(owners.get(f) ?? []), { group: g, sel }]);
    }
    const unclassified: string[] = [];
    const doubled: string[] = [];
    const untiled: string[] = [];
    let whole = 0;
    let split = 0;
    let parts = 0;
    let excluded = 0;
    let placement = 0;
    for (const f of files) {
      const own = owners.get(f) ?? [];
      const homed = own.length > 0;
      const homes = (homed ? 1 : 0) + (inMap(STRYKER_EXCLUDED, f) ? 1 : 0) + (inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0);
      if (homes === 0) unclassified.push(f);
      if (homes > 1) doubled.push(f);
      if (homed) {
        const problem = homingProblem(f, own);
        if (problem !== null) untiled.push(`${f}: ${problem}`);
        if (own.length === 1 && own[0]!.sel === "all") whole++;
        else {
          split++;
          parts += own.length;
        }
      }
      excluded += inMap(STRYKER_EXCLUDED, f) ? 1 : 0;
      placement += inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0;
    }
    // the failure message reports the count, so a red names how many files escaped (ruling 67)
    expect(unclassified, `${unclassified.length} of ${files.length} file(s) unclassified`).toEqual([]);
    expect(doubled, "files with more than one home").toEqual([]);
    expect(untiled, "files whose ranges do not tile them exactly once").toEqual([]);
    // anti-vacuity, derived from the maps and never typed: the universe is exactly what was homed, and every class was non-empty
    expect(files.length).toBe(whole + split + excluded + placement);
    expect(whole).toBeGreaterThan(0);
    expect(split, "files cut into ranges").toBeGreaterThan(0);
    expect(parts, "ranges over those files").toBeGreaterThan(split);
    expect(excluded).toBeGreaterThan(0);
    expect(placement).toBe(Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE).length); // every placement key is one existing exact file
  });

  it("the tiling check refuses each way a split file can go wrong: a gap, an overlap, a range that stops short of the end, one that does not start at line 1, and a whole file selected twice", () => {
    const file = "src/sports/cricket/cricket.ts"; // a real file, so lineCount is real
    const n = lineCount(ENGINE, file);
    const r = (group: string, from: number, to: number) => ({ group, sel: [[from, to]] as Selected });
    expect(homingProblem(file, [r("a", 1, 10), r("b", 11, n)]), "a clean tiling").toBeNull();
    expect(homingProblem(file, [r("b", 11, n), r("a", 1, 10)]), "order of the owners does not matter").toBeNull();
    expect(homingProblem(file, [r("a", 1, 10), r("b", 12, n)]), "a gap").toMatch(/a ends at line 10 and b starts at line 12/);
    expect(homingProblem(file, [r("a", 1, 10), r("b", 10, n)]), "an overlap").toMatch(/a ends at line 10 and b starts at line 10/);
    expect(homingProblem(file, [r("a", 1, 10), r("b", 11, n - 1)]), "short of the end").toMatch(/ends at line \d+, but the file has \d+ lines/);
    expect(homingProblem(file, [r("a", 2, 10), r("b", 11, n)]), "not from line 1").toMatch(/starts at line 2, not line 1/);
    expect(homingProblem(file, [r("a", 1, 10), r("b", 11, 99999)]), "99999 is how a range says to the end").toBeNull();
    expect(homingProblem(file, [{ group: "a", sel: "all" }, r("b", 1, 99999)]), "a whole file plus a range").toMatch(/selects the whole file/);
    expect(homingProblem(file, [{ group: "a", sel: "all" }, { group: "b", sel: "all" }]), "a whole file in two legs").toMatch(/selects the whole file/);
    expect(homingProblem(file, [{ group: "a", sel: "all" }]), "one whole file is one home").toBeNull();
  });

  it("every exclusion names its own reason and globs at least one file, in BOTH maps", () => {
    const files = universe();
    for (const [name, map] of [["STRYKER_EXCLUDED", STRYKER_EXCLUDED], ["STRYKER_PLACEMENT_OUT_OF_SCOPE", STRYKER_PLACEMENT_OUT_OF_SCOPE]] as const) {
      expect(Object.keys(map).length, name).toBeGreaterThan(0);
      for (const [k, reason] of Object.entries(map)) {
        expect(reason.length, `${name}[${k}]`).toBeGreaterThanOrEqual(10);
        // testkit and generated/ hold files the universe filter would keep; a stale key (renamed or deleted file) matches none
        expect(files.filter((f) => matchesGlob(f, k)).length, `${name}[${k}] matches no file`).toBeGreaterThan(0);
      }
    }
    expect(new Set(Object.values(STRYKER_EXCLUDED)).size, "each exclusion has its OWN reason").toBe(Object.keys(STRYKER_EXCLUDED).length);
    for (const r of Object.values(STRYKER_PLACEMENT_OUT_OF_SCOPE)) expect(r).toMatch(/^ruling 67: placement scheduling, low priority/);
    expect(STRYKER_EXCLUDED["src/testkit/**"]).toMatch(/^ruling 67:/);
  });

  it("the placement exclusion is the 19 exact src/scheduling files of build, calendar and repair, each exactly one file (ruling 67)", () => {
    const files = universe();
    const keys = Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE);
    // the count is ruling 67's own ("the 19 placement files"), not derived from the map under test
    expect(keys).toHaveLength(19);
    for (const k of keys) {
      expect(k, "an exact file, not a glob").toMatch(/^src\/scheduling\/[a-z-]+\.ts$/);
      expect(files.filter((f) => matchesGlob(f, k)), k).toEqual([k]);
    }
    // ruling 67's three families, by name
    for (const n of ["build", "build-grid", "build-objectives", "constraints", "candidate-courts", // build
      "calendar", "capacity", "health", "court-windows", "tz", "grid-step", "rest-floor", // calendar
      "repair-domain", "repair-decompose-cpsat", "repair-decompose", "repair-synthetic-board", "repair-minimality", "conflict-detail", "report"]) { // repair
      expect(keys, n).toContain(`src/scheduling/${n}.ts`);
    }
  });

  it("the scheduling files ruling 67 names as excluded are each excluded by name, and nothing else under scheduling/ is (the seven draw generators stay in)", () => {
    for (const n of ["index", "logger", "solver-test-bounds", "placement-client", "payload-fixtures"]) {
      expect(Object.keys(STRYKER_EXCLUDED), n).toContain(`src/scheduling/${n}.ts`);
    }
    expect(Object.keys(STRYKER_EXCLUDED)).toContain("src/scheduling/generated/**");
    const scheduling = Object.keys(STRYKER_EXCLUDED).filter((k) => k.startsWith("src/scheduling/"));
    expect(scheduling).toHaveLength(6);
    // the seven draw generators are not excluded and not placement, and the two draws legs hold exactly those seven
    const draws = [...STRYKER_GROUPS["draws-bracket"], ...STRYKER_GROUPS["draws-pairing"]];
    for (const n of ["bracket", "bracket-layout", "roundrobin", "swiss", "americano", "participants", "feedgraph"]) {
      expect(inMap(STRYKER_EXCLUDED, `src/scheduling/${n}.ts`), `${n} excluded`).toBe(false);
      expect(inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, `src/scheduling/${n}.ts`), `${n} placement`).toBe(false);
      expect(draws.filter((e) => e === `src/scheduling/${n}.ts`), `${n} in exactly one draws leg`).toHaveLength(1);
    }
    expect(draws).toHaveLength(7);
  });

  it("no in-scope production file imports payload-fixtures.ts, the file excluded because it feeds only the placement tests (review 4, R4-m4)", () => {
    const inScope = universe().filter((f) => !inMap(STRYKER_EXCLUDED, f) && !inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f));
    expect(inScope.length).toBeGreaterThan(0);
    // premise: the test can see a real importer, so an empty hit list means "nobody imports it", not "the regex sees nothing"
    const importers = universe().filter((f) => /payload-fixtures/.test(readFileSync(join(ENGINE, f), "utf8")));
    expect(importers, "repair-synthetic-board.ts imports it (out of scope), so the probe can see it").toContain("src/scheduling/repair-synthetic-board.ts");
    expect(inScope.filter((f) => /payload-fixtures/.test(readFileSync(join(ENGINE, f), "utf8")))).toEqual([]);
  });

  it("the probe is one exact file with a co-located test, and a draw generator (ruling 66)", () => {
    expect(STRYKER_GROUPS.probe).toEqual(["src/scheduling/roundrobin.ts"]);
    expect(existsSync(join(ENGINE, "src/scheduling/roundrobin.test.ts"))).toBe(true);
    expect(STRYKER_GROUPS["draws-pairing"]).toContain("src/scheduling/roundrobin.ts");
    expect(inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, "src/scheduling/roundrobin.ts")).toBe(false);
  });

  it("no group's mutate list reaches a test file, and every directory group says so itself (review I11a)", () => {
    let checked = 0;
    let positives = 0;
    for (const [g, globs] of Object.entries(RESOLVED)) {
      const pos = globs.filter((x) => !x.startsWith("!"));
      const files = [...selected(ENGINE, globs).keys()];
      // EACH positive entry must match a file, not just the group's total (review 4, R4-m5); a range entry matches its file
      for (const p of pos) expect(globSync([parseEntry(p).glob], { cwd: ENGINE }).length, `${g}: ${p} matches no file`).toBeGreaterThan(0);
      checked += files.length;
      positives += pos.length;
      expect(files.filter((f) => /\.test\.ts$|__tests__/.test(f)), g).toEqual([]);
      // a glob group carries the negations itself (Stryker reads `mutate`, not this test's filter), as its last two entries
      if (pos.some((p) => p.includes("*"))) expect(globs.slice(-2), `${g}: the test negations come last`).toEqual(["!src/**/*.test.ts", "!src/**/__tests__/**"]);
    }
    // the bound comes from the groups themselves, not a typed number
    expect(positives).toBeGreaterThan(Object.keys(STRYKER_GROUPS).length);
    expect(checked).toBeGreaterThanOrEqual(positives);
    expect(Object.keys(STRYKER_GROUPS).length).toBeGreaterThan(1);
  });

  it("the negations are what keep test files out: without them the same positives DO reach test files (the guard has something to guard)", () => {
    let reached = 0;
    for (const globs of Object.values(RESOLVED)) {
      const pos = globs.filter((x) => !x.startsWith("!")).map((x) => parseEntry(x).glob);
      reached += globSync(pos, { cwd: ENGINE }).filter((f) => /\.test\.ts$|__tests__/.test(f)).length;
    }
    expect(reached, "co-located tests exist under the grouped directories").toBeGreaterThan(0);
  });

  it("the legs are ruling 66's ten families and the probe: every leg belongs to one family, every family has a leg, the probe is last", () => {
    const names = Object.keys(STRYKER_GROUPS);
    expect(names.at(-1)).toBe("probe");
    const legs = names.filter((g) => g !== "probe");
    expect(legs.filter((g) => familyOf(g) === undefined), "legs of no family").toEqual([]);
    for (const f of FAMILIES) expect(legs.filter((g) => familyOf(g) === f).length, `legs of ${f}`).toBeGreaterThan(0);
    // a family's legs are declared together (the dispatch choices read them in this order)
    for (const f of FAMILIES) {
      const at = legs.map((g, i) => (familyOf(g) === f ? i : -1)).filter((i) => i >= 0);
      expect(at[at.length - 1]! - at[0]! + 1, `${f}'s legs are contiguous`).toBe(at.length);
    }
    expect(legs.length, "more legs than families, or nothing was split").toBeGreaterThan(FAMILIES.length);
  });

  it("STRYKER_FAMILIES is ruling 66's ten families, each with exactly the legs named for it, every leg in one family and the probe in none (floors are kept per family)", () => {
    expect(Object.keys(STRYKER_FAMILIES)).toEqual([...FAMILIES]);
    const legs = Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe");
    const listed = Object.values(STRYKER_FAMILIES).flat();
    expect(listed.slice().sort(), "every leg once, the probe never").toEqual(legs.slice().sort());
    let checked = 0;
    for (const [family, members] of Object.entries(STRYKER_FAMILIES)) {
      expect(members.length, `legs of ${family}`).toBeGreaterThan(0);
      // the leg's family by its NAME (this file's own reading of the naming rule), against the table's
      for (const leg of members) {
        expect(familyOf(leg), `${leg} is listed under ${family}`).toBe(family);
        checked++;
      }
      // and in the order the legs are declared
      expect(members, `${family}'s legs in declaration order`).toEqual(legs.filter((g) => familyOf(g) === family));
    }
    expect(checked).toBe(legs.length);
  });

  it("cricket.ts is split into parts, one leg each; the other cricket files, and any new one, stay together in sports-cricket", () => {
    const kernel = "src/sports/cricket/cricket.ts";
    const kernelLegs = Object.keys(STRYKER_GROUPS).filter((g) => g.startsWith("sports-cricket-kernel-"));
    expect(kernelLegs.length).toBeGreaterThan(1);
    kernelLegs.forEach((g, i) => {
      // declared as a part of the file, and resolved to one range of it
      expect(STRYKER_GROUPS[g as keyof typeof STRYKER_GROUPS], g).toEqual([`${kernel}#${i + 1}`]);
      expect(RESOLVED[g], g).toHaveLength(1);
      expect(parseEntry(RESOLVED[g]![0] as string).glob, g).toBe(kernel);
      expect(parseEntry(RESOLVED[g]![0] as string).lines, `${g} is a range`).not.toBeNull();
    });
    const rest = [...selected(ENGINE, STRYKER_GROUPS["sports-cricket"]).keys()];
    expect(rest).not.toContain(kernel);
    // the rest is what is in the directory besides it and the tests
    const all = universe().filter((f) => f.startsWith("src/sports/cricket/"));
    expect(all.length).toBeGreaterThan(1);
    expect(rest.slice().sort()).toEqual(all.filter((f) => f !== kernel).sort());
  });

  it("every part of every split file is taken by exactly one leg, and every `file#N` names a part that exists (STRYKER_SPLITS)", () => {
    const taken = new Map<string, number[]>();
    for (const [g, entries] of Object.entries(STRYKER_GROUPS)) {
      for (const e of entries) {
        const m = /^(.*)#(\d+)$/.exec(e);
        if (m === null) continue;
        expect(Object.keys(STRYKER_SPLITS), `${g}: ${e} takes a part of a file with no split`).toContain(m[1]);
        taken.set(m[1]!, [...(taken.get(m[1]!) ?? []), Number(m[2])]);
      }
    }
    expect([...taken.keys()].sort(), "every split file is taken by some leg").toEqual(Object.keys(STRYKER_SPLITS).sort());
    let parts = 0;
    for (const [file, anchors] of Object.entries(STRYKER_SPLITS)) {
      expect(existsSync(join(ENGINE, file)), `${file} exists`).toBe(true);
      expect(anchors.length, `${file} has at least one cut`).toBeGreaterThan(0);
      expect(taken.get(file)!.slice().sort((a, b) => a - b), `${file}: the parts the legs take`).toEqual(Array.from({ length: anchors.length + 1 }, (_, i) => i + 1));
      parts += anchors.length + 1;
    }
    expect(parts, "parts checked").toBeGreaterThan(Object.keys(STRYKER_SPLITS).length);
  });

  it("the sports legs split src/sports/ by family: every sport directory is in exactly one family, and the top-level files are in sports-other", () => {
    const dirs = new Set(readdirSync(join(ENGINE, "src/sports"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
    expect(dirs.size).toBeGreaterThan(5);
    const sports = Object.entries(RESOLVED).filter(([g]) => g.startsWith("sports-"));
    expect(sports.length).toBeGreaterThan(6);
    for (const d of dirs) {
      const families = new Set(sports.filter(([, globs]) => globs.some((x) => !x.startsWith("!") && parseEntry(x).glob.startsWith(`src/sports/${d}/`))).map(([g]) => familyOf(g)));
      expect([...families], `src/sports/${d}/`).toHaveLength(1);
    }
    const topLevel = globSync("src/sports/*.ts", { cwd: ENGINE }).filter((f) => !/\.test\.ts$/.test(f));
    expect(topLevel.length).toBeGreaterThan(0);
    expect([...selected(ENGINE, STRYKER_GROUPS["sports-other"]).keys()]).toEqual(expect.arrayContaining(topLevel));
  });
});

describe("strykerConcurrency and the vitest worker bound it copies (review I11b, R2-I4)", () => {
  // Each expected value is hand-derived from vitest.config.ts:43-46, bound = max(2, min(cores - 1, floor(mem / 3 GiB))),
  // then divided by the vitest workers ONE sandbox runs (STRYKER_VITEST_WORKERS), floored at 1.
  it("concurrency = vitest's own bound ÷ the workers one sandbox runs, from the formula's inputs", () => {
    // 4 cores, 16 GiB: bound = max(2, min(3, 5)) = 3
    expect(strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: 1 })).toBe(3);
    expect(strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: 3 })).toBe(1); // 3 ÷ 3
    // 16 cores, 8 GiB: bound = max(2, min(15, 2)) = 2 (memory-bound)
    expect(strykerConcurrency({ cores: 16, memBytes: 8 * GB, workersPerSandbox: 1 })).toBe(2);
    // 16 cores, 64 GiB: bound = max(2, min(15, 21)) = 15; ÷ 2 = 7
    expect(strykerConcurrency({ cores: 16, memBytes: 64 * GB, workersPerSandbox: 2 })).toBe(7);
    // vitest's own floor of 2: 2 cores, 16 GiB: bound = max(2, min(1, 5)) = 2, and one core: max(2, min(0, 5)) = 2
    expect(strykerConcurrency({ cores: 2, memBytes: 16 * GB, workersPerSandbox: 1 })).toBe(2);
    expect(strykerConcurrency({ cores: 1, memBytes: 16 * GB, workersPerSandbox: 1 })).toBe(2);
    // never below one sandbox, however many workers each runs: 2 cores, 4 GiB: bound = max(2, min(1, 1)) = 2; ÷ 4 = 0 → 1
    expect(strykerConcurrency({ cores: 2, memBytes: 4 * GB, workersPerSandbox: 4 })).toBe(1);
  });

  it("vitest.config.ts's bound is still the formula this copy was taken from (a moved formula reds here, not in an OOM)", () => {
    const cfg = readFileSync(join(ENGINE, "vitest.config.ts"), "utf8");
    expect(cfg).toContain("Math.min(availableParallelism() - 1, Math.floor(totalmem() / (3 * GB)))");
    expect(cfg).toMatch(/Math\.max\(\s*2,/);
  });

  it("a sandbox runs ONE vitest worker, as the runner's own override says (and the engine's vitest is the version that override applies to)", () => {
    expect(STRYKER_VITEST_WORKERS).toBe(1);
    const req = createRequire(import.meta.url);
    const runner = readFileSync(join(dirname(req.resolve("@stryker-mutator/vitest-runner")), "vitest-test-runner.js"), "utf8");
    // the branch for vitest >= 4.1 (the last `return` of #getVitestPoolConfig) forces one worker
    expect(runner).toMatch(/semver\.satisfies\(version, '<4\.1\.0'\)[\s\S]*?return \{\s*pool: 'threads',\s*maxWorkers: 1,\s*\};/);
    const v = (JSON.parse(readFileSync(req.resolve("vitest/package.json"), "utf8")) as { version: string }).version.split(".").map(Number);
    expect(v[0]! > 4 || (v[0] === 4 && v[1]! >= 1), `vitest ${v.join(".")} is on the runner's >=4.1 branch`).toBe(true);
  });
});

describe("stryker.groups.d.mts declares exactly what stryker.groups.mjs exports (review I11d)", () => {
  const dts = readFileSync(join(ENGINE, "stryker.groups.d.mts"), "utf8");
  it("the exports, no more and no fewer", () => {
    const declared = [...dts.matchAll(/^export (?:declare )?(?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
    expect(declared).toEqual(["STRYKER_EXCLUDED", "STRYKER_FAMILIES", "STRYKER_GROUPS", "STRYKER_PLACEMENT_OUT_OF_SCOPE", "STRYKER_SPLITS", "STRYKER_VITEST_WORKERS", "strykerConcurrency"]);
    expect(Object.keys(groupsModule).sort()).toEqual(declared);
  });
  it("the group-name union in the declaration is STRYKER_GROUPS's keys, in order", () => {
    const union = /STRYKER_GROUPS: Record<([\s\S]+?),\s*string\[\]\s*>;/.exec(dts)?.[1];
    expect(union, "STRYKER_GROUPS is declared as a Record over a union of names").toBeDefined();
    const names = [...union!.matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual(Object.keys(STRYKER_GROUPS));
  });
});

describe("stryker.config.mjs reads its group from STRYKER_GROUP, through the real groups file (the seam, driven)", () => {
  // One plain-node process loads the config once per group (a query string re-evaluates the module), so the config is
  // proven as Stryker will load it, not as a vitest-transformed copy.
  const names = Object.keys(STRYKER_GROUPS);
  const load = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", `
      const out = {};
      for (const g of ${JSON.stringify(names)}) {
        process.env.STRYKER_GROUP = g;
        out[g] = (await import("./stryker.config.mjs?g=" + g)).default;
      }
      console.log(JSON.stringify(out));
    `], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, ...env }, timeout: SPAWN_MS });

  spawnIt(1)("every group's config mutates exactly that group's globs, and writes its own report and incremental file", () => {
    const r = load({});
    expect(r.status, r.stderr).toBe(0);
    const configs = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>;
    expect(Object.keys(configs)).toEqual(names);
    let parts = 0;
    for (const g of names) {
      const c = configs[g]!;
      // a leg's parts of a split file arrive as the ranges Stryker reads, never as `file#N` (the ranges themselves are held by
      // test/stryker-cuts.test.ts, against Stryker's own instrumenter): one `file:a-b` for each `file#N` the leg declares
      const mutate = c.mutate as string[];
      expect(mutate.filter((e) => e.includes("#")), `${g}: a part left unresolved`).toEqual([]);
      const declared = STRYKER_GROUPS[g as keyof typeof STRYKER_GROUPS].filter((e) => /#\d+$/.test(e));
      expect(mutate.filter((e) => /:\d+-\d+$/.test(e)), `${g}: one range for each part it declares`).toHaveLength(declared.length);
      parts += declared.length;
      expect(mutate, g).toEqual(RESOLVED[g]);
      expect(c.incrementalFile, g).toBe(`reports/mutation/${g}.incremental.json`);
      expect(c.jsonReporter, g).toEqual({ fileName: `reports/mutation/${g}.json` });
      expect(c.incremental, g).toBe(true);
      expect(c.testRunner, g).toBe("vitest");
      // Stryker's runner ignores this and always uses perTest; the config states what it gets
      expect(c.coverageAnalysis, g).toBe("perTest");
      // the floor file gates (D14), never Stryker's own break
      expect(c.thresholds, g).toMatchObject({ break: null });
      expect(c.concurrency, g).toBeGreaterThanOrEqual(1);
      // the dry run is given D14's 344 s floor times the CI slowdown, and the runner's `related` is stated (both pinned below)
      expect(c.dryRunTimeoutMinutes, g).toBe(DRY_RUN_TIMEOUT_MINUTES);
      expect(c.vitest, g).toEqual({ related: true });
    }
    expect(parts, "the parts of split files the configs resolved").toBeGreaterThan(Object.keys(STRYKER_SPLITS).length);
    // two groups really do differ (a config that ignored the env would give every group the same list)
    expect(new Set(names.map((g) => JSON.stringify(configs[g]!.mutate))).size).toBe(names.length);
  });

  spawnIt(2)("an unset or unknown STRYKER_GROUP is a refusal that names the valid groups, never a silent default", () => {
    for (const bad of ["", "nosuch"]) {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `process.env.STRYKER_GROUP = ${JSON.stringify(bad)}; if (${JSON.stringify(bad)} === "") delete process.env.STRYKER_GROUP; await import("./stryker.config.mjs");`], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS });
      expect(r.status, `group "${bad}"`).not.toBe(0);
      expect(r.stderr).toContain("STRYKER_GROUP must be one of");
      expect(r.stderr).toContain("competition");
    }
  });
});

describe("the dry run's timeout and the runner's `related` mode, pinned (fix round 1, I3 and a minor)", () => {
  // The rulebook, typed here: D14 takes a leg's first, whole test run to be at least 344 s on CI, and the review put CI at about
  // 8 times slower than a local run. 344 x 8 = 2,752 s = 45.9 minutes, whole minutes up: 46.
  const D14_DRY_RUN_FLOOR_SECONDS = 344;
  const CI_SLOWDOWN = 8;
  const req = createRequire(import.meta.url);

  it("the config allows 46 minutes, and that is above Stryker's default of 5 (which is below D14's own floor, so every CI dry run would be abandoned)", () => {
    expect(DRY_RUN_TIMEOUT_MINUTES).toBe(Math.ceil((D14_DRY_RUN_FLOOR_SECONDS * CI_SLOWDOWN) / 60));
    expect(DRY_RUN_TIMEOUT_MINUTES).toBe(46);
    // the premise, from Stryker's own schema: its default is 5 minutes, 300 s, and D14's floor is longer than that
    const core = req.resolve("@stryker-mutator/core/package.json");
    const apiCore = createRequire(core).resolve("@stryker-mutator/api/core"); // .../api/dist/src/core/index.js
    const schema = JSON.parse(readFileSync(join(dirname(apiCore), "../../schema/stryker-core.json"), "utf8")) as { properties: { dryRunTimeoutMinutes: { default: number } } };
    const stryker = schema.properties.dryRunTimeoutMinutes.default;
    expect(stryker, "Stryker's default for the initial test run, in minutes").toBe(5);
    expect(D14_DRY_RUN_FLOOR_SECONDS, "D14's floor is longer than Stryker's default allows").toBeGreaterThan(stryker * 60);
    expect(DRY_RUN_TIMEOUT_MINUTES * 60, "the config allows at least D14's floor with the slowdown").toBeGreaterThanOrEqual(D14_DRY_RUN_FLOOR_SECONDS * CI_SLOWDOWN);
  });

  it("`vitest.related` is stated true, it is the runner's own default, and the runner narrows the dry run to the files related to the mutated ones with it", () => {
    const runnerDir = dirname(req.resolve("@stryker-mutator/vitest-runner"));
    const schema = JSON.parse(readFileSync(join(runnerDir, "../schema/vitest-runner-options.json"), "utf8")) as { properties: { vitest: { properties: { related: { default: boolean } } } } };
    expect(schema.properties.vitest.properties.related.default, "the runner's default").toBe(true);
    const runner = readFileSync(join(runnerDir, "vitest-test-runner.js"), "utf8");
    // what `related` does: the vitest run is narrowed to the mutated files' related tests; off, it is undefined (every test)
    expect(runner).toMatch(/this\.ctx\.config\.related =\s*this\.options\.vitest\.related && relatedFiles\s*\?\s*relatedFiles\.map\(normalizeFileName\)\s*:\s*undefined;/);
    // and the warning a leg whose files no test imports would print, which the config comment names
    expect(runner).toContain("Vitest failed to find test files related to mutated files");
    const config = readFileSync(join(ENGINE, "stryker.config.mjs"), "utf8");
    expect(config).toMatch(/vitest: \{ related: true \},/);
  });
});
