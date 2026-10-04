// Final review I-1: the committed-evidence judge reads each run's FROZEN plan
// (plans.lock.json), never today's planners. The reviewer's two probes,
// reproduced as tomorrow's planners — one more scripted L2 atom (what W3 does
// when it scripts a swiss atom) and one more L1 cell (what W1d's full-grid L1
// does) — must leave the unchanged W1c evidence green. Each probe first shows
// it has teeth: judged against the live planner, the same evidence reds.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { parseResults } from "../lib/results.ts";
import { LOCK_PATH, REPO, TRUTH_RUNS, judgeRun, livePlan, noVariant, readLock, sweepCommitted, thawed } from "./committed-plans.ts";

const tomorrow = vi.hoisted(() => ({ atom: false, cell: false }));

// One more scripted atom: M2 (a walkover after round 1) mapped to the M1 script.
vi.mock("../lib/scenario-catalogue.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/scenario-catalogue.ts")>();
  const scripted = Object.freeze({ ...orig.HARNESS_SCENARIO, M2: "M1" as const });
  const mod: Record<string, unknown> = { ...orig };
  Object.defineProperty(mod, "HARNESS_SCENARIO", { enumerable: true, get: () => (tomorrow.atom ? scripted : orig.HARNESS_SCENARIO) });
  return mod;
});
// One more L1 cell: planL1 is the slice's cells × LIFECYCLE; the extra cell
// joins only that call (no --only, scenario LIFECYCLE), so no slice run moves.
vi.mock("../lib/slice.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/slice.ts")>();
  const planSliceCases: typeof orig.planSliceCases = (variantFor, filter = {}) => {
    const cases = orig.planSliceCases(variantFor, filter);
    if (!tomorrow.cell || filter.only !== undefined || filter.scenario !== "LIFECYCLE") return cases;
    const row = "groups_ko", sport = "badminton", variant = variantFor(sport);
    const extra: CaseSpec = { caseId: `${row}|${sport}|${variant}|LIFECYCLE`, row, sport, variant, scenario: "LIFECYCLE", canary: false };
    return [...cases, extra];
  };
  return { ...orig, planSliceCases };
});

afterEach(() => {
  tomorrow.atom = false;
  tomorrow.cell = false;
});

const casesOf = (dir: string) => parseResults(JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, dir, "results.json"), "utf8"))).cases;
/** The lock's own totals: what an honest sweep judges, whatever the planners say today. */
function lockTotals(): { runs: number; driven: number; planned: number } {
  const runs = Object.values(readLock().runs);
  return { runs: runs.length, driven: runs.reduce((n, e) => n + e.driven.length, 0), planned: runs.reduce((n, e) => n + Object.keys(e.planned).length, 0) };
}

describe("the committed evidence is judged against its frozen plans, not today's planners (final review I-1)", () => {
  it("today: the sweep is clean and judges exactly the lock's cases", () => {
    const r = sweepCommitted();
    expect(r.wrong).toEqual([]);
    expect({ runs: r.runs, driven: r.driven, planned: r.planned }).toEqual(lockTotals());
    expect(r.runs).toBeGreaterThan(0);
  });

  it("a run the lock does not hold, or holds under another plan, is refused by name — never judged live", () => {
    const lock = readLock();
    const { "w1c-l2": l2, ...rest } = lock.runs;
    expect(l2, "the probe's run is frozen").toBeDefined();
    expect(sweepCommitted({ ...lock, runs: rest }).wrong).toEqual([`w1c-l2: no frozen plan in ${LOCK_PATH}`]);
    const moved = { ...lock, runs: { ...lock.runs, "w1c-l2": { ...l2!, plan: "--layer L1" } } };
    expect(sweepCommitted(moved).wrong).toEqual([`w1c-l2: ran "--layer L2", frozen as "--layer L1"`]);
  });

  it("one more scripted L2 atom (M2 → the M1 script) reds w1c-l2 judged live, and leaves the frozen sweep green", () => {
    tomorrow.atom = true;
    // Teeth: tomorrow's planner drives an M2 run that w1c-l2 recorded as ░.
    const live = judgeRun(casesOf("w1c-l2"), livePlan("--layer L2")).wrong;
    expect(live.filter((w) => w.includes("the plan DRIVES this case")).length, live.join("\n")).toBeGreaterThan(0);
    const r = sweepCommitted();
    expect(r.wrong).toEqual([]);
    expect({ runs: r.runs, driven: r.driven, planned: r.planned }).toEqual(lockTotals());
  });

  it("one more planL1 cell reds each L1 run judged live, and leaves the frozen sweep green", () => {
    tomorrow.cell = true;
    const runs = ["w1c-l1/w1c-l1-r1", "w1c-l1/w1c-l1-r2", "w1c-l1/w1c-l1-r3"];
    for (const dir of runs) {
      // Teeth: tomorrow's L1 plans a cell the W1c run never held.
      expect(judgeRun(casesOf(dir), livePlan("--layer L1")).wrong, dir).toContain("groups_ko|badminton|LIFECYCLE@1280: planned by --layer L1, missing from the run");
    }
    const r = sweepCommitted();
    expect(r.wrong).toEqual([]);
    expect({ runs: r.runs, driven: r.driven, planned: r.planned }).toEqual(lockTotals());
  });
});

// W1d item 3: recordPlanned writes `planned: true`, and the judge takes the
// marker as a SECOND witness beside I-2's `durationMs === 0` shape — never a
// replacement, so committed evidence (no marker) is judged exactly as before.
// The runs are built from w1c-l2 (3 driven, 65 planned, layered): the lock is
// the plan, the committed run is the shape, and the marker is added the way
// recordPlanned would write it.
describe("the planned marker is a second witness beside I-2's shape (W1d item 3)", () => {
  const entry = readLock().runs["w1c-l2"]!;
  const plan = thawed(entry);
  const committed = casesOf("w1c-l2");
  const isPlanned = (c: { caseId: string }) => Object.hasOwn(entry.planned, noVariant(c.caseId));
  /** The run as recordPlanned would have written it: every lock-planned case marked. */
  const marked = () => committed.map((c) => (isPlanned(c) ? { ...c, planned: true as const } : c));
  const driven = () => committed.filter((c) => !isPlanned(c));

  it("old evidence (no marker anywhere) is judged as before: 3 driven, 65 planned, nothing wrong", () => {
    expect(committed.some((c) => (c as { planned?: unknown }).planned !== undefined)).toBe(false);
    expect(judgeRun(committed, plan)).toEqual({ driven: 3, planned: 65, wrong: [] });
    expect(judgeRun(committed, plan).driven).toBe(entry.driven.length);
    expect(judgeRun(committed, plan).planned).toBe(Object.keys(entry.planned).length);
  });

  it("a fully marked run (every lock-planned case planned: true, 0 ms, no check) is clean, and carries exactly the lock's planned count of markers", () => {
    const run = marked();
    expect(run.filter((c) => (c as { planned?: unknown }).planned === true)).toHaveLength(Object.keys(entry.planned).length);
    expect(judgeRun(run, plan)).toEqual({ driven: 3, planned: 65, wrong: [] });
  });

  it("a marked run where one lock-planned case LACKS planned: true is wrong, naming that case and no other", () => {
    const run = marked();
    const i = run.findIndex(isPlanned);
    const lacking = run[i]!;
    run[i] = (({ planned: _p, ...rest }) => rest)(lacking as typeof lacking & { planned?: true }) as typeof lacking;
    const r = judgeRun(run, plan);
    expect(r.wrong).toHaveLength(1);
    expect(r.wrong[0]).toContain(`${lacking.caseId}: the plan records it planned, stored without the planned shape`);
    expect(r.wrong[0]).toContain("planned=undefined");
    // The same run before the marker existed is clean: this is the marker's own witness, not I-2's.
    expect(judgeRun(committed, plan).wrong).toEqual([]);
  });

  it("a marked planned case that kept time is wrong too (planned: true, but 12 ms)", () => {
    const run = marked();
    const i = run.findIndex(isPlanned);
    run[i] = { ...run[i]!, durationMs: 12 };
    const r = judgeRun(run, plan);
    expect(r.wrong).toHaveLength(1);
    expect(r.wrong[0]).toContain(`${run[i]!.caseId}: the plan records it planned, stored without the planned shape (planned=true, 12 ms, 0 check(s))`);
  });

  it("a marked planned case that kept a check is wrong too (planned: true, 0 ms, but 1 check)", () => {
    const run = marked();
    const i = run.findIndex(isPlanned);
    run[i] = { ...run[i]!, checks: [{ id: "x", kind: "assertion", verdict: "pass", checked: 1, reason: "", evidence: [] }] };
    const r = judgeRun(run, plan);
    expect(r.wrong.filter((w) => w.includes("without the planned shape"))).toEqual([`${run[i]!.caseId}: the plan records it planned, stored without the planned shape (planned=true, 0 ms, 1 check(s))`]);
  });

  it("a lock-DRIVEN case carrying planned: true with time and checks (a driven result relabelled) is wrong — I-2's shape alone passes it", () => {
    const d = driven();
    expect(d).toHaveLength(3);
    const victim = d[0]!;
    // The shape that slips past I-2: a real, timed, checked, counted driven result.
    expect(victim.durationMs).toBeGreaterThan(0);
    expect(victim.checks.length).toBeGreaterThan(0);
    const relabelled = marked().map((c) => (c.caseId === victim.caseId ? { ...c, planned: true as const } : c));
    const r = judgeRun(relabelled, plan);
    expect(r.wrong).toHaveLength(1);
    expect(r.wrong[0]).toContain(`${victim.caseId}: the plan DRIVES this case, stored with planned: true`);
    // Teeth: without the marker the very same case is clean, so the old heuristic never saw it.
    expect(judgeRun(marked(), plan).wrong).toEqual([]);
  });

  it("the same relabel on another layer's frozen plan is caught too (w1c-l1: all driven, no planned case to mark)", () => {
    const l1 = readLock().runs["w1c-l1/w1c-l1-r1"]!;
    const cases = casesOf("w1c-l1/w1c-l1-r1");
    expect(l1.driven.length).toBe(cases.length);
    expect(Object.keys(l1.planned)).toHaveLength(0);
    const relabelled = cases.map((c, i) => (i === 0 ? { ...c, planned: true as const } : c));
    const r = judgeRun(relabelled, thawed(l1));
    expect(r.wrong).toHaveLength(1);
    expect(r.wrong[0]).toContain("the plan DRIVES this case, stored with planned: true");
  });
});
