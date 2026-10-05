// Ruling 56 (2026-10-04): tools/ holds the dev-only harnesses (tools/matrix,
// @seazn/matrix; tools/bench, @seazn/bench). Nothing under apps/ or packages/ — nor
// scripts/, which the Fly image type-checks through apps/web's `typecheck` —
// may import them: tools/ is not in the image (.dockerignore), and a harness
// is a consumer of the product, never a dependency of it.
//
// This file is the exact layer: every import in those trees is resolved to a
// path and judged, every package.json and tsconfig is read (the root
// package.json too — its dependencies, and its scripts that reach tools/,
// which no string in those trees may name: CL-R4, review I-1 and m-2), every
// spawn call's ARGUMENTS are read for a tools/ path (W1d item 28: a string
// handed to exec/spawn/fork runs harness code with no import for the rest of
// this scan to see — see spawnCallsIn for what it reads and its stated limits),
// and the two guards' shared source (scripts/lib/tools-import-guard.mjs) is held
// to the tools/* workspaces that actually exist. The eslint rule built from that
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
  /** Spawn calls (exec/spawn/fork and their Sync forms) inspected, across every file not in SPAWN_EXEMPT (item 28). */
  spawnCalls: number;
  /** The inspected calls by callee name — the spelling each was written with. */
  spawnByName: Record<string, number>;
  /** Files holding at least one inspected spawn call. */
  spawnFiles: string[];
  /** The SPAWN_EXEMPT files the walk met. They are skipped for every count above, but READ for hits. */
  spawnExempted: string[];
  /** Spawn calls found in the exempt files — what proves they are read at all. */
  spawnExemptCalls: number;
  /** A tools/ path in a spawn call's arguments in an EXEMPT file: kept apart from spawnHits, and pinned by SPAWN_EXEMPT_EXPECTED. */
  spawnExemptHits: { file: string; line: number; arg: string }[];
  /** A `tools/` path in a spawn call's ARGUMENTS: the line it is on, and the literal (or the joined pair) that names it. */
  spawnHits: { file: string; line: number; arg: string }[];
}

/** Files whose spawn calls are never counted as hits — exact paths, never a pattern (item 28). They are
 *  still read: a tools/ path they spawn lands in `spawnExemptHits`, and the real-tree test holds that to
 *  SPAWN_EXEMPT_EXPECTED, so an exemption cannot go on covering for a spawn nobody wrote down. */
const SPAWN_EXEMPT: readonly string[] = [
  // Its trap rows hand `tools/bench/...` specifiers to the reference-boundary gate as DATA; a fixture
  // of that suite that spawned one would be the trap, not a dependency.
  "packages/reference/test/boundary-gate.test.ts",
  // This file spells spawn calls and `tools/` paths in its own fixtures.
  "scripts/__tests__/tools-import-guard.test.ts",
];
/** The tools/ paths the exempt files are KNOWN to spawn: none today. A new entry says, in a comment, why that spawn is legitimate. */
const SPAWN_EXEMPT_EXPECTED: { file: string; line: number; arg: string }[] = [];

/** Every string literal's text in a source file — template pieces included, comments never. */
function stringLiterals(f: string, text: string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (isLiteralPiece(n)) out.push(n.text);
    n.forEachChild(walk);
  };
  walk(ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false, scriptKindOf(f)));
  return out;
}

/** How the TypeScript parser should read `f`: by extension, JSX only where the extension says so. */
const scriptKindOf = (f: string): ts.ScriptKind =>
  /\.[cm]?jsx?$/.test(f) ? (f.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** A string literal, or one piece of a template (head, middle or tail). */
const isLiteralPiece = (n: ts.Node): n is ts.StringLiteralLike | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail =>
  ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);

/** The callees item 28 judges, by the name they are called under: `exec`, `cp.execSync` and `cp["execSync"]` alike.
 *  ONE list: the callee test is exact membership and the cheap pre-read below is a substring test over the same
 *  names, so neither can drift from the other and neither carries a regex anchor for the other to cover. */
const SPAWNERS: ReadonlySet<string> = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
/** What may precede `tools/` for it to be the repo's directory: the start of the literal, whitespace, a quote, or `/`
 *  (`./tools`, `../tools`, `a/tools`), and the shell and option shapes that glue a path to a word — `=` (`--dir=tools/matrix`),
 *  `:` (`link:tools/bench`), `(`, `&`, `|` and `;`. A word character, `-`, `@` or `.` does not: `mytools/`, `my-tools/`, `@tools/`,
 *  `.tools/` are other directories. (The brief's class held `.`; it only ever adds `.tools/`, a hidden directory, so it is dropped.) */
const LEAD = String.raw`(?:^|[\s"'/=:(&|;])`;
/** A harness path inside ONE literal — `tools/matrix/…`, `./tools/bench/…`, `pnpm --dir tools/matrix`, `tools//matrix` — but not
 *  `mytools/matrix`, `tools/matrixx` or `tools/benchmark`. Case-sensitive: `tools/Matrix` is a known gap (SPAWN_KNOWN_GAPS). */
const TOOLS_LITERAL = new RegExp(`${LEAD}tools/+(?:matrix|bench)\\b`);
/** The same path split across two adjacent literals: the first ends in `tools` (or `tools/`), the second opens with the harness. */
const TOOLS_DIR_END = new RegExp(`${LEAD}tools/*$`);
const HARNESS_START = /^\/*(?:matrix|bench)\b/;

/** The spawn calls in one source file, and the `tools/` paths among their ARGUMENTS (item 28).
 *  A call's arguments are every string literal and template piece beneath it — an array's items,
 *  a nested `join(...)`, an options object's `cwd` — except a function passed
 *  directly as an argument (a callback is not part of the command). Not the file at large: the dockerignore and z3 scans spell `tools/…` in files
 *  that spawn `git`, and those spell it far from the call.
 *
 *  Limits, stated: a path held in a variable or built from non-literal pieces is not seen, nor is
 *  a spawner under an alias (`import { spawn as run }`, `promisify(execFile)`) or from another
 *  library (`execa`). An alias is caught from the other side, by the real-tree test, which reds
 *  on any file that imports child_process yet holds no call this reads; another library is not
 *  caught. A `RegExp#exec` call is read as a spawn call too: it counts, and it would be a hit
 *  only with a harness path in its argument. */
function spawnCallsIn(f: string, text: string): { callees: string[]; hits: { line: number; arg: string }[] } {
  const out: { callees: string[]; hits: { line: number; arg: string }[] } = { callees: [], hits: [] };
  if (![...SPAWNERS].some((name) => text.includes(name))) return out;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, scriptKindOf(f));
  const seen = new Set<string>();
  const hit = (at: ts.Node, arg: string) => {
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    // A spawn inside a spawn's arguments reaches the same literal twice: one hit.
    if (!seen.has(`${line}\0${arg}`)) { seen.add(`${line}\0${arg}`); out.hits.push({ line, arg }); }
  };
  const calleeName = (e: ts.Expression): string | null =>
    ts.isIdentifier(e) ? e.text
      : ts.isPropertyAccessExpression(e) ? e.name.text
        : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text
          : null;
  const judgeArguments = (call: ts.CallExpression) => {
    const pieces: { at: ts.Node; text: string }[] = [];
    const collect = (n: ts.Node): void => {
      if (isLiteralPiece(n)) pieces.push({ at: n, text: n.text });
      n.forEachChild(collect);
    };
    // A callback handed straight to the call (`exec(cmd, () => …)`) is not an argument to the command; a function
    // deeper down (`[...names.map((x) => `tools/matrix/${x}`)]`, an IIFE) builds one, so its body is read.
    for (const arg of call.arguments) if (!ts.isFunctionLike(arg)) collect(arg);
    pieces.forEach((p, i) => {
      if (TOOLS_LITERAL.test(p.text)) hit(p.at, p.text);
      const next = pieces[i + 1];
      if (next !== undefined && TOOLS_DIR_END.test(p.text) && HARNESS_START.test(next.text)) hit(p.at, `${p.text.replace(/\/+$/, "")}/${next.text.replace(/^\/+/, "")}`);
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name !== null && SPAWNERS.has(name)) { out.callees.push(name); judgeArguments(n); }
    }
    n.forEachChild(visit);
  };
  visit(sf);
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
  const out: Scan = { perRoot: Object.fromEntries(ROOTS.map((r) => [r, 0])), specifiers: 0, manifests: 0, manifestFiles: [], tsconfigs: 0, rootScripts: 0, toolsScripts: [], offenders: [], spawnCalls: 0, spawnByName: {}, spawnFiles: [], spawnExempted: [], spawnExemptCalls: 0, spawnExemptHits: [], spawnHits: [] };
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
      const spawned = spawnCallsIn(f, text);
      if (SPAWN_EXEMPT.includes(f)) {
        // Exempt means "not a hit", never "not read": what an exempt file spawns is pinned by SPAWN_EXEMPT_EXPECTED.
        out.spawnExempted.push(f);
        out.spawnExemptCalls += spawned.callees.length;
        for (const h of spawned.hits) out.spawnExemptHits.push({ file: f, ...h });
      } else {
        if (spawned.callees.length > 0) out.spawnFiles.push(f);
        for (const c of spawned.callees) { out.spawnCalls++; out.spawnByName[c] = (out.spawnByName[c] ?? 0) + 1; }
        for (const h of spawned.hits) out.spawnHits.push({ file: f, ...h });
      }
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

/** One source file, untracked, in a throwaway repo. */
const fixtureWith = (path: string, text: string): string => fixture({ [path]: text });

/** The spawn scan's fixture (item 28): a hit, the dockerignore/z3 decoy shape (a tools literal in a
 *  file whose spawn call runs something else), and an exempt file. */
const spawnFixture = (): string => fixture({
  "scripts/spawns.ts": `execFileSync("node", ["--experimental-strip-types", "tools/matrix/run.ts"]);\n`,
  "apps/web/x/spawn-decoy.ts": `const p = "tools/matrix/run.ts"; spawnSync("git", ["ls-files"]);\n`,
  "packages/reference/test/boundary-gate.test.ts": `spawnSync("node", ["tools/bench/x.ts"]);\n`,
});

/** A source file that loads child_process: `from "…"`, `require("…")`, `import("…")` (so `await import(...)` too), `node:` or not. The real-tree oracle. */
const CHILD_PROCESS_IMPORT = /(?:\bfrom|\brequire\(|\bimport\()\s*["'](?:node:)?child_process["']/;

/** Every callee the guard names (item 28's brief) — typed here, never read from the scan. */
const SPAWN_NAMES = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"];
/** Each row: a source that must be ONE hit. `calls` is how many spawn calls it holds (default 1), `line` where the hit sits (default 1). */
const SPAWN_HITS: { label: string; source: string; callee: string; arg: string; calls?: number; line?: number; ext?: string }[] = [
  { label: "exec, a command line", source: `exec("node tools/matrix/a.ts");`, callee: "exec", arg: "node tools/matrix/a.ts" },
  { label: "execSync through a module object", source: `cp.execSync("pnpm --dir tools/matrix x");`, callee: "execSync", arg: "pnpm --dir tools/matrix x" },
  { label: "execFile, ./tools", source: `execFile("node", ["./tools/matrix/run.ts"]);`, callee: "execFile", arg: "./tools/matrix/run.ts" },
  { label: "execFileSync, ../tools", source: `execFileSync("node", ["../tools/bench/b.ts"]);`, callee: "execFileSync", arg: "../tools/bench/b.ts" },
  { label: "spawn, a join of pieces", source: `spawn("node", [join(root, "tools", "matrix", "run.ts")]);`, callee: "spawn", arg: "tools/matrix" },
  { label: "spawnSync through child_process", source: `child_process.spawnSync("node", ["tools/bench/x.ts"]);`, callee: "spawnSync", arg: "tools/bench/x.ts" },
  { label: "fork, a bare relative path", source: `fork("./tools/bench/b.ts");`, callee: "fork", arg: "./tools/bench/b.ts" },
  { label: "a bracketed callee", source: `cp["execSync"]("node tools/matrix/a.ts");`, callee: "execSync", arg: "node tools/matrix/a.ts" },
  { label: "a template head", source: "exec(`node tools/matrix/a.ts ${x}`);", callee: "exec", arg: "node tools/matrix/a.ts " },
  { label: "a template tail after a substitution", source: "spawn(`${root}/tools/matrix/run.ts`);", callee: "spawn", arg: "/tools/matrix/run.ts" },
  { label: "the cwd in an options object", source: `spawnSync("pnpm", ["test"], { cwd: join(root, "tools", "bench") });`, callee: "spawnSync", arg: "tools/bench" },
  { label: "a path split across a concatenation with doubled slashes", source: `execSync("node ../tools//" + "//matrix/run.ts");`, callee: "execSync", arg: "node ../tools/matrix/run.ts" },
  { label: "a path split across a concatenation", source: `execSync("node ../tools" + "/matrix/run.ts");`, callee: "execSync", arg: "node ../tools/matrix/run.ts" },
  { label: "a spawn inside a spawn's arguments is one hit, two calls", source: `execFileSync("node", [execFileSync("node", ["tools/matrix/x.ts"])]);`, callee: "execFileSync", arg: "tools/matrix/x.ts", calls: 2 },
  { label: "a multi-line call: the hit sits on the literal's line", source: `spawnSync(\n  "node",\n  ["--import", "./tools/matrix/lib/crash-exit.ts"],\n);`, callee: "spawnSync", arg: "./tools/matrix/lib/crash-exit.ts", line: 3 },
  { label: ".mjs", source: `spawnSync("node", ["tools/bench/x.ts"]);`, callee: "spawnSync", arg: "tools/bench/x.ts", ext: "mjs" },
  { label: ".cjs", source: `require("node:child_process").spawnSync("node", ["tools/bench/x.ts"]);`, callee: "spawnSync", arg: "tools/bench/x.ts", ext: "cjs" },
  // m3: a function is skipped only as the call's DIRECT argument; deeper, its body is part of the argument.
  { label: "a .map callback inside the argument array builds the path", source: "spawnSync(\"node\", [...f.map((x) => `tools/matrix/${x}`)]);", callee: "spawnSync", arg: "tools/matrix/" },
  { label: "an immediately-invoked function inside the argument array", source: `spawnSync("node", [(() => "tools/matrix/x.ts")()]);`, callee: "spawnSync", arg: "tools/matrix/x.ts" },
  // m5, fixed: the lead class was whitespace, quotes, `.` and `/`; these shell-string and option shapes spell the same path.
  { label: "an option's =value (--dir=tools/matrix)", source: `spawnSync("pnpm", ["--dir=tools/matrix", "x"]);`, callee: "spawnSync", arg: "--dir=tools/matrix" },
  { label: "a link: specifier (pnpm add link:tools/bench)", source: `execSync("pnpm add link:tools/bench");`, callee: "execSync", arg: "pnpm add link:tools/bench" },
  { label: "a parenthesised path", source: `exec("(tools/matrix/run.ts)");`, callee: "exec", arg: "(tools/matrix/run.ts)" },
  { label: "a path after && with no space", source: `exec("cd . &&tools/matrix/run.ts");`, callee: "exec", arg: "cd . &&tools/matrix/run.ts" },
  { label: "a path after ; with no space", source: `exec("a;tools/bench/run.ts");`, callee: "exec", arg: "a;tools/bench/run.ts" },
  { label: "a path after | with no space", source: `exec("a|tools/bench/run.ts");`, callee: "exec", arg: "a|tools/bench/run.ts" },
  { label: "a single-quoted path inside a command line", source: `exec("cd 'tools/matrix' && x");`, callee: "exec", arg: "cd 'tools/matrix' && x" },
  { label: "a double-quoted path inside a command line", source: `exec('cd "tools/bench" && x');`, callee: "exec", arg: 'cd "tools/bench" && x' },
  { label: "a doubled slash (tools//matrix) is the same directory", source: `spawn("node", ["tools//matrix/run.ts"]);`, callee: "spawn", arg: "tools//matrix/run.ts" },
  // A KNOWN false positive, pinned: git reads the file, it does not run it, but `REV:tools/...` is the shape of a path spec and is flagged for review (exempt it by exact path if it is real).
  { label: "git show REV:tools/matrix/run.ts reads, not runs, and is flagged all the same", source: `execFileSync("git", ["show", "HEAD:tools/matrix/run.ts"]);`, callee: "execFileSync", arg: "HEAD:tools/matrix/run.ts" },
  // The call sits INSIDE the JSX: read as plain TypeScript, `<div>{…}</div>` is a type assertion and the call is lost.
  { label: ".tsx, the call inside a JSX child", source: `const el = <div>{spawnSync("node", ["tools/bench/x.ts"])}</div>;`, callee: "spawnSync", arg: "tools/bench/x.ts", ext: "tsx" },
  { label: ".jsx, the call inside a JSX child", source: `const el = <div>{spawnSync("node", ["tools/bench/x.ts"])}</div>;`, callee: "spawnSync", arg: "tools/bench/x.ts", ext: "jsx" },
];
/** Rows that are NOT hits: `calls` is how many spawn calls the scan must still have inspected. */
const SPAWN_DECOYS: { label: string; source: string; calls: number }[] = [
  { label: "a tools/ literal outside the call (the dockerignore/z3 decoy shape)", source: `const p = "tools/matrix/run.ts"; spawnSync("git", ["ls-files"]);`, calls: 1 },
  { label: "`tools` alone as a git pathspec", source: `execFileSync("git", ["ls-files", "--", "tools"]);`, calls: 1 },
  { label: "a directory that merely contains the name", source: `spawn("node", ["mytools/matrix/a.ts", "toolsx/bench/b.ts", "tools/matrixx/c.ts", "tools/benchmark/d.ts"]);`, calls: 1 },
  { label: "a callback's body is not the call's arguments", source: `exec("ls", () => { log("tools/matrix/run.ts"); });`, calls: 1 },
  { label: "a gap between the two pieces", source: `spawn("node", ["tools", "--flag", "matrix"]);`, calls: 1 },
  { label: "a comment", source: `// spawn("node", ["tools/matrix/run.ts"])\n/* exec("tools/matrix/a.ts") */\n`, calls: 0 },
  { label: "a call in a string", source: `const t = 'spawn("tools/matrix/a.ts")';`, calls: 0 },
  { label: "a call that is not a spawn", source: `readFileSync("tools/matrix/a.ts"); require.resolve("tools/bench/b.ts");`, calls: 0 },
  { label: "a callee that merely contains a spawner's name", source: `respawn("node tools/matrix/a.ts"); forked("tools/bench/b.ts"); spawnSyncLike("tools/bench/b.ts");`, calls: 0 },
  // m1: a REAL spawner word in the file, so only the callee's own exactness can reject the lookalike (a file with no
  // spawner word is never parsed, which is what made the old rows above cover for it).
  { label: "a spawner beside a lookalike with a PREFIX (respawn)", source: `spawn("git", ["status"]); respawn("node tools/matrix/a.ts");`, calls: 1 },
  { label: "a spawner beside a lookalike with a SUFFIX (spawned, spawnSyncLike)", source: `spawn("git", ["status"]); spawned("node tools/matrix/a.ts"); spawnSyncLike("tools/bench/b.ts");`, calls: 1 },
  { label: "a spawner beside a lookalike with both (forkedExec)", source: `fork("./x.ts"); myexecSyncs("tools/matrix/a.ts");`, calls: 1 },
  { label: "a hyphenated or hidden directory is another directory (my-tools/, .tools/)", source: `spawn("node", ["my-tools/matrix/a.ts", ".tools/bench/b.ts"]);`, calls: 1 },
  { label: "an npm scope that is not the directory (@tools/matrix)", source: `spawn("npm", ["i", "@tools/matrix"]);`, calls: 1 },
];
/** m5: measured misses, pinned as NOT hits so a change that closes one is deliberate: it must move its row to SPAWN_HITS. `calls` is what the scan inspects. */
const SPAWN_KNOWN_GAPS: { label: string; source: string; calls: number }[] = [
  { label: "the harness name is interpolated (`tools/${x}/run.ts`)", source: "spawn(`tools/${x}/run.ts`);", calls: 1 },
  { label: "a different case (tools/Matrix resolves only on a case-insensitive filesystem; Linux CI is not one)", source: `spawn("node", ["tools/Matrix/run.ts"]);`, calls: 1 },
  { label: "the path is held in a variable", source: `const p = "tools/matrix/run.ts"; spawn("node", [p]);`, calls: 1 },
  { label: "the harness is named by package, not path", source: `spawn("pnpm", ["--filter", "@seazn/matrix", "x"]);`, calls: 1 },
  { label: "an aliased spawner", source: `import { spawn as run } from "node:child_process"; run("node", ["tools/matrix/run.ts"]);`, calls: 0 },
  { label: "a promisified spawner", source: `const run = promisify(execFile); await run("node", ["tools/matrix/run.ts"]);`, calls: 0 },
];

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
    // Nothing to spawn, so nothing inspected and nothing hit: the real-tree test below refuses a zero.
    expect({ calls: s.spawnCalls, byName: s.spawnByName, files: s.spawnFiles, exempted: s.spawnExempted, exemptCalls: s.spawnExemptCalls, exemptHits: s.spawnExemptHits, hits: s.spawnHits }).toEqual({ calls: 0, byName: {}, files: [], exempted: [], exemptCalls: 0, exemptHits: [], hits: [] });
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

  it("item 28: a tools/ path passed to a spawn call is a hit; a tools/ literal elsewhere in a spawning file is not; the exempt file's hit is reported apart, as an exempt hit", () => {
    const r = scan(spawnFixture());
    expect(r.spawnHits).toEqual([{ file: "scripts/spawns.ts", line: 1, arg: "tools/matrix/run.ts" }]);
    expect(r.spawnCalls).toBe(2); // spawns.ts and spawn-decoy.ts; the exempt file is not inspected
    expect(r.spawnByName).toEqual({ execFileSync: 1, spawnSync: 1 });
    expect(r.spawnFiles.sort()).toEqual(["apps/web/x/spawn-decoy.ts", "scripts/spawns.ts"]);
    expect(r.spawnExempted).toEqual(["packages/reference/test/boundary-gate.test.ts"]);
    // The exempt file is READ (item I1): its real hit is reported apart, never among spawnHits and never counted as a call.
    expect(r.spawnExemptHits).toEqual([{ file: "packages/reference/test/boundary-gate.test.ts", line: 1, arg: "tools/bench/x.ts" }]);
    expect(r.spawnExemptCalls).toBe(1);
    // The spawn scan reads arguments, not imports: it adds nothing to the import judgement.
    expect(r.offenders).toEqual([]);
  });

  it("item 28: the exemption is by exact path — the same call in a file beside the exempt one, or at the same name in another directory, is a hit", () => {
    const call = `spawnSync("node", ["tools/bench/x.ts"]);\n`;
    const r = scan(fixture({
      "packages/reference/test/boundary-gate.test.ts": call, // exempt
      "packages/reference/test/boundary-gate.test.tsx": call,
      "packages/reference/test/other.test.ts": call,
      "packages/other/test/boundary-gate.test.ts": call,
      "scripts/__tests__/tools-import-guard.test.ts": call, // exempt
      "scripts/__tests__/tools-import-guard.test.ts.bak.ts": call,
    }));
    expect(r.spawnHits.map((h) => h.file).sort()).toEqual([
      "packages/other/test/boundary-gate.test.ts",
      "packages/reference/test/boundary-gate.test.tsx",
      "packages/reference/test/other.test.ts",
      "scripts/__tests__/tools-import-guard.test.ts.bak.ts",
    ]);
    expect(r.spawnCalls).toBe(4);
    expect(r.spawnExempted.sort()).toEqual([...SPAWN_EXEMPT].sort());
    // Each exempt file's call was READ: it is an exempt hit, not a hit and not a call.
    expect(r.spawnExemptHits.map((h) => h.file).sort()).toEqual([...SPAWN_EXEMPT].sort());
    expect(r.spawnExemptCalls).toBe(2);
  });

  it("item 28, every spelling: each spawner, member and bracketed callees, ./tools and ../tools, a join of pieces, a template, an options object, every source extension — one hit each", () => {
    for (const row of SPAWN_HITS) {
      const file = `scripts/one.${row.ext ?? "ts"}`;
      const r = scan(fixtureWith(file, `${row.source}\n`));
      expect(r.spawnHits, row.label).toEqual([{ file, line: row.line ?? 1, arg: row.arg }]);
      expect(r.spawnCalls, `${row.label}: calls inspected`).toBe(row.calls ?? 1);
      expect(r.spawnByName, `${row.label}: the callee recorded`).toEqual({ [row.callee]: row.calls ?? 1 });
    }
    // Anti-vacuity: the table reaches every spawner the brief names, and every row ran.
    expect([...new Set(SPAWN_HITS.map((r) => r.callee))].sort()).toEqual([...SPAWN_NAMES].sort());
    expect(SPAWN_HITS).toHaveLength(31);
  });

  it("item 28, decoys: a tools/ literal that is not a spawn argument is no hit — and the spawn calls beside it were still inspected", () => {
    for (const row of SPAWN_DECOYS) {
      const r = scan(fixtureWith("scripts/decoy.ts", `${row.source}\n`));
      expect(r.spawnHits, row.label).toEqual([]);
      expect(r.spawnCalls, `${row.label}: calls inspected`).toBe(row.calls);
    }
    expect(SPAWN_DECOYS).toHaveLength(14);
    // Not vacuous: the boundary decoys sit beside a real path in one call, and only the real path is the hit.
    const beside = scan(fixtureWith("scripts/pos.ts", `spawn("node", ["mytools/matrix/a.ts", "tools/matrix/e.ts", "tools/matrixx/c.ts"]);\n`));
    expect(beside.spawnHits).toEqual([{ file: "scripts/pos.ts", line: 1, arg: "tools/matrix/e.ts" }]);
  });

  it("item 28, known gaps: each measured miss is pinned as NOT a hit, so closing one is a deliberate change that moves its row to the hits table", () => {
    for (const row of SPAWN_KNOWN_GAPS) {
      const r = scan(fixtureWith("scripts/gap.ts", `${row.source}\n`));
      expect(r.spawnHits, row.label).toEqual([]);
      expect(r.spawnCalls, `${row.label}: calls inspected`).toBe(row.calls);
    }
    expect(SPAWN_KNOWN_GAPS).toHaveLength(6);
  });

  it("item 28, a sequence: hits across files and roots all report, in repo order, and a second scan of the same repo agrees with the first", () => {
    const root = fixture({
      "apps/web/a.ts": `spawnSync("node", ["tools/bench/x.ts"]);\n`,
      "packages/y/b.ts": `const ok = 1;\nexecSync("pnpm --dir tools/matrix x");\n`,
      "scripts/c.ts": `spawn("git", ["status"]);\n`, // inspected, no hit
      "scripts/d.mjs": `fork("./tools/matrix/run.ts");\n`,
    });
    const first = scan(root);
    expect(first.spawnHits).toEqual([
      { file: "apps/web/a.ts", line: 1, arg: "tools/bench/x.ts" },
      { file: "packages/y/b.ts", line: 2, arg: "pnpm --dir tools/matrix x" },
      { file: "scripts/d.mjs", line: 1, arg: "./tools/matrix/run.ts" },
    ]);
    expect(first.spawnCalls).toBe(4);
    expect(scan(root)).toEqual(first);
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

  it("item 28, the real tree: spawn calls were inspected — non-zero, the child_process names this tree really uses, every file that imports child_process — and none reaches tools/", () => {
    const s = scan(REPO);
    const real = (s.spawnByName.spawnSync ?? 0) + (s.spawnByName.execFileSync ?? 0) + (s.spawnByName.execSync ?? 0);
    console.info(`tools-import-guard: ${s.spawnCalls} calls named like a spawner in ${s.spawnFiles.length} files (${real} are the child_process-only names spawnSync/execFileSync/execSync; the rest are mostly RegExp#exec, the protobuf writer's fork and the 2048 game's own spawn), ${s.spawnExempted.length} exempt files read for hits (${s.spawnExemptCalls} calls)`);
    expect(s.spawnCalls).toBeGreaterThan(10);
    // m2: spawnCalls alone proves little (361 of ~387 are RegExp#exec or the protobuf writer's fork). The names that
    // can only be child_process: a stated floor (21 measured 2026-10-05), never a figure read back from the scan.
    expect(real).toBeGreaterThanOrEqual(15);
    expect(s.spawnByName.spawnSync).toBeGreaterThan(0);
    expect(s.spawnByName.execFileSync).toBeGreaterThan(0);
    // The oracle is a text read of the tracked files, not the scan: a file that loads child_process is in this tree
    // to call it, so the scan must have found a call in each (an aliased or promisified spawner is the gap this
    // reds on), bar the exempt files.
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS], { cwd: REPO, encoding: "utf8" })
      .split("\0").filter((f) => f !== "" && SOURCE.test(f) && !SPAWN_EXEMPT.includes(f) && existsSync(join(REPO, f)));
    const importers = files.filter((f) => CHILD_PROCESS_IMPORT.test(readFileSync(join(REPO, f), "utf8"))).sort();
    expect(importers.length).toBeGreaterThanOrEqual(15);
    expect(importers.filter((f) => !s.spawnFiles.includes(f)), "files that load child_process but hold no inspected spawn call").toEqual([]);
    // Each exemption names a file that is really there and was really met — a rename strands it silently — and
    // the exempt files are READ: a tools/ path they spawn is an exempt hit, and none is expected today.
    expect([...s.spawnExempted].sort()).toEqual([...SPAWN_EXEMPT].sort());
    expect(s.spawnExemptCalls, "the exempt files hold spawn calls, so reading them must find some").toBeGreaterThan(0);
    expect(s.spawnExemptHits, "document the exemption or fix the spawn").toEqual(SPAWN_EXEMPT_EXPECTED);
    expect(s.spawnHits).toEqual([]);
  });

  it("item 28: the child_process import oracle sees every way a file loads the module — and not a lookalike", () => {
    const rows: [line: string, loads: boolean][] = [
      [`import { spawnSync } from "node:child_process";`, true],
      [`import { x } from 'child_process';`, true],
      [`import {\n  spawn,\n  type ChildProcess,\n} from "node:child_process";`, true],
      [`const cp = require("node:child_process");`, true],
      [`const { spawn } = await import("node:child_process");`, true],
      [`const m = import(\n  "child_process");`, true],
      [`import x from "my-child_process";`, false],
      [`import x from "node:child_process/promises-ish";`, false],
      [`// spawn is imported from node:child_process elsewhere`, false],
    ];
    for (const [line, loads] of rows) expect(CHILD_PROCESS_IMPORT.test(line), line).toBe(loads);
    expect(rows.filter(([, l]) => l)).toHaveLength(6);
  });

  it("item 28: the harness directories a spawn argument is judged against are exactly the tools/* workspaces that exist", () => {
    const dirs = readdirSync(join(REPO, "tools")).filter((d) => existsSync(join(REPO, "tools", d, "package.json"))).sort();
    expect(dirs).toContain("matrix");
    expect(dirs).toContain("bench");
    for (const d of dirs) {
      const r = scan(fixtureWith("scripts/one.ts", `spawnSync("node", ["tools/${d}/x.ts"]);\n`));
      expect(r.spawnHits, `tools/${d}`).toHaveLength(1);
    }
    expect(dirs).toEqual(["bench", "matrix"]);
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
