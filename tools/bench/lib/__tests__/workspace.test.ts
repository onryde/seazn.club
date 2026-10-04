// The bench is the @seazn/bench workspace at tools/bench. It left scripts/bench
// on 2026-10-04, following the format matrix to tools/ (format-matrix ruling 56:
// tools/ holds the dev-only harnesses). A workspace move leaves two things
// behind that nothing else here would notice, and this file checks both
// against the tree:
//   - The manifest is out of step with the code. If the bench imports a package
//     the manifest does not declare, pnpm still resolves it from the root, so
//     every run stays green while the manifest is wrong. A declared package
//     the bench no longer imports is not a real dependency either.
//   - A live wiring file still runs or names the old directory: the root
//     scripts, the CI step that runs this suite, or the manual bench workflow.
// The import guard (scripts/__tests__/tools-import-guard.test.ts) holds the
// other direction: nothing in apps/, packages/ or scripts/ may reach tools/.
// Single-sport reason: no sport is involved. This pins a manifest and its wiring.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = resolve(BENCH, "..", "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

interface Manifest {
  name?: string;
  private?: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}
const manifest = JSON.parse(readFileSync(join(BENCH, "package.json"), "utf8")) as Manifest;
const root = JSON.parse(read("package.json")) as Manifest;

/** The `.ts` files a real run loads. Tests and their helpers are left out:
 *  vitest loads those, and their tooling (vitest, typescript) comes from the
 *  root, as it does for every other suite here. */
function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") shipped(full, out);
      continue;
    }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** A bare specifier's package name (`@scope/name` or `name`); null for a
 *  relative path or a node builtin. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || isBuiltin(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The old spelling as a path, never as part of another one:
 *  `packages/engine/scripts/bench-build.ts` is a different file. */
const OLD = /(?<![\w/.-])scripts\/bench(?![\w-])/;

describe("@seazn/bench: the workspace at tools/bench", () => {
  it("sits at tools/bench as @seazn/bench, a private ESM workspace pnpm sees, and scripts/bench is gone", () => {
    expect(relative(REPO, BENCH)).toBe(join("tools", "bench"));
    expect(manifest.name).toBe("@seazn/bench");
    expect(manifest.private).toBe(true);
    // The nearest package.json decides how node --experimental-strip-types
    // reads a .ts file: it was the root's (ESM) under scripts/, and is this
    // one's now.
    expect(manifest.type).toBe("module");
    const lines = read("pnpm-workspace.yaml").split("\n");
    const at = lines.findIndex((l) => l.trim() === "packages:");
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1).map((l) => l.trim())).toContain('- "tools/*"');
    // A recreated old directory would let a stale path resolve to the wrong copy.
    expect(existsSync(join(REPO, "scripts", "bench"))).toBe(false);
  });

  it("declares exactly the packages the bench's shipped modules import, each at the root's range", () => {
    const modules = shipped(BENCH);
    const imported = new Set<string>();
    let specifiers = 0;
    for (const f of modules) {
      for (const i of ts.preProcessFile(readFileSync(f, "utf8"), true, true).importedFiles) {
        specifiers++;
        const pkg = packageOf(i.fileName);
        if (pkg !== null) imported.add(pkg);
      }
    }
    const used = [...imported].sort();
    console.info(`bench workspace: ${modules.length} shipped modules, ${specifiers} specifiers read; packages ${JSON.stringify(used)}`);
    // Anti-vacuity: the entrypoint and the library were read, and they import packages at all.
    expect(modules.length).toBeGreaterThanOrEqual(40);
    expect(modules).toContain(join(BENCH, "bench.ts"));
    expect(specifiers).toBeGreaterThan(100);
    expect(used.length).toBeGreaterThan(0);
    // Both directions: an undeclared import, and a declared package nothing imports.
    const declared = Object.keys(manifest.dependencies ?? {}).sort();
    expect(declared).toEqual(used);
    // Real dependencies only, and only one kind of them.
    expect([manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]).toEqual([undefined, undefined, undefined]);
    // The root's ranges, so the lockfile resolves the same versions the bench ran on under scripts/.
    const rootRanges = { ...root.devDependencies, ...root.dependencies };
    let ranged = 0;
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      expect(range, name).toBe(rootRanges[name]);
      ranged++;
    }
    expect(ranged).toBe(declared.length);
  });

  it("is run from tools/bench by the root scripts, the CI step and the manual workflow, and no wiring file names scripts/bench", () => {
    // The root scripts: each command's .ts file exists under tools/bench.
    const benchScripts = Object.entries(root.scripts ?? {}).filter(([n]) => n.startsWith("bench:"));
    expect(benchScripts.map(([n]) => n).sort()).toEqual(["bench:build-packs", "bench:scheduler"]);
    for (const [n, cmd] of benchScripts) {
      const file = cmd.split(/\s+/).find((w) => w.endsWith(".ts"));
      expect(file, n).toBeDefined();
      expect(file!.startsWith("tools/bench/"), `${n}: ${cmd}`).toBe(true);
      expect(existsSync(join(REPO, file!)), `${n}: ${file}`).toBe(true);
    }
    // The CI step that runs this suite: the positional is a substring filter, so it must spell today's directory.
    const ci = read(".github/workflows/ci.yml").split("\n");
    const step = ci.findIndex((l) => l.trim() === "- name: Bench lib unit tests (DB-free)");
    expect(step).toBeGreaterThan(-1);
    expect(ci[step + 1]!.trim().startsWith("run: ")).toBe(true);
    expect(ci[step + 1]!.trimEnd().endsWith(" --testTimeout=30000 tools/bench")).toBe(true);
    // The manual workflow's run step.
    expect(read(".github/workflows/bench.yml")).toContain("node --experimental-strip-types tools/bench/bench.ts \\\n");
    // No wiring file spells the old directory.
    const wiring = [
      "package.json", "pnpm-workspace.yaml", "eslint.config.mjs", "tsconfig.scripts.json", "turbo.json", ".gitignore", ".dockerignore",
      ...readdirSync(join(REPO, ".github", "workflows")).filter((f) => f.endsWith(".yml")).map((f) => `.github/workflows/${f}`),
    ];
    const offenders: string[] = [];
    for (const f of wiring) read(f).split("\n").forEach((l, i) => { if (OLD.test(l)) offenders.push(`${f}:${i + 1}`); });
    console.info(`bench workspace: ${wiring.length} wiring files read for the old directory`);
    expect(wiring.length).toBeGreaterThan(8);
    expect(offenders).toEqual([]);
    // The probe itself: it sees the old path, and not a different file that only contains it.
    expect(["node scripts/bench/bench.ts", "--testTimeout=30000 scripts/bench", "`scripts/bench/lib/env.ts`"].map((s) => OLD.test(s))).toEqual([true, true, true]);
    expect(["packages/engine/scripts/bench-build.ts", "scripts/bench-x.ts", "tools/bench/bench.ts", "./scripts/benchx"].map((s) => OLD.test(s))).toEqual([false, false, false, false]);
  });
});
