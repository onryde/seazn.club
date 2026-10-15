// lib/relay-phase.ts is IMPORT-FREE, and that is a guard, not a comment (R2007 PR B review M3). Two readers depend on it:
//   * api-v1/schemas.ts imports it by relative `.ts` path, and scripts/openapi-gen.ts / gen-relay-contracts.ts load
//     schemas.ts under bare `node --experimental-strip-types` (no `@/`);
//   * the overlay page (a client component, R2005) reads the loopback phase endpoint through it, and must never pull a
//     server module into the client bundle — schemas.ts itself reaches the engine's scheduler, which `next build` cannot
//     bundle for the browser (tsc and vitest stay green when it happens).
// So the file may import NOTHING — not a package, not a relative module, not even a type-only import. The scanner is
// proved on planted sources first, so a scan that finds nothing is a real zero.
//
// Pure — no DB, no sport (the relay is sport-agnostic).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = resolve(import.meta.dirname, "../relay-phase.ts");

/** Every module reference in a TS source: static and type-only imports, side-effect imports, re-exports, dynamic
 *  imports and requires. Comments are dropped first (the file's own header talks ABOUT imports). */
function moduleReferences(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const patterns = [
    /^\s*import\s[^;]*?from\s*["'][^"']+["']/gm,   // import x / { x } / type { x } / * as x from "m"
    /^\s*import\s*["'][^"']+["']/gm,                // import "m"
    /^\s*export\s[^;]*?from\s*["'][^"']+["']/gm,   // export { x } / * from "m"
    /\bimport\s*\(/g,                               // import("m")
    /\brequire\s*\(/g,                              // require("m")
  ];
  return patterns.flatMap((p) => code.match(p) ?? []);
}

describe("lib/relay-phase.ts is import-free (client-safe, strip-types-safe)", () => {
  it("the scanner finds every kind of module reference it is planted with — and none in comments", () => {
    const planted: [string, number][] = [
      ['import { z } from "zod";', 1],
      ['import type { RelayHeartbeat } from "@/server/api-v1/schemas";', 1],
      ['import * as S from "../server/api-v1/schemas.ts";', 1],
      ['import "server-only";', 1],
      ['export { PROGRAMME_PHASES } from "./other";', 1],
      ['export * from "./other";', 1],
      ['const m = await import("node:fs");', 1],
      ['const fs = require("node:fs");', 1],
      ["// schemas.ts imports it by relative path; import x from \"y\" in a comment", 0],
      ['/* import { z } from "zod"; */ export const A = 1;', 0],
      ['export const PATH = "/phase";', 0],
    ];
    let checked = 0;
    for (const [source, want] of planted) {
      expect(moduleReferences(source), source).toHaveLength(want);
      checked++;
    }
    expect(checked).toBe(planted.length);
    expect(planted.filter(([, n]) => n > 0).length, "anti-vacuity: positive controls").toBe(8);
  });

  it("the real file has no module reference at all, and exports the loopback reader the overlay needs", () => {
    const text = readFileSync(SOURCE, "utf8");
    // Premise: the scan read the real module, not an empty or wrong file.
    expect(text).toContain("export const PROGRAMME_PHASES");
    expect(text).toContain("export function parseRelayPhaseReply");
    expect(text.split("\n").length).toBeGreaterThan(10);
    expect(moduleReferences(text)).toEqual([]);
  });
});
