// The model runner's per-cell half (W1b Task 14): runCell runs fc.check over
// fc.commands for one cell, each property run on a fresh division, and reduces
// the runs into one CellReport. Driven DB-free through ModelFakeDriver (Task
// 13), whose outcomes are the engine's fold and whose schedule is the engine's
// round robin.
//
// State transitions under test (TEST-STRATEGY rule 1): a cell with no failure;
// a cell whose first failure is shrunk (fences off, #879); the same failure
// replayed from its seed, path and replayPath; a failure matched by an OPEN
// regression, then by a FIXED one; an unexpected refusal (the check that
// outranks every other); other checks met while shrinking; the time box
// before, during and after a failure. Empty cases FIRST: one run of one
// command; a cell whose every step was refused; a time box already spent.
//
// single-sport: the model fake is a round-robin (league) product, and #879 —
// the one fault these tests drive — is a league fault; the correct-product
// test sweeps the model's own sports (SLICE_SPORTS) instead.
import { describe, expect, it } from "vitest";
import { RefusedCall, type PostedEvent } from "../lib/driver/types.ts";
import { COMMAND_KINDS, newModelState, type ModelState } from "../lib/model/commands.ts";
import { FENCES } from "../lib/model/fences.ts";
import { runCell, shrinkTarget, type RunCellInput } from "../lib/model/run-cell.ts";
import { ROSTER_LOCK_FINDING, UNEXPECTED_REFUSAL, VACUITY_CHECK, informativeSteps, type CommandCounts, type UnknownLedger } from "../lib/model/state.ts";
import { STEP_INVARIANTS } from "../lib/invariants.ts";
import { SLICE_SPORTS } from "../lib/slice.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { ModelFakeDriver, type ModelFakeOpts } from "./model-fake-driver.ts";

const CELL = "league|generic";
const I7 = "I7-rr-no-pair-over-legs";
const I8 = "I8-generate-named";
const FENCE_879 = "late-entry-then-generate";

type Over = Partial<RunCellInput> & { fault879?: boolean; opts?: ModelFakeOpts; sport?: string; variant?: string; driver?: () => ModelFakeDriver };
const input = (over: Over = {}): RunCellInput => {
  const { fault879, opts, sport = "generic", variant = "score", driver, ...rest } = over;
  return {
    cell: `league|${sport}`, row: "league", sport, variant,
    newDriverState: async (n) => {
      const real = driver?.() ?? new ModelFakeDriver({ ...opts, fault879: fault879 === true });
      return { real, model: await newModelState({ driver: real, row: "league", sport, variant, entrants: 4, tag: `t${n}` }) };
    },
    runs: 40, maxCommands: 12, seed: 42, fences: true, timeLimitMs: 60_000, regressions: [],
    ...rest,
  };
};

/** Every post refused by NAME — a product that will not take a result. */
class RefusingPosts extends ModelFakeDriver {
  override postStream(id: string, _events: readonly StreamEvent[], _prefix = ""): Promise<PostedEvent[]> {
    return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses every result"));
  }
}
/** Once built, every organiser command is refused by NAME: nothing is ever accepted. */
class RefusingEverything extends ModelFakeDriver {
  built = false;
  #no(path: string): Promise<never> { return Promise.reject(new RefusedCall("POST", path, 409, "TEST_REFUSED", "test: refuses everything")); }
  override start() { return this.built ? this.#no("/start") : super.start(); }
  override generate() { return this.built ? this.#no("/generate") : super.generate(); }
  override addEntrants(d: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]) { return this.built ? this.#no("/entrants") : super.addEntrants(d, es); }
}

describe("shrinkTarget — which check a cell's shrink is locked to", () => {
  it("empty case first: before any failure, the first check thrown is the target", () => {
    expect(shrinkTarget(null, I7)).toBe(I7);
    expect(shrinkTarget(null, UNEXPECTED_REFUSAL)).toBe(UNEXPECTED_REFUSAL);
  });
  it("the target's own check stays the failure; any other check is masked (null)", () => {
    expect(shrinkTarget(I7, I7)).toBe(I7);
    expect(shrinkTarget(I7, "model-fold-parity")).toBeNull();
    expect(shrinkTarget(UNEXPECTED_REFUSAL, I7)).toBeNull();
  });
  it("an unexpected refusal outranks every other target and is never masked (T14 amendment: a NEW failure, not merely counted)", () => {
    expect(shrinkTarget(I7, UNEXPECTED_REFUSAL)).toBe(UNEXPECTED_REFUSAL);
    expect(shrinkTarget("model-error", UNEXPECTED_REFUSAL)).toBe(UNEXPECTED_REFUSAL);
    expect(shrinkTarget(UNEXPECTED_REFUSAL, UNEXPECTED_REFUSAL)).toBe(UNEXPECTED_REFUSAL);
  });
});

describe("runCell", () => {
  it("empty case first: one run of one command is VACUOUS — reported, never a pass", async () => {
    const r = await runCell(input({ runs: 1, maxCommands: 1 }));
    expect(r.failure).toBeNull();
    expect(r.vacuous.length).toBeGreaterThan(0);
    expect(r.executions).toBe(1);
  });

  it("empty case: a cell whose every step was refused told the model nothing — vacuous on model-informative-steps", async () => {
    const drivers: RefusingEverything[] = [];
    const r = await runCell(input({
      runs: 10,
      newDriverState: async (n) => {
        const real = new RefusingEverything();
        drivers.push(real);
        const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        real.built = true;
        return { real, model };
      },
    }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    // The steps did run, and every one was refused: vacuity is about what they told the model.
    expect(r.counts.Start.ran + r.counts.Generate.ran + r.counts.AddEntrant.ran).toBeGreaterThan(0);
    expect(r.counts.Start.refused + r.counts.Generate.refused + r.counts.AddEntrant.refused).toBe(r.counts.Start.ran + r.counts.Generate.ran + r.counts.AddEntrant.ran);
    expect(r.informativeSteps).toBe(0);
    expect(r.vacuous).toContain(`no informative step (${VACUITY_CHECK})`);
    // Runs happened, yet nothing was accepted and nothing was compared: each rule says so itself.
    expect(r.counts.Score.accepted).toBe(0);
    expect(r.vacuous).toContain("no Score was accepted");
    expect(r.foldParity).toBe(0);
    expect(r.vacuous).toContain("fold parity compared zero fixtures");
    expect(drivers.length).toBe(r.executions);
  });

  it.each(SLICE_SPORTS)("a correct product (%s): no failure; every kind ran; Score accepted; each applicable step invariant and fold parity counted > 0; the roster lock met as the known finding", async (sport) => {
    const variant = sport === "generic" ? "score" : "bwf";
    const r = await runCell(input({ sport, variant }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    expect(r.vacuous).toEqual([]);
    for (const k of COMMAND_KINDS) expect(r.counts[k].ran, k).toBeGreaterThan(0);
    expect(r.counts.Score.accepted).toBeGreaterThan(0);
    // Applicability from the invariant registry, never a typed list: I6 is swiss-only.
    const applicable = STEP_INVARIANTS.filter((s) => s.stageKinds === "any" || s.stageKinds.includes("league"));
    expect(applicable.map((s) => s.id)).toEqual(expect.arrayContaining([I7, I8]));
    for (const s of applicable) expect(r.stepChecks[s.id], s.id).toBeGreaterThan(0);
    expect(r.foldParity).toBeGreaterThan(0);
    expect(r.informativeSteps).toBeGreaterThan(0);
    // After Start the roster is locked: offered, refused as EXPECTED, recorded under CD-T13b.
    expect(r.counts.AddEntrant.expected).toBeGreaterThan(0);
    expect(r.findings[ROSTER_LOCK_FINDING]?.count).toBe(r.counts.AddEntrant.expected);
    expect(r.findings[ROSTER_LOCK_FINDING]?.evidence.length).toBe(3);
    // A correct fake answers every post first time: no ledger ever went unknown.
    expect(r.unknowns).toEqual({ retried: 0, "tip-moved": 0, "next-match-unverified": 0 });
    expect(r.numRuns).toBe(40);
    expect(r.seed).toBe(42);
    expect(r.interrupted).toBe(false);
    expect(r.masked).toEqual({});
  });

  it("aggregates per cell, across every property run: all five counts, step checks, fences, parity, unknowns by cause, findings (3 evidence lines kept), informative steps", async () => {
    const captured: ModelState[] = [];
    const seeded: readonly UnknownLedger["cause"][] = ["retried", "tip-moved", "next-match-unverified"];
    const r = await runCell(input({
      runs: 12,
      newDriverState: async (n) => {
        const real = new ModelFakeDriver();
        const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        // Every field seeded non-zero in every run, so a field the reducer drops shows.
        for (const k of COMMAND_KINDS) model.counts[k] = { ran: 1, accepted: 2, refused: 3, expected: 4, unexpected: 5 };
        for (const cause of seeded) model.unknowns.push({ cause, fixture: `x${n}`, detail: "seeded" });
        model.findings.set("SEEDED-1", { count: 2, evidence: [`a${n}`, `b${n}`] });
        model.stepChecks.set("SEEDED-CHECK", 7);
        model.fenced.set("SEEDED-FENCE", 1);
        model.foldParity = 3;
        model.steps.push({ cmd: "Seeded(0,0)", verdict: "accepted" }, { cmd: "Seeded(1,0)", verdict: "refused" });
        captured.push(model);
        return { real, model };
      },
    }));
    expect(captured.length).toBeGreaterThan(1);
    expect(r.executions).toBe(captured.length);
    const sum = (f: (m: ModelState) => number) => captured.reduce((s, m) => s + f(m), 0);
    const fields: readonly (keyof CommandCounts)[] = ["ran", "accepted", "refused", "expected", "unexpected"];
    for (const k of COMMAND_KINDS) for (const f of fields) expect(r.counts[k][f], `${k}.${f}`).toBe(sum((m) => m.counts[k][f]));
    for (const id of new Set(captured.flatMap((m) => [...m.stepChecks.keys()]))) expect(r.stepChecks[id], id).toBe(sum((m) => m.stepChecks.get(id) ?? 0));
    for (const id of new Set(captured.flatMap((m) => [...m.fenced.keys()]))) expect(r.fenced[id], id).toBe(sum((m) => m.fenced.get(id) ?? 0));
    expect(r.foldParity).toBe(sum((m) => m.foldParity));
    for (const cause of seeded) expect(r.unknowns[cause], cause).toBe(sum((m) => m.unknowns.filter((u) => u.cause === cause).length));
    expect(r.findings["SEEDED-1"]).toEqual({ count: sum((m) => m.findings.get("SEEDED-1")?.count ?? 0), evidence: ["a1", "b1", "a2"] });
    expect(r.informativeSteps).toBe(sum((m) => informativeSteps(m).checked));
    expect(r.stepChecks["SEEDED-CHECK"]).toBe(7 * captured.length);
  });

  it("Review Focus 3 — fenced: #879 present, fences ON → no failure, and the fence fired (the walk kept exploring past it)", async () => {
    const r = await runCell(input({ fault879: true }));
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    expect(FENCES.map((f) => f.id)).toContain(FENCE_879);
    expect(r.fenced[FENCE_879]).toBeGreaterThan(0);
    // Exploring past the fence: every other command still ran, and nothing is vacuous.
    for (const k of COMMAND_KINDS) expect(r.counts[k].ran, k).toBeGreaterThan(0);
    expect(r.vacuous).toEqual([]);
    expect(r.fences).toBe(true);
  });

  it("fences OFF → #879 found on I7; the shrunk path is Generate, AddEntrant, Generate before any Start; seed and path logged", async () => {
    const r = await runCell(input({ fault879: true, fences: false }));
    expect(r.failure?.check).toBe(I7);
    const f = r.failure;
    if (f === null) throw new Error("unreachable: asserted above");
    const cmds = f.commands.map((c) => c.split("(")[0]);
    // #879 is pre-Start (T13 fix round 1): after Start the roster lock refuses AddEntrant.
    expect(cmds.indexOf("Start")).toBe(-1);
    expect(cmds.indexOf("Generate")).toBeGreaterThan(-1);
    expect(cmds.indexOf("AddEntrant")).toBeGreaterThan(cmds.indexOf("Generate"));
    expect(cmds.lastIndexOf("Generate")).toBeGreaterThan(cmds.indexOf("AddEntrant"));
    // Only commands that RAN are listed (R-PF9): the step that threw is the last one.
    expect(cmds.at(-1)).toBe("Generate");
    expect(f.path.length).toBeGreaterThan(0);
    expect(f.replayPath).toMatch(/\S/);
    expect(f.known).toBeNull();
    expect(f.seed).toBe(42);
    expect(f.evidence.join(" ")).toMatch(/meets 2×/);
    expect(r.fences).toBe(false);
    // A failing cell is judged by its failure, not by coverage.
    expect(r.vacuous).toEqual([]);
  });

  it("replay: the reported seed + path + replayPath reproduce the same failure and the same shrunk commands (R29, R-PF9)", async () => {
    const first = (await runCell(input({ fault879: true, fences: false }))).failure;
    if (first === null) throw new Error("the fences-off cell found nothing to replay");
    const again = await runCell(input({ fault879: true, fences: false, seed: first.seed, path: first.path, replayPath: first.replayPath ?? undefined, runs: 1 }));
    expect(again.failure?.check).toBe(first.check);
    expect(again.failure?.commands).toEqual(first.commands);
    expect(again.failure?.replayPath).toBe(first.replayPath);
  });

  it("a failure matching an OPEN committed regression on the same cell and check is known, by id; a FIXED one, or another cell or check, is not", async () => {
    const reg = { id: "MB-001", title: "#879", issue: "#879", cell: CELL, variant: "score", check: I7, seed: 1, path: "0", replayPath: null, fence: FENCE_879, status: "open" as const, found: "2026-09-28", runId: "t" };
    const r = await runCell(input({ fault879: true, fences: false, regressions: [reg] }));
    expect(r.failure?.known).toBe("MB-001");
    const fixed = await runCell(input({ fault879: true, fences: false, regressions: [{ ...reg, status: "fixed" }] }));
    expect(fixed.failure?.known).toBeNull();
    const elsewhere = await runCell(input({ fault879: true, fences: false, regressions: [{ ...reg, cell: "league|badminton" }, { ...reg, id: "MB-002", check: I8 }] }));
    expect(elsewhere.failure?.known).toBeNull();
  });

  it("an unexpected refusal (a result the model holds legal, refused by name) is a NEW failure on model-unexpected-refusal — known only through an open regression on that check", async () => {
    const r = await runCell(input({ driver: () => new RefusingPosts() }));
    expect(r.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(r.failure?.known).toBeNull();
    const unexpected = COMMAND_KINDS.reduce((s, k) => s + r.counts[k].unexpected, 0);
    expect(unexpected).toBeGreaterThan(0);
    const cmds = (r.failure?.commands ?? []).map((c) => c.split("(")[0]);
    expect(["Score", "Walkover"]).toContain(cmds.at(-1));
    expect(cmds).toContain("Start");
    const reg = { id: "MB-003", title: "t", issue: null, cell: CELL, variant: "score", check: UNEXPECTED_REFUSAL, seed: 1, path: "0", replayPath: null, fence: null, status: "open" as const, found: "2026-09-29", runId: "t" };
    expect((await runCell(input({ driver: () => new RefusingPosts(), regressions: [reg] }))).failure?.known).toBe("MB-003");
  });

  it("backstop: unexpected refusals counted while the reported failure is another check (or none) still report model-unexpected-refusal, NEW, carrying what it displaced", async () => {
    const seeded = (fault879: boolean): RunCellInput["newDriverState"] => async (n) => {
      const real = new ModelFakeDriver({ fault879 });
      const model = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
      model.counts.Void.unexpected = 1;
      return { real, model };
    };
    const none = await runCell(input({ newDriverState: seeded(false) }));
    expect(none.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(none.failure?.known).toBeNull();
    expect(none.failure?.evidence[0]).toMatch(/unexpected refusal/);
    const displaced = await runCell(input({ fences: false, newDriverState: seeded(true) }));
    expect(displaced.failure?.check).toBe(UNEXPECTED_REFUSAL);
    expect(displaced.failure?.evidence.join("\n")).toContain(I7);
    // A regression on the displaced check does not make the unexpected refusal known.
    const reg = { id: "MB-001", title: "#879", issue: "#879", cell: CELL, variant: "score", check: I7, seed: 1, path: "0", replayPath: null, fence: FENCE_879, status: "open" as const, found: "2026-09-28", runId: "t" };
    expect((await runCell(input({ fences: false, newDriverState: seeded(true), regressions: [reg] }))).failure?.known).toBeNull();
  });

  it("the shrink stays on its first failure's check: a candidate failing another check is passed over, counted in masked, never reported", async () => {
    // Two faults at once: #879 (I7) and an outcome nobody posted (fold parity).
    // Seed 62 was found by probing seeds 1-150: its first failure is fold
    // parity, and one shrink candidate on the way fails I7 instead — the only
    // seed of the 150 where that happens. Without the lock that candidate
    // would be taken and the cell would report I7 (killed by mutation).
    const r = await runCell(input({ opts: { lieOutcome: true }, fault879: true, fences: false, runs: 40, maxCommands: 12, seed: 62 }));
    expect(r.failure?.check).toBe("model-fold-parity");
    expect(r.masked).toEqual({ [I7]: 1 });
    expect(r.failure?.commands.map((c) => c.split("(")[0])).toEqual(["Start", "Score"]);
  });

  it("time box: once the clock passes the limit no further run starts — reported interrupted, numRuns short, never a failure", async () => {
    let t = 0;
    // Each read advances the clock 1 s; the deadline is read once, then once per run.
    const r = await runCell(input({ now: () => (t += 1000), timeLimitMs: 3500 }));
    expect(r.failure).toBeNull();
    expect(r.interrupted).toBe(true);
    expect(r.numRuns).toBe(3);
    expect(r.executions).toBe(3);
  });

  it("time box, empty case: a limit already spent runs nothing — vacuous, never a failure", async () => {
    let t = 0;
    const r = await runCell(input({ now: () => (t += 1000), timeLimitMs: 0 }));
    expect(r.failure).toBeNull();
    expect(r.interrupted).toBe(true);
    expect(r.numRuns).toBe(0);
    expect(r.executions).toBe(0);
    // R25, every line and each on its own: nothing ran, so every vacuity rule fires. With no
    // run, no stage kind is known, so only the invariants that apply to ANY stage are owed
    // (from the registry, never a typed list).
    expect(r.vacuous).toEqual([
      ...COMMAND_KINDS.map((k) => `command ${k} never ran`),
      "no Score was accepted",
      ...STEP_INVARIANTS.filter((s) => s.stageKinds === "any").map((s) => `step invariant ${s.id} checked zero items`),
      "fold parity compared zero fixtures",
      `no informative step (${VACUITY_CHECK})`,
    ]);
  });

  it("time box after a failure: the limit cuts the shrink short and the failure is still reported, unshrunk", async () => {
    const full = await runCell(input({ fault879: true, fences: false }));
    let started = 0;
    let last: ModelState | null = null;
    const cut = await runCell(input({
      fault879: true, fences: false,
      // The clock runs out the moment the first failing run has been started.
      now: () => (started >= full.numRuns ? Number.POSITIVE_INFINITY : 0),
      newDriverState: async (n) => {
        started = n;
        const real = new ModelFakeDriver({ fault879: true });
        last = await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` });
        return { real, model: last };
      },
    }));
    expect(cut.failure?.check).toBe(I7);
    expect(cut.interrupted).toBe(true);
    expect(cut.executions).toBe(full.numRuns);
    expect(cut.failure?.path).toBe(String(full.numRuns - 1));
    expect(cut.failure?.commands.length).toBeGreaterThanOrEqual(full.failure?.commands.length ?? Number.POSITIVE_INFINITY);
    // Unshrunk, the generated run still holds commands its preconditions skipped and commands
    // after the one that threw. Only the ones that RAN are listed (R-PF9): exactly the failing
    // run's own record of what it ran, in order, ending on the Generate that threw.
    const ran = (last as ModelState | null)?.history ?? [];
    expect(ran.length).toBeGreaterThan(0);
    expect(cut.failure?.commands).toEqual(ran);
    expect(ran.at(-1)?.split("(")[0]).toBe("Generate");
  });

  it("deterministic: the same seed gives the same report", async () => {
    expect(await runCell(input({ runs: 15 }))).toEqual(await runCell(input({ runs: 15 })));
  });
});
