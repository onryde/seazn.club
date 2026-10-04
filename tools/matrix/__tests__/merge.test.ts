// W1d Task 4 (D5, Review Focus 1, R25): N shard results of ONE layer back into
// one run, in plan order — and every way a shard can be silently short is
// refused BY NAME, with nothing merged around the hole. Sport-agnostic: the
// merge reads shard headers and case ids, never a sport (the L2 test below
// carries the planned-case shape the grid layers add). The seam from
// `--shard` to the merge, through the REAL runner, is run-shard.test.ts's.
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mergeShards, type ShardInput } from "../lib/merge.ts";
import { findSecrets } from "../lib/redact.ts";
import { RunResultsSchemaV3, isPlannedShape, parseResults, type CaseResult, type CheckResult, type RunResults } from "../lib/results.ts";
import { stripe, stripeSize } from "../lib/shard.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

const GRID = { rows: ["league"], sports: ["generic"] };
const check: CheckResult = { id: "I1", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence: [] };
const COUNTS = { calls: 1, fixtures: 1, events: 1 };

/** A case of an L3 HTTP run that worked; the id is the plan item. */
const workedCase = (caseId: string): CaseResult => ({
  caseId, row: "league", sport: "generic", variant: "default", scenario: caseId.split("|").at(-1)!, canary: false,
  state: "works", reason: "1 checks, 1 items", checks: [{ ...check }], counts: { ...COUNTS }, durationMs: 1, notes: [],
  layer: "L3", driver: "http", width: null,
});

/** A valid v3 shard of the stripe: the header as run.ts writes it for `--shard k/N`. */
function shardOf(plan: readonly string[], k: number, of: number, over: Record<string, unknown> = {}): RunResults {
  return {
    schemaVersion: 3, runId: `shard-${k}`, harnessCommit: "abc", startedAt: `2026-10-04T10:0${k % 10}:00.000Z`, finishedAt: `2026-10-04T11:0${k % 10}:00.000Z`,
    grid: GRID, layer: "L3", driver: "http", plan: "--set w1-driving",
    shard: { index: k, of, planSize: plan.length },
    cases: stripe(plan, { index: k, of }).map(workedCase),
    ...over,
  } as RunResults;
}

const plan = Array.from({ length: 7 }, (_, i) => `league|generic|default|S${i}`);
const all = (of: number, p: readonly string[] = plan, over: Record<string, unknown> = {}): ShardInput[] =>
  Array.from({ length: of }, (_, k) => ({ name: `s${k + 1}`, exit: "0", results: shardOf(p, k + 1, of, over) }));
const asRun = (i: ShardInput): RunResults => i.results as RunResults;
/** The refusal's name, or null when it merged: asserts on the name, never only on "it threw". */
function refusedAs(inputs: readonly ShardInput[]): string | null {
  try { mergeShards(inputs, "ci-1-1-l3"); return null; } catch (e) { return e instanceof Error ? e.name : String(e); }
}
const msgOf = (inputs: readonly ShardInput[]): string => {
  try { mergeShards(inputs, "ci-1-1-l3"); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

describe("mergeShards (Review Focus 1)", () => {
  it("merges N shards back into plan order, records shards: N, and counts every case", () => {
    const { merged, checked } = mergeShards(all(3), "ci-1-1-L3");
    expect(merged.cases.map((c) => c.caseId)).toEqual(plan);
    expect(merged.shards).toBe(3);
    expect(merged.shard).toBeUndefined();
    expect(merged.runId).toBe("ci-1-1-L3");
    expect(checked).toBe(7);
  });

  it("the header: the shards' own commit, grid, layer, driver and plan; the earliest start and the latest finish; the result parses as v3", () => {
    const { merged } = mergeShards(all(3), "ci-1-1-l3");
    expect(merged.harnessCommit).toBe("abc");
    expect(merged.layer).toBe("L3");
    expect(merged.driver).toBe("http");
    expect(merged.plan).toBe("--set w1-driving");
    expect(merged.grid).toEqual(GRID);
    // The fixture gives shard k a start of 10:0k and a finish of 11:0k: the merge is the span.
    expect(merged.startedAt).toBe("2026-10-04T10:01:00.000Z");
    expect(merged.finishedAt).toBe("2026-10-04T11:03:00.000Z");
    expect(parseResults(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
  });

  it("arrival order is irrelevant: shards handed over backwards, or shuffled, merge to the same plan order", () => {
    const forward = mergeShards(all(3), "x").merged.cases.map((c) => c.caseId);
    expect(forward).toEqual(plan);
    expect(mergeShards([...all(3)].reverse(), "x").merged.cases.map((c) => c.caseId)).toEqual(plan);
    const s = all(3);
    expect(mergeShards([s[1], s[2], s[0]], "x").merged.cases.map((c) => c.caseId)).toEqual(plan);
  });

  it("zero shards is refused (vacuous)", () => {
    expect(() => mergeShards([], "x")).toThrow(expect.objectContaining({ name: "ShardMissing" }));
    expect(() => mergeShards([], "x")).toThrow(/zero shards/);
  });

  it("a shard that died, a partial shard, a stray shard: each refused by name", () => {
    const s = all(3);
    expect(() => mergeShards([s[0], s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardMissing" }));
    expect(() => mergeShards([s[0], { ...s[1], exit: null }, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardFailed" }));
    expect(() => mergeShards([s[0], { ...s[1], exit: "3" }, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardFailed" }));
    const short = structuredClone(s[1]);
    asRun(short).cases.pop();
    expect(() => mergeShards([s[0], short, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardSize" }));
    const aborted = structuredClone(s[1]);
    (aborted.results as Record<string, unknown>).aborted = { turn: "t", deadlineMs: 1, caseId: plan[1], worker: null, inFlight: [] };
    expect(() => mergeShards([s[0], aborted, s[2]], "x")).toThrow(expect.objectContaining({ name: "ShardAborted" }));
    expect(() => mergeShards([...s, s[0]], "x")).toThrow(expect.objectContaining({ name: "ShardDuplicate" }));
  });

  it("the exit code is read as text: '0' and '0\\n' (what `echo $? > exit.txt` writes) pass; every other text fails the shard, naming it", () => {
    const s = all(3);
    expect(refusedAs([s[0], { ...s[1], exit: "0\n" }, s[2]])).toBeNull();
    expect(refusedAs([s[0], { ...s[1], exit: " 0 " }, s[2]])).toBeNull();
    let checked = 0;
    for (const exit of ["1", "2", "3", "137", "", "\n", "EXIT=0", "00", "0 0", "abc"]) {
      expect(refusedAs([s[0], { ...s[1], exit }, s[2]]), JSON.stringify(exit)).toBe("ShardFailed");
      expect(msgOf([s[0], { ...s[1], exit }, s[2]]), JSON.stringify(exit)).toMatch(/^s2: /);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("a shard with no results.json, or an empty one, is refused ShardEmpty (R25); a results file the schema refuses is ShardInvalid", () => {
    const s = all(3);
    expect(refusedAs([s[0], { ...s[1], results: null }, s[2]])).toBe("ShardEmpty");
    expect(refusedAs([s[0], { ...s[1], results: undefined }, s[2]])).toBe("ShardEmpty");
    const empty = { ...s[1], results: { ...asRun(s[1]), cases: [] } };
    expect(refusedAs([s[0], empty, s[2]])).toBe("ShardEmpty");
    expect(msgOf([s[0], empty, s[2]])).toMatch(/^s2: zero cases/);
    expect(refusedAs([s[0], { ...s[1], results: {} }, s[2]])).toBe("ShardInvalid");
    expect(refusedAs([s[0], { ...s[1], results: "not an object" }, s[2]])).toBe("ShardInvalid");
    expect(refusedAs([s[0], { ...s[1], results: { ...asRun(s[1]), schemaVersion: 4 } }, s[2]])).toBe("ShardInvalid");
    expect(msgOf([s[0], { ...s[1], results: {} }, s[2]])).toMatch(/^s2: /);
  });

  it("a v2 results file, or a v3 run with no shard header, is no shard: refused ShardMismatch, naming it", () => {
    const s = all(3);
    const noHeader = (({ shard: _s, ...rest }) => rest)(asRun(s[1]));
    expect(refusedAs([s[0], { ...s[1], results: noHeader }, s[2]])).toBe("ShardMismatch");
    expect(msgOf([s[0], { ...s[1], results: noHeader }, s[2]])).toMatch(/^s2: not a shard/);
    const v2 = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "s", finishedAt: "f", grid: GRID, cases: asRun(s[1]).cases.map(({ layer: _l, driver: _d, width: _w, ...c }) => c) };
    expect(refusedAs([s[0], { ...s[1], results: v2 }, s[2]])).toBe("ShardMismatch");
    // The merge of an ALREADY merged run is no shard either (it carries `shards`, never `shard`).
    const merged = mergeShards(all(3), "x").merged;
    expect(refusedAs([{ name: "m", exit: "0", results: merged }, ...all(3).slice(0, 2)])).toBe("ShardMismatch");
  });

  it("each of ShardSize and ShardMissing refuses ALONE: a missing shard (all remaining stripes whole) and a short shard (every shard present) are different holes", () => {
    const s = all(3);
    // Missing only: the two shards that arrived are each exactly their stripe.
    expect(refusedAs([s[0], s[1]])).toBe("ShardMissing");
    expect(msgOf([s[0], s[1]])).toMatch(/shard 3\/3 is absent/);
    // Short only: every index is present, one stripe lost a case.
    const short = structuredClone(s);
    asRun(short[2]).cases.pop();
    expect(refusedAs(short)).toBe("ShardSize");
    expect(msgOf(short)).toMatch(/^s3: 1 cases, its stripe of 7 holds 2/);
    // A shard with too MANY cases is as wrong as one with too few.
    const long = structuredClone(s);
    asRun(long[0]).cases.push(workedCase("league|generic|default|EXTRA"));
    expect(refusedAs(long)).toBe("ShardSize");
  });

  it("shards of different commits, plans, layers, drivers, scopes, grids, shard counts or plan sizes are refused", () => {
    const overrides: [string, Record<string, unknown>][] = [
      ["a different harness commit", { harnessCommit: "def" }],
      ["a different plan", { plan: "--set pad-proof" }],
      ["a different layer", { layer: "L1" }],
      ["a different driver", { driver: "browser" }],
      ["a different plan size", { shard: { index: 2, of: 3, planSize: 8 } }],
      ["a different shard count", { shard: { index: 2, of: 4, planSize: 7 } }],
      ["a different grid", { grid: { rows: ["league", "knockout"], sports: ["generic"] } }],
      ["a different scope", { scope: "L1 (grid)" }],
    ];
    let checked = 0;
    for (const [what, o] of overrides) {
      const s = all(3);
      s[1] = { ...s[1], results: { ...asRun(s[1]), ...o } };
      expect(refusedAs(s), what).toBe("ShardMismatch");
      expect(msgOf(s), what).toMatch(/^s2: /);
      checked++;
    }
    expect(checked).toBe(overrides.length);
  });

  it("a shard of ANOTHER layer, every case consistent with its own run, is refused by the header comparison alone (not by the per-case layer check, which would cover for it)", () => {
    const s = all(3);
    s[1] = { ...s[1], results: { ...asRun(s[1]), layer: "L1", cases: asRun(s[1]).cases.map((c) => ({ ...c, layer: "L1" })) } };
    expect(asRun(s[1]).cases.every((c) => c.layer === asRun(s[1]).layer), "the fixture is self-consistent").toBe(true);
    expect(refusedAs(s)).toBe("ShardMismatch");
    expect(msgOf(s)).toMatch(/^s2: layer "L1" ≠ "L3"/);
  });

  it("a case whose own layer differs from its run's is refused (item 14's reader)", () => {
    const s = all(3);
    asRun(s[0]).cases[0].layer = "L1";
    expect(() => mergeShards(s, "x")).toThrow(expect.objectContaining({ name: "ShardMismatch" }));
  });

  it("a secret-shaped string in a shard is refused (Review Focus 5), by count and never by value", () => {
    const s = all(3);
    asRun(s[0]).cases[0].reason = "postgres://u:p@h/db";
    expect(() => mergeShards(s, "x")).toThrow(expect.objectContaining({ name: "ShardSecret" }));
    const text = msgOf(s);
    // Counted, never quoted: the DB-URL shape and the password-in-URL shape each match the one string.
    expect(text).toMatch(/^s1: \d+ secret-shaped string/);
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("u:p@h");
  });

  it("…including a secret that starts a LINE: the scan reads the raw strings, never the JSON text (writeResults' review I1)", () => {
    // JSON.stringify spells the newline `\n`, which erases the \b before `sk_`/`dl_`/a JWT — so a scan of the
    // stringified body passes this witness (spelled in two halves so this file is no secret itself), and the
    // raw-string scan refuses it.
    const witness = `see the log\n${"sk"}_live_${"ABCDEFGH12345678"}`;
    expect(findSecrets(JSON.stringify(witness)), "the witness hides from a scan of the JSON text").toEqual([]);
    expect(findSecrets(witness).length, "…and is a secret as written").toBeGreaterThan(0);
    const s = all(3);
    asRun(s[2]).cases[0].reason = witness;
    expect(refusedAs(s)).toBe("ShardSecret");
  });

  it("the secret scan runs on every shard BEFORE any is merged: a leak in the LAST shard still refuses, and a clean set merges", () => {
    const s = all(3);
    asRun(s[2]).cases[1].notes = [`token ${"sk"}_live_${"ABCDEFGH12345678"}`];
    expect(refusedAs(s)).toBe("ShardSecret");
    expect(refusedAs(all(3))).toBeNull();
  });

  it("CaseCollision: two shards naming one case id is refused, naming both shards (a hand-built collision)", () => {
    const four = ["league|generic|default|A", "league|generic|default|B", "league|generic|default|C", "league|generic|default|D"];
    const s = all(2, four);
    expect(refusedAs(s)).toBeNull();
    // Shard 2's second case (plan position 3, "D") is relabelled as plan position 0's "A".
    asRun(s[1]).cases[1] = workedCase(four[0]);
    expect(refusedAs(s)).toBe("CaseCollision");
    expect(msgOf(s)).toContain(four[0]);
    expect(msgOf(s)).toMatch(/shard 1\/2.*shard 2\/2/);
  });

  it("a plan shorter than N: the high shards own nothing, so a merge of the shards that DO exist is whole — and a stray empty one is refused", () => {
    const two = [plan[0], plan[1]];
    const inputs = all(3, two).slice(0, 2);
    const { merged, checked } = mergeShards(inputs, "x");
    expect(merged.cases.map((c) => c.caseId)).toEqual(two);
    expect(merged.shards).toBe(3);
    expect(checked).toBe(2);
    // Shard 3 of a 2-item plan holds zero cases: run.ts refuses to write it, so one that arrives is no shard of this plan.
    const stray = { name: "s3", exit: "0", results: shardOf(two, 3, 3) };
    expect(asRun(stray).cases).toHaveLength(0);
    expect(refusedAs([...inputs, stray])).toBe("ShardEmpty");
  });

  it("workers: the merged run records the most any shard ran, and none when no shard ran more than one", () => {
    expect("workers" in mergeShards(all(3), "x").merged).toBe(false);
    const s = all(3);
    asRun(s[0]).workers = 2;
    asRun(s[2]).workers = 4;
    expect(mergeShards(s, "x").merged.workers).toBe(4);
  });

  it("scope (T3-SCOPE): shards that all carry one scope merge to it; shards that all lack it merge to none; a disagreement — either way round — is refused", () => {
    const withScope = (scope: string | undefined) => all(3, plan, scope === undefined ? {} : { scope });
    expect(mergeShards(withScope("L2 (grid)"), "x").merged.scope).toBe("L2 (grid)");
    const none = mergeShards(withScope(undefined), "x").merged;
    expect(none.scope).toBeUndefined();
    expect("scope" in none).toBe(false);
    const oneLacks = withScope("L2 (grid)");
    delete asRun(oneLacks[1]).scope;
    expect(refusedAs(oneLacks)).toBe("ShardMismatch");
    expect(msgOf(oneLacks)).toMatch(/scope/);
    const oneExtra = withScope(undefined);
    asRun(oneExtra[2]).scope = "L2 (grid)";
    expect(refusedAs(oneExtra)).toBe("ShardMismatch");
    const slice = withScope("L2 (grid)");
    asRun(slice[0]).scope = "L2 (slice)";
    expect(refusedAs(slice)).toBe("ShardMismatch");
    expect(msgOf(slice)).toMatch(/scope/);
  });

  it("every header field the schema declares is accounted for by the merge — carried, replaced or refused — so a field added later is decided here, never silently dropped (T3-SCOPE's lesson)", () => {
    const s = all(3, plan, { scope: "L2 (grid)" });
    asRun(s[0]).workers = 2;
    const merged = mergeShards(s, "x").merged;
    const schemaKeys = Object.keys(RunResultsSchemaV3.shape);
    expect(schemaKeys.length, "the schema's keys were read").toBeGreaterThan(10);
    // `shard` is each shard's own header (the merge records `shards` instead), and `aborted` is refused outright.
    expect(Object.keys(merged).sort()).toEqual(schemaKeys.filter((k) => k !== "shard" && k !== "aborted").sort());
  });

  it("a marked-planned case must have the planned shape: planned: true on a case with a check, or in a state recordPlanned never writes, is refused", () => {
    const s = all(3);
    asRun(s[1]).cases[0].planned = true;
    expect(refusedAs(s), "planned: true on a ✅ case with a check").toBe("ShardInvalid");
    expect(msgOf(s)).toMatch(/planned/);
    const planned = all(3);
    Object.assign(asRun(planned[1]).cases[0], { planned: true, state: "not_run", reason: "no script", checks: [] });
    expect(refusedAs(planned), "planned: true in the planned shape (░, no check)").toBeNull();
    const wrongState = all(3);
    Object.assign(asRun(wrongState[1]).cases[0], { planned: true, state: "later", reason: "W9: later", checks: [] });
    expect(refusedAs(wrongState), "planned: true on a ⏳ case").toBe("ShardInvalid");
  });

  it("another layer: an L2 grid shard set merges with planned ░ cases kept planned, the scope carried, and every planned case in the planned shape", () => {
    const l2 = Array.from({ length: 5 }, (_, i) => ({ id: `league|generic|default|M7|n${i}`, planned: i % 2 === 0 }));
    const l2Case = (x: { id: string; planned: boolean }, i: number): CaseResult => ({
      ...workedCase(x.id), layer: "L2", driver: "browser", width: 390, l2: { n: i + 1, covers: ["row"], l3Gap: null },
      ...(x.planned ? { planned: true as const, state: "not_run" as const, reason: "no scenario script yet", checks: [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0 } : {}),
    });
    const ids = l2.map((x) => x.id);
    const inputs: ShardInput[] = [1, 2].map((k) => ({
      name: `l2-${k}`, exit: "0",
      results: { ...shardOf(ids, k, 2, { layer: "L2", driver: "browser", plan: "--layer L2 --scope grid", scope: "L2 (grid)" }), cases: stripe(l2, { index: k, of: 2 }).map((x) => l2Case(x, l2.indexOf(x))) },
    }));
    const { merged, checked } = mergeShards(inputs, "ci-1-1-l2");
    expect(checked).toBe(5);
    expect(merged.layer).toBe("L2");
    expect(merged.scope).toBe("L2 (grid)");
    const plannedCases = merged.cases.filter((c) => c.planned === true);
    expect(plannedCases).toHaveLength(3);
    expect(plannedCases.every((c) => isPlannedShape(c))).toBe(true);
    // The driven two stay driven, and every pair-run keeps its own n, in plan order.
    expect(merged.cases.filter((c) => c.planned === undefined).map((c) => c.caseId)).toEqual([ids[1], ids[3]]);
    expect(merged.cases.map((c) => c.l2?.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a second call on the same inputs is the same merge, and the inputs are untouched", () => {
    const s = all(3);
    const before = JSON.stringify(s);
    const a = mergeShards(s, "x");
    const b = mergeShards(s, "x");
    expect(b).toEqual(a);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("rule 10: for any plan and any shard count, the merge of the shards IN ANY ORDER is the plan; losing or shortening any one shard is refused by name", () => {
    let checked = 0;
    let refused = 0;
    fc.assert(fc.property(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 2, max: 6 }), fc.nat(), fc.boolean(), (n, of, spin, backwards) => {
      const p = Array.from({ length: n }, (_, i) => `league|generic|default|S${i}`);
      // Only the stripes that hold items are shards (run.ts refuses to write an empty one).
      const present = Array.from({ length: of }, (_, k) => k + 1).filter((k) => stripeSize(n, { index: k, of }) > 0);
      const inputs = present.map((k) => ({ name: `s${k}`, exit: "0", results: shardOf(p, k, of) as unknown }));
      const rot = spin % inputs.length;
      const arrival = [...inputs.slice(rot), ...inputs.slice(0, rot)];
      expect(mergeShards(backwards ? arrival.reverse() : arrival, "x").merged.cases.map((c) => c.caseId)).toEqual(p);
      checked++;
      // Any one shard lost — however many remain, including none — is a hole, refused.
      for (const lose of present) {
        expect(refusedAs(inputs.filter((i) => i.name !== `s${lose}`)), `lose s${lose} of ${present.length} (${n} items / ${of})`).toBe("ShardMissing");
        refused++;
      }
      // Any one shard short by one case: refused (a shard left with no case at all is ShardEmpty).
      for (const k of present) {
        const cut = inputs.map((i) => (i.name === `s${k}` ? { ...i, results: { ...(i.results as RunResults), cases: (i.results as RunResults).cases.slice(1) } } : i));
        const name = refusedAs(cut);
        expect(name === "ShardSize" || name === "ShardEmpty", `short s${k}: ${name}`).toBe(true);
        refused++;
      }
    }), { numRuns: 40 });
    expect(checked).toBe(40);
    expect(refused).toBeGreaterThan(40);
  });
});

// The CLI: `pnpm matrix:merge --run-id <id> --out <dir> <shardDir>...`, run as its package script.
const meter = new SpawnMeter(6);
describe("merge-shards CLI", { timeout: meter.budget }, () => {
  beforeEach(() => meter.reset());
  const root = mkdtempSync(join(tmpdir(), "w1d-merge-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const fresh = (): string => join(root, `case-${++n}`);
  /** Writes a shard dir: results.json (unless null) and exit.txt (unless null). */
  function shardDir(base: string, name: string, results: unknown | null, exit: string | null): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    if (results !== null) writeFileSync(join(dir, "results.json"), typeof results === "string" ? results : JSON.stringify(results));
    if (exit !== null) writeFileSync(join(dir, "exit.txt"), exit);
    return dir;
  }
  const argvOfScript = (): string[] => {
    const words = (scripts["matrix:merge"] ?? "").split(" ");
    expect(words[0], "matrix:merge runs node").toBe("node");
    expect(words.at(-1), "matrix:merge runs merge-shards.ts").toBe("tools/matrix/merge-shards.ts");
    return words.slice(1);
  };
  const merge = (...args: string[]) => {
    meter.tick();
    return spawnSync(process.execPath, [...argvOfScript(), ...args], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  };
  const threeShards = (base: string, exit: (k: number) => string | null = () => "0\n"): string[] => all(3).map((s, k) => shardDir(base, `shard-${k + 1}`, s.results, exit(k + 1)));

  it("the package script preloads crash-exit.ts, then runs merge-shards.ts", () => {
    expect(scripts["matrix:merge"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/merge-shards.ts");
  });

  it("three shard dirs with exit 0: exit 0, results.json and MATRIX.md written to --out, the line names the counts", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const out = join(base, "out");
    const r = merge("--run-id", "ci-1-1-l3", "--out", out, ...dirs);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`merged 7 cases from 3 shards → ${out}`);
    const merged = parseResults(JSON.parse(readFileSync(join(out, "results.json"), "utf8"))) as RunResults;
    expect(merged.cases.map((c) => c.caseId)).toEqual(plan);
    expect(merged.runId).toBe("ci-1-1-l3");
    expect(merged.shards).toBe(3);
    expect("shard" in merged).toBe(false);
    const md = readFileSync(join(out, "MATRIX.md"), "utf8");
    expect(md).toContain("run `ci-1-1-l3`");
    expect(md).toContain("| league |");
    expect(md).not.toContain("No cases run");
  });

  it("shard dirs given out of order merge to plan order (the dirs are arguments, not a sequence)", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const out = join(base, "out");
    const r = merge("--run-id", "ci-1-1-l3", "--out", out, dirs[2], dirs[0], dirs[1]);
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as RunResults).cases.map((c) => c.caseId)).toEqual(plan);
  });

  it("dirs missing exit.txt: exit 2, ShardFailed named, and nothing written to --out", () => {
    const base = fresh();
    const dirs = threeShards(base, (k) => (k === 2 ? null : "0\n"));
    const out = join(base, "out");
    const r = merge("--run-id", "ci-1-1-l3", "--out", out, ...dirs);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/merge-shards: ShardFailed: .*shard-2: no exit\.txt/);
    expect(existsSync(join(out, "results.json"))).toBe(false);
    expect(existsSync(join(out, "MATRIX.md"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("a shard that exited non-zero, one shard short, and one shard absent: each exit 2 by its own name, nothing written", () => {
    const cases: [string, (base: string) => string[], RegExp][] = [
      ["exit 3", (b) => threeShards(b, (k) => (k === 3 ? "3\n" : "0\n")), /ShardFailed: .*exit 3/],
      ["a missing shard", (b) => threeShards(b).slice(0, 2), /ShardMissing: shard 3\/3 is absent/],
      ["a short shard", (b) => all(3).map((s, k) => { const r = structuredClone(asRun(s)); if (k === 1) r.cases.pop(); return shardDir(b, `shard-${k + 1}`, r, "0\n"); }), /ShardSize: .*shard-2: 1 cases/],
    ];
    let checked = 0;
    for (const [what, make, why] of cases) {
      const base = fresh();
      const out = join(base, "out");
      const r = merge("--run-id", "ci-1-1-l3", "--out", out, ...make(base));
      expect(r.status, `${what}: ${r.stderr}`).toBe(2);
      expect(r.stderr, what).toMatch(why);
      expect(existsSync(out), what).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a missing, an empty and an unparseable results.json are exit 2 naming the dir; a shard dir that does not exist is ShardMissing", () => {
    let checked = 0;
    for (const [what, results, why] of [
      ["missing", null, /ShardEmpty: .*shard-2: no results\.json/],
      ["empty (0 bytes)", "", /ShardEmpty: .*shard-2: results\.json is empty/],
      ["whitespace only", "  \n", /ShardEmpty: .*shard-2: results\.json is empty/],
      ["not JSON", "{ nope", /ShardInvalid: .*shard-2: results\.json is not JSON/],
    ] as const) {
      const base = fresh();
      const dirs = threeShards(base);
      const out = join(base, "out");
      rmSync(dirs[1], { recursive: true });
      const dir = shardDir(base, "shard-2", results, "0\n");
      const r = merge("--run-id", "ci-1-1-l3", "--out", out, dirs[0], dir, dirs[2]);
      expect(r.status, `${what}: ${r.stderr}`).toBe(2);
      expect(r.stderr, what).toMatch(why);
      expect(existsSync(out), what).toBe(false);
      checked++;
    }
    const base = fresh();
    const dirs = threeShards(base);
    const gone = join(base, "no-such-shard");
    const r = merge("--run-id", "ci-1-1-l3", "--out", join(base, "out"), dirs[0], gone, dirs[2]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ShardMissing: .*no-such-shard/);
    checked++;
    expect(checked).toBe(5);
  });

  it("a secret in a shard: exit 2 ShardSecret, the value never printed, nothing written", () => {
    const base = fresh();
    const s = all(3);
    asRun(s[0]).cases[0].reason = "see\npostgres://u:hunter22@h/db";
    const dirs = s.map((x, k) => shardDir(base, `shard-${k + 1}`, x.results, "0\n"));
    const out = join(base, "out");
    const r = merge("--run-id", "ci-1-1-l3", "--out", out, ...dirs);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ShardSecret/);
    expect(r.stderr + r.stdout).not.toContain("hunter22");
    expect(existsSync(out)).toBe(false);
  });

  it("a --run-id that is not already its own slug is refused (it would name a different directory than the one asked for): exit 2, nothing written", () => {
    const base = fresh();
    const dirs = threeShards(base);
    let checked = 0;
    for (const id of ["CI-1-1-L3", "ci_1_1", "ci-1-1-l3 ", "ci-1-", "x".repeat(41), ""]) {
      const out = join(base, `out-${checked}`);
      const r = merge("--run-id", id, "--out", out, ...dirs);
      expect(r.status, `${JSON.stringify(id)}: ${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(id)).toMatch(/--run-id .* is not its own slug/);
      expect(existsSync(out), JSON.stringify(id)).toBe(false);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("usage errors are exit 2: no --run-id, no --out, no shard dir, an unknown flag", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const out = join(base, "out");
    let checked = 0;
    for (const argv of [
      ["--out", out, ...dirs], ["--run-id", "ci-1-1-l3", ...dirs], ["--run-id", "ci-1-1-l3", "--out", out], ["--bogus", "--run-id", "ci-1-1-l3", "--out", out, ...dirs], [],
    ]) {
      const r = merge(...argv);
      expect(r.status, `${argv.join(" ")}: ${r.stderr}`).toBe(2);
      expect(r.stderr, argv.join(" ")).toMatch(/usage: merge-shards\.ts/);
      expect(existsSync(out), argv.join(" ")).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a merge whose cases the grid cannot render is refused before anything is written (the dry render): exit 2, no results.json left behind", () => {
    const base = fresh();
    const s = all(3);
    // Every field the schema checks is valid; the case's row is simply not on the run's own grid, which renderMatrix refuses.
    asRun(s[1]).cases[0].row = "knockout";
    const dirs = s.map((x, k) => shardDir(base, `shard-${k + 1}`, x.results, "0\n"));
    const out = join(base, "out");
    const r = merge("--run-id", "ci-1-1-l3", "--out", out, ...dirs);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/merge-shards: .*knockout/);
    expect(existsSync(out)).toBe(false);
  });

  it("a bare `--` (the one pnpm 10 forwards from `pnpm run matrix:merge -- <flags>`) is dropped, never read as a shard dir", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const out = join(base, "out");
    const r = merge("--", "--run-id", "ci-1-1-l3", "--out", out, ...dirs);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(out, "results.json"))).toBe(true);
  });

  it("a single shard dir is refused too: one shard is no merge (the shard header says of >= 2)", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const r = merge("--run-id", "ci-1-1-l3", "--out", join(base, "out"), dirs[0]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ShardMissing: shard 2\/3 is absent/);
  });

  it("the merge is deterministic: the same shard dirs, merged twice, write byte-identical files", () => {
    const base = fresh();
    const dirs = threeShards(base);
    const a = join(base, "out-a");
    const b = join(base, "out-b");
    expect(merge("--run-id", "ci-1-1-l3", "--out", a, ...dirs).status).toBe(0);
    expect(merge("--run-id", "ci-1-1-l3", "--out", b, ...dirs).status).toBe(0);
    for (const f of ["results.json", "MATRIX.md"]) expect(readFileSync(join(a, f), "utf8"), f).toBe(readFileSync(join(b, f), "utf8"));
  });
});
