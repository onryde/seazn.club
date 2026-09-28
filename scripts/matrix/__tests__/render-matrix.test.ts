import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { SEVERITY, renderMatrix, worstState } from "../lib/render-matrix.ts";
import { CASE_STATES, GLYPH, type CaseResult, type RunResults } from "../lib/results.ts";

// The catalogue as a run snapshots it (run.ts): the tests below that expect the
// full 21 × 11 grid read it from here, the way a real results.json carries it.
const GRID = { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] };
const run = (cases: CaseResult[], grid: RunResults["grid"] = GRID): RunResults => ({ schemaVersion: 2, runId: "r1", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", grid, cases });
const kase = (p: Partial<CaseResult>): CaseResult => ({
  caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
  state: "works", reason: "", checks: [], counts: { calls: 1, fixtures: 1, events: 1 }, durationMs: 5, notes: [], ...p,
});

/** Split a markdown table row on UNESCAPED pipes; drops the outer empties. */
const cells = (line: string): string[] => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
const lineStarting = (md: string, prefix: string) => md.split("\n").find((l) => l.startsWith(prefix));

describe("renderMatrix — empty first", () => {
  it("an empty run renders the explicit banner and no table (R13)", () => {
    const md = renderMatrix(run([]));
    expect(md).toContain("**No cases run.**");
    expect(md).not.toContain("| row |");
  });
});

describe("renderMatrix", () => {
  it("renders all 21 rows × 11 sports; cells without cases are ░", () => {
    const md = renderMatrix(run([kase({})]));
    for (const row of ROW_KEYS) expect(md).toContain(`| ${row} |`);
    const header = md.split("\n").find((l) => l.startsWith("| row |"))!;
    for (const s of SPORT_KEYS) expect(header).toContain(s);
    const league = md.split("\n").find((l) => l.startsWith("| league |"))!;
    expect(league.split("|").filter((c) => c.trim() === "░").length).toBe(10);
    expect(league).toContain("✅");
  });
  it("columns follow SPORT_KEYS, rows follow ROW_KEYS, and a case lands under its own sport", () => {
    const md = renderMatrix(run([kase({})]));
    expect(cells(lineStarting(md, "| row |")!)).toEqual(["row", ...SPORT_KEYS]);
    const tableRows = md.split("\n").filter((l) => ROW_KEYS.some((r) => l.startsWith(`| ${r} |`))).map((l) => cells(l)[0]);
    expect(tableRows).toEqual([...ROW_KEYS]);
    const league = cells(lineStarting(md, "| league |")!);
    expect(league.indexOf("✅")).toBe(1 + SPORT_KEYS.indexOf("generic"));
  });
  it("a cell shows its WORST case: one red among works is red", () => {
    const md = renderMatrix(run([kase({}), kase({ caseId: "x", scenario: "M1", state: "red", reason: "m1-walkover-recorded" })]));
    expect(md.split("\n").find((l) => l.startsWith("| league |"))).toContain("❌");
  });
  it("worstState: empty → null; severity order", () => {
    expect(worstState([])).toBeNull();
    expect(worstState(["works", "later"])).toBe("later");
    expect(worstState(["refused", "red", "later"])).toBe("red");
  });
  it("SEVERITY ranks every state exactly once, in the declared order", () => {
    // A state missing from SEVERITY would make worstState return null for a
    // cell holding only that state, and the cell would read ░ "not run".
    expect([...SEVERITY].sort()).toEqual([...CASE_STATES].sort());
    expect(SEVERITY).toEqual(["red", "later", "needs_ruling", "no_path", "not_run", "refused", "works"]);
    for (const s of CASE_STATES) expect(worstState([s])).toBe(s);
  });
  it("is deterministic and carries no durations or timestamps from the run", () => {
    const a = renderMatrix(run([kase({ durationMs: 1 })]));
    const b = renderMatrix(run([kase({ durationMs: 999 })]));
    expect(a).toBe(b);
    expect(a).toContain("Do not edit by hand");
    const c = renderMatrix({ ...run([kase({ durationMs: 1 })]), startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T11:00:00Z" });
    expect(c).toBe(a);
  });
  it("case order in results.json does not change the output", () => {
    const one = kase({ caseId: "a|1" });
    const two = kase({ caseId: "b|2", sport: "tennis", variant: "doubles", state: "later", reason: "W1b: x" });
    expect(renderMatrix(run([two, one]))).toBe(renderMatrix(run([one, two])));
  });
  it("totals count each state and the whole run", () => {
    const md = renderMatrix(run([kase({ caseId: "a" }), kase({ caseId: "b" }), kase({ caseId: "c", state: "red" })]));
    expect(md).toContain(`| ${GLYPH.works} works | 2 |`);
    expect(md).toContain(`| ${GLYPH.red} red | 1 |`);
    expect(md).toContain(`| ${GLYPH.later} later | 0 |`);
    expect(md).toContain("| total | 3 |");
  });
  it("the cases table counts applied checks over all checks, and items only from applied ones", () => {
    const md = renderMatrix(run([kase({
      caseId: "league|generic|score|LIFECYCLE",
      checks: [
        { id: "I1", kind: "invariant", verdict: "pass", checked: 3, reason: "", evidence: [] },
        { id: "I2", kind: "invariant", verdict: "abstain", checked: 0, reason: "", evidence: [] },
      ],
    })]));
    const row = cells(lineStarting(md, "| `league")!);
    expect(row.slice(-2)).toEqual(["1/2", "3"]);
  });
});

// PF4: an error-red (a product 400, a driver crash) has no checks at all. It
// must still read ❌ in the grid and carry its reason in the cases table.
describe("renderMatrix — error reds (PF4)", () => {
  it("a zero-check error case is ❌ in its cell and shows its `error:` reason", () => {
    const reason = "error: RefusedCall: /api/v1/divisions/d1/stages → HTTP 400 VALIDATION: bad stage";
    const md = renderMatrix(run([kase({ caseId: "knockout|generic|score|LIFECYCLE", row: "knockout", state: "red", reason, checks: [] })]));
    const ko = cells(lineStarting(md, "| knockout |")!);
    expect(ko[1 + SPORT_KEYS.indexOf("generic")]).toBe("❌");
    const row = cells(lineStarting(md, "| `knockout")!);
    expect(row).toEqual(["`knockout\\|generic\\|score\\|LIFECYCLE`", "❌", reason, "0/0", "0"]);
  });
});

describe("renderMatrix — table safety", () => {
  it("pipes in a caseId or reason are escaped, and newlines flattened, so the row keeps five cells", () => {
    const md = renderMatrix(run([kase({ state: "red", reason: "error: ZodError: [\n  {\"path\": \"a|b\"}\n]" })]));
    const line = lineStarting(md, "| `league")!;
    expect(cells(line)).toHaveLength(5);
    expect(line).not.toContain("\n");
    expect(cells(line)[2]).toBe('error: ZodError: [ {"path": "a\\|b"} ]');
  });
  it("a case off the run's own grid is refused, never silently dropped from the grid", () => {
    expect(() => renderMatrix(run([kase({ caseId: "leauge|generic", row: "leauge" })]))).toThrow(/leauge/);
    expect(() => renderMatrix(run([kase({ caseId: "league|curling", sport: "curling" })]))).toThrow(/curling/);
  });
});

describe("renderMatrix — the grid is the run's own (T11 review M4)", () => {
  const small = { rows: ["knockout", "league"], sports: ["zeta", "generic"] };
  it("rows and columns follow results.grid in its own order, not the live catalogue", () => {
    const md = renderMatrix(run([kase({})], small));
    expect(cells(lineStarting(md, "| row |")!)).toEqual(["row", "zeta", "generic"]);
    const tableRows = md.split("\n").filter((l) => /^\| (knockout|league) \|/.test(l)).map((l) => cells(l));
    expect(tableRows).toEqual([["knockout", "░", "░"], ["league", "░", "✅"]]);
    // Nothing of the live catalogue leaks in: none of its other rows or sports.
    expect(md).not.toContain("| swiss |");
    expect(lineStarting(md, "| row |")).not.toContain("badminton");
  });
  it("a case on the live catalogue but off the run's grid is refused — the check reads the stored grid", () => {
    expect(() => renderMatrix(run([kase({ caseId: "league|badminton", sport: "badminton" })], small))).toThrow(/league\|badminton .*not on this run's own grid \(results\.grid\)/);
    expect(() => renderMatrix(run([kase({ caseId: "swiss|generic", row: "swiss" })], small))).toThrow(/swiss\|generic/);
  });
  it("a sport the live catalogue has never heard of renders when the run's grid has it", () => {
    const md = renderMatrix(run([kase({ caseId: "league|zeta", sport: "zeta", state: "red", reason: "x" })], small));
    expect(cells(lineStarting(md, "| league |")!)).toEqual(["league", "❌", "░"]);
  });
});
