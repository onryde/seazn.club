// Engine import-boundary gate (engine/03-engine-architecture.md §1, PROMPT-01 §4).
// packages/engine/src must stay pure: no effectful imports, no ambient time or
// randomness. Run with: node --experimental-strip-types scripts/engine-boundary.ts (from the engine package; `pnpm boundary` there,
// `pnpm engine:boundary` from the repo root). It scans the src/ beside it, so it holds with the engine at packages/engine or at a repo root.
// It also walks the phone subpaths (phone-subpaths.json, beside src/): see checkPhoneSafety below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/** A banned import allowed in ONE named file. Used sparingly: an exemption is a ruling, not a convenience, and it is checked for staleness
 *  (the scan is red when the file no longer imports it), so it cannot outlive the import it excuses. */
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

// A `/` after one of these characters, or after one of these words, starts a regular expression; after anything else (a name, a number,
// `)`, `]`, `}`) it divides.
const REGEX_PRECEDERS = new Set(Array.from("(,=:[!&|?{;+-*%<>~^"));
const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const WORD_CHAR = /[\w$]/;

/** The code skeleton of `source`: same length, so an index here is an index in the source, with the comments and the contents of every
 *  string, template text and regular expression blanked to spaces (their quotes stay). A scan of the skeleton cannot mistake text for
 *  code: a `process.env` or an `import "node:fs"` inside a string or a comment is not a read or an import. A specifier is a string, so its
 *  text is read from the source at the span the skeleton's quotes mark. Unlike a regex replace this knows that a `//` or `/*` inside a
 *  string starts no comment and that a quote inside a comment or a regular expression starts no string - each of those hides the code
 *  after it from a regex-based scan. */
function codeSkeleton(source: string): string {
  const n = source.length;
  const bare = source.split("");
  const blank = (from: number, to: number) => bare.fill(" ", from, to);
  let i = 0;
  let last = -1; // the last character of code that was not whitespace, to tell a regex `/` from a division `/`

  const slashStartsRegex = (): boolean => {
    if (last < 0) return true;
    const c = source[last]!;
    if (REGEX_PRECEDERS.has(c)) return true;
    if (!WORD_CHAR.test(c)) return false;
    let from = last;
    while (from > 0 && WORD_CHAR.test(source[from - 1]!)) from--;
    return REGEX_KEYWORDS.has(source.slice(from, last + 1));
  };

  // Scans code; inside a template placeholder `${ ... }` it stops after the brace that closes the placeholder.
  const code = (inPlaceholder: boolean): void => {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        const from = i;
        while (i < n && source[i] !== "\n") i++;
        blank(from, i);
        continue;
      }
      if (c === "/" && next === "*") {
        const from = i;
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        blank(from, i);
        continue;
      }
      if (c === '"' || c === "'") {
        const from = ++i;
        while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
        blank(from, i);
        i++; // the closing quote (an unterminated string stops at its line's end, and this steps over that)
        last = i - 1;
        continue;
      }
      if (c === "`") {
        i++;
        let from = i;
        while (i < n && source[i] !== "`") {
          if (source[i] === "\\") {
            i += 2;
          } else if (source[i] === "$" && source[i + 1] === "{") {
            blank(from, i);
            i += 2;
            code(true);
            from = i;
          } else {
            i++;
          }
        }
        blank(from, i);
        i++; // the closing backtick
        last = i - 1;
        continue;
      }
      if (c === "/" && slashStartsRegex()) {
        const from = ++i;
        let inClass = false;
        while (i < n && source[i] !== "\n") {
          const r = source[i]!;
          if (r === "\\") {
            i += 2;
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          i++;
        }
        blank(from, i);
        if (source[i] === "/") i++; // (the flags after it are read as the code they look like, which cannot start a regex or hide a quote)
        last = i - 1;
        continue;
      }
      if (c === "{") {
        depth++;
      } else if (c === "}") {
        if (inPlaceholder && depth === 0) {
          i++;
          return;
        }
        depth--;
      }
      if (!/\s/.test(c)) last = i;
      i++;
    }
  };
  code(false);
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
  /(?<![\w$.])(?<!typeof\s*)import\s*\(\s*["']([^"']+)["']/dg, // import("x"), but not typeof import("x")
  /(?<![\w$.])require\s*\(\s*["']([^"']+)["']/dg, // require("x")
];
/** `import(` or `require(` with anything but a string literal after it (a variable, a template, nothing): the module it loads cannot be known,
 *  so the walk would be smaller than the truth. */
const LOAD_OF_A_VALUE = /(?<![\w$.])(?:import|require)\s*\((?!\s*["'])/g;

// Naming `process`. Any identifier `process` is a read of the Node global unless it is a property name: `x.process`, `x?.process`, an object
// key or a type member (`{ process: 1 }`, `process?: string`). A spread (`...process.env`) is a read. `typeof process` is a read: it is how
// a module probes for Node, which a phone module has no business doing.
const BARE_PROCESS = /(?<![\w$])process(?![\w$])/g;
const GLOBAL_ROOT = "(?:globalThis|global|window|self)";
const GLOBAL_PROCESS = new RegExp(String.raw`(?<![\w$.])${GLOBAL_ROOT}\s*(?:\?\.|\.)\s*process(?![\w$])`, "g");
/** `globalThis["process"]` holds its name in a string, which the skeleton has blanked: the span of the name says what it was. */
const GLOBAL_BY_NAME = new RegExp(String.raw`(?<![\w$.])${GLOBAL_ROOT}\s*(?:\?\.\s*)?\[\s*["']([^"']*)["']\s*\]`, "dg");
/** `const { process: p } = globalThis` renames the global; the shorthand `{ process }` is already a bare `process`. */
const GLOBAL_DESTRUCTURED = new RegExp(String.raw`\{[^{}]*?(?<![\w$.])process\s*:[^{}]*\}\s*=\s*${GLOBAL_ROOT}(?![\w$])`, "g");
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
    for (const m of bare.matchAll(LOAD_OF_A_VALUE)) found.push({ index: m.index, kind: "unresolved-import", detail: "an import() or require() of something that is not a string literal" });
    for (const m of bare.matchAll(BARE_PROCESS)) {
      let before = m.index - 1;
      while (before >= 0 && /\s/.test(bare[before]!)) before--;
      const prev = before >= 0 ? bare[before] : "";
      if (prev === "." && bare.slice(before - 2, before + 1) !== "...") continue; // x.process, x?.process: some other object's member
      KEY_AFTER.lastIndex = m.index + "process".length;
      if (prev !== "?" && KEY_AFTER.test(bare)) continue; // a key or a type member (`process: 1`, `process?: string`); after a `?` it is a ternary's middle
      found.push({ index: m.index, kind: "process", detail: "reads `process`" });
    }
    for (const m of bare.matchAll(GLOBAL_PROCESS)) found.push({ index: m.index, kind: "process", detail: "reads `process`" });
    for (const m of bare.matchAll(GLOBAL_DESTRUCTURED)) found.push({ index: m.index, kind: "process", detail: "reads `process`" });
    for (const m of bare.matchAll(GLOBAL_BY_NAME)) {
      if (textOf(m.indices![1]!) === "process") found.push({ index: m.index, kind: "process", detail: "reads `process`" });
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
  if (violations.length > 0) console.log(`\n${violations.length} boundary violation(s) in ${scanned} files scanned`);
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
