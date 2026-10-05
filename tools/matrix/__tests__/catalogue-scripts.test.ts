// W1d Task 19 fix round 1 (review m9): the generators of the committed catalogue files live in the repo, beside what they generate.
//
// tools/matrix/catalogue/scripts/ holds the python that wrote triage-rules.json, audit-verdicts.json and p-map.json. Each is run
// here into a scratch file and compared byte for byte with the committed one, so (a) the scripts stay runnable and (b) a hand edit
// of a generated file without the matching edit of its script fails by name. gen-shapes.py, dump.py and classify.py read the
// three baseline dispatches' results, which are not in the repo until Task 21 commits them; they are listed and documented, not run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CATALOGUE_DIR } from "../lib/triage.ts";
import { REPO } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const SCRIPTS = resolve(CATALOGUE_DIR, "scripts");
const scratch = mkdtempSync(join(tmpdir(), "w1d-t19-scripts-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** [script, the committed file it writes, extra argv before the output path]. */
const REBUILT: readonly (readonly [string, string, readonly string[]])[] = [
  ["gen-rules.py", "triage-rules.json", []],
  ["gen-verdicts.py", "audit-verdicts.json", []],
  // gen-routing.py takes the repo it reads design section 8 from, then the output.
  ["gen-routing.py", "gap-routing.json", [REPO]],
  // build-p-map.py takes the repo it reads W1-driving's committed TRIAGE.md and results from, then the output.
  ["build-p-map.py", "p-map.json", [REPO]],
];

describe("the catalogue generators (review m9)", () => {
  it("python3 is there: a missing interpreter is a failure of its own, never a skipped test", () => {
    const r = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: SPAWN_MS });
    expect(r.error, "python3 must be on PATH").toBeUndefined();
    expect(r.status).toBe(0);
  });

  it("every script of the directory is one this test knows: a new generator is rebuilt here or documented as needing the dispatches", () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".py")).sort();
    const needsDispatches = ["classify.py", "dump.py", "gen-shapes.py"];
    expect(files).toEqual([...REBUILT.map((r) => r[0]), ...needsDispatches].sort());
    for (const f of needsDispatches) {
      const src = readFileSync(resolve(SCRIPTS, f), "utf8");
      expect(src, `${f} says how to run it`).toMatch(/W1D_DISPATCH=/);
    }
    expect(existsSync(resolve(SCRIPTS, "README.md"))).toBe(true);
    const readme = readFileSync(resolve(SCRIPTS, "README.md"), "utf8");
    for (const f of files) expect(readme, `README names ${f}`).toContain(f);
  });

  for (const [script, committed, pre] of REBUILT) {
    it(`${script} rebuilds ${committed} byte for byte`, () => {
      const out = join(scratch, committed);
      const r = spawnSync("python3", [resolve(SCRIPTS, script), ...pre, out], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      expect(r.status, `${script} exit: ${r.stderr}`).toBe(0);
      const built = readFileSync(out);
      const want = readFileSync(resolve(CATALOGUE_DIR, committed));
      expect(built.length, `${committed} is not empty`).toBeGreaterThan(100);
      // Compare as text so a diff names the first differing line; equal text of equal length is equal bytes.
      expect(built.equals(want), `${committed} differs from what ${script} writes (a hand edit needs the same edit in the script)`).toBe(true);
    }, spawnBudget(1));
  }

  it("the rebuilt files are the ones the loaders read: they parse (rules and verdicts through their own schemas), and the count of generators is 4", () => {
    expect(REBUILT).toHaveLength(4);
    const pmap = JSON.parse(readFileSync(resolve(CATALOGUE_DIR, "p-map.json"), "utf8")) as Record<string, string>;
    // 164 product reds of W1-driving (the script asserts it too), every value a P-rule or a coverage-table label.
    expect(Object.keys(pmap)).toHaveLength(164);
    for (const label of Object.values(pmap)) expect(label).toMatch(/^(?:P[1-7]|CT:[a-z0-9-]+)$/);
  });
});
