// W1d Task 8 (D4; class 20 — derived budgets; review C2; rulings T4-CLAMP, CLI-TABLES): the CI job matrix.
// The workflow must not carry logic it cannot test, so the shard counts, each job's `--shard k/N` argument string and
// its timeout come from ci/shard-matrix.ts and ci/shards.json, and the YAML only calls them. Expected values here come
// from the brief (the rulebook: 12 jobs, 18 + driven × ceiling ÷ workers ÷ 60 + 10), from hand arithmetic, and from the
// REAL runner's own evidence (the seam tests) — never from shardMatrix itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHARD_REFUSALS, ShardRefused, ceilingFromRuns, ceilingsOf, loadShardsConfig, main, planOfArgs, shardMatrix, type Job, type ShardsConfig,
} from "../ci/shard-matrix.ts";
import { drivenInPlanOrder, livePlan } from "../lib/expected-plan.ts";
import { mergeShards, type ShardInput } from "../lib/merge.ts";
import { matchPlanIds } from "../lib/judge.ts";
import { LAYERS, parseResults, type Layer, type RunResults } from "../lib/results.ts";
import { slugRunId } from "../lib/run-id.ts";
import { offlineVariantOrder } from "../lib/variants.ts";
import { runSlice, type RunDeps } from "../run.ts";
import { deps, fakeBrowserRun } from "./run-deps.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TR = join(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

const flags = (n: number, driven = n): boolean[] => Array.from({ length: n }, (_, i) => i < driven);
/** The per-case ceilings the brief derives from the committed evidence: 210 s, 30 s, 30 s. */
const C: Record<Layer, number> = { L1: 210, L2: 30, L3: 30 };
/** The plan sizes of the full scope, with their driven counts, as the brief states them. */
const FULL = { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) };
const cfg: ShardsConfig = loadShardsConfig();
/** One scratch root for every temp directory below, removed once at the end (a hook inside an `it` is not a cleanup). */
const SCRATCH = mkdtempSync(join(tmpdir(), "w1d-shardmx-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const scratchDir = (name: string): string => { const d = mkdtempSync(join(SCRATCH, `${name}-`)); return d; };
const withShards = (layer: Layer, scope: "full" | "smoke", shards: number): ShardsConfig => ({ ...cfg, layers: { ...cfg.layers, [layer]: { ...cfg.layers[layer], [scope]: { ...cfg.layers[layer][scope], shards } } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the edits below break the schema on purpose, so the config is untyped there
type Loose = Record<string, any>;
const refusal = (fn: () => unknown): ShardRefused => {
  try { fn(); } catch (e) { if (e instanceof ShardRefused) return e; throw e; }
  throw new Error("expected a ShardRefused, nothing was thrown");
};

describe("shardMatrix (D4; class 20 — derived budgets; review C2)", () => {
  it("the full scope is 12 jobs (L1 8 + L2 2 + L3 2), each timed by the driven items of its own stripe", () => {
    const m = shardMatrix(cfg, "full", FULL, C);
    expect(m.include).toHaveLength(12);
    expect(m.include.every((j) => j.timeout <= cfg.maxTimeoutMinutes && j.timeout < 360)).toBe(true);
    expect(m.include.map((j) => j.layer)).toEqual([...Array(8).fill("L1"), ...Array(2).fill("L2"), ...Array(2).fill("L3")]);
  });

  it("the stripe with the most driven items sets the larger budget", () => {
    // items 0..5, driven at 0,2,4,5 → stripe 1 (0,2,4) drives 3, stripe 2 (1,3,5) drives 1. (Contiguous blocks would give 2 and 2.)
    const plan = [true, false, true, false, true, true];
    const m = shardMatrix(withShards("L2", "smoke", 2), "smoke", { L1: flags(6), L2: plan, L3: flags(33) }, { L1: 210, L2: 600, L3: 30 });
    const [s1, s2] = m.include.filter((j) => j.layer === "L2");
    expect(s1.timeout).toBe(cfg.setupMinutes + Math.ceil((3 * 600) / 60) + cfg.slackMinutes);
    expect(s2.timeout).toBe(cfg.setupMinutes + Math.ceil((1 * 600) / 60) + cfg.slackMinutes);
    // By hand: 18 + 30 + 10 and 18 + 10 + 10 — the brief's constants, not cfg's.
    expect([s1.timeout, s2.timeout]).toEqual([58, 38]);
  });

  it("planned cases cost nothing: L2's 1,731-item grid with 62 driven fits, where counting planned items would not", () => {
    const m = shardMatrix(cfg, "full", FULL, C);
    for (const j of m.include.filter((x) => x.layer === "L2")) expect(j.timeout).toBeLessThan(60);
    expect(cfg.setupMinutes + Math.ceil((Math.ceil(1731 / 2) * 30) / 60) + cfg.slackMinutes).toBeGreaterThan(cfg.maxTimeoutMinutes); // the wrong count would refuse
    // The same grid with every item driven IS refused: the budget follows the driven count, not the plan size.
    expect(() => shardMatrix(cfg, "full", { ...FULL, L2: flags(1731) }, C)).toThrow(/exceeds/);
  });

  it("job ids are lowercase, unique, and already their own run-id slug (review C1)", () => {
    const m = shardMatrix(cfg, "full", FULL, C);
    const ids = m.include.map((j) => j.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBe(id.toLowerCase());
      expect(slugRunId(`ci-12345678901-2-${id}`)).toBe(`ci-12345678901-2-${id}`);
    }
    expect(ids.slice(0, 3)).toEqual(["l1-s1", "l1-s2", "l1-s3"]);
  });

  it("shard labels are k/N with every k once per layer, and args end with that shard", () => {
    const m = shardMatrix(cfg, "full", FULL, C);
    const l1 = m.include.filter((j) => j.layer === "L1");
    expect(l1.map((j) => `${j.k}/${j.of}`)).toEqual(["1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "8/8"]);
    expect(l1.every((j) => j.args.endsWith(`--shard ${j.k}/8`))).toBe(true);
    // The exact argument strings: the layer's own args, --workers only above 1, --shard last (brief).
    expect(l1[0].args).toBe("--driver browser --layer L1 --scope grid --shard 1/8");
    expect(m.include.find((j) => j.layer === "L2" && j.k === 2)!.args).toBe("--driver browser --layer L2 --scope grid --shard 2/2");
    expect(m.include.filter((j) => j.layer === "L3").map((j) => j.args)).toEqual(["--set w1-driving --workers 4 --shard 1/2", "--set w1-driving --workers 4 --shard 2/2"]);
  });

  it("pr-sample is ONE L3 job with no --shard, budgeted for two passes, and its rows travel in args", () => {
    const m = shardMatrix(cfg, "pr-sample", { L3: flags(40) }, C, "league,swiss");
    expect(m.include).toEqual([expect.objectContaining({ layer: "L3", id: "l3-sample", k: 1, of: 1, args: "--set pr-sample --rows league,swiss --workers 4",
      timeout: cfg.setupMinutes + Math.ceil((40 * 30 * 2) / 4 / 60) + cfg.slackMinutes })]);
    // By hand: 18 + ceil(2400 / 4 / 60 = 10) + 10 = 38 — and ONE pass would be 33, which is what a dropped `passes` gives.
    expect(m.include[0].timeout).toBe(38);
    expect(m.include).toHaveLength(1);
    expect(slugRunId("ci-12345678901-2-l3-sample")).toBe("ci-12345678901-2-l3-sample");
  });

  it("a timeout over the cap is refused at plan time (moving the ceiling moves the budget)", () => {
    expect(() => shardMatrix(cfg, "full", FULL, { ...C, L1: 5000 })).toThrow(/ShardTimeoutTooLong|exceeds/);
    const e = refusal(() => shardMatrix(cfg, "full", FULL, { ...C, L1: 5000 }));
    expect(e.name).toBe("ShardTimeoutTooLong");
    // It names the job, so the operator reads which shard to re-split.
    expect(e.message).toMatch(/L1 shard 1\/8/);
    expect(e.message).toContain(String(cfg.maxTimeoutMinutes));
    // …and a smaller ceiling is what lets the same plan through: the budget is the ceiling's, not a flat number.
    expect(() => shardMatrix(cfg, "full", FULL, { ...C, L1: 210 })).not.toThrow();
  });

  it("the cap is inclusive: a job AT maxTimeoutMinutes plans, one minute over is refused", () => {
    const one = { L1: flags(6), L2: flags(2), L3: flags(33) };
    // L2 smoke, 2 stripes of 1 driven item each: 18 + ceil(C / 60) + 10. C = 16,320 s is 272 min → exactly 300.
    const at = shardMatrix(cfg, "smoke", one, { ...C, L2: 16_320 }).include.filter((j) => j.layer === "L2");
    expect(at.map((j) => j.timeout)).toEqual([300, 300]);
    expect(refusal(() => shardMatrix(cfg, "smoke", one, { ...C, L2: 16_321 })).name).toBe("ShardTimeoutTooLong");
  });

  it("the empty case: zero planned, or zero driven, in a layer is refused (vacuous)", () => {
    expect(() => shardMatrix(cfg, "full", { ...FULL, L1: [] }, C)).toThrow(/L1: zero planned items/);
    expect(() => shardMatrix(cfg, "full", { ...FULL, L1: flags(231, 0) }, C)).toThrow(/L1: zero driven items in 231 planned/);
    // A layer with no plan at all is the same refusal as an empty one — never skipped (a smoke scope with no L2 job is not a smaller smoke).
    expect(() => shardMatrix(cfg, "full", { L1: FULL.L1, L3: FULL.L3 }, C)).toThrow(/L2: zero/);
    expect(() => shardMatrix(cfg, "smoke", { L1: flags(6), L2: flags(68, 3) }, C)).toThrow(/L3: zero/);
    expect(refusal(() => shardMatrix(cfg, "full", { ...FULL, L3: [] }, C)).name).toBe("ShardPlanVacuous");
    // Each layer is judged on its own: all three empty is refused at the first.
    expect(() => shardMatrix(cfg, "full", {}, C)).toThrow(/L1: zero/);
  });

  // Ruling T4-CLAMP: run.ts exits 2 ShardEmpty on an empty stripe, AFTER its sign-in, so a job scheduled for one reds
  // CI on a harmless empty shard. N is clamped to the plan size, so every scheduled stripe holds an item.
  it("T4-CLAMP: N greater than the plan size is clamped to it — no job is scheduled for a stripe with no item", () => {
    const plan = [true, false, true, false, false]; // 5 items, items 0 and 2 driven
    const m = shardMatrix(withShards("L2", "smoke", 8), "smoke", { L1: flags(6), L2: plan, L3: flags(33) }, C);
    const l2 = m.include.filter((j) => j.layer === "L2");
    expect(l2.map((j) => `${j.k}/${j.of}`)).toEqual(["1/5", "2/5", "3/5", "4/5", "5/5"]);
    expect(l2.every((j) => j.args.endsWith(`--shard ${j.k}/5`))).toBe(true);
    // Five items over five stripes hold ONE item each (by hand): stripes 1 and 3 hold the driven items.
    expect(l2.map((j) => j.timeout)).toEqual([18 + 1 + 10, 18 + 0 + 10, 18 + 1 + 10, 18 + 0 + 10, 18 + 0 + 10]);
    // The other layers keep their configured counts (they hold more items than shards).
    expect(m.include.filter((j) => j.layer === "L1").map((j) => j.of)).toEqual([2, 2]);
    // Anti-vacuity: the unclamped config WOULD have asked for 8.
    expect(withShards("L2", "smoke", 8).layers.L2.smoke.shards).toBe(8);
  });

  it("T4-CLAMP: N equal to the plan size is not clamped, and N below it is untouched", () => {
    const eq = shardMatrix(cfg, "smoke", { L1: flags(2), L2: flags(68, 3), L3: flags(33) }, C).include.filter((j) => j.layer === "L1");
    expect(eq.map((j) => `${j.k}/${j.of}`)).toEqual(["1/2", "2/2"]);
    const wide = shardMatrix(withShards("L1", "smoke", 3), "smoke", { L1: flags(7), L2: flags(68, 3), L3: flags(33) }, C).include.filter((j) => j.layer === "L1");
    expect(wide.map((j) => `${j.k}/${j.of}`)).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("T4-CLAMP: a plan of one item cannot be striped at all (run.ts takes no --shard 1/1, and the merge needs a shard header): refused by name", () => {
    const e = refusal(() => shardMatrix(cfg, "smoke", { L1: flags(1), L2: flags(68, 3), L3: flags(33) }, C));
    expect(e.name).toBe("ShardPlanTooSmall");
    expect(e.message).toMatch(/L1/);
    expect(e.message).toMatch(/1 item/);
  });

  it("a stripe with items but nothing driven is allowed (the smoke L2 slice drives 3 of 68); it costs its setup", () => {
    const m = shardMatrix(cfg, "smoke", { L1: flags(6), L2: [false, false, false, true], L3: flags(33) }, C);
    // items 0,2 (stripe 1): none driven; items 1,3 (stripe 2): item 3 driven.
    expect(m.include.filter((j) => j.layer === "L2").map((j) => j.timeout)).toEqual([cfg.setupMinutes + cfg.slackMinutes, cfg.setupMinutes + 1 + cfg.slackMinutes]);
    expect(m.include.filter((j) => j.layer === "L2").map((j) => j.timeout)).toEqual([28, 29]);
  });

  it("a ceiling that is not a positive finite number is refused: a zero or NaN budget would be a vacuous one", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = refusal(() => shardMatrix(cfg, "full", FULL, { ...C, L2: bad }));
      expect(e.name, String(bad)).toBe("BadCeiling");
      expect(e.message).toMatch(/L2/);
    }
    // pr-sample reads only L3's ceiling: a bad L1 one is not its business.
    expect(() => shardMatrix(cfg, "pr-sample", { L3: flags(40) }, { ...C, L1: 0 }, "none")).not.toThrow();
    expect(refusal(() => shardMatrix(cfg, "pr-sample", { L3: flags(40) }, { ...C, L3: 0 }, "none")).name).toBe("BadCeiling");
  });

  it("pr-sample: it needs the rows a PR declared; a row the catalogue lacks is refused by name; the rows are in their canonical spelling", () => {
    const plans = { L3: flags(40) };
    expect(refusal(() => shardMatrix(cfg, "pr-sample", plans, C)).name).toBe("PrSampleNeedsRows");
    expect(refusal(() => shardMatrix(cfg, "pr-sample", plans, C, "")).name).toBe("PrSampleNeedsRows");
    expect(() => shardMatrix(cfg, "pr-sample", plans, C, "leage")).toThrow(/leage/);
    // The one spelling run.ts records (sorted, none and all written out) — so the plan string run.ts writes is the one the judge reads.
    expect(shardMatrix(cfg, "pr-sample", plans, C, "swiss,league").include[0].args).toBe("--set pr-sample --rows league,swiss --workers 4");
    expect(shardMatrix(cfg, "pr-sample", plans, C, "none").include[0].args).toBe("--set pr-sample --rows none --workers 4");
    expect(shardMatrix(cfg, "pr-sample", plans, C, "all").include[0].args).toBe("--set pr-sample --rows all --workers 4");
    // The other scopes plan their own rows: a --rows beside them is ignored, never an error.
    expect(shardMatrix(cfg, "full", FULL, C, "none").include).toHaveLength(12);
  });

  it("pr-sample is L3 only: the other layers' plans, if handed over, make no job; and its own plan is judged (zero is refused)", () => {
    const m = shardMatrix(cfg, "pr-sample", { L1: flags(231, 178), L2: flags(1731, 62), L3: flags(40) }, C, "none");
    expect(m.include.map((j) => j.layer)).toEqual(["L3"]);
    expect(refusal(() => shardMatrix(cfg, "pr-sample", { L1: flags(5) }, C, "none")).name).toBe("ShardPlanVacuous");
    expect(() => shardMatrix(cfg, "pr-sample", { L3: flags(40, 0) }, C, "none")).toThrow(/zero driven/);
  });

  it("an unknown scope is refused", () => {
    expect(() => shardMatrix(cfg, "nightly" as never, FULL, C)).toThrow(/unknown scope "nightly"/);
  });

  it("a second call: shardMatrix is pure — twice over the same frozen inputs gives equal jobs, and mutates nothing it was handed", () => {
    const freeze = <T extends object>(o: T): T => { Object.values(o).forEach((v) => { if (v !== null && typeof v === "object") freeze(v); }); return Object.freeze(o); };
    const frozenCfg = freeze(structuredClone(cfg));
    const plans = freeze({ L1: flags(231, 178), L2: flags(1731, 62), L3: flags(937) });
    const ceilings = freeze({ ...C });
    const first = shardMatrix(frozenCfg, "full", plans, ceilings);
    const second = shardMatrix(frozenCfg, "full", plans, ceilings);
    expect(second).toEqual(first);
    expect(first.include).toHaveLength(12);
    // …and one call's jobs are not the next call's: a run of another scope in between changes nothing.
    shardMatrix(frozenCfg, "smoke", { L1: flags(6), L2: flags(68, 3), L3: flags(33) }, ceilings);
    expect(shardMatrix(frozenCfg, "full", plans, ceilings)).toEqual(first);
  });

  it("the smoke scope is 6 jobs, 2 per layer, each over its own plan (the self-proof's N > 1)", () => {
    const m = shardMatrix(cfg, "smoke", { L1: flags(6), L2: flags(68, 3), L3: flags(33) }, C);
    expect(m.include.map((j) => `${j.layer} ${j.k}/${j.of}`)).toEqual(["L1 1/2", "L1 2/2", "L2 1/2", "L2 2/2", "L3 1/2", "L3 2/2"]);
    // L3's smoke plan is the pr-sample set with no rows, run on 4 workers.
    expect(m.include.filter((j) => j.layer === "L3").map((j) => j.args)).toEqual(["--set pr-sample --rows none --workers 4 --shard 1/2", "--set pr-sample --rows none --workers 4 --shard 2/2"]);
  });

  it("workers divide the budget, per layer: the same driven count costs a quarter of the minutes on 4 workers", () => {
    const m = shardMatrix(cfg, "smoke", { L1: flags(6), L2: flags(6), L3: flags(6) }, { L1: 600, L2: 600, L3: 600 });
    const l1 = m.include.find((j) => j.layer === "L1")!; // 1 worker, 3 driven in stripe 1: ceil(3 * 600 / 60) = 30
    const l3 = m.include.find((j) => j.layer === "L3")!; // 4 workers, 3 driven: ceil(3 * 600 / 4 / 60) = 8
    expect([l1.timeout, l3.timeout]).toEqual([18 + 30 + 10, 18 + 8 + 10]);
  });
});

describe("shards.json (the committed config, D4)", () => {
  it("holds the brief's numbers: 8/2/2 shards for the full scope, 2/2/2 for the smoke, 18 + driven + 10 minutes, capped at 300", () => {
    expect(LAYERS.map((l) => cfg.layers[l].full.shards)).toEqual([8, 2, 2]);
    expect(LAYERS.map((l) => cfg.layers[l].smoke.shards)).toEqual([2, 2, 2]);
    expect(LAYERS.map((l) => cfg.layers[l].full.workers)).toEqual([1, 1, 4]);
    expect(LAYERS.map((l) => cfg.layers[l].smoke.workers)).toEqual([1, 1, 4]);
    expect([cfg.setupMinutes, cfg.slackMinutes, cfg.maxTimeoutMinutes]).toEqual([18, 10, 300]);
    expect(cfg.prSample).toEqual({ args: "--set pr-sample", workers: 4, passes: 2 });
    expect(cfg.maxTimeoutMinutes).toBeLessThan(360);
    expect(cfg.layers.L1.ceilingFrom).toHaveLength(6);
  });

  it("every args string is a plan the planners know, in the plan string run.ts records for it (planOfArgs)", () => {
    const want: Record<string, string> = {
      "--driver browser --layer L1 --scope grid": "--layer L1 --scope grid",
      "--driver browser --layer L1 --scope slice": "--layer L1",
      "--driver browser --layer L2 --scope grid": "--layer L2 --scope grid",
      "--driver browser --layer L2 --scope slice": "--layer L2",
      "--set w1-driving": "--set w1-driving",
      "--set pr-sample --rows none": "--set pr-sample --rows none",
      "--set pr-sample --rows swiss,league": "--set pr-sample --rows league,swiss",
    };
    let checked = 0;
    for (const [args, plan] of Object.entries(want)) {
      expect(planOfArgs(args), args).toBe(plan);
      expect(drivenInPlanOrder(plan).length, plan).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(7);
    // …and every args string the config itself carries is one of them.
    const own = [...LAYERS.flatMap((l) => [cfg.layers[l].full.args, cfg.layers[l].smoke.args])];
    expect(own).toHaveLength(6);
    for (const a of own) expect(Object.keys(want), a).toContain(a);
  });

  it("planOfArgs refuses what it cannot plan: an unknown flag, a --shard or --workers in the config, a repeated flag, a flag on the wrong plan, a layer or scope it does not know", () => {
    let checked = 0;
    for (const bad of ["--driver browser --layer L1 --scope grid --shard 1/2", "--set w1-driving --workers 4", "--bogus 1", "--driver browser --layer L9", "--driver browser --layer L1 --scope all", "--layer L1 --set w1-driving", "", "--driver browser --layer L1 --layer L2", "--set w1-driving --scope grid", "--set w1-driving --rows none", "--layer L1 --rows none", "--set pr-sample", "--driver ftp --layer L1", "--layer"]) {
      expect(refusal(() => planOfArgs(bad)).name, bad).toBe("ShardsArgsUnplannable");
      checked++;
    }
    expect(checked).toBe(14);
  });

  it("loadShardsConfig refuses what it cannot trust: a missing file, bad JSON, an unknown key, a shard count under 2, a ceiling path that escapes", () => {
    const dir = scratchDir("cfg");
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ci", "shards.json"), "utf8");
    const put = (name: string, body: string): string => { const f = join(dir, name); writeFileSync(f, body); return f; };
    const edit = (f: (c: Loose) => void): string => { const c = JSON.parse(text) as Loose; f(c); return put(`c${Math.random().toString(36).slice(2)}.json`, JSON.stringify(c)); };
    expect(refusal(() => loadShardsConfig(join(dir, "absent.json"))).name).toBe("ShardsFileInvalid");
    expect(refusal(() => loadShardsConfig(put("bad.json", "{ not json"))).name).toBe("ShardsFileInvalid");
    expect(refusal(() => loadShardsConfig(edit((c) => { c.extra = 1; }))).message).toMatch(/extra/);
    // N = 1 is no stripe: run.ts refuses `--shard 1/1`, and the merge reads the shard header only a shard has.
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L1.full.shards = 1; }))).message).toMatch(/layers\.L1\.full\.shards/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L2.smoke.shards = 65; }))).message).toMatch(/layers\.L2\.smoke\.shards/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.maxTimeoutMinutes = 360; }))).message).toMatch(/maxTimeoutMinutes/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L3.ceilingFrom = []; }))).message).toMatch(/ceilingFrom/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L3.ceilingFrom = ["../../etc"]; }))).message).toMatch(/ceilingFrom/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L3.ceilingFrom = ["/abs/dir"]; }))).message).toMatch(/ceilingFrom/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.layers.L1.full.args = "--driver browser --layer L1 --shard 1/2"; }))).message).toMatch(/args/);
    expect(refusal(() => loadShardsConfig(edit((c) => { c.prSample.passes = 0; }))).message).toMatch(/passes/);
    expect(refusal(() => loadShardsConfig(edit((c) => { delete c.layers.L2; }))).message).toMatch(/L2/);
    // The committed file itself loads.
    expect(loadShardsConfig().layers.L1.full.shards).toBe(8);
  });
});

/** A results.json of one layer holding the given durations, in the strict shape parseResults reads. */
function evidence(durations: readonly number[], layer: Layer = "L1"): unknown {
  return {
    schemaVersion: 3, runId: "r", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", grid: { rows: ["league"], sports: ["generic"] }, layer, driver: "http",
    cases: durations.map((durationMs, i) => ({ caseId: `league|generic|score|X${i}`, row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, state: "works", reason: "", checks: [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs, notes: [], layer, driver: "http", width: null })),
  };
}

describe("ceilings: the per-case budget a layer derives from committed evidence (D4)", () => {
  const root = scratchDir("ceil");
  const put = (dir: string, body: unknown): void => { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, "results.json"), typeof body === "string" ? body : JSON.stringify(body)); };

  it("the rule: the max durationMs, rounded UP to 10 s, times 1.5 — each step on its own boundary", () => {
    // [ms, expected seconds]. 132,684 ms is the brief's L1 maximum: 132.7 s -> 140 s -> 210 s.
    const rows: [number, number][] = [[132_684, 210], [17_002, 30], [13_530, 30], [10_000, 15], [10_001, 30], [1, 15], [20_000, 30], [140_000, 210], [140_001, 225]];
    let checked = 0;
    for (const [ms, want] of rows) {
      put("a", evidence([0, ms, 5]));
      expect(ceilingFromRuns(["a"], root), `${ms} ms`).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("the max across the named runs: not the first, not the last, not the mean — and the order of the list does not matter", () => {
    put("r1", evidence([5_000, 9_000]));
    put("r2", evidence([135_000, 1_000]));
    put("r3", evidence([60_000]));
    expect(ceilingFromRuns(["r1", "r2", "r3"], root)).toBe(210);
    expect(ceilingFromRuns(["r3", "r2", "r1"], root)).toBe(210);
    expect(ceilingFromRuns(["r2", "r1", "r3"], root)).toBe(210);
    expect(ceilingFromRuns(["r1", "r3"], root)).toBe(90); // 60 s -> 60 s -> 90 s
    expect(ceilingFromRuns(["r1"], root)).toBe(15);
  });

  it("a listed directory with no results.json is refused BY NAME, so a moved directory reds the plan step, never the shard (review I6)", () => {
    mkdirSync(join(root, "no-results"), { recursive: true });
    mkdirSync(join(root, "parent", "child"), { recursive: true });
    writeFileSync(join(root, "parent", "child", "results.json"), JSON.stringify(evidence([1000])));
    for (const dir of ["no-results", "absent-entirely", "parent"]) {
      const e = refusal(() => ceilingFromRuns(["r1", dir], root));
      expect(e.name, dir).toBe("CeilingUnreadable");
      expect(e.message, dir).toContain(dir);
      expect(e.message, dir).toContain("results.json");
    }
  });

  it("evidence it cannot read is refused by name: not JSON, a schema it does not know, an empty list, and a run that timed no case", () => {
    put("not-json", "{ nope");
    put("not-a-run", { schemaVersion: 3 });
    put("no-cases", evidence([]));
    put("all-zero", evidence([0, 0, 0]));
    for (const dir of ["not-json", "not-a-run", "no-cases", "all-zero"]) {
      const e = refusal(() => ceilingFromRuns([dir], root));
      expect(e.name, dir).toBe("CeilingUnreadable");
      expect(e.message, dir).toContain(dir);
    }
    // A zero measured max would be a zero budget (every job would plan at setup + slack): refused, never rounded to 0.
    expect(refusal(() => ceilingFromRuns(["all-zero"], root)).message).toMatch(/no case with a duration|zero/);
    expect(refusal(() => ceilingFromRuns([], root)).name).toBe("CeilingUnreadable");
    // …by its OWN reason: an empty list is not the zero-duration refusal reached by another road.
    expect(refusal(() => ceilingFromRuns([], root)).message).toMatch(/names no run/);
    expect(ceilingFromRuns(["r1"], root)).toBeGreaterThan(0);
  });

  it("the committed evidence gives the brief's ceilings: L1 210 s (132,684 ms), L2 30 s (17,002 ms), L3 30 s (13,530 ms)", () => {
    // Recomputed here from the raw files, by the rule's words, and pinned to the brief's literals.
    const maxMs = (dirs: readonly string[]): number => Math.max(...dirs.flatMap((d) => (parseResults(JSON.parse(readFileSync(join(TR, d, "results.json"), "utf8"))).cases.map((c) => c.durationMs))));
    const by = Object.fromEntries(LAYERS.map((l) => [l, maxMs(cfg.layers[l].ceilingFrom)])) as Record<Layer, number>;
    expect(by).toEqual({ L1: 132_684, L2: 17_002, L3: 13_530 });
    expect(Object.fromEntries(LAYERS.map((l) => [l, Math.ceil(by[l] / 1000 / 10) * 10 * 1.5]))).toEqual({ L1: 210, L2: 30, L3: 30 });
    expect(ceilingsOf(cfg)).toEqual({ L1: 210, L2: 30, L3: 30 });
  });
});

describe("drivenInPlanOrder (lib/expected-plan.ts): the plan's items in the order `stripe` partitions them", () => {
  it("agrees with livePlan on how many items there are and how many are driven, for every plan shape the matrix runs", () => {
    const plans = ["--layer L1", "--layer L1 --scope grid", "--layer L2", "--layer L2 --scope grid", "--set w1-driving", "--set pr-sample --rows none", "--set pr-sample --rows swiss", "slice"];
    let checked = 0;
    for (const plan of plans) {
      const f = drivenInPlanOrder(plan);
      const p = livePlan(plan);
      expect(f.length, plan).toBe(p.driven.size + p.planned.size);
      expect(f.filter(Boolean).length, plan).toBe(p.driven.size);
      checked++;
    }
    expect(checked).toBe(plans.length);
    // The sizes the brief gives, by plan: 6 / 231 / 68 / 1,731 / 937 / 33.
    expect(drivenInPlanOrder("--layer L1").length).toBe(6);
    expect(drivenInPlanOrder("--layer L1 --scope grid").length).toBe(231);
    expect(drivenInPlanOrder("--layer L2").length).toBe(68);
    expect(drivenInPlanOrder("--layer L2").filter(Boolean).length).toBe(3);
    expect(drivenInPlanOrder("--layer L2 --scope grid").length).toBe(1731);
    expect(drivenInPlanOrder("--set w1-driving").length).toBe(937);
    expect(drivenInPlanOrder("--set pr-sample --rows none").length).toBe(33);
  });

  it("livePlan, rebuilt on the same ordered list, still carries each planned item's state AND reason (the refactor kept the stored reason)", () => {
    // Nothing else reads `reason` today (judge.ts reads only the keys), so a refactor that dropped it would pass every other suite.
    const p = livePlan("--layer L2");
    expect(p.planned.size).toBe(65); // 68 items, 3 driven
    const states = new Set<string>();
    for (const [key, v] of p.planned) {
      expect(v.reason.length, key).toBeGreaterThan(0);
      states.add(v.state);
    }
    expect([...states].sort()).toEqual(["no_path", "not_run"]);
  });

  it("an unknown plan is refused like livePlan's", () => {
    expect(() => drivenInPlanOrder("--layer L9")).toThrow(/no planner/);
  });
});

/** The real runner, over fakes, with the DB's real builder-default order (the L1 grid plans every sport). */
const live = (): RunDeps => {
  const d = deps({ openBrowserRun: async () => fakeBrowserRun().run });
  return { ...d, openDb: async () => ({ ...(await d.openDb()), variantKeysInBuilderOrder: async (s: string) => [...offlineVariantOrder(s)] }) };
};

describe("the seam, through the REAL runner (class 1: a fixture on both ends proves the fixture)", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** The jobs of `scope` run through runSlice exactly as the workflow would hand them `job.args`, then merged and judged by plan. */
  async function drive(scope: "full" | "smoke" | "pr-sample", rows?: string): Promise<{ jobs: Job[]; runs: Map<string, RunResults[]> }> {
    const plans: Partial<Record<Layer, boolean[]>> = {};
    const layers: readonly Layer[] = scope === "pr-sample" ? ["L3"] : LAYERS;
    for (const l of layers) {
      const args = scope === "pr-sample" ? `${cfg.prSample.args} --rows ${rows ?? "none"}` : cfg.layers[l][scope].args;
      plans[l] = drivenInPlanOrder(planOfArgs(args));
    }
    const jobs = shardMatrix(cfg, scope, plans, ceilingsOf(cfg), rows).include;
    const dir = scratchDir("drive");
    const runs = new Map<string, RunResults[]>();
    for (const j of jobs) {
      const code = await runSlice(live(), [...j.args.split(" "), "--run-id", `${j.id}`, "--report-dir", dir]);
      // The runner's own verdict on the job's argument string: ShardEmpty, a usage error or a refused flag would not be 0.
      expect(code, `${j.layer} ${j.k}/${j.of}: ${j.args}`).toBe(0);
      const r = parseResults(JSON.parse(readFileSync(join(dir, j.id, "results.json"), "utf8"))) as RunResults;
      // The plan string the runner RECORDED is the one planOfArgs derived from the job's own plan flags (the job's budget
      // was planned from that plan): the producer's word against the helper's, for every job of every scope.
      const planFlags = j.args.replace(/ --shard \d+\/\d+$/, "").replace(/ --workers \d+/, "");
      expect(r.plan, `${j.id}: ${j.args}`).toBe(planOfArgs(planFlags));
      runs.set(j.layer, [...(runs.get(j.layer) ?? []), r]);
    }
    return { jobs, runs };
  }

  it("the full scope: every job's args are accepted by run.ts, every stripe holds an item, and each timeout is the DRIVEN count of the real stripe", { timeout: 300_000 }, async () => {
    const { jobs, runs } = await drive("full");
    expect(jobs).toHaveLength(12);
    const ceilings = ceilingsOf(cfg);
    let checked = 0;
    for (const j of jobs) {
      const r = runs.get(j.layer)![j.k - 1];
      const workers = j.args.includes("--workers 4") ? 4 : 1;
      expect(r.shard, `${j.layer} ${j.k}/${j.of}`).toEqual({ index: j.k, of: j.of, planSize: { L1: 231, L2: 1731, L3: 937 }[j.layer] });
      expect(r.cases.length).toBeGreaterThan(0);
      // The budget basis: the cases the stripe DROVE (no `planned` marker), counted from the evidence the runner wrote.
      const drivenReal = r.cases.filter((c) => c.planned !== true).length;
      expect(j.timeout, `${j.layer} ${j.k}/${j.of}`).toBe(cfg.setupMinutes + Math.ceil((drivenReal * ceilings[j.layer]) / workers / 60) + cfg.slackMinutes);
      // The `--workers` the job asks for is the one the run used (written only when more than one ran).
      if (workers > 1) expect(r.workers).toBe(workers);
      else expect(r.workers).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(12);
    // The recorded plan strings are the ones planOfArgs derived (merge-shards and the judge read them).
    expect(runs.get("L1")![0].plan).toBe("--layer L1 --scope grid");
    expect(runs.get("L2")![0].plan).toBe("--layer L2 --scope grid");
    expect(runs.get("L3")![0].plan).toBe("--set w1-driving");
    expect(runs.get("L1")![0].scope).toBe("L1 (grid)");
    // Non-vacuity: the stripes differ in how much they drove (the L2 grid's 62 driven items do not split evenly across any 8).
    const l1 = runs.get("L1")!.map((r) => r.cases.filter((c) => c.planned !== true).length);
    expect(l1.reduce((a, b) => a + b, 0)).toBe(178);
    expect(new Set(l1).size).toBeGreaterThan(1);
    expect(runs.get("L2")!.map((r) => r.cases.filter((c) => c.planned !== true).length).reduce((a, b) => a + b, 0)).toBe(62);
  });

  it("the full scope's shards of each layer merge into the layer's plan: right count, right order, identity clean against the planner (the judge's own check)", { timeout: 300_000 }, async () => {
    const { runs } = await drive("full");
    let merged = 0;
    for (const l of LAYERS) {
      const shards = runs.get(l)!;
      const inputs: ShardInput[] = shards.map((r, i) => ({ name: `${l}-${i + 1}`, exit: "0\n", results: r }));
      const m = mergeShards(inputs, `ci-1-1-${l.toLowerCase()}`);
      expect(m.merged.shards, l).toBe(shards.length);
      expect(m.checked, l).toBe({ L1: 231, L2: 1731, L3: 937 }[l]);
      expect(matchPlanIds(m.merged).compared, l).toBe(m.checked);
      merged++;
    }
    expect(merged).toBe(3);
  });

  it("the smoke scope: six jobs, each accepted by run.ts, each stripe non-empty (L1 has 6 items, L2 68 of which 3 driven, L3 the fixed 33)", { timeout: 300_000 }, async () => {
    const { jobs, runs } = await drive("smoke");
    expect(jobs).toHaveLength(6);
    expect(runs.get("L1")!.map((r) => r.cases.length)).toEqual([3, 3]);
    expect(runs.get("L2")!.map((r) => r.cases.length)).toEqual([34, 34]);
    expect(runs.get("L3")!.map((r) => r.cases.length)).toEqual([17, 16]);
    expect(runs.get("L2")!.flatMap((r) => r.cases).filter((c) => c.planned !== true)).toHaveLength(3);
    expect(runs.get("L3")![0].plan).toBe("--set pr-sample --rows none");
    for (const j of jobs) {
      const r = runs.get(j.layer)![j.k - 1];
      const workers = j.args.includes("--workers 4") ? 4 : 1;
      const drivenReal = r.cases.filter((c) => c.planned !== true).length;
      expect(j.timeout, `${j.layer} ${j.k}/${j.of}`).toBe(cfg.setupMinutes + Math.ceil((drivenReal * ceilingsOf(cfg)[j.layer]) / workers / 60) + cfg.slackMinutes);
    }
  });

  it("pr-sample: one job, no --shard, the rows in args — run.ts records the plan with those rows, and ALL its cases are in the one run", { timeout: 120_000 }, async () => {
    const { jobs, runs } = await drive("pr-sample", "swiss,league");
    expect(jobs).toHaveLength(1);
    const r = runs.get("L3")![0];
    expect(r.shard).toBeUndefined();
    expect(r.plan).toBe("--set pr-sample --rows league,swiss");
    expect(r.cases).toHaveLength(drivenInPlanOrder("--set pr-sample --rows league,swiss").length);
    expect(r.cases.length).toBeGreaterThan(33);
    expect(jobs[0].timeout).toBe(cfg.setupMinutes + Math.ceil((r.cases.length * ceilingsOf(cfg).L3 * cfg.prSample.passes) / cfg.prSample.workers / 60) + cfg.slackMinutes);
  });
});

describe("shard-matrix.ts the CLI: matrix=<json> for $GITHUB_OUTPUT (exit 0), or a refusal (exit 2, nothing on stdout)", { timeout: 120_000 }, () => {
  const io = { out: "", err: "" };
  beforeEach(() => {
    io.out = ""; io.err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { io.out += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { io.err += String(s); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const dir = scratchDir("cli");
  const shardsText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ci", "shards.json"), "utf8");
  const withCeiling = (layer: Layer, ceilingFrom: string[]): string => {
    const c = JSON.parse(shardsText) as { layers: Record<string, { ceilingFrom: string[] }> };
    c.layers[layer].ceilingFrom = ceilingFrom;
    const f = join(dir, `s-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(c));
    return f;
  };
  const matrix = (): { include: Job[] } => {
    expect(io.out.endsWith("\n")).toBe(true);
    expect(io.out.split("\n").filter((l) => l !== ""), "stdout is the one line $GITHUB_OUTPUT takes, and nothing else").toHaveLength(1);
    expect(io.out.startsWith("matrix=")).toBe(true);
    return JSON.parse(io.out.slice("matrix=".length)) as { include: Job[] };
  };

  it("--scope full plans offline from the real committed plans and ceilings: 12 jobs, the exact ids, and a matrix with the one key `include`", () => {
    expect(main(["--scope", "full"])).toBe(0);
    const m = matrix();
    expect(Object.keys(m)).toEqual(["include"]);
    expect(m.include.map((j) => j.id)).toEqual(["l1-s1", "l1-s2", "l1-s3", "l1-s4", "l1-s5", "l1-s6", "l1-s7", "l1-s8", "l2-s1", "l2-s2", "l3-s1", "l3-s2"]);
    expect(m.include.every((j) => Object.keys(j).sort().join() === "args,id,k,layer,of,timeout")).toBe(true);
    expect(m.include.every((j) => j.timeout <= 300)).toBe(true);
    expect(io.err).toMatch(/L1.*231.*178/);
  });

  it("--scope smoke is 6 jobs; --scope pr-sample --rows <r> is one; and --rows beside full or smoke is ignored", () => {
    expect(main(["--scope", "smoke"])).toBe(0);
    expect(matrix().include).toHaveLength(6);
    io.out = "";
    expect(main(["--scope", "pr-sample", "--rows", "league,swiss"])).toBe(0);
    const one = matrix().include;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ layer: "L3", id: "l3-sample", k: 1, of: 1, args: "--set pr-sample --rows league,swiss --workers 4" });
    io.out = "";
    expect(main(["--scope", "full", "--rows", "none"])).toBe(0);
    const withRows = matrix();
    io.out = "";
    expect(main(["--scope", "full"])).toBe(0);
    expect(withRows).toEqual(matrix());
  });

  it("an unknown row is a refusal naming the row, exit 2, nothing on stdout", () => {
    expect(main(["--scope", "pr-sample", "--rows", "leage"])).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toMatch(/leage/);
  });

  it("usage errors are exit 2 with nothing on stdout: no scope, an unknown scope, a positional, an unknown flag, pr-sample with no rows", () => {
    for (const argv of [[], ["--scope", "nightly"], ["--scope", "full", "extra"], ["--scope", "full", "--bogus", "1"], ["--scope", "pr-sample"], ["--scope", "pr-sample", "--rows", ""], ["--scope"]]) {
      io.out = ""; io.err = "";
      expect(main(argv), argv.join(" ")).toBe(2);
      expect(io.out, argv.join(" ")).toBe("");
      expect(io.err, argv.join(" ")).toMatch(/usage: shard-matrix\.ts/);
    }
    // pr-sample without rows is refused as USAGE (its own reason), before any plan is built from a rows value that is not there.
    for (const argv of [["--scope", "pr-sample"], ["--scope", "pr-sample", "--rows", ""]]) {
      io.err = "";
      expect(main(argv)).toBe(2);
      expect(io.err, argv.join(" ")).toContain("--scope pr-sample needs --rows");
    }
  });

  it("a bare `--` (pnpm 10 forwards one) is no argument", () => {
    expect(main(["--", "--scope", "smoke"])).toBe(0);
    expect(matrix().include).toHaveLength(6);
  });

  it("a ceilingFrom directory without results.json is refused by name (review I6): exit 2, nothing on stdout, the directory in the message", () => {
    expect(main(["--scope", "full", "--shards-file", withCeiling("L1", ["w1drv-l1"])])).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toMatch(/CeilingUnreadable/);
    expect(io.err).toContain("w1drv-l1");
    // The same file with a directory that holds one plans.
    io.err = "";
    expect(main(["--scope", "full", "--shards-file", withCeiling("L1", ["w1drv-l1/w1drv-l1-r2"])])).toBe(0);
  });

  it("pr-sample reads only L3's evidence: a broken L1 or L2 ceilingFrom is not its business (and IS the full scope's)", () => {
    const f = withCeiling("L1", ["w1drv-l1"]);
    expect(main(["--scope", "pr-sample", "--rows", "none", "--shards-file", f])).toBe(0);
    expect(matrix().include).toHaveLength(1);
    io.out = "";
    expect(main(["--scope", "full", "--shards-file", f])).toBe(2);
    // The other direction: a broken L3 ceilingFrom stops pr-sample.
    io.err = "";
    expect(main(["--scope", "pr-sample", "--rows", "none", "--shards-file", withCeiling("L3", ["w1drv-l3-moved"])])).toBe(2);
    expect(io.err).toMatch(/CeilingUnreadable/);
  });

  it("a --shards-file that does not exist, or holds a config the schema refuses, is exit 2", () => {
    expect(main(["--scope", "full", "--shards-file", join(dir, "absent.json")])).toBe(2);
    expect(io.err).toMatch(/ShardsFileInvalid/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ note: "x" }));
    io.err = "";
    expect(main(["--scope", "full", "--shards-file", bad])).toBe(2);
    expect(io.out).toBe("");
  });

  it("T4-CLAMP through the CLI: a shard count above the REAL plan's size is clamped to it, said on stderr, and every stripe holds an item", () => {
    // L1's smoke plan is the slice: 3 rows (league, knockout, swiss) x 2 sports (generic, badminton) = 6 cells, so 8 shards
    // cannot all hold one. The size is read from the planner and pinned to that hand count.
    const size = drivenInPlanOrder(planOfArgs(cfg.layers.L1.smoke.args)).length;
    expect(size).toBe(6);
    const c = JSON.parse(shardsText) as { layers: Record<string, { smoke: { shards: number } }> };
    c.layers.L1.smoke.shards = 8;
    const f = join(dir, "eight.json");
    writeFileSync(f, JSON.stringify(c));
    expect(main(["--scope", "smoke", "--shards-file", f])).toBe(0);
    const l1 = matrix().include.filter((j) => j.layer === "L1");
    expect(l1.map((j) => `${j.k}/${j.of}`)).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    expect(io.err).toMatch(/L1 6 items.*clamped from 8 shards/);
    // The layers that were not clamped say nothing of it.
    expect(io.err.split("\n").filter((l) => /clamped/.test(l))).toHaveLength(1);
  });

  it("a refusal's text passes through redact: a path that carries a secret-shaped name is not echoed", () => {
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    expect(main(["--scope", "full", "--shards-file", join(dir, `${secret}.json`)])).toBe(2);
    expect(io.err).toMatch(/ShardsFileInvalid/);
    expect(io.err).not.toContain(secret);
    expect(io.out).toBe("");
  });

  it("a plan that would time out past the cap is a refusal at plan time, named (ShardTimeoutTooLong), never at minute 360", () => {
    const c = JSON.parse(shardsText) as { layers: Record<string, { full: { shards: number } }> };
    c.layers.L1.full.shards = 2; // 178 driven over two stripes of one browser worker at 210 s
    const f = join(dir, "two.json");
    writeFileSync(f, JSON.stringify(c));
    expect(main(["--scope", "full", "--shards-file", f])).toBe(2);
    expect(io.err).toMatch(/ShardTimeoutTooLong/);
    expect(io.err).toMatch(/L1 shard 1\/2/);
    expect(io.out).toBe("");
  });

  it("every refusal name the CLI can print is declared once, and ShardRefused carries its own name", () => {
    expect([...SHARD_REFUSALS].sort()).toEqual(["BadCeiling", "CeilingUnreadable", "PrSampleNeedsRows", "ShardPlanTooSmall", "ShardPlanVacuous", "ShardTimeoutTooLong", "ShardsArgsUnplannable", "ShardsFileInvalid"].sort());
    expect(new Set(SHARD_REFUSALS).size).toBe(SHARD_REFUSALS.length);
    expect(new ShardRefused("BadCeiling", "m").name).toBe("BadCeiling");
    expect(new ShardRefused("BadCeiling", "m")).toBeInstanceOf(Error);
  });
});

describe("shard-matrix.ts as its package script, a real process (the preload form the workflow calls)", () => {
  const meter = new SpawnMeter(3);
  beforeEach(() => meter.reset());
  const argv = (extra: readonly string[]): string[] => {
    const words = (scripts["matrix:shards"] ?? "").split(" ");
    expect(words[0]).toBe("node");
    return [...words.slice(1), ...extra];
  };
  const run = (extra: readonly string[]) => {
    meter.tick();
    return spawnSync(process.execPath, argv(extra), { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  };

  it("`matrix:shards --scope full` prints exactly the matrix=<json> line on stdout and exits 0", { timeout: meter.budget }, () => {
    const r = run(["--scope", "full"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(1);
    const m = JSON.parse(r.stdout.replace(/^matrix=/, "")) as { include: { layer: string }[] };
    expect(m.include.map((j) => j.layer).sort()).toEqual([...Array(8).fill("L1"), ...Array(2).fill("L2"), ...Array(2).fill("L3")].sort());
  });

  it("a ceilingFrom directory without results.json exits 2 through the script, naming the directory (review I6)", { timeout: meter.budget }, () => {
    const dir = scratchDir("spawn");
    try {
      const c = JSON.parse(readFileSync(join(REPO, "tools/matrix/ci/shards.json"), "utf8")) as { layers: Record<string, { ceilingFrom: string[] }> };
      c.layers.L1.ceilingFrom = ["w1drv-l1"];
      const f = join(dir, "s.json");
      writeFileSync(f, JSON.stringify(c));
      const r = run(["--scope", "full", "--shards-file", f]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("w1drv-l1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
