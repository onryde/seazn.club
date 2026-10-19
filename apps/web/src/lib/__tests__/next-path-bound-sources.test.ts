// Review M2 of the login-round-trip fix: `next` (the post-auth return path) is bounded by ONE constant,
// NEXT_PATH_MAX_LENGTH (lib/types.ts), and every zod schema that takes a `next` has to use it. Without a guard a route
// can quietly grow its own literal again (`next: z.string().max(1000)` on magic-link, say), and the person is then
// bounced at that one step with a link every other step accepted. That is exactly how the 500-character bound hid in
// four places. Behaviour tests cannot see it: a route-local `.max(1000)` still accepts the real links.
//
// So this reads the source. It scans every non-test .ts/.tsx under apps/web/src for a property named `next` whose value
// is a zod schema, and requires `.max(NEXT_PATH_MAX_LENGTH)` and no other `.max(`. It reports how many schemas it
// checked, and finding none is a failure (a scan whose pattern drifted from the code would otherwise pass for ever).
// The four sites that exist today are named, so a refactor that moves one has to say so here.
//
// Sport: not applicable. This is auth plumbing.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/web/src/, with a trailing slash: this file sits in src/lib/__tests__/. */
const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Every non-test source file under `dir`: no tests, no installed packages, no build output. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "node_modules", ".next"].includes(entry.name) ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every property named `next` whose value is a zod schema, as the text of its chain (a chain written over several
 *  lines is joined). A commented-out line is not a schema. */
function nextSchemas(source: string): { line: number; text: string }[] {
  const lines = source.split("\n");
  const found: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const m = /(^|[\s{,])next\??\s*:\s*z\b/.exec(lines[i]!);
    if (!m) continue;
    let text = lines[i]!.slice(m.index);
    for (let j = i + 1; j < lines.length && lines[j]!.trimStart().startsWith("."); j++) text += ` ${lines[j]!.trim()}`;
    found.push({ line: i + 1, text });
  }
  return found;
}

/** Why a `next` schema is not bounded by the shared constant, or null when it is. */
function boundProblem(text: string): string | null {
  const bounds = [...text.matchAll(/\.max\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  if (bounds.length === 0) return "has no .max(): unbounded";
  const others = bounds.filter((b) => b !== "NEXT_PATH_MAX_LENGTH");
  return others.length > 0 ? `.max(${others.join(", ")}) is not NEXT_PATH_MAX_LENGTH` : null;
}

/** The sites that carry a `next` bound today, relative to src/. A move or a deletion has to be made here too. */
const KNOWN_SITES = [
  "lib/types.ts",
  "app/api/auth/magic-link/route.ts",
  "app/api/auth/magic-link/consume/route.ts",
  "app/api/auth/verify-email/route.ts",
];

describe("every zod `next` is bounded by NEXT_PATH_MAX_LENGTH and nothing else", () => {
  it("scans the whole source tree: each known site is found, and every schema found is bounded by the constant alone", () => {
    const files = sourceFiles(SRC);
    expect(files.length, "the scan walked the tree").toBeGreaterThan(100);

    const checked: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      for (const schema of nextSchemas(fs.readFileSync(file, "utf8"))) {
        checked.push({ file: path.relative(SRC, file), ...schema });
      }
    }
    const summary = `checked ${checked.length} next schemas in ${files.length} files`;
    expect(checked.length, `anti-vacuity: ${summary}`).toBeGreaterThan(0);

    const sites = new Set(checked.map((c) => c.file));
    for (const site of KNOWN_SITES) expect(sites.has(site), `${site} carries a next schema (${summary})`).toBe(true);

    const problems = checked
      .map((c) => ({ where: `${c.file}:${c.line}`, problem: boundProblem(c.text) }))
      .filter((p) => p.problem !== null);
    expect(problems, summary).toEqual([]);
  });

  it("the checker can fail: a literal, another constant, no bound at all, and a literal on a continuation line are each caught", () => {
    const flagged = (source: string) => nextSchemas(source).map((s) => boundProblem(s.text));
    const canonical = "  next: z.string().max(NEXT_PATH_MAX_LENGTH).optional(),";
    expect(flagged(canonical)).toEqual([null]);
    expect(flagged("  next: z\n    .string()\n    .max(NEXT_PATH_MAX_LENGTH)\n    .optional(),")).toEqual([null]);

    expect(flagged("  next: z.string().max(500).optional(),")).toEqual([".max(500) is not NEXT_PATH_MAX_LENGTH"]);
    expect(flagged("  next: z.string().max(1000).optional(),")).toEqual([".max(1000) is not NEXT_PATH_MAX_LENGTH"]);
    expect(flagged("  next: z.string().max(MAX_NAME).optional(),")).toEqual([".max(MAX_NAME) is not NEXT_PATH_MAX_LENGTH"]);
    expect(flagged("  next: z.string().optional(),")).toEqual(["has no .max(): unbounded"]);
    expect(flagged("  next: z\n    .string()\n    .max(300)\n    .optional(),")).toEqual([".max(300) is not NEXT_PATH_MAX_LENGTH"]);
    expect(flagged("z.object({ next: z.string().max(80) })")).toEqual([".max(80) is not NEXT_PATH_MAX_LENGTH"]);

    // Not schemas: a commented-out line, a doc line, a field of another name, a plain TypeScript property.
    expect(flagged("  // next: z.string().max(500).optional(),")).toEqual([]);
    expect(flagged("   *  next: z.string().max(500)")).toEqual([]);
    expect(flagged("  nextPage: z.string().max(40).optional(),")).toEqual([]);
    expect(flagged("  next: string | null;")).toEqual([]);
  });
});
