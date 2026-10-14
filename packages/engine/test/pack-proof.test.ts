// Engine-split Task 1b-3 (D14). pack-proof/run.mjs is the end-to-end proof (a packed tarball consumed from outside the repo by
// Node, Next, Metro+Hermes and tsc, in CI's `engine-pack` job). It needs the network and minutes, so it is not run here. What IS
// held here, with no network, is every decision inside it that could quietly stop being a decision: the scratch directory is
// refused when it is inside the repo, a fixture that checked nothing is a failure, the tarball's exports are judged for
// source/dangling targets, the right pnpm is picked, and the Metro module count is read from a bundle that actually parses.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { assertOutsideRepo, checkTarballExports, devBundleModules, engineModules, pickPnpm, requireChecked, runFixtures } from "../pack-proof/lib.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ENGINE, "..", "..");
const PROOF = join(ENGINE, "pack-proof");
const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, Record<string, string>> };
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
const targetsOf = (exp: Record<string, Record<string, string>>) => Object.values(exp).flatMap((c) => Object.values(c));
const filesFor = (exp: Record<string, Record<string, string>>) =>
  new Set(targetsOf(exp).flatMap((t) => (t.includes("*") ? sportDirs.map((d) => t.replace("*", d).slice(2)) : [t.slice(2)])));
const keys = Object.keys(pkg.exports);

describe("checkTarballExports", () => {
  const packed = pkg.publishConfig.exports;

  it("passes the engine's own publishConfig.exports and counts every target (two conditions per declared export)", () => {
    expect(sportDirs.length).toBeGreaterThan(0);
    expect(keys.length).toBeGreaterThan(0);
    expect(checkTarballExports({ manifest: { exports: packed }, files: filesFor(packed), expectedKeys: keys })).toBe(keys.length * 2);
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
    expect(checkTarballExports({ manifest: { exports: packed }, files, expectedKeys: keys })).toBe(keys.length * 2);
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

describe("run.mjs, as the command line sees it (no network: both refusals come before anything is built)", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(PROOF, "run.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });

  it("refuses an unknown fixture and an unknown flag with exit 2 and the usage line", () => {
    for (const args of [["--only", "bogus"], ["--only"], ["--nope"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("usage: node packages/engine/pack-proof/run.mjs [--only node|next|rn|types]");
    }
  });

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
  });
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
    const bundler = JSON.parse(read("types", "tsconfig.bundler.json")) as { compilerOptions: Record<string, unknown> };
    const nodenext = JSON.parse(read("types", "tsconfig.nodenext.json")) as { compilerOptions: Record<string, unknown> };
    expect(bundler.compilerOptions.skipLibCheck).toBe(false);
    expect(nodenext.compilerOptions.skipLibCheck).toBe(false);
    expect(String(bundler.compilerOptions.moduleResolution).toLowerCase()).toBe("bundler");
    expect(String(nodenext.compilerOptions.moduleResolution).toLowerCase()).toBe("nodenext");
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

  it("keeps the fixture sources out of the package's lint (they import the PACKED name from outside the program), but lints the runner", async () => {
    const eslint = new ESLint({ cwd: ENGINE });
    for (const f of ["pack-proof/run.mjs", "pack-proof/lib.mjs"]) expect(await eslint.isPathIgnored(join(ENGINE, f)), f).toBe(false);
    for (const f of ["pack-proof/types/consumer.ts", "pack-proof/node/strip.ts", "pack-proof/next/app/page.tsx", "pack-proof/rn/metro.config.js"]) {
      expect(await eslint.isPathIgnored(join(ENGINE, f)), f).toBe(true);
    }
  });
});
