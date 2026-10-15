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
import { execFile, execFileSync } from "node:child_process";
import console from "node:console";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertBundleMatchesWalk,
  assertExactVersions,
  assertOutsideRepo,
  assertPhoneRuleGreen,
  assertSameSet,
  DATA_EXPORTS,
  checkTarballExports,
  declaredAppRoutes,
  devBundleModules,
  engineDistPaths,
  exportSpecifiers,
  installSignalCleanup,
  installedVersion,
  phoneSpecifiers,
  pickPnpm,
  requireChecked,
  runFixtures,
  sourceSportDirs,
  sportDirsOf,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, "..");
const REPO = path.resolve(ENGINE, "..", "..");
const FIXTURE_NAMES = ["node", "next", "rn", "types"];

/** The platform Metro bundles for. (rn/package.json pins `@react-native-community/cli` 20.2.0: React Native 0.86.3's
 *  community-cli-plugin takes it as an optional peer with the range `*`, and `react-native/cli.js` exits without it.) */
const RN_PLATFORM = "android";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rootPkg = readJson(path.join(REPO, "package.json"));
const enginePkg = readJson(path.join(ENGINE, "package.json"));

const info = (line) => console.log(`  ${line}`);

/** Every version a fixture installs is the one THIS repo resolved (read from its installed packages, never a range typed here), so
 *  the proof runs against what the repo's own tests run against. The rn fixture's toolchain is pinned in rn/package.json. */
const enginePins = () => ({ zod: installedVersion(ENGINE, "zod"), "fast-check": installedVersion(ENGINE, "fast-check"), vitest: installedVersion(ENGINE, "vitest"), "@types/node": installedVersion(ENGINE, "@types/node") });
const WEB = path.join(REPO, "apps/web");

// ---------------------------------------------------------------------------------------------------------------- processes

/** The environment a child runs in: ours, minus what running under `pnpm run` / `npm run` adds (`npm_config_*`, `npm_execpath`
 *  ... would steer a child pnpm toward THIS repo's settings) and minus NODE_ENV (production would skip devDependencies). */
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("npm_") && k !== "NODE_ENV") env[k] = v;
  return { ...env, ...extra };
}

const MAX_BUFFER = 512 * 1024 * 1024;
const failure = (label, command, args, e) => {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trimEnd().split("\n").slice(-60).join("\n");
  const status = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : undefined;
  return new Error(`${label} failed (${status !== undefined ? `exit ${status}` : e.signal ?? e.code ?? "no status"}): ${command} ${args.join(" ")}\n${out}`);
};

/** Run a command to completion and return stdout, BLOCKING this process. Only for the startup probe: a blocked process cannot
 *  act on a signal, so everything that takes time goes through `run`. On failure throw with the command and the tail of its output. */
function runSync(label, command, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  try {
    return execFileSync(command, args, { cwd, env: childEnv(env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_BUFFER, timeout: timeoutMs });
  } catch (e) {
    throw failure(label, command, args, e);
  }
}

/** The children `run` has started and not yet seen finish: what a SIGINT/SIGTERM must stop before it removes their directory. */
const running = new Set();

/** Run a command, resolve with stdout. Asynchronous on purpose: while a child runs this process is free to take a signal.
 *  On failure reject with the command and the tail of what it printed. */
function run(label, command, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env: childEnv(env), encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs }, (e, stdout, stderr) => {
      running.delete(child);
      if (e === null) resolve(stdout);
      else reject(failure(label, command, args, Object.assign(e, { stdout, stderr })));
    });
    running.add(child);
    child.stdin?.end(); // nothing is ever typed at a child
  });
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
  return pickPnpm(pinned, candidates, (c) => runSync("pnpm --version", c.command, [...c.prefix, "--version"], { cwd: scratchRoot, timeoutMs: 120_000 }));
}

/** Every file under `dir`, as `/`-separated paths relative to `base`. */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

/** Build dist/, check it is whole, pack it with pnpm, unpack the tarball and check its manifest. */
async function buildAndPack(ctx) {
  const { pnpm, scratchRoot } = ctx;
  await run("build:dist", pnpm.command, [...pnpm.prefix, "run", "build:dist"], { cwd: ENGINE });

  // An empty or partial dist/ packs a ~15-file tarball whose exports all dangle, and pnpm exits 0. Check the emit itself first,
  // against the workspace's own export list, so a broken build says so before it is packed.
  const distFiles = new Set(existsSync(path.join(ENGINE, "dist")) ? listFiles(path.join(ENGINE, "dist")).map((f) => `dist/${f}`) : []);
  if (distFiles.size === 0) throw new Error("dist/ is missing or empty after build:dist");
  // the data exports (the phone pin) are package-root files, not dist/ ones: present in the workspace, they are what `files` will pack
  const dataFiles = [...DATA_EXPORTS.values()].filter((f) => existsSync(path.join(ENGINE, f)));
  const distChecked = checkTarballExports({ manifest: { exports: enginePkg.publishConfig.exports }, files: new Set([...distFiles, ...dataFiles]), expectedKeys: Object.keys(enginePkg.exports), where: "dist/ and the package root" });
  info(`dist: ${distFiles.size} files, ${distChecked} export targets present`);

  const destination = path.join(scratchRoot, "tarball");
  mkdirSync(destination, { recursive: true });
  await run("pnpm pack", pnpm.command, [...pnpm.prefix, "pack", "--pack-destination", destination], { cwd: ENGINE });
  const tarballs = readdirSync(destination).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected exactly one tarball in ${destination}, found ${tarballs.length}`);
  const tgz = path.join(destination, tarballs[0]);

  const unpacked = path.join(scratchRoot, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  await run("tar -xzf", "tar", ["-xzf", tgz, "-C", unpacked]);
  const files = new Set(listFiles(path.join(unpacked, "package")));
  const manifest = readJson(path.join(unpacked, "package", "package.json"));
  if (manifest.name !== enginePkg.name) throw new Error(`the tarball is ${manifest.name}, expected ${enginePkg.name}`);
  const checked = checkTarballExports({ manifest, files, expectedKeys: Object.keys(enginePkg.exports) });
  requireChecked("tarball", checked);
  info(`tarball: ${checked} export targets checked in ${files.size} files (${path.basename(tgz)})`);

  // The sport directories the packed dist/ holds an index for must be exactly the workspace source's: a sport that lost its
  // index (or a stray one) would otherwise just shrink every count below it.
  const sportDirs = sportDirsOf(files);
  assertSameSet("dist/sports/<dir> in the tarball vs src/sports/<dir> with an index.ts", sportDirs, sourceSportDirs(ENGINE));
  // Everything a consumer can import: each non-pattern export key, and `./sports/*` expanded over those directories.
  const specifiers = exportSpecifiers({ manifest, sportDirs });
  info(`tarball: ${specifiers.length} importable specifiers (${specifiers.length - sportDirs.length} export keys + ${sportDirs.length} sport directories)`);
  return { tgz, manifest, files, sportDirs, specifiers };
}

/** Copy a fixture to a scratch directory outside the repo, add the tarball (under the `@seazn/engine` alias) and the repo's own
 *  zod, and install. Every other version is exact: `extra*` come from `enginePins()` / apps/web's installed packages, and the
 *  fixture's own package.json pins its toolchain. `dest` names the scratch directory when one fixture installs twice. */
async function installFixture(name, ctx, extraDependencies = {}, extraDevDependencies = {}, dest = name) {
  const dir = path.join(ctx.scratchRoot, dest);
  assertOutsideRepo(ctx.scratchRoot, REPO);
  cpSync(path.join(HERE, name), dir, { recursive: true, filter: (src) => !/(^|[\\/])(node_modules|\.next)([\\/]|$)/.test(src) });
  assertOutsideRepo(dir, REPO);
  const pkgFile = path.join(dir, "package.json");
  const pkg = readJson(pkgFile);
  pkg.dependencies = { ...pkg.dependencies, "@seazn/engine": `file:${ctx.tarball.tgz}`, zod: installedVersion(ENGINE, "zod"), ...extraDependencies };
  pkg.devDependencies = { ...pkg.devDependencies, ...extraDevDependencies };
  assertExactVersions(`${dest} dependencies`, pkg.dependencies);
  assertExactVersions(`${dest} devDependencies`, pkg.devDependencies);
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const { pnpm } = ctx;
  await run(`${dest}: pnpm install`, pnpm.command, [...pnpm.prefix, "install", "--no-frozen-lockfile", "--ignore-workspace"], { cwd: dir });
  // the install must really be the tarball under the alias: its manifest is the packed one
  const installed = readJson(path.join(dir, "node_modules", "@seazn", "engine", "package.json"));
  if (installed.name !== enginePkg.name || installed.exports["./core"].default !== "./dist/core/index.js") throw new Error(`${dest}: node_modules/@seazn/engine is not the packed ${enginePkg.name}`);
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------- fixtures

/** Parse the JSON-array line `<TAG> [..]` strip.ts prints. */
function printedList(out, tag, what) {
  const m = new RegExp(`^${tag} (\\[.*\\])$`, "m").exec(out);
  if (m === null) throw new Error(`${what} printed no ${tag} line:\n${out}`);
  return JSON.parse(m[1]);
}

async function nodeFixture(ctx) {
  const optionalPeers = Object.entries(enginePkg.peerDependenciesMeta ?? {}).filter(([, v]) => v.optional === true).map(([k]) => k);
  // 1. zod ONLY: every export but ./testkit, and every sport directory, loaded with `import()`. The optional peers are not
  //    installed here, so an `import "fast-check"` (or vitest) anywhere outside the testkit fails this run.
  const core = await installFixture("node", ctx);
  for (const peer of optionalPeers) if (existsSync(path.join(core, "node_modules", peer))) throw new Error(`node: the zod-only install holds the optional peer ${peer}`);
  const coreOut = await run("node: strip.ts core", process.execPath, ["--experimental-strip-types", "strip.ts", "core"], { cwd: core, timeoutMs: 180_000 });
  const imported = printedList(coreOut, "SPECIFIERS", "node: strip.ts core");
  // ... and the tarball's own export list is the oracle: what strip.ts read from the INSTALLED package must be the same set
  assertSameSet("node: specifiers imported from the zod-only install", imported, ctx.tarball.specifiers.filter((x) => x !== "@seazn/engine/testkit"));
  // The data exports (the phone pin) are not modules: read through the installed package's exports map with a JSON import attribute, and
  // equal to the workspace's own file. A package that exported the key but shipped another file, or none, fails here.
  const printedData = JSON.parse(/^DATA (\{.*\})$/m.exec(coreOut)?.[1] ?? "null");
  const workspaceData = Object.fromEntries([...DATA_EXPORTS].map(([key, file]) => [`@seazn/engine/${key.slice(2)}`, readJson(path.join(ENGINE, file))]));
  if (JSON.stringify(printedData) !== JSON.stringify(workspaceData)) throw new Error(`node: the data exports read from the installed package differ from the workspace's files:\n${coreOut}`);
  const dataChecked = requireChecked("node: data exports", Object.keys(workspaceData).length);
  info(`node: ${dataChecked} data export(s) read from the installed package, equal to the workspace's file (${Object.keys(workspaceData).join(", ")})`);

  // 2. + fast-check and vitest: the testkit imported, and every builtin sport folded for real from the packed build.
  const pins = enginePins();
  const kit = await installFixture("node", ctx, {}, { "fast-check": pins["fast-check"], vitest: pins.vitest }, "node-testkit");
  const kitOut = await run("node: strip.ts testkit", process.execPath, ["--experimental-strip-types", "strip.ts", "testkit"], { cwd: kit, timeoutMs: 180_000 });
  assertSameSet("node: specifiers imported from the testkit install", printedList(kitOut, "SPECIFIERS", "node: strip.ts testkit"), ["@seazn/engine/testkit"]);
  const sports = printedList(kitOut, "SPORTS", "node: strip.ts testkit");
  const folds = Number(/^FOLDS (\d+)$/m.exec(kitOut)?.[1]);
  // the sports to fold come from the WORKSPACE source's own builtinModules; what was folded came from the tarball
  const expectedSports = (await import(pathToFileURL(path.join(ENGINE, "src", "sports", "index.ts")).href)).builtinModules.map((m) => m.key);
  assertSameSet("node: sports folded from the tarball vs the workspace's builtinModules", sports, expectedSports);
  if (!(folds >= sports.length)) throw new Error(`node: ${folds} folds for ${sports.length} sports`);
  const specifiers = imported.length + 1;
  info(`node: ${specifiers} specifiers imported (${specifiers - ctx.tarball.sportDirs.length} export keys + ${ctx.tarball.sportDirs.length} sport directories), ${sports.length} sports folded over ${folds} declared configs`);
  const specifiersAndSports = specifiers + sports.length;

  // rules.mjs (Task 1d-5, R12): the testkit's rules parser, run from the INSTALLED tarball, reads the same rows per file as the workspace's
  // own parse of the same tables. A parse that found nothing, or found different rows, fails; so does a leg that skips itself.
  const rules = await run("node: rules.mjs", process.execPath, ["rules.mjs"], { cwd: kit, timeoutMs: 120_000 });
  if (/^SKIPPED: /m.test(rules)) throw new Error(`node: rules.mjs skipped itself - the parser it calls shipped in 1d-5, so a skip is a failure:\n${rules}`);
  const total = Number(/^rules: (\d+)$/m.exec(rules)?.[1]);
  const byFile = JSON.parse(/^RULES_BY_FILE (\{.*\})$/m.exec(rules)?.[1] ?? "null");
  if (byFile === null) throw new Error(`node: rules.mjs printed no RULES_BY_FILE line:\n${rules}`);
  // the rows to expect come from the WORKSPACE source's parse of rules/; what was parsed came from the tarball
  const workspace = await import(pathToFileURL(path.join(ENGINE, "src", "testkit", "rules-reference.ts")).href);
  const wsRows = workspace.allRows();
  const wsByFile = workspace.ruleFiles().map((f) => `${f}:${wsRows.filter((r) => r.file === f).length}`);
  assertSameSet("node: rules rows per file parsed from the tarball vs the workspace", Object.entries(byFile).map(([f, n]) => `${f}:${n}`), wsByFile);
  if (total !== wsRows.length) throw new Error(`node: rules.mjs parsed ${total} rows from the tarball, the workspace parses ${wsRows.length}`);
  info(`node: ${total} rules rows parsed from the installed testkit over ${wsByFile.length} rules files`);
  return specifiersAndSports + dataChecked + requireChecked("node: rules.mjs", total);
}

async function nextFixture(ctx) {
  const webNext = installedVersion(WEB, "next");
  const react = installedVersion(WEB, "react");
  const dir = await installFixture(
    "next",
    ctx,
    { next: webNext, react, "react-dom": installedVersion(WEB, "react-dom") },
    { typescript: installedVersion(WEB, "typescript"), "@types/react": installedVersion(WEB, "@types/react"), "@types/react-dom": installedVersion(WEB, "@types/react-dom"), "@types/node": enginePins()["@types/node"] },
  );
  info(`next: ${webNext} (apps/web's), react ${react}`);
  const out = await run("next: next build", process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "build"], { cwd: dir, env: { NEXT_TELEMETRY_DISABLED: "1" } });
  const built = Object.keys(readJson(path.join(dir, ".next", "server", "app-paths-manifest.json")));
  // The routes the fixture DECLARES (its page and route files) are what is counted; the framework adds /_not-found and
  // /_global-error, which say nothing about the engine. Every declared route must be among the built ones.
  const declared = declaredAppRoutes(listFiles(path.join(HERE, "next", "app")));
  for (const want of declared) if (!built.includes(want)) throw new Error(`next: the build did not produce ${want} (built: ${built.join(", ")})\n${out}`);
  info(`next: built ${built.join(", ")}; counting the ${declared.length} declared (${declared.join(", ")})`);
  // Prerendering RAN the imports: the page printed `typeof` of two engine values and the route body lists the shipped sports.
  const html = readFileSync(path.join(dir, ".next", "server", "app", "index.html"), "utf8");
  if (!html.includes("<p>function</p><p>function</p>")) throw new Error("next: the prerendered page does not show the engine's EngineError and registry.register as functions");
  const body = JSON.parse(readFileSync(path.join(dir, ".next", "server", "app", "api", "probe.body"), "utf8"));
  if (!Array.isArray(body.sports) || body.sports.length === 0) throw new Error(`next: the prerendered route lists no sports: ${JSON.stringify(body)}`);
  info(`next: the route handler listed ${body.sports.length} sports at build time`);
  return declared.length;
}

/** The specifiers of the phone subpaths (Task 1c-1): the subpaths of phone-subpaths.json, each an export of the packed manifest, with
 *  `./sports/*` expanded over the sport directories the tarball holds (already checked against the workspace source). */
function phoneSubpathSpecifiers(ctx) {
  const { subpaths } = readJson(path.join(ENGINE, "phone-subpaths.json"));
  return phoneSpecifiers({ subpaths, manifest: ctx.tarball.manifest, sportDirs: ctx.tarball.sportDirs });
}

function hermescPath(dir) {
  const hermesPkg = createRequire(path.join(dir, "package.json")).resolve("hermes-compiler/package.json");
  return path.join(path.dirname(hermesPkg), "hermesc", process.platform === "darwin" ? "osx-bin" : "linux64-bin", "hermesc");
}

async function rnFixture(ctx) {
  // The static half first (scripts/engine-boundary.ts, on the workspace source): a closure that already reads a Node builtin, `process`
  // or scheduling is a finding of its own, and the bundle below is then compared to the modules it walked.
  const { checkPhoneClosure } = await import(pathToFileURL(path.join(ENGINE, "scripts", "engine-boundary.ts")).href);
  const phone = checkPhoneClosure(ENGINE); // the walk, and the closure pin of phone-subpaths.json: a drift is a violation
  assertPhoneRuleGreen(phone);
  info(`rn: static phone walk ${phone.walked.length} modules from ${phone.entries.length} entries, equal to the closure phone-subpaths.json pins`);

  const dir = await installFixture("rn", ctx);
  const specifiers = phoneSubpathSpecifiers(ctx);
  const coreAt = specifiers.indexOf("@seazn/engine/core");
  if (coreAt === -1) throw new Error("rn: phone-subpaths.json does not list ./core, which the entry folds with");
  const imports = specifiers.map((s, i) => `import * as m${i} from "${s}";`);
  const index = [
    ...imports,
    'import { badminton } from "@seazn/engine/sports/setbased";',
    "",
    "// a fold, so the fold kernel and a sport module are in the closure: badminton at its schema-default config over an empty",
    "// ledger. Nothing here is EXECUTED: Metro resolves and transforms it, and hermesc compiles the production bundle.",
    "const cfg = badminton.configSchema.parse({});",
    'const lineups = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };',
    `const state = m${coreAt}.foldMatch(badminton, cfg, lineups, []);`,
    "",
    `globalThis.__enginePackProof = { state, modules: [${specifiers.map((_, i) => `m${i}`).join(", ")}] };`,
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
    await bundle("control.js", "control.bundle.js", true);
    await compile("control-hermes.js", "control.hbc");
  } catch (e) {
    throw new Error(`rn: TOOLCHAIN FAILURE - Metro/Hermes could not bundle or compile a file that imports nothing of the engine, so this is not an engine finding.\n${e.message}`);
  }
  info("rn: toolchain ran (control entry bundled by Metro, control file compiled by hermesc)");

  await bundle("index.js", "dev.bundle.js", true);
  const paths = devBundleModules(readFileSync(path.join(dir, "dev.bundle.js"), "utf8"));
  const engine = engineDistPaths(paths, ["@seazn/engine", enginePkg.name]);
  info(`rn: dev bundle ${paths.length} modules, ${engine.length} from @seazn/engine/dist (${specifiers.length} subpaths imported)`);
  // exactly the modules the static walk found, as their dist/ twins: this replaces 1b-3's interim floor
  const agreed = assertBundleMatchesWalk({ bundle: engine, walked: phone.walked });
  info(`rn: the dev bundle holds exactly the ${agreed} modules the static phone walk found`);

  await bundle("index.js", "out.js", false);
  await compile("out.js", "out.hbc");
  const hbc = path.join(dir, "out.hbc");
  if (!existsSync(hbc)) throw new Error("rn: hermesc exited 0 but wrote no out.hbc");
  info(`rn: hermesc compiled the production bundle (${readFileSync(hbc).length} bytes of bytecode)`);
  return engine.length;
}

async function typesFixture(ctx) {
  const pins = enginePins();
  const dir = await installFixture("types", ctx, {}, { "fast-check": pins["fast-check"], vitest: pins.vitest, "@types/node": pins["@types/node"] });
  // One `import type * as` per importable specifier (every export key and every sport directory), generated from the packed
  // manifest. An unresolved one is TS2307 under skipLibCheck false, and a resolved one is checked against its .d.ts.
  const lines = ctx.tarball.specifiers.map((specifier, i) => `import type * as m${i} from "${specifier}";`);
  writeFileSync(path.join(dir, "all-exports.ts"), `${lines.join("\n")}\nexport type All = [${lines.map((_, i) => `typeof m${i}`).join(", ")}];\n`);
  const written = readFileSync(path.join(dir, "all-exports.ts"), "utf8").split("\n").filter((l) => l.startsWith("import type * as ")).length;
  if (written !== ctx.tarball.specifiers.length || written === 0) throw new Error(`types: all-exports.ts has ${written} imports for ${ctx.tarball.specifiers.length} specifiers`);
  const compilers = [
    { label: "TS 7", bin: path.join(REPO, "node_modules", "typescript-native", "bin", "tsc"), major: 7 },
    { label: "TS 6", bin: path.join(REPO, "node_modules", "typescript", "bin", "tsc"), major: 6 },
  ];
  const configs = ["tsconfig.bundler.json", "tsconfig.nodenext.json"];
  let passed = 0;
  for (const c of compilers) {
    const version = (await run(`types: ${c.label} --version`, process.execPath, [c.bin, "--version"], { cwd: dir, timeoutMs: 60_000 })).trim();
    if (!version.startsWith(`Version ${c.major}.`)) throw new Error(`types: ${c.bin} reports "${version}", expected a ${c.major}.x`);
    for (const config of configs) {
      await run(`types: ${c.label} -p ${config}`, process.execPath, [c.bin, "-p", config], { cwd: dir, timeoutMs: 5 * 60_000 });
      info(`types: ${version} -p ${config} exit 0 (skipLibCheck false, ${written} specifiers)`);
      passed++;
    }
  }
  if (passed !== compilers.length * configs.length) throw new Error(`types: ${passed} of ${compilers.length * configs.length} compiler runs passed`);
  return written;
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
  // The scratch directory is removed on success AND on failure (a killed run too, best effort); `--keep` keeps it, and says where.
  // A failure prints the tail of what failed, so nothing needs the directory to be read.
  const keep = args.keep;
  installSignalCleanup({ dir: scratchRoot, keep: () => keep, before: () => { for (const child of running) child.kill("SIGTERM"); } });
  try {
    const pnpm = resolvePnpm(scratchRoot);
    console.log(`pack-proof: pnpm ${pnpm.version} (${pnpm.label}), node ${process.version}, scratch ${scratchRoot}`);
    const ctx = { pnpm, scratchRoot, tarball: undefined };
    ctx.tarball = await buildAndPack(ctx);
    const names = args.only === undefined ? FIXTURE_NAMES : [args.only];
    const { results, failures } = await runFixtures(names, FIXTURES, ctx, (line) => console.log(line));
    for (const f of failures) console.error(`\n${f.name}: FAILED\n${f.error.message}`);
    if (failures.length > 0) {
      console.error(`\npack-proof: ${failures.length} of ${names.length} fixture(s) failed (${failures.map((f) => f.name).join(", ")}); re-run with --keep to keep the scratch directory`);
      return 1;
    }
    console.log(`pack-proof: ${results.length} fixture(s) green in ${Math.round((Date.now() - started) / 1000)}s`);
    return 0;
  } catch (e) {
    console.error(`pack-proof: ${e instanceof Error ? e.message : String(e)}\n(re-run with --keep to keep the scratch directory)`);
    return 1;
  } finally {
    if (keep) console.log(`pack-proof: scratch kept at ${scratchRoot}`);
    else rmSync(scratchRoot, { recursive: true, force: true });
  }
}

process.exitCode = await main();
