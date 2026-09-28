// Every scripts/matrix module must LOAD under `node --experimental-strip-types`.
//
// Copied from the bench's own gate (scripts/bench/lib/__tests__/strip-types-
// loadable.test.ts), which exists because the bench shipped a whole wave
// unrunnable. The harness runs as `node --experimental-strip-types`, and
// strip-only mode can DELETE type annotations but cannot SYNTHESISE code. So a
// construct that needs a transform — a TS `enum`, a `namespace`, a constructor
// parameter property — is refused outright:
//
//     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
//     TypeScript parameter property is not supported in strip-only mode
//
// The bench's `schedule.ts` carried `constructor(private readonly divisionRef:
// string) {}` through 1150 passing tests, a clean `tsc -p
// tsconfig.scripts.json`, a clean eslint, two implementer rounds and three
// reviewer passes. Every one of those gates is blind to it, because vitest
// transpiles with esbuild and tsc only typechecks. The FIRST live run died on
// the import, before a single HTTP call.
//
// Why a spawned import rather than something cheaper: `node
// --experimental-strip-types --check <file>` exits 0 on the broken file. It is
// a syntax check and never reaches the stripping transform, so it cannot see
// this class at all. Only actually loading the module does — and loading it
// also proves every relative import carries its `.ts` and every bare import
// resolves (ERR_MODULE_NOT_FOUND), which vitest's resolver would forgive.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts` the harness SHIPS — the modules a real run loads. Test files
 *  are excluded on purpose: vitest loads those, and vitest transpiles, so they
 *  are never subject to strip-only mode. */
function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") shipped(full, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const MODULES = shipped(MATRIX).sort();

describe("every shipped scripts/matrix module loads under --experimental-strip-types", () => {
  // The discovery guard, FIRST. A walker that returned `[]` would make every
  // `it.each` row below disappear and the file would report green having
  // checked nothing — an empty set satisfies a for-all vacuously.
  it("discovery guard: at least the catalogue is found", () => {
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  it.each(MODULES)("%s", (file) => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)});`],
      { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 },
    );
    expect(r.stderr, file).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.status, `${file}\n${r.stderr}`).toBe(0);
  });
});
