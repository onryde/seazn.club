// Every bench module must LOAD under `node --experimental-strip-types`.
//
// This file exists because the bench shipped a whole wave unrunnable. `package
// .json`'s `bench:scheduler` is `node --experimental-strip-types
// scripts/bench/bench.ts`, and strip-only mode can DELETE type annotations but
// cannot SYNTHESISE code. So a construct that needs a transform — a TS `enum`,
// a `namespace`, a constructor parameter property — is refused outright:
//
//     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
//     TypeScript parameter property is not supported in strip-only mode
//
// `schedule.ts` carried `constructor(private readonly divisionRef: string) {}`
// through T1-T7: 1150 passing tests, a clean `tsc -p tsconfig.scripts.json`, a
// clean `eslint scripts/bench`, two implementer rounds and three reviewer
// passes. Every one of those gates is blind to it, because vitest transpiles
// with esbuild and tsc only typechecks. The FIRST live run died on the import,
// before a single HTTP call.
//
// The bench's "no TS `enum`" rule (bench GLOBAL.md, restated at the top of
// `packs/build-packs/_tiny.ts`) is the same rule with a smaller scope. This
// generalises it, and — the point — makes it a gate rather than a convention,
// because a convention is what failed.
//
// Why a spawned import rather than something cheaper: `node
// --experimental-strip-types --check <file>` exits 0 on the broken file. It is
// a syntax check and never reaches the stripping transform, so it cannot see
// this class at all. Only actually loading the module does.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.ts` the bench SHIPS — the modules a real run loads. Test files and
 *  their helpers are excluded on purpose: vitest loads those, and vitest
 *  transpiles, so they are never subject to strip-only mode. */
function shippedModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      shippedModules(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const MODULES = shippedModules(BENCH_ROOT).sort();

describe("every shipped bench module loads under --experimental-strip-types", () => {
  // The discovery guard, FIRST. Without it a walker that returned `[]` — a
  // renamed directory, a changed extension — would make every `it.each` row
  // below disappear and the file would report green having checked nothing.
  // An empty set satisfies a for-all vacuously, which is exactly the shape of
  // vacuous pass this whole file exists to stop.
  it("discovers the shipped modules, and the entrypoint is among them", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(20);
    expect(MODULES).toContain(join(BENCH_ROOT, "bench.ts"));
    expect(MODULES).toContain(join(BENCH_ROOT, "lib", "schedule.ts"));
    // No test file smuggled in — those are allowed to use anything, so
    // including one would make this suite refuse legal code.
    expect(MODULES.filter((m) => m.includes("__tests__"))).toEqual([]);
  });

  it.each(MODULES.map((m) => [m.slice(BENCH_ROOT.length + 1), m] as const))(
    "%s",
    (_label, full) => {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(full).href)});`,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      const stderr = result.stderr ?? "";
      // Asserted on the CODE, not just the exit status: a module that failed
      // for an unrelated reason (a missing peer, a thrown top-level) would
      // also be non-zero, and reporting that as "unsupported syntax" would
      // send the next reader to the wrong place entirely.
      expect(
        stderr.includes("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"),
        `${_label} uses a construct strip-only mode cannot execute:\n${stderr}`,
      ).toBe(false);
      expect(result.status, `${_label} failed to load:\n${stderr}`).toBe(0);
    },
  );
});
