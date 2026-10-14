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

// Comments may legitimately mention Date.now() etc.; only code counts.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function bannedImport(specifier: string): string | null {
  if (specifier.includes("apps/")) return "apps/";
  for (const banned of BANNED_IMPORTS) {
    if (specifier === banned || specifier.startsWith(`${banned}/`)) return banned;
  }
  return null;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

/** The gate's findings and how many .ts files it looked at: a clean report over zero files proves nothing, so the CLI refuses it. */
export function scanEngineBoundary(srcDir: string): { scanned: number; violations: Violation[] } {
  const violations: Violation[] = [];
  let scanned = 0;
  for (const file of walk(srcDir)) {
    scanned++;
    const rel = relative(srcDir, file).split(sep).join("/");
    const code = stripComments(readFileSync(file, "utf8"));
    const lineOf = (index: number) => code.slice(0, index).split("\n").length;

    for (const match of code.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? "";
      const banned = bannedImport(specifier);
      if (banned) {
        violations.push({
          file: rel,
          line: lineOf(match.index),
          rule: `forbidden import "${specifier}" (${banned})`,
        });
      }
    }

    if (TOKEN_ALLOWLIST.test(rel)) continue;
    for (const token of BANNED_TOKENS) {
      let at = code.indexOf(token);
      while (at !== -1) {
        violations.push({ file: rel, line: lineOf(at), rule: `forbidden call ${token})` });
        at = code.indexOf(token, at + token.length);
      }
    }
  }
  return { scanned, violations };
}

export function checkEngineBoundary(srcDir: string): Violation[] {
  return scanEngineBoundary(srcDir).violations;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Phone-safe subpaths (engine-split 1c-1, spec 5.3, D25). packages/engine/phone-subpaths.json lists the subpaths a phone (React Native,
// Hermes) imports. Every module they reach by VALUE import must import no Node builtin (`node:*` or a bare builtin name), read no
// `process`, and import nothing from src/scheduling. `import type` / `export type` are erased at compile time, so they are not followed.
// This is the static half; pack-proof/run.mjs bundles the same subpaths with Metro and compiles them with Hermes (the runtime half) and
// asserts the bundle holds exactly the modules walked here.

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
}

const PHONE_LIST_FILE = "phone-subpaths.json";
const SCHEDULING_DIR = "src/scheduling";
const NODE_BUILTINS = new Set(builtinModules);

// A `/` after one of these characters, or after one of these words, starts a regular expression; after anything else (a name, a number,
// `)`, `]`, `}`) it divides.
const REGEX_PRECEDERS = new Set(Array.from("(,=:[!&|?{;+-*%<>~^"));
const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const WORD_CHAR = /[\w$]/;

/** The code skeleton of `source`: same length and same line breaks, so an index here is an index in the source, with the comments, the
 *  contents of every string, template text and regular expression blanked to spaces (their quotes stay). A scan of the skeleton cannot
 *  mistake text for code: a `process.env` or an `import "node:fs"` inside a string or a comment is not a read or an import. A specifier is
 *  a string, so its text is read from the source at the span the skeleton's quotes mark. Unlike a regex replace this knows that a `//` or
 *  `/*` inside a string starts no comment and that a quote inside a comment or a regular expression starts no string - each of those hides
 *  the code after it from a regex-based scan. */
function codeSkeleton(source: string): string {
  const n = source.length;
  const bare = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < Math.min(to, n); k++) if (bare[k] !== "\n") bare[k] = " ";
  };
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
        if (source[i] === c) i++; // an unterminated string stops at its line's end
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

// Every way a module is loaded by value, matched against the skeleton, where group 1 is the blanked specifier: its span (the `d` flag)
// is where to read the real one in the source. `import type ...` and `export type ...` are skipped by the lookahead. `import { type A } from`
// IS followed: whether the build keeps that import depends on a compiler flag, and a walk too wide is loud (the Metro proof names the module
// it walked but the bundle lacks) where a walk too narrow is silent.
const VALUE_IMPORTS: RegExp[] = [
  /\bimport(?!\s+type\s)\s+[^;"'`]*?\bfrom\s*["']([^"']+)["']/dg, // import a, { b } as c, * as d from "x" (any number of lines)
  /\bexport(?!\s+type\s)\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/dg, // export * [as n] / { a } from "x"
  /(?<![\w$.])import\s*["']([^"']+)["']/dg, // import "x"
  /(?<![\w$.])import\s*\(\s*["']([^"']+)["']/dg, // import("x")
  /(?<![\w$.])require\s*\(\s*["']([^"']+)["']/dg, // require("x")
];
/** `import(` with anything but a string literal after it: the module it loads cannot be known, so the walk would be smaller than the truth. */
const DYNAMIC_IMPORT_OF_A_VALUE = /(?<![\w$.])import\s*\(\s*(?!["'])/g;
// Reading `process`: a member of it, or of `globalThis`'s `process`.
const PROCESS_READ = /(?<![\w$.])process\s*(?:\?\.|\.|\[)|(?<![\w$.])globalThis\s*(?:\?\.|\.)\s*process\b/g;
/** `globalThis["process"]` holds its name in a string, which the skeleton has blanked: the span of the name says what it was. */
const GLOBAL_PROCESS_BY_NAME = /(?<![\w$.])globalThis\s*\[\s*["']([^"']+)["']\s*\]/dg;

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

/** Walk the phone closure of the engine at `engineDir` (the directory holding package.json, phone-subpaths.json and src/). Throws when the
 *  two json files cannot be read; everything else it finds is a violation in the report. The caller must treat `walked.length === 0` as a
 *  failure: a walk that visited nothing proves nothing. */
export function checkPhoneSafety(engineDir: string): PhoneReport {
  const pkg = readJsonFile(engineDir, "package.json");
  const list = readJsonFile(engineDir, PHONE_LIST_FILE);
  if (!isRecord(pkg) || !isRecord(pkg.exports)) throw new Error(`package.json has no "exports" object`);
  if (!isRecord(list) || !Array.isArray(list.subpaths) || !list.subpaths.every((s) => typeof s === "string")) {
    throw new Error(`${PHONE_LIST_FILE}: "subpaths" must be an array of strings`);
  }
  const exportsMap = pkg.exports;
  const violations: PhoneViolation[] = [];
  const entries: string[] = [];
  const queue: string[] = [];
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
      else queue.push(file);
    }
  }

  const walked = new Set<string>();
  const externals = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (walked.has(file)) continue;
    walked.add(file);
    const source = readFileSync(join(engineDir, file), "utf8");
    const bare = codeSkeleton(source);
    const lineOf = (index: number) => source.slice(0, index).split("\n").length;
    const textOf = (span: [number, number]) => source.slice(span[0], span[1]);
    const violate = (kind: string, index: number, detail: string) => violations.push({ kind, file, detail: `line ${lineOf(index)}: ${detail}` });

    for (const re of VALUE_IMPORTS) {
      for (const m of bare.matchAll(re)) {
        const specifier = textOf(m.indices![1]!);
        if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
          violate("node-builtin", m.index, `imports ${JSON.stringify(specifier)}, a Node builtin`);
        } else if (!specifier.startsWith(".")) {
          externals.add(packageNameOf(specifier));
        } else {
          const base = posix.normalize(posix.join(posix.dirname(file), specifier));
          if (base === ".." || base.startsWith("../")) {
            violate("outside-engine", m.index, `imports ${JSON.stringify(specifier)}, which leaves the package`);
          } else if (underScheduling(base)) {
            violate("scheduling", m.index, `imports ${JSON.stringify(specifier)}, which is under ${SCHEDULING_DIR}`);
          } else {
            const target = [base, `${base}.ts`, base.replace(/\.[cm]?js$/, ".ts"), `${base}/index.ts`].find((c) => isFile(join(engineDir, c)));
            if (target === undefined) violate("unresolved-import", m.index, `imports ${JSON.stringify(specifier)}, which resolves to no file`);
            else queue.push(target);
          }
        }
      }
    }
    for (const m of bare.matchAll(DYNAMIC_IMPORT_OF_A_VALUE)) violate("unresolved-import", m.index, "a dynamic import() of something that is not a string literal");
    for (const m of bare.matchAll(PROCESS_READ)) violate("process", m.index, `reads \`process\` (${m[0].trim()})`);
    for (const m of bare.matchAll(GLOBAL_PROCESS_BY_NAME)) {
      if (textOf(m.indices![1]!) === "process") violate("process", m.index, `reads \`process\` (globalThis["process"])`);
    }
  }
  return { walked: [...walked].sort(), entries: entries.sort(), externals: [...externals].sort(), violations };
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
  // The phone walk (1c-1). It cannot run without package.json and phone-subpaths.json beside src/, and a walk of nothing proves nothing.
  let phone: PhoneReport;
  try {
    phone = checkPhoneSafety(engineDir);
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
  if (clean) console.log(`PASS  engine boundary clean (${scanned} files scanned)`);
  process.exit(clean ? 0 : 1);
}
