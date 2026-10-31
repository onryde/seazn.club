// Engine split 2b, Task A1: seazn.club installs the engine from GitHub Packages, `"@seazn/engine":
// "npm:@onryde/seazn-engine@^1.0.0"`, and packages/engine has left the workspace. Three pins:
//
//   1. every consumer RESOLVES the registry package, at the version its lock importer names, through a lock importer whose
//      specifier is the manifest's own. A leftover `node_modules/@seazn/engine -> ../../packages/engine` link, or a checkout
//      whose install predates its manifest, would otherwise be a green against stale source (plan Review Focus 4, AGENTS.md
//      class 14);
//   2. every consumer pins exactly the alias spec, and the consumer set is the six the plan names (a seventh is a deliberate
//      edit here, never a silent one);
//   3. the Docker install sees the registry credential only through a BuildKit secret mount, never an ARG, an ENV or a copied
//      file (plan Review Focus 2).
//
// Single-sport reason: no sport is involved; this is the dependency wiring.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCOPED = "@onryde/seazn-engine";
const ALIAS = "@seazn/engine";
const SPEC = `npm:${SCOPED}@^1.0.0`;
/** The six consumers (plan Global Constraints), as lock importer keys. */
const CONSUMERS = [".", "apps/web", "packages/reference", "packages/scheduler", "tools/bench", "tools/matrix"] as const;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
/** The mount the Docker install must carry: the npmrc arrives as a BuildKit secret, at the user-level config path. */
const SECRET_MOUNT = "--mount=type=secret,id=npmrc,target=/root/.npmrc";

type Manifest = Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")) as Manifest;

/** The `packages:` globs of pnpm-workspace.yaml, read line by line as tools/matrix/__tests__/workspace-wiring.test.ts reads them. */
function workspaceDirs(): string[] {
  const lines = readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === "packages:");
  if (at < 0) throw new Error("pnpm-workspace.yaml has no packages: key");
  const dirs: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const g = /^\s+-\s+["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(l)?.[1];
    if (g === undefined) break;
    if (!/^[\w.-]+\/\*$/.test(g)) throw new Error(`workspace glob ${g} is not the <dir>/* shape this scan expands: extend the scan, do not skip it`);
    const d = g.slice(0, -2);
    for (const n of readdirSync(path.join(ROOT, d))) if (existsSync(path.join(ROOT, d, n, "package.json"))) dirs.push(`${d}/${n}`);
  }
  if (dirs.length === 0) throw new Error("pnpm-workspace.yaml's globs expanded to no manifest");
  return dirs;
}

/** Each importer's `@seazn/engine` entry in pnpm-lock.yaml (parsed by lines: the repo root has no YAML dependency). */
function lockEntries(): Map<string, { specifier: string; version: string }> {
  const out = new Map<string, { specifier: string; version: string }>();
  const lines = readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  let section = "";
  let importer = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[a-zA-Z]/.test(line)) { section = line.replace(/:.*$/, ""); continue; }
    if (section !== "importers") continue;
    const key = /^ {2}(\S.*?):(?: \{\})?$/.exec(line);
    if (key !== null) { importer = key[1]!.replace(/^'(.*)'$/, "$1"); continue; }
    if (/^ {6}'@seazn\/engine':$/.test(line)) {
      const specifier = /^ {8}specifier: (.+)$/.exec(lines[i + 1] ?? "")?.[1];
      const version = /^ {8}version: (.+)$/.exec(lines[i + 2] ?? "")?.[1];
      if (specifier === undefined || version === undefined) throw new Error(`pnpm-lock.yaml: importer ${importer}'s @seazn/engine entry is not the specifier/version shape this parse reads`);
      out.set(importer, { specifier: specifier.replace(/^'(.*)'$/, "$1"), version: version.replace(/^'(.*)'$/, "$1") });
    }
  }
  return out;
}

/** The Dockerfile's instructions: comment lines dropped, `\` continuations joined, as Docker parses them. */
function dockerInstructions(): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of readFileSync(path.join(ROOT, "Dockerfile"), "utf8").split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const continued = /\\\s*$/.test(raw);
    cur += `${raw.replace(/\\\s*$/, "")} `;
    if (continued) continue;
    if (cur.trim() !== "") out.push(cur.trim().replace(/\s+/g, " "));
    cur = "";
  }
  if (cur.trim() !== "") out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}

describe("@seazn/engine is installed from GitHub Packages (engine split 2b, A1)", () => {
  it("@seazn/engine resolves to the registry package", () => {
    const lock = lockEntries();
    const problems: string[] = [];
    let checked = 0;
    for (const dir of CONSUMERS) {
      const m = manifest(dir);
      const declared = FIELDS.map((f) => m[f]?.[ALIAS]).find((s) => s !== undefined);
      const entry = lock.get(dir);
      if (entry === undefined) { problems.push(`${dir}: pnpm-lock.yaml has no @seazn/engine entry for this importer`); continue; }
      if (entry.specifier !== declared) problems.push(`${dir}: the lock's specifier ${entry.specifier} is not the manifest's ${String(declared)} — the install predates the manifest`);
      const version = new RegExp(`^${SCOPED.replace(/[/@]/g, "\\$&")}@([^(]+)`).exec(entry.version)?.[1];
      if (version === undefined) { problems.push(`${dir}: the lock resolves @seazn/engine to ${entry.version}, not a ${SCOPED} version`); continue; }
      let real: string;
      try {
        real = realpathSync(createRequire(path.join(ROOT, dir, "package.json")).resolve(`${ALIAS}/core`));
      } catch (e) {
        problems.push(`${dir}: ${ALIAS}/core does not resolve (${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      const pkgRoot = /^(.*\/node_modules\/\.pnpm\/@onryde\+seazn-engine@[^/]+\/node_modules\/@onryde\/seazn-engine)\//.exec(real)?.[1];
      if (pkgRoot === undefined) { problems.push(`${dir}: ${ALIAS}/core resolves to ${real}, outside node_modules/.pnpm/@onryde+seazn-engine@*`); continue; }
      const installed = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { name?: string; version?: string };
      if (installed.name !== SCOPED || installed.version !== version) problems.push(`${dir}: installed ${installed.name}@${installed.version}, the lock says ${SCOPED}@${version}`);
      checked++;
    }
    expect(problems).toEqual([]);
    expect(checked, "consumers whose resolution was checked").toBe(CONSUMERS.length);
  });

  it("every consumer pins the alias", () => {
    const consumers: string[] = [];
    const problems: string[] = [];
    let fields = 0;
    for (const dir of [".", ...workspaceDirs()]) {
      const m = manifest(dir);
      let named = false;
      for (const field of FIELDS) {
        const spec = m[field]?.[ALIAS];
        if (spec === undefined) continue;
        named = true;
        fields++;
        if (spec !== SPEC) problems.push(`${dir === "." ? "" : `${dir}/`}package.json: ${field}["${ALIAS}"] is ${JSON.stringify(spec)}, want ${JSON.stringify(SPEC)}`);
      }
      if (named) consumers.push(dir);
    }
    expect(problems).toEqual([]);
    expect(consumers.sort()).toEqual([...CONSUMERS].sort());
    expect(fields, "dependency fields naming the alias").toBe(CONSUMERS.length);
  });

  it("Dockerfile installs with the npmrc secret only", () => {
    const instructions = dockerInstructions();
    const installs = instructions.filter((i) => /^RUN\s/i.test(i) && /\bpnpm\s+install\b/.test(i));
    expect(installs.length, "RUN instructions that pnpm install").toBeGreaterThan(0);
    for (const i of installs) expect(i, "every install RUN mounts the npmrc secret").toContain(SECRET_MOUNT);

    const argsAndEnvs = instructions.filter((i) => /^(ARG|ENV)\s/i.test(i));
    expect(argsAndEnvs.length, "ARG/ENV instructions scanned").toBeGreaterThan(0);
    expect(argsAndEnvs.filter((i) => /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/i.test(i))).toEqual([]);

    const copies = instructions.filter((i) => /^(COPY|ADD)\s/i.test(i));
    expect(copies.length, "COPY/ADD instructions scanned").toBeGreaterThan(0);
    const sources = copies.flatMap((i) => i.split(" ").slice(1).filter((t) => !t.startsWith("--")).slice(0, -1));
    expect(sources.filter((s) => /(^|\/)\.npmrc$/.test(s))).toEqual([]);

    // `COPY . .` puts the committed .npmrc in the builder layer (it is not in .dockerignore), so it must hold no credential:
    // the registry mapping only. pnpm 10.34 refuses to expand `${NODE_AUTH_TOKEN}` in a project .npmrc anyway ("Ignored
    // project-level auth setting"), so a credential line there could only ever be a literal token.
    const npmrc = readFileSync(path.join(ROOT, ".npmrc"), "utf8").split("\n").filter((l) => l.trim() !== "" && !/^\s*[#;]/.test(l));
    expect(npmrc).toEqual(["@onryde:registry=https://npm.pkg.github.com"]);
  });
});
