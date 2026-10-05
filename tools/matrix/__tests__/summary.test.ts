// W1d Task 8 (D1a, D5, D20; PF-1, ruling 61): SUMMARY.md. Every expected number below is counted by hand from the fixture
// (the comment beside it says how), never derived from summary(). The verdict tests all start from ONE all-green fixture
// and change ONE thing, so each "no" is witnessed against the "yes" it departs from (a negative needs its positive pair).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GhRunner } from "../ci/gh.ts";
import { GREEN_RUNS, main, percentile, summary, type JudgeInput, type Previous, type PreviousInput, type SummaryDeps } from "../ci/summary.ts";
import { parseJudgeOut, type JudgeOut } from "../lib/judge.ts";
import { findSecrets } from "../lib/redact.ts";
import { LAYERS, parseResults, type CaseResult, type Layer, type RunResults } from "../lib/results.ts";
import { main as judgeMain } from "../judge.ts";
import { runSlice } from "../run.ts";
import { deps as runDeps, fakeBrowserRun } from "./run-deps.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const NOW = new Date("2026-10-04T12:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "w1d-summary-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// --- fixtures --------------------------------------------------------------------------------------------------

type CaseSpec = Partial<Omit<CaseResult, "caseId">> & { caseId: string };
/** One case. L1 and L2 are browser runs at 1280, L3 is http (D9). */
const kase = (layer: Layer, o: CaseSpec): CaseResult => ({
  row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, state: "works", reason: "", checks: [], counts: { calls: 0, fixtures: 0, events: 0 },
  durationMs: 1000, notes: [], layer, driver: layer === "L3" ? "http" : "browser", width: layer === "L3" ? null : 1280, ...o,
});
const planned = (layer: Layer, caseId: string, scenario: string, state: "not_run" | "no_path" = "not_run"): CaseResult =>
  kase(layer, { caseId, scenario, state, planned: true, durationMs: 0, reason: state === "not_run" ? "no harness script for this atom" : "no path" });
/** A valid merged v3 run (parseResults vouches for the fixture). */
const mergedRun = (layer: Layer, runId: string, cases: CaseResult[], extra: Record<string, unknown> = {}): RunResults =>
  parseResults({ schemaVersion: 3, runId, harnessCommit: "abc1234", startedAt: "2026-10-04T00:00:00Z", finishedAt: "2026-10-04T01:00:00Z", grid: { rows: ["league"], sports: ["generic"] }, layer, driver: layer === "L3" ? "http" : "browser", plan: `--layer ${layer}`, scope: `${layer} (grid)`, shards: 2, cases, ...extra }) as RunResults;
const judgeOut = (o: Partial<JudgeOut>): JudgeOut => parseJudgeOut({ version: 1, mode: "across", exit: 0, layer: "L1", runs: ["ci-7-1-l1", "ci-8-1-l1", "ci-9-1-l1"], plannedNotRun: "allow", compared: 10, faults: [], differing: [], missing: [], regressed: [], absent: [], ...o });
const ID = (l: Layer): string => `ci-9-1-${l.toLowerCase()}`;
const threeOf = (l: Layer): string[] => [`ci-7-1-${l.toLowerCase()}`, `ci-8-1-${l.toLowerCase()}`, ID(l)];

const baseCases = (l: Layer): CaseResult[] => [kase(l, { caseId: `c1-${l}` }), kase(l, { caseId: `c2-${l}`, durationMs: 2000 }), planned(l, `p1-${l}`, "A1")];
const allRuns = (): Record<Layer, RunResults | null> => ({ L1: mergedRun("L1", ID("L1"), baseCases("L1")), L2: mergedRun("L2", ID("L2"), baseCases("L2")), L3: mergedRun("L3", ID("L3"), baseCases("L3")) });
const greenJudges = (): JudgeInput[] => LAYERS.map((l) => ({ path: `merged/${l}/across.json`, out: judgeOut({ layer: l, runs: threeOf(l) }) }));
const VERDICT = /\*\*Harness-green: [^*]+\*\*/;
const verdictOf = (md: string): string => VERDICT.exec(md)?.[0] ?? "(no verdict line)";

// --- the page --------------------------------------------------------------------------------------------------

describe("summary: the previous run line (D1a) — the empty case first", () => {
  it("no previous run -> `Previous harness-green run: none yet`, and the diff section says there is nothing to diff", () => {
    const md = summary(allRuns(), [], null, NOW);
    expect(md).toContain("Previous harness-green run: none yet");
    expect(md).toContain("No weekly diff: there is no previous harness-green run yet.");
    expect(md.split("\n")[2]).toBe("Previous harness-green run: none yet"); // it OPENS the page, under the title
  });

  it("a previous run is named by date, days ago and id: 2026-09-27 -> 7 days before 2026-10-04 12:00", () => {
    const prev: Previous = { runId: 77, date: "2026-09-27T02:17:00Z", layers: {} };
    const md = summary(allRuns(), [], prev, NOW);
    expect(md).toContain("Previous harness-green run: 2026-09-27 (7 days ago) — run 77");
    // The day count follows the clock it is given, not a constant.
    expect(summary(allRuns(), [], prev, new Date("2026-10-20T12:00:00Z"))).toContain("(23 days ago)");
  });

  it("an unavailable previous run is a line carrying the reason, and the page still renders in full", () => {
    const md = summary(allRuns(), [], { unavailable: "gh run download 12: HTTP 404" }, NOW);
    expect(md).toContain("Previous run unavailable: gh run download 12: HTTP 404");
    expect(md).toContain("No weekly diff this time: the previous run could not be read.");
    expect(md).toContain("## Layers");
    expect(md).toContain("## Timings");
  });
});

describe("summary: the layer table — the histogram, counted by hand", () => {
  // L1: works x3, refused x1, red x1 (a product red, not a fault), later x1, needs_ruling x1, no_path x2 (planned),
  //     not_run planned x3 (atoms A1 x2, A2 x1) and not_run UNplanned x1 -> cases 13, driven 8 (everything but the 5 planned).
  const l1 = (): CaseResult[] => [
    kase("L1", { caseId: "w1", durationMs: 1000 }), kase("L1", { caseId: "w2", durationMs: 2000 }), kase("L1", { caseId: "w3", durationMs: 3000 }),
    kase("L1", { caseId: "rf", state: "refused", reason: "refused as the rulebook says" }),
    kase("L1", { caseId: "rd", state: "red", reason: "invariant X failed" }),
    kase("L1", { caseId: "lt", state: "later", reason: "wave 3" }),
    kase("L1", { caseId: "nr", state: "needs_ruling", reason: "ruling needed" }),
    planned("L1", "np1", "A1", "no_path"), planned("L1", "np2", "A2", "no_path"),
    planned("L1", "pn1", "A1"), planned("L1", "pn2", "A1"), planned("L1", "pn3", "A2"),
    kase("L1", { caseId: "un", state: "not_run", reason: "not run" }),
  ];
  const md = summary({ ...allRuns(), L1: mergedRun("L1", "ci-9-1-l1", l1()) }, [], null, NOW);

  it("the row counts every state, planned ░ apart from unplanned ░", () => {
    expect(l1()).toHaveLength(13);
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 | 2 | 13 | 8 | 3 | 1 | 1 | 1 | 1 | 2 | 3 | 1 |");
    // …under a header that names those columns in the same order.
    expect(md).toContain("| layer | scope | run | shards | cases | driven | ✅ works | ⛔ refused | ❌ red | ⏳ later | ⬜ needs_ruling | 🚫 no_path | ░ planned | ░ unplanned |");
  });

  it("the other layers' rows are their own (3 cases, 2 driven, 1 planned ░)", () => {
    expect(md).toContain("| L2 | L2 (grid) | ci-9-1-l2 | 2 | 3 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |");
    expect(md).toContain("| L3 | L3 (grid) | ci-9-1-l3 | 2 | 3 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |");
  });

  it("the planned ░ are counted per atom, biggest first — A1 x2 then A2 x1 — and only for ░ (a planned 🚫 is not in it)", () => {
    const section = md.slice(md.indexOf("## Planned ░ by atom"), md.indexOf("## Harness faults"));
    expect(section).toContain("**L1** — 3 planned ░ across 2 atoms:");
    expect(section.indexOf("| A1 | 2 |")).toBeGreaterThan(-1);
    expect(section.indexOf("| A1 | 2 |")).toBeLessThan(section.indexOf("| A2 | 1 |"));
    // The 🚫 planned cases (np1 of A1, np2 of A2) did not add to either atom.
    expect(section).not.toContain("| A1 | 3 |");
    expect(section).not.toContain("| A2 | 2 |");
    // L2 and L3 each planned one ░ of atom A1.
    expect(section).toContain("**L2** — 1 planned ░ across 1 atom:");
  });

  it("the atoms are ordered by their COUNT, then by name — a count order and an alphabetical order that disagree", () => {
    // Z x3, M x2, B x2, A x1: alphabetical would read A, B, M, Z; by count it is Z, then the tied B and M by name, then A.
    const cases = [
      planned("L1", "z1", "Z"), planned("L1", "z2", "Z"), planned("L1", "z3", "Z"),
      planned("L1", "m1", "M"), planned("L1", "m2", "M"), planned("L1", "b1", "B"), planned("L1", "b2", "B"), planned("L1", "a1", "A"),
    ];
    const md2 = summary({ ...allRuns(), L1: mergedRun("L1", ID("L1"), cases) }, [], null, NOW);
    const section = md2.slice(md2.indexOf("## Planned ░ by atom"), md2.indexOf("## Harness faults"));
    expect(section).toContain("**L1** — 8 planned ░ across 4 atoms:");
    const order = ["| Z | 3 |", "| B | 2 |", "| M | 2 |", "| A | 1 |"].map((row) => section.indexOf(row));
    expect(order.every((i) => i > -1), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("a run that was not sharded (no `shards` in its results) is one shard in the layers table, and a sharded one shows its count", () => {
    const one = summary({ ...allRuns(), L1: mergedRun("L1", ID("L1"), baseCases("L1"), { shards: undefined }) }, [], null, NOW);
    expect(one).toContain("| L1 | L1 (grid) | ci-9-1-l1 | 1 | 3 | 2 |");
    expect(one).toContain("| L2 | L2 (grid) | ci-9-1-l2 | 2 | 3 | 2 |");
  });

  it("a layer whose plan has no planned ░ says so rather than printing an empty table", () => {
    const none = summary({ ...allRuns(), L2: mergedRun("L2", ID("L2"), [kase("L2", { caseId: "x" }), planned("L2", "y", "A1", "no_path")]) }, [], null, NOW);
    expect(none).toMatch(/- L2: no planned ░/);
  });

  it("an unplanned ░ is a harness fault, listed with its kind (D6) — and the faults line counts it", () => {
    expect(md).toContain("Harness faults in this run: 1 (L1 1).");
    expect(md).toContain("**L1** — 1 fault: unplanned-not-run");
    expect(md).toContain("- [unplanned-not-run] `un` — not run");
  });
});

describe("summary: timings — p50/p90/max of the DRIVEN cases only", () => {
  const ten = (): CaseResult[] => Array.from({ length: 10 }, (_, i) => kase("L3", { caseId: `t${i + 1}`, durationMs: (i + 1) * 1000 }));
  const seven = (): CaseResult[] => Array.from({ length: 7 }, (_, i) => kase("L1", { caseId: `s${i + 1}`, durationMs: (i + 1) * 100 }));

  it("nearest rank, by hand: ten cases 1..10 s -> p50 5.0, p90 9.0, max 10.0; seven cases 100..700 ms -> p50 0.4, p90 0.7, max 0.7", () => {
    const runs = { L1: mergedRun("L1", ID("L1"), seven()), L2: mergedRun("L2", ID("L2"), [planned("L2", "a", "A1"), planned("L2", "b", "A1")]), L3: mergedRun("L3", ID("L3"), ten()) };
    const md = summary(runs, [], null, NOW);
    expect(md).toContain("| L1 | 7 | 0.4 s | 0.7 s | 0.7 s |");
    expect(md).toContain("| L3 | 10 | 5.0 s | 9.0 s | 10.0 s |");
  });

  it("planned cases (durationMs 0) are not measurements: five of them beside the ten change nothing", () => {
    const withPlanned = [...ten(), ...Array.from({ length: 5 }, (_, i) => planned("L3", `p${i}`, "A1"))];
    const md = summary({ ...allRuns(), L3: mergedRun("L3", ID("L3"), withPlanned) }, [], null, NOW);
    expect(md).toContain("| L3 | 10 | 5.0 s | 9.0 s | 10.0 s |");
    expect(md).not.toContain("| L3 | 15 |");
  });

  it("a layer that drove nothing has no timings (an em dash, never NaN or 0), and a missing layer likewise", () => {
    const md = summary({ ...allRuns(), L2: mergedRun("L2", ID("L2"), [planned("L2", "a", "A1")]), L3: null }, [], null, NOW);
    expect(md).toContain("| L2 | 0 | — | — | — |");
    expect(md).toContain("| L3 | 0 | — | — | — |");
    expect(md).not.toMatch(/NaN|Infinity/);
  });

  it("percentile: the smallest value with at least q of the list at or below it; an empty list has none", () => {
    const xs = [10, 20, 30, 40];
    expect([percentile(xs, 50), percentile(xs, 90), percentile(xs, 100), percentile(xs, 1)]).toEqual([20, 40, 40, 10]);
    expect(percentile([7], 50)).toBe(7);
    expect(() => percentile([], 50)).toThrow(/empty/);
    // A rank that lands on a boundary stays there: 90% of 10 is exactly the 9th, 50% of 7 is the 4th (3.5 rounds up).
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 91)).toBe(10);
    expect(percentile(Array.from({ length: 7 }, (_, i) => i + 1), 50)).toBe(4);
    // A percent that is no whole number in 1..100 is refused, not rounded.
    for (const bad of [0, 101, 0.5, 90.5, Number.NaN]) expect(() => percentile(xs, bad), String(bad)).toThrow(/whole percent/);
  });
});

describe("summary: a missing layer is a line, never a silent omission", () => {
  it("a layer with no merged run has its own row of dashes, a line saying why, and the verdict is not green", () => {
    const runs = { ...allRuns(), L2: null };
    const md = summary(runs, greenJudges(), null, NOW);
    expect(md).toContain("| L2 | — | — | — | — | — |");
    expect(md).toContain("- L2: no merged run — its merge was refused, no shard ran");
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("L2: no merged run to judge");
    // The other two layers are still reported.
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 |");
    expect(md).toContain("| L3 | L3 (grid) | ci-9-1-l3 |");
  });

  it("all three missing is still a page, with three lines", () => {
    const md = summary({ L1: null, L2: null, L3: null }, [], null, NOW);
    expect((md.match(/: no merged run — /g) ?? []).length).toBe(3);
    expect(md).toContain("Harness faults in this run: none (0 of 3 layers present)");
  });
});

describe("summary: the weekly diff (D20)", () => {
  const prevRun = (l: Layer, cases: CaseResult[]): RunResults => mergedRun(l, `prev-${l}`, cases);

  it("lists every move — ✅→❌ and ❌→✅ — by case, with the counts, and counts what was added and removed", () => {
    // before: c1 works, c2 works, c3 red, c4 works.  now: c1 red (✅→❌), c2 works, c3 works (❌→✅), c5 new (c4 gone).
    const before = prevRun("L1", [kase("L1", { caseId: "c1" }), kase("L1", { caseId: "c2" }), kase("L1", { caseId: "c3", state: "red", reason: "x failed" }), kase("L1", { caseId: "c4" })]);
    const now = mergedRun("L1", ID("L1"), [kase("L1", { caseId: "c1", state: "red", reason: "y failed" }), kase("L1", { caseId: "c2" }), kase("L1", { caseId: "c3" }), kase("L1", { caseId: "c5" })]);
    const md = summary({ ...allRuns(), L1: now }, [], { runId: 77, date: "2026-09-27T00:00:00Z", layers: { L1: before } }, NOW);
    const diff = md.slice(md.indexOf("## Weekly diff"));
    expect(diff).toContain("2 cases changed state since run 77 (3 compared):");
    expect(diff).toContain("- L1: 3 cases in both runs, 1 added and 1 removed since");
    expect(diff).toContain("✅→❌ (1): `c1`");
    expect(diff).toContain("❌→✅ (1): `c3`");
    expect(diff).not.toContain("`c2`"); // unchanged
    expect(diff).not.toContain("`c4`"); // removed, not a move
    expect(diff).not.toContain("`c5`"); // added, not a move
    // The layers the previous run lacks are named, not skipped.
    expect(diff).toContain("- L2: the previous run's merged results hold no L2");
    expect(diff).not.toMatch(/no state changed in the/i);
  });

  it("says `no state changed` when none did, with how many cases it compared (not a vacuous yes)", () => {
    const layers = Object.fromEntries(LAYERS.map((l) => [l, prevRun(l, baseCases(l))])) as Partial<Record<Layer, RunResults>>;
    const md = summary(allRuns(), [], { runId: 5, date: "2026-09-20T00:00:00Z", layers }, NOW);
    expect(md).toContain("No state changed in the 9 cases both runs hold (compared with run 5).");
    // 3 layers x 3 cases each.
    expect(md).not.toContain("changed state since");
  });

  it("a previous run that shares no case is `nothing to compare`, never `no state changed`", () => {
    const other = { L1: prevRun("L1", [kase("L1", { caseId: "zz" })]) };
    const md = summary(allRuns(), [], { runId: 5, date: "2026-09-20T00:00:00Z", layers: other }, NOW);
    expect(md).toContain("Nothing to compare with run 5: it shares no case with this run.");
    expect(md).not.toContain("No state changed");
  });

  it("every transition is spelled with its two glyphs, and the longest list is cut with a count", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, "0")}`);
    const before = prevRun("L3", ids.map((id) => kase("L3", { caseId: id })));
    const now = mergedRun("L3", ID("L3"), ids.map((id) => kase("L3", { caseId: id, state: "later", reason: "wave 4" })));
    const md = summary({ ...allRuns(), L3: now }, [], { runId: 8, date: "2026-09-27T00:00:00Z", layers: { L3: before } }, NOW);
    expect(md).toContain("✅→⏳ (30):");
    expect(md).toContain("… and 5 more"); // 25 listed, 5 more
    expect(md).toContain("`m00`");
    expect(md).not.toContain("`m29`");
  });
});

describe("summary: harness faults of THIS run, by the judge's own authority", () => {
  it("a crash is listed with its kind and its reason; the faults line names the layer", () => {
    const cases = [kase("L2", { caseId: "ok" }), kase("L2", { caseId: "boom", state: "red", reason: "error: crashed — worker died" }), kase("L2", { caseId: "tm", state: "red", reason: "error: TimeoutError: 30000 ms" })];
    const md = summary({ ...allRuns(), L2: mergedRun("L2", ID("L2"), cases) }, [], null, NOW);
    expect(md).toContain("Harness faults in this run: 2 (L2 2).");
    expect(md).toContain("**L2** — 2 faults: crash 1, harness-error 1");
    expect(md).toContain("- [crash] `boom` — error: crashed — worker died");
    // The product answering is data, not a fault.
    const data = summary({ ...allRuns(), L2: mergedRun("L2", ID("L2"), [kase("L2", { caseId: "p5", state: "red", reason: "error: RefusedCall: POST /withdraw → HTTP 422 WRONG_PHASE" })]) }, [], null, NOW);
    expect(data).toContain("Harness faults in this run: none (3 of 3 layers present)");
  });
});

describe("summary: redaction — the page passes findSecrets with zero hits", () => {
  it("a fault reason that carries a secret and an email: the secret is gone, the line stays, findSecrets is empty", () => {
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    const reason = `error: crashed — api_key=${secret} while mailing ops@example.com`;
    const md = summary({ ...allRuns(), L1: mergedRun("L1", ID("L1"), [kase("L1", { caseId: "leak", state: "red", reason })]) }, [], { unavailable: `gh api: token=${secret}` }, NOW);
    expect(findSecrets(md)).toEqual([]);
    expect(md).not.toContain(secret);
    expect(md).toContain("- [crash] `leak`"); // the positive: the fault is still listed
    expect(md).toContain("[redacted]");
    expect(findSecrets(reason).length, "the fixture IS a secret as written").toBeGreaterThan(0);
  });
});

describe("summary: the verdict — fails safe (PF-1, ruling 61)", () => {
  it("the positive: three layers, each with a `judge across` verdict over exactly 3 runs bound to its merged run -> harness-green yes", () => {
    expect(GREEN_RUNS).toBe(3);
    const md = summary(allRuns(), greenJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: yes**");
    expect(md).toContain("identical across exactly 3 runs, with no harness fault (ruling 61)");
    expect(md).toContain("- `merged/L2/across.json`: L2 across over 3 runs (ci-7-1-l2, ci-8-1-l2, ci-9-1-l2) — exit 0, 10 cases compared, 0 faults, 0 differing, 0 regressed");
  });

  it("no judge at all is `not judged`, never yes — and it says what would make it green", () => {
    const md = summary(allRuns(), [], null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: not judged**");
    expect(md).toContain("judge across");
    expect(md).toContain("No `--judge` file was given.");
  });

  it("a MISSING judge file is `judge refused`, and never green — even with the other layers judged clean", () => {
    const judges: JudgeInput[] = [...greenJudges().slice(0, 2), { path: "merged/L3/across.json", refused: "the file is missing — a refused judge writes none, so this run has no verdict from it" }];
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("judge refused: merged/L3/across.json");
    expect(md).toContain("- `merged/L3/across.json`: judge refused");
    // L3 has no verdict bound either, so there are two reasons, not one.
    expect(md).toContain("L3: no `judge across` verdict is bound to run ci-9-1-l3");
  });

  it("a STALE file — a verdict of earlier runs, whose ids do not name this merged run — is not this run's verdict", () => {
    const judges = greenJudges();
    judges[0] = { path: "merged/L1/across.json", out: judgeOut({ layer: "L1", runs: ["ci-1-1-l1", "ci-2-1-l1", "ci-3-1-l1"] }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("a stale verdict, ignored");
    expect(md).toContain("L1: no `judge across` verdict is bound to run ci-9-1-l1 (a judge file for this layer judged other runs)");
  });

  it("a file for the wrong LAYER does not bind: L1's merged run has no verdict if the only file names L2", () => {
    const judges = greenJudges();
    judges[0] = { path: "merged/L1/across.json", out: judgeOut({ layer: "L2", runs: threeOf("L1") }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("L1: no `judge across` verdict is bound to run ci-9-1-l1");
  });

  it("exactly 3 runs: two are not enough, and four are not either (ruling 61 says three)", () => {
    for (const runs of [2, 4, 5]) {
      const judges = greenJudges();
      const ids = Array.from({ length: runs }, (_, i) => (i === runs - 1 ? ID("L2") : `ci-${i}-1-l2`));
      judges[1] = { path: "merged/L2/across.json", out: judgeOut({ layer: "L2", runs: ids }) };
      const md = summary(allRuns(), judges, null, NOW);
      expect(verdictOf(md), `${runs} runs`).toBe("**Harness-green: no**");
      expect(md, `${runs} runs`).toContain(`L2: judged ${runs} runs; harness-green needs exactly 3 (ruling 61)`);
    }
  });

  it("an across verdict with a difference or a fault is not green, and says how many", () => {
    const judges = greenJudges();
    judges[2] = { path: "merged/L3/across.json", out: judgeOut({ layer: "L3", runs: threeOf("L3"), exit: 1, differing: [{ caseId: "d1", states: ["works", "red"] }], faults: [{ run: ID("L3"), caseId: "f1", kind: "crash", reason: "error: crashed — x" }, { run: ID("L3"), caseId: "f2", kind: "vacuous", reason: "no checks ran (vacuous)" }] }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("L3: 1 differing, 2 harness faults across the runs");
  });

  it("a `faults` verdict (one run) or a `regression` verdict is not the ruling-61 claim: all-faults judges leave every layer unjudged", () => {
    const faultsOnly: JudgeInput[] = LAYERS.map((l) => ({ path: `merged/${l}/faults.json`, out: judgeOut({ mode: "faults", layer: l, runs: [ID(l)] }) }));
    const md = summary(allRuns(), faultsOnly, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    for (const l of LAYERS) expect(md).toContain(`${l}: no \`judge across\` verdict is bound to run ${ID(l)}`);
    // …and the clean faults verdicts are still shown as what they are.
    expect(md).toContain("L1 faults over 1 run (ci-9-1-l1) — exit 0");
    const regression: JudgeInput[] = LAYERS.map((l) => ({ path: `r/${l}.json`, out: judgeOut({ mode: "regression", layer: l, runs: [ID(l)], plannedNotRun: null }) }));
    expect(verdictOf(summary(allRuns(), regression, null, NOW))).toBe("**Harness-green: no**");
  });

  it("a faults verdict that found faults blocks green even beside a clean across verdict", () => {
    const judges = [...greenJudges(), { path: "merged/L1/faults.json", out: judgeOut({ mode: "faults", layer: "L1", runs: [ID("L1")], exit: 1, faults: [{ run: ID("L1"), caseId: "f", kind: "crash", reason: "error: crashed — x" }] }) } as JudgeInput];
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("L1: 1 harness fault in this run");
  });

  it("two across verdicts for one layer, one clean and one not: not green (every bound verdict must hold)", () => {
    const judges = [...greenJudges(), { path: "merged/L2/across-2.json", out: judgeOut({ layer: "L2", runs: threeOf("L2"), exit: 1, differing: [{ caseId: "d", states: ["works", "red"] }] }) } as JudgeInput];
    expect(verdictOf(summary(allRuns(), judges, null, NOW))).toBe("**Harness-green: no**");
  });

  it("a clean judge cannot paper over faults the merged results themselves hold", () => {
    const runs = { ...allRuns(), L1: mergedRun("L1", ID("L1"), [...baseCases("L1"), kase("L1", { caseId: "boom", state: "red", reason: "error: crashed — x" })]) };
    const md = summary(runs, greenJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("L1: this run's merged results hold 1 harness fault that no judge verdict shows");
  });

  it("the judge file of a regression of a v2 run names no layer, and binds to nothing", () => {
    const md = summary(allRuns(), [...greenJudges(), { path: "r/none.json", out: judgeOut({ mode: "regression", layer: null, runs: ["old"], plannedNotRun: null }) }], null, NOW);
    expect(md).toContain("`r/none.json`: regression names no layer; it binds to none of this run's layers.");
    expect(verdictOf(md)).toBe("**Harness-green: yes**"); // it is simply not one of the verdicts
  });
});

// --- the CLI ---------------------------------------------------------------------------------------------------

/** Writes `<dir>/<layer>/results.json` for each run given. */
function writeMerged(dir: string, runs: Partial<Record<Layer, RunResults>>): void {
  for (const l of LAYERS) {
    const r = runs[l];
    if (r === undefined) continue;
    mkdirSync(join(dir, l), { recursive: true });
    writeFileSync(join(dir, l, "results.json"), JSON.stringify(r));
  }
}
const fresh = (name: string): string => { const d = join(scratch, `${name}-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; };
const written = (p: string): string => readFileSync(p, "utf8");
const wireRun = (id: number, daysAgo: number, event = "schedule") => ({ id, event, conclusion: "success", created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() });

/** A gh that lists the given runs and "downloads" a run's merged artifact by writing the layers it holds. */
function fakeGh(list: ReturnType<typeof wireRun>[], artifacts: Record<number, Partial<Record<Layer, RunResults>>> = {}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "api") return { status: 0, stdout: JSON.stringify({ workflow_runs: list }), stderr: "" };
    if (args[0] === "run" && args[1] === "download") {
      const id = Number(args[2]);
      const into = args[args.indexOf("-D") + 1];
      if (artifacts[id] === undefined) return { status: 1, stdout: "", stderr: "no valid artifacts found to download" };
      writeMerged(into, artifacts[id]);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected gh call" };
  };
  return { gh, calls };
}

describe("main (the CLI)", () => {
  const io = { out: "", err: "" };
  beforeEach(() => {
    io.out = ""; io.err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { io.out += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { io.err += String(s); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const deps = (gh: GhRunner, env: Record<string, string | undefined> = { GITHUB_REPOSITORY: "acme/seazn", GITHUB_RUN_ID: "9" }): SummaryDeps => ({ gh, env, now: () => NOW });
  const noGh: GhRunner = () => { throw new Error("gh must not be called"); };
  const runs = (): Partial<Record<Layer, RunResults>> => ({ L1: mergedRun("L1", ID("L1"), baseCases("L1")), L2: mergedRun("L2", ID("L2"), baseCases("L2")), L3: mergedRun("L3", ID("L3"), baseCases("L3")) });

  it("reads each layer's results.json and the judge files, writes the page, exit 0 — a green verdict end to end", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const judgeArgs = LAYERS.flatMap((l) => { const f = join(dir, `${l}-across.json`); writeFileSync(f, JSON.stringify(judgeOut({ layer: l, runs: threeOf(l) }))); return ["--judge", f]; });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, ...judgeArgs, "--previous-run", "none", "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(verdictOf(md)).toBe("**Harness-green: yes**");
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 | 2 | 3 | 2 |");
    expect(md).toContain("Previous harness-green run: none yet");
    expect(io.out).toBe(`summary: wrote ${out} (3 of 3 layers)\n`);
  });

  it("the seam: a REAL run (runSlice) and a REAL verdict file (judge.ts --json-out) are read and bound by the summary", async () => {
    // Class 1: a fixture on both ends proves the fixture. Here the run is the runner's own L1 slice over fakes, the verdict is
    // judge.ts's own writer over that run, and the id that binds them is the one the runner wrote — none of it typed here.
    const dir = fresh("seam"); const reports = fresh("reports");
    expect(await runSlice(runDeps({ openBrowserRun: async () => fakeBrowserRun().run }), ["--driver", "browser", "--layer", "L1", "--run-id", "ci-9-1-l1", "--report-dir", reports])).toBeLessThanOrEqual(1);
    mkdirSync(join(dir, "L1"), { recursive: true });
    writeFileSync(join(dir, "L1", "results.json"), readFileSync(join(reports, "ci-9-1-l1", "results.json")));
    const judgeFile = join(dir, "L1-faults.json");
    const code = judgeMain(["faults", join(dir, "L1", "results.json"), "--json-out", judgeFile]);
    expect([0, 1]).toContain(code);
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--judge", judgeFile, "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(md).toContain(`\`${judgeFile}\`: L1 faults over 1 run (ci-9-1-l1) — exit ${code}`);
    expect(md).not.toContain("judge refused");
    expect(md).not.toContain("a stale verdict");
    // The judge's own count of this run's faults is the summary's own (one authority, two readers).
    const judged = JSON.parse(readFileSync(judgeFile, "utf8")) as JudgeOut;
    expect(md).toContain(`Harness faults in this run: ${judged.faults.length === 0 ? "none (1 of 3 layers present)" : `${judged.faults.length} (L1 ${judged.faults.length})`}.`);
  }, 60_000);

  it("a judge file that does not exist is `judge refused` in the page (exit 0, the page still written) and the verdict is not green", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const good = LAYERS.slice(0, 2).flatMap((l) => { const f = join(dir, `${l}.json`); writeFileSync(f, JSON.stringify(judgeOut({ layer: l, runs: threeOf(l) }))); return ["--judge", f]; });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, ...good, "--judge", join(dir, "L3-never-written.json"), "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(verdictOf(md)).toBe("**Harness-green: no**");
    expect(md).toContain("judge refused: ");
    expect(md).toContain("L3-never-written.json");
  });

  it("a judge file that is not a verdict, or that contradicts itself, is `judge refused` too", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const junk = join(dir, "junk.json"); writeFileSync(junk, "{ not json");
    const wrongShape = join(dir, "shape.json"); writeFileSync(wrongShape, JSON.stringify({ version: 1 }));
    // exit 0 with a fault listed: edited by hand, or half written.
    const liar = join(dir, "liar.json");
    writeFileSync(liar, JSON.stringify({ ...judgeOut({ layer: "L1", runs: threeOf("L1") }), faults: [{ run: ID("L1"), caseId: "f", kind: "crash", reason: "error: crashed — x" }] }));
    // exit 1 with nothing listed: a verdict that says "found something" and names nothing.
    const mute = join(dir, "mute.json");
    writeFileSync(mute, JSON.stringify({ ...judgeOut({ layer: "L2", runs: threeOf("L2") }), exit: 1 }));
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--judge", junk, "--judge", wrongShape, "--judge", liar, "--judge", mute, "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect((md.match(/judge refused: /g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(md).toContain("the verdict contradicts itself (exit 1 but it lists no finding)");
    expect(md).toContain("is not a judge verdict");
    expect(md).toContain("the verdict contradicts itself (exit 0 but it lists 1 finding(s))");
    expect(verdictOf(md)).toBe("**Harness-green: no**");
  });

  it("a layer directory that is absent, or holds something that is not that layer's results, is a missing layer (exit 0, a line, a note on stderr)", () => {
    const dir = fresh("m");
    writeMerged(dir, { L1: runs().L1!, L3: mergedRun("L3", ID("L3"), baseCases("L3")) });
    mkdirSync(join(dir, "L2"), { recursive: true });
    writeFileSync(join(dir, "L2", "results.json"), JSON.stringify(mergedRun("L1", "wrong", baseCases("L1")))); // L1's run in L2's slot
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(md).toContain("- L2: no merged run — ");
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 |");
    expect(io.err).toMatch(/L2: .*holds layer L1, not L2/);
    // A committed v2 results file (W1a/W1b evidence) is no layer's merged run, and says so by its OWN reason.
    const v2 = fresh("v2");
    mkdirSync(join(v2, "L1"), { recursive: true });
    const { layer: _l, driver: _d, width: _w, ...v2case } = kase("L1", { caseId: "old" });
    writeFileSync(join(v2, "L1", "results.json"), JSON.stringify({ schemaVersion: 2, runId: "old", harnessCommit: "abc1234", startedAt: "2026-10-04T00:00:00Z", finishedAt: "2026-10-04T01:00:00Z", grid: { rows: ["league"], sports: ["generic"] }, cases: [v2case] }));
    io.err = "";
    expect(main(["--merged", v2, "--out", join(v2, "SUMMARY.md")], deps(noGh))).toBe(0);
    expect(io.err).toMatch(/L1: .*not a v3 run/);
    expect(written(join(v2, "SUMMARY.md"))).toContain("- L1: no merged run — ");
    // A completely empty merged dir is three missing layers.
    io.err = "";
    const empty = fresh("e");
    expect(main(["--merged", empty, "--out", join(empty, "SUMMARY.md")], deps(noGh))).toBe(0);
    expect((written(join(empty, "SUMMARY.md")).match(/: no merged run — /g) ?? []).length).toBe(3);
  });

  it("--previous-run auto: the newest scheduled/dispatch success that is NOT this run is downloaded and diffed", () => {
    const dir = fresh("a"); writeMerged(dir, runs());
    // This run is 9 (just succeeded, so it is in the list); 50 is a pull_request; 40 the previous weekly; 30 older.
    const prev = { L1: mergedRun("L1", "ci-40-1-l1", [kase("L1", { caseId: "c1-L1", state: "red", reason: "was red" }), kase("L1", { caseId: "c2-L1", durationMs: 2000 }), planned("L1", "p1-L1", "A1")]) };
    const { gh, calls } = fakeGh([wireRun(9, 0), wireRun(50, 1, "pull_request"), wireRun(40, 6), wireRun(30, 13)], { 40: prev });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--previous-run", "auto", "--out", out], deps(gh))).toBe(0);
    const md = written(out);
    expect(md).toContain("Previous harness-green run: 2026-09-28 (6 days ago) — run 40");
    expect(md).toContain("1 case changed state since run 40 (3 compared):");
    expect(md).toContain("❌→✅ (1): `c1-L1`");
    // Exactly one run was downloaded: 40 (not 9 — itself — and not the PR's 50).
    const downloads = calls.filter((c) => c[1] === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].slice(0, 5)).toEqual(["run", "download", "40", "-n", "merged"]);
    expect(downloads[0]).toContain("--repo");
  });

  it("--previous-run auto with only this run on record is `none yet` (and nothing is downloaded)", () => {
    const dir = fresh("a"); writeMerged(dir, runs());
    const { gh, calls } = fakeGh([wireRun(9, 0), wireRun(8, 1, "pull_request")]);
    expect(main(["--merged", dir, "--previous-run", "auto", "--out", join(dir, "S.md")], deps(gh))).toBe(0);
    expect(written(join(dir, "S.md"))).toContain("Previous harness-green run: none yet");
    expect(calls.filter((c) => c[1] === "download")).toEqual([]);
  });

  it("any gh failure is a line, never a failed summary: a failed listing, a failed download, an expired artifact, a missing repo", () => {
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    const cases: [string, GhRunner, Record<string, string | undefined> | undefined][] = [
      ["a failed listing", () => ({ status: 1, stdout: "", stderr: `HTTP 500 api_key=${secret}` }), undefined],
      ["a failed download", fakeGh([wireRun(40, 6)]).gh, undefined],
      ["an artifact of no layers", fakeGh([wireRun(40, 6)], { 40: {} }).gh, undefined],
      ["no repository", noGh, { GITHUB_RUN_ID: "9" }],
    ];
    for (const [what, gh, env] of cases) {
      const dir = fresh("f"); writeMerged(dir, runs());
      const out = join(dir, "S.md");
      expect(main(["--merged", dir, "--previous-run", "auto", "--out", out], deps(gh, env)), what).toBe(0);
      const md = written(out);
      expect(md, what).toContain("Previous run unavailable: ");
      expect(md, what).toContain("## Layers");
      expect(md, what).not.toContain(secret);
      expect(findSecrets(md), what).toEqual([]);
    }
    expect(cases).toHaveLength(4);
  });

  it("--previous-run none (and the default) never calls gh", () => {
    const dir = fresh("n"); writeMerged(dir, runs());
    expect(main(["--merged", dir, "--out", join(dir, "a.md")], deps(noGh))).toBe(0);
    expect(main(["--merged", dir, "--previous-run", "none", "--out", join(dir, "b.md")], deps(noGh))).toBe(0);
    expect(written(join(dir, "a.md"))).toBe(written(join(dir, "b.md")));
  });

  it("the page is deterministic: the same inputs and clock give the same bytes", () => {
    const dir = fresh("d"); writeMerged(dir, runs());
    expect(main(["--merged", dir, "--out", join(dir, "a.md")], deps(noGh))).toBe(0);
    expect(main(["--merged", dir, "--out", join(dir, "b.md")], deps(noGh))).toBe(0);
    expect(written(join(dir, "a.md"))).toBe(written(join(dir, "b.md")));
    expect(written(join(dir, "a.md")).length).toBeGreaterThan(500);
  });

  it("usage is exit 2, nothing written: no --merged, no --out, a bad --previous-run, an unknown flag, a positional", () => {
    const dir = fresh("u"); writeMerged(dir, runs());
    const out = join(dir, "never.md");
    const bad = [[], ["--merged", dir], ["--out", out], ["--merged", dir, "--out", out, "--previous-run", "latest"], ["--merged", dir, "--out", out, "--bogus", "1"], ["--merged", dir, "--out", out, "extra"], ["--merged", dir, "--out"]];
    for (const argv of bad) {
      io.err = "";
      expect(main(argv, deps(noGh)), argv.join(" ")).toBe(2);
      expect(io.err, argv.join(" ")).toMatch(/usage: summary\.ts/);
    }
    expect(() => readFileSync(out)).toThrow();
    expect(bad).toHaveLength(7);
  });

  it("an --out that cannot be written is exit 2 naming it, never a crash", () => {
    const dir = fresh("w"); writeMerged(dir, runs());
    expect(main(["--merged", dir, "--out", dir], deps(noGh))).toBe(2); // a directory
    expect(io.err).toMatch(/cannot be written/);
    const blocker = join(dir, "file"); writeFileSync(blocker, "x");
    expect(main(["--merged", dir, "--out", join(blocker, "S.md")], deps(noGh))).toBe(2); // a parent that is a file
  });

  it("a bare `--` (pnpm 10 forwards one) is no argument, and --out creates its directory", () => {
    const dir = fresh("p"); writeMerged(dir, runs());
    const out = join(dir, "deep", "er", "S.md");
    expect(main(["--", "--merged", dir, "--out", out], deps(noGh))).toBe(0);
    expect(written(out)).toContain("# Matrix truth run summary");
  });
});

describe("summary.ts as its package script, a real process", () => {
  const meter = new SpawnMeter(2);
  beforeEach(() => meter.reset());
  const spawn = (extra: readonly string[]) => {
    meter.tick();
    const words = (scripts["matrix:summary"] ?? "").split(" ");
    expect(words[0]).toBe("node");
    return spawnSync(process.execPath, [...words.slice(1), ...extra], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: "" } });
  };

  it("writes the page for a merged dir and exits 0, with no gh and no network", { timeout: meter.budget }, () => {
    const dir = fresh("s");
    writeMerged(dir, { L1: mergedRun("L1", ID("L1"), baseCases("L1")), L3: mergedRun("L3", ID("L3"), baseCases("L3")) });
    const out = join(dir, "SUMMARY.md");
    const r = spawn(["--merged", dir, "--previous-run", "none", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const md = written(out);
    expect(md.startsWith("# Matrix truth run summary")).toBe(true);
    expect(md).toContain("- L2: no merged run — ");
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 |");
  });

  it("a usage error is exit 2 through the script", { timeout: meter.budget }, () => {
    const r = spawn(["--merged", "x"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/usage: summary\.ts/);
  });
});

// Unused-type guard: PreviousInput is part of the module's public contract (summary's third parameter).
const _contract: PreviousInput[] = [null, { unavailable: "x" }, { runId: 1, date: "2026-01-01T00:00:00Z", layers: {} }];
void _contract;
