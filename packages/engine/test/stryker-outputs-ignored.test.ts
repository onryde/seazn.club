// W1d Task 16, FINAL-FIX M8: every file a Stryker leg uploads from packages/engine/ is a GENERATED file, and a local run of the
// same commands (`mutation:floor --survivors`, `pnpm mutation`) leaves it behind in the working tree, so each must be
// gitignored. The list is read from mutation.yml's upload step, never typed here: a file the workflow starts uploading that
// the ignore file does not cover reds this test by name.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/mutation.yml"), "utf8");

/** The engine paths of the artifact upload's `path: |` block, with the matrix expression stood in for by a real leg name. */
function uploadedEnginePaths(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /uses:\s*actions\/upload-artifact@/.test(l));
  if (at < 0) return [];
  const pathAt = lines.findIndex((l, i) => i > at && /^\s*path:\s*\|\s*$/.test(l));
  if (pathAt < 0) return [];
  const indent = (l: string) => l.length - l.trimStart().length;
  const out: string[] = [];
  for (let i = pathAt + 1; i < lines.length && lines[i]!.trim() !== "" && indent(lines[i]!) > indent(lines[pathAt]!); i++) {
    const p = lines[i]!.trim().replaceAll("${{ matrix.group }}", "probe");
    if (p.startsWith("packages/engine/")) out.push(p);
  }
  return out;
}

const ignored = (path: string): boolean => {
  const r = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: REPO, timeout: SPAWN_MS });
  expect(r.status === 0 || r.status === 1, `git check-ignore ${path}: status ${r.status} (0 ignored, 1 not)`).toBe(true);
  return r.status === 0;
};

describe("the files a Stryker leg uploads from packages/engine/ are gitignored (M8)", () => {
  const paths = uploadedEnginePaths(WORKFLOW);

  it("the upload step is read: the survivors file and the report are among its paths (a parse that finds none proves nothing)", () => {
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(paths).toContain("packages/engine/SURVIVORS.md");
    expect(paths).toContain("packages/engine/reports/mutation/probe.json");
  });

  it("every uploaded engine path is ignored, so a local run leaves the tree clean", () => {
    expect(paths.filter((p) => !ignored(p))).toEqual([]);
  }, spawnBudget(Math.max(paths.length, 1)));

  it("the check can say no: a tracked engine file is not ignored", () => {
    expect(ignored("packages/engine/package.json")).toBe(false);
  });

  it("the reader finds nothing in a workflow with no upload step, and nothing outside packages/engine/", () => {
    expect(uploadedEnginePaths("jobs:\n  a:\n    steps:\n      - run: echo\n")).toEqual([]);
    expect(uploadedEnginePaths("      - uses: actions/upload-artifact@v4\n        with:\n          path: |\n            other/place.json\n")).toEqual([]);
  });
});
