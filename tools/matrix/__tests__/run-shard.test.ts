// W1d Task 4 (D4): `--shard k/N` driven through the REAL runner — runSlice →
// execute → runItems → stripe → runCase / recordPlanned → writeResults — and
// the evidence read back from the results.json writeResults re-parsed (ruling
// T2-SEAM: `shard` is proven written by the producer, never by a fixture on
// both ends). The last tests fold the runner's OWN shard files through the
// real merge and compare the merge with an unsharded run of the same plan:
// the sharded and the unsharded evidence must say the same thing per case
// (ruling 61 compares per case across runs).
// Sport-agnostic on purpose (the stripe sees plan items, never a sport); the
// layered tests cover the two plan shapes that carry planned cases.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedGates } from "../lib/format-gates-copy.ts";
import { stagesForRow } from "../lib/catalogue.ts";
import { mergeShards, type ShardInput } from "../lib/merge.ts";
import { offlineVariantOrder } from "../lib/variants.ts";
import { parseResults, type RunResults } from "../lib/results.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { runSlice, type PlanCases, type RunDeps } from "../run.ts";
import { deps, fakeBrowserRun } from "./run-deps.ts";

afterEach(() => { vi.restoreAllMocks(); });

/** Everything runSlice prints, captured (and kept off the reporter). */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  return { out: () => out.join(""), err: () => err.join("") };
}

const dirFor = () => mkdtempSync(join(tmpdir(), "w1d-shard-"));
const resultsPath = (dir: string, runId: string) => join(dir, runId, "results.json");
/** The run's results.json, through the schema writeResults re-parsed it with. */
const runIn = (dir: string, runId: string): RunResults => parseResults(JSON.parse(readFileSync(resultsPath(dir, runId), "utf8"))) as RunResults;
const ids = (r: RunResults): string[] => r.cases.map((c) => c.caseId);

/** A five-item plan: five catalogue rows, one scenario each, so every id is distinct and in a known order.
 *  The third and fifth need a format gate (format-gates-copy.ts: double_elim, americano), so a plan that lacks
 *  a gate has its hole at plan index 2 or 4 — in the stripe of shard 1/2 and NOT in shard 2/2's. */
const FIVE_ROWS = ["league", "knockout", "double_elim", "swiss", "americano"] as const;
const FIVE = FIVE_ROWS.map((row) => `${row}|generic|score|LIFECYCLE`);
const fivePlan: PlanCases = () => ({
  sports: ["generic"], deniesFeatures: false,
  plan: (variantFor): CaseSpec[] => FIVE_ROWS.map((row) => ({ caseId: `${row}|generic|${variantFor("generic")}|LIFECYCLE`, row, sport: "generic", variant: variantFor("generic"), scenario: "LIFECYCLE", canary: false })),
});
const plainPlan = (n: number): PlanCases => (cli) => {
  const all = fivePlan(cli);
  return { ...all, plan: (v) => all.plan(v).slice(0, n) };
};

describe("--shard k/N: the stripe the runner runs, and the header it writes", () => {
  it("--shard 2/2 of a five-item plan runs items 1 and 3 (0-based) — and writes shard {index: 2, of: 2, planSize: 5} into the results.json writeResults re-parsed", async () => {
    capture();
    const dir = dirFor();
    const d = deps({ planCases: fivePlan });
    expect(await runSlice(d, ["--shard", "2/2", "--run-id", "sh2", "--report-dir", dir])).toBe(0);
    const r = runIn(dir, "sh2");
    expect(r.shard).toEqual({ index: 2, of: 2, planSize: 5 });
    expect(ids(r)).toEqual([FIVE[1], FIVE[3]]);
    // Only the stripe's cases cost an org (anti-vacuity: the unsharded run below costs five).
    expect(d.orgs).toHaveLength(2);
    // `plan` stays the command line's plan, WITHOUT the shard, so every shard of one run carries one plan string.
    expect(r.plan).toBe("slice");
    expect("shards" in r).toBe(false);
    // The stripe's case numbers are its own (1, 2): a shard run id names its orgs, and each shard has its own run id.
    expect(d.orgs.map((o) => o.name)).toEqual(["Matrix sh2 1", "Matrix sh2 2"]);
  });

  it("--shard 1/2 runs items 0, 2 and 4; and with no --shard the run has no shard header and runs all five (the empty case of the flag)", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps({ planCases: fivePlan }), ["--shard", "1/2", "--run-id", "sh1", "--report-dir", dir])).toBe(0);
    expect(ids(runIn(dir, "sh1"))).toEqual([FIVE[0], FIVE[2], FIVE[4]]);
    expect(runIn(dir, "sh1").shard).toEqual({ index: 1, of: 2, planSize: 5 });
    const whole = deps({ planCases: fivePlan });
    expect(await runSlice(whole, ["--run-id", "all", "--report-dir", dir])).toBe(0);
    const r = runIn(dir, "all");
    expect(ids(r)).toEqual(FIVE);
    expect(r.shard).toBeUndefined();
    expect("shard" in r).toBe(false);
    expect(whole.orgs).toHaveLength(5);
  });

  it("the shard's own console says how many it runs: [1/2] … [2/2], never [1/5]", async () => {
    const io = capture();
    const dir = dirFor();
    expect(await runSlice(deps({ planCases: fivePlan }), ["--shard", "2/2", "--run-id", "sh2", "--report-dir", dir])).toBe(0);
    expect(io.out()).toContain("[1/2] ");
    expect(io.out()).toContain("[2/2] ");
    expect(io.out()).not.toContain("/5]");
  });

  it("--shard 3/4 on a two-item plan is refused ShardEmpty: exit 2, the reason named, and nothing written", async () => {
    const io = capture();
    const dir = dirFor();
    const d = deps({ planCases: plainPlan(2) });
    expect(await runSlice(d, ["--shard", "3/4", "--run-id", "sh3", "--report-dir", dir])).toBe(2);
    expect(io.err()).toMatch(/ShardEmpty: shard 3\/4 of a plan of 2 items holds none — fewer items than shards/);
    expect(existsSync(resultsPath(dir, "sh3"))).toBe(false);
    expect(existsSync(join(dir, "sh3", "MATRIX.md"))).toBe(false);
    // …and the refusal is not an abort: it says "refused", and no case org was ever seeded.
    expect(io.err()).toMatch(/matrix: refused — ShardEmpty/);
    expect(d.orgs).toHaveLength(0);
    // The shards that DO hold items run: 1/4 and 2/4 of the same plan.
    for (const k of [1, 2]) expect(await runSlice(deps({ planCases: plainPlan(2) }), ["--shard", `${k}/4`, "--run-id", `ok${k}`, "--report-dir", dir])).toBe(0);
    expect(ids(runIn(dir, "ok1"))).toEqual([FIVE[0]]);
    expect(ids(runIn(dir, "ok2"))).toEqual([FIVE[1]]);
  });

  it("the empty plan: unsharded it is exit 1 (zero cases, results written); with --shard it is ShardEmpty (exit 2, nothing written) — a shard of nothing is never a shard", async () => {
    const io = capture();
    const dir = dirFor();
    expect(await runSlice(deps({ planCases: plainPlan(0) }), ["--run-id", "e0", "--report-dir", dir])).toBe(1);
    expect(existsSync(resultsPath(dir, "e0"))).toBe(true);
    expect(await runSlice(deps({ planCases: plainPlan(0) }), ["--shard", "1/2", "--run-id", "e1", "--report-dir", dir])).toBe(2);
    expect(io.err()).toMatch(/ShardEmpty: shard 1\/2 of a plan of 0 items holds none/);
    expect(existsSync(resultsPath(dir, "e1"))).toBe(false);
  });

  it("--shard with --canary is a usage refusal (exit 2) before anything touches the DB", async () => {
    const io = capture();
    const d = deps();
    expect(await runSlice(d, ["--shard", "1/2", "--canary", "M1", "--run-id", "x", "--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toMatch(/--shard.*--canary|--canary.*--shard/);
    expect(io.err()).toMatch(/usage: run\.ts/);
  });

  it.each(["0/2", "3/2", "1/1", "1/65", "a/2", "1/2/3", "", "01/2", "1/ 2"])("a bad --shard %j is a usage error: exit 2, BadShard's reason on stderr, nothing run", async (bad) => {
    const io = capture();
    const d = deps({ planCases: fivePlan });
    expect(await runSlice(d, ["--shard", bad, "--run-id", "x", "--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toMatch(/--shard .* is not k\/N with 1 ≤ k ≤ N and 2 ≤ N ≤ 64/);
    expect(io.err()).toMatch(/usage: run\.ts/);
  });

  it("a second call: --shard 1/2 twice under two run ids plans the same case ids (the partition does not depend on the run)", async () => {
    capture();
    const dir = dirFor();
    for (const id of ["again-a", "again-b"]) expect(await runSlice(deps({ planCases: fivePlan }), ["--shard", "1/2", "--run-id", id, "--report-dir", dir])).toBe(0);
    const a = runIn(dir, "again-a");
    const b = runIn(dir, "again-b");
    expect(ids(a)).toEqual([FIVE[0], FIVE[2], FIVE[4]]);
    expect(ids(b)).toEqual(ids(a));
    expect(b.shard).toEqual(a.shard);
  });

  it("the shards of one plan are the plan: --shard 1/3, 2/3, 3/3 interleave back to the five items, with no overlap", async () => {
    capture();
    const dir = dirFor();
    const parts: string[][] = [];
    for (const k of [1, 2, 3]) {
      expect(await runSlice(deps({ planCases: fivePlan }), ["--shard", `${k}/3`, "--run-id", `p${k}`, "--report-dir", dir])).toBe(0);
      parts.push(ids(runIn(dir, `p${k}`)));
    }
    expect(parts.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(new Set(parts.flat()).size).toBe(5);
    expect([parts[0][0], parts[1][0], parts[2][0], parts[0][1], parts[1][1]]).toEqual(FIVE);
  });

  it("the gate guards judge the WHOLE plan, in every shard: a plan lacking a gate refuses --shard 1/2 AND --shard 2/2 exactly as it refuses the unsharded run, though the gated rows sit in one stripe (a hole in one stripe must not let the others run for an hour first)", async () => {
    const io = capture();
    const dir = dirFor();
    // The premise, from the gate map itself: which of the five need a gate, and that shard 2/2's stripe (indices 1, 3) needs none.
    const gated = FIVE_ROWS.map((row) => expectedGates(stagesForRow(row)).length > 0);
    expect(gated).toEqual([false, false, true, false, true]);
    const lacking = (): RunDeps => {
      const d = deps({ planCases: fivePlan });
      return { ...d, openDb: async () => ({ ...(await d.openDb()), planGrants: async () => [] }) };
    };
    expect(await runSlice(lacking(), ["--run-id", "g0", "--report-dir", dir]), "the unsharded plan").toBe(2);
    let refusals = 0;
    for (const k of [1, 2]) {
      const d = lacking();
      expect(await runSlice(d, ["--shard", `${k}/2`, "--run-id", `g${k}`, "--report-dir", dir]), `shard ${k}/2`).toBe(2);
      expect(existsSync(resultsPath(dir, `g${k}`)), `shard ${k}/2 wrote nothing`).toBe(false);
      refusals++;
    }
    expect(refusals).toBe(2);
    expect((io.err().match(/PlanLacksGate/g) ?? []).length).toBe(3);
  });
});

/** Runs `argv` against the real runner and answers the shard dirs' evidence as the merge reads it. */
async function runShards(argvFor: (k: number) => string[], of: number, mk: () => RunDeps, tag: string): Promise<{ inputs: ShardInput[]; runs: RunResults[] }> {
  const dir = dirFor();
  const inputs: ShardInput[] = [];
  const runs: RunResults[] = [];
  for (let k = 1; k <= of; k++) {
    const code = await runSlice(mk(), [...argvFor(k), "--run-id", `${tag}-s${k}`, "--report-dir", dir]);
    // The runner's own exit code, as a shard writes it to exit.txt — never a literal "0".
    inputs.push({ name: `${tag}-s${k}`, exit: `${code}\n`, results: JSON.parse(readFileSync(resultsPath(dir, `${tag}-s${k}`), "utf8")) });
    runs.push(runIn(dir, `${tag}-s${k}`));
  }
  return { inputs, runs };
}
/** What a reader compares across runs, per case (ruling 61): not durations, and not a run's own timestamps. */
const stable = (r: RunResults) => r.cases.map((c) => ({ id: c.caseId, state: c.state, reason: c.reason, planned: c.planned, l2: c.l2, layer: c.layer, width: c.width, checks: c.checks.map((k) => [k.id, k.verdict, k.checked]) }));

describe("the seam, end to end: the runner's own shard files, folded through the real merge, equal the unsharded run (class 1: a fixture on both ends proves the fixture)", () => {
  it("a plain plan over HTTP: three shards merge to the five items, equal per case to the unsharded run", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps({ planCases: fivePlan }), ["--run-id", "whole", "--report-dir", dir])).toBe(0);
    const whole = runIn(dir, "whole");
    const { inputs, runs } = await runShards((k) => ["--shard", `${k}/3`], 3, () => deps({ planCases: fivePlan }), "plain");
    expect(runs.every((r) => r.shard?.of === 3 && r.shard.planSize === 5)).toBe(true);
    const { merged, checked } = mergeShards(inputs, "plain-merged");
    expect(checked).toBe(5);
    expect(merged.shards).toBe(3);
    expect(merged.shard).toBeUndefined();
    expect(stable(merged)).toEqual(stable(whole));
    // Anti-vacuity: the comparison saw five cases and more than one state or reason text is not required — but it saw ids.
    expect(stable(merged)).toHaveLength(5);
  });

  it("--layer L2 (the slice, browser; 🚫/░ planned cases among the driven): three shards merge equal per case to the unsharded run, planned markers and l2 runs kept, scope carried", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps({ openBrowserRun: async () => fakeBrowserRun().run }), ["--driver", "browser", "--layer", "L2", "--run-id", "l2whole", "--report-dir", dir])).toBe(0);
    const whole = runIn(dir, "l2whole");
    const { inputs, runs } = await runShards((k) => ["--driver", "browser", "--layer", "L2", "--shard", `${k}/3`], 3, () => deps({ openBrowserRun: async () => fakeBrowserRun().run }), "l2");
    expect(runs.map((r) => r.scope)).toEqual(["L2 (slice)", "L2 (slice)", "L2 (slice)"]);
    const { merged, checked } = mergeShards(inputs, "l2-merged");
    expect(checked).toBe(whole.cases.length);
    expect(merged.scope).toBe("L2 (slice)");
    expect(merged.layer).toBe("L2");
    expect(stable(merged)).toEqual(stable(whole));
    // The comparison covered both kinds of case: it would pass vacuously on a plan with no planned case.
    expect(merged.cases.filter((c) => c.planned === true).length).toBeGreaterThan(0);
    expect(merged.cases.filter((c) => c.planned === undefined).length).toBeGreaterThan(0);
    expect(merged.cases.every((c) => c.l2 !== undefined)).toBe(true);
  });

  it("--layer L1 --scope grid (231 cells, another scope and another layer): four shards merge equal per case to the unsharded run, the five uneven stripes sized by the rulebook", async () => {
    capture();
    const dir = dirFor();
    const live = (): RunDeps => {
      const d = deps({ openBrowserRun: async () => fakeBrowserRun().run });
      return { ...d, openDb: async () => ({ ...(await d.openDb()), variantKeysInBuilderOrder: async (s: string) => [...offlineVariantOrder(s)] }) };
    };
    const args = ["--driver", "browser", "--layer", "L1", "--scope", "grid"];
    expect(await runSlice(live(), [...args, "--run-id", "g1whole", "--report-dir", dir])).toBe(0);
    const whole = runIn(dir, "g1whole");
    expect(whole.cases).toHaveLength(231);
    const { inputs, runs } = await runShards((k) => [...args, "--shard", `${k}/4`], 4, live, "g1");
    // 231 = 4 x 57 + 3: shards 1..3 hold 58 and shard 4 holds 57 — written by hand from the plan size, not from stripeSize.
    expect(runs.map((r) => r.cases.length)).toEqual([58, 58, 58, 57]);
    const { merged } = mergeShards(inputs, "g1-merged");
    expect(merged.scope).toBe("L1 (grid)");
    expect(merged.shards).toBe(4);
    expect(stable(merged)).toEqual(stable(whole));
    expect(merged.cases.filter((c) => c.planned === true).length).toBeGreaterThan(0);
  }, 120_000);

  it("a shard that is missing from the runner's own set refuses the merge by name (the end-to-end hole)", async () => {
    capture();
    const { inputs } = await runShards((k) => ["--shard", `${k}/3`], 3, () => deps({ planCases: fivePlan }), "hole");
    expect(() => mergeShards([inputs[0], inputs[2]], "x")).toThrow(expect.objectContaining({ name: "ShardMissing" }));
    expect(() => mergeShards(inputs, "x")).not.toThrow();
  });
});
