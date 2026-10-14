// The staging deploy installs with `pnpm install --frozen-lockfile --prod`,
// which drops devDependencies. pnpm's isolated node_modules gives no walk-up
// to a hoisted copy the way npm's flat tree did, so every package the engine
// imports at RUNTIME must sit in `dependencies` or `peerDependencies` — a
// devDependency-only entry resolves fine in every local run and in every CI job
// that installs dev deps, then dies with ERR_MODULE_NOT_FOUND on the deploy job
// alone. (1b-2: zod moved from `dependencies` to a peer, so the published
// tarball makes the consumer own the one zod instance. A workspace package's
// peer is not installed under `--prod`, so the monorepo's deploy install finds
// zod only by walking up to the ROOT node_modules: the root lists it in
// `dependencies`, pinned in apps/web/src/__tests__/toolchain.test.ts.)
//
// src/testkit/** is excluded: it is a test harness, imported only from a
// consumer's own test files, so vitest/fast-check stay devDependencies.
// So is every `__tests__/` directory: its non-`.test.ts` files (fakes, scenario
// tables) are helpers imported only by tests, and `solver-fakes.ts` imports `vi`.
// That skip is only safe while nothing shipped imports from one, so the last test
// below fails if any scanned file does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;
const MANIFEST = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"),
) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/** `import … from "x"`, `export … from "x"`, bare `import "x"`, `import("x")`. The `… ` part may not cross a quote or a `;`:
 *  otherwise a bare `import "x"` is read as the head of the NEXT statement's `from` and its own specifier is never seen. */
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[^"';]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "testkit" && entry !== "__tests__") walk(full, out);
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

describe("engine runtime dependencies", () => {
  it("declares every runtime import in `dependencies` or `peerDependencies`, not `devDependencies`", () => {
    const declared = new Set([...Object.keys(MANIFEST.dependencies ?? {}), ...Object.keys(MANIFEST.peerDependencies ?? {})]);
    const missing = [...runtimeImports()]
      .filter(([pkg]) => !declared.has(pkg))
      .map(([pkg, file]) => `${pkg} (imported from src/${file})`);
    expect(missing).toEqual([]);
  });

  it("finds the imports it is meant to be guarding", () => {
    // A regex that silently matched nothing would make the gate above vacuous.
    // The engine's only runtime import is `zod`. The gRPC client and the pino
    // logger left with the solver and logger ports (engine-split D11, D25) and
    // now live in @seazn/scheduler, whose own runtime-deps test pins them there.
    //
    // `z3-solver` was an entry until C8 deleted the solver, and `@grpc/grpc-js`,
    // `@bufbuild/protobuf` and `pino` were until D11/D25. The set is listed by
    // name rather than left to a length check precisely so that any removal or
    // addition has to be an edit someone made on purpose.
    expect([...runtimeImports().keys()].sort()).toEqual(["zod"]);
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
