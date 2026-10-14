// Dependency hygiene for @seazn/scheduler, the twin of packages/engine/test/runtime-deps.test.ts. The stg/prod `--prod`
// install runs Flyway and `sync-sports`, not the app, and drops devDependencies; pnpm's isolated node_modules gives no
// walk-up to a hoisted copy, so every package this one imports at RUNTIME must sit in `dependencies`, or a deploy-only
// ERR_MODULE_NOT_FOUND follows. (The app's real deploy pin is tools/matrix/__tests__/workspace-wiring.test.ts, 1a-4.)
//
// Every `__tests__/` directory is excluded: its non-`.test.ts` files (live-seam-guard.ts imports `vitest`) are helpers
// imported only by tests. That skip is only safe while nothing shipped imports from one, so the last test below fails if
// any scanned file does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;
const MANIFEST = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"),
) as { dependencies?: Record<string, string> };

/** `import … from "x"`, `export … from "x"`, bare `import "x"`, `import("x")`. The `… ` part may not cross a quote or a `;`:
 *  otherwise a bare `import "x"` is read as the head of the NEXT statement's `from` and its own specifier is never seen. */
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[^"';]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments first: prose in this repo contains phrases like `tell "worse" from
 * "better"`, which the multi-line import pattern below would otherwise read as
 * an import of a package named `better`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Bare package name: "zod/v4" → "zod", "@scope/pkg/sub" → "@scope/pkg". */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Every import specifier of every scanned (shipped) file, with the file (relative to src/) that wrote it. */
function scannedSpecifiers(): { specifier: string; file: string }[] {
  const out: { specifier: string; file: string }[] = [];
  for (const file of walk(SRC)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(SPECIFIER)) {
      out.push({ specifier: match[1] ?? match[2] ?? match[3]!, file: file.slice(SRC.length + 1) });
    }
  }
  return out;
}

function runtimeImports(): Map<string, string> {
  const found = new Map<string, string>(); // package -> first file that imports it
  for (const { specifier, file } of scannedSpecifiers()) {
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    const pkg = packageOf(specifier);
    if (!found.has(pkg)) found.set(pkg, file);
  }
  return found;
}

/** A relative specifier that reaches into a `__tests__/` directory: `./__tests__/x.ts`, `../__tests__/x.ts`. */
const REACHES_INTO_TESTS = /^\.{1,2}\/(?:.*\/)?__tests__\//;

describe("scheduler runtime dependencies", () => {
  it("declares every runtime import in `dependencies`, not `devDependencies`", () => {
    const declared = new Set(Object.keys(MANIFEST.dependencies ?? {}));
    const missing = [...runtimeImports()]
      .filter(([pkg]) => !declared.has(pkg))
      .map(([pkg, file]) => `${pkg} (imported from src/${file})`);
    expect(missing).toEqual([]);
  });

  it("finds the imports it is meant to be guarding", () => {
    // A regex that silently matched nothing would make the gate above vacuous. `@grpc/grpc-js` and `@bufbuild/protobuf`
    // arrive with the placement client and its generated stubs, `pino` with `logger.ts`, and `@seazn/engine` with the
    // port types and the clock: all four are runtime imports, so all four must stay in `dependencies`. Listed by name
    // rather than left to a length check so that adding or dropping one is an edit someone made on purpose.
    expect([...runtimeImports().keys()].sort()).toEqual([
      "@bufbuild/protobuf",
      "@grpc/grpc-js",
      "@seazn/engine",
      "pino",
    ]);
  });

  it("is not blind to a shipped file importing a `__tests__/` helper, the one thing that makes skipping that directory safe", () => {
    // the probe sees the shapes it forbids, and none it should allow
    for (const bad of ["./__tests__/solver-fakes.ts", "../__tests__/x.ts", "./sub/__tests__/y.ts"]) {
      expect(REACHES_INTO_TESTS.test(bad), bad).toBe(true);
    }
    for (const fine of ["./build.ts", "../calendar.ts", "./tests.ts", "./my__tests__/x.ts", "zod", "vitest"]) {
      expect(REACHES_INTO_TESTS.test(fine), fine).toBe(false);
    }
    // and the scan itself sees a bare import that is followed by an import with a `from`
    const sample = 'import "./__tests__/a.ts";\nimport { b } from "./b.ts";\nexport * from "./__tests__/c.ts";\n';
    expect([...sample.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3])).toEqual(["./__tests__/a.ts", "./b.ts", "./__tests__/c.ts"]);
    const all = scannedSpecifiers();
    // anti-vacuity: the scan reads real relative imports, so an empty hit list means "nobody imports a test helper"
    expect(all.filter((s) => s.specifier.startsWith(".")).length, "relative imports scanned").toBeGreaterThan(0);
    expect(
      all.filter((s) => REACHES_INTO_TESTS.test(s.specifier)).map((s) => `${s.file} imports ${s.specifier}`),
    ).toEqual([]);
  });
});
