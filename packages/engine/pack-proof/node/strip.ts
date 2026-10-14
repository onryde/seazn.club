// The deploy's `sync-sports` shape (scripts/sync-sports.ts): Node's own type stripping, bare imports of the engine's subpaths, no
// bundler and no loader. It runs against the PACKED tarball in a directory outside the repo, so every relative import inside
// dist/ must already carry its `.js` and every bare import must resolve from this install alone.
//
//   node --experimental-strip-types strip.ts core      imports every export but ./testkit (this install has zod only)
//   node --experimental-strip-types strip.ts testkit   imports ./testkit and folds every builtin sport (fast-check + vitest installed)
//
// The two modes are two installs on purpose. `fast-check` and `vitest` are OPTIONAL peers that only the testkit may need: with
// them absent, an `import "fast-check"` anywhere else in the engine fails the `core` run with ERR_MODULE_NOT_FOUND.
//
// What it imports is READ from the installed package: the keys of its package.json `exports` (the `./sports/*` pattern expanded
// over the sport directories its dist/ holds an index for). Nothing is typed here. The last lines are machine-read by run.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "core" && mode !== "testkit") {
  console.error("usage: strip.ts core|testkit");
  process.exit(2);
}

const pkgDir = new URL("./node_modules/@seazn/engine/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", pkgDir), "utf8"));
const sportDirs = readdirSync(new URL("dist/sports/", pkgDir), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`dist/sports/${d.name}/index.js`, pkgDir)))
  .map((d) => d.name)
  .sort();
const keys = Object.keys(manifest.exports).filter((k) => !k.includes("*"));

const specifiers =
  mode === "testkit"
    ? keys.filter((k) => k === "./testkit").map((k) => `@seazn/engine/${k.slice(2)}`)
    : [...keys.filter((k) => k !== "./testkit").map((k) => `@seazn/engine/${k.slice(2)}`), ...sportDirs.map((d) => `@seazn/engine/sports/${d}`)];
if (specifiers.length === 0) process.exit(1);
for (const specifier of specifiers) await import(specifier);
console.log(`SPECIFIERS ${JSON.stringify(specifiers)}`);

const { builtinModules } = await import("@seazn/engine/sports");
if (builtinModules.length === 0) process.exit(1);
console.log(`builtinModules: ${builtinModules.length}`);

if (mode === "testkit") {
  // A real fold of every sport: the engine's own declared configs (generic has no schema default, so a bare parse({}) is
  // wrong for it) and its own default lineups, over an empty ledger, through the packed build.
  const { foldMatch } = await import("@seazn/engine/core");
  const { declaredCfgs, defaultLineupPair } = await import("@seazn/engine/testkit");
  const sports = [];
  let folds = 0;
  for (const module of builtinModules) {
    for (const { cfg } of declaredCfgs(module)) {
      const state = foldMatch(module, cfg, defaultLineupPair(module.positions), []);
      if (state === undefined || state === null) throw new Error(`${module.key}: the fold returned ${String(state)}`);
      folds++;
    }
    sports.push(module.key);
  }
  if (folds === 0) process.exit(1);
  console.log(`SPORTS ${JSON.stringify(sports)}`);
  console.log(`FOLDS ${folds}`);
}
