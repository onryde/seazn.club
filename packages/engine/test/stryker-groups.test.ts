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
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { STRYKER_EXCLUDED, STRYKER_GROUPS, STRYKER_PLACEMENT_OUT_OF_SCOPE, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GB = 1024 ** 3; // as vitest.config.ts
/** A test that spawns `n` processes. */
const spawnIt = (n: number) => (name: string, fn: () => void) => it(name, fn, spawnBudget(n));

// The universe: every non-test .ts under src/ (a test, a __tests__ helper or a declaration file is never product code).
const universe = () => globSync("src/**/*.ts", { cwd: ENGINE }).filter((f) => !/__tests__|\.test\.ts$|\.d\.ts$/.test(f));
// path.matchesGlob (node:path, Node 22+): minimatch is not a dependency of the engine or the root (review I11c).
const inMap = (map: Record<string, string>, f: string) => Object.keys(map).some((e) => matchesGlob(f, e));
// globSync's `exclude` option receives BASENAMES for files ('cascade.test.ts'), so a path negation never matches there
// (probed on Node 26.8.2: 24 files, 14 of them tests). Expand the positives, then filter the RESULT (review 4, R4-I1).
const expand = (globs: string[], only: string[] = globs.filter((g) => !g.startsWith("!"))) =>
  globSync(only, { cwd: ENGINE }).filter((f) => !globs.filter((g) => g.startsWith("!")).some((n) => matchesGlob(f, n.slice(1))));

describe("every engine source file has exactly one Stryker home (rulings 66, 67)", () => {
  it("every non-test .ts under src/ is in exactly one group, a named exclusion, or the ruling-67 placement exclusion; unclassified = 0", () => {
    const files = universe();
    const owners = new Map<string, string[]>();
    for (const [g, globs] of Object.entries(STRYKER_GROUPS)) if (g !== "probe") for (const f of expand(globs)) owners.set(f, [...(owners.get(f) ?? []), g]);
    const unclassified: string[] = [];
    const doubled: string[] = [];
    let grouped = 0;
    let excluded = 0;
    let placement = 0;
    for (const f of files) {
      const homes = (owners.get(f)?.length ?? 0) + (inMap(STRYKER_EXCLUDED, f) ? 1 : 0) + (inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0);
      if (homes === 0) unclassified.push(f);
      if (homes > 1) doubled.push(f);
      grouped += owners.get(f)?.length ?? 0;
      excluded += inMap(STRYKER_EXCLUDED, f) ? 1 : 0;
      placement += inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, f) ? 1 : 0;
    }
    // the failure message reports the count, so a red names how many files escaped (ruling 67)
    expect(unclassified, `${unclassified.length} of ${files.length} file(s) unclassified`).toEqual([]);
    expect(doubled, "files with more than one home").toEqual([]);
    // anti-vacuity, derived from the maps and never typed: the universe is exactly what was homed, and every class was non-empty
    expect(files.length).toBe(grouped + excluded + placement);
    expect(grouped).toBeGreaterThan(0);
    expect(excluded).toBeGreaterThan(0);
    expect(placement).toBe(Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE).length); // every placement key is one existing exact file
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
    // the seven draw generators are not excluded and not placement
    for (const n of ["bracket", "bracket-layout", "roundrobin", "swiss", "americano", "participants", "feedgraph"]) {
      expect(inMap(STRYKER_EXCLUDED, `src/scheduling/${n}.ts`), `${n} excluded`).toBe(false);
      expect(inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, `src/scheduling/${n}.ts`), `${n} placement`).toBe(false);
      expect(STRYKER_GROUPS.draws, n).toContain(`src/scheduling/${n}.ts`);
    }
    expect(STRYKER_GROUPS.draws).toHaveLength(7);
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
    expect(STRYKER_GROUPS.draws).toContain("src/scheduling/roundrobin.ts");
    expect(inMap(STRYKER_PLACEMENT_OUT_OF_SCOPE, "src/scheduling/roundrobin.ts")).toBe(false);
  });

  it("no group's mutate list reaches a test file, and every directory group says so itself (review I11a)", () => {
    let checked = 0;
    let positives = 0;
    for (const [g, globs] of Object.entries(STRYKER_GROUPS)) {
      const pos = globs.filter((x) => !x.startsWith("!"));
      const files = expand(globs);
      // EACH positive entry must match a file, not just the group's total (review 4, R4-m5)
      for (const p of pos) expect(globSync([p], { cwd: ENGINE }).length, `${g}: ${p} matches no file`).toBeGreaterThan(0);
      checked += files.length;
      positives += pos.length;
      expect(files.filter((f) => /\.test\.ts$|__tests__/.test(f)), g).toEqual([]);
      // a glob group carries the negations itself (Stryker reads `mutate`, not this test's filter)
      if (pos.some((p) => p.includes("*"))) {
        expect(globs, `${g} negations`).toEqual(expect.arrayContaining(["!src/**/*.test.ts", "!src/**/__tests__/**"]));
        expect(globs.slice(pos.length), `${g}: negations come after every positive`).toEqual(globs.filter((x) => x.startsWith("!")));
      }
    }
    // the bound comes from the groups themselves, not a typed number
    expect(positives).toBeGreaterThan(Object.keys(STRYKER_GROUPS).length);
    expect(checked).toBeGreaterThanOrEqual(positives);
    expect(Object.keys(STRYKER_GROUPS).length).toBeGreaterThan(1);
  });

  it("the negations are what keep test files out: without them the same positives DO reach test files (the guard has something to guard)", () => {
    let reached = 0;
    for (const globs of Object.values(STRYKER_GROUPS)) {
      const pos = globs.filter((x) => !x.startsWith("!"));
      reached += globSync(pos, { cwd: ENGINE }).filter((f) => /\.test\.ts$|__tests__/.test(f)).length;
    }
    expect(reached, "co-located tests exist under the grouped directories").toBeGreaterThan(0);
  });

  it("the group names are ruling 66's ten plus the probe, plus the one carve-out the dry run forced, in declaration order (the dispatch choices test is order-sensitive)", () => {
    expect(Object.keys(STRYKER_GROUPS)).toEqual([
      "competition", "core", "modules", "draws", "sports-cricket", "sports-cricket-kernel", "sports-football", "sports-period", "sports-setbased", "sports-nested", "sports-other", "probe",
    ]);
  });

  it("cricket.ts is carved out of sports-cricket into its own group: the other cricket files, and any new one, stay in sports-cricket (the dry run's mutant count put the family over the split line)", () => {
    expect(STRYKER_GROUPS["sports-cricket-kernel"]).toEqual(["src/sports/cricket/cricket.ts"]);
    expect(existsSync(join(ENGINE, "src/sports/cricket/cricket.ts"))).toBe(true);
    const rest = expand(STRYKER_GROUPS["sports-cricket"]);
    expect(rest).not.toContain("src/sports/cricket/cricket.ts");
    // the rest is what is in the directory besides it and the tests
    const all = universe().filter((f) => f.startsWith("src/sports/cricket/"));
    expect(all.length).toBeGreaterThan(1);
    expect(rest.slice().sort()).toEqual(all.filter((f) => f !== "src/sports/cricket/cricket.ts").sort());
  });

  it("the sports groups split src/sports/ by family: every sport directory is in exactly one of them, and the top-level files are in sports-other", () => {
    const dirs = new Set(readdirSync(join(ENGINE, "src/sports"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
    expect(dirs.size).toBeGreaterThan(5);
    const sports = Object.entries(STRYKER_GROUPS).filter(([g]) => g.startsWith("sports-"));
    expect(sports.length).toBe(7); // ruling 66's six, plus the cricket.ts carve-out
    for (const d of dirs) {
      const owners = sports.filter(([, globs]) => globs.some((x) => x === `src/sports/${d}/**/*.ts`)).map(([g]) => g);
      expect(owners, `src/sports/${d}/`).toHaveLength(1);
    }
    const topLevel = globSync("src/sports/*.ts", { cwd: ENGINE }).filter((f) => !/\.test\.ts$/.test(f));
    expect(topLevel.length).toBeGreaterThan(0);
    expect(expand(STRYKER_GROUPS["sports-other"])).toEqual(expect.arrayContaining(topLevel));
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
  it("the five exports, no more and no fewer", () => {
    const declared = [...dts.matchAll(/^export (?:declare )?(?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
    expect(declared).toEqual(["STRYKER_EXCLUDED", "STRYKER_GROUPS", "STRYKER_PLACEMENT_OUT_OF_SCOPE", "STRYKER_VITEST_WORKERS", "strykerConcurrency"]);
    expect(Object.keys(groupsModule).sort()).toEqual(declared);
  });
  it("the group-name union in the declaration is STRYKER_GROUPS's keys, in order", () => {
    const union = /STRYKER_GROUPS: Record<([^,]+),/.exec(dts)?.[1];
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
    for (const g of names) {
      const c = configs[g]!;
      expect(c.mutate, g).toEqual(STRYKER_GROUPS[g as keyof typeof STRYKER_GROUPS]);
      expect(c.incrementalFile, g).toBe(`reports/mutation/${g}.incremental.json`);
      expect(c.jsonReporter, g).toEqual({ fileName: `reports/mutation/${g}.json` });
      expect(c.incremental, g).toBe(true);
      expect(c.testRunner, g).toBe("vitest");
      // Stryker's runner ignores this and always uses perTest; the config states what it gets
      expect(c.coverageAnalysis, g).toBe("perTest");
      // the floor file gates (D14), never Stryker's own break
      expect(c.thresholds, g).toMatchObject({ break: null });
      expect(c.concurrency, g).toBeGreaterThanOrEqual(1);
    }
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
