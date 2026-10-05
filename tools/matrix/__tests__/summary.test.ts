// W1d Task 8 (D1a, D5, D20; PF-1, ruling 61) and T9-HG: SUMMARY.md. Every expected number below is counted by hand from the
// fixture (the comment beside it says how), never derived from summary(). The verdict tests all start from ONE complete
// fixture (three merged layers, a `judge faults` verdict bound to each) and change ONE thing, so each "Run complete: no" is
// witnessed against the "yes" it departs from (a negative needs its positive pair). One workflow run never says
// "Harness-green: yes" or "no": ruling 61's three-run claim is PR-B's `matrix:judge across`, over three workflow runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GhRunner } from "../ci/gh.ts";
import { GREEN_RUNS, main, percentile, summary, type JudgeInput, type Previous, type PreviousInput, type SummaryDeps } from "../ci/summary.ts";
import type { JudgeOut } from "../lib/judge.ts";
import { findSecrets } from "../lib/redact.ts";
import { LAYERS, type CaseResult, type Layer, type RunResults } from "../lib/results.ts";
import { main as judgeMain } from "../judge.ts";
import { runSlice } from "../run.ts";
import { deps as runDeps, fakeBrowserRun } from "./run-deps.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";
import { ID, baseCases, judgeOut, kase, mergedRun, planned, threeOf } from "./summary-fixtures.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const NOW = new Date("2026-10-04T12:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "w1d-summary-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// --- fixtures --------------------------------------------------------------------------------------------------

const allRuns = (): Record<Layer, RunResults | null> => ({ L1: mergedRun("L1", ID("L1"), baseCases("L1")), L2: mergedRun("L2", ID("L2"), baseCases("L2")), L3: mergedRun("L3", ID("L3"), baseCases("L3")) });
/** The per-run claim's inputs: a `judge faults` verdict (exit 0) bound to each layer's merged run, as the merge step writes them. */
const faultsJudges = (): JudgeInput[] => LAYERS.map((l) => ({ path: `merged/${l}/judge.json`, out: judgeOut({ mode: "faults", layer: l, runs: [ID(l)] }) }));
/** A `judge across` verdict over exactly three runs, the last of which is this run: PR-B Task 17's input, never a workflow run's own. */
const acrossJudges = (): JudgeInput[] => LAYERS.map((l) => ({ path: `merged/${l}/across.json`, out: judgeOut({ layer: l, runs: threeOf(l) }) }));
const VERDICT = /\*\*Run complete: [^*]+\*\*/;
const verdictOf = (md: string): string => VERDICT.exec(md)?.[0] ?? "(no verdict line)";
/** T9-HG's fixed line, as the controller's ruling spells it (not read back from summary.ts). */
const HARNESS_GREEN_LINE = "Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)";

// --- the page --------------------------------------------------------------------------------------------------

describe("summary: the previous run line (D1a) — the empty case first", () => {
  it("no previous run -> `Previous complete run: none yet`, and the diff section says there is nothing to diff", () => {
    const md = summary(allRuns(), [], null, NOW);
    expect(md).toContain("Previous complete run: none yet");
    expect(md).toContain("No weekly diff: there is no previous complete run yet.");
    expect(md.split("\n")[2]).toBe("Previous complete run: none yet"); // it OPENS the page, under the title
  });

  it("a previous run is named by date, days ago and id: 2026-09-27 -> 7 days before 2026-10-04 12:00", () => {
    const prev: Previous = { runId: 77, date: "2026-09-27T02:17:00Z", layers: {} };
    const md = summary(allRuns(), [], prev, NOW);
    expect(md).toContain("Previous complete run: 2026-09-27 (7 days ago) — run 77");
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
  it("a layer with no merged run has its own row of dashes, a line saying why, and the run is not complete", () => {
    const runs = { ...allRuns(), L2: null };
    const md = summary(runs, faultsJudges(), null, NOW);
    expect(md).toContain("| L2 | — | — | — | — | — |");
    expect(md).toContain("- L2: no merged run — its merge was refused, no shard ran");
    expect(verdictOf(md)).toBe("**Run complete: no**");
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

describe("summary: the per-run verdict — fails safe (PF-1, T9-HG)", () => {
  it("the positive: three merged layers, each with a `judge faults` verdict (exit 0) bound to its run -> Run complete: yes", () => {
    expect(GREEN_RUNS).toBe(3);
    const md = summary(allRuns(), faultsJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: yes**");
    expect(md).toContain("a `judge faults` verdict (exit 0) is bound to each layer's merged run");
    expect(md).toContain("- `merged/L2/judge.json`: L2 faults over 1 run (ci-9-1-l2) — exit 0, 10 cases compared, 0 faults, 0 differing, 0 regressed");
  });

  it("ONE workflow run never says Harness-green yes, no or not judged: the line is the same fixed text whatever the page's verdict (every judge shape, three-run across verdicts included)", () => {
    const scenarios: [string, Record<Layer, RunResults | null>, JudgeInput[]][] = [
      ["complete", allRuns(), faultsJudges()],
      ["no judge at all", allRuns(), []],
      ["a layer missing", { ...allRuns(), L2: null }, faultsJudges()],
      ["a refused judge", allRuns(), [...faultsJudges().slice(0, 2), { path: "merged/L3/judge.json", refused: "the file is missing" }]],
      ["complete AND three clean across verdicts bound to this run", allRuns(), [...faultsJudges(), ...acrossJudges()]],
      ["three clean across verdicts only", allRuns(), acrossJudges()],
    ];
    let checked = 0;
    for (const [what, runs, judges] of scenarios) {
      const md = summary(runs, judges, null, NOW);
      expect(md.split("\n").filter((l) => l.includes("Harness-green")), what).toEqual([HARNESS_GREEN_LINE]);
      expect(md, what).not.toMatch(/Harness-green: (yes|no|not judged)/i);
      expect(md, what).toMatch(/\*\*Run complete: (yes|no)\*\*/);
      checked++;
    }
    expect(checked).toBe(6);
    // The positive and negative pair for "Run complete" among them: the first scenario is yes, the second is no.
    expect(verdictOf(summary(scenarios[0]![1], scenarios[0]![2], null, NOW))).toBe("**Run complete: yes**");
    expect(verdictOf(summary(scenarios[1]![1], scenarios[1]![2], null, NOW))).toBe("**Run complete: no**");
  });

  it("no judge at all is Run complete: no, never yes — and it names the verdict each layer lacks", () => {
    const md = summary(allRuns(), [], null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    for (const l of LAYERS) expect(md).toContain(`${l}: no \`judge faults\` verdict is bound to run ${ID(l)}`);
    expect(md).toContain("No `--judge` file was given.");
  });

  it("a MISSING judge file is `judge refused`, and the run is not complete — even with the other layers judged clean", () => {
    const judges: JudgeInput[] = [...faultsJudges().slice(0, 2), { path: "merged/L3/judge.json", refused: "the file is missing — a refused judge writes none, so this run has no verdict from it" }];
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("judge refused: merged/L3/judge.json");
    expect(md).toContain("- `merged/L3/judge.json`: judge refused");
    // L3 has no verdict bound either, so there are two reasons, not one.
    expect(md).toContain("L3: no `judge faults` verdict is bound to run ci-9-1-l3");
  });

  it("a STALE file — a verdict of another run, whose id does not name this merged run — is not this run's verdict", () => {
    const judges = faultsJudges();
    judges[0] = { path: "merged/L1/judge.json", out: judgeOut({ mode: "faults", layer: "L1", runs: ["ci-1-1-l1"] }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("a stale verdict, ignored");
    expect(md).toContain("L1: no `judge faults` verdict is bound to run ci-9-1-l1 (a judge file for this layer judged other runs)");
  });

  it("a file for the wrong LAYER does not bind: L1's merged run has no verdict if the only file names L2", () => {
    const judges = faultsJudges();
    judges[0] = { path: "merged/L1/judge.json", out: judgeOut({ mode: "faults", layer: "L2", runs: [ID("L1")] }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("L1: no `judge faults` verdict is bound to run ci-9-1-l1");
  });

  it("a faults verdict that found faults is not complete, and says how many", () => {
    const judges = faultsJudges();
    judges[2] = { path: "merged/L3/judge.json", out: judgeOut({ mode: "faults", layer: "L3", runs: [ID("L3")], exit: 1, faults: [{ run: ID("L3"), caseId: "f1", kind: "crash", reason: "error: crashed — x" }, { run: ID("L3"), caseId: "f2", kind: "vacuous", reason: "no checks ran (vacuous)" }] }) };
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("L3: 2 harness faults in this run");
  });

  it("an `across` or a `regression` verdict is not the per-run claim: with only those, every layer lacks its faults verdict and the run is not complete", () => {
    const md = summary(allRuns(), acrossJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    for (const l of LAYERS) expect(md).toContain(`${l}: no \`judge faults\` verdict is bound to run ${ID(l)}`);
    // …and the clean across verdicts are still shown as what they are.
    expect(md).toContain("L1 across over 3 runs (ci-7-1-l1, ci-8-1-l1, ci-9-1-l1) — exit 0");
    const regression: JudgeInput[] = LAYERS.map((l) => ({ path: `r/${l}.json`, out: judgeOut({ mode: "regression", layer: l, runs: [ID(l)], plannedNotRun: null }) }));
    expect(verdictOf(summary(allRuns(), regression, null, NOW))).toBe("**Run complete: no**");
  });

  it("two faults verdicts for one layer, one clean and one not: not complete (every bound faults verdict must hold)", () => {
    const judges = [...faultsJudges(), { path: "merged/L2/judge-2.json", out: judgeOut({ mode: "faults", layer: "L2", runs: [ID("L2")], exit: 1, faults: [{ run: ID("L2"), caseId: "d", kind: "crash", reason: "error: crashed — x" }] }) } as JudgeInput];
    const md = summary(allRuns(), judges, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("L2: 1 harness fault in this run");
  });

  it("a clean judge cannot paper over faults the merged results themselves hold", () => {
    const runs = { ...allRuns(), L1: mergedRun("L1", ID("L1"), [...baseCases("L1"), kase("L1", { caseId: "boom", state: "red", reason: "error: crashed — x" })]) };
    const md = summary(runs, faultsJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("L1: this run's merged results hold 1 harness fault");
  });

  it("a layer with no merged run is not complete, however clean the other layers are", () => {
    const md = summary({ ...allRuns(), L3: null }, faultsJudges(), null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("L3: no merged run to judge");
  });

  it("the ruling-61 check on an `across` verdict is kept as T8 wrote it, but it is a NOTE: it never moves Run complete either way", () => {
    // The positive: complete, with a faults verdict per layer. Each variation below adds an across verdict and changes nothing else.
    expect(verdictOf(summary(allRuns(), faultsJudges(), null, NOW))).toBe("**Run complete: yes**");
    let checked = 0;
    for (const runs of [2, 4, 5]) {
      const judges = faultsJudges();
      const ids = Array.from({ length: runs }, (_, i) => (i === runs - 1 ? ID("L2") : `ci-${i}-1-l2`));
      judges.push({ path: "merged/L2/across.json", out: judgeOut({ layer: "L2", runs: ids }) });
      const md = summary(allRuns(), judges, null, NOW);
      expect(verdictOf(md), `${runs} runs`).toBe("**Run complete: yes**");
      expect(md, `${runs} runs`).toContain(`L2: judged ${runs} runs; harness-green needs exactly 3 (ruling 61)`);
      checked++;
    }
    const exactly = faultsJudges();
    exactly.push({ path: "merged/L2/across.json", out: judgeOut({ layer: "L2", runs: threeOf("L2") }) });
    expect(summary(allRuns(), exactly, null, NOW)).not.toContain("harness-green needs exactly");
    const differing = faultsJudges();
    differing.push({ path: "merged/L3/across.json", out: judgeOut({ layer: "L3", runs: threeOf("L3"), exit: 1, differing: [{ caseId: "d1", states: ["works", "red"] }], faults: [{ run: ID("L3"), caseId: "f1", kind: "crash", reason: "error: crashed — x" }, { run: ID("L3"), caseId: "f2", kind: "vacuous", reason: "no checks ran (vacuous)" }] }) });
    const md = summary(allRuns(), differing, null, NOW);
    expect(verdictOf(md)).toBe("**Run complete: yes**");
    expect(md).toContain("L3: 1 differing, 2 harness faults across the runs");
    expect(checked).toBe(3);
  });

  it("the judge file of a regression of a v2 run names no layer, and binds to nothing", () => {
    const md = summary(allRuns(), [...faultsJudges(), { path: "r/none.json", out: judgeOut({ mode: "regression", layer: null, runs: ["old"], plannedNotRun: null }) }], null, NOW);
    expect(md).toContain("`r/none.json`: regression names no layer; it binds to none of this run's layers.");
    expect(verdictOf(md)).toBe("**Run complete: yes**"); // it is simply not one of the verdicts
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
    if (args[0] === "api") {
      // The runs endpoint filters by `event=` on the server, and the code under test asks for each weekly event separately.
      const event = new URL(`https://api.example.test/${args[1] ?? ""}`).searchParams.get("event");
      return { status: 0, stdout: JSON.stringify({ workflow_runs: event === null ? list : list.filter((r) => r.event === event) }), stderr: "" };
    }
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

  it("reads each layer's results.json and the judge files, writes the page, exit 0 — a complete run end to end", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const judgeArgs = LAYERS.flatMap((l) => { const f = join(dir, `${l}-faults.json`); writeFileSync(f, JSON.stringify(judgeOut({ mode: "faults", layer: l, runs: [ID(l)] }))); return ["--judge", f]; });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, ...judgeArgs, "--previous-run", "none", "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(verdictOf(md)).toBe("**Run complete: yes**");
    expect(md).toContain("| L1 | L1 (grid) | ci-9-1-l1 | 2 | 3 | 2 |");
    expect(md).toContain("Previous complete run: none yet");
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
    // The real producer's file BINDS to the real run: L1 has its faults verdict (the run is incomplete only for the layers not given).
    expect(md).not.toContain("L1: no `judge faults` verdict is bound");
    expect(md).toContain("L2: no merged run to judge");
    // The judge's own count of this run's faults is the summary's own (one authority, two readers).
    const judged = JSON.parse(readFileSync(judgeFile, "utf8")) as JudgeOut;
    expect(md).toContain(`Harness faults in this run: ${judged.faults.length === 0 ? "none (1 of 3 layers present)" : `${judged.faults.length} (L1 ${judged.faults.length})`}.`);
  }, 60_000);

  it("through main(): a STALE faults file (another run's id) is NOT complete — and the right files are (the positive pair); an across file of 2 or 4 runs is a note, never a verdict", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    let n = 0;
    const file = (l: Layer, mode: "faults" | "across", runIds: string[]): string => { const f = join(dir, `v${n++}-${l}.json`); writeFileSync(f, JSON.stringify(judgeOut({ mode, layer: l, runs: runIds }))); return f; };
    const pageFor = (judges: string[]): string => {
      const out = join(dir, `S${n++}.md`);
      expect(main(["--merged", dir, ...judges.flatMap((j) => ["--judge", j]), "--out", out], deps(noGh))).toBe(0);
      return written(out);
    };
    const good = (l: Layer): string => file(l, "faults", [ID(l)]);
    // The positive pair: with all three right, the same command line is complete.
    expect(verdictOf(pageFor([good("L1"), good("L2"), good("L3")]))).toBe("**Run complete: yes**");

    // A stale file: a verdict over an EARLIER run, not this merged run (ci-9-1-l1).
    const stale = pageFor([file("L1", "faults", ["ci-1-1-l1"]), good("L2"), good("L3")]);
    expect(verdictOf(stale)).toBe("**Run complete: no**");
    expect(stale).toContain("a stale verdict, ignored");
    expect(stale).toContain("L1: no `judge faults` verdict is bound to run ci-9-1-l1");
    expect(stale).toContain("(a judge file for this layer judged other runs)");

    // An across file over two runs, one of them this run, beside the three right files: a note, and still complete.
    const two = pageFor([good("L1"), good("L2"), good("L3"), file("L1", "across", threeOf("L1").slice(1))]);
    expect(verdictOf(two)).toBe("**Run complete: yes**");
    expect(two).toContain("L1: judged 2 runs; harness-green needs exactly 3 (ruling 61)");
    expect(two).not.toContain("a stale verdict");

    // Four: "more than two" is not three either — and it is still only a note.
    const four = pageFor([good("L1"), good("L2"), good("L3"), file("L1", "across", [...threeOf("L1"), "ci-6-1-l1"])]);
    expect(verdictOf(four)).toBe("**Run complete: yes**");
    expect(four).toContain("L1: judged 4 runs; harness-green needs exactly 3 (ruling 61)");
  });

  it("a judge file that does not exist is `judge refused` in the page (exit 0, the page still written) and the run is not complete", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const good = LAYERS.slice(0, 2).flatMap((l) => { const f = join(dir, `${l}.json`); writeFileSync(f, JSON.stringify(judgeOut({ mode: "faults", layer: l, runs: [ID(l)] }))); return ["--judge", f]; });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, ...good, "--judge", join(dir, "L3-never-written.json"), "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect(verdictOf(md)).toBe("**Run complete: no**");
    expect(md).toContain("judge refused: ");
    expect(md).toContain("L3-never-written.json");
  });

  it("a judge file that is not a verdict, or that contradicts itself, is `judge refused` too", () => {
    const dir = fresh("m"); writeMerged(dir, runs());
    const junk = join(dir, "junk.json"); writeFileSync(junk, "{ not json");
    const wrongShape = join(dir, "shape.json"); writeFileSync(wrongShape, JSON.stringify({ version: 1 }));
    // exit 0 with a fault listed: edited by hand, or half written.
    const liar = join(dir, "liar.json");
    writeFileSync(liar, JSON.stringify({ ...judgeOut({ mode: "faults", layer: "L1", runs: [ID("L1")] }), faults: [{ run: ID("L1"), caseId: "f", kind: "crash", reason: "error: crashed — x" }] }));
    // exit 1 with nothing listed: a verdict that says "found something" and names nothing.
    const mute = join(dir, "mute.json");
    writeFileSync(mute, JSON.stringify({ ...judgeOut({ mode: "faults", layer: "L2", runs: [ID("L2")] }), exit: 1 }));
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--judge", junk, "--judge", wrongShape, "--judge", liar, "--judge", mute, "--out", out], deps(noGh))).toBe(0);
    const md = written(out);
    expect((md.match(/judge refused: /g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(md).toContain("the verdict contradicts itself (exit 1 but it lists no finding)");
    expect(md).toContain("is not a judge verdict");
    expect(md).toContain("the verdict contradicts itself (exit 0 but it lists 1 finding(s))");
    expect(verdictOf(md)).toBe("**Run complete: no**");
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
    expect(md).toContain("Previous complete run: 2026-09-28 (6 days ago) — run 40");
    expect(md).toContain("1 case changed state since run 40 (3 compared):");
    expect(md).toContain("❌→✅ (1): `c1-L1`");
    // Exactly one run was downloaded: 40 (not 9, which is this run itself).
    const downloads = calls.filter((c) => c[1] === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].slice(0, 5)).toEqual(["run", "download", "40", "-n", "merged"]);
    expect(downloads[0]).toContain("--repo");
    // The PR's run 50 was never a candidate, and not because of anything this CLI sorts out afterwards: the fake answers
    // by the URL's `event=` exactly as GitHub does, so a pull_request run is only ever seen if it is ASKED for. (W1d T8->T9 (e):
    // the old comment here claimed "not the PR's 50" as if the sort excluded it; the list never held it.)
    const asked = calls.filter((c) => c[0] === "api").map((c) => new URL(`https://api.example.test/${c[1] ?? ""}`).searchParams.get("event"));
    expect(asked).toEqual(["schedule", "workflow_dispatch"]);
    expect(asked).not.toContain("pull_request");
  });

  it("--previous-run auto: the newest success is a workflow_dispatch with older schedules behind it — the sort picks the dispatch, whatever order the two event lists are read in (W1d T8->T9 (e))", () => {
    const dir = fresh("a"); writeMerged(dir, runs());
    const onDispatch = { L1: mergedRun("L1", "ci-60-1-l1", [kase("L1", { caseId: "c1-L1", state: "red", reason: "was red on the dispatch" }), kase("L1", { caseId: "c2-L1", durationMs: 2000 }), planned("L1", "p1-L1", "A1")]) };
    const onSchedule = { L1: mergedRun("L1", "ci-40-1-l1", [kase("L1", { caseId: "c1-L1" }), kase("L1", { caseId: "c2-L1", durationMs: 2000 }), planned("L1", "p1-L1", "A1")]) };
    // successfulRuns reads the schedule list FIRST, then the dispatch list, so without the sort the first non-self row is the
    // schedule 40 (6 days old) and the dispatch 60 (1 day old) is never chosen. The schedules behind it are 6 and 13 days old.
    const { gh, calls } = fakeGh([wireRun(9, 0), wireRun(60, 1, "workflow_dispatch"), wireRun(40, 6), wireRun(30, 13)], { 60: onDispatch, 40: onSchedule });
    const out = join(dir, "SUMMARY.md");
    expect(main(["--merged", dir, "--previous-run", "auto", "--out", out], deps(gh))).toBe(0);
    const md = written(out);
    expect(md).toContain("Previous complete run: 2026-10-03 (1 days ago) — run 60");
    expect(md).toContain("1 case changed state since run 60 (3 compared):");
    const downloads = calls.filter((c) => c[1] === "download");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].slice(0, 5)).toEqual(["run", "download", "60", "-n", "merged"]);
    // Anti-vacuity: the dispatch run really was the SECOND list read (so a missing sort would have chosen 40).
    expect(calls.filter((c) => c[0] === "api").map((c) => c[1]?.includes("event=workflow_dispatch"))).toEqual([false, true]);
  });

  it("--previous-run auto with only this run on record is `none yet` (and nothing is downloaded)", () => {
    const dir = fresh("a"); writeMerged(dir, runs());
    const { gh, calls } = fakeGh([wireRun(9, 0), wireRun(8, 1, "pull_request")]);
    expect(main(["--merged", dir, "--previous-run", "auto", "--out", join(dir, "S.md")], deps(gh))).toBe(0);
    expect(written(join(dir, "S.md"))).toContain("Previous complete run: none yet");
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

  describe("--require-complete (T9-HG): the workflow's colour follows the per-run verdict", () => {
    const faultsFiles = (dir: string, over: Partial<Record<Layer, string[]>> = {}): string[] => LAYERS.flatMap((l) => {
      const f = join(dir, `${l}-faults.json`);
      writeFileSync(f, JSON.stringify(judgeOut({ mode: "faults", layer: l, runs: over[l] ?? [ID(l)] })));
      return ["--judge", f];
    });
    const attempt = (dir: string, judges: string[], extra: string[]): { status: number; page: string } => {
      const out = join(dir, `S-${Math.random().toString(36).slice(2)}.md`);
      const status = main(["--merged", dir, ...judges, ...extra, "--out", out], deps(noGh));
      return { status, page: written(out) };
    };

    it("a complete run exits 0 with the flag, and the page says so (the positive)", () => {
      const dir = fresh("rc"); writeMerged(dir, runs());
      const r = attempt(dir, faultsFiles(dir), ["--require-complete"]);
      expect(r.status).toBe(0);
      expect(verdictOf(r.page)).toBe("**Run complete: yes**");
      expect(io.err).not.toMatch(/not complete/);
    });

    it("a run that is NOT complete exits 1 with the flag — AFTER the page is written, saying why on the page and on stderr", () => {
      let checked = 0;
      const cases: [string, (dir: string) => { judges: string[]; runs?: Partial<Record<Layer, RunResults>> }][] = [
        ["a stale faults verdict for one layer", (dir) => ({ judges: faultsFiles(dir, { L2: ["ci-1-1-l2"] }) })],
        ["no judge file at all", () => ({ judges: [] })],
        ["a missing layer", (dir) => ({ judges: faultsFiles(dir), runs: { L1: runs().L1!, L3: runs().L3! } })],
        ["a judge file that does not exist", (dir) => ({ judges: [...faultsFiles(dir).slice(0, 4), "--judge", join(dir, "never-written.json")] })],
      ];
      for (const [what, make] of cases) {
        const dir = fresh("rc");
        const built = make(dir);
        writeMerged(dir, built.runs ?? runs());
        io.err = "";
        const r = attempt(dir, built.judges, ["--require-complete"]);
        expect({ what, status: r.status }, what).toEqual({ what, status: 1 });
        expect(verdictOf(r.page), what).toBe("**Run complete: no**");
        expect(io.err, what).toMatch(/the run is not complete \(exit 1: --require-complete\)/);
        checked++;
      }
      expect(checked).toBe(4);
    });

    it("without the flag the same incomplete run is still exit 0 (the page's own contract is unchanged: the steps that judge decide the colour)", () => {
      const dir = fresh("rc"); writeMerged(dir, runs());
      const r = attempt(dir, [], []);
      expect(r.status).toBe(0);
      expect(verdictOf(r.page)).toBe("**Run complete: no**");
    });
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
  const meter = new SpawnMeter(3);
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

  it("--require-complete through the script: an incomplete run is exit 1 and the page is still written; a missing layer cannot be complete", { timeout: meter.budget }, () => {
    const dir = fresh("s");
    writeMerged(dir, { L1: mergedRun("L1", ID("L1"), baseCases("L1")), L3: mergedRun("L3", ID("L3"), baseCases("L3")) });
    const out = join(dir, "SUMMARY.md");
    const r = spawn(["--merged", dir, "--require-complete", "--out", out]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/the run is not complete \(exit 1: --require-complete\)/);
    expect(written(out)).toContain("**Run complete: no**");
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
