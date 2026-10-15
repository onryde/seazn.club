// Engine-split Task 1b-3 (D14). pack-proof/run.mjs is the end-to-end proof (a packed tarball consumed from outside the repo by
// Node, Next, Metro+Hermes and tsc, in CI's `engine-pack` job). It needs the network and minutes, so it is not run here. What IS
// held here, with no network, is every decision inside it that could quietly stop being a decision: the scratch directory is
// refused when it is inside the repo, a fixture that checked nothing is a failure, the tarball's exports are judged for
// source/dangling targets, the right pnpm is picked, and the Metro module count is read from a bundle that actually parses.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertBundleMatchesWalk,
  assertExactVersions,
  assertOutsideRepo,
  assertPhoneRuleGreen,
  assertSameSet,
  checkTarballExports,
  DATA_EXPORTS,
  declaredAppRoutes,
  devBundleModules,
  distTwin,
  engineDistPaths,
  engineModules,
  exportSpecifiers,
  installSignalCleanup,
  installedVersion,
  phoneSpecifiers,
  pickPnpm,
  requireChecked,
  runFixtures,
  sourceSportDirs,
  sportDirsOf,
} from "../pack-proof/lib.mjs";
import { checkPhoneClosure, checkPhoneSafety, phoneClosureDrift } from "../scripts/engine-boundary.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { FLOOR_MS, treeBudget } from "./tree-budget.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ENGINE, "..", "..");
const PROOF = join(ENGINE, "pack-proof");
const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, string | Record<string, string>> };
  scripts: Record<string, string>;
};
const FIXTURES = ["next", "node", "rn", "types"];

const scratch = () => mkdtempSync(join(tmpdir(), "pack-proof-test-"));

describe("assertOutsideRepo: a scratch directory inside the repo proves nothing", () => {
  it("refuses the repo, a directory inside it, and a symlink from outside that points into it", () => {
    const t = scratch();
    try {
      mkdirSync(join(t, "repo", "sub"), { recursive: true });
      symlinkSync(join(t, "repo", "sub"), join(t, "link"));
      for (const dir of [join(t, "repo"), join(t, "repo", "sub"), join(t, "link")]) {
        expect(() => assertOutsideRepo(dir, join(t, "repo")), dir).toThrow(/inside the repo/);
      }
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("accepts a sibling whose name merely starts with the repo's (a prefix is not containment), and the real tmpdir", () => {
    const t = scratch();
    try {
      mkdirSync(join(t, "repo"));
      mkdirSync(join(t, "repo-other"));
      expect(() => assertOutsideRepo(join(t, "repo-other"), join(t, "repo"))).not.toThrow();
      // the control against the real repo: os.tmpdir() is outside it, or this whole proof could never run
      expect(() => assertOutsideRepo(t, REPO)).not.toThrow();
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("requireChecked: zero checked is a failure", () => {
  it.each([0, -1, 1.5, Number.NaN, undefined, "3", null])("refuses %s", (n) => {
    expect(() => requireChecked("fx", n)).toThrow(/fx: .* checked/);
  });
  it("passes a positive integer through", () => {
    expect(requireChecked("fx", 1)).toBe(1);
    expect(requireChecked("fx", 46)).toBe(46);
  });
});

// The tarball as pnpm packs it: the manifest's publishConfig.exports promoted to `exports`, every target present. `files` is built
// from the manifest the test hands in, with the `*` pattern expanded over the sport directories that have an index on disk.
const sportDirs = readdirSync(join(ENGINE, "src", "sports"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ENGINE, "src", "sports", d.name, "index.ts")))
  .map((d) => d.name);
type Exports = Record<string, string | Record<string, string>>;
const targetsOf = (exp: Exports) => Object.values(exp).flatMap((c) => (typeof c === "string" ? [c] : Object.values(c)));
const filesFor = (exp: Exports) =>
  new Set(targetsOf(exp).flatMap((t) => (t.includes("*") ? sportDirs.map((d) => t.replace("*", d).slice(2)) : [t.slice(2)])));
const keys = Object.keys(pkg.exports);
// what the engine DECLARES: a data export is a plain string in the published manifest, a module is a conditions object
const dataKeys = Object.keys(pkg.publishConfig.exports).filter((k) => typeof pkg.publishConfig.exports[k] === "string");
const moduleKeys = keys.filter((k) => !dataKeys.includes(k));
const declaredTargets = Object.values(pkg.publishConfig.exports).reduce((n, v) => n + (typeof v === "string" ? 1 : Object.keys(v).length), 0);

describe("checkTarballExports", () => {
  const packed = pkg.publishConfig.exports;

  it("passes the engine's own publishConfig.exports and counts every target (two conditions per module export, one per data export)", () => {
    expect(sportDirs.length).toBeGreaterThan(0);
    expect(moduleKeys.length).toBeGreaterThan(10);
    expect(dataKeys, "the engine declares its phone pin as a data export").toEqual(["./phone-subpaths.json"]);
    expect(declaredTargets).toBe(moduleKeys.length * 2 + dataKeys.length);
    expect(checkTarballExports({ manifest: { exports: packed }, files: filesFor(packed), expectedKeys: keys })).toBe(declaredTargets);
  });

  it("holds the data exports to their file: present in the tarball, named exactly, and only as a plain string", () => {
    const key = "./phone-subpaths.json";
    expect([...DATA_EXPORTS.keys()]).toEqual([key]);
    const files = filesFor(packed);
    // present: the control for the three refusals below
    expect(files.has("phone-subpaths.json")).toBe(true);
    expect(checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toBe(declaredTargets);
    // the tarball lacks the file: a dangling data export, named
    const without = new Set(files);
    without.delete("phone-subpaths.json");
    expect(() => checkTarballExports({ manifest: { exports: packed }, files: without, expectedKeys: keys })).toThrow(/exports\["\.\/phone-subpaths\.json"\]: "\.\/phone-subpaths\.json" is not in the tarball \(a dangling export\)/);
    expect(() => checkTarballExports({ manifest: { exports: packed }, files: without, expectedKeys: keys, where: "dist/" })).toThrow(/is not in dist\//);
    // named any other way: the wrong file, a path under dist/, a conditions object
    for (const bad of ["./other.json", "./dist/phone-subpaths.json", { default: "./phone-subpaths.json" }]) {
      expect(() => checkTarballExports({ manifest: { exports: { ...packed, [key]: bad } }, files, expectedKeys: keys }), JSON.stringify(bad)).toThrow(/expected the plain string "\.\/phone-subpaths\.json"/);
    }
    // the key itself is part of the compared key set
    const gone = Object.fromEntries(Object.entries(packed).filter(([k]) => k !== key));
    expect(() => checkTarballExports({ manifest: { exports: gone }, files, expectedKeys: keys })).toThrow(/missing \[\.\/phone-subpaths\.json\]/);
    // a valid data export makes up for no module: every module key empty is "checked nothing" even though one data target is judged
    const hollow = Object.fromEntries(Object.entries(packed).map(([k, v]) => [k, typeof v === "string" ? v : {}]));
    expect(() => checkTarballExports({ manifest: { exports: hollow }, files, expectedKeys: keys })).toThrow(/module exports: 0 checked - a fixture that checked nothing/);
    // and a data export does not excuse a module: the workspace's own exports still point at source
    expect(() => checkTarballExports({ manifest: { exports: pkg.exports }, files, expectedKeys: keys })).toThrow(/points at source/);
  });

  it("refuses what `npm pack` ships: the workspace exports, pointing at ./src/*.ts", () => {
    expect(() => checkTarballExports({ manifest: { exports: pkg.exports }, files: new Set(), expectedKeys: keys })).toThrow(/points at source/);
    // a `.ts` that is not a declaration file, and a src segment under dist/-looking text, are source too
    for (const target of ["./dist/core/index.ts", "./dist/src/core/index.js"]) {
      const bad = { "./core": { types: "./dist/core/index.d.ts", default: target } };
      expect(() => checkTarballExports({ manifest: { exports: bad }, files: new Set(["dist/core/index.d.ts", target.slice(2)]), expectedKeys: ["./core"] }), target).toThrow(/points at source/);
    }
  });

  it("accepts a .d.ts as a types target (the control for the .ts refusal above)", () => {
    const ok = { "./core": { types: "./dist/core/index.d.ts", default: "./dist/core/index.js" } };
    expect(checkTarballExports({ manifest: { exports: ok }, files: new Set(["dist/core/index.d.ts", "dist/core/index.js"]), expectedKeys: ["./core"] })).toBe(2);
  });

  it("refuses a dangling target, naming it, and says where it looked", () => {
    const files = filesFor(packed);
    files.delete("dist/core/index.js");
    expect(() => checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toThrow(/dist\/core\/index\.js" is not in the tarball \(a dangling export\)/);
    expect(() => checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys, where: "dist/" })).toThrow(/is not in dist\//);
  });

  it("refuses an empty dist: every export dangles", () => {
    expect(() => checkTarballExports({ manifest: { exports: packed }, files: new Set(), expectedKeys: keys })).toThrow(/dangling/);
  });

  it("refuses a `*` pattern that matches no file; a match is any non-empty string, slashes included (a Node subpath pattern)", () => {
    const files = filesFor(packed);
    for (const f of [...files]) if (f.startsWith("dist/sports/") && f.split("/").length === 4) files.delete(f);
    expect(() => checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toThrow(/pattern .* matches no file/);
    // `dist/sports//index.js` (an empty `*`) is no match; a nested directory is one
    files.add("dist/sports/index.d.ts");
    expect(() => checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toThrow(/pattern .* matches no file/);
    files.add("dist/sports/a/b/index.js");
    files.add("dist/sports/a/b/index.d.ts");
    expect(checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toBe(declaredTargets);
  });

  it("refuses a manifest whose export keys differ from the workspace's, either way", () => {
    const missing = Object.fromEntries(Object.entries(packed).filter(([k]) => k !== "./stats"));
    expect(() => checkTarballExports({ manifest: { exports: missing }, files: filesFor(packed), expectedKeys: keys })).toThrow(/missing \[\.\/stats\]/);
    const extra = { ...packed, "./extra": { default: "./dist/core/index.js" } };
    expect(() => checkTarballExports({ manifest: { exports: extra }, files: filesFor(packed), expectedKeys: keys })).toThrow(/extra \[\.\/extra\]/);
  });

  it("refuses a target outside dist/, no exports at all, and no expected keys to compare against", () => {
    const outside = { "./core": { default: "./lib/index.js" } };
    expect(() => checkTarballExports({ manifest: { exports: outside }, files: new Set(["lib/index.js"]), expectedKeys: ["./core"] })).toThrow(/outside dist/);
    expect(() => checkTarballExports({ manifest: {}, files: new Set(), expectedKeys: ["./core"] })).toThrow(/no exports/);
    expect(() => checkTarballExports({ manifest: { exports: {} }, files: new Set(), expectedKeys: ["./core"] })).toThrow(/no exports/);
    expect(() => checkTarballExports({ manifest: { exports: packed }, files: filesFor(packed), expectedKeys: [] })).toThrow(/no expected export keys/);
  });
});

describe("pickPnpm: the repo's pin, asked from where the fixtures run it", () => {
  const bare = { label: "pnpm", command: "pnpm", prefix: [] as string[] };
  const viaCorepack = { label: "corepack pnpm@10.34.5", command: "corepack", prefix: ["pnpm@10.34.5"] };

  it("skips a global pnpm of another version and takes the candidate that reports the pin", () => {
    const asked: string[] = [];
    const got = pickPnpm("10.34.5", [bare, viaCorepack], (c) => {
      asked.push(c.label);
      return c.command === "pnpm" ? "11.17.0\n" : "10.34.5\n";
    });
    expect(got.label).toBe(viaCorepack.label);
    expect(got.version).toBe("10.34.5");
    expect(asked).toEqual(["pnpm", viaCorepack.label]);
  });

  it("takes the first candidate when it already is the pin (CI's pnpm/action-setup), without asking the second", () => {
    const asked: string[] = [];
    expect(pickPnpm("10.34.5", [bare, viaCorepack], (c) => (asked.push(c.label), "10.34.5")).label).toBe("pnpm");
    expect(asked).toEqual(["pnpm"]);
  });

  it("treats a candidate that throws as unavailable, and names every version it saw when none match", () => {
    const attempt = () =>
      pickPnpm("10.34.5", [bare, viaCorepack], (c) => {
        if (c.command === "corepack") throw new Error("corepack: command not found");
        return "11.17.0";
      });
    expect(attempt).toThrow(/no pnpm 10\.34\.5 is available outside the repo/);
    expect(attempt).toThrow(/pnpm: 11\.17\.0/);
    expect(attempt).toThrow(/corepack pnpm@10\.34\.5: unavailable \(corepack: command not found\)/);
    expect(() => pickPnpm("10.34.5", [], () => "10.34.5")).toThrow(/no pnpm 10\.34\.5/);
  });

  it("does not accept a near version (10.34.50, 10.34)", () => {
    expect(() => pickPnpm("10.34.5", [bare], () => "10.34.50")).toThrow();
    expect(() => pickPnpm("10.34.5", [bare], () => "10.34")).toThrow();
  });
});

describe("the Metro dev bundle reader", () => {
  // the shape Metro 0.84 emits: __d(function (...) { ... },<id>,[<deps>],"<path>");
  const mod = (id: number, deps: number[], p: string) => `__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, module, exports, _dependencyMap) {\n  var x = 1;\n},${id},[${deps.join(",")}],"${p}");`;
  const bundle = [
    mod(0, [1], "index.js"),
    mod(1, [], "node_modules/.pnpm/@onryde+seazn-engine@file+x/node_modules/@onryde/seazn-engine/dist/core/index.js"),
    mod(2, [], "node_modules/@seazn/engine/dist/sport/index.js"),
    "__r(0);",
  ].join("\n");

  it("reads every module path, one per __d( definition", () => {
    expect(devBundleModules(bundle)).toEqual([
      "index.js",
      "node_modules/.pnpm/@onryde+seazn-engine@file+x/node_modules/@onryde/seazn-engine/dist/core/index.js",
      "node_modules/@seazn/engine/dist/sport/index.js",
    ]);
  });

  it("refuses a bundle with no definitions, and one where a definition's path cannot be read (the pattern went stale)", () => {
    expect(() => devBundleModules("__r(0);")).toThrow(/no __d\( module definition/);
    expect(() => devBundleModules(`${bundle}\n__d(function () {},3,[],);`)).toThrow(/4 __d\( definitions but 3 readable/);
  });

  it("counts the engine's modules under either spelling, and nothing else", () => {
    const paths = [
      ...devBundleModules(bundle),
      "node_modules/@seazn/engine/dist/core/index.js.map",
      "node_modules/@seazn/engine-extras/dist/x.js",
      "node_modules/zod/dist/x.js",
      "node_modules/@seazn/engine/src/x.js",
    ];
    expect(engineModules(paths, ["@seazn/engine", "@onryde/seazn-engine"])).toEqual([
      "node_modules/.pnpm/@onryde+seazn-engine@file+x/node_modules/@onryde/seazn-engine/dist/core/index.js",
      "node_modules/@seazn/engine/dist/sport/index.js",
    ]);
    expect(() => engineModules(paths, [])).toThrow(/at least one package name/);
  });
});

// Engine-split Task 1c-1: the rn leg imports the phone subpaths of phone-subpaths.json (not a list typed in run.mjs) and holds the Metro
// dev bundle to the static phone walk of scripts/engine-boundary.ts: the same modules, in their dist/ spelling, no more and no fewer.
// Single-sport reason: no sport is involved - this is a module-graph rule.
describe("the phone subpaths the rn leg imports", () => {
  const phone = JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { subpaths: string[] };
  const manifest = { exports: pkg.publishConfig.exports };

  it("are the listed subpaths, each a key of the packed manifest, with ./sports/* expanded over the source's sport directories", () => {
    const sportDirs = sourceSportDirs(ENGINE);
    const got = phoneSpecifiers({ subpaths: phone.subpaths, manifest, sportDirs });
    expect(sportDirs.length, "anti-vacuity: the sport directories").toBeGreaterThan(5);
    expect(got.length).toBe(phone.subpaths.filter((s) => !s.includes("*")).length + sportDirs.length);
    expect(got.slice(0, 3)).toEqual(["@seazn/engine/core", "@seazn/engine/sport", "@seazn/engine/sports"]);
    for (const d of sportDirs) expect(got).toContain(`@seazn/engine/sports/${d}`);
    expect(got.some((x) => x.includes("*"))).toBe(false);
  });

  it("honours the alias, keeps the list's order, and refuses what it cannot import: nothing, an unexported subpath, an unknown pattern", () => {
    const m = { exports: { "./a": {}, "./b/*": {}, "./sports/*": {} } };
    expect(phoneSpecifiers({ subpaths: ["./a", "./sports/*"], manifest: m, sportDirs: ["x", "y"], name: "pkg" })).toEqual(["pkg/a", "pkg/sports/x", "pkg/sports/y"]);
    expect(() => phoneSpecifiers({ subpaths: [], manifest: m, sportDirs: ["x"] })).toThrow(/lists no subpath/);
    expect(() => phoneSpecifiers({ subpaths: ["./nope"], manifest: m, sportDirs: ["x"] })).toThrow(/not an export/);
    expect(() => phoneSpecifiers({ subpaths: ["./b/*"], manifest: m, sportDirs: ["x"] })).toThrow(/no known expansion/);
    expect(() => phoneSpecifiers({ subpaths: ["./sports/*"], manifest: m, sportDirs: [] })).toThrow(/no sport directory/);
    expect(() => phoneSpecifiers({ subpaths: ["a"], manifest: { exports: { a: {} } }, sportDirs: ["x"] })).toThrow(/not a \.\/ subpath/);
    expect(() => phoneSpecifiers({ subpaths: ["./a"], manifest: {}, sportDirs: ["x"] })).toThrow(/not an export/);
  });
});

describe("the dev bundle is held to the static phone walk", () => {
  it("distTwin maps src/<path>.ts to dist/<path>.js and nothing else", () => {
    expect(distTwin("src/core/index.ts")).toBe("dist/core/index.js");
    expect(distTwin("src/sports/setbased/set.ts")).toBe("dist/sports/setbased/set.js");
    for (const bad of ["dist/core/index.js", "src/core/index.js", "core/index.ts", "lib/src/core/index.ts", "src/core/x.d.ts.map"]) expect(() => distTwin(bad), bad).toThrow(/not a src/);
  });

  it("engineDistPaths keeps the engine's modules under either spelling, as their dist/ paths", () => {
    const paths = [
      "index.js",
      "node_modules/.pnpm/@onryde+seazn-engine@file+x/node_modules/@onryde/seazn-engine/dist/core/index.js",
      "node_modules/@seazn/engine/dist/sport/index.js",
      "node_modules/zod/dist/x.js",
    ];
    expect(engineDistPaths(paths, ["@seazn/engine", "@onryde/seazn-engine"])).toEqual(["dist/core/index.js", "dist/sport/index.js"]);
  });

  const walked = ["src/core/index.ts", "src/core/a.ts", "src/sport/index.ts"];
  const bundle = ["dist/core/index.js", "dist/core/a.js", "dist/sport/index.js"];

  it("passes when the bundle holds exactly the walked modules (in any order) and reports how many", () => {
    expect(assertBundleMatchesWalk({ bundle, walked })).toBe(3);
    expect(assertBundleMatchesWalk({ bundle: [...bundle].reverse(), walked })).toBe(3);
  });

  it("refuses a walked module the bundle lacks, naming it, and a bundled module the walk never reached, naming it", () => {
    expect(() => assertBundleMatchesWalk({ bundle: bundle.slice(0, 2), walked })).toThrow(/absent from the dev bundle[\s\S]*dist\/sport\/index\.js/);
    expect(() => assertBundleMatchesWalk({ bundle: [...bundle, "dist/core/sneaky.js"], walked })).toThrow(/never walked[\s\S]*dist\/core\/sneaky\.js/);
    // either alone is a failure, and the message names only the side that is wrong
    expect(() => assertBundleMatchesWalk({ bundle: bundle.slice(0, 2), walked })).not.toThrow(/never walked/);
  });

  it("refuses an empty walk: a comparison against nothing is satisfied by nothing", () => {
    expect(() => assertBundleMatchesWalk({ bundle: [], walked: [] })).toThrow(/empty/);
  });

  // The compiler's own account of the build, read from tsconfig.build.json: what tsc would emit (getOutputFileNames) and, file by file, what the
  // emitted JavaScript imports (transpileModule, which elides an import used only as a type, as the build does). Neither goes through distTwin
  // or through the static walk, so a walk that follows an import the build erases, or misses one it keeps, cannot agree with them by construction.
  const build = (() => {
    const read = ts.readConfigFile(join(ENGINE, "tsconfig.build.json"), ts.sys.readFile);
    expect(read.error, "tsconfig.build.json parses").toBeUndefined();
    return ts.parseJsonConfigFileContent(read.config, ts.sys, ENGINE, undefined, join(ENGINE, "tsconfig.build.json"));
  })();
  const emittedJs = (): Set<string> => {
    const out = new Set<string>();
    for (const file of build.fileNames) {
      for (const o of ts.getOutputFileNames(build, file, false)) if (o.endsWith(".js")) out.add(relative(ENGINE, o).split(sep).join("/"));
    }
    return out;
  };
  /** The dist/ modules reachable from `entries` through the imports of the emitted JavaScript, by emitting each source file in memory. */
  const emittedClosure = (entries: readonly string[]): string[] => {
    const seen = new Set<string>();
    const queue = entries.map((e) => e.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
    while (queue.length > 0) {
      const dist = queue.shift()!;
      if (seen.has(dist)) continue;
      seen.add(dist);
      const srcFile = dist.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      const js = ts.transpileModule(readFileSync(join(ENGINE, srcFile), "utf8"), { compilerOptions: build.options, fileName: srcFile }).outputText;
      const sf = ts.createSourceFile(dist, js, ts.ScriptTarget.ESNext, true);
      const follow = (spec: string) => {
        if (spec.startsWith(".")) queue.push(posix.join(posix.dirname(dist), spec));
      };
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) follow(n.moduleSpecifier.text);
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) follow(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return [...seen].sort();
  };

  // The compiler's account of the real build is made ONCE (the emit list of every source file, then the emitted JavaScript of each phone module
  // in memory) and shared by the three tests below. Its budget follows the files it touches: the build's file list, and the phone modules
  // transpiled and re-parsed.
  const BUILD_MS = treeBudget(build.fileNames.length, 2);
  let real: ReturnType<typeof checkPhoneClosure>;
  let walk: ReturnType<typeof checkPhoneSafety>;
  let emitted: Set<string>;
  let emittedBundle: string[];
  beforeAll(() => {
    walk = checkPhoneSafety(ENGINE);
    real = checkPhoneClosure(ENGINE);
    emitted = emittedJs();
    emittedBundle = emittedClosure(real.entries);
  }, BUILD_MS);

  it("holds against the real engine: every walked module's dist/ twin is a file tsc's build emits (tsconfig.build.json), and a test file is not", () => {
    expect(emitted.size, "anti-vacuity: the files the build emits").toBeGreaterThan(100);
    expect(walk.walked.length, "anti-vacuity: the modules checked").toBeGreaterThan(30);
    for (const src of walk.walked) expect(emitted, `${src} -> ${distTwin(src)}`).toContain(distTwin(src));
    // the emit list can say no: a source file the build excludes has no twin in it
    const aTest = globSync("src/**/*.test.ts", { cwd: ENGINE })[0];
    expect(aTest, "the engine has a co-located test").toBeDefined();
    expect(emitted.has(distTwin(aTest!))).toBe(false);
  });

  it("holds against the real engine: the modules the emitted JavaScript imports, from the phone entries, are exactly the walked modules", () => {
    expect(real.violations).toEqual([]);
    const bundle = emittedBundle;
    expect(bundle.length, "anti-vacuity: the emitted closure").toBeGreaterThan(30);
    // assertBundleMatchesWalk names the module either side lacks; the count it returns is the pinned closure's
    const pinned = (JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { closure: { modules: string[] } }).closure.modules;
    expect(assertBundleMatchesWalk({ bundle, walked: real.walked })).toBe(pinned.length);
    expect(phoneClosureDrift(real.walked, pinned), "the phone closure drifted from the pin").toBeNull();
  });

  it("the emitted-closure check can fail: a walk with a module added or dropped disagrees with it", () => {
    const bundle = emittedBundle;
    expect(bundle.length, "anti-vacuity: the emitted closure").toBeGreaterThan(30);
    expect(() => assertBundleMatchesWalk({ bundle, walked: walk.walked.slice(1) })).toThrow(/never walked/);
    expect(() => assertBundleMatchesWalk({ bundle, walked: [...walk.walked, "src/core/not-a-module.ts"] })).toThrow(/absent from the dev bundle/);
  });

  it("assertPhoneRuleGreen passes a clean walk, and refuses any violation (the closure-changed one included) and an empty walk", () => {
    const walked = ["src/core/index.ts"];
    expect(assertPhoneRuleGreen({ walked, violations: [] })).toBe(1);
    expect(() => assertPhoneRuleGreen({ walked, violations: [{ kind: "node-builtin", file: "src/core/index.ts", detail: "line 1: imports node:fs" }] })).toThrow(/rule is red[\s\S]*src\/core\/index\.ts node-builtin: line 1/);
    expect(() => assertPhoneRuleGreen({ walked, violations: [{ kind: "closure-changed", file: "phone-subpaths.json", detail: "1 module(s) added: x" }] })).toThrow(/closure-changed: 1 module\(s\) added/);
    expect(() => assertPhoneRuleGreen({ walked: [], violations: [] })).toThrow(/visited no module/);
    expect(() => assertPhoneRuleGreen({} as never)).toThrow(/report/);
  });

  // run.mjs is not importable (it runs on load), so its wiring is read from its SYNTAX: the rn leg must, as unconditional top-level statements
  // of rnFixture and in this order, take the combined phone check (walk + pin), assert it green, and later compare the bundle to the walk it
  // took. A text search would pass `if (false) assertPhoneRuleGreen(phone)` and `phone.violations.length > 0 && false`; this does not.
  const rnLegProblems = (source: string): string[] => {
    const sf = ts.createSourceFile("run.mjs", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const fn = sf.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "rnFixture");
    if (!fn?.body) return ["rnFixture is not a function declaration with a body"];
    const unwrap = (e: ts.Expression): ts.Expression => (ts.isAwaitExpression(e) ? unwrap(e.expression) : ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
    const flat = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ");
    const steps: { bound: string | null; callee: string; args: string[] }[] = [];
    for (const st of fn.body.statements) {
      const call = (e: ts.Expression | undefined, bound: string | null) => {
        const c = e && unwrap(e);
        if (c && ts.isCallExpression(c)) steps.push({ bound, callee: c.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : flat(c.expression), args: c.arguments.map(flat) });
      };
      if (ts.isExpressionStatement(st)) call(st.expression, null);
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) call(d.initializer, flat(d.name));
    }
    const at = (pred: (s: (typeof steps)[number]) => boolean) => steps.findIndex(pred);
    const problems: string[] = [];
    const takeAt = at((s) => s.bound === "phone" && s.callee === "checkPhoneClosure" && s.args.join(",") === "ENGINE");
    const assertAt = at((s) => s.bound === null && s.callee === "assertPhoneRuleGreen" && s.args.join(",") === "phone");
    const engineAt = at((s) => s.bound === "engine" && s.callee === "engineDistPaths");
    const compareAt = at((s) => s.callee === "assertBundleMatchesWalk" && s.args.join(",") === "{ bundle: engine, walked: phone.walked }");
    if (at((s) => s.bound === "{ checkPhoneClosure }" && s.callee === "import") === -1) problems.push("rnFixture does not import checkPhoneClosure as a top-level statement");
    if (takeAt === -1) problems.push("rnFixture does not take `const phone = checkPhoneClosure(ENGINE)` as a top-level statement");
    if (assertAt === -1) problems.push("rnFixture does not call assertPhoneRuleGreen(phone) as a top-level statement");
    if (engineAt === -1) problems.push("rnFixture does not take `const engine = engineDistPaths(...)` as a top-level statement");
    if (compareAt === -1) problems.push("rnFixture does not call assertBundleMatchesWalk({ bundle: engine, walked: phone.walked }) as a top-level statement");
    if ([takeAt, assertAt, engineAt, compareAt].every((i) => i !== -1) && !(takeAt < assertAt && assertAt < compareAt && engineAt < compareAt)) problems.push("rnFixture's phone check, assertion and bundle comparison are out of order");
    return problems;
  };

  it("run.mjs's rn leg takes the combined phone check, asserts it green, and compares the dev bundle to the walk - as top-level statements, in order", () => {
    const real = readFileSync(join(PROOF, "run.mjs"), "utf8");
    expect(rnLegProblems(real)).toEqual([]);
    expect(real, "the 1b-3 interim floor is gone").not.toContain("RN_ENGINE_MODULE_FLOOR");
    const code = real.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).toContain('readJson(path.join(ENGINE, "phone-subpaths.json"))');
    expect(code).toContain("phoneSpecifiers({ subpaths,");
  });

  it.each([
    ["the assertion guarded by a constant", "assertPhoneRuleGreen(phone);", "if (false) assertPhoneRuleGreen(phone);"],
    ["the assertion short-circuited", "assertPhoneRuleGreen(phone);", "assertPhoneRuleGreen(phone) && false;"],
    ["the assertion commented out", "assertPhoneRuleGreen(phone);", "// assertPhoneRuleGreen(phone);"],
    ["the assertion on a copy", "assertPhoneRuleGreen(phone);", "assertPhoneRuleGreen({ ...phone, violations: [] });"],
    ["the pin dropped (the plain walk instead of the combined check)", "const phone = checkPhoneClosure(ENGINE);", "const phone = checkPhoneSafety(ENGINE);"],
    ["the comparison against an empty walk", "walked: phone.walked }", "walked: [] }"],
    ["the comparison against the wrong list", "bundle: engine, walked", "bundle: paths, walked"],
    ["the comparison made conditional", "const agreed = assertBundleMatchesWalk(", "const agreed = false && assertBundleMatchesWalk("],
  ])("the wiring check sees %s", (_label, find, replace) => {
    const real = readFileSync(join(PROOF, "run.mjs"), "utf8");
    expect(real.split(find).length - 1, `${find} appears once in run.mjs`).toBe(1);
    expect(rnLegProblems(real.replace(find, replace)).length).toBeGreaterThan(0);
  });

  it("the wiring check sees the assertion moved after the comparison", () => {
    const real = readFileSync(join(PROOF, "run.mjs"), "utf8");
    const assertion = "  assertPhoneRuleGreen(phone);\n";
    expect(real.split(assertion).length - 1).toBe(1);
    const afterCompare = "  info(`rn: the dev bundle holds exactly"; // the line after the comparison
    expect(real.split(afterCompare).length - 1).toBe(1);
    const moved = real.replace(assertion, "").replace(afterCompare, `${assertion}${afterCompare}`);
    expect(rnLegProblems(moved)).toEqual(["rnFixture's phone check, assertion and bundle comparison are out of order"]);
  });
});

describe("runFixtures: every fixture runs, and only a positive count passes", () => {
  it("collects every failure instead of stopping at the first, logs only the passes, and rejects zero", async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const fixtures = {
      ok: () => (ran.push("ok"), 3),
      zero: () => (ran.push("zero"), 0),
      boom: () => {
        ran.push("boom");
        throw new Error("exploded");
      },
      late: async () => (ran.push("late"), 7),
    };
    const { results, failures } = await runFixtures(["ok", "zero", "boom", "late", "missing"], fixtures, {}, (l) => log.push(l));
    expect(ran).toEqual(["ok", "zero", "boom", "late"]);
    expect(results).toEqual([{ name: "ok", n: 3 }, { name: "late", n: 7 }]);
    expect(log).toEqual(["ok: 3 checked", "late: 7 checked"]);
    expect(failures.map((f) => [f.name, f.error.message.split("\n")[0]])).toEqual([
      ["zero", "zero: 0 checked - a fixture that checked nothing is a failure, not a pass"],
      ["boom", "exploded"],
      ["missing", "no fixture named missing"],
    ]);
  });

  it("hands each fixture the shared context", async () => {
    const ctx = { tarball: "t.tgz" };
    const { results } = await runFixtures(["a"], { a: (c: typeof ctx) => c.tarball.length }, ctx, () => undefined);
    expect(results).toEqual([{ name: "a", n: 5 }]);
  });
});

describe("exportSpecifiers: the proof imports every key and every sport directory", () => {
  const srcDirs = sourceSportDirs(ENGINE);
  // the data exports hold no module, so they are not specifiers a fixture can import
  const nonPattern = moduleKeys.filter((k) => !k.includes("*"));

  it("lists each non-pattern module export plus each sport directory with an index, and no data export (the engine's own declarations, counted)", () => {
    const got = exportSpecifiers({ manifest: { exports: pkg.publishConfig.exports }, sportDirs: srcDirs });
    expect(srcDirs.length).toBeGreaterThan(0);
    expect(nonPattern.length).toBeGreaterThan(0);
    expect(got.length).toBe(nonPattern.length + srcDirs.length);
    expect(new Set(got).size).toBe(got.length);
    for (const k of nonPattern) expect(got, k).toContain(`@seazn/engine/${k.slice(2)}`);
    for (const d of srcDirs) expect(got, d).toContain(`@seazn/engine/sports/${d}`);
    // the pattern itself is never a specifier, and neither is the data file
    expect(got.some((x) => x.includes("*"))).toBe(false);
    expect(got.some((x) => x.endsWith(".json")), "a data export is not importable as a module").toBe(false);
    expect(keys.length - got.length, "keys not listed: the pattern and the data exports, the pattern expanded to its directories").toBe(1 + dataKeys.length - srcDirs.length);
  });

  it("refuses a pattern it cannot expand, a `*` with no directory, an empty manifest, and a key that is not a subpath", () => {
    const base = { "./core": { default: "./dist/core/index.js" } };
    expect(() => exportSpecifiers({ manifest: { exports: { ...base, "./other/*": {} } }, sportDirs: ["a"] })).toThrow(/no known expansion/);
    expect(() => exportSpecifiers({ manifest: { exports: { ...base, "./sports/*": {} } }, sportDirs: [] })).toThrow(/no sport directory/);
    expect(() => exportSpecifiers({ manifest: { exports: {} }, sportDirs: ["a"] })).toThrow(/no exports/);
    expect(() => exportSpecifiers({ manifest: {}, sportDirs: ["a"] })).toThrow(/no exports/);
    expect(() => exportSpecifiers({ manifest: { exports: { core: {} } }, sportDirs: ["a"] })).toThrow(/not a \.\/ subpath/);
  });

  it("honours the alias name, and expands the pattern in the directories' order", () => {
    expect(exportSpecifiers({ manifest: { exports: { "./core": {}, "./sports/*": {} } }, sportDirs: ["x", "y"], name: "pkg" })).toEqual(["pkg/core", "pkg/sports/x", "pkg/sports/y"]);
  });
});

// pack-proof/node/strip.ts is the consumer that imports every export of the INSTALLED package. A data export (a plain string, like the
// phone pin) is not a module: `import()` of it without a JSON attribute throws, so strip.ts must tell the two apart by the installed
// manifest, and read the data with the attribute. Run here, for real, against a small fake install - no network, no pnpm.
describe("pack-proof/node/strip.ts: a data export is read as data, not imported as a module", () => {
  it("imports each module export and sport directory, skips the data export in that list, and prints the data it read through the exports map", () => {
    const t = scratch();
    try {
      const install = join(t, "node_modules", "@seazn", "engine");
      const write = (rel: string, content: string) => {
        mkdirSync(dirname(join(install, rel)), { recursive: true });
        writeFileSync(join(install, rel), content);
      };
      write("package.json", JSON.stringify({
        name: "@seazn/engine",
        type: "module",
        exports: {
          "./core": { default: "./dist/core/index.js" },
          "./sports": { default: "./dist/sports/index.js" },
          "./sports/*": { default: "./dist/sports/*/index.js" },
          "./testkit": { default: "./dist/testkit/index.js" },
          "./pin.json": "./pin.json",
        },
      }));
      write("pin.json", JSON.stringify({ subpaths: ["./core"], closure: { modules: ["src/core/index.ts"] } }));
      write("dist/core/index.js", "export const core = 1;\n");
      write("dist/sports/index.js", "export const builtinModules = [{ key: 'x' }];\n");
      write("dist/sports/x/index.js", "export const x = 1;\n");
      write("dist/testkit/index.js", "export const kit = 1;\n");
      writeFileSync(join(t, "package.json"), JSON.stringify({ type: "module" }));
      // strip.ts finds the install from ITS OWN location, so it runs from a copy beside the fake one
      writeFileSync(join(t, "strip.ts"), readFileSync(join(PROOF, "node", "strip.ts"), "utf8"));
      const real = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "strip.ts", "core"], { cwd: t, encoding: "utf8", timeout: SPAWN_MS });
      expect(real.status, real.stdout + real.stderr).toBe(0);
      const specifiers = /^SPECIFIERS (\[.*\])$/m.exec(real.stdout)?.[1];
      expect(JSON.parse(specifiers ?? "null"), "the modules imported: core and sports, then the sport directories").toEqual(["@seazn/engine/core", "@seazn/engine/sports", "@seazn/engine/sports/x"]);
      const data = /^DATA (\{.*\})$/m.exec(real.stdout)?.[1];
      expect(JSON.parse(data ?? "null"), "the data export, read through the installed exports map").toEqual({ "@seazn/engine/pin.json": { subpaths: ["./core"], closure: { modules: ["src/core/index.ts"] } } });
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, spawnBudget(1));
});

describe("sport directories: the tarball's dist/sports must mirror the source's", () => {
  it("reads <dir> from dist/sports/<dir>/index.js only (not a .d.ts, a deeper index, a bare index or a sibling file)", () => {
    const files = ["dist/sports/b/index.js", "dist/sports/a/index.js", "dist/sports/a/index.d.ts", "dist/sports/c/d/index.js", "dist/sports/index.js", "dist/sports/period/suspensions.js", "src/sports/z/index.js"];
    expect(sportDirsOf(files)).toEqual(["a", "b"]);
    expect(sportDirsOf([])).toEqual([]);
  });

  it("reads the source's directories with an index.ts, and leaves out the one that has none", () => {
    const base = join(ENGINE, "src", "sports");
    const all = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const without = all.filter((d) => !existsSync(join(base, d, "index.ts")));
    const got = sourceSportDirs(ENGINE);
    expect(without.length, "a sport directory without an index (period/) is the control").toBeGreaterThan(0);
    for (const d of without) expect(got).not.toContain(d);
    expect(got.length).toBe(all.length - without.length);
    const t = scratch();
    try {
      mkdirSync(join(t, "src", "sports", "a"), { recursive: true });
      mkdirSync(join(t, "src", "sports", "b"), { recursive: true });
      writeFileSync(join(t, "src", "sports", "a", "index.ts"), "");
      writeFileSync(join(t, "src", "sports", "b", "other.ts"), "");
      writeFileSync(join(t, "src", "sports", "index.ts"), "");
      expect(sourceSportDirs(t)).toEqual(["a"]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("assertSameSet: equal in any order passes; a missing member, an extra one, a duplicate and an empty expectation each refuse", () => {
    expect(() => assertSameSet("x", ["b", "a"], ["a", "b"])).not.toThrow();
    expect(() => assertSameSet("x", ["a"], ["a", "b"])).toThrow(/x: missing \[b\], extra \[\]/);
    expect(() => assertSameSet("x", ["a", "b", "c"], ["a", "b"])).toThrow(/x: missing \[\], extra \[c\]/);
    expect(() => assertSameSet("x", ["a", "a", "b"], ["a", "b"])).toThrow(/duplicates/);
    expect(() => assertSameSet("x", [], [])).toThrow(/nothing to compare/);
    expect(() => assertSameSet("x", ["a"], [])).toThrow(/nothing to compare/);
  });
});

describe("declaredAppRoutes: only the routes the fixture declares are counted", () => {
  it("maps page and route files to Next's manifest keys, and ignores layouts and everything else", () => {
    expect(declaredAppRoutes(["layout.tsx", "page.tsx", "api/probe/route.ts", "api/probe/helper.ts", "x/page.jsx", "nested/deep/route.js", "x/loading.tsx", "page.css"])).toEqual(["/api/probe/route", "/nested/deep/route", "/page", "/x/page"]);
    expect(declaredAppRoutes([])).toEqual([]);
    expect(declaredAppRoutes(["layout.tsx"])).toEqual([]);
  });

  it("finds exactly the two routes the Next fixture declares (the page and /api/probe), never the framework's", () => {
    const files: string[] = [];
    const walk = (dir: string, rel = "") => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(join(dir, d.name), `${rel}${d.name}/`);
        else files.push(`${rel}${d.name}`);
      }
    };
    walk(join(PROOF, "next", "app"));
    expect(declaredAppRoutes(files)).toEqual(["/api/probe/route", "/page"]);
  });
});

describe("fixture pins: every version is exact, and comes from the repo", () => {
  it("assertExactVersions accepts x.y.z (and a pre-release) and the tarball's file: spec, and refuses every range", () => {
    expect(assertExactVersions("d", { zod: "4.4.3", a: "1.0.0-beta.1", "@seazn/engine": "file:/tmp/x.tgz" })).toBe(3);
    expect(assertExactVersions("d", undefined)).toBe(0);
    for (const bad of ["^4.4.3", "~4.4.3", "*", "latest", ">=4", "4.4", "4", "", "workspace:*", "npm:zod@4.4.3", "4.4.3 || 5"]) {
      expect(() => assertExactVersions("d", { zod: bad }), JSON.stringify(bad)).toThrow(/zod is .* not an exact x\.y\.z/);
    }
    // a file: spec is only the tarball's
    expect(() => assertExactVersions("d", { zod: "file:/tmp/x.tgz" })).toThrow(/not an exact/);
    expect(() => assertExactVersions("d", { "@seazn/engine": "^1.0.0" })).toThrow(/not an exact/);
  });

  it("installedVersion reads the installed package's version, and refuses a package that is absent or has no x.y.z", () => {
    const t = scratch();
    try {
      mkdirSync(join(t, "node_modules", "@types", "node"), { recursive: true });
      mkdirSync(join(t, "node_modules", "odd"), { recursive: true });
      writeFileSync(join(t, "node_modules", "@types", "node", "package.json"), JSON.stringify({ version: "26.1.2" }));
      writeFileSync(join(t, "node_modules", "odd", "package.json"), JSON.stringify({ version: "latest" }));
      expect(installedVersion(t, "@types/node")).toBe("26.1.2");
      expect(() => installedVersion(t, "absent")).toThrow(/absent is not installed/);
      expect(() => installedVersion(t, "odd")).toThrow(/expected x\.y\.z/);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
    // and the real ones the fixtures take
    for (const name of ["zod", "vitest", "fast-check", "@types/node"]) expect(installedVersion(ENGINE, name), name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the fixtures' own package.json files pin exactly (rn carries its whole toolchain), and rn's @babel/core is the version the repo pins", () => {
    let checked = 0;
    for (const f of FIXTURES) {
      const p = JSON.parse(readFileSync(join(PROOF, f, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      checked += assertExactVersions(`${f} dependencies`, p.dependencies);
      checked += assertExactVersions(`${f} devDependencies`, p.devDependencies);
    }
    expect(checked, "rn's react, react-native and tooling are the ones with literals").toBeGreaterThanOrEqual(9);
    const workspace = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
    const repoBabel = /"@babel\/helper-module-transforms@<8>@babel\/core": "(\d+\.\d+\.\d+)"/.exec(workspace)?.[1];
    expect(repoBabel, "the workspace's @babel/core 7 override").toBeDefined();
    const rn = JSON.parse(readFileSync(join(PROOF, "rn", "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(rn.devDependencies["@babel/core"]).toBe(repoBabel);
  });

  it("run.mjs takes no version from a manifest range", () => {
    const source = readFileSync(join(PROOF, "run.mjs"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(source).not.toMatch(/peerDependencies\.(zod|vitest|fast-check)|peerDependencies\[|devDependencies\[|webPkg\./);
  });
});

describe("installSignalCleanup", () => {
  const fakeProcess = () => {
    const proc = Object.assign(new EventEmitter(), { codes: [] as number[], exit(code: number) { this.codes.push(code); } });
    return proc;
  };

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s removes the scratch directory and exits %i, once", (signal, code) => {
    const t = scratch();
    const proc = fakeProcess();
    try {
      writeFileSync(join(t, "marker"), "x");
      installSignalCleanup({ dir: t, keep: () => false, proc });
      expect(proc.listenerCount("SIGINT")).toBe(1);
      expect(proc.listenerCount("SIGTERM")).toBe(1);
      proc.emit(signal);
      expect(existsSync(t)).toBe(false);
      expect(proc.codes).toEqual([code]);
      proc.emit(signal);
      expect(proc.codes, "the handler is `once`").toEqual([code]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("runs `before` first, while the directory still exists, and again for each signal only once", () => {
    const t = scratch();
    const proc = fakeProcess();
    const seen: boolean[] = [];
    try {
      installSignalCleanup({ dir: t, keep: () => false, before: () => seen.push(existsSync(t)), proc });
      proc.emit("SIGTERM");
      expect(seen).toEqual([true]);
      expect(existsSync(t)).toBe(false);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("keeps the directory when --keep was given (asked at signal time, not at install time), but still exits", () => {
    const t = scratch();
    const proc = fakeProcess();
    let keep = false;
    try {
      installSignalCleanup({ dir: t, keep: () => keep, proc });
      keep = true;
      proc.emit("SIGTERM");
      expect(existsSync(t)).toBe(true);
      expect(proc.codes).toEqual([143]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("run.mjs, as the command line sees it (no network: both refusals come before anything is built)", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(PROOF, "run.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: SPAWN_MS });

  it("refuses an unknown fixture and an unknown flag with exit 2 and the usage line", () => {
    for (const args of [["--only", "bogus"], ["--only"], ["--nope"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: node packages/engine/pack-proof/run.mjs [--only node|next|rn|types]");
    }
  }, spawnBudget(3));

  it("refuses a scratch directory inside the repo (TMPDIR pointed into it), before any pnpm runs, and leaves nothing behind", () => {
    // node_modules is git-ignored AND inside the repo, so a crash here strands nothing in a commit
    const base = mkdtempSync(join(ENGINE, "node_modules", ".pack-proof-test-"));
    try {
      const r = run(["--only", "node"], { TMPDIR: base });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/refusing to use .* it is inside the repo/);
      expect(r.stdout).not.toContain("pack-proof: pnpm");
      expect(readdirSync(base), "the refused scratch directory is removed").toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, spawnBudget(1));
});

describe("run.mjs removes its scratch directory when it is killed, and stops its child", () => {
  // A fake `pnpm` that answers --version, and otherwise records its pid and sleeps: the run is then waiting on a child.
  const fakePnpm = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.34.5; exit 0; fi\necho $$ > "$FAKE_PID_FILE"\nexec sleep 120\n', { mode: 0o755 });
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it.each([["SIGTERM", 143], ["SIGINT", 130]] as const)("%s while a child runs: scratch gone, child stopped, exit %i", async (signal, code) => {
    const base = scratch();
    const bin = join(base, "bin");
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    fakePnpm(bin);
    const pidFile = join(base, "child.pid");
    try {
      const run = spawn(process.execPath, [join(PROOF, "run.mjs"), "--only", "node"], { env: { ...process.env, TMPDIR: tmp, PATH: `${bin}:/bin:/usr/bin`, FAKE_PID_FILE: pidFile }, stdio: "ignore" });
      const exited = new Promise<number | null>((resolve) => run.once("exit", (c) => resolve(c)));
      for (let i = 0; i < 300 && !existsSync(pidFile); i++) await sleepMs(100);
      expect(existsSync(pidFile), "the fake pnpm never started: the run did not reach its first child").toBe(true);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(childPid)).toBe(true);
      expect(readdirSync(tmp).filter((d) => d.startsWith("engine-pack-"))).toHaveLength(1);
      run.kill(signal);
      expect(await exited).toBe(code);
      expect(readdirSync(tmp).filter((d) => d.startsWith("engine-pack-"))).toEqual([]);
      for (let i = 0; i < 50 && alive(childPid); i++) await sleepMs(100);
      expect(alive(childPid), "the child outlived the run").toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("run.mjs removes its scratch directory on failure, and keeps it only for --keep", () => {
  // No pnpm on PATH (an empty directory): the run fails right after it made its scratch directory, before any build.
  const failing = (args: string[]) => {
    const base = scratch();
    const empty = scratch();
    try {
      const r = spawnSync(process.execPath, [join(PROOF, "run.mjs"), ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: base, PATH: empty }, timeout: SPAWN_MS });
      return { r, left: readdirSync(base).filter((d) => d.startsWith("engine-pack-")), base };
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  };

  it("a failed run leaves nothing behind", () => {
    const { r, left, base } = failing(["--only", "node"]);
    try {
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/no pnpm 10\.34\.5 is available/);
      expect(left).toEqual([]);
      expect(r.stdout).not.toContain("scratch kept");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, spawnBudget(1));

  it("--keep keeps it, and prints where", () => {
    const { r, left, base } = failing(["--only", "node", "--keep"]);
    try {
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
      expect(left).toHaveLength(1);
      expect(r.stdout).toContain(`scratch kept at ${join(base, left[0] ?? "")}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, spawnBudget(1));
});

describe("the fixtures and wiring that make the run a proof", () => {
  const read = (...p: string[]) => readFileSync(join(PROOF, ...p), "utf8");
  const code = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("has exactly the four fixtures, each a `type: module` package (R27)", () => {
    const dirs = readdirSync(PROOF, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs).toEqual(FIXTURES);
    for (const d of dirs) {
      const p = JSON.parse(read(d, "package.json")) as { type?: string; private?: boolean };
      expect(p.type, d).toBe("module");
      expect(p.private, d).toBe(true);
    }
  });

  it("type-checks with skipLibCheck OFF under both resolutions, and the consumer carries a @ts-expect-error and a not-any assertion", () => {
    const bundler = JSON.parse(read("types", "tsconfig.bundler.json")) as { compilerOptions: Record<string, unknown>; include: string[] };
    const nodenext = JSON.parse(read("types", "tsconfig.nodenext.json")) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(bundler.compilerOptions.skipLibCheck).toBe(false);
    expect(nodenext.compilerOptions.skipLibCheck).toBe(false);
    expect(String(bundler.compilerOptions.moduleResolution).toLowerCase()).toBe("bundler");
    expect(String(nodenext.compilerOptions.moduleResolution).toLowerCase()).toBe("nodenext");
    // the generated all-exports.ts (one `import type * as` per specifier) is part of the program
    expect(bundler).toMatchObject({ include: expect.arrayContaining(["consumer.ts", "all-exports.ts"]) });
    expect(nodenext).toMatchObject({ include: expect.arrayContaining(["consumer.ts", "all-exports.ts"]) });
    const consumer = read("types", "consumer.ts");
    expect(consumer.match(/\/\/ @ts-expect-error/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(consumer).toMatch(/IsAny</);
    // it reaches the four subpaths the plan names
    for (const sub of ["core", "sport", "scheduling", "testkit"]) expect(consumer, sub).toContain(`from "@seazn/engine/${sub}"`);
  });

  it("builds the Next fixture with no transpilePackages", () => {
    expect(code(read("next", "next.config.js"))).not.toContain("transpilePackages");
    expect(read("next", "app", "page.tsx")).toContain("@seazn/engine/core");
    expect(read("next", "app", "page.tsx")).toContain("@seazn/engine/sport");
    expect(read("next", "app", "api", "probe", "route.ts")).toContain("@seazn/engine/sports");
  });

  it("is run by `pack:proof`, which is the engine package's own script", () => {
    expect(pkg.scripts["pack:proof"]).toBe("node pack-proof/run.mjs");
  });

  it("keeps the emitted dist out of the package's own lint, whose typed rules cannot parse a file outside the tsconfig", async () => {
    // (lives here, not in publish-manifest.test.ts: that file imports src/, and a test that does must not load ESLint under Stryker)
    const eslint = new ESLint({ cwd: ENGINE });
    // the control: a file the config does lint, so "ignored" below is the dist rule and not an ignore-everything config
    expect(await eslint.isPathIgnored(join(ENGINE, "src/core/index.ts")), "src/core/index.ts").toBe(false);
    for (const f of ["dist/core/index.js", "dist/core/index.d.ts", "dist/testkit/conformance.js"]) {
      expect(await eslint.isPathIgnored(join(ENGINE, f)), f).toBe(true);
    }
  }, FLOOR_MS); // the first `new ESLint` loads the package's whole flat config: ~5 s under coverage, once per worker

  it("keeps the fixture sources out of the package's lint (they import the PACKED name from outside the program), but lints the runner", async () => {
    const eslint = new ESLint({ cwd: ENGINE });
    for (const f of ["pack-proof/run.mjs", "pack-proof/lib.mjs"]) expect(await eslint.isPathIgnored(join(ENGINE, f)), f).toBe(false);
    for (const f of ["pack-proof/types/consumer.ts", "pack-proof/node/strip.ts", "pack-proof/next/app/page.tsx", "pack-proof/rn/metro.config.js"]) {
      expect(await eslint.isPathIgnored(join(ENGINE, f)), f).toBe(true);
    }
  }, FLOOR_MS);
});
