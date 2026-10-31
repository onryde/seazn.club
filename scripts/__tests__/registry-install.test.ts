// Engine split 2b, Task A1: seazn.club installs the engine from GitHub Packages, `"@seazn/engine":
// "npm:@onryde/seazn-engine@^X.Y.Z"` (a caret range on the registry alias; which release is the engine-release bump's business, so
// no version literal is pinned here), and packages/engine has left the workspace. Three pins:
//
//   1. every consumer RESOLVES the registry package, at the version its lock importer names, through a lock importer whose
//      specifier is the manifest's own. A leftover `node_modules/@seazn/engine -> ../../packages/engine` link, or a checkout
//      whose install predates its manifest, would otherwise be a green against stale source (plan Review Focus 4, AGENTS.md
//      class 14);
//      and that version satisfies the caret range the manifest declares (a bump that edited the manifests but not the lock
//      would otherwise pass against the old release);
//   2. every consumer pins a caret range on the alias (never workspace:, link:, file:, a tag, `*` or a 0.0.0-pr snapshot), all
//      six carry the IDENTICAL specifier, and the consumer set is the six the plan names (a seventh is a deliberate edit here,
//      never a silent one);
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
/** The shape of a pin: the registry alias at a caret range on one full release. No prerelease, no `workspace:`/`link:`/`file:`, no tag, no `*`. */
const SPEC_SHAPE = /^npm:@onryde\/seazn-engine@\^(\d+)\.(\d+)\.(\d+)$/;
const WANT_SHAPE = `a caret range on the registry alias (npm:${SCOPED}@^X.Y.Z)`;
/** Does `^major.minor.patch` admit `version`? The semver caret rule: the leftmost non-zero part is the ceiling. `semver` is not a root dependency, so this is read here. */
function caretAdmits(range: string, version: string): boolean {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version); // a prerelease is admitted by no prerelease-free caret
  if (r === null || v === null) return false;
  const [rM, rm, rp] = [r[1]!, r[2]!, r[3]!].map(Number) as [number, number, number];
  const [vM, vm, vp] = [v[1]!, v[2]!, v[3]!].map(Number) as [number, number, number];
  const atLeast = vM > rM || (vM === rM && (vm > rm || (vm === rm && vp >= rp)));
  if (!atLeast) return false;
  if (rM > 0) return vM === rM;
  if (rm > 0) return vM === 0 && vm === rm;
  return vM === 0 && vm === 0 && vp === rp;
}
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
      const range = declared !== undefined && SPEC_SHAPE.test(declared) ? declared.slice(declared.lastIndexOf("@") + 1) : undefined;
      if (range === undefined) problems.push(`${dir}: the manifest's ${String(declared)} is not ${WANT_SHAPE}`);
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
      if (range !== undefined && !caretAdmits(range, version)) problems.push(`${dir}: the lock resolves ${SCOPED}@${version}, which the manifest's range ${range} does not admit`);
      checked++;
    }
    expect(problems).toEqual([]);
    expect(checked, "consumers whose resolution was checked").toBe(CONSUMERS.length);
  });

  it("every consumer pins a caret range on the registry alias, all six identical", () => {
    const consumers: string[] = [];
    const problems: string[] = [];
    const specs = new Map<string, string>(); // "<manifest>: <field>" -> specifier
    for (const dir of [".", ...workspaceDirs()]) {
      const m = manifest(dir);
      let named = false;
      for (const field of FIELDS) {
        const spec = m[field]?.[ALIAS];
        if (spec === undefined) continue;
        named = true;
        const where = `${dir === "." ? "" : `${dir}/`}package.json: ${field}["${ALIAS}"]`;
        specs.set(where, spec);
        if (!SPEC_SHAPE.test(spec)) problems.push(`${where} is ${JSON.stringify(spec)}, want ${WANT_SHAPE}`);
      }
      if (named) consumers.push(dir);
    }
    expect(problems).toEqual([]);
    expect(consumers.sort()).toEqual([...CONSUMERS].sort());
    expect(specs.size, "dependency fields naming the alias").toBe(CONSUMERS.length);
    // Consistency: one release range across the repo. A bump that edits five manifests and forgets the sixth is a skew, not a bump.
    expect(new Set(specs.values()).size, `consumers disagree on the specifier: ${JSON.stringify(Object.fromEntries(specs), null, 1)}`).toBe(1);
  });

  describe("the range pin's own judgement (so a bump that is right passes, and a wrong shape does not)", () => {
    const ok = (v: string) => `npm:${SCOPED}@${v}`;
    it.each(["^1.0.0", "^1.1.0", "^2.13.7", "^0.4.2", "^10.20.30"])("accepts %s", (v) => {
      expect(SPEC_SHAPE.test(ok(v))).toBe(true);
    });
    it.each([
      ["workspace:*"], ["workspace:^1.0.0"], ["link:../engine"], ["file:../engine"], ["latest"], ["*"], ["^1.0.0"],
      [ok("0.0.0-pr6.abc")], [ok("^1.0.0-beta.1")], [ok("~1.0.0")], [ok("1.0.0")], [ok("^1.0")], [ok("^1")], [ok(">=1.0.0")], [ok("latest")], [ok("*")],
      ["npm:@other/pkg@^1.0.0"], [`${ok("^1.0.0")} `],
    ])("refuses %s", (spec) => {
      expect(SPEC_SHAPE.test(spec)).toBe(false);
    });
    // Expected values are the semver caret rule (^1.2.3 := >=1.2.3 <2.0.0; ^0.2.3 := >=0.2.3 <0.3.0; ^0.0.3 := >=0.0.3 <0.0.4).
    it.each([
      ["^1.0.0", "1.0.0", true], ["^1.0.0", "1.9.3", true], ["^1.0.0", "2.0.0", false], ["^1.0.0", "0.9.9", false],
      ["^1.1.0", "1.0.0", false], ["^1.1.0", "1.1.0", true], ["^1.1.0", "1.0.9", false], ["^1.1.0", "1.1.1", true],
      ["^0.2.3", "0.2.3", true], ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false], ["^0.2.3", "0.2.2", false], ["^0.2.3", "1.0.0", false],
      ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false], ["^0.0.3", "0.1.0", false],
      ["^1.0.0", "1.1.0-beta.1", false], ["^1.0.0", "workspace", false], ["1.0.0", "1.0.0", false],
    ] as const)("%s admits %s: %s", (range, version, admitted) => {
      expect(caretAdmits(range, version)).toBe(admitted);
    });
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
