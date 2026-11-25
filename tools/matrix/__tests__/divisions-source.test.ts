// The divisions folder reader's anti-vacuity floor: a read that finds fewer modules than the product has THROWS, and the real
// folder clears the floor with the exact count the floor was set from. MIN_MODULES=0 would make the throw unreachable.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIVISIONS_DIR, MIN_MODULES, divisionsModules, divisionsSource } from "./divisions-source.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("divisions-source: the folder reader's floor", () => {
  it("throws on a divisions folder holding fewer than MIN_MODULES modules", () => {
    const repo = mkdtempSync(join(tmpdir(), "divisions-source-"));
    try {
      mkdirSync(join(repo, DIVISIONS_DIR), { recursive: true });
      writeFileSync(join(repo, DIVISIONS_DIR, "only.ts"), "export const a = 1;\n");
      expect(() => divisionsModules(repo)).toThrow(/fewer than the \d+ the scan needs/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a test file beside the modules is not a module: it neither clears the floor nor joins the scanned source", () => {
    const repo = mkdtempSync(join(tmpdir(), "divisions-source-"));
    try {
      const dir = join(repo, DIVISIONS_DIR);
      mkdirSync(dir, { recursive: true });
      // One module short of the floor, plus a test file: still a lost scan, so it THROWS.
      const modules = Array.from({ length: MIN_MODULES - 1 }, (_, i) => `m${i}.ts`);
      for (const m of modules) writeFileSync(join(dir, m), `export const ${m.slice(0, -3)} = 1;\n`);
      writeFileSync(join(dir, "patch.test.ts"), "// TEST-ONLY TEXT\n");
      expect(() => divisionsModules(repo)).toThrow(new RegExp(`holds ${MIN_MODULES - 1} modules, fewer than the ${MIN_MODULES}`));
      // At the floor the test file is still left out: of the module list and of the source the door tests read.
      writeFileSync(join(dir, "index.ts"), "export {};\n");
      const files = divisionsModules(repo);
      expect(files, "the modules the scan read").toEqual([...modules, "index.ts"].sort());
      expect(files.length, "anti-vacuity: the floor's own count was read").toBe(MIN_MODULES);
      expect(divisionsSource(repo)).not.toContain("TEST-ONLY TEXT");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reads the real folder: at least MIN_MODULES modules, index.ts among them, all of it in the source", () => {
    const files = divisionsModules(REPO);
    expect(files.length).toBeGreaterThanOrEqual(MIN_MODULES);
    expect(MIN_MODULES).toBeGreaterThanOrEqual(7);
    expect(files).toContain("index.ts");
    expect(divisionsSource(REPO).length).toBeGreaterThan(files.length * 100);
  });
});
