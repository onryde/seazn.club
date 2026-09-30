import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { SEVERITY, renderMatrix, worstState } from "../lib/render-matrix.ts";
import { CASE_STATES, GLYPH, type CaseResult, type CaseResultV2, type RunResults, type RunResultsV2 } from "../lib/results.ts";

// The catalogue as a run snapshots it (run.ts): the tests below that expect the
// full 21 × 11 grid read it from here, the way a real results.json carries it.
const GRID = { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] };
const run = (cases: CaseResultV2[], grid: RunResultsV2["grid"] = GRID): RunResultsV2 => ({ schemaVersion: 2, runId: "r1", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", grid, cases });
const kase = (p: Partial<CaseResultV2>): CaseResultV2 => ({
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

// W1c Task 3 (D9): the renderer reads v3 as it reads v2. A ░ case alone is
// indistinguishable in the grid from an EMPTY cell (both read ░), so each
// glyph is witnessed beside a ✅ in the same cell — where only the case can
// have put it — and in the totals and the cases table.
describe("renderMatrix — v3 results, 🚫 and ░ (W1c Task 3)", () => {
  const small = { rows: ["league", "knockout"], sports: ["generic", "badminton"] };
  const run3 = (cases: CaseResult[], grid: RunResults["grid"] = small): RunResults => ({ schemaVersion: 3, runId: "r3", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", grid, layer: "L2", driver: "browser", cases });
  const kase3 = (p: Partial<CaseResult>): CaseResult => ({ ...kase({}), layer: "L2", driver: "browser", width: 320, ...p });
  const works = (row: string, sport: string) => kase3({ caseId: `${row}|${sport}|w`, row, sport });
  const noPath = kase3({ caseId: "league|generic|np", state: "no_path", reason: "W6: no bracket UI" });
  const notRun = kase3({ caseId: "knockout|badminton|nr", row: "knockout", sport: "badminton", state: "not_run", reason: "no scenario script yet (atom A1)" });

  it("empty case first: a v3 run with zero cases renders the banner, naming schema v3", () => {
    const md = renderMatrix(run3([]));
    expect(md).toContain("**No cases run.**");
    expect(md).toContain("schema v3");
    expect(md).not.toContain("| row |");
  });
  it("a v3 run with one 🚫 and one ░ case renders both glyphs in their cells, the totals and the cases table", () => {
    const md = renderMatrix(run3([works("league", "generic"), noPath, works("knockout", "badminton"), notRun]));
    expect(cells(lineStarting(md, "| league |")!)).toEqual(["league", GLYPH.no_path, "░"]);
    expect(cells(lineStarting(md, "| knockout |")!)).toEqual(["knockout", "░", GLYPH.not_run]);
    expect(md).toContain(`| ${GLYPH.no_path} no_path | 1 |`);
    expect(md).toContain(`| ${GLYPH.not_run} not_run | 1 |`);
    expect(md).toContain(`| ${GLYPH.works} works | 2 |`);
    expect(md).toContain("| total | 4 |");
    expect(cells(lineStarting(md, "| `league\\|generic\\|np`")!)).toEqual(["`league\\|generic\\|np`", "🚫", "W6: no bracket UI", "0/0", "0"]);
    expect(cells(lineStarting(md, "| `knockout\\|badminton\\|nr`")!)).toEqual(["`knockout\\|badminton\\|nr`", "░", "no scenario script yet (atom A1)", "0/0", "0"]);
  });
  it("a cell holding ✅ + 🚫 renders 🚫 (severity: no_path above works), whatever the case order", () => {
    for (const cases of [[works("league", "generic"), noPath], [noPath, works("league", "generic")]]) {
      expect(cells(lineStarting(renderMatrix(run3(cases)), "| league |")!)[1]).toBe("🚫");
    }
  });
  it("v2 and v3 holding the same cases render identically, bar the schema version and v3's layer line in the header", () => {
    const v3cases = [works("league", "generic"), noPath, notRun];
    const v2cases: CaseResultV2[] = v3cases.map(({ layer: _l, driver: _d, width: _w, ...c }) => c);
    const v3md = renderMatrix(run3(v3cases));
    const v2md = renderMatrix({ ...run(v2cases, small), runId: "r3" });
    expect(v3md).toContain("schema v3");
    expect(v2md).toContain("schema v2");
    const layerLine = "> Layer **L2** · driver **browser** · plan not recorded (written before results carried a plan).\n\n";
    expect(v3md).toContain(layerLine);
    expect(v3md.replace("schema v3", "schema v2").replace(layerLine, "")).toBe(v2md);
  });
});

// W1c Task 14 carry 5 (Task 3 review minor): MATRIX.md's header named only the
// schema version, so a reader could not tell an L1 browser run from an L3 HTTP
// one without opening results.json. A v3 header names the run's layer, its
// driver and — once recorded (carry 6) — the plan that produced it. v2
// evidence renders byte-for-byte as before (committed-matrix.test.ts pins it).
describe("renderMatrix — the header names the layer, driver and plan (W1c Task 14 carry 5)", () => {
  const small = { rows: ["league"], sports: ["generic"] };
  const v3 = (p: Partial<RunResults>): RunResults => ({ schemaVersion: 3, runId: "r3", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", grid: small, layer: "L3", driver: "http", cases: [], ...p });
  const line = (md: string) => lineStarting(md, "> Layer ");
  it("empty case first: a v3 run with zero cases still names them above the banner", () => {
    const md = renderMatrix(v3({ layer: "L1", driver: "browser", plan: "--layer L1" }));
    expect(line(md)).toBe("> Layer **L1** · driver **browser** · plan `--layer L1`.");
    expect(md.indexOf("> Layer ")).toBeLessThan(md.indexOf("**No cases run.**"));
  });
  it("each run names its own layer, driver and plan", () => {
    const k = { ...kase({}), layer: "L3" as const, driver: "http" as const, width: null };
    expect(line(renderMatrix(v3({ plan: "slice --only league|generic", cases: [k] })))).toBe("> Layer **L3** · driver **http** · plan `slice --only league|generic`.");
    expect(line(renderMatrix(v3({ layer: "L2", driver: "browser", plan: "--set width-sweep", cases: [{ ...k, layer: "L2", driver: "browser", width: 768 }] })))).toBe("> Layer **L2** · driver **browser** · plan `--set width-sweep`.");
  });
  it("a v3 run written before the plan was recorded says so, never a blank", () => {
    expect(line(renderMatrix(v3({})))).toBe("> Layer **L3** · driver **http** · plan not recorded (written before results carried a plan).");
  });
  it("v2 evidence carries no layer line", () => {
    expect(line(renderMatrix(run([kase({})])))).toBeUndefined();
    expect(line(renderMatrix(run([])))).toBeUndefined();
  });
});
