// ci.yml's `changes` job answers docs-only or code, the heavy jobs skip on a
// docs-only answer, and `ci-gate` is the one check that reports for all of them.
// Three wiring facts make that safe, and none is visible from any one job:
//
//   * ci-gate `needs` EVERY other job. A job added later and left out of that
//     list could fail, or be skipped on a code PR, and the gate would still
//     pass — a required check that does not look at the job.
//   * ci-gate runs `always()`. Without it a failed upstream job SKIPS the gate,
//     and GitHub counts a skipped required check as passed.
//   * exactly the intended jobs are gated, each `needs: changes`. In particular
//     `gates` is NOT: its matrix harness tests read the docs (cli-invocation
//     sweeps every tracked *.md), so a docs-only PR must still run it.
//
// Read from ci.yml's text, like the repo's other workflow guards: no YAML library
// is a declared root dependency, and toolchain.test.ts enforces that.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CI_YML = join(import.meta.dirname, "../..", ".github/workflows/ci.yml");
const GATED_IF = "if: needs.changes.outputs.code == 'true'";

/** The jobs whose `if:` skips them on a docs-only change: the design, stated here, not read back from the file. */
const GATED = [
  "container",
  "matrix-rows",
  "smoke-db",
  "smoke-db-app",
  "smoke-db-outliers",
  "smoke-db-usecases",
  "smoke-e2e",
  "test",
];
/** Must run on a docs-only change too — see the header. */
const NEVER_GATED = ["changes", "gates", "security", "placement-pin", "scheduler-live"];

interface Job {
  id: string;
  /** Job-level lines only (4-space keys), comments dropped. */
  header: string[];
  needs: string[];
  text: string;
}

const jobs = (): Job[] => {
  const text = readFileSync(CI_YML, "utf8");
  const body = text.slice(text.indexOf("\njobs:"));
  return body
    .split(/\n(?= {2}[A-Za-z][\w-]*:\s*\n)/)
    .slice(1)
    .map((block) => {
      const lines = block.split("\n").filter((l) => !/^\s*#/.test(l));
      const id = /^ {2}([A-Za-z][\w-]*):/.exec(lines[0])![1];
      const header = lines.filter((l) => /^ {4}[A-Za-z][\w-]*:/.test(l));
      let needs: string[] = [];
      const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
      if (at >= 0) {
        const inline = lines[at].replace(/^ {4}needs:\s*/, "").trim();
        if (inline) needs = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
        else for (const l of lines.slice(at + 1)) {
          const m = /^ {6}- ([\w-]+)\s*$/.exec(l);
          if (!m) break;
          needs.push(m[1]);
        }
      }
      return { id, header, needs, text: lines.join("\n") };
    });
};

describe("ci.yml: the docs-only gate and ci-gate", () => {
  it("ci-gate needs every other job in the workflow, and runs always()", () => {
    const all = jobs();
    // Anti-vacuity: the split must have found the workflow's jobs, not one blob.
    expect(all.length, `jobs found: ${all.map((j) => j.id).join(", ")}`).toBeGreaterThan(10);
    const gate = all.find((j) => j.id === "ci-gate");
    expect(gate, "a ci-gate job").toBeDefined();
    const others = all.filter((j) => j.id !== "ci-gate").map((j) => j.id).sort();
    expect([...gate!.needs].sort()).toEqual(others);
    expect(gate!.header).toContain("    if: always()");
  });

  it("gates exactly the intended jobs on `changes`, each of which needs it, and leaves the rest ungated", () => {
    const all = jobs();
    const byId = new Map(all.map((j) => [j.id, j]));
    const gated = all.filter((j) => j.header.includes(`    ${GATED_IF}`)).map((j) => j.id).sort();
    expect(gated).toEqual([...GATED].sort());
    for (const id of GATED) expect(byId.get(id)!.needs, `${id} needs changes`).toContain("changes");
    for (const id of NEVER_GATED) {
      const j = byId.get(id);
      expect(j, `job ${id}`).toBeDefined();
      expect(j!.text, `${id} must run on a docs-only change`).not.toContain("needs.changes.outputs.code");
    }
  });

  it("`changes` answers through scripts/ci-docs-only.sh and exposes that answer as outputs.code", () => {
    const changes = jobs().find((j) => j.id === "changes");
    expect(changes, "a changes job").toBeDefined();
    expect(changes!.text).toContain("code: ${{ steps.verdict.outputs.code }}");
    expect(changes!.text).toMatch(/id: verdict\n(?:.*\n)*? {8}run: bash scripts\/ci-docs-only\.sh\n/);
  });
  it("every job with a Postgres service runs scripts/ci-pg-fast.sh before db:apply", () => {
    // Stated here, not read back: the five database-bound jobs.
    const DB_JOBS = ["smoke-db", "smoke-db-app", "smoke-db-outliers", "smoke-db-usecases", "smoke-e2e"];
    const withPg = jobs().filter((j) => j.text.includes("image: postgres:16"));
    expect(withPg.map((j) => j.id).sort()).toEqual([...DB_JOBS].sort());
    for (const j of withPg) {
      const tune = j.text.indexOf("run: bash scripts/ci-pg-fast.sh\n");
      const apply = j.text.indexOf("run: npm run db:apply");
      expect(tune, `${j.id} runs the tuning step`).toBeGreaterThan(-1);
      expect(apply, `${j.id} runs db:apply`).toBeGreaterThan(-1);
      expect(tune, `${j.id}: tuning precedes db:apply`).toBeLessThan(apply);
    }
    const script = readFileSync(join(import.meta.dirname, "..", "ci-pg-fast.sh"), "utf8");
    for (const g of ["fsync", "full_page_writes", "synchronous_commit"]) {
      expect(script, `${g} is set off`).toContain(`ALTER SYSTEM SET ${g} = off`);
    }
    expect(script, "the script asserts the setting landed").toContain('"$v" != "off"');
  });
});
