// Engine import-boundary gate (engine/03-engine-architecture.md §1, PROMPT-01 §4).
// packages/engine/src must stay pure: no effectful imports, no ambient time or
// randomness. Run with: node --experimental-strip-types scripts/engine-boundary.ts (from the engine package; `pnpm boundary` there,
// `pnpm engine:boundary` from the repo root). It scans the src/ beside it, so it holds with the engine at packages/engine or at a repo root.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

if (isMainModule(import.meta.url)) {
  // The src/ beside this script's own directory: the engine at packages/engine, or the engine at a repo root. Files are named by their path
  // from the working directory (`packages/engine/src/...` from the repo root, `src/...` from the package), never by a typed prefix.
  const srcDir = new URL("../src", import.meta.url).pathname;
  const shown = (file: string) => relative(process.cwd(), join(srcDir, file)).split(sep).join("/");
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
  console.log(
    violations.length === 0
      ? `PASS  engine boundary clean (${scanned} files scanned)`
      : `\n${violations.length} boundary violation(s) in ${scanned} files scanned`,
  );
  process.exit(violations.length === 0 ? 0 : 1);
}
