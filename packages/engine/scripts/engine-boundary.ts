// Engine import-boundary gate (engine/03-engine-architecture.md §1, PROMPT-01 §4).
// packages/engine/src must stay pure: no effectful imports, no ambient time or
// randomness. Run with: node --experimental-strip-types scripts/engine-boundary.ts (from the engine package; `pnpm boundary` there,
// `pnpm engine:boundary` from the repo root). It scans the src/ beside it, so it holds with the engine at packages/engine or at a repo root.
// It also walks the phone subpaths (phone-subpaths.json, beside src/): see checkPhoneSafety below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isMainModule } from "./lib/main-module.ts";

const BANNED_IMPORTS = [
  "postgres",
  "next",
  "react",
  "react-dom",
  "ioredis",
  "server-only",
  "node:crypto",
  "crypto",
];

const BANNED_TOKENS = ["Date.now(", "Math.random(", "new Date()"];

// Ambient time is allowed only in core/clock.ts and its co-located tests —
// everywhere else (including rng.ts: mulberry32 is seeded) it breaks fold
// determinism. PROMPT-01 §4.
const TOKEN_ALLOWLIST = /core\/clock(\.test)?\.ts$/;

/** A banned import allowed in ONE named file. Used sparingly: an exemption is a ruling, not a convenience. The scan checks it for staleness
 *  only while the file exists: it is red when the file no longer imports the specifier. A DELETED file is never visited, so that case is
 *  caught by test/boundary-gate.test.ts, which holds the real tree's `exempted` equal to this list. */
export interface ImportExemption {
  /** Relative to src/, `/`-separated. */
  file: string;
  /** The exact specifier; no other banned import in that file is excused. */
  specifier: string;
  why: string;
}

export const IMPORT_EXEMPTIONS: readonly ImportExemption[] = [
  {
    file: "testkit/golden.ts",
    specifier: "node:crypto",
    why: "the golden-replay harness hashes recorded streams with createHash (since 2dd25ba4b); moving it off node:crypto would churn every golden digest. The old comment stripper hid this import from the gate. Orchestrator ruling, a recommendation to the owner, reversible",
  },
];

export interface Violation {
  file: string;
  line: number;
  rule: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

function bannedImport(specifier: string): string | null {
  if (specifier.includes("apps/")) return "apps/";
  for (const banned of BANNED_IMPORTS) {
    if (specifier === banned || specifier.startsWith(`${banned}/`)) return banned;
  }
  return null;
}

// Every module specifier a file names, type imports included (the boundary is about what a file names, not what survives the build). Matched
// against the code skeleton, where group 1 is the blanked specifier: its span (the `d` flag) is where to read the real one in the source.
const IMPORT_RE = /(?:\bfrom\s*|(?<![\w$.])import\s*\(\s*|(?<![\w$.])require\s*\(\s*|\bimport\s*)["']([^"']+)["']/dg;

function importsOf(source: string, skeleton: string): { specifier: string; index: number }[] {
  return [...skeleton.matchAll(IMPORT_RE)].map((m) => ({ specifier: source.slice(m.indices![1]![0], m.indices![1]![1]), index: m.index }));
}

/** Every module specifier `source` names, in source order, found in its code skeleton - never in a comment, a string or a regular expression. */
export function importSpecifiers(source: string): string[] {
  return importsOf(source, codeSkeleton(source)).map((i) => i.specifier);
}

/** The gate's findings and how many .ts files it looked at: a clean report over zero files proves nothing, so the CLI refuses it.
 *  `exempted` lists the `<file> <specifier>` pairs of IMPORT_EXEMPTIONS that excused an import in this scan. */
export function scanEngineBoundary(srcDir: string): { scanned: number; violations: Violation[]; exempted: string[] } {
  const violations: Violation[] = [];
  const exempted: string[] = [];
  let scanned = 0;
  for (const file of walk(srcDir)) {
    scanned++;
    const rel = relative(srcDir, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    const code = codeSkeleton(source);
    const excusable = IMPORT_EXEMPTIONS.filter((e) => e.file === rel);
    const excused = new Set<string>();

    for (const { specifier, index } of importsOf(source, code)) {
      const banned = bannedImport(specifier);
      if (!banned) continue;
      if (excusable.some((e) => e.specifier === specifier)) {
        excused.add(specifier);
        continue;
      }
      violations.push({ file: rel, line: lineOf(source, index), rule: `forbidden import "${specifier}" (${banned})` });
    }
    for (const e of excusable) {
      if (excused.has(e.specifier)) exempted.push(`${e.file} ${e.specifier}`);
      else violations.push({ file: rel, line: 1, rule: `stale import exemption: "${e.specifier}" is no longer imported here, so remove it from IMPORT_EXEMPTIONS in scripts/engine-boundary.ts` });
    }

    if (TOKEN_ALLOWLIST.test(rel)) continue;
    for (const token of BANNED_TOKENS) {
      let at = code.indexOf(token);
      while (at !== -1) {
        violations.push({ file: rel, line: lineOf(source, at), rule: `forbidden call ${token})` });
        at = code.indexOf(token, at + token.length);
      }
    }
  }
  return { scanned, violations, exempted };
}

export function checkEngineBoundary(srcDir: string): Violation[] {
  return scanEngineBoundary(srcDir).violations;
}


// ---------------------------------------------------------------------------------------------------------------------------------
// The code skeleton (shared by the boundary scan and the phone walk)

/** The code skeleton of `source`: same length, so an index here is an index in the source, with the comments and the contents of every
 *  string, template text and regular expression blanked to spaces (their quotes, backticks, slashes and `${` `}` stay). A scan of the
 *  skeleton cannot mistake text for code: a `process.env` or an `import "node:fs"` inside a string or a comment is not a read or an import,
 *  and a `//` or `/*` inside a string starts no comment. A specifier is a string, so its text is read from the source at the span the
 *  skeleton's quotes mark.
 *
 *  The TypeScript parser decides what is a literal: whether a `/` divides or opens a regular expression depends on the grammar around it
 *  (`x! / y`, `i++ / 2`, `if (a) /re/.test(b)`, `a.return / 2`), which no rule about the preceding character gets right. The comments are
 *  then found in the text that is left, where no literal can hide a `//` or a `/*` any more.
 *
 *  `parsed` is a parse of `source` the caller already holds (the tests share one parse per file between the skeleton and their oracles);
 *  without it the text is parsed here. Either way the result is the same, and kept for the next call with the same text. */
export function codeSkeleton(source: string, parsed?: ts.SourceFile): string {
  let skeleton = SKELETONS.get(source);
  if (skeleton === undefined) {
    skeleton = skeletonOf(source, parsed ?? ts.createSourceFile("skeleton.ts", source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS));
    SKELETONS.set(source, skeleton);
  }
  return skeleton;
}

/** The skeleton of a source is a pure function of its text, and parsing is most of what the gate costs (every file is read by the boundary
 *  scan, and the ~50 phone modules again by the phone walk): the second read of a text is a lookup. */
const SKELETONS = new Map<string, string>();

function skeletonOf(source: string, parsed: ts.SourceFile): string {
  const bare = source.split("");
  const blank = (from: number, to: number) => bare.fill(" ", from, to);
  // an unterminated literal has no closing delimiter to keep
  const closes = (at: number, delimiter: string) => (source[at - 1] === delimiter ? at - 1 : at);

  const literals = (node: ts.Node): void => {
    const start = node.getStart(parsed);
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
        blank(start + 1, closes(node.end, source[start]!));
        break;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: // `text`
      case ts.SyntaxKind.TemplateTail: // }text`
        blank(start + 1, closes(node.end, "`"));
        break;
      case ts.SyntaxKind.TemplateHead: // `text${
      case ts.SyntaxKind.TemplateMiddle: // }text${
        blank(start + 1, node.end - 2);
        break;
      case ts.SyntaxKind.RegularExpressionLiteral: // /text/flags
        blank(start + 1, source.lastIndexOf("/", node.end - 1));
        break;
      default:
    }
    ts.forEachChild(node, literals);
  };
  literals(parsed);

  // What is left holds code, whitespace and comments (and the delimiters of literals whose text is gone), so a `//` or `/*` here opens a comment.
  const rest = bare.join("");
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "/") continue;
    if (rest[i + 1] === "/") {
      const end = rest.indexOf("\n", i);
      blank(i, end === -1 ? rest.length : end);
      i = end === -1 ? rest.length : end;
    } else if (rest[i + 1] === "*") {
      const end = rest.indexOf("*/", i + 2);
      const to = end === -1 ? rest.length : end + 2;
      blank(i, to);
      i = to - 1;
    }
  }
  return bare.join("");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Phone-safe subpaths (engine-split 1c-1, spec 5.3, D25). packages/engine/phone-subpaths.json lists the subpaths a phone (React Native,
// Hermes) imports. Every module they reach by VALUE import must import no Node builtin (`node:*` or a bare builtin name), name no
// `process` (any identifier `process`, whatever it is used for, and `globalThis`/`global`/`window`/`self` `.process`), import nothing from
// src/scheduling, import no package the engine does not declare as a dependency or required peer, and not import the engine by its own
// package name. `import type` / `export type` are erased at compile time, so they are not followed. The closure is also pinned: the
// sorted module list in phone-subpaths.json `closure.modules` is what the walk must find, so a new module on a phone is a reviewed
// change (see checkPhoneClosure). This is the static half; pack-proof/run.mjs bundles the same subpaths with Metro and compiles them with
// Hermes (the runtime half) and asserts the bundle holds exactly the modules walked here.
//
// What a walk over text cannot see, and so does not claim: an alias (`const g = globalThis; g.process`), `Reflect.get(globalThis, "p" + "rocess")`,
// `eval`, and a computed `globalThis[name]`. A type-position `import("x").T` IS followed (a walk too wide is loud: the Metro proof names the module
// it walked but the bundle lacks; a walk too narrow is silent).

export interface PhoneViolation {
  kind: string;
  /** Engine-relative, `/`-separated. */
  file: string;
  detail: string;
}

export interface PhoneReport {
  /** Every module of the phone closure, engine-relative, sorted. */
  walked: string[];
  /** The module each listed subpath resolves to (a pattern gives one per match), sorted. */
  entries: string[];
  /** The packages the closure imports, by package name, sorted. */
  externals: string[];
  violations: PhoneViolation[];
  /** The most module visits the walk allowed itself (10 x the .ts files under src/ unless `visitBudget` said otherwise). */
  visitBudget: number;
}

export interface PhoneOptions {
  /** Throw once the walk has visited more modules than this. The walk visits each module once, so only a broken visited-guard reaches it. */
  visitBudget?: number;
}

const PHONE_LIST_FILE = "phone-subpaths.json";
const SCHEDULING_DIR = "src/scheduling";
const NODE_BUILTINS = new Set(builtinModules);
/** The engine's workspace alias (apps import it as `@seazn/engine/...`); its published name is read from package.json. */
const ENGINE_ALIAS = "@seazn/engine";
const VISIT_BUDGET_PER_FILE = 10;

// Every way a module is loaded by value, matched against the skeleton, where group 1 is the blanked specifier: its span (the `d` flag)
// is where to read the real one in the source. `import type ...` is skipped by the lookahead (and `export type ...` never matches), but
// `import type from "x"` and `import type, { a } from "x"` import a default binding NAMED `type`, which is a value import. `import { type A } from`
// IS followed: whether the build keeps that import depends on a compiler flag, and a walk too wide is loud where a walk too narrow is silent.
// `typeof import("x")` is a type query, erased like `import type`. The grammar after `import` is spelled out (default, then `* as ns` or
// `{ ... }`) rather than skipped lazily, so two imports with no semicolon between them are two matches, not one.
const VALUE_IMPORTS: RegExp[] = [
  /\bimport(?!\s*type(?:\s+(?!from\b)|\s*[{*]))\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s*[\w$]+|\{[^}]*\})?\s*from\s*["']([^"']+)["']/dg, // import a, { b as c }, * as d from "x" (any number of lines; `{ "a-b" as c }` too: the skeleton blanks the string)
  /\bexport\s*(?:\*(?:\s*as\s*(?:[\w$]+|"[^"\n]*"|'[^'\n]*'))?|\{[^}]*\})\s*from\s*["']([^"']+)["']/dg, // export * [as n | as "n"] / { a } from "x" (`export type` has a word before the * or {)
  /\bimport\s*["']([^"']+)["']/dg, // import "x"
  /(?<![\w$.])(?<!typeof\s*)import\s*\(\s*["']([^"']+)["'](?=\s*[,)])/dg, // import("x") or import("x", opts), but not typeof import("x"), nor import("x" + y)
  /(?<![\w$.])require\s*\(\s*["']([^"']+)["'](?=\s*[,)])/dg, // require("x")
];
/** `import(` or `require(` with anything but exactly one string literal as its module (a variable, a template, nothing, or a literal that goes
 *  on: `"./" + "../scheduling/x.ts"`, `c ? "a" : "b"`): the module it loads cannot be known, so the walk would be smaller than the truth. */
const LOAD_OF_A_VALUE = /(?<![\w$.])(?:import|require)\s*\((?:(?!\s*["'])|\s*(?:"[^"\n]*"|'[^'\n]*')\s*(?=[^\s,)]))/g;

// Naming a Node global. Any identifier `process` (and `Buffer`, `__dirname`, `__filename`: Node's module scope and global object, none of
// which Hermes has) is a read unless it is a property name: `x.process`, `x?.process`, an object key or a type member (`{ process: 1 }`,
// `process?: string`). A spread (`...process.env`) is a read, `typeof process` is a read (it is how a module probes for Node, which a phone
// module has no business doing), and so is `case process:`. A binding of one of these names (`const process = ...`, a parameter called
// `process`) is refused too: the rule reads names, it does not resolve scopes. Only a property position is allowed.
const NODE_GLOBALS = "process|Buffer|__dirname|__filename";
const BARE_NODE_GLOBAL = new RegExp(String.raw`(?<![\w$])(${NODE_GLOBALS})(?![\w$])`, "g");
/** The Node globals that also hang off the global object (`globalThis.process`); `__dirname` and `__filename` are module scope, not properties. */
const GLOBAL_PROPERTY_NAMES = new Set(["process", "Buffer"]);
const GLOBAL_ROOT = "(?:globalThis|global|window|self)";
const GLOBAL_PROCESS = new RegExp(String.raw`(?<![\w$.])${GLOBAL_ROOT}\s*(?:\?\.|\.)\s*(process|Buffer)(?![\w$])`, "dg");
/** `globalThis["process"]` holds its name in a string, which the skeleton has blanked: the span of the name says what it was. A template
 *  literal with no placeholder (`globalThis[`process`]`) names it the same way. */
const GLOBAL_BY_NAME = new RegExp(String.raw`(?<![\w$.])${GLOBAL_ROOT}\s*(?:\?\.\s*)?\[\s*(["'\x60])([^"'\x60]*)\1\s*\]`, "dg");
/** `const { process: p } = globalThis` renames the global; the shorthand `{ process }` is already a bare `process`. */
const GLOBAL_DESTRUCTURED = new RegExp(String.raw`\{[^{}]*?(?<![\w$.])(process|Buffer)\s*:[^{}]*\}\s*=\s*${GLOBAL_ROOT}(?![\w$])`, "dg");
const KEY_AFTER = /\s*\??\s*:/y;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const packageNameOf = (specifier: string): string => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);

function readJsonFile(engineDir: string, name: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(engineDir, name), "utf8");
  } catch (e) {
    throw new Error(`cannot read ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The files an exports pattern `./<dir>/*\/<rest>` stands for: one per directory below <dir> that holds <rest>. Any other shape is refused
 *  rather than guessed at: a pattern read wrongly would be a smaller walk that looks clean. */
function expandPattern(engineDir: string, subpath: string, target: string): string[] {
  const star = target.indexOf("*");
  const head = target.slice(0, star);
  const tail = target.slice(star + 1);
  if (target.indexOf("*", star + 1) !== -1 || !head.endsWith("/") || !tail.startsWith("/")) {
    throw new Error(`exports "${subpath}" -> ${target}: only <dir>/*/<file> patterns are expanded; teach checkPhoneSafety the new shape`);
  }
  let names: string[];
  try {
    names = readdirSync(join(engineDir, head));
  } catch {
    names = []; // no such directory: the pattern matches nothing, which the caller reports
  }
  return names.map((name) => `${head}${name}${tail}`).filter((candidate) => isFile(join(engineDir, candidate)));
}

/** The packages the engine declares for a consumer to have: `dependencies` and the `peerDependencies` not marked optional. A
 *  devDependency is not here (a consumer does not install it), nor is an optional peer (a phone that lacks it must still load). */
function declaredPackages(pkg: Record<string, unknown>): Set<string> {
  const names = (field: unknown): string[] => (isRecord(field) ? Object.keys(field) : []);
  const meta = isRecord(pkg.peerDependenciesMeta) ? pkg.peerDependenciesMeta : {};
  const optional = (name: string): boolean => isRecord(meta[name]) && meta[name].optional === true;
  return new Set([...names(pkg.dependencies), ...names(pkg.peerDependencies).filter((n) => !optional(n))]);
}

/** Walk the phone closure of the engine at `engineDir` (the directory holding package.json, phone-subpaths.json and src/). Throws when the
 *  two json files cannot be read, and when the walk outruns its visit budget; everything else it finds is a violation in the report. The
 *  caller must treat `walked.length === 0` as a failure: a walk that visited nothing proves nothing. This does not read the closure pin:
 *  checkPhoneClosure does. */
export function checkPhoneSafety(engineDir: string, opts: PhoneOptions = {}): PhoneReport {
  const pkg = readJsonFile(engineDir, "package.json");
  const list = readJsonFile(engineDir, PHONE_LIST_FILE);
  if (!isRecord(pkg) || !isRecord(pkg.exports)) throw new Error(`package.json has no "exports" object`);
  if (!isRecord(list) || !Array.isArray(list.subpaths) || !list.subpaths.every((s) => typeof s === "string")) {
    throw new Error(`${PHONE_LIST_FILE}: "subpaths" must be an array of strings`);
  }
  const exportsMap = pkg.exports;
  const declared = declaredPackages(pkg);
  const selfNames = [ENGINE_ALIAS, ...(typeof pkg.name === "string" ? [pkg.name] : [])];
  const isSelf = (specifier: string) => selfNames.some((n) => specifier === n || specifier.startsWith(`${n}/`));
  let sourceFiles = 0;
  try {
    for (const _ of walk(join(engineDir, "src"))) sourceFiles++;
  } catch {
    sourceFiles = 0; // no src/: every entry is reported missing below
  }
  const visitBudget = opts.visitBudget ?? VISIT_BUDGET_PER_FILE * sourceFiles;
  if (!Number.isInteger(visitBudget) || visitBudget < 0) throw new Error(`visitBudget must be a non-negative integer, got ${String(visitBudget)}`);

  const violations: PhoneViolation[] = [];
  const entries: string[] = [];
  const queue: string[] = [];
  // THE visited-guard: a module is queued once, ever. Without it a cycle never ends; the budget below is what turns that into a failure.
  const queued = new Set<string>();
  const enqueue = (file: string) => {
    if (queued.has(file)) return;
    queued.add(file);
    queue.push(file);
  };
  const underScheduling = (rel: string) => rel === SCHEDULING_DIR || rel.startsWith(`${SCHEDULING_DIR}/`);

  for (const subpath of list.subpaths) {
    if (!Object.hasOwn(exportsMap, subpath)) {
      violations.push({ kind: "unknown-subpath", file: PHONE_LIST_FILE, detail: `lists ${JSON.stringify(subpath)}, which package.json does not export` });
      continue;
    }
    const target = exportsMap[subpath];
    if (typeof target !== "string" || !target.startsWith("./")) {
      violations.push({ kind: "missing-entry", file: "package.json", detail: `exports ${JSON.stringify(subpath)} is not a ./ path string` });
      continue;
    }
    const rel = posix.normalize(target.slice(2));
    const files = subpath.includes("*") ? expandPattern(engineDir, subpath, rel) : isFile(join(engineDir, rel)) ? [rel] : [];
    if (files.length === 0) {
      violations.push({ kind: "missing-entry", file: rel, detail: `exports ${JSON.stringify(subpath)} points at ${rel}, which ${subpath.includes("*") ? "matches no file" : "is not a file"}` });
      continue;
    }
    for (const file of files) {
      entries.push(file);
      if (underScheduling(file)) violations.push({ kind: "scheduling", file, detail: `exports ${JSON.stringify(subpath)} resolves under ${SCHEDULING_DIR}` });
      else enqueue(file);
    }
  }

  const walked: string[] = [];
  const externals = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (walked.length >= visitBudget) {
      throw new Error(`the phone walk passed its visit budget of ${visitBudget} (${VISIT_BUDGET_PER_FILE} x the ${sourceFiles} .ts files under src/ unless set) at ${file}: it is not terminating`);
    }
    walked.push(file);
    const source = readFileSync(join(engineDir, file), "utf8");
    const bare = codeSkeleton(source);
    const textOf = (span: [number, number]) => source.slice(span[0], span[1]);
    const found: { index: number; kind: string; detail: string }[] = [];

    for (const re of VALUE_IMPORTS) {
      for (const m of bare.matchAll(re)) {
        const specifier = textOf(m.indices![1]!);
        const at = (kind: string, detail: string) => found.push({ index: m.index, kind, detail });
        if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
          at("node-builtin", `imports ${JSON.stringify(specifier)}, a Node builtin`);
        } else if (specifier.startsWith(".")) {
          const base = posix.normalize(posix.join(posix.dirname(file), specifier));
          if (!base.startsWith("src/")) {
            at("outside-src", `imports ${JSON.stringify(specifier)}, which leaves src/ (dist/ is built from src/ alone)`);
          } else if (underScheduling(base)) {
            at("scheduling", `imports ${JSON.stringify(specifier)}, which is under ${SCHEDULING_DIR}`);
          } else {
            const target = [base, `${base}.ts`, base.replace(/\.[cm]?js$/, ".ts"), `${base}/index.ts`].find((c) => isFile(join(engineDir, c)));
            if (target === undefined) at("unresolved-import", `imports ${JSON.stringify(specifier)}, which resolves to no file`);
            else enqueue(target);
          }
        } else if (isSelf(specifier)) {
          at("self-import", `imports ${JSON.stringify(specifier)}, the engine by its own package name: the walk follows relative paths, so this edge would be invisible. Import the file by its relative path`);
        } else {
          const name = packageNameOf(specifier);
          externals.add(name);
          if (!declared.has(name)) at("undeclared-package", `imports ${JSON.stringify(specifier)}, but package.json declares ${name} neither as a dependency nor as a required peer`);
        }
      }
    }
    for (const m of bare.matchAll(LOAD_OF_A_VALUE)) found.push({ index: m.index, kind: "unresolved-import", detail: "an import() or require() of something that is not exactly one string literal" });
    const nodeGlobal = (index: number, name: string) =>
      found.push(name === "process" ? { index, kind: "process", detail: "reads `process`" } : { index, kind: "node-global", detail: `reads the Node global \`${name}\`` });
    for (const m of bare.matchAll(BARE_NODE_GLOBAL)) {
      let before = m.index - 1;
      while (before >= 0 && /\s/.test(bare[before]!)) before--;
      const prev = before >= 0 ? bare[before] : "";
      if (prev === "." && bare.slice(before - 2, before + 1) !== "...") continue; // x.process, x?.process: some other object's member
      KEY_AFTER.lastIndex = m.index + m[1]!.length;
      // a key or a type member (`process: 1`, `process?: string`); after a `?` it is a ternary's middle, after `case` a switch label
      if (prev !== "?" && !/(?<![\w$])case$/.test(bare.slice(0, before + 1)) && KEY_AFTER.test(bare)) continue;
      nodeGlobal(m.index, m[1]!);
    }
    for (const m of bare.matchAll(GLOBAL_PROCESS)) nodeGlobal(m.index, textOf(m.indices![1]!));
    for (const m of bare.matchAll(GLOBAL_DESTRUCTURED)) nodeGlobal(m.index, textOf(m.indices![1]!));
    for (const m of bare.matchAll(GLOBAL_BY_NAME)) {
      const name = textOf(m.indices![2]!);
      if (GLOBAL_PROPERTY_NAMES.has(name)) nodeGlobal(m.index, name);
    }
    for (const f of found.sort((a, b) => a.index - b.index)) violations.push({ kind: f.kind, file, detail: `line ${lineOf(source, f.index)}: ${f.detail}` });
  }
  return { walked: [...walked].sort(), entries: entries.sort(), externals: [...externals].sort(), violations, visitBudget };
}

/** The modules phone-subpaths.json `closure.modules` records: the sorted phone closure, a SET the walk must match exactly. Throws when it is
 *  missing, empty or not a list of strings: a pin of nothing pins nothing. */
export function readPhonePin(engineDir: string): string[] {
  const list = readJsonFile(engineDir, PHONE_LIST_FILE);
  const modules = isRecord(list) && isRecord(list.closure) ? list.closure.modules : undefined;
  if (!Array.isArray(modules) || modules.length === 0 || !modules.every((m) => typeof m === "string")) {
    throw new Error(`${PHONE_LIST_FILE}: "closure.modules" must be a non-empty array of module paths (the sorted phone closure)`);
  }
  return modules;
}

/** null when `walked` and `pinned` hold the same modules; otherwise the one message every check that reds on a phone-closure change prints:
 *  the modules added and removed, and the file to re-pin. */
export function phoneClosureDrift(walked: readonly string[], pinned: readonly string[]): string | null {
  const have = new Set(walked);
  const want = new Set(pinned);
  const added = [...have].filter((m) => !want.has(m)).sort();
  const removed = [...want].filter((m) => !have.has(m)).sort();
  if (added.length === 0 && removed.length === 0) return null;
  const parts = [
    ...(added.length > 0 ? [`${added.length} module(s) added: ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`${removed.length} module(s) removed: ${removed.join(", ")}`] : []),
  ];
  return `the phone closure changed - ${parts.join("; ")}. If that is intended, re-pin "closure.modules" (and "closure.measured") in ${PHONE_LIST_FILE}, beside src/: a new module on a phone is a reviewed decision`;
}

/** checkPhoneSafety, plus the closure pin: when the walk and phone-subpaths.json `closure.modules` disagree the report carries a
 *  `closure-changed` violation (after the walk's own). An empty walk is reported without it: nothing walked is already a failure. */
export function checkPhoneClosure(engineDir: string, opts: PhoneOptions = {}): PhoneReport {
  const report = checkPhoneSafety(engineDir, opts);
  const pinned = readPhonePin(engineDir);
  if (report.walked.length > 0) {
    const drift = phoneClosureDrift(report.walked, pinned);
    if (drift !== null) report.violations.push({ kind: "closure-changed", file: PHONE_LIST_FILE, detail: drift });
  }
  return report;
}

if (isMainModule(import.meta.url)) {
  // The src/ beside this script's own directory: the engine at packages/engine, or the engine at a repo root. Files are named by their path
  // from the working directory (`packages/engine/src/...` from the repo root, `src/...` from the package), never by a typed prefix.
  const engineDir = fileURLToPath(new URL("..", import.meta.url));
  const srcDir = new URL("../src", import.meta.url).pathname;
  const shown = (file: string) => relative(process.cwd(), join(srcDir, file)).split(sep).join("/");
  const shownEngine = (file: string) => relative(process.cwd(), join(engineDir, file)).split(sep).join("/");
  let result: ReturnType<typeof scanEngineBoundary>;
  try {
    result = scanEngineBoundary(srcDir);
  } catch (e) {
    console.error(`FAIL  cannot scan ${relative(process.cwd(), srcDir) || "."}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const { scanned, violations } = result;
  if (scanned === 0) {
    console.error(`FAIL  scanned 0 files under ${relative(process.cwd(), srcDir) || "."}: a gate over nothing proves nothing`);
    process.exit(1);
  }
  for (const v of violations) {
    console.error(`FAIL  ${shown(v.file)}:${v.line}  ${v.rule}`);
  }
  // The phone walk (1c-1) and its closure pin. It cannot run without package.json and phone-subpaths.json beside src/, and a walk of nothing
  // proves nothing.
  let phone: PhoneReport;
  try {
    phone = checkPhoneClosure(engineDir);
  } catch (e) {
    console.error(`FAIL  cannot walk the phone subpaths: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  for (const v of phone.violations) {
    console.error(`FAIL  ${shownEngine(v.file)}  ${v.kind}: ${v.detail}`);
  }
  if (phone.walked.length === 0) {
    console.error(`FAIL  walked 0 phone modules from ${PHONE_LIST_FILE}: a gate over nothing proves nothing`);
    process.exit(1);
  }
  // The boundary line prints whatever the phone walk found (and the walk's line whatever the boundary scan found): a red gate states what it
  // checked and found clean as well as what it found wrong. PASS is reserved for both rules clean.
  if (violations.length > 0) console.log(`\n${violations.length} boundary violation(s) in ${scanned} files scanned`);
  else if (phone.violations.length > 0) console.log(`engine boundary clean (${scanned} files scanned)`);
  if (phone.violations.length > 0) console.log(`\n${phone.violations.length} phone-safety violation(s) in ${phone.walked.length} modules walked`);
  else console.log(`phone-safe: ${phone.walked.length} modules walked`);
  const clean = violations.length === 0 && phone.violations.length === 0;
  if (clean) {
    // an exemption in use is stated, so a reader of the CI log sees what the gate let through
    for (const e of result.exempted) console.log(`exempt  ${shown(e.split(" ")[0]!)}  ${e.split(" ")[1]}`);
    console.log(`PASS  engine boundary clean (${scanned} files scanned)`);
  }
  process.exit(clean ? 0 : 1);
}
