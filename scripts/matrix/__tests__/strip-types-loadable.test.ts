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

  // W1c Task 4's modules, named: the walker finds them today, and a move or a
  // rename that dropped one out of the walk would otherwise shrink the list
  // below silently. The browser ones load playwright (a bare import) and the
  // bench's tap helpers, so their load also proves those resolve.
  const W1C_T4 = [
    "lib/widths.ts", "lib/driver/envelope.ts", "lib/pads/execute.ts",
    "lib/browser/budget.ts", "lib/browser/viewports.ts", "lib/browser/selectors.ts",
    "lib/browser/session.ts", "lib/browser/respond.ts", "lib/browser/evidence.ts",
  ];
  it("W1c Task 4's modules are all in the walk", () => {
    const missing = W1C_T4.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T4.length).toBe(9);
    expect(missing).toEqual([]);
  });

  // W1c Task 5's page objects, named for the same reason. Their loads also
  // prove the bench's scorer.ts and execute.ts resolve from lib/browser/pages,
  // and that the functions evaluateAll serialises (standingsCellsOf,
  // championFrom) survive strip-only mode as plain JS.
  const W1C_T5 = [
    "lib/browser/pages/ctx.ts", "lib/browser/pages/paths.ts", "lib/browser/pages/competition.ts",
    "lib/browser/pages/division-builder.ts", "lib/browser/pages/entrants.ts", "lib/browser/pages/launch.ts",
    "lib/browser/pages/stage-rail.ts", "lib/browser/pages/run-sheet.ts", "lib/browser/pages/fixture-console.ts",
    "lib/browser/pages/standings.ts", "lib/browser/pages/public-division.ts",
  ];
  it("W1c Task 5's page objects are all in the walk", () => {
    const missing = W1C_T5.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T5.length).toBe(11);
    expect(missing).toEqual([]);
  });

  // Playwright's evaluateAll sends a function's SOURCE TEXT to the page. Under
  // strip-only mode that text is the stripped source, so it must compile as
  // plain JS on its own, outside its module — rebuilt here from toString().
  it("the functions evaluateAll ships to the page compile and run from their own source, outside their module", () => {
    const mod = (rel: string) => JSON.stringify(pathToFileURL(join(MATRIX, rel)).href);
    const code = [
      `const s = await import(${mod("lib/browser/pages/standings.ts")});`,
      `const p = await import(${mod("lib/browser/pages/public-division.ts")});`,
      "const rebuilt = (f) => new Function(`return (${f.toString()})`)();",
      "const cells = rebuilt(s.standingsCellsOf)([], s.CELL_SELECTORS);",
      "const champion = rebuilt(p.championFrom)([], 'Champion');",
      "console.log(JSON.stringify({ cells, champion }));",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe(JSON.stringify({ cells: [], champion: null }));
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
