import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const workspaces = ["apps", "packages"].flatMap((d) => readdirSync(resolve(REPO, d)).map((n) => `${d}/${n}`)).filter((w) => existsSync(resolve(REPO, w, "package.json")));

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };

describe("workspace wiring (trap 2: a new package is invisible to the root chains)", () => {
  it("the workspace list is non-empty and includes packages/reference", () => {
    expect(workspaces.length).toBeGreaterThan(2);
    expect(workspaces).toContain("packages/reference");
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
    expect(pkg.scripts["reference:boundary"]).toBe("node --experimental-strip-types scripts/reference-boundary.ts");
  });
});
