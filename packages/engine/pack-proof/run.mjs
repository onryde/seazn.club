// Packed-tarball proof (engine-split Task 1b-3, D14): build the engine's dist, PACK it with pnpm, and consume the tarball the way
// a registry consumer does, from directories outside the repo - Node's own type stripping, a Next build with no
// transpilePackages, a Metro bundle compiled by Hermes, and a TypeScript check with skipLibCheck off.
//
//   node packages/engine/pack-proof/run.mjs [--only node|next|rn|types] [--keep]
//
// Prints `<fixture>: <N> checked` per fixture and exits non-zero on any failure or when a fixture checked nothing.
// The decisions that need no network are in lib.mjs, held to failing inputs by test/pack-proof.test.ts.
//
// WHY PNPM, AND WHICH ONE. `publishConfig.exports` (the dist mapping) is applied by pnpm only; `npm pack` ships the workspace's
// `exports` -> ./src/*.ts into a tarball with no src. And the pnpm that runs must be the repo's pin (root `packageManager`):
// asked from a scratch directory, a bare `pnpm` answers with whatever is global (11.x on a dev machine), which packs and
// installs differently. The version is asserted, not assumed.
import { execFileSync } from "node:child_process";
import console from "node:console";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo, checkTarballExports, devBundleModules, engineModules, pickPnpm, requireChecked, runFixtures } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, "..");
const REPO = path.resolve(ENGINE, "..", "..");
const FIXTURE_NAMES = ["node", "next", "rn", "types"];

/** Task 1b-3: the dev bundle of every phone subpath must hold at least this many engine modules. The 2026-10-14 static closure
 *  was 46; Batch 1c makes the count exact. */
const RN_ENGINE_MODULE_FLOOR = 40;
/** The platform Metro bundles for. (rn/package.json pins `@react-native-community/cli` 20.2.0: React Native 0.86.3's
 *  community-cli-plugin takes it as an optional peer with the range `*`, and `react-native/cli.js` exits without it.) */
const RN_PLATFORM = "android";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rootPkg = readJson(path.join(REPO, "package.json"));
const enginePkg = readJson(path.join(ENGINE, "package.json"));
const webPkg = readJson(path.join(REPO, "apps/web/package.json"));

const info = (line) => console.log(`  ${line}`);

// ---------------------------------------------------------------------------------------------------------------- processes

/** The environment a child runs in: ours, minus what running under `pnpm run` / `npm run` adds (`npm_config_*`, `npm_execpath`
 *  ... would steer a child pnpm toward THIS repo's settings) and minus NODE_ENV (production would skip devDependencies). */
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("npm_") && k !== "NODE_ENV") env[k] = v;
  return { ...env, ...extra };
}

/** Run a command, return stdout. On failure throw with the command and the tail of what it printed. */
function run(label, command, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  try {
    return execFileSync(command, args, { cwd, env: childEnv(env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs });
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trimEnd().split("\n").slice(-60).join("\n");
    throw new Error(`${label} failed (${e.status !== null && e.status !== undefined ? `exit ${e.status}` : e.signal ?? e.code ?? "no status"}): ${command} ${args.join(" ")}\n${out}`);
  }
}

// -------------------------------------------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { only: undefined, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") {
      args.only = argv[++i] ?? ""; // a bare `--only` is a typo, not "everything"
    } else if (argv[i] === "--keep") {
      args.keep = true;
    } else {
      return { error: `unknown argument ${argv[i]}` };
    }
  }
  if (args.only !== undefined && !FIXTURE_NAMES.includes(args.only)) return { error: `--only takes one of ${FIXTURE_NAMES.join("|")}, got "${args.only}"` };
  return args;
}

// ----------------------------------------------------------------------------------------------------------------- set-up

function pinnedPnpmVersion() {
  const m = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootPkg.packageManager ?? "");
  if (m === null) throw new Error(`the root package.json packageManager is not "pnpm@<x.y.z>": ${String(rootPkg.packageManager)}`);
  return m[1];
}

function resolvePnpm(scratchRoot) {
  const pinned = pinnedPnpmVersion();
  const candidates = [
    { label: "pnpm", command: "pnpm", prefix: [] },
    { label: `corepack pnpm@${pinned}`, command: "corepack", prefix: [`pnpm@${pinned}`] },
  ];
  // asked from the scratch directory, where the fixtures will run it
  return pickPnpm(pinned, candidates, (c) => run("pnpm --version", c.command, [...c.prefix, "--version"], { cwd: scratchRoot, timeoutMs: 120_000 }));
}

/** Every file under `dir`, as `/`-separated paths relative to `base`. */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

/** Build dist/, check it is whole, pack it with pnpm, unpack the tarball and check its manifest. */
function buildAndPack(ctx) {
  const { pnpm, scratchRoot } = ctx;
  run("build:dist", pnpm.command, [...pnpm.prefix, "run", "build:dist"], { cwd: ENGINE });

  // An empty or partial dist/ packs a ~15-file tarball whose exports all dangle, and pnpm exits 0. Check the emit itself first,
  // against the workspace's own export list, so a broken build says so before it is packed.
  const distFiles = new Set(existsSync(path.join(ENGINE, "dist")) ? listFiles(path.join(ENGINE, "dist")).map((f) => `dist/${f}`) : []);
  if (distFiles.size === 0) throw new Error("dist/ is missing or empty after build:dist");
  const distChecked = checkTarballExports({ manifest: { exports: enginePkg.publishConfig.exports }, files: distFiles, expectedKeys: Object.keys(enginePkg.exports), where: "dist/" });
  info(`dist: ${distFiles.size} files, ${distChecked} export targets present`);

  const destination = path.join(scratchRoot, "tarball");
  mkdirSync(destination, { recursive: true });
  run("pnpm pack", pnpm.command, [...pnpm.prefix, "pack", "--pack-destination", destination], { cwd: ENGINE });
  const tarballs = readdirSync(destination).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected exactly one tarball in ${destination}, found ${tarballs.length}`);
  const tgz = path.join(destination, tarballs[0]);

  const unpacked = path.join(scratchRoot, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  run("tar -xzf", "tar", ["-xzf", tgz, "-C", unpacked]);
  const files = new Set(listFiles(path.join(unpacked, "package")));
  const manifest = readJson(path.join(unpacked, "package", "package.json"));
  if (manifest.name !== enginePkg.name) throw new Error(`the tarball is ${manifest.name}, expected ${enginePkg.name}`);
  const checked = checkTarballExports({ manifest, files, expectedKeys: Object.keys(enginePkg.exports) });
  requireChecked("tarball", checked);
  info(`tarball: ${checked} export targets checked in ${files.size} files (${path.basename(tgz)})`);
  return { tgz, manifest, files };
}

/** Copy a fixture to a scratch directory outside the repo, add the tarball (under the `@seazn/engine` alias) and zod, and install. */
function installFixture(name, ctx, extraDependencies = {}, extraDevDependencies = {}) {
  const dir = path.join(ctx.scratchRoot, name);
  assertOutsideRepo(ctx.scratchRoot, REPO);
  cpSync(path.join(HERE, name), dir, { recursive: true, filter: (src) => !/(^|[\\/])(node_modules|\.next)([\\/]|$)/.test(src) });
  assertOutsideRepo(dir, REPO);
  const pkgFile = path.join(dir, "package.json");
  const pkg = readJson(pkgFile);
  pkg.dependencies = { ...pkg.dependencies, "@seazn/engine": `file:${ctx.tarball.tgz}`, zod: enginePkg.peerDependencies.zod, ...extraDependencies };
  pkg.devDependencies = { ...pkg.devDependencies, ...extraDevDependencies };
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const { pnpm } = ctx;
  run(`${name}: pnpm install`, pnpm.command, [...pnpm.prefix, "install", "--no-frozen-lockfile", "--ignore-workspace"], { cwd: dir });
  // the install must really be the tarball under the alias: its manifest is the packed one
  const installed = readJson(path.join(dir, "node_modules", "@seazn", "engine", "package.json"));
  if (installed.name !== enginePkg.name || installed.exports["./core"].default !== "./dist/core/index.js") throw new Error(`${name}: node_modules/@seazn/engine is not the packed ${enginePkg.name}`);
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------- fixtures

async function nodeFixture(ctx) {
  const dir = installFixture("node", ctx);
  const out = run("node: strip.ts", process.execPath, ["--experimental-strip-types", "strip.ts"], { cwd: dir, timeoutMs: 120_000 });
  const m = /^builtinModules: (\d+)$/m.exec(out);
  if (m === null) throw new Error(`node: strip.ts did not report a builtinModules count:\n${out}`);
  const builtins = Number(m[1]);
  // rules.mjs: skipped, loudly, until Task 1d-5 gives it a parser to call
  const rules = run("node: rules.mjs", process.execPath, ["rules.mjs"], { cwd: dir, timeoutMs: 120_000 });
  const skipped = /^SKIPPED: (.+)$/m.exec(rules);
  if (skipped !== null) {
    info(`node: rules.mjs skipped - ${skipped[1]}`);
    return builtins;
  }
  const r = /^rules: (\d+)$/m.exec(rules);
  if (r === null) throw new Error(`node: rules.mjs neither skipped nor reported a rules count:\n${rules}`);
  return builtins + requireChecked("node: rules.mjs", Number(r[1]));
}

async function nextFixture(ctx) {
  const webNext = createRequire(path.join(REPO, "apps/web/package.json"))("next/package.json").version;
  const dir = installFixture(
    "next",
    ctx,
    { next: webNext, react: webPkg.dependencies.react, "react-dom": webPkg.dependencies["react-dom"] },
    { typescript: webPkg.devDependencies.typescript, "@types/react": webPkg.devDependencies["@types/react"], "@types/react-dom": webPkg.devDependencies["@types/react-dom"], "@types/node": enginePkg.devDependencies["@types/node"] },
  );
  info(`next: ${webNext} (apps/web's), react ${webPkg.dependencies.react}`);
  const out = run("next: next build", process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "build"], { cwd: dir, env: { NEXT_TELEMETRY_DISABLED: "1" } });
  const manifest = readJson(path.join(dir, ".next", "server", "app-paths-manifest.json"));
  const routes = Object.keys(manifest);
  // the two routes the fixture declares must be among the ones built (a build that built something else is not this proof)
  for (const want of ["/page", "/api/probe/route"]) if (!routes.includes(want)) throw new Error(`next: the build did not produce ${want} (built: ${routes.join(", ")})\n${out}`);
  info(`next: built ${routes.join(", ")}`);
  // Prerendering RAN the imports: the page printed `typeof` of two engine values and the route body lists the shipped sports.
  const html = readFileSync(path.join(dir, ".next", "server", "app", "index.html"), "utf8");
  if (!html.includes("<p>function</p><p>function</p>")) throw new Error("next: the prerendered page does not show the engine's EngineError and registry.register as functions");
  const body = JSON.parse(readFileSync(path.join(dir, ".next", "server", "app", "api", "probe.body"), "utf8"));
  if (!Array.isArray(body.sports) || body.sports.length === 0) throw new Error(`next: the prerendered route lists no sports: ${JSON.stringify(body)}`);
  info(`next: the route handler listed ${body.sports.length} sports at build time`);
  return routes.length;
}

/** Every phone subpath the packed manifest exports under core/sport/sports and every sport directory that has an index. */
function phoneSubpaths(ctx) {
  const exportsMap = ctx.tarball.manifest.exports;
  const fixed = ["./core", "./sport", "./sports"].filter((k) => k in exportsMap).map((k) => k.slice(2));
  // `./sports/*` expands over the directories the packed dist/ holds an index for
  const dirs = [...ctx.tarball.files]
    .map((f) => /^dist\/sports\/([^/]+)\/index\.js$/.exec(f)?.[1])
    .filter((d) => d !== undefined)
    .sort();
  if (!("./sports/*" in exportsMap)) throw new Error("the packed manifest has no ./sports/*");
  return [...fixed, ...dirs.map((d) => `sports/${d}`)];
}

function hermescPath(dir) {
  const hermesPkg = createRequire(path.join(dir, "package.json")).resolve("hermes-compiler/package.json");
  return path.join(path.dirname(hermesPkg), "hermesc", process.platform === "darwin" ? "osx-bin" : "linux64-bin", "hermesc");
}

async function rnFixture(ctx) {
  const dir = installFixture("rn", ctx);
  const subpaths = phoneSubpaths(ctx);
  const imports = subpaths.map((s, i) => `import * as m${i} from "@seazn/engine/${s}";`);
  const index = [
    ...imports,
    'import { badminton } from "@seazn/engine/sports/setbased";',
    "",
    "// a real fold, not just an import: badminton at its schema-default config over an empty ledger",
    "const cfg = badminton.configSchema.parse({});",
    'const lineups = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };',
    "const state = m0.foldMatch(badminton, cfg, lineups, []);",
    "",
    `globalThis.__enginePackProof = { state, modules: [${subpaths.map((_, i) => `m${i}`).join(", ")}] };`,
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "index.js"), index);
  writeFileSync(path.join(dir, "control.js"), 'globalThis.__control = "ok";\n');
  writeFileSync(path.join(dir, "control-hermes.js"), "var control = 1 + 1;\n");

  const rnCli = path.join("node_modules", "react-native", "cli.js");
  const bundle = (entry, out, dev) =>
    run(`rn: react-native bundle ${entry} (dev=${dev})`, process.execPath, [rnCli, "bundle", "--platform", RN_PLATFORM, "--dev", String(dev), "--entry-file", entry, "--bundle-output", out, "--reset-cache"], { cwd: dir, env: { CI: "1" } });
  const hermesc = hermescPath(dir);
  const compile = (src, out) => run(`rn: hermesc ${src}`, hermesc, ["-emit-binary", "-out", out, src], { cwd: dir, timeoutMs: 5 * 60_000 });

  // The toolchain first, on an entry that imports nothing of ours. A red here is a missing CLI or a broken install, which is
  // NOT a finding about the engine - and it must not be reported as one.
  try {
    bundle("control.js", "control.bundle.js", true);
    compile("control-hermes.js", "control.hbc");
  } catch (e) {
    throw new Error(`rn: TOOLCHAIN FAILURE - Metro/Hermes could not bundle or compile a file that imports nothing of the engine, so this is not an engine finding.\n${e.message}`);
  }
  info("rn: toolchain ran (control entry bundled by Metro, control file compiled by hermesc)");

  bundle("index.js", "dev.bundle.js", true);
  const paths = devBundleModules(readFileSync(path.join(dir, "dev.bundle.js"), "utf8"));
  const engine = engineModules(paths, ["@seazn/engine", enginePkg.name]);
  info(`rn: dev bundle ${paths.length} modules, ${engine.length} from @seazn/engine/dist (${subpaths.length} subpaths imported)`);
  if (engine.length < RN_ENGINE_MODULE_FLOOR) throw new Error(`rn: only ${engine.length} engine modules reached the dev bundle, expected at least ${RN_ENGINE_MODULE_FLOOR}:\n${engine.join("\n")}`);

  bundle("index.js", "out.js", false);
  compile("out.js", "out.hbc");
  const hbc = path.join(dir, "out.hbc");
  if (!existsSync(hbc)) throw new Error("rn: hermesc exited 0 but wrote no out.hbc");
  info(`rn: hermesc compiled the production bundle (${readFileSync(hbc).length} bytes of bytecode)`);
  return engine.length;
}

async function typesFixture(ctx) {
  const dir = installFixture(
    "types",
    ctx,
    {},
    { "fast-check": enginePkg.peerDependencies["fast-check"], vitest: enginePkg.peerDependencies.vitest, "@types/node": enginePkg.devDependencies["@types/node"] },
  );
  const compilers = [
    { label: "TS 7", bin: path.join(REPO, "node_modules", "typescript-native", "bin", "tsc"), major: 7 },
    { label: "TS 6", bin: path.join(REPO, "node_modules", "typescript", "bin", "tsc"), major: 6 },
  ];
  let passed = 0;
  for (const c of compilers) {
    const version = run(`types: ${c.label} --version`, process.execPath, [c.bin, "--version"], { cwd: dir, timeoutMs: 60_000 }).trim();
    if (!version.startsWith(`Version ${c.major}.`)) throw new Error(`types: ${c.bin} reports "${version}", expected a ${c.major}.x`);
    for (const config of ["tsconfig.bundler.json", "tsconfig.nodenext.json"]) {
      run(`types: ${c.label} -p ${config}`, process.execPath, [c.bin, "-p", config], { cwd: dir, timeoutMs: 5 * 60_000 });
      info(`types: ${version} -p ${config} exit 0 (skipLibCheck false)`);
      passed++;
    }
  }
  return passed;
}

const FIXTURES = { node: nodeFixture, next: nextFixture, rn: rnFixture, types: typesFixture };

// ------------------------------------------------------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`pack-proof: ${args.error}\nusage: node packages/engine/pack-proof/run.mjs [--only ${FIXTURE_NAMES.join("|")}] [--keep]`);
    return 2;
  }
  const started = Date.now();
  // First, and before anything is built or installed: where the fixtures will live. os.tmpdir() honours TMPDIR, so a shell that
  // points it into the repo is caught here rather than after a ten-minute install that proves nothing.
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "engine-pack-"));
  try {
    assertOutsideRepo(scratchRoot, REPO);
  } catch (e) {
    rmSync(scratchRoot, { recursive: true, force: true }); // our own empty directory, and it is in the repo: leave nothing behind
    console.error(`pack-proof: ${e.message}`);
    return 1;
  }
  let keep = args.keep;
  try {
    const pnpm = resolvePnpm(scratchRoot);
    console.log(`pack-proof: pnpm ${pnpm.version} (${pnpm.label}), node ${process.version}, scratch ${scratchRoot}`);
    const ctx = { pnpm, scratchRoot, tarball: undefined };
    ctx.tarball = buildAndPack(ctx);
    const names = args.only === undefined ? FIXTURE_NAMES : [args.only];
    const { results, failures } = await runFixtures(names, FIXTURES, ctx, (line) => console.log(line));
    for (const f of failures) console.error(`\n${f.name}: FAILED\n${f.error.message}`);
    if (failures.length > 0) {
      keep = true;
      console.error(`\npack-proof: ${failures.length} of ${names.length} fixture(s) failed (${failures.map((f) => f.name).join(", ")}); scratch kept at ${scratchRoot}`);
      return 1;
    }
    console.log(`pack-proof: ${results.length} fixture(s) green in ${Math.round((Date.now() - started) / 1000)}s`);
    return 0;
  } catch (e) {
    keep = true;
    console.error(`pack-proof: ${e instanceof Error ? e.message : String(e)}\n(scratch kept at ${scratchRoot})`);
    return 1;
  } finally {
    if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  }
}

process.exitCode = await main();
