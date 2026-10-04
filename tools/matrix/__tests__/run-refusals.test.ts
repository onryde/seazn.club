// W1d Task 5 (items 5, 12, 25): two failures that used to surface INSIDE a run
// are refused up front, by name, with exit 2 (a precondition) where they used
// to be exit 3 (aborted) or a raw duplicate-slug red on every case.
//  - item 5: NoLayerForWidth reached runSlice's catch and was filed as an abort.
//  - items 12/25: a run id reused with another --report-dir (the E-2 guard
//    reads only <report-dir>/<id>/results.json) against the SAME database
//    collided on the case org slug `m-<id>-<n>` — organizations_slug_key, the
//    first case's org, every case red. The probe asks the DATABASE, and runs
//    after the DB opens and BEFORE sign-in.
// Driven through the REAL runner (runSlice → execute → the refused list); the
// DB is a fake RunDb, and the SQL itself is pinned in seed-org.test.ts.
// Sport-agnostic on purpose: the probe sees a run id, never a sport.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runModel } from "../model.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";
import { BROWSER_WIDTHS, L2_WIDTHS } from "../lib/widths.ts";
import { NoLayerForWidth, layerOfWidth } from "../lib/layers.ts";
import { DataDirMismatch, RunIdUsedInDb, likePrefixOf, type MatrixSql } from "../lib/seed-org.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { realDeps, runSlice, type CasePlanner, type DbFactories, type PlanCases, type RunDeps } from "../run.ts";
import { deps, fakeBrowserRun, withRunIdTaken, type Deps } from "./run-deps.ts";

afterEach(() => { vi.restoreAllMocks(); });

/** Everything runSlice prints, captured (and kept off the reporter). */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  return { out: () => out.join(""), err: () => err.join("") };
}
const dirFor = () => mkdtempSync(join(tmpdir(), "w1d-refusals-"));
const resultsPath = (dir: string, runId: string) => join(dir, runId, "results.json");

const ROWS = ["league", "knockout", "double_elim", "swiss", "americano"] as const;
/** An n-item plan of distinct catalogue rows (n <= 5), one scenario each. */
const rowsPlan = (n: number): PlanCases => () => ({
  sports: ["generic"], deniesFeatures: false,
  plan: (variantFor): CaseSpec[] => ROWS.slice(0, n).map((row) => ({ caseId: `${row}|generic|${variantFor("generic")}|LIFECYCLE`, row, sport: "generic", variant: variantFor("generic"), scenario: "LIFECYCLE", canary: false })),
});
/** A plain planner whose plan() throws `e` — the throw happens INSIDE execute (runItems), after the DB is open and
 *  signed in, which is where an abort and a refusal part ways. */
const throwingPlan = (e: Error): PlanCases => () => ({ sports: ["generic"], deniesFeatures: false, plan: () => { throw e; } });

describe("item 5: NoLayerForWidth is a refusal (exit 2), not an abort (exit 3)", () => {
  it("a width no layer runs at, found while the plan is turned into cases (inside execute), is refused by name", async () => {
    const io = capture();
    const d = deps({ planCases: throwingPlan(new NoLayerForWidth(999)) });
    expect(await runSlice(d, ["--run-id", "nlw1", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/matrix: refused — NoLayerForWidth: layers: width 999 is neither L1's 1280 \(ruling 39\) nor one of L2_WIDTHS/);
    expect(io.err()).not.toContain("aborted");
    // It was found past sign-in (that is the point: the seam is the refused list, not an earlier gate), and nothing was seeded.
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
    expect(d.orgs).toHaveLength(0);
  });

  it("the same error from a layered planner's layered() is refused too (the other plan shape)", async () => {
    const io = capture();
    const d = deps({ planCases: () => ({ sports: ["generic"], deniesFeatures: false, layer: "L1", label: "--layer L1", acceptsWidth: null, layered: () => { throw new NoLayerForWidth(999); } }), openBrowserRun: async () => fakeBrowserRun().run });
    expect(await runSlice(d, ["--driver", "browser", "--run-id", "nlw2", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/matrix: refused — NoLayerForWidth/);
  });

  it("negative control: another error from the same place is still an ABORT (exit 3) — the refused list is by name, not everything", async () => {
    const io = capture();
    expect(await runSlice(deps({ planCases: throwingPlan(new Error("planner exploded")) }), ["--run-id", "nlw3", "--report-dir", dirFor()])).toBe(3);
    expect(io.err()).toMatch(/matrix: aborted — Error: planner exploded/);
  });

  it("built when the planner is CHOSEN it was already a refusal (the brief's form: planCases throwing); both sites agree", async () => {
    const io = capture();
    const d = deps({ planCases: () => { throw new NoLayerForWidth(999); } });
    expect(await runSlice(d, ["--run-id", "nlw4", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/NoLayerForWidth/);
    expect(d.order).toEqual([]); // before the preflight: nothing was touched
  });

  it("premise guard: every width the CLI accepts HAS a layer, so through the CLI today this refusal is a defensive classification (anti-vacuity: counted)", () => {
    let checked = 0;
    for (const w of BROWSER_WIDTHS) { expect(() => layerOfWidth(w), String(w)).not.toThrow(); checked++; }
    expect(checked).toBe(1 + L2_WIDTHS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("items 12, 25: a run id the database already holds is refused before anything is signed in or seeded", () => {
  it("a taken run id: exit 2, named, with the count — and no sign-in, no org, no case, nothing written", async () => {
    const io = capture();
    const dir = dirFor();
    const d = withRunIdTaken(deps({ planCases: rowsPlan(3) }), async () => 3);
    expect(await runSlice(d, ["--run-id", "w1d-dup", "--report-dir", dir])).toBe(2);
    expect(io.err()).toContain("RunIdUsedInDb: run id w1d-dup already seeded 3 org(s) in this database — pick a fresh --run-id (item 12)");
    expect(io.err()).toMatch(/matrix: refused — RunIdUsedInDb/);
    expect(io.err()).not.toContain("aborted");
    // After the DB opened, before anything else: the probe ran, the sign-in did not, and the DB was still closed.
    expect(d.order).toEqual(["preflight", "openDb", "runIdTaken w1d-dup", "dispose"]);
    expect(d.orgs).toHaveLength(0);
    expect(d.drivers).toHaveLength(0);
    expect(d.emails).toEqual([]);
    expect(existsSync(resultsPath(dir, "w1d-dup"))).toBe(false);
    expect(io.out()).not.toContain("[1/");
  });

  it("the empty case: a fresh run id (zero orgs) proceeds, and the probe was asked exactly once, before the sign-in", async () => {
    capture();
    const dir = dirFor();
    const d = withRunIdTaken(deps({ planCases: rowsPlan(2) }), async () => 0);
    expect(await runSlice(d, ["--run-id", "w1d-fresh", "--report-dir", dir])).toBe(0);
    expect(d.taken).toEqual(["w1d-fresh"]);
    expect(d.order).toEqual(["preflight", "openDb", "runIdTaken w1d-fresh", "signIn", "dispose"]);
    expect(d.orgs).toHaveLength(2);
    expect(existsSync(resultsPath(dir, "w1d-fresh"))).toBe(true);
  });

  it("the probe is asked about the SLUGGED run id — the one the case org slugs carry — not the raw argument", async () => {
    capture();
    const d = withRunIdTaken(deps({ planCases: rowsPlan(1) }), async () => 0);
    expect(await runSlice(d, ["--run-id", "W1D Dup_Raw", "--report-dir", dirFor()])).toBe(0);
    expect(d.taken).toEqual(["w1d-dup-raw"]);
    expect(d.orgs.map((o) => o.slug)).toEqual(["m-w1d-dup-raw-1"]);
  });

  it("one org is already too many: a count of 1 refuses, singular spelling kept as 'org(s)'", async () => {
    const io = capture();
    const d = withRunIdTaken(deps({ planCases: rowsPlan(2) }), async () => 1);
    expect(await runSlice(d, ["--run-id", "one", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toContain("already seeded 1 org(s)");
  });

  it("a probe that cannot read the DB: a data-dir mismatch is a refusal (exit 2), anything else an abort (exit 3)", async () => {
    const io = capture();
    expect(await runSlice(withRunIdTaken(deps({ planCases: rowsPlan(1) }), () => { throw new DataDirMismatch("/tmp/pg", "/elsewhere"); }), ["--run-id", "mm", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/refused — DataDirMismatch/);
    expect(await runSlice(withRunIdTaken(deps({ planCases: rowsPlan(1) }), () => { throw new Error("connection refused"); }), ["--run-id", "mm2", "--report-dir", dirFor()])).toBe(3);
    expect(io.err()).toMatch(/aborted — Error: connection refused/);
  });

  it("the real error class carries the id and the count, and names itself", () => {
    const e = new RunIdUsedInDb("abc", 7);
    expect(e.name).toBe("RunIdUsedInDb");
    expect(e).toBeInstanceOf(Error);
    expect(e.runId).toBe("abc");
    expect(e.count).toBe(7);
    expect(e.message).toBe("run id abc already seeded 7 org(s) in this database — pick a fresh --run-id (item 12)");
  });

  /** A database that REMEMBERS: every org a run seeds is kept, and the probe counts the case-org slugs of the id it is
   *  asked about (the brief's semantic: `m-<id>-` prefix). Which rows the real SQL counts is pinned in seed-org.test.ts. */
  function rememberingDb() {
    const slugs: string[] = [];
    const attach = (d: Deps): Deps & { taken: string[] } => {
      const prepare = d.prepareCaseOrg;
      d.prepareCaseOrg = async (ctx, input) => { slugs.push(input.slug); return prepare(ctx, input); };
      return withRunIdTaken(d, (id) => slugs.filter((s) => s.startsWith(`m-${id}-`)).length);
    };
    return { slugs, attach };
  }

  it("SEQUENCE (item 12 as it happened): run, then the same id into ANOTHER --report-dir against the same DB — refused with the count the first run really seeded", async () => {
    const io = capture();
    const db = rememberingDb();
    const first = db.attach(deps({ planCases: rowsPlan(3) }));
    expect(await runSlice(first, ["--run-id", "seq", "--report-dir", dirFor()])).toBe(0);
    expect(first.orgs).toHaveLength(3);
    // The E-2 guard (a results.json under THIS report dir) cannot see it: the dir is another one.
    const second = db.attach(deps({ planCases: rowsPlan(3) }));
    expect(await runSlice(second, ["--run-id", "seq", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toContain(`already seeded ${first.orgs.length} org(s)`);
    expect(second.orgs).toHaveLength(0);
    expect(second.order).not.toContain("signIn");
    // A different id on the same DB is unaffected (the third call of the sequence).
    const third = db.attach(deps({ planCases: rowsPlan(1) }));
    expect(await runSlice(third, ["--run-id", "seq2", "--report-dir", dirFor()])).toBe(0);
    expect(db.slugs).toEqual(["m-seq-1", "m-seq-2", "m-seq-3", "m-seq2-1"]);
  });

  it("SEQUENCE: the same id into the SAME --report-dir is still RunIdReused (the filesystem guard runs first, so the DB is never opened)", async () => {
    const io = capture();
    const dir = dirFor();
    const db = rememberingDb();
    expect(await runSlice(db.attach(deps({ planCases: rowsPlan(2) })), ["--run-id", "same", "--report-dir", dir])).toBe(0);
    const again = db.attach(deps({ planCases: rowsPlan(2) }));
    expect(await runSlice(again, ["--run-id", "same", "--report-dir", dir])).toBe(2);
    expect(io.err()).toMatch(/RunIdReused: run id same already has results at /);
    expect(again.order).toEqual([]);
  });

  /** One refused call per run shape the runner has: every one reaches the probe, because it is in execute(), before the
   *  shard stripe, the planner's own judgement and the browser. */
  const SHAPES: { name: string; argv: string[]; planner: PlanCases | (() => CasePlanner); browser: boolean }[] = [
    { name: "plain http", argv: [], planner: rowsPlan(2), browser: false },
    { name: "sharded --shard 1/2 (T4)", argv: ["--shard", "1/2"], planner: rowsPlan(2), browser: false },
    { name: "an EMPTY stripe --shard 3/4 of a two-item plan (it would be ShardEmpty, after sign-in)", argv: ["--shard", "3/4"], planner: rowsPlan(2), browser: false },
    { name: "plain browser --width 1280", argv: ["--driver", "browser", "--width", "1280"], planner: rowsPlan(2), browser: true },
    { name: "a layered plan (--layer L1)", argv: ["--driver", "browser"], planner: () => ({ sports: ["generic"], deniesFeatures: false, layer: "L1", label: "--layer L1", acceptsWidth: null, layered: () => [] }) as never, browser: true },
  ];
  it("every run shape — http, sharded, an empty stripe, plain browser, layered — refuses a taken id by name, before any sign-in", async () => {
    let checked = 0;
    for (const s of SHAPES) {
      const io = capture();
      const d = withRunIdTaken(deps({ planCases: s.planner as never, ...(s.browser ? { openBrowserRun: async () => fakeBrowserRun().run } : {}) } as Partial<RunDeps>), async () => 2);
      expect(await runSlice(d, [...s.argv, "--run-id", "shape", "--report-dir", dirFor()]), s.name).toBe(2);
      expect(io.err(), s.name).toContain("RunIdUsedInDb: run id shape already seeded 2 org(s)");
      expect(d.order, s.name).toEqual(["preflight", "openDb", "runIdTaken shape", "dispose"]);
      vi.restoreAllMocks();
      checked++;
    }
    console.info(`run-refusals: ${checked} run shapes refused a taken id`);
    expect(checked).toBe(SHAPES.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the probe is WIRED, not just declared (class: the inert seam)", () => {
  /** realDeps' own openDb over a fake MatrixSql factory: the production wiring from execute() to the SQL object.
   *  Only the pieces that need a network or a git checkout are replaced. */
  const wired = (answer: (runId: string) => number): { d: RunDeps; asked: string[]; opened: string[] } => {
    const asked: string[] = [];
    const opened: string[] = [];
    const m = { runIdTaken: async (runId: string) => { asked.push(runId); return answer(runId); } } as unknown as MatrixSql;
    const f: DbFactories = {
      matrixSql: () => { opened.push("m"); return { sql: m, dispose: async () => { opened.push("m.dispose"); } }; },
      planSql: () => { opened.push("p"); return { sql: {} as never, dispose: async () => { opened.push("p.dispose"); } }; },
    };
    const d: RunDeps = {
      ...realDeps(f),
      env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
      harnessCommit: async () => "abc1234",
      preflight: async () => ({ ok: true, refusals: [] }),
      signIn: async () => { throw new Error("signed in — the probe did not refuse first"); },
      planCases: rowsPlan(2),
    };
    return { d, asked, opened };
  };

  it("realDeps.openDb().runIdTaken reaches the gated MatrixSql's probe, and a taken id refuses the run through the REAL runSlice → execute path", async () => {
    const io = capture();
    const { d, asked, opened } = wired(() => 4);
    expect(await runSlice(d, ["--run-id", "wired", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toContain("RunIdUsedInDb: run id wired already seeded 4 org(s) in this database");
    expect(asked).toEqual(["wired"]);
    // Both handles were opened for the run, and BOTH closed on the refusal.
    expect(opened).toEqual(["m", "p", "m.dispose", "p.dispose"]);
  });

  it("…and a database that holds none lets the same run reach its sign-in (the pair: the probe is the only thing that stopped it above)", async () => {
    const io = capture();
    const { d, asked } = wired(() => 0);
    expect(await runSlice(d, ["--run-id", "wired0", "--report-dir", dirFor()])).toBe(3);
    expect(io.err()).toMatch(/aborted — Error: signed in — the probe did not refuse first/);
    expect(asked).toEqual(["wired0"]);
  });
});

describe("one slug space: the run CLI and the model CLI refuse each other's run ids", () => {
  it("a run id seeded by model.ts is refused by run.ts, and one seeded by run.ts is refused by model.ts — the count is what the first CLI really seeded", async () => {
    const io = capture();
    const slugs: string[] = [];
    const remember = (d: Deps): Deps & { taken: string[] } => {
      const prepare = d.prepareCaseOrg;
      d.prepareCaseOrg = async (ctx, input) => { slugs.push(input.slug); return prepare(ctx, input); };
      return withRunIdTaken(d, (id) => slugs.filter((s) => s.startsWith(`m-${id}-`)).length);
    };
    // model.ts first: two cells, so two case orgs under `x-model`.
    const modelDeps = remember(deps());
    const model = { env: modelDeps.env, harnessCommit: modelDeps.harnessCommit, preflight: modelDeps.preflight, openDb: modelDeps.openDb, signIn: modelDeps.signIn, prepareCaseOrg: modelDeps.prepareCaseOrg, driverFor: () => new ModelFakeDriver({ fault879: false }) };
    expect(await runModel(model, ["--run-id", "x-model", "--report-dir", dirFor(), "--cell", "league|generic", "--cell", "league|badminton", "--runs", "40"])).toBe(0);
    expect(slugs).toEqual(["m-x-model-1", "m-x-model-2"]);
    const run = remember(deps({ planCases: rowsPlan(2) }));
    expect(await runSlice(run, ["--run-id", "x-model", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toContain(`run id x-model already seeded ${slugs.length} org(s)`);
    expect(run.orgs).toHaveLength(0);
    // …and the other way round: run.ts seeds, model.ts is refused.
    const seeded = remember(deps({ planCases: rowsPlan(3) }));
    expect(await runSlice(seeded, ["--run-id", "x-run", "--report-dir", dirFor()])).toBe(0);
    expect(seeded.orgs).toHaveLength(3);
    const refused = remember(deps());
    const modelAgain = { env: refused.env, harnessCommit: refused.harnessCommit, preflight: refused.preflight, openDb: refused.openDb, signIn: refused.signIn, prepareCaseOrg: refused.prepareCaseOrg, driverFor: () => new ModelFakeDriver({ fault879: false }) };
    expect(await runModel(modelAgain, ["--run-id", "x-run", "--report-dir", dirFor(), "--cell", "league|generic", "--runs", "40"])).toBe(2);
    expect(io.err()).toContain(`run id x-run already seeded ${seeded.orgs.length} org(s)`);
  });
});

describe("likePrefixOf — the LIKE pattern for a run id's case-org slugs", () => {
  it("a run id containing % or _ cannot match other ids (the LIKE escape)", () => {
    expect(likePrefixOf("w1d_a")).toBe("m-w1d\\_a-");
  });
});
