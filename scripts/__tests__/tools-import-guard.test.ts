// Ruling 56 (2026-10-04): tools/ holds the dev-only harnesses (tools/matrix,
// @seazn/matrix; the bench later). Nothing under apps/ or packages/ — nor
// scripts/, which the Fly image type-checks through apps/web's `typecheck` —
// may import them: tools/ is not in the image (.dockerignore), and a harness
// is a consumer of the product, never a dependency of it.
//
// This file is the exact layer: every import in those trees is resolved to a
// path and judged, every package.json and tsconfig is read, and the two
// guards' shared source (scripts/lib/tools-import-guard.mjs) is held to the
// tools/* workspaces that actually exist. The eslint rule built from that
// source is the coarse layer; the last block below runs each of the four real
// eslint configs on stdin to prove the rule reaches the files it guards.
// Single-sport reason: no sport is involved — this is an import-graph guard.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { TOOLS_IMPORT_MESSAGE, TOOLS_IMPORT_REGEX, TOOLS_PACKAGES } from "../lib/tools-import-guard.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The trees the guard holds. */
const ROOTS = ["apps", "packages", "scripts"] as const;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** A specifier's package name: `@scope/name` or `name`; null for a path or a builtin. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The package names of `root`'s tools/* workspaces, read from their manifests. */
function toolsPackagesIn(root: string): string[] {
  const dir = join(root, "tools");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "package.json")))
    .map((d) => (JSON.parse(readFileSync(join(dir, d, "package.json"), "utf8")) as { name: string }).name)
    .sort();
}

interface Scan {
  /** Source files read, per root. */
  perRoot: Record<string, number>;
  /** Import specifiers judged, across every file. */
  specifiers: number;
  manifests: number;
  tsconfigs: number;
  /** `<file>: <what>` for every edge into tools/. */
  offenders: string[];
}

/** Every import, dependency and tsconfig reference under `root`'s ROOTS that
 *  reaches `root`/tools — by path (resolved), or by a tools/* package name. */
function scan(root: string): Scan {
  const tools = join(root, "tools");
  const names = new Set(toolsPackagesIn(root));
  const intoTools = (abs: string) => abs === tools || abs.startsWith(tools + sep);
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(root, f)));
  const out: Scan = { perRoot: Object.fromEntries(ROOTS.map((r) => [r, 0])), specifiers: 0, manifests: 0, tsconfigs: 0, offenders: [] };
  const judge = (f: string, spec: string) => {
    out.specifiers++;
    const pkg = packageOf(spec);
    if (pkg !== null ? names.has(pkg) : (spec.startsWith(".") || spec.startsWith("/")) && intoTools(spec.startsWith("/") ? spec : resolve(root, dirname(f), spec))) {
      out.offenders.push(`${f}: ${spec}`);
    }
  };
  for (const f of new Set(files)) {
    const top = f.split("/")[0]!;
    if (SOURCE.test(f)) {
      out.perRoot[top] = (out.perRoot[top] ?? 0) + 1;
      const info = ts.preProcessFile(readFileSync(join(root, f), "utf8"), true, true);
      for (const i of info.importedFiles) judge(f, i.fileName);
      for (const r of info.referencedFiles) judge(f, r.fileName.startsWith(".") ? r.fileName : `./${r.fileName}`);
    } else if (basename(f) === "package.json") {
      out.manifests++;
      const m = JSON.parse(readFileSync(join(root, f), "utf8")) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, range] of Object.entries((m[field] ?? {}) as Record<string, string>)) {
          const local = /^(?:link|file|portal):(.*)$/.exec(range)?.[1];
          if (names.has(name) || (local !== undefined && intoTools(resolve(root, dirname(f), local)))) out.offenders.push(`${f}: ${field}.${name}`);
        }
      }
    } else if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(basename(f))) {
      out.tsconfigs++;
      const read = ts.readConfigFile(join(root, f), (p) => readFileSync(p, "utf8"));
      if (read.error) throw new Error(`${f}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
      const c = read.config as { include?: string[]; files?: string[]; extends?: string | string[]; references?: { path: string }[]; compilerOptions?: { paths?: Record<string, string[]> } };
      const paths = [
        ...(c.include ?? []), ...(c.files ?? []), ...[c.extends ?? []].flat(), ...(c.references ?? []).map((r) => r.path),
        ...Object.values(c.compilerOptions?.paths ?? {}).flat(),
      ].filter((p) => p.startsWith("."));
      for (const p of paths) if (intoTools(resolve(root, dirname(f), p.replace(/\*.*$/, "")))) out.offenders.push(`${f}: ${p}`);
    }
  }
  return out;
}

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

/** A throwaway repo: the given files, untracked (git ls-files --others sees them). */
function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tools-guard-")));
  temps.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

// One table drives the resolver's positive control AND the eslint regex: the
// coarse layer must flag what the exact one finds, and pass every decoy.
const EDGES: [file: string, spec: string][] = [
  ["apps/x/src/a.ts", "../../../tools/matrix/run.ts"],
  ["packages/y/src/b.ts", "@seazn/matrix/lib/x"],
  ["scripts/c.mjs", "../tools/matrix/model.ts"],
  ["scripts/d.cjs", "../tools"],
];
const DECOYS: [file: string, spec: string][] = [
  ["apps/x/src/ok.ts", "./tools/local"], // apps/x/src/tools, not the repo's
  ["apps/x/src/ok2.ts", "@seazn/matrixx"],
  ["apps/x/src/ok3.ts", "../../../toolsx/a"],
  ["packages/y/src/ok4.ts", "@seazn/engine/competition"],
];
const line = (file: string, spec: string): string =>
  file.endsWith(".cjs") ? "const m = require(" + JSON.stringify(spec) + ");\n"
    : file.endsWith(".mjs") ? "const m = await import(" + JSON.stringify(spec) + ");\n"
      : file.includes("/b.ts") ? "export * from " + JSON.stringify(spec) + ";\n"
        : "import { run } from " + JSON.stringify(spec) + ";\n";

describe("tools import guard (ruling 56)", () => {
  it("empty case first: a repo with nothing in apps/, packages/ or scripts/ scans zero files — which the real-tree test below refuses", () => {
    const s = scan(fixture({ "tools/matrix/package.json": JSON.stringify({ name: "@seazn/matrix" }), "README": "x\n" }));
    expect(Object.values(s.perRoot).reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.offenders).toEqual([]);
  });

  it("positive control: every edge shape into tools/ is found — import, re-export, require, dynamic import, a dependency, a tsconfig path — and no decoy is", () => {
    const files: Record<string, string> = {
      "tools/matrix/package.json": JSON.stringify({ name: "@seazn/matrix" }),
      "tools/matrix/run.ts": "import { x } from \"../../apps/x/src/a.ts\";\n", // tools may import the product
      "packages/y/package.json": JSON.stringify({ name: "y", devDependencies: { "@seazn/matrix": "workspace:*" } }),
      "apps/x/package.json": JSON.stringify({ name: "x", dependencies: { z: "link:../../tools/matrix" } }),
      "apps/x/tsconfig.json": "{\n  // comments are legal here\n  \"include\": [\"src/**/*.ts\", \"../../tools/matrix/**/*.ts\"]\n}\n",
    };
    for (const [f, spec] of [...EDGES, ...DECOYS]) files[f] = (files[f] ?? "") + line(f, spec);
    const s = scan(fixture(files));
    expect(s.offenders.sort()).toEqual([
      ...EDGES.map(([f, spec]) => `${f}: ${spec}`),
      "apps/x/package.json: dependencies.z",
      "apps/x/tsconfig.json: ../../tools/matrix/**/*.ts",
      "packages/y/package.json: devDependencies.@seazn/matrix",
    ].sort());
    // Every edge and decoy was read as a specifier: nothing passed by going unread.
    expect(s.specifiers).toBe(EDGES.length + DECOYS.length);
    expect(s.perRoot).toEqual({ apps: 4, packages: 2, scripts: 2 });
  });

  it("the real tree: apps/, packages/ and scripts/ reach nothing under tools/ — every root read, every import judged", () => {
    const s = scan(REPO);
    console.info(`tools-import-guard: ${JSON.stringify(s.perRoot)} source files, ${s.specifiers} specifiers, ${s.manifests} manifests, ${s.tsconfigs} tsconfigs judged`);
    for (const r of ROOTS) expect(s.perRoot[r], `${r}: zero files read`).toBeGreaterThan(10);
    expect(s.specifiers).toBeGreaterThan(1000);
    expect(s.manifests).toBeGreaterThanOrEqual(3);
    expect(s.tsconfigs).toBeGreaterThanOrEqual(3);
    expect(s.offenders).toEqual([]);
  });

  it("the guard's package list is exactly the tools/* workspaces that exist, and its regex matches each — so a new harness joins the guard or reds here", () => {
    const actual = toolsPackagesIn(REPO);
    expect(actual).toContain("@seazn/matrix");
    expect([...TOOLS_PACKAGES].sort()).toEqual(actual);
    const re = new RegExp(TOOLS_IMPORT_REGEX);
    for (const name of actual) {
      expect(re.test(name), name).toBe(true);
      expect(re.test(`${name}/lib/x.ts`), `${name}/…`).toBe(true);
      expect(re.test(`${name}x`), `${name}x`).toBe(false);
    }
  });

  it("the eslint regex flags every edge specifier the resolver finds, and passes every decoy", () => {
    const re = new RegExp(TOOLS_IMPORT_REGEX);
    for (const [, spec] of EDGES) expect(re.test(spec), spec).toBe(true);
    for (const [, spec] of DECOYS) expect(re.test(spec), spec).toBe(false);
    expect(EDGES.length + DECOYS.length).toBe(8);
  });
});

// The real configs, spawned: a rule present in a config but not reaching the
// files would still pass a config-reading test (packages/reference's
// eslint-inline-type.test.ts is the precedent). One spawn per test; the
// budget is one cap plus slack (AGENTS.md class 20).
const LINT_MS = 90_000;
const SLACK_MS = 5_000;
const PROBE = [
  `import "node:path";`, // 1: benign
  `import "@seazn/matrix";`, // 2: flagged
  `import "../../../../tools/matrix/run.ts";`, // 3: flagged
  `import "./tools/local";`, // 4: decoy
  `import "@seazn/matrixx";`, // 5: decoy
  "",
].join("\n");
const CONFIGS: [cwd: string, file: string][] = [
  ["apps/web", "src/lib/format-templates.ts"],
  ["packages/engine", "src/competition/index.ts"],
  ["packages/reference", "src/index.ts"],
  [".", "scripts/seed-demo-templates.ts"],
];

describe("tools import guard: each real eslint config reaches its files", () => {
  it.each(CONFIGS)("%s: lines 2 and 3 of the probe go red as %s, the decoys do not", (cwd, file) => {
    const dir = resolve(REPO, cwd);
    const eslint = join(dir, "node_modules", ".bin", "eslint");
    expect(existsSync(eslint), eslint).toBe(true);
    expect(existsSync(join(dir, file)), `${file} must be a real file in the project`).toBe(true);
    // TSESTREE_SINGLE_RUN=false: in single-run mode (CI=true, or a plain CLI
    // run) a `parserOptions.project` config lints the file ON DISK and ignores
    // stdin — measured: the root config reported nothing for the probe.
    const r = spawnSync(eslint, ["--format", "json", "--stdin", "--stdin-filename", file], {
      cwd: dir, input: PROBE, encoding: "utf8", timeout: LINT_MS, env: { ...process.env, TSESTREE_SINGLE_RUN: "false" },
    });
    const results = JSON.parse(r.stdout.trim() === "" ? "[]" : r.stdout) as { filePath: string; messages: { ruleId: string | null; line: number; message: string }[] }[];
    expect(results, r.stderr).toHaveLength(1);
    expect(relative(dir, results[0]!.filePath)).toBe(file);
    const ours = results[0]!.messages.filter((m) => m.ruleId === "@typescript-eslint/no-restricted-imports");
    expect(ours.map((m) => m.line)).toEqual([2, 3]);
    for (const m of ours) expect(m.message).toContain(TOOLS_IMPORT_MESSAGE);
    // The file was parsed, not ignored: no fatal parse message.
    expect(results[0]!.messages.filter((m) => m.ruleId === null)).toEqual([]);
  }, LINT_MS + SLACK_MS);
});
