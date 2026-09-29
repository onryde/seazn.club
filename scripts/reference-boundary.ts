// The reference package's import boundary (design §7.2, ruling 27):
// relative imports that stay inside packages/reference/src, and statement-form
// `import type` / `export type` from @seazn/engine/core. Everything else —
// engine values, inline `{ type X }` (strip-types keeps it as a runtime
// import), other engine subpaths, anything leaving src (the bench pack types
// import engine runtime values, trap 3), dynamic import, require, and
// nondeterministic tokens — is a violation. Zero files scanned is a refusal.
//
// The judge reads one statement per line (a multi-line clause is joined onto
// its first line, up to its `from` and never past a `;`). The assumptions that
// makes are guards, not comments: a second import on the same line, an import
// whose `from` no statement head reached, and a source the scan cannot read
// (.mts, .tsx, .js, …) are each a violation rather than a silent skip.
//
// Run: node --experimental-strip-types scripts/reference-boundary.ts [srcDir]
// (default: this checkout's packages/reference/src). Exit 0 clean; 1 on any
// violation or on zero files scanned; 2 on usage.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./matrix/lib/main-module.ts";

export interface Violation { file: string; line: number; specifier: string; reason: string }
export const ALLOWED_ENGINE = "@seazn/engine/core";
const BANNED_TOKENS = ["Date.now(", "Math.random(", "new Date()"] as const;
const STATIC = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']/;
const REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']/;
/** Every place a line names a module — counted, so a second one is refused, never skipped. */
const IMPORT_SITE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)["']([^"']+)["']/g;
const IMPORT_SITE_ONE = new RegExp(IMPORT_SITE.source);
/** Sources node or a bundler would load that the line judge never reads. */
const UNSCANNED = /\.(?:mts|cts|tsx|js|mjs|cjs|jsx)$/;

function sourceFiles(dir: string, out: { ts: string[]; unscanned: string[] }): { ts: string[]; unscanned: string[] } {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (n.endsWith(".ts")) { if (!n.endsWith(".test.ts")) out.ts.push(p); }
    else if (UNSCANNED.test(n)) out.unscanned.push(p);
  }
  return out;
}

export function checkReferenceBoundary(srcDir: string): { scanned: number; violations: Violation[] } {
  const root = resolve(srcDir);
  const found = sourceFiles(root, { ts: [], unscanned: [] });
  const files = found.ts.sort();
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n").map((raw) => raw.replace(/\/\/.*$/, ""));
    // Lines whose import site some statement has judged; any other line with
    // a site is refused below, so a statement the join cannot reach is never
    // a silent pass.
    const judged = new Set<number>();
    lines.forEach((line, i) => {
      const add = (specifier: string, reason: string) => violations.push({ file: rel, line: i + 1, specifier, reason });
      for (const t of BANNED_TOKENS) if (line.includes(t)) add(t, "nondeterministic token (the reference must answer the same way every time)");
      const sites = [...line.matchAll(IMPORT_SITE)].map((m) => m[1] ?? "");
      if (sites.length > 1) { judged.add(i); add(sites[1] ?? "", "more than one import on a line — the gate judges one statement per line"); return; }
      const dyn = DYNAMIC.exec(line);
      if (dyn) { judged.add(i); add(dyn[1] ?? "", "dynamic import() is refused"); return; }
      const req = REQUIRE.exec(line);
      if (req) { judged.add(i); add(req[1] ?? "", "require() is refused"); return; }
      const bare = BARE_IMPORT.exec(line);
      if (bare) { judged.add(i); add(bare[1] ?? "", "side-effect import is refused"); return; }
      if (!/^\s*(import|export)\b/.test(line)) return;
      // Join a multi-line import/export clause onto its first line for
      // matching — up to its `from "…"`, and never past a `;`: an `export
      // const …;` or `export class … {` that has no `from` of its own must not
      // borrow the next statement's.
      let stmt = line;
      let last = i;
      for (let k = i + 1; !/\bfrom\s*["']/.test(stmt) && !stmt.includes(";") && k < lines.length && k < i + 20; k++) { stmt += ` ${lines[k] ?? ""}`; last = k; }
      const m = STATIC.exec(stmt);
      if (!m) return;
      judged.add(last);
      const [, , typeKw, clause, spec] = m as unknown as [string, string, string | undefined, string, string];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(root + sep)) add(spec, "relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)");
        return;
      }
      if (spec.startsWith("@seazn/engine")) {
        if (spec !== ALLOWED_ENGINE) { add(spec, "only @seazn/engine/core types may be imported"); return; }
        if (typeKw === undefined && /\{\s*type\s/.test(clause)) { add(spec, "inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine"); return; }
        if (typeKw === undefined) add(spec, "engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)");
        return;
      }
      add(spec, "not an allowed import (relative within src, or @seazn/engine/core types)");
    });
    lines.forEach((line, i) => {
      if (judged.has(i)) return;
      const site = IMPORT_SITE_ONE.exec(line);
      if (site) violations.push({ file: rel, line: i + 1, specifier: site[1] ?? "", reason: "an import the gate could not judge (no import/export head within reach of its `from`) — refused, never skipped" });
    });
  }
  for (const file of found.unscanned.sort()) {
    const rel = relative(root, file);
    violations.push({ file: rel, line: 1, specifier: rel, reason: "not a .ts source — the gate scans .ts only, so this file's imports would go unjudged" });
  }
  return { scanned: files.length, violations };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    process.stderr.write("usage: node --experimental-strip-types scripts/reference-boundary.ts [srcDir]  (default: packages/reference/src)\n");
    process.exitCode = 2;
  } else {
    const dir = args[0] ?? fileURLToPath(new URL("../packages/reference/src", import.meta.url));
    const { scanned, violations } = checkReferenceBoundary(dir);
    for (const v of violations) process.stderr.write(`FAIL ${v.file}:${v.line} ${v.specifier} — ${v.reason}\n`);
    if (scanned === 0) process.stderr.write("reference:boundary scanned ZERO files — refusing\n");
    process.stdout.write(`reference:boundary: ${scanned} files, ${violations.length} violation(s)\n`);
    process.exitCode = scanned === 0 || violations.length > 0 ? 1 : 0;
  }
}
