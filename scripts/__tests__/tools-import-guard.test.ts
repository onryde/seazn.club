// Ruling 56 (2026-10-04): tools/ holds the dev-only harnesses (tools/matrix,
// @seazn/matrix; tools/bench, @seazn/bench). Nothing under apps/ or packages/ — nor
// scripts/, which the Fly image type-checks through apps/web's `typecheck` —
// may import them: tools/ is not in the image (.dockerignore), and a harness
// is a consumer of the product, never a dependency of it.
//
// This file is the exact layer: every import in those trees is resolved to a
// path and judged, every package.json and tsconfig is read (the root
// package.json too — its dependencies, and its scripts that reach tools/,
// which no string in those trees may name: CL-R4, review I-1 and m-2), and the two
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
  /** Every package.json judged, repo-relative — the root one included (m-2). */
  manifestFiles: string[];
  tsconfigs: number;
  /** Root package.json scripts read, and those that reach tools/ (directly or by running one that does). */
  rootScripts: number;
  toolsScripts: string[];
  /** `<file>: <what>` for every edge into tools/. */
  offenders: string[];
}

/** Every string literal's text in a source file — template pieces included, comments never. */
function stringLiterals(f: string, text: string): string[] {
  const kind = /\.[cm]?jsx?$/.test(f) ? (f.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    n.forEachChild(walk);
  };
  walk(ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false, kind));
  return out;
}

/** Does `text` name the script `name` as a whole word — so `x:run` is not `x:runner`? */
const names = (text: string, name: string): boolean => {
  if (!/^[\w:.-]+$/.test(name)) throw new Error(`test: script name ${JSON.stringify(name)} is outside [\\w:.-] — escape it before matching`);
  return new RegExp(`(?<![\\w:.-])${name.replaceAll(".", "\\.")}(?![\\w:-])`).test(text);
};

/** Every import, dependency and tsconfig reference under `root`'s ROOTS that
 *  reaches `root`/tools — by path (resolved), or by a tools/* package name —
 *  plus the root package.json: its dependencies (the image installs from it),
 *  and its scripts. A root script whose command points into tools/ (or runs
 *  one that does) may be run by CI and by hand, but nothing under ROOTS may
 *  name it: a packages/ test that reads a script line and spawns it reaches
 *  tools/ at runtime with no import for the rest of this scan to see (CL-R4,
 *  review I-1: reference:boundary preloaded the harness's crash-exit.ts).
 *  "Named" means spelled, as a whole word, inside a string literal (a
 *  template's text included): the one thing such an edge cannot avoid — a
 *  constant holding the name still spells it — while a comment that mentions
 *  a script is prose, not an edge (scripts/lib/crash-exit.ts's header lists
 *  the scripts that preload it). */
function scan(root: string): Scan {
  const tools = join(root, "tools");
  const pkgNames = new Set(toolsPackagesIn(root));
  const intoTools = (abs: string) => abs === tools || abs.startsWith(tools + sep);
  /** A command's path-shaped words, resolved from `dir`, any of them inside tools/? */
  const pointsIntoTools = (cmd: string, dir: string) =>
    cmd.split(/[\s=]+/).map((w) => w.replace(/^["']|["']$/g, "")).some((w) => !w.startsWith("-") && w.includes("/") && intoTools(resolve(root, dir, w)));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(root, f)));
  const out: Scan = { perRoot: Object.fromEntries(ROOTS.map((r) => [r, 0])), specifiers: 0, manifests: 0, manifestFiles: [], tsconfigs: 0, rootScripts: 0, toolsScripts: [], offenders: [] };
  const judge = (f: string, spec: string) => {
    out.specifiers++;
    const pkg = packageOf(spec);
    if (pkg !== null ? pkgNames.has(pkg) : (spec.startsWith(".") || spec.startsWith("/")) && intoTools(spec.startsWith("/") ? spec : resolve(root, dirname(f), spec))) {
      out.offenders.push(`${f}: ${spec}`);
    }
  };
  /** A manifest's dependencies on a tools/* package, by name or by a local path into tools/. */
  const manifest = (f: string): Record<string, unknown> => {
    out.manifests++;
    out.manifestFiles.push(f);
    const m = JSON.parse(readFileSync(join(root, f), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries((m[field] ?? {}) as Record<string, string>)) {
        const local = /^(?:link|file|portal):(.*)$/.exec(range)?.[1];
        if (pkgNames.has(name) || (local !== undefined && intoTools(resolve(root, dirname(f), local)))) out.offenders.push(`${f}: ${field}.${name}`);
      }
    }
    return m;
  };
  // The root manifest first: its scripts decide which names the trees below may not mention.
  const toolsScripts = new Set<string>();
  if (existsSync(join(root, "package.json"))) {
    const scripts = (manifest("package.json").scripts ?? {}) as Record<string, string>;
    out.rootScripts = Object.keys(scripts).length;
    for (const [n, cmd] of Object.entries(scripts)) if (pointsIntoTools(cmd, ".")) toolsScripts.add(n);
    // A script that runs one of those (`pnpm <it>`, `npm run <it>`) reaches tools/ too.
    for (let grew = true; grew;) {
      grew = false;
      for (const [n, cmd] of Object.entries(scripts)) {
        if (!toolsScripts.has(n) && [...toolsScripts].some((t) => names(cmd, t))) { toolsScripts.add(n); grew = true; }
      }
    }
  }
  out.toolsScripts = [...toolsScripts].sort();
  const named = (f: string, t: string) => out.offenders.push(`package.json: scripts.${t} reaches tools/ and is named by ${f}`);
  /** A source file names a reaching script in a string literal. The plain-text
   *  check first, so only a file that mentions one at all is parsed. */
  const sourceNames = (f: string, text: string) => {
    const mentioned = out.toolsScripts.filter((t) => names(text, t));
    if (mentioned.length === 0) return;
    const literals = stringLiterals(f, text);
    for (const t of mentioned) if (literals.some((l) => names(l, t))) named(f, t);
  };
  for (const f of new Set(files)) {
    const top = f.split("/")[0]!;
    if (SOURCE.test(f)) {
      out.perRoot[top] = (out.perRoot[top] ?? 0) + 1;
      const text = readFileSync(join(root, f), "utf8");
      const info = ts.preProcessFile(text, true, true);
      for (const i of info.importedFiles) judge(f, i.fileName);
      for (const r of info.referencedFiles) judge(f, r.fileName.startsWith(".") ? r.fileName : `./${r.fileName}`);
      sourceNames(f, text);
    } else if (basename(f) === "package.json") {
      const m = manifest(f);
      for (const [n, cmd] of Object.entries((m.scripts ?? {}) as Record<string, string>)) {
        if (pointsIntoTools(cmd, dirname(f))) out.offenders.push(`${f}: scripts.${n}`);
        else for (const t of out.toolsScripts) if (names(cmd, t)) named(`${f} (scripts.${n})`, t);
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
  // The bench (@seazn/bench) is the second harness: by package name and by path.
  ["apps/x/src/e.ts", "@seazn/bench"],
  ["scripts/f.ts", "../tools/bench/lib/env.ts"],
];
const DECOYS: [file: string, spec: string][] = [
  ["apps/x/src/ok.ts", "./tools/local"], // apps/x/src/tools, not the repo's
  ["apps/x/src/ok2.ts", "@seazn/matrixx"],
  ["apps/x/src/ok3.ts", "../../../toolsx/a"],
  ["packages/y/src/ok4.ts", "@seazn/engine/competition"],
  ["scripts/ok5.ts", "@seazn/benchx"],
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
    // No root package.json: no manifest, no script read, none reaching tools/.
    expect({ manifests: s.manifests, rootScripts: s.rootScripts, toolsScripts: s.toolsScripts }).toEqual({ manifests: 0, rootScripts: 0, toolsScripts: [] });
    expect(s.offenders).toEqual([]);
  });

  it("CL-R4 (review I-1, m-2): the root package.json is judged — a dependency on a harness, and a root script that reaches tools/ (directly, or by running one that does) named from a guarded tree", () => {
    const s = scan(fixture({
      "tools/matrix/package.json": JSON.stringify({ name: "@seazn/matrix" }),
      "tools/matrix/lib/crash-exit.ts": "\n",
      "package.json": JSON.stringify({
        name: "root",
        devDependencies: { "@seazn/matrix": "workspace:*" },
        scripts: {
          "m:preload": "node --experimental-strip-types --import ./tools/matrix/lib/crash-exit.ts scripts/gate.ts",
          "m:eq": "node --import=./tools/matrix/lib/crash-exit.ts scripts/gate.ts",
          "m:via": "pnpm m:preload && echo done",
          "m:clean": "node --import ./scripts/lib/crash-exit.ts scripts/gate.ts",
          "m:prefix": "node scripts/gate.ts",
          "lint:all": "eslint scripts tools",
        },
      }),
      // Spawns a reaching script by name: the edge the import scan cannot see.
      "packages/y/test/gate.test.ts": "const line = pkg.scripts[\"m:preload\"];\nconst eq = pkg.scripts[\"m:eq\"];\n",
      "apps/x/run.mjs": "spawn(\"pnpm\", [\"m:via\"]);\n",
      // A template literal spells it too.
      "scripts/tmpl.ts": "const cmd = `pnpm m:eq -- ${x}`;\n",
      // Decoys: a clean script, a name that only starts with a reaching one, a word with no path,
      // and a reaching script named in comments only (prose, not an edge).
      "scripts/ok.ts": "run(\"m:clean\"); run(\"m:preloader\"); run(\"lint:all\");\n// preloaded by m:preload and m:via\n/* m:eq */\n",
      // A nested manifest whose own script points into tools/, and one that runs a reaching root script.
      "packages/y/package.json": JSON.stringify({ name: "y", scripts: { gate: "node ../../tools/matrix/run.ts", relay: "pnpm -w m:eq" } }),
    }));
    expect(s.manifestFiles.sort()).toEqual(["package.json", "packages/y/package.json"]);
    expect(s.rootScripts).toBe(6);
    expect(s.toolsScripts).toEqual(["m:eq", "m:preload", "m:via"]);
    expect(s.offenders.sort()).toEqual([
      "package.json: devDependencies.@seazn/matrix",
      "package.json: scripts.m:eq reaches tools/ and is named by packages/y/package.json (scripts.relay)",
      "package.json: scripts.m:eq reaches tools/ and is named by packages/y/test/gate.test.ts",
      "package.json: scripts.m:eq reaches tools/ and is named by scripts/tmpl.ts",
      "package.json: scripts.m:preload reaches tools/ and is named by packages/y/test/gate.test.ts",
      "package.json: scripts.m:via reaches tools/ and is named by apps/x/run.mjs",
      "packages/y/package.json: scripts.gate",
    ].sort());
  });

  it("positive control: every edge shape into tools/ is found — import, re-export, require, dynamic import, a dependency, a tsconfig path — and no decoy is", () => {
    const files: Record<string, string> = {
      "tools/matrix/package.json": JSON.stringify({ name: "@seazn/matrix" }),
      "tools/bench/package.json": JSON.stringify({ name: "@seazn/bench" }),
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
    expect(s.perRoot).toEqual({ apps: 5, packages: 2, scripts: 4 });
  });

  it("the real tree: apps/, packages/ and scripts/ reach nothing under tools/ — every root read, every import judged", () => {
    const s = scan(REPO);
    console.info(`tools-import-guard: ${JSON.stringify(s.perRoot)} source files, ${s.specifiers} specifiers, ${s.manifests} manifests, ${s.tsconfigs} tsconfigs, ${s.rootScripts} root scripts (${s.toolsScripts.length} reach tools/) judged`);
    for (const r of ROOTS) expect(s.perRoot[r], `${r}: zero files read`).toBeGreaterThan(10);
    expect(s.specifiers).toBeGreaterThan(1000);
    // m-2: the root manifest is judged too — the image installs from it (Dockerfile COPY).
    // The expected list comes from git, never from the scan.
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "package.json", ...ROOTS.map((r) => `${r}/**/package.json`)], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "").sort();
    expect(tracked).toContain("package.json");
    expect(tracked.length).toBeGreaterThanOrEqual(5);
    expect([...s.manifestFiles].sort()).toEqual(tracked);
    expect(s.manifests).toBe(tracked.length);
    expect(s.tsconfigs).toBeGreaterThanOrEqual(3);
    // Root scripts were read, and the harness CLIs are seen reaching tools/ — the
    // positive side, checked against a plain substring oracle (and never by
    // spelling a harness script's name here: this file is itself scanned, and
    // naming one is the very edge it refuses). I-1's reference:boundary is no
    // longer among them.
    const rootScripts = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const oracle = Object.keys(rootScripts).filter((k) => rootScripts[k]!.includes("./tools/") || rootScripts[k]!.includes(" tools/")).sort();
    expect(s.rootScripts).toBe(Object.keys(rootScripts).length);
    expect(s.rootScripts).toBeGreaterThan(20);
    expect(oracle.length).toBeGreaterThanOrEqual(7);
    expect(s.toolsScripts).toEqual(oracle);
    expect(s.offenders).toEqual([]);
    expect(s.toolsScripts).not.toContain("reference:boundary");
  });

  it("the guard's package list is exactly the tools/* workspaces that exist, and its regex matches each — so a new harness joins the guard or reds here", () => {
    const actual = toolsPackagesIn(REPO);
    expect(actual).toContain("@seazn/matrix");
    expect(actual).toContain("@seazn/bench");
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
    expect(EDGES.length + DECOYS.length).toBe(11);
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
  `import "@seazn/bench/lib/env.ts";`, // 6: flagged
  `import "@seazn/benchx";`, // 7: decoy
  "",
].join("\n");
const CONFIGS: [cwd: string, file: string][] = [
  ["apps/web", "src/lib/format-templates.ts"],
  ["packages/engine", "src/competition/index.ts"],
  ["packages/reference", "src/index.ts"],
  [".", "scripts/seed-demo-templates.ts"],
];

describe("tools import guard: each real eslint config reaches its files", () => {
  it.each(CONFIGS)("%s: lines 2, 3 and 6 of the probe go red as %s, the decoys do not", (cwd, file) => {
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
    expect(ours.map((m) => m.line)).toEqual([2, 3, 6]);
    for (const m of ours) expect(m.message).toContain(TOOLS_IMPORT_MESSAGE);
    // The file was parsed, not ignored: no fatal parse message.
    expect(results[0]!.messages.filter((m) => m.ruleId === null)).toEqual([]);
  }, LINT_MS + SLACK_MS);
});
