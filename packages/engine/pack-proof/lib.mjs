// The decisions behind pack-proof/run.mjs that need no network and no child process, so test/pack-proof.test.ts can hold each
// one to a failing input (engine-split Task 1b-3). run.mjs is the only importer; nothing here is part of the published package.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Throws when `dir` (symlinks resolved) is the repo or anywhere beneath it.
 *
 *  A fixture installed inside the repo resolves `zod`, `typescript`, `next` ... by walking UP into the repo's own node_modules,
 *  so every import "works" whether or not the tarball is a complete package. The proof is only a proof from outside. */
export function assertOutsideRepo(dir, repoRoot) {
  const real = realpathSync(dir);
  const root = realpathSync(repoRoot);
  const rel = path.relative(root, real);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  if (inside) throw new Error(`refusing to use ${real}: it is inside the repo (${root}), where a missing dependency would resolve from the repo's node_modules`);
}

/** A fixture that checked nothing proves nothing: the count must be a positive integer. */
export function requireChecked(name, n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: ${String(n)} checked - a fixture that checked nothing is a failure, not a pass`);
  return n;
}

const SRC_SEGMENT = /(^|\/)src(\/|$)/;
const TS_SOURCE = /(?<!\.d)\.m?ts$/; // a `.ts` that is not a declaration file

function leaves(value, at) {
  if (typeof value === "string") return [[at, value]];
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
  throw new Error(`${at}: an export target must be a string or a conditions object, got ${JSON.stringify(value)}`);
}

/** What a registry consumer gets from the packed manifest. `manifest` is the tarball's own package.json, `files` the set of
 *  paths in the tarball relative to the package root (no `package/` prefix), `expectedKeys` the workspace's export subpaths,
 *  `where` what `files` is, for the message (run.mjs also calls this on the emitted dist/ BEFORE packing, where an empty dist/
 *  would otherwise pack a 15-file tarball with every export dangling and exit 0).
 *
 *  Throws on: no exports; a key set that differs from the workspace's; any target under `src/` or any `.ts` that is not a
 *  `.d.ts` (what `npm pack` ships when publishConfig.exports is not applied); any target the tarball does not contain; a `*`
 *  pattern that matches no file. Returns the number of export targets checked (every leaf string, a `*` pattern counting once). */
export function checkTarballExports({ manifest, files, expectedKeys, where = "the tarball" }) {
  const exp = manifest.exports;
  if (exp === null || typeof exp !== "object" || Object.keys(exp).length === 0) throw new Error("the packed package.json has no exports");
  const keys = Object.keys(exp).sort();
  const want = [...expectedKeys].sort();
  if (want.length === 0) throw new Error("no expected export keys were given (the workspace declares none to compare against)");
  if (JSON.stringify(keys) !== JSON.stringify(want)) {
    const missing = want.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !want.includes(k));
    throw new Error(`the packed exports differ from the workspace's: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }
  let checked = 0;
  for (const [at, target] of Object.entries(exp).flatMap(([key, value]) => leaves(value, `exports[${JSON.stringify(key)}]`))) {
    if (!target.startsWith("./")) throw new Error(`${at}: "${target}" is not a ./ path`);
    const rel = target.slice(2);
    if (SRC_SEGMENT.test(rel) || TS_SOURCE.test(rel)) throw new Error(`${at}: "${target}" points at source, which the tarball does not ship (was it packed by npm instead of pnpm?)`);
    if (!rel.startsWith("dist/")) throw new Error(`${at}: "${target}" is outside dist/`);
    if (rel.includes("*")) {
      // as in a Node subpath pattern, `*` stands for any non-empty string, slashes included
      const re = new RegExp(`^${rel.split("*").map((s) => s.replace(/[.+^$|\\()[\]{}?]/g, "\\$&")).join(".+")}$`);
      if (![...files].some((f) => re.test(f))) throw new Error(`${at}: the pattern "${target}" matches no file in ${where}`);
    } else if (!files.has(rel)) {
      throw new Error(`${at}: "${target}" is not in ${where} (a dangling export)`);
    }
    checked++;
  }
  return checked;
}

/** The pnpm to run: the first candidate whose `--version`, asked from OUTSIDE the repo, is exactly `pinned`.
 *  A bare `pnpm` asked inside the repo answers with the repo's pin (corepack reads `packageManager`), while the same `pnpm` run
 *  in a scratch directory answers with whatever is global - so the version is always asked where the fixtures will run it.
 *  `versionOf(candidate)` returns the printed version, or throws when the candidate is not installed. */
export function pickPnpm(pinned, candidates, versionOf) {
  const seen = [];
  for (const candidate of candidates) {
    let version;
    try {
      version = String(versionOf(candidate)).trim();
    } catch (e) {
      seen.push(`${candidate.label}: unavailable (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
      continue;
    }
    if (version === pinned) return { ...candidate, version };
    seen.push(`${candidate.label}: ${version}`);
  }
  throw new Error(`no pnpm ${pinned} is available outside the repo (${seen.join("; ")}). Install it, or enable corepack so \`corepack pnpm@${pinned}\` works.`);
}

/** The module paths of a Metro DEV bundle: every `__d(` definition ends `, <id>, [<deps>], "<path>")`. The definition count and
 *  the path count must agree, or the pattern here has stopped reading the bundle and the engine-module count would be a lie. */
export function devBundleModules(bundle) {
  const definitions = (bundle.match(/(^|[^\w$.])__d\(/g) ?? []).length;
  const paths = [...bundle.matchAll(/\},\s*\d+\s*,\s*\[[\d,\s]*\]\s*,\s*"([^"\n]+)"\s*\)/g)].map((m) => m[1]);
  if (definitions === 0) throw new Error("the dev bundle holds no __d( module definition");
  if (definitions !== paths.length) throw new Error(`the dev bundle has ${definitions} __d( definitions but ${paths.length} readable module paths`);
  return paths;
}

/** The modules of the engine's emitted build among a bundle's module paths. Metro records REAL paths, and where the package sits
 *  depends on the installer: `node_modules/@seazn/engine/dist/...` for a copy, `node_modules/.pnpm/<id>/node_modules/@onryde/seazn-engine/dist/...`
 *  under pnpm (its virtual store names the directory by the package's own name, not the alias). `names` are the spellings to
 *  accept (the alias and the published name). */
export function engineModules(paths, names) {
  if (names.length === 0) throw new Error("engineModules needs at least one package name");
  return paths.filter((p) => names.some((n) => p.includes(`/node_modules/${n}/dist/`) || p.startsWith(`node_modules/${n}/dist/`)) && p.endsWith(".js"));
}

/** Run every selected fixture, never stopping at the first failure (CI should show every red leg at once). `fixtures` maps a
 *  name to `async (ctx) => N`. A thrown error and a count that is not a positive integer are both failures. `log` receives
 *  each `<name>: <N> checked` line. Returns `{ results, failures }`. */
export async function runFixtures(names, fixtures, ctx, log) {
  const results = [];
  const failures = [];
  for (const name of names) {
    const fixture = fixtures[name];
    if (fixture === undefined) {
      failures.push({ name, error: new Error(`no fixture named ${name}`) });
      continue;
    }
    try {
      const n = requireChecked(name, await fixture(ctx));
      results.push({ name, n });
      log(`${name}: ${n} checked`);
    } catch (error) {
      failures.push({ name, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { results, failures };
}

// --------------------------------------------------------------------------------------------- what the proof must cover

/** The specifiers a consumer can import: every non-pattern key of the PACKED manifest's `exports`, plus the `./sports/*` pattern
 *  expanded over `sportDirs`. `name` is the alias the fixtures install under. Throws on a pattern it has no expansion for, on a
 *  `*` with no directory to expand over, and on an empty result (a proof that imports nothing proves nothing). */
export function exportSpecifiers({ manifest, sportDirs, name = "@seazn/engine" }) {
  const exp = manifest.exports;
  if (exp === null || typeof exp !== "object" || Object.keys(exp).length === 0) throw new Error("the packed package.json has no exports");
  const out = [];
  for (const key of Object.keys(exp)) {
    if (!key.startsWith("./")) throw new Error(`export key "${key}" is not a ./ subpath`);
    if (!key.includes("*")) {
      out.push(`${name}/${key.slice(2)}`);
    } else if (key === "./sports/*") {
      if (sportDirs.length === 0) throw new Error("./sports/* has no sport directory to expand over");
      for (const dir of sportDirs) out.push(`${name}/sports/${dir}`);
    } else {
      throw new Error(`export pattern "${key}" has no known expansion: teach exportSpecifiers how to enumerate it`);
    }
  }
  return out;
}

/** The sport directories a tarball file list holds an index for: `dist/sports/<dir>/index.js`, sorted. */
export function sportDirsOf(files) {
  return [...files].flatMap((f) => {
    const m = /^dist\/sports\/([^/]+)\/index\.js$/.exec(f);
    return m === null ? [] : [m[1]];
  }).sort();
}

/** The sport directories of the workspace source that hold an index.ts (what the tarball's dist/sports must mirror). */
export function sourceSportDirs(engineDir) {
  const base = `${engineDir}/src/sports`;
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${base}/${d.name}/index.ts`))
    .map((d) => d.name)
    .sort();
}

/** Two collections must hold the same members. An empty expectation is refused: it would be satisfied by an empty actual. */
export function assertSameSet(label, actual, expected) {
  if (expected.length === 0) throw new Error(`${label}: nothing to compare against (an empty expectation is satisfied by anything empty)`);
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = [...e].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !e.has(x));
  if (a.size !== actual.length) throw new Error(`${label}: duplicates in the actual set`);
  if (missing.length > 0 || extra.length > 0) throw new Error(`${label}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
}

/** The app-router entries a fixture DECLARES, as the keys Next writes to `.next/server/app-paths-manifest.json`:
 *  `app/page.tsx` -> `/page`, `app/api/probe/route.ts` -> `/api/probe/route`. Layouts and everything else are not routes.
 *  `files` are `/`-separated paths relative to `app/`. */
export function declaredAppRoutes(files) {
  return [...new Set(files.flatMap((f) => {
    const m = /^(?:(.*)\/)?(page|route)\.(?:tsx?|jsx?)$/.exec(f);
    return m === null ? [] : [`/${m[1] === undefined ? "" : `${m[1]}/`}${m[2]}`];
  }))].sort();
}

// ------------------------------------------------------------------------------------------------------------ fixture pins

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The version the repo resolved for `name`, read from `<dir>/node_modules/<name>/package.json`. Throws when it is not installed
 *  there (never a fallback to a range). */
export function installedVersion(dir, name) {
  const file = `${dir}/node_modules/${name}/package.json`;
  if (!existsSync(file)) throw new Error(`${name} is not installed under ${dir} (run pnpm install at the repo root)`);
  const version = JSON.parse(readFileSync(file, "utf8")).version;
  if (typeof version !== "string" || !EXACT.test(version)) throw new Error(`${name} reports version ${JSON.stringify(version)}, expected x.y.z`);
  return version;
}

/** Every dependency a fixture installs is an exact x.y.z (the tarball itself is a `file:` spec). No fixture lockfile exists, so
 *  a range would let the proof drift from the versions the repo tests against. */
export function assertExactVersions(label, deps, { fileSpecs = ["@seazn/engine"] } = {}) {
  const entries = Object.entries(deps ?? {});
  for (const [name, spec] of entries) {
    if (fileSpecs.includes(name) && typeof spec === "string" && spec.startsWith("file:")) continue;
    if (typeof spec !== "string" || !EXACT.test(spec)) throw new Error(`${label}: ${name} is "${String(spec)}", not an exact x.y.z`);
  }
  return entries.length;
}

// --------------------------------------------------------------------------------------------------------------- clean-up

/** Remove `dir` when SIGINT/SIGTERM arrives, unless `keep()` says to keep it, then exit 128+signal. `before` runs first (the run
 *  uses it to stop the children that are still writing into `dir`). The handler only gets to run while the event loop does, so
 *  the run must wait on its children asynchronously. Best effort by nature: a SIGKILL cannot be handled. `proc` is the process
 *  (an EventEmitter with `exit`), injectable so a test can raise the signal without killing itself. */
export function installSignalCleanup({ dir, keep, before = () => undefined, proc = process }) {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    proc.once(signal, () => {
      before();
      if (!keep()) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      proc.exit(code);
    });
  }
}
