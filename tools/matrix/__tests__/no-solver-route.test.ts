// Ruling 66 (W1d D23): the matrix drives no solver route, so matrix-truth.yml carries no placement container. This is
// the premise as a guard, a pure scan with no network and no DB. If a matrix path ever reaches the solver, the container
// stops being optional plumbing and becomes a precondition, and no check may claim to prove scheduling: the owner re-decides.
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HM = resolve(REPO, "tools/matrix");
const SOLVER_ROUTE = /schedule\/auto|schedule\/ai-|ai-plan/;
// The board's real solver controls, from apps/web/src/components/v2/schedule-board.tsx (:1416, :1433, :1456, :1485). The words
// run schedule-auto, not auto-schedule (review 4, R4-I3), so the pattern is built from the testids themselves.
const BOARD_SOLVER_CONTROLS = ["schedule-auto", "schedule-reflow", "schedule-polish", "board-ai-schedule"];
const BOARD_SOLVER_CONTROL = /schedule-(auto|reflow|polish)|board-ai-schedule|autoRun/;

describe("ruling 66: no matrix path reaches the solver", () => {
  it("the route pattern matches the real solver routes and not the matrix's own (a positive pair)", () => {
    const solver = ["/api/v1/stages/x/schedule/auto", "/api/v1/stages/x/schedule/ai-plan", "/schedule/ai-plan/apply"];
    const matrix = ["/api/v1/stages/x/generate", "/api/v1/divisions/x/start", "/api/v1/stages/x/rebuild"];
    for (const p of solver) expect(SOLVER_ROUTE.test(p), p).toBe(true);
    for (const p of matrix) expect(SOLVER_ROUTE.test(p), p).toBe(false);
    expect(solver).toHaveLength(3);
    expect(matrix).toHaveLength(3);
  });

  it("the control pattern matches the board's four REAL solver testids, read from the product source (a positive pair)", () => {
    const board = readFileSync(resolve(REPO, "apps/web/src/components/v2/schedule-board.tsx"), "utf8");
    let checked = 0;
    for (const id of BOARD_SOLVER_CONTROLS) {
      expect(board, `${id} is no longer in the board: re-read the controls`).toContain(`data-testid="${id}"`);
      expect(BOARD_SOLVER_CONTROL.test(`[data-testid="${id}"]`), id).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
    expect(BOARD_SOLVER_CONTROL.test('[data-testid="stage-generate"]')).toBe(false);
  });

  it("no non-test file under tools/matrix names a solver route, and none under lib/browser names a board solver control (ruling 66)", () => {
    const files = globSync("**/*.ts", { cwd: HM }).filter((f) => !/__tests__|\.test\.ts$|^catalogue\//.test(f)).sort();
    // anti-vacuity: the scan must have read files, and the ones that matter must be among them
    expect(files.length, "zero files scanned is a failure").toBeGreaterThan(0);
    expect(files).toEqual(expect.arrayContaining(["lib/driver/http-driver.ts", "lib/browser/selectors.ts", "lib/browser/pages/stage-rail.ts", "run.ts"]));
    const browser = files.filter((f) => f.startsWith("lib/browser/"));
    expect(browser.length, "zero browser files scanned").toBeGreaterThan(1);
    const text = (f: string): string => readFileSync(join(HM, f), "utf8");
    const hits = [...files.filter((f) => SOLVER_ROUTE.test(text(f))), ...browser.filter((f) => BOARD_SOLVER_CONTROL.test(text(f)))];
    expect(hits, `scanned ${files.length} file(s), ${browser.length} of them browser. A matrix path now reaches the solver: re-decide the placement container as plumbing, and no check may claim to prove scheduling (owner ruling 66)`).toEqual([]);
  });
});
