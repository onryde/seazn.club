// A live test that no workflow runs is a test that does not exist (engine-split 1a-4 Step 7, review R10).
//
// The scheduler owns two files that talk to a REAL placement service and SKIP without one (`RUN_INTEGRATION`, gated on
// `PLACEMENT_SERVICE_HOST`): placement-integration.test.ts and repair-decompose-cpsat-integration.test.ts. The two jobs that
// could run them pull in opposite directions, and the join between them is workflow TEXT:
//
//   * ci.yml's scheduler step is the strict DB-free judge. It counts a skip as a failure, so it must EXCLUDE both files, or
//     it goes red for a reason that has nothing to do with the code.
//   * placement-ci.yml's `integration` job stands up the real container and is the only place those files can run. It must
//     run BOTH, with a judge that fails on zero tests, on any skip, and on any live file that did not report.
//
// Before this test, placement-ci.yml ran one of the two (the other was run by no workflow at all) and pointed at a path that
// had stopped existing when the file moved, so the job would have "ran 0 files" and still read as an intentional skip. Both
// directions are asserted from the workflow text, over a live-file list DERIVED from the tree, never typed here.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "../..");
const workflow = (name: string) => readFileSync(join(REPO, ".github/workflows", name), "utf8");

/** Every `*.test.ts` under src/ and test/ (recursive). */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") testFiles(path, out);
    } else if (entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** The files that gate on a live service: the tree's own declaration, a top-level `RUN_INTEGRATION` read of the host variable.
 *  Anchored to the start of a line, so this file's own prose about that declaration is not itself a "live file". */
const live = [...testFiles(join(PACKAGE, "src")), ...testFiles(join(PACKAGE, "test"))]
  .filter((file) => /^const\s+RUN_INTEGRATION\s*=\s*process\.env\.PLACEMENT_SERVICE_HOST\b/m.test(readFileSync(file, "utf8")))
  .map((file) => relative(PACKAGE, file).split("\\").join("/"));

/** The text of one workflow step: from its `- name:` line to the next step or the comment block that heads it. */
function step(yml: string, name: string): string {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(at, `no step named "${name}"`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {6}(- |#)/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n");
}

describe("the scheduler's live tests run in placement-ci.yml, and are excluded from ci.yml's strict step", () => {
  it("finds the two live files (anti-vacuity: a scan that finds nothing proves nothing)", () => {
    expect(live.length, "live files found").toBeGreaterThanOrEqual(2);
    expect(live).toContain("src/__tests__/placement-integration.test.ts");
    expect(live).toContain("src/__tests__/repair-decompose-cpsat-integration.test.ts");
  });

  it("placement-ci.yml runs every live file with the scheduler's own vitest", () => {
    const yml = workflow("placement-ci.yml");
    const run = step(yml, "Run the integration suite against the live service");
    expect(run, "the suite runs from the scheduler package").toMatch(/working-directory:\s*packages\/scheduler\b/);
    expect(run, "and not from the engine").not.toContain("packages/engine");
    expect(run).toContain("PLACEMENT_SERVICE_HOST: localhost:50051");
    for (const file of live) expect(run, `${file} is not run by the integration step`).toContain(file);
  });

  it("placement-ci.yml's judge fails on zero tests, on any skip, and on any live file that did not report", () => {
    const judge = step(workflow("placement-ci.yml"), "Assert the suite RAN, and passed");
    expect(judge, "a zero-total refusal").toMatch(/"\$total" -eq 0/);
    expect(judge, "a skipped test is a failure").toMatch(/"\$skipped" -ne 0/);
    for (const file of live) {
      expect(judge, `the judge never checks that ${file} reported`).toContain(file.split("/").pop()!);
    }
  });

  it("placement-ci.yml's filter and drift gate follow the code to packages/scheduler", () => {
    const yml = workflow("placement-ci.yml");
    const paths = yml.slice(yml.indexOf("    paths:"), yml.indexOf("concurrency:"));
    expect(paths, "the scheduler is in the PR path filter").toContain('"packages/scheduler/**"');
    // build.ts still owns the request and the fallback, so the engine's scheduling tree stays in the filter.
    expect(paths).toContain('"packages/engine/src/scheduling/**"');
    expect(paths, "the retired engine codegen script is no longer a trigger").not.toContain("packages/engine/scripts/gen-proto.ts");
    // Each step on its own: the drift gate's error message also names the command, so a joined text would let a stale
    // regenerate step ride on the message of the next one.
    const regenerate = step(yml, "Regenerate TypeScript proto stubs");
    expect(regenerate, "the codegen runs in the scheduler workspace").toMatch(/run:\s*pnpm --filter @seazn\/scheduler gen:proto\s*$/);
    const drift = step(yml, "TypeScript stub drift gate");
    expect(drift, "the gate diffs the scheduler's generated tree").toContain("git status --porcelain -- packages/scheduler/src/generated/");
    expect(regenerate + drift, "no stale engine path in the codegen or its gate").not.toMatch(/packages\/engine\/(src\/scheduling\/generated|scripts)/);
  });

  it("ci.yml's scheduler step excludes every live file, and still runs the rest of the package", () => {
    const run = step(workflow("ci.yml"), "Scheduler package tests (DB-free)");
    expect(run).toContain("packages/scheduler");
    for (const file of live) {
      expect(run, `${file} is not excluded from the strict step`).toContain(`--exclude packages/scheduler/${file}`);
    }
    // The strict judge, copied from the reference step: zero tests, a failed suite and any skip or todo are all red.
    expect(run).toContain("numTotalTests > 0");
    expect(run).toContain("numFailedTestSuites");
    expect(run).toContain("numPassedTests !== r.numTotalTests");
  });
});
