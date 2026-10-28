// Smoke split (Task 4 review): the suites moved from scripts/smoke.ts to scripts/smoke/suites/, two directories deeper, and
// seven of them read a dictionary through `new URL("../apps/web/…", import.meta.url)` — a path relative to the FILE, which
// tsc cannot see (it is a string) and which the full smoke only reaches 40 suites in. A copy that kept `../` resolved under
// scripts/smoke/ and threw ENOENT. This reads every file of the smoke script and resolves each file-relative path from that
// file: a `new URL(<literal>, import.meta.url)` (a template's static part before its first `${`, which must name an existing
// directory) and every relative import specifier. Every `import.meta` in the code must be one of the URLs resolved here, so a
// new location-dependent read cannot slip past unchecked. COUNTED: zero URLs, zero imports or zero files is a failure.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SMOKE_DIR = join(import.meta.dirname, "..", "smoke");
const FILES = readdirSync(SMOKE_DIR, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(SMOKE_DIR, f));

/** `new URL("…" | '…' | `…`, import.meta.url)` — the literal and its quote. */
const FILE_URL = /new URL\(\s*(["'`])([^"'`]*)\1\s*,\s*import\.meta\.url\s*\)/g;
/** A static `import … from "./…"` / `"../…"` (and `export … from`), or a dynamic `import("./…")`. */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
/** Lines that are code, not comment prose (a comment may name `import.meta.url` without reading anything). */
const codeLines = (text: string): string => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** Where a file-relative URL lands: a file for a plain literal, the directory before the first `${` for a template. */
function target(file: string, spec: string): { path: string; kind: "file" | "dir" } {
  const at = spec.indexOf("${");
  if (at === -1) return { path: resolve(dirname(file), spec), kind: "file" };
  const head = spec.slice(0, at);
  return { path: resolve(dirname(file), head.slice(0, head.lastIndexOf("/") + 1)), kind: "dir" };
}
const exists = (t: { path: string; kind: "file" | "dir" }): boolean =>
  existsSync(t.path) && (t.kind === "file" ? statSync(t.path).isFile() : statSync(t.path).isDirectory());

describe("smoke split: every file-relative path in scripts/smoke/ resolves from the file that holds it", () => {
  it("the walk reads the entry, main() and the suites", () => {
    const rel = FILES.map((f) => f.slice(SMOKE_DIR.length + 1));
    expect(rel, `smoke files read: ${rel.length}`).toEqual(expect.arrayContaining(["index.ts", "main.ts", "harness.ts"]));
    expect(rel.filter((f) => f.startsWith("suites/")).length, "suite files read").toBeGreaterThan(100);
  });

  it("every `new URL(<literal>, import.meta.url)` names a path that exists, and every `import.meta` is one of them", () => {
    const missing: string[] = [];
    let urls = 0;
    let metas = 0;
    for (const f of FILES) {
      const code = codeLines(readFileSync(f, "utf8"));
      for (const m of code.matchAll(FILE_URL)) {
        urls++;
        if (!exists(target(f, m[2]!))) missing.push(`${f.slice(SMOKE_DIR.length + 1)}: ${m[2]}`);
      }
      metas += [...code.matchAll(/\bimport\.meta\b/g)].length;
    }
    // The sweep at the move found seven dictionary reads (i18n, publicQualificationStandings, bracketFinish, boardRoundCodes,
    // onlineChessDesk, stageRulesFormatSmoke, w2cStageRules); fewer means the matcher stopped reading them.
    expect(urls, `file URLs resolved: ${urls}`).toBeGreaterThanOrEqual(7);
    expect(missing, `file URLs that resolve to nothing (of ${urls})`).toEqual([]);
    expect(metas, "every import.meta in the code is a file URL resolved above").toBe(urls);
  });

  it("every relative import specifier resolves to a file", () => {
    const missing: string[] = [];
    let imports = 0;
    for (const f of FILES) {
      for (const m of codeLines(readFileSync(f, "utf8")).matchAll(RELATIVE_IMPORT)) {
        imports++;
        if (!exists({ path: resolve(dirname(f), m[1]!), kind: "file" })) missing.push(`${f.slice(SMOKE_DIR.length + 1)}: ${m[1]}`);
      }
    }
    // main.ts alone imports 106 suite files; index.ts, the suites and the harness add theirs.
    expect(imports, `relative imports resolved: ${imports}`).toBeGreaterThan(106);
    expect(missing, `relative imports that resolve to nothing (of ${imports})`).toEqual([]);
  });
});
