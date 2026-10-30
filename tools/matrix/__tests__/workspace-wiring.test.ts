import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
/**
 * The `packages:` globs of pnpm-workspace.yaml — the file pnpm itself reads to
 * decide what a workspace is (review M-3: never a hard-coded directory list).
 * Only the `<dir>/*` shape is expanded; any other glob is returned as-is so the
 * shape test below refuses it rather than this helper guessing.
 */
function workspaceGlobs(): string[] {
  const lines = read("pnpm-workspace.yaml").split("\n");
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
const globs = workspaceGlobs();
const workspaces = globs
  .filter((g) => /^[\w.-]+\/\*$/.test(g))
  .flatMap((g) => { const d = g.slice(0, -2); return readdirSync(resolve(REPO, d)).map((n) => `${d}/${n}`); })
  .filter((w) => existsSync(resolve(REPO, w, "package.json")));

/**
 * Workspaces the Fly image deliberately does NOT build. `.dockerignore` lists them — the
 * workspace itself, or a directory above it — so the Dockerfile never COPYs their manifest
 * (apps/cron-worker: ruled A2 of the Cloudflare cron plan, because the builder stage never installs
 * its devDependencies and `turbo run typecheck` inside the image would fail on it; tools/*: the
 * dev-only harnesses, tools/bench and tools/matrix, ruling 56, ignored as the whole `tools/`
 * directory). Read from the file,
 * never a list typed here.
 */
const dockerignored = new Set(
  read(".dockerignore").split("\n").map((l) => l.trim().replace(/^\/|\/$/g, "")).filter((l) => l !== "" && !l.startsWith("#")),
);
/** The `.dockerignore` line that excludes workspace `w`: `w` itself or its nearest listed ancestor. */
function ignoredBy(w: string): string | undefined {
  const parts = w.split("/");
  for (let i = parts.length; i > 0; i--) {
    const p = parts.slice(0, i).join("/");
    if (dockerignored.has(p)) return p;
  }
  return undefined;
}
const imageExempt = workspaces.filter((w) => ignoredBy(w) !== undefined);

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };

describe("workspace wiring (trap 2: a new package is invisible to the root chains)", () => {
  it("the workspace list comes from pnpm-workspace.yaml's globs, is non-empty and includes packages/reference", () => {
    // Every glob is the `<dir>/*` shape the enumeration expands; a new shape
    // (`tools/**`, a negation) must extend it, never be silently skipped.
    expect(globs.length).toBeGreaterThan(0);
    for (const g of globs) expect(g, `unexpanded workspace glob ${g}`).toMatch(/^[\w.-]+\/\*$/);
    expect(globs).toContain("packages/*");
    expect(workspaces.length).toBeGreaterThan(2);
    expect(workspaces).toContain("packages/reference");
    // Engine split 2b (reverse inventory row 21): packages/engine is no longer a workspace (it is the registry package).
    // Ruling 56: the matrix harness is the tools/matrix workspace (@seazn/matrix), and the scheduler
    // bench followed it to tools/bench (@seazn/bench).
    expect(globs).toContain("tools/*");
    expect(workspaces).toContain("tools/matrix");
    expect(workspaces).toContain("tools/bench");
  });
  it("the Dockerfile COPYs every workspace manifest BEFORE pnpm install --frozen-lockfile", () => {
    const docker = read("Dockerfile").split("\n");
    const install = docker.findIndex((l) => l.includes("pnpm install --frozen-lockfile"));
    expect(install).toBeGreaterThan(0);
    let judged = 0;
    for (const w of workspaces) {
      if (imageExempt.includes(w)) continue; // judged by the exemption test below
      const at = docker.findIndex((l) => l.trim() === `COPY ${w}/package.json ${w}/`);
      expect(at, `${w}: no COPY line`).toBeGreaterThan(-1);
      expect(at, `${w}: COPY after install`).toBeLessThan(install);
      judged++;
    }
    expect(judged + imageExempt.length).toBe(workspaces.length);
    expect(judged).toBeGreaterThan(2);
  });
  it("the ONLY workspaces the Dockerfile may skip are ones `.dockerignore` lists, and they must not be COPYed either", () => {
    // Anti-vacuity and anti-widening: the exemption set is exactly the Cloudflare cron Worker and the
    // two dev-only harnesses, the scheduler bench and the matrix (ruling 56: tools/ is dev-only and
    // ignored as a whole). A fourth dockerignored workspace, or any of them leaving `.dockerignore`,
    // fails here and needs a conscious edit.
    expect(imageExempt).toEqual(["apps/cron-worker", "tools/bench", "tools/matrix"]);
    // Each by the line the ruling names: the Worker by its own path, each harness by the tools/ directory.
    expect(imageExempt.map((w) => [w, ignoredBy(w)])).toEqual([["apps/cron-worker", "apps/cron-worker"], ["tools/bench", "tools"], ["tools/matrix", "tools"]]);
    const docker = read("Dockerfile");
    for (const w of imageExempt) {
      expect(ignoredBy(w), `${w} is not under a line of .dockerignore`).toBeDefined();
      // COPYing a path the build context excludes would fail the image build.
      expect(docker, `${w}: dockerignored but COPYed`).not.toContain(`COPY ${w}/`);
    }
  });
  it("every workspace with a lint/typecheck/test script is in the root chain of that name", () => {
    let judged = 0;
    for (const w of workspaces) {
      const scripts = (JSON.parse(read(`${w}/package.json`)) as Manifest).scripts ?? {};
      for (const s of ["lint", "typecheck", "test"] as const) {
        if (scripts[s] === undefined) continue;
        judged++;
        expect(pkg.scripts[s], `root ${s} misses ${w}`).toContain(`npm run ${s} --workspace ${w}`);
      }
    }
    expect(judged).toBeGreaterThanOrEqual(9);
  });
  it("packages/reference: every bare import in src is a declared dependency", () => {
    const ref = JSON.parse(read("packages/reference/package.json")) as Manifest;
    const declared = new Set([...Object.keys(ref.dependencies ?? {}), ...Object.keys(ref.devDependencies ?? {})]);
    // Recursive: W2a's family lives in src/families/, which a flat scan of src/ never read (ruling T15-R3).
    const files = (readdirSync(resolve(REPO, "packages/reference/src"), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.includes("/")).length, "no file under a src/ subdirectory was scanned (src/families/ holds the W2a family)").toBeGreaterThan(0);
    let bare = 0;
    for (const f of files) for (const m of read(`packages/reference/src/${f}`).matchAll(/from\s+"([^".][^"]*)"/g)) {
      // A Node built-in (`node:fs` in a family test reading Appendix A) is never a package dependency.
      if (m[1]!.startsWith("node:")) continue;
      bare++;
      const name = m[1]!.startsWith("@") ? m[1]!.split("/").slice(0, 2).join("/") : m[1]!.split("/")[0]!;
      expect(declared.has(name), `${f}: ${m[1]} is not declared`).toBe(true);
    }
    expect(bare).toBeGreaterThan(0);
  });
  it("packages/reference: the engine is a DEV dependency (types only), and every devDependency it shares with the engine has the engine's range", () => {
    const ref = JSON.parse(read("packages/reference/package.json")) as Manifest;
    // Engine split 2b (I): the engine's devDependencies are read from its installed (published) manifest.
    const engine = JSON.parse(read("packages/reference/node_modules/@seazn/engine/package.json")) as Manifest;
    expect(ref.dependencies?.["@seazn/engine"]).toBeUndefined();
    expect(ref.devDependencies?.["@seazn/engine"]).toBe("npm:@onryde/seazn-engine@^1.0.0"); // engine split 2b (A1): the registry alias
    let shared = 0;
    for (const [name, range] of Object.entries(ref.devDependencies ?? {})) {
      const theirs = engine.devDependencies?.[name];
      if (theirs === undefined) continue;
      shared++;
      expect(range, `${name}`).toBe(theirs);
    }
    // eslint, @eslint/js, typescript-eslint, @types/node, typescript, typescript-native, vitest
    expect(shared).toBeGreaterThanOrEqual(7);
  });
  it("packages/reference: every root chain names it with the script it actually has", () => {
    const scripts = (JSON.parse(read("packages/reference/package.json")) as Manifest).scripts ?? {};
    for (const s of ["lint", "typecheck", "test"] as const) {
      expect(scripts[s], `packages/reference has no ${s} script`).toBeDefined();
      expect(pkg.scripts[s]).toContain(`npm run ${s} --workspace packages/reference`);
    }
    expect(pkg.scripts["reference:boundary"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts scripts/reference-boundary.ts");
  });
  // Engine split 2b (reverse inventory row 21): the two tests that held turbo's lint and typecheck of packages/reference and
  // packages/scheduler to an `@onryde/seazn-engine#` task hashing the engine's sources left with the engine workspace. A registry
  // dependency has no turbo task; turbo keys it through the lockfile instead (`hashOfExternalDependencies`).
});
