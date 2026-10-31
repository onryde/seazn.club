// D19: published as @onryde/seazn-engine, consumed as @seazn/engine. Pins both halves so nobody "fixes" one.
//
// The scan is a function of a repo root, so the real tree is judged once and the SHAPES of failure are judged on scratch trees
// (a stale spec under a glob the typed list never had, behind a correct sibling field, in a peer or optional field).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCOPED = "@onryde/seazn-engine";
const ALIAS = "@seazn/engine";
/** Engine split 2b (A1): the registry alias at a caret range on one full release, as scripts/__tests__/registry-install.test.ts pins. Which release is the engine-release bump's business. */
const SPEC_SHAPE = /^npm:@onryde\/seazn-engine@\^\d+\.\d+\.\d+$/;
const WANT_SHAPE = `a caret range on the registry alias (npm:${SCOPED}@^X.Y.Z)`;
/** The scratch repos' own release: deliberately not the one the real tree is on, so a scan that judged the VALUE would fail here. */
const SPEC = `npm:${SCOPED}@^7.8.9`;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
/** Engine split 2b (reverse inventory row 14, I): the engine is the installed package, linked under its alias. */
const INSTALLED_ENGINE_MANIFEST = "node_modules/@seazn/engine/package.json";

type Field = (typeof FIELDS)[number];
type Manifest = { name?: string } & Partial<Record<Field, Record<string, string>>>;

/** The `packages:` globs of pnpm-workspace.yaml, read as tools/matrix/__tests__/workspace-wiring.test.ts reads them. */
function workspaceGlobs(root: string): string[] {
  const lines = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === "packages:");
  if (at < 0) throw new Error("pnpm-workspace.yaml has no packages: key");
  const globs: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(l);
    if (m?.[1] === undefined) break;
    globs.push(m[1]);
  }
  return globs;
}

/** Every workspace manifest (the globs pnpm itself reads) plus the root, relative to `root`. A glob this cannot expand is a refusal, never a skip. */
function manifestPaths(root: string): string[] {
  const globs = workspaceGlobs(root);
  for (const g of globs) if (!/^[\w.-]+\/\*$/.test(g)) throw new Error(`workspace glob ${g} is not the <dir>/* shape this scan expands: extend the scan, do not skip it`);
  const dirs = globs.flatMap((g) => {
    const d = g.slice(0, -2);
    return readdirSync(path.join(root, d)).map((n) => `${d}/${n}`);
  });
  return ["package.json", ...dirs.map((d) => `${d}/package.json`).filter((p) => existsSync(path.join(root, p)))];
}

/**
 * Judges every dependency field of every manifest, each separately (a `??` across fields lets a correct one shadow a stale one):
 * a field naming the alias must hold a caret range on the registry alias (SPEC_SHAPE), every such field must hold the IDENTICAL
 * specifier (the first one judged, the root manifest's, is the reference), and no field may name the scoped package.
 */
function scan(root: string): { manifests: string[]; consumers: string[]; checked: number; problems: string[] } {
  const manifests = manifestPaths(root);
  const consumers = new Set<string>();
  const problems: string[] = [];
  let checked = 0;
  let reference: { where: string; spec: string } | undefined;
  for (const p of manifests) {
    const m = JSON.parse(readFileSync(path.join(root, p), "utf8")) as Manifest;
    for (const field of FIELDS) {
      const deps = m[field] ?? {};
      if (SCOPED in deps) { consumers.add(p); checked++; problems.push(`${p}: ${field} names ${SCOPED} (consumers import the alias key ${ALIAS})`); }
      if (ALIAS in deps) {
        consumers.add(p);
        checked++;
        const spec = deps[ALIAS];
        const where = `${p}: ${field}["${ALIAS}"]`;
        if (typeof spec !== "string" || !SPEC_SHAPE.test(spec)) problems.push(`${where} is ${JSON.stringify(spec)}, want ${WANT_SHAPE}`);
        else if (reference === undefined) reference = { where, spec };
        else if (spec !== reference.spec) problems.push(`${where} is ${JSON.stringify(spec)}, but ${reference.where} is ${JSON.stringify(reference.spec)} — every consumer carries the identical specifier`);
      }
    }
  }
  return { manifests, consumers: [...consumers].sort(), checked, problems };
}

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A scratch repo: `globs` for pnpm-workspace.yaml and `{ "<dir>/<name>": manifest }` (the root manifest is "."). */
function scratchRepo(globs: string[], packages: Record<string, Manifest>): string {
  const root = mkdtempSync(path.join(tmpdir(), "engine-identity-"));
  scratch.push(root);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), `# scratch\npackages:\n${globs.map((g) => `  - "${g}"\n`).join("")}\noverrides:\n  x: y\n`);
  for (const [dir, m] of Object.entries(packages)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(m));
  }
  return root;
}
const good: Manifest = { dependencies: { [ALIAS]: SPEC } };

describe("engine package identity", () => {
  it("is published under the GitHub owner's scope", () => {
    expect((JSON.parse(readFileSync(path.join(ROOT, INSTALLED_ENGINE_MANIFEST), "utf8")) as Manifest).name).toBe(SCOPED);
  });

  it("every workspace that depends on the engine imports it as @seazn/engine through the alias, in every dependency field", () => {
    const { manifests, consumers, checked, problems } = scan(ROOT);
    expect(manifests.length, "the workspace scan found next to nothing").toBeGreaterThan(5);
    // 6 at 1b-1: root, apps/web, packages/reference (dev), packages/scheduler, tools/matrix, tools/bench.
    expect(consumers.length, `found ${consumers.length} engine consumers (${consumers.join(", ")}) — fewer than 6 means the scan is vacuous or a consumer was dropped`).toBeGreaterThanOrEqual(6);
    expect(checked, "no dependency entry was judged").toBeGreaterThanOrEqual(consumers.length);
    expect(problems, `${checked} entries judged in ${consumers.length} consumers`).toEqual([]);
  });

  describe("the scan itself (scratch repos)", () => {
    it("accepts a tree that is right everywhere, and counts what it judged", () => {
      const root = scratchRepo(["apps/*", "libs/*"], { ".": good, "apps/a": good, "libs/b": { devDependencies: { [ALIAS]: SPEC } } });
      const r = scan(root);
      expect(r.consumers).toEqual(["apps/a/package.json", "libs/b/package.json", "package.json"]);
      expect(r.checked).toBe(3);
      expect(r.problems).toEqual([]);
    });

    it("follows pnpm-workspace.yaml, not a typed list: a stale consumer under a glob the repo did not have before is found, and ignored when the glob is absent", () => {
      const stale: Manifest = { dependencies: { [ALIAS]: "workspace:*" } };
      const withGlob = scan(scratchRepo(["apps/*", "libs/*"], { ".": good, "apps/a": good, "libs/stale": stale }));
      expect(withGlob.problems).toEqual([`libs/stale/package.json: dependencies["${ALIAS}"] is "workspace:*", want ${WANT_SHAPE}`]);
      const without = scan(scratchRepo(["apps/*"], { ".": good, "apps/a": good, "libs/stale": stale }));
      expect(without.problems, "the glob is not declared, so pnpm does not treat libs/stale as a workspace").toEqual([]);
    });

    it("judges a stale devDependencies even when dependencies is correct (no ?? shadowing)", () => {
      const root = scratchRepo(["apps/*"], { ".": good, "apps/a": { dependencies: { [ALIAS]: SPEC }, devDependencies: { [ALIAS]: "workspace:*" } } });
      expect(scan(root).problems).toEqual([`apps/a/package.json: devDependencies["${ALIAS}"] is "workspace:*", want ${WANT_SHAPE}`]);
    });

    it.each(FIELDS)("judges a stale %s", (field) => {
      const root = scratchRepo(["apps/*"], { ".": good, "apps/a": { [field]: { [ALIAS]: "*" } } });
      expect(scan(root).problems).toEqual([`apps/a/package.json: ${field}["${ALIAS}"] is "*", want ${WANT_SHAPE}`]);
    });

    it("accepts any caret release, not a typed one", () => {
      for (const v of ["^1.0.0", "^1.1.0", "^2.13.7", "^0.4.2"]) {
        const spec = `npm:${SCOPED}@${v}`;
        const r = scan(scratchRepo(["apps/*"], { ".": { dependencies: { [ALIAS]: spec } }, "apps/a": { dependencies: { [ALIAS]: spec } } }));
        expect(r.checked, `${v}: entries judged`).toBe(2);
        expect(r.problems, v).toEqual([]);
      }
    });

    it.each([
      ["workspace:*"], ["link:../engine"], ["file:../engine"], ["latest"], ["*"], ["^7.8.9"],
      [`npm:${SCOPED}@0.0.0-pr6.abc`], [`npm:${SCOPED}@^7.8.9-beta.1`], [`npm:${SCOPED}@~7.8.9`], [`npm:${SCOPED}@7.8.9`], [`npm:${SCOPED}@^7.8`], [`npm:${SCOPED}@latest`], ["npm:@other/pkg@^7.8.9"],
    ])("refuses %s as the engine specifier", (spec) => {
      const r = scan(scratchRepo(["apps/*"], { ".": good, "apps/a": { dependencies: { [ALIAS]: spec } } }));
      expect(r.checked).toBe(2);
      expect(r.problems).toEqual([`apps/a/package.json: dependencies["${ALIAS}"] is ${JSON.stringify(spec)}, want ${WANT_SHAPE}`]);
    });

    it("refuses every consumer when the whole tree is on a non-release specifier", () => {
      const bad: Manifest = { dependencies: { [ALIAS]: `npm:${SCOPED}@0.0.0-pr6.abc` } };
      const r = scan(scratchRepo(["apps/*"], { ".": bad, "apps/a": bad, "apps/b": bad }));
      expect(r.checked).toBe(3);
      expect(r.problems.length, "one problem per consumer").toBe(3);
    });

    it("refuses one consumer on a different release while the others agree, whichever one it is", () => {
      const other: Manifest = { dependencies: { [ALIAS]: `npm:${SCOPED}@^7.9.0` } };
      const apps = scan(scratchRepo(["apps/*"], { ".": good, "apps/a": good, "apps/b": other }));
      expect(apps.checked).toBe(3);
      expect(apps.problems).toEqual([`apps/b/package.json: dependencies["${ALIAS}"] is "npm:${SCOPED}@^7.9.0", but package.json: dependencies["${ALIAS}"] is "${SPEC}" — every consumer carries the identical specifier`]);
      // The odd one out is the root: the reference is the first judged, so both siblings are the ones named.
      const root = scan(scratchRepo(["apps/*"], { ".": other, "apps/a": good, "apps/b": good }));
      expect(root.problems.length).toBe(2);
      expect(root.problems.every((x) => x.includes("every consumer carries the identical specifier"))).toBe(true);
    });

    it("refuses two fields of one manifest on different releases (no ?? shadowing)", () => {
      const root = scratchRepo(["apps/*"], { ".": good, "apps/a": { dependencies: { [ALIAS]: SPEC }, devDependencies: { [ALIAS]: `npm:${SCOPED}@^7.9.0` } } });
      expect(scan(root).problems).toEqual([`apps/a/package.json: devDependencies["${ALIAS}"] is "npm:${SCOPED}@^7.9.0", but package.json: dependencies["${ALIAS}"] is "${SPEC}" — every consumer carries the identical specifier`]);
    });

    it.each(FIELDS)("refuses the scoped name as a key in %s", (field) => {
      const root = scratchRepo(["apps/*"], { ".": good, "apps/a": { [field]: { [SCOPED]: SPEC } } });
      expect(scan(root).problems).toEqual([`apps/a/package.json: ${field} names ${SCOPED} (consumers import the alias key ${ALIAS})`]);
    });

    it("refuses a workspace glob shape it cannot expand rather than skipping it", () => {
      expect(() => scan(scratchRepo(["apps/*", "libs/**"], { ".": good }))).toThrow(/libs\/\*\* is not the <dir>\/\* shape/);
    });
  });
});
