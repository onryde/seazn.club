// M2 n1 — the spectator walkthrough's SEEDING budget is derived from what the
// setup stands up, not typed beside it.
//
// The defect this closes is a latent one, and it is the one AGENTS.md #20
// names: `spectator-public.spec.ts`'s setup carried a flat
// `test.setTimeout(180_000)` written when it seeded TWO divisions, and M1 k2
// added a whole THIRD (`Upcoming` — division, two teams, stage generate,
// start, PATCH) without touching it. The file is
// `test.describe.configure({ mode: "serial" })`, so a setup that runs out of
// clock aborts every test after it, and the runner prints whichever
// `expect`/`apiJson` was in flight rather than the wall clock — the failure
// arrives dressed as a seeding or data defect (#20), and #21 then makes the
// reported count a floor rather than a total.
//
// WHY A NODE TEST, and what it can and cannot see. Playwright is not run here
// (the shared server, and the file is serial), so this pins the ARITHMETIC and
// the WIRING instead:
//
//   - the arithmetic, by importing the real `spectatorSetupBudgetMs` — a pure
//     module with no imports of its own, which is why it can be imported from
//     vitest at all (`@playwright/test` is not pulled in);
//   - the wiring, by reading the spec's own source. A pure-function test alone
//     would stay perfectly green with the spec reverted to `180_000`, which is
//     precisely the mutant this file exists to kill, so the source scan is not
//     decoration: it is the half that has teeth.
//
// The source scan asserts the two properties that make "a fourth division
// moves the budget with it" TRUE rather than aspirational: every division the
// setup creates is configured from the `SETUP_DIVISIONS` table, and the
// budget is computed from that table's size. A fourth division must therefore
// either go through the table (and move the clock) or red this file.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SETUP_FLOOR_MS,
  SETUP_BASE_MS,
  SETUP_PER_DIVISION_MS,
  spectatorSetupBudgetMs,
} from "../../../e2e/spectator-public-budget";

/** apps/web — this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");
const SPEC_PATH = join(WEB, "e2e/walkthrough/spectator-public.spec.ts");
const SPEC = readFileSync(SPEC_PATH, "utf8");

/** The setup test's body: from its own `test("setup:` to the next top-level
 *  `test(`. Scoping matters — the file has three other `test.setTimeout`
 *  calls, and two of them are already derived. */
function setupBody(): string {
  const start = SPEC.indexOf('test("setup:');
  expect(start, "the setup test is no longer named `setup: …`").toBeGreaterThan(-1);
  const rest = SPEC.slice(start + 1);
  const end = rest.indexOf("\ntest(");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the walkthrough setup's budget grows with what the setup builds", () => {
  it("reproduces the flat literal exactly at the cost it was written for — two divisions", () => {
    // The anchor that makes every number below auditable: `180_000` was not a
    // guess, it was the budget a TWO-division setup ran green on. The
    // derivation starts from that observation rather than replacing it.
    expect(spectatorSetupBudgetMs({ divisions: 2 })).toBe(180_000);
  });

  it("a third division moves it — this is the M1 k2 cost that had no budget", () => {
    const two = spectatorSetupBudgetMs({ divisions: 2 });
    const three = spectatorSetupBudgetMs({ divisions: 3 });
    expect(three).toBeGreaterThan(two);
    expect(three).toBe(SETUP_BASE_MS + 3 * SETUP_PER_DIVISION_MS);
  });

  it("…and a fourth moves it again, which is the whole claim", () => {
    // Stated as a ladder rather than a single sample: a `Math.max` that had
    // swallowed the growth term would pass the pair above on the floor alone.
    const budgets = [2, 3, 4, 5].map((divisions) => spectatorSetupBudgetMs({ divisions }));
    const strictlyIncreasing = budgets.every((ms, i) => i === 0 || ms > budgets[i - 1]!);
    expect(strictlyIncreasing, `not monotonic: ${budgets.join(" < ")}`).toBe(true);
  });

  it("never drops below the floor, however little the setup claims to build", () => {
    // A miscount (or a future setup that seeds through some other helper) must
    // not be able to SHRINK the clock below what the file already needed.
    for (const divisions of [0, 1]) {
      expect(spectatorSetupBudgetMs({ divisions }), `${divisions} divisions`).toBe(SETUP_FLOOR_MS);
    }
  });
});

describe("the spec really uses it — the half a pure-function test cannot see", () => {
  it("the setup test's clock is the derived constant, with no numeric literal left", () => {
    const body = setupBody();
    expect(body, "the setup no longer sets its own timeout").toContain("test.setTimeout(");
    expect(
      body.includes("test.setTimeout(SETUP_BUDGET_MS)"),
      "the setup's `test.setTimeout` is not the derived `SETUP_BUDGET_MS` — a flat literal beside a cost that grows is the latent red AGENTS.md #20 names",
    ).toBe(true);
    const literals = [...body.matchAll(/test\.setTimeout\(\s*[\d_]+\s*\)/g)].map((m) => m[0]);
    expect(literals, "a flat numeric timeout is back in the setup test").toEqual([]);
  });

  it("every division the setup creates is configured from SETUP_DIVISIONS", () => {
    // THE guard behind "adding a fourth moves the budget with it". Without it
    // a fourth division can be added with an inline config and the table — and
    // so the clock — stays at three.
    const calls = [...SPEC.matchAll(/makeCricketDivision\(\s*request,\s*compId,\s*([^\s,)]+)/g)].map(
      (m) => m[1]!,
    );
    expect(calls.length, "the setup creates no divisions at all any more").toBeGreaterThanOrEqual(3);
    expect(
      calls.filter((arg) => !arg.startsWith("SETUP_DIVISIONS.")),
      "these `makeCricketDivision` calls pass an inline config instead of a SETUP_DIVISIONS entry, so the setup's budget cannot see them",
    ).toEqual([]);
  });

  it("the budget is computed from that table's size, not from a typed count", () => {
    expect(
      /const SETUP_BUDGET_MS = spectatorSetupBudgetMs\(\{\s*divisions: Object\.keys\(SETUP_DIVISIONS\)\.length/.test(
        SPEC,
      ),
      "SETUP_BUDGET_MS is no longer derived from Object.keys(SETUP_DIVISIONS).length — a hand-typed count is the flat literal again, one level up",
    ).toBe(true);
  });

  it("the derived value is what a three-division setup is actually given today", () => {
    // Anti-vacuity for the scan above: it proves the SHAPE, this proves the
    // shape currently evaluates to a budget larger than the one M1 k2 left in
    // place. If these two ever disagree the scan is passing on a coincidence.
    const entries = [...SPEC.matchAll(/makeCricketDivision\(\s*request,\s*compId,\s*SETUP_DIVISIONS\.(\w+)/g)];
    const distinct = new Set(entries.map((m) => m[1]!));
    expect(distinct.size, "the setup builds three distinct divisions").toBe(3);
    expect(spectatorSetupBudgetMs({ divisions: distinct.size })).toBeGreaterThan(180_000);
  });
});
