import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

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
    expect(workspaces).toContain("packages/engine");
  });
  it("the Dockerfile COPYs every workspace manifest BEFORE pnpm install --frozen-lockfile", () => {
    const docker = read("Dockerfile").split("\n");
    const install = docker.findIndex((l) => l.includes("pnpm install --frozen-lockfile"));
    expect(install).toBeGreaterThan(0);
    let judged = 0;
    for (const w of workspaces) {
      const at = docker.findIndex((l) => l.trim() === `COPY ${w}/package.json ${w}/`);
      expect(at, `${w}: no COPY line`).toBeGreaterThan(-1);
      expect(at, `${w}: COPY after install`).toBeLessThan(install);
      judged++;
    }
    expect(judged).toBe(workspaces.length);
    expect(judged).toBeGreaterThan(2);
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
    const files = readdirSync(resolve(REPO, "packages/reference/src")).filter((f) => f.endsWith(".ts"));
    let bare = 0;
    for (const f of files) for (const m of read(`packages/reference/src/${f}`).matchAll(/from\s+"([^".][^"]*)"/g)) {
      bare++;
      const name = m[1]!.startsWith("@") ? m[1]!.split("/").slice(0, 2).join("/") : m[1]!.split("/")[0]!;
      expect(declared.has(name), `${f}: ${m[1]} is not declared`).toBe(true);
    }
    expect(bare).toBeGreaterThan(0);
  });
  it("packages/reference: the engine is a DEV dependency (types only), and every devDependency it shares with the engine has the engine's range", () => {
    const ref = JSON.parse(read("packages/reference/package.json")) as Manifest;
    const engine = JSON.parse(read("packages/engine/package.json")) as Manifest;
    expect(ref.dependencies?.["@seazn/engine"]).toBeUndefined();
    expect(ref.devDependencies?.["@seazn/engine"]).toBe("workspace:*");
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
    expect(pkg.scripts["reference:boundary"]).toBe("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/reference-boundary.ts");
  });
  it("packages/reference: turbo keys its lint AND typecheck on the engine's inputs, so an engine type change is a cache miss (review M-4)", () => {
    // The real consumer, spawned: turbo's own dry-run task graph. Both tasks
    // read @seazn/engine/core types (tsc, and the type-aware lint), so each
    // must depend on a task whose inputs hold the engine core sources.
    const r = spawnSync(resolve(REPO, "node_modules", ".bin", "turbo"), ["run", "lint", "typecheck", "--filter=@seazn/reference", "--dry=json"], {
      cwd: REPO, encoding: "utf8", timeout: SPAWN_MS,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TURBO_TELEMETRY_DISABLED: "1" },
    });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    type Task = { taskId: string; dependencies: string[]; inputs: Record<string, string> };
    const tasks = (JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { tasks: Task[] }).tasks;
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    let judged = 0;
    for (const id of ["@seazn/reference#lint", "@seazn/reference#typecheck"]) {
      const t = byId.get(id);
      expect(t, `${id} missing from the turbo graph`).toBeDefined();
      const engineDeps = (t?.dependencies ?? []).filter((d) => d.startsWith("@seazn/engine#"));
      expect(engineDeps, `${id} does not depend on any @seazn/engine task`).not.toEqual([]);
      for (const d of engineDeps) {
        const inputs = Object.keys(byId.get(d)?.inputs ?? {});
        expect(inputs, `${d} does not hash the engine core types`).toContain("src/core/types.ts");
        expect(inputs).toContain("src/core/index.ts");
      }
      judged++;
    }
    expect(judged).toBe(2);
  }, spawnBudget(1));
});
