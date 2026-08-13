// Pins two things: (1) resolveModuleClient is the CLIENT mirror of
// server/engine-db/registry.ts — same "no fallback to latest" contract, same
// MODULE_DUPLICATE tolerance for a shared-registry double boot; (2)
// foldClient actually runs the module's own fold (delegates to foldMatch
// verbatim) rather than reimplementing or short-circuiting it. Also carries
// the bundle-purity grep the S10 brief asks for: this tree must never import
// a server-only specifier, since it ships in the browser bundle.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { foldMatch } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { foldClient, resolveModuleClient } from "../module-client";
import type { GenericCfg, GenericState } from "@seazn/engine/sports/generic";

describe("resolveModuleClient", () => {
  it("resolves a pinned, already-shipped module", () => {
    // Named `mod`, not `module` — Next lints an assignment to `module` as
    // shadowing the CommonJS module variable (@next/next/no-assign-module-variable).
    const mod = resolveModuleClient("generic", "1.0.0");
    expect(mod.key).toBe("generic");
    expect(mod.version).toBe("1.0.0");
  });

  it("throws a typed MODULE_NOT_FOUND for an unknown version of a KNOWN sport — never falls back to latest", () => {
    // "cricket@1.0.0" is real and registered; asking for a version that does
    // not exist must not silently hand back the only other version on file.
    expect(() => resolveModuleClient("cricket", "9.9.9")).toThrow(EngineError);
    try {
      resolveModuleClient("cricket", "9.9.9");
      expect.unreachable("resolveModuleClient must throw for an unpinned version");
    } catch (err) {
      expect(EngineError.is(err, "MODULE_NOT_FOUND")).toBe(true);
    }
  });

  it("throws MODULE_NOT_FOUND for a sport key that does not exist at all", () => {
    expect(() => resolveModuleClient("not-a-real-sport", "1.0.0")).toThrow(EngineError);
    try {
      resolveModuleClient("not-a-real-sport", "1.0.0");
      expect.unreachable("resolveModuleClient must throw for an unknown key");
    } catch (err) {
      expect(EngineError.is(err, "MODULE_NOT_FOUND")).toBe(true);
    }
  });

  it("booting twice in one process is a no-op, not a crash", () => {
    expect(resolveModuleClient("football", "1.0.0").key).toBe("football");
    expect(resolveModuleClient("football", "1.0.0").key).toBe("football");
  });

  it("tolerates MODULE_DUPLICATE raised by a prior boot path on the same shared registry", async () => {
    // Simulates the real-world hazard the pinned facts call out: the engine's
    // default registry (`@seazn/engine/sport`'s `registry` export) is a
    // process-wide singleton, so if something else in the process already
    // called registerBuiltins() on it, module-client's own boot must swallow
    // the resulting MODULE_DUPLICATE — never let it crash the resolver.
    vi.resetModules();
    const { registry } = await import("@seazn/engine/sport");
    const { registerBuiltins } = await import("@seazn/engine/sports");
    const { generic } = await import("@seazn/engine/sports/generic");
    registerBuiltins(registry); // "another boot path already ran"
    const fresh = await import("../module-client");
    expect(() => fresh.resolveModuleClient("generic", "1.0.0")).not.toThrow();
    expect(fresh.resolveModuleClient("generic", "1.0.0")).toBe(generic);
    vi.resetModules();
  });
});

describe("foldClient", () => {
  it("runs the module's own fold — matches foldMatch exactly and reflects a real state change", () => {
    const mod = resolveModuleClient("generic", "1.0.0");
    const lineups = defaultLineupPair(mod.positions);
    const cfg: GenericCfg = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const events = [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, { type: "generic.score", payload: { by: "H", points: 3 } }),
    ];

    const clientState = foldClient(mod, cfg, lineups, events) as GenericState;
    const directState = foldMatch(mod, cfg, lineups, events) as GenericState;

    // Not a no-op: the score event actually moved the fold.
    expect(clientState.running).toEqual({ home: 3, away: 0 });
    // Delegation, not reimplementation: identical to calling foldMatch directly.
    expect(clientState).toEqual(directState);
  });
});

describe("bundle purity", () => {
  const SRC_DIR = path.resolve(__dirname, "..");
  const FORBIDDEN_EXACT = new Set(["server-only", "next/headers", "postgres", "ioredis"]);
  const isForbidden = (spec: string) => FORBIDDEN_EXACT.has(spec) || spec.startsWith("@/server/");

  // Matches real import syntax only (`from "x"`, `require("x")`, or a
  // line-anchored bare `import "x"` side-effect import — the exact form
  // `server-only` itself uses) — NOT prose. A plain substring `includes`
  // check would also match a comment that merely NAMES the package while
  // explaining why it is absent (this file's own header does exactly that),
  // which is the "own comment" false-positive this repo has hit before.
  const IMPORT_RE = /\b(?:from|require)\s*\(?\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

  function importSpecifiers(text: string): string[] {
    return [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]).filter((s): s is string => !!s);
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue; // tests may reference testkit/engine-core freely
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("no chassis source file imports a server-only or DB specifier", () => {
    const files = sourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0); // guards against an empty/renamed dir hiding a vacuous pass
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (isForbidden(spec)) offenders.push(`${path.relative(SRC_DIR, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("self-check: the matcher actually catches a real forbidden import (proves the test above isn't vacuous)", () => {
    expect(importSpecifiers('import "server-only";\n').some(isForbidden)).toBe(true);
    expect(importSpecifiers('import { sql } from "@/server/db";\n').some(isForbidden)).toBe(true);
    expect(importSpecifiers('import postgres from "postgres";\n').some(isForbidden)).toBe(true);
    // Prose mentioning the package name must NOT trip it.
    expect(importSpecifiers('// this file drops the server-only guard\n').some(isForbidden)).toBe(false);
  });
});
