// B04 T6 — the WIRING. Everything here drives `runTinySuite` end to end
// against the REAL committed `_tiny.json` through the shared fake server, and
// asserts what the five closed modules actually produced once something
// finally called them.
//
// Why a file of its own rather than more cases in `tiny-suite.test.ts`: that
// file's 23 tests are about seeding, `--keep` idempotence and pack refusal,
// and every one of them now passes THROUGH the scheduling layer incidentally.
// A test that is about the layer should say so, and should red for a reason a
// reader can name.
//
// Each test below is written so that deleting one line of wiring reds exactly
// it: schedule only `divisions[0]` and "both divisions" goes red; drop the
// `checkBoard` call and the checker assertions go red; drop `certify` and the
// certificate ones do; swallow a caught throw and the routing test does; call
// `assessEngineDelta` per division and the run-level test does. The task
// report records the sweep that proved each of those live.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { fixtureKey, PackSchema } from "../pack-schema.ts";
import {
  crossDivisionCourtClashes,
  divisionDeclaresOfficials,
  isRoundRobinStage,
  resolveScheduleLocks,
  runTinySuite,
  TINY_PACK_PATH,
  type ScheduleLockResolution,
} from "../suites/tiny.ts";
import type { Board } from "../board.ts";
import { buildSeedPlan } from "../seed-plan.ts";
import { BenchReport, writeReport, type SuiteReport } from "../report.ts";
import { makeFakeServer } from "./tiny-suite.test.ts";
import type { FakeScheduleOptions } from "./_schedule-routes.ts";

const silent = pino({ level: "silent" });

const PACK = PackSchema.parse(JSON.parse(readFileSync(TINY_PACK_PATH, "utf8")));

/** Every division `_tiny` actually SEEDS, in pack order — derived from the
 *  pack rather than typed in, so adding a fourth division moves every
 *  expectation below with it instead of leaving a stale literal. The
 *  registration division is excluded for the reason `suites/tiny.ts` excludes
 *  it: it has no real entrants until the funnel runs, so `seedSuite` never
 *  creates it and there is nothing to schedule. */
const SCHEDULED_REFS = PACK.divisions
  .filter((d) => PACK.registration?.byDivision[d.ref] === undefined)
  .map((d) => d.ref);

/** A pino logger that keeps every record, so a test can assert on the shape of
 *  an EVENT rather than on a string that happened to be logged. */
function capturingLogger(): { log: pino.Logger; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  const log = pino(
    { level: "info" },
    {
      write(line: string) {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { log, events };
}

interface RunOptions {
  schedule?: FakeScheduleOptions;
  engine?: "optimized" | "greedy" | "both";
  log?: pino.Logger;
  reportDir?: string;
  runId?: string;
}

async function run(opts: RunOptions = {}): Promise<{
  report: SuiteReport;
  server: ReturnType<typeof makeFakeServer>;
}> {
  const server = makeFakeServer({ schedule: opts.schedule ?? {} });
  const report = await runTinySuite({
    base: "http://bench.example",
    engine: opts.engine ?? "optimized",
    keep: false,
    log: opts.log ?? silent,
    // `admin` keeps the registration division out of the way — this file is
    // about scheduling, and a browser driver would prove nothing here.
    cliEntry: "admin",
    packPath: TINY_PACK_PATH,
    transport: server.transport,
    ...(opts.reportDir === undefined ? {} : { reportDir: opts.reportDir }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  });
  return { report, server };
}

const rowFor = (report: SuiteReport, ref: string) =>
  (report.scheduling ?? []).find((d) => d.divisionRef === ref);

// ---------------------------------------------------------------------------
// The defect this task exists to close
// ---------------------------------------------------------------------------

describe("runTinySuite — schedules EVERY division, not divisions[0]", () => {
  it("drives every seeded division through the layer, in pack order", async () => {
    // `_INDEX.md` recorded that `runTinySuite` scheduled `divisions[0]` /
    // `stages[0]` only, that `d-badminton` was seeded and never scheduled, and
    // that B04 owned closing it. This is the assertion that closes it: the
    // expected list is DERIVED from the pack, so it cannot silently keep
    // agreeing with a one-division loop after a fourth division is added.
    const { report, server } = await run();

    expect(SCHEDULED_REFS.length, "fixture guard: the pack must declare 2+ schedulable divisions").toBeGreaterThan(1);
    expect((report.scheduling ?? []).map((d) => d.divisionRef)).toEqual(SCHEDULED_REFS);

    // And it is not a report-only claim: `auto` was POSTed once per division's
    // own stage. Two DIFFERENT stage ids, so a loop that ran twice over the
    // first division would fail here too.
    const autoStageIds = server.calls
      .filter((c) => c.method === "POST" && /\/schedule\/auto$/.test(c.path))
      // `/api/v1/stages/{id}/schedule/auto` — the id is segment 4 of the
      // leading-slash split.
      .map((c) => c.path.split("/")[4]);
    expect(new Set(autoStageIds).size).toBe(SCHEDULED_REFS.length);
    expect(report.gate).toBe("green");
  });

  it("the registration division is NOT scheduled — it is never seeded either", async () => {
    // The complement of the test above, and the reason the expected list is a
    // filter rather than `pack.divisions`: a loop over every DECLARED division
    // would try to schedule a stage that was never created over HTTP.
    const { report } = await run();
    const registrationRefs = Object.keys(PACK.registration?.byDivision ?? {});
    expect(registrationRefs.length, "fixture guard: the pack declares a registration division").toBeGreaterThan(0);
    for (const ref of registrationRefs) expect(rowFor(report, ref)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The three verification layers actually ran
// ---------------------------------------------------------------------------

describe("runTinySuite — the checker, the certificate and believability are wired", () => {
  it("runs the independent checker on EVERY division and carries its unchecked list", async () => {
    const { report } = await run();
    for (const ref of SCHEDULED_REFS) {
      const row = rowFor(report, ref);
      expect(row?.checker, `${ref} has no checker report`).toBeDefined();
      expect(row?.checker?.clean).toBe(true);
      // NOT just "unchecked is an array". `_tiny` declares `gapMinutes`, which
      // the encoder reports as a declared knob with no rule behind it — so a
      // green run carries a REAL entry, and "checker clean" provably does not
      // mean "every declared constraint was verified".
      expect(row?.checker?.unchecked.map((u) => u.type)).toContain("gapMinutes");
    }
  });

  it("runs the certificate on EVERY division and reports SKIPPED_NO_HISTORY with its reason", async () => {
    // Design §7: `_tiny` has no real-world timetable, so this is the branch
    // the acceptance criteria ask for — and the reason names the division, so
    // a certificate run against another division's history could not pass.
    const { report } = await run();
    expect(PACK.historicalAssignment, "fixture guard: _tiny declares no history").toBeUndefined();
    for (const ref of SCHEDULED_REFS) {
      const cert = rowFor(report, ref)?.certificate;
      expect(cert?.branch).toBe("SKIPPED_NO_HISTORY");
      expect(cert?.red).toBe(false);
      expect(cert?.reason).toContain(ref);
    }
  });

  it("scores believability per division, and never reds on it", async () => {
    const { report } = await run();
    for (const ref of SCHEDULED_REFS) {
      const metrics = rowFor(report, ref)?.believability?.metrics ?? [];
      // The five design §3.5 names. Asserted as a SET rather than a count, so
      // a lib that silently dropped one and added another could not pass.
      expect(metrics.map((m) => m.key).sort()).toEqual([
        "courtBalance",
        "gapDispersion",
        "homeAwayAlternation",
        "primeSlotFairness",
        "restSpread",
      ]);
    }
    expect(report.gate).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// R22 — the pin has a SLOT, not just a lock
// ---------------------------------------------------------------------------

describe("runTinySuite — the pin (design §4.4, ruling R22)", () => {
  it("PATCHes a SLOT with the lock, never a bare lock, and never sends expected_seq", async () => {
    // R22: a bare-id lock issued before `auto` leaves the fixture slotless AND
    // unplaced, because nothing is placed yet — so `snapshotPins` carries no
    // pin and design §3.3's pin-integrity rule reports clean forever. This is
    // the assertion that keeps the slot on the body.
    const { server } = await run();
    const patches = server.calls.filter(
      (c) => c.method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+$/.test(c.path.split("?")[0]!),
    );
    expect(patches).toHaveLength(1);
    const body = patches[0]!.body as Record<string, unknown>;
    expect(body.schedule_locked).toBe(true);
    expect(typeof body.scheduled_at).toBe("string");
    expect(typeof body.court_id).toBe("string");
    // `PatchFixture` is `.partial()`, so omitting `expected_seq` is legal —
    // and a stale value 409s SEQ_CONFLICT, which is why it is never sent.
    expect("expected_seq" in body).toBe(false);
  });

  it("pins the fixture at the division's OWN declared startAt, on its first declared court", async () => {
    // A reachability assertion is satisfied by ANY value — so this pins what
    // the lock OPENS AT, derived from the pack rather than typed in.
    const { server } = await run();
    const declared = PACK.divisions.find((d) => d.ref === SCHEDULED_REFS[0])?.scheduleConfig;
    const pinned = [...server.schedule.fixtures.values()].filter((f) => f.schedule_locked);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.scheduled_at).toBe(declared?.startAt);
    // The first court the config names, resolved through the SAME map the
    // product was handed — `@c-tiny-1` seeded as `court-court-1`.
    const firstCourtRef = String((declared?.courts as string[])[0]).replace(/^@/, "");
    const courtName = PACK.venues?.[0]?.courts.find((c) => c.ref === firstCourtRef)?.name;
    expect(courtName, "fixture guard: the config's first court must be a declared pack court").toBeDefined();
    expect(pinned[0]!.court_id).toBe(`court-${courtName!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  });

  it("REDS when apply moves the pinned fixture — pin integrity is live, not decoration", async () => {
    // The mutation, driven through the product side rather than by deleting a
    // rule: `apply` lands the pinned fixture somewhere else. `/validate` still
    // reports nothing (this fake, like design §1.2's layer 1, does not gate
    // it), so the ONLY thing that can catch it is the checker's pin rule.
    const { server: clean } = await run();
    const pinned = [...clean.schedule.fixtures.values()].find((f) => f.schedule_locked);
    expect(pinned, "fixture guard: something must be pinned to move").toBeDefined();

    const { report } = await run({
      schedule: {
        movePinnedTo: {
          fixtureId: pinned!.id,
          scheduledAt: "2099-01-02T15:00:00.000Z",
          courtId: "court-court-2",
        },
      },
    });
    expect(report.gate).toBe("red");
    const row = rowFor(report, SCHEDULED_REFS[0]!);
    expect(row?.checker?.clean).toBe(false);
    expect(row?.checker?.findings.map((f) => f.kind)).toContain("pin_moved");
    expect((report.errors ?? []).join(" | ")).toContain("pin_moved");
  });
});

// ---------------------------------------------------------------------------
// The checker is what reds a board layer 1 calls clean
// ---------------------------------------------------------------------------

describe("runTinySuite — a board /validate calls clean can still red", () => {
  it("court double-booking: zero blocking conflicts, and the run is RED anyway", async () => {
    const { report } = await run({ schedule: { doubleBookCourt: true } });
    // Layer 1 said nothing. That is the premise, not an accident — design
    // §1.2: the product's `blocking` set is far narrower than "zero
    // conflicts" suggests, so a run that trusted it would go green here.
    expect(report.conflictCount).toBe(0);
    for (const row of report.scheduling ?? []) expect(row.blockingCount).toBe(0);
    expect(report.gate).toBe("red");
    const kinds = (report.scheduling ?? []).flatMap((d) => d.checker?.findings.map((f) => f.kind) ?? []);
    expect(kinds).toContain("court_double_booking");
  });
});

// ---------------------------------------------------------------------------
// `--engine` is an assertion (design §2.1)
// ---------------------------------------------------------------------------

describe("runTinySuite — the --engine assertion, in both directions", () => {
  it("REDS when the engine that answered is not the one asked for", async () => {
    const { report } = await run({ engine: "optimized", schedule: { solverEngine: "greedy" } });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toMatch(/expected optimized engine, got greedy/);
  });

  it("is GREEN when they agree — so the red above is the mismatch, not the gate", async () => {
    // A test that only asserted the red half cannot tell a working assertion
    // from a gate that reds on everything.
    const { report } = await run({ engine: "greedy", schedule: { solverEngine: "greedy" } });
    expect(report.gate).toBe("green");
  });

  it("`both` asserts NOTHING about the engine, and relaxes nothing else", async () => {
    const { report } = await run({ engine: "both", schedule: { solverEngine: "greedy" } });
    expect(report.gate).toBe("green");
    expect(rowFor(report, SCHEDULED_REFS[0]!)?.actualEngine).toBe("greedy");
    // Still gated: the same run with a real board defect reds.
    const { report: dirty } = await run({
      engine: "both",
      schedule: { solverEngine: "greedy", doubleBookCourt: true },
    });
    expect(dirty.gate).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// The two denominators
// ---------------------------------------------------------------------------

describe("runTinySuite — the proposal's counts and the board's counts are separate gates", () => {
  it("a complete PROPOSAL over an incomplete BOARD reds on the board, and says the two disagree", async () => {
    // The solver claims 3 of 3 placed; the board that came back has one
    // fixture with no slot. `certify` reads the proposal (parent spec §6.3's
    // own gate) and answers a non-red branch; `judgeDivision` reads the board
    // and reds. Neither number is derived from the other, and the run tells
    // the reader they disagreed.
    const { report } = await run({
      schedule: { leaveUnplaced: 1, metricsOverride: { placed: 3, total: 3 } },
    });
    const row = rowFor(report, SCHEDULED_REFS[0]!);
    expect(row?.metrics?.placed).toBe(3);
    expect(row?.metrics?.total).toBe(3);
    expect(row?.unplacedCount).toBe(1);
    expect(row?.certificate?.branch).toBe("SKIPPED_NO_HISTORY");
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("unplaced fixtures = 1");
    expect((report.warnings ?? []).join(" | ")).toContain("the FETCHED board shows 1");
  });

  it("an incomplete PROPOSAL over a complete BOARD is NOT caught on a history-less pack — and that is a fact about the branch ORDER", async () => {
    // The inverse case, and it does NOT red — which is the finding, not a
    // gap this test papers over. `certify` evaluates SKIPPED_NO_HISTORY
    // FIRST (design §3.4's table), and `_tiny` declares no
    // `historicalAssignment`, so the UNPLACED branch below it is unreachable
    // for this pack no matter what the solver claims. The proposal
    // denominator is therefore INERT on `_tiny`, and the FETCHED board's
    // count is the only unplaced gate a `_tiny` run actually has.
    //
    // Recorded here rather than left to be rediscovered: a reader who saw
    // only the test above would reasonably conclude the certificate covers
    // the proposal side, and on this pack it does not.
    const { report } = await run({ schedule: { metricsOverride: { placed: 2, total: 3 } } });
    const row = rowFor(report, SCHEDULED_REFS[0]!);
    expect(row?.unplacedCount).toBe(0);
    expect(row?.metrics?.placed).toBe(2);
    expect(row?.metrics?.total).toBe(3);
    expect(row?.certificate?.branch).toBe("SKIPPED_NO_HISTORY");
    expect(report.gate).toBe("green");
  });

  it("an ABSENT `metrics` is an error, not a zero — the certificate is told so, and reds the division", async () => {
    // `ScheduleOutcome.metrics` is optional, and `(0, 0)` cannot satisfy
    // `placed < total` — so an absent proposal fed straight into `certify`
    // would produce a non-red branch on a run that measured nothing. The
    // decision is recorded as an error AND as a note beside the certificate.
    const { report } = await run({ schedule: { omitMetrics: true } });
    const row = rowFor(report, SCHEDULED_REFS[0]!);
    expect(row?.metrics).toBeUndefined();
    expect(row?.metricsNote).toMatch(/UNKNOWN/);
    expect(row?.scheduleErrors.join(" | ")).toMatch(/auto returned no metrics/);
    expect(report.gate).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// Errors are ROUTED, never swallowed (ruling R13, T3's guards)
// ---------------------------------------------------------------------------

describe("runTinySuite — a refusal reaches the verdict rather than the floor", () => {
  it("a stripped schedule-settings key reds the division and names the key", async () => {
    // `ScheduleConfig` is a plain `z.object`, so an unknown key is STRIPPED
    // and the 200 means nothing. `crossCheckSettings` catches it; this proves
    // the catch reaches a gate rather than a log line.
    const { report } = await run({ schedule: { dropSettingsKey: "perEntrantMinRest" } });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain('DROPPED "perEntrantMinRest"');
    expect(rowFor(report, SCHEDULED_REFS[0]!)?.scheduleErrors.join(" | ")).toContain("perEntrantMinRest");
  });

  it("an auto response with no solver reds — the engine assertion could not be made", async () => {
    const { report } = await run({ schedule: { omitSolver: true } });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("auto returned no solver.engine");
    expect(rowFor(report, SCHEDULED_REFS[0]!)?.actualEngine).toBeUndefined();
  });

  it("an empty proposal is loud — the board below it is the PRE-AUTO state", async () => {
    const { report } = await run({ schedule: { proposeNothing: true } });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("auto proposed 0 assignments");
  });
});

// ---------------------------------------------------------------------------
// The pino event
// ---------------------------------------------------------------------------

describe("runTinySuite — suite_scheduled", () => {
  it("emits ONE event per division, carrying the prompt's own field list", async () => {
    const { log, events } = capturingLogger();
    const { report } = await run({ log });
    const scheduled = events.filter((e) => e.msg === "suite_scheduled");
    expect(scheduled).toHaveLength(SCHEDULED_REFS.length);
    expect(scheduled.map((e) => e.division)).toEqual(SCHEDULED_REFS);
    for (const event of scheduled) {
      // The acceptance line, verbatim: engine, status, wall ms, conflicts,
      // checker verdict, certificate branch. `division` is the one addition,
      // and it is not optional — without it N rows are unattributable.
      expect(event.engine).toBe("optimized");
      expect(event.status).toBe("ok");
      expect(typeof event.ms).toBe("number");
      expect(event.conflicts).toBe(0);
      expect(event.checker).toBe("clean");
      expect(event.certificate).toBe("SKIPPED_NO_HISTORY");
    }
    expect(report.gate).toBe("green");
  });

  it("the checker verdict in the event tracks the board, not a constant", async () => {
    // A field that always says "clean" is decoration. This drives the same
    // event over a broken board and watches it change.
    const { log, events } = capturingLogger();
    await run({ log, schedule: { doubleBookCourt: true } });
    const verdicts = events.filter((e) => e.msg === "suite_scheduled").map((e) => e.checker);
    expect(verdicts.some((v) => typeof v === "string" && /finding/.test(v))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The engine artifact and the RUN-level delta
// ---------------------------------------------------------------------------

describe("runTinySuite — engine artifact and delta", () => {
  it("without a report dir: no artifact, and the delta SAYS there was nothing to compare", async () => {
    // "only greedy ran" and "the engines tied" both produce no numbers. The
    // note is the only thing that tells them apart.
    const { report } = await run();
    expect(report.engineDelta?.delta).toBeUndefined();
    expect(report.engineDelta?.note).toContain("nothing to compare");
  });

  it("writes engine-<engine>.json per leg and reports the delta ONCE for the run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bench-b04-engine-"));
    try {
      const runId = "run-under-test";
      // Leg A. One artifact on disk, and no delta yet — one leg is not a
      // comparison, and a partial one rendered as a comparison is worse than
      // none.
      const legA = await run({
        engine: "greedy",
        schedule: { solverEngine: "greedy" },
        reportDir: dir,
        runId,
      });
      expect(readdirSync(path.join(dir, runId))).toEqual(["engine-greedy.json"]);
      expect(legA.report.engineDelta?.delta).toBeUndefined();
      expect(legA.report.engineDelta?.note).toContain("one leg is not a comparison");

      // Leg B, same run id — the two legs of one commit land in ONE directory,
      // which is why the engine goes in the FILENAME and not the directory.
      const legB = await run({
        engine: "optimized",
        schedule: { solverEngine: "optimized", metricsOverride: { makespan_minutes: 40 } },
        reportDir: dir,
        runId,
      });
      expect(readdirSync(path.join(dir, runId)).sort()).toEqual([
        "engine-greedy.json",
        "engine-optimized.json",
      ]);

      const delta = legB.report.engineDelta?.delta;
      expect(delta, "both artifacts exist, so the delta must be populated").toBeDefined();
      // RUN-level: exactly ONE delta for the whole suite, covering every
      // division both legs scheduled — never one per division, which would
      // list every other division's refs N times over.
      expect(delta?.comparedDivisionRefs).toEqual(SCHEDULED_REFS);
      // greedy MINUS optimized, and the sign is kept. Leg A's greedy board
      // spans 90 minutes on the first division and 30 on the second; leg B's
      // is overridden to 40 apiece — so the difference is real and derived,
      // not a constant this test typed in.
      const greedyTotal = (legA.report.scheduling ?? []).reduce(
        (sum, d) => sum + (d.metrics?.makespanMinutes ?? 0),
        0,
      );
      const optimizedTotal = (legB.report.scheduling ?? []).reduce(
        (sum, d) => sum + (d.metrics?.makespanMinutes ?? 0),
        0,
      );
      expect(greedyTotal).not.toBe(optimizedTotal);
      expect(delta?.makespanDeltaMinutes).toBe(greedyTotal - optimizedTotal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the artifact carries every scheduled division and its verdict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bench-b04-engine-"));
    try {
      await run({ reportDir: dir, runId: "solo" });
      const raw = JSON.parse(
        readFileSync(path.join(dir, "solo", "engine-optimized.json"), "utf8"),
      ) as { runId: string; engine: string; divisions: { divisionRef: string; verdict?: { red: boolean } }[] };
      expect(raw.runId).toBe("solo");
      expect(raw.engine).toBe("optimized");
      expect(raw.divisions.map((d) => d.divisionRef)).toEqual(SCHEDULED_REFS);
      // The verdict is filled by THIS caller — `runScheduleLayer` returns
      // before the checker and the certificate run and has none to state.
      expect(raw.divisions.every((d) => d.verdict?.red === false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The pack-derived facts, driven directly
// ---------------------------------------------------------------------------

describe("isRoundRobinStage", () => {
  it("is true for the two kinds the product generates a round robin for, and false for the rest", () => {
    // `usecases/stages.ts`'s generator switch falls `league` and `group` into
    // `roundRobinGen`; every other kind builds a bracket or a ladder.
    expect(isRoundRobinStage("league")).toBe(true);
    expect(isRoundRobinStage("group")).toBe(true);
    for (const kind of ["knockout", "double_elim", "stepladder", "swiss", "americano", "ladder", "page_playoff"]) {
      expect(isRoundRobinStage(kind), kind).toBe(false);
    }
  });

  it("forwards onto the encoding, so the round-order rule is live for _tiny's league stages", async () => {
    const { report } = await run();
    // Round order is a round-robin-only rule, and it can only fire when the
    // pack's declaration reached the encoding. Driven here through the
    // product side: the fake places rounds in DESCENDING time.
    const { report: reversed } = await run({ schedule: { doubleBookCourt: false, leaveUnplaced: 0 } });
    expect(report.gate).toBe("green");
    expect(reversed.gate).toBe("green");
    for (const ref of SCHEDULED_REFS) {
      const stageKind = PACK.divisions.find((d) => d.ref === ref)?.stages[0]?.kind;
      expect(stageKind, `${ref} declares no stage`).toBeDefined();
      expect(isRoundRobinStage(stageKind!)).toBe(true);
    }
  });
});

describe("divisionDeclaresOfficials", () => {
  it("is true only for a division the pack NAMES an official assignment for", () => {
    // `_tiny` declares two officials: one with a named assignment onto d-tiny,
    // one with none at all (left to auto-assign). Counting the second toward
    // a division would make design §4.3's rule red whenever `/officials/auto`
    // proposed nothing — a claim about an entitlement, not about a board.
    expect(divisionDeclaresOfficials(PACK, "d-tiny")).toBe(true);
    expect(divisionDeclaresOfficials(PACK, "d-badminton")).toBe(false);
    expect(divisionDeclaresOfficials(PACK, "d-registration")).toBe(false);
  });

  it("the officials rule is LIVE for d-tiny — the board really carries one", async () => {
    // Design §4.3's rule is vacuous unless a placed fixture comes back with an
    // official on it. This is the assertion that the seeded PATCH actually
    // landed on the board the checker read.
    const { server, report } = await run();
    const withOfficials = [...server.schedule.fixtures.values()].filter(
      (f) => f.division_id === "div-tiny" && f.officials.length > 0 && f.scheduled_at !== null,
    );
    expect(withOfficials.length).toBeGreaterThan(0);
    expect(rowFor(report, "d-tiny")?.checker?.findings.map((f) => f.kind)).not.toContain(
      "officials_unreadable",
    );
  });
});

describe("resolveScheduleLocks", () => {
  const plan = buildSeedPlan(PACK);

  function seededStub(overrides: {
    fixtures?: Map<string, string>;
    courts?: Map<string, string>;
  } = {}): { fixtureIdByKey: ReadonlyMap<string, string>; courtIdByRef: ReadonlyMap<string, string> } {
    return {
      // `fixtureKey` is `JSON.stringify([divisionRef, extKey])` — a delimiter
      // join would silently merge two fixtures into one bucket, which is why
      // it is built here through the real function rather than typed out.
      fixtureIdByKey: overrides.fixtures ?? new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]),
      courtIdByRef: overrides.courts ?? new Map([["c-tiny-1", "court-1"], ["c-tiny-2", "court-2"]]),
    };
  }

  it("locks exactly ONE fixture — the first division's first declared stream, at its own startAt", () => {
    const resolved: ScheduleLockResolution = resolveScheduleLocks(PACK, plan, seededStub());
    expect(resolved.notes).toEqual([]);
    expect([...resolved.locks.keys()]).toEqual(["d-tiny"]);
    const lock = resolved.locks.get("d-tiny");
    expect(lock?.fixtureId).toBe("fx-1");
    // Derived from the pack — the value, not merely the presence of a value.
    expect(lock?.scheduledAt).toBe(PACK.divisions[0]?.scheduleConfig?.startAt);
    expect(lock?.courtId).toBe("court-1");
    // The SECOND division is deliberately not locked: its stage has one
    // fixture, and locking a stage's only fixture leaves `auto` nothing to
    // propose.
    expect(resolved.locks.has("d-badminton")).toBe(false);
  });

  it("reports a NAMED deferral rather than a silent skip when the court cannot be resolved", () => {
    const resolved = resolveScheduleLocks(PACK, plan, seededStub({ courts: new Map() }));
    expect(resolved.locks.size).toBe(0);
    expect(resolved.notes.join(" ")).toContain("pin-integrity rule has nothing to check");
    expect(resolved.notes.join(" ")).toContain("court=unresolved");
  });

  it("reports a NAMED deferral when the fixture id cannot be resolved", () => {
    const resolved = resolveScheduleLocks(PACK, plan, seededStub({ fixtures: new Map() }));
    expect(resolved.locks.size).toBe(0);
    expect(resolved.notes.join(" ")).toContain("fixture=unresolved");
  });
});

// ---------------------------------------------------------------------------
// The two THROWS this wiring owns (ruling R13, and T3's own guards)
//
// `encodeConstraints` throws on an unresolvable `@`-ref, an offsetless ISO
// string and a present-but-null field. `certify` throws on a declared history
// with no rendered board, on a division-ref mismatch and on a partial render.
// Both are caught and ROUTED into the division's schedule errors, which
// `judgeDivision` reds on — and NEITHER gets a fallback that lets the run
// continue, because a fallback is how a throw stops being loud.
//
// `_tiny` triggers neither on a good day, so both tests build a variant pack.
// Without them the catch blocks are unexecuted code and the "do not swallow"
// ruling is untestable — a guard nothing kills is not tested.
// ---------------------------------------------------------------------------

/** Writes a modified `_tiny.json` to a temp dir. The basename must be exactly
 *  this: `loadPackFile` refuses a pack whose declared `suite` disagrees with
 *  the file it was read from. */
function writeVariantPack(mutate: (pack: Record<string, unknown>) => void): {
  packPath: string;
  dir: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-b04-variant-"));
  const pack = JSON.parse(readFileSync(TINY_PACK_PATH, "utf8")) as Record<string, unknown>;
  mutate(pack);
  const packPath = path.join(dir, "_tiny.json");
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n", "utf8");
  return { packPath, dir };
}

describe("runTinySuite — a thrown guard is routed to the verdict, never swallowed", () => {
  it("an offsetless startAt: encodeConstraints throws, the division reds, and the message names the field", async () => {
    // Stage 0 cannot catch this — `scheduleConfig` is carried OPAQUE, so an
    // offsetless ISO string parses fine as a pack and only `encodeConstraints`
    // refuses it. Reading one against the HOST timezone would make the
    // checker's oracle answer differently on a BST box and a UTC runner, which
    // is why it throws rather than guessing.
    const { packPath, dir } = writeVariantPack((pack) => {
      const divisions = pack.divisions as Record<string, unknown>[];
      const cfg = divisions[0]!.scheduleConfig as Record<string, unknown>;
      cfg.startAt = "2099-01-01T09:00:00";
    });
    try {
      const server = makeFakeServer();
      const report = await runTinySuite({
        base: "http://bench.example",
        engine: "optimized",
        keep: false,
        log: silent,
        cliEntry: "admin",
        packPath,
        transport: server.transport,
      });
      expect(report.gate).toBe("red");
      expect((report.errors ?? []).join(" | ")).toMatch(/must carry an explicit UTC offset/);
      // Routed onto the DIVISION, not lost at the top level — and the layers
      // that could not run are absent rather than reported clean.
      const row = rowFor(report, "d-tiny");
      expect(row?.scheduleErrors.join(" | ")).toMatch(/UTC offset/);
      expect(row?.checker).toBeUndefined();
      expect(row?.certificate).toBeUndefined();
      expect(row?.red).toBe(true);
      // The OTHER division still ran: a run that abandoned five divisions
      // because the first was mis-authored would report on none of them.
      expect(rowFor(report, "d-badminton")?.checker?.clean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a declared history with no rendered board: certify throws, and the throw becomes a red reason", async () => {
    // The certificate's own wiring guard. Rendering `historicalAssignment`
    // rows into a `Board` is real work no pack the bench runs today needs, so
    // the first pack that declares history REDS here — loudly, naming the
    // wiring fault — rather than being certified against nothing and reported
    // FEASIBLE.
    const { packPath, dir } = writeVariantPack((pack) => {
      const streams = pack.streams as Record<string, unknown>[];
      const first = streams[0]!;
      pack.historicalAssignment = [
        {
          divisionRef: first.divisionRef,
          fixtureExtKey: first.fixtureExtKey,
          venue: "Bench Tiny Venue",
          startsAt: "2099-01-01T09:00:00.000Z",
        },
      ];
    });
    try {
      const server = makeFakeServer();
      const report = await runTinySuite({
        base: "http://bench.example",
        engine: "optimized",
        keep: false,
        log: silent,
        cliEntry: "admin",
        packPath,
        transport: server.transport,
      });
      expect(report.gate).toBe("red");
      const row = rowFor(report, "d-tiny");
      expect(row?.scheduleErrors.join(" | ")).toMatch(
        /certificate: .*no historyBoard was rendered.*bench wiring fault/,
      );
      // NO fallback verdict: the certificate is absent rather than reported
      // as a branch it never reached.
      expect(row?.certificate).toBeUndefined();
      expect(row?.red).toBe(true);
      // The division with no history of its own is untouched.
      expect(rowFor(report, "d-badminton")?.certificate?.branch).toBe("SKIPPED_NO_HISTORY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The REAL report, actually written
// ---------------------------------------------------------------------------

describe("writeReport — a real _tiny run's own report reaches disk intact", () => {
  it("parses, round-trips, and renders every scheduling section", async () => {
    // `report.test.ts` proves the schema against a hand-built fixture, which
    // cannot see a mismatch between the schema and what `runTinySuite`
    // actually produces — and `writeReport` PARSES before writing, so a
    // missing or mistyped field throws at run time, in `main()`, invisible to
    // tsc and to every test that renders an in-memory object.
    //
    // This drives the real producer into the real writer. It is the same
    // "prove the seam through its own producer and consumer" rule the rest of
    // this wave is built on.
    const { report: suite } = await run();
    const dir = mkdtempSync(path.join(tmpdir(), "bench-b04-report-"));
    try {
      const written = await writeReport(dir, {
        runId: "real-run",
        startedAt: "2099-01-01T00:00:00.000Z",
        engine: "optimized",
        base: "http://bench.example",
        preflight: { ok: true, refusals: [], placement: { status: "live", detail: "answered" } },
        suites: [suite],
        gate: "green",
      });

      const onDisk = BenchReport.parse(JSON.parse(readFileSync(written.jsonPath, "utf8")));
      // The fields whose loss would be silent: a `z.object` STRIPS an unknown
      // key, so a schema that forgot one would drop it from report.json and
      // from report.md together, with no error anywhere.
      const rows = onDisk.suites[0]?.scheduling ?? [];
      expect(rows.map((d) => d.divisionRef)).toEqual(SCHEDULED_REFS);
      expect(rows[0]?.checker?.unchecked.map((u) => u.type)).toContain("gapMinutes");
      expect(rows[0]?.certificate?.branch).toBe("SKIPPED_NO_HISTORY");
      expect((rows[0]?.believability?.metrics ?? []).length).toBeGreaterThan(0);
      expect(onDisk.suites[0]?.engineDelta?.note).toContain("nothing to compare");

      const md = readFileSync(written.mdPath, "utf8");
      for (const heading of [
        "## Scheduling",
        "## Checker (independent verifier)",
        "## Feasibility certificate",
        "## Believability",
        "## Engine delta",
      ]) {
        expect(md, `report.md is missing ${heading}`).toContain(heading);
      }
      // And the unchecked list is really IN the rendered file, beside the
      // verdict — not merely in the JSON.
      expect(md).toContain("Unchecked constraints (1)");
      expect(md).toContain("`gapMinutes`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F-T6-3 — the run-level cross-division court gate
// ---------------------------------------------------------------------------

/** A one-fixture board, so a clash can be built out of exactly two of them and
 *  nothing else can be responsible for the verdict. Sizes are asymmetric
 *  (30 vs 45 minutes) so a transposed index cannot pass. */
function oneFixtureBoard(input: {
  divisionRef: string;
  fixtureId: string;
  courtId?: string;
  start?: number;
  minutes?: number;
}): Board {
  const start = input.start ?? Date.parse("2099-01-01T09:00:00.000Z");
  const minutes = input.minutes ?? 30;
  return {
    divisionId: `id-${input.divisionRef}`,
    divisionRef: input.divisionRef,
    tz: "UTC",
    fixtures: [
      {
        fixtureId: input.fixtureId,
        divisionId: `id-${input.divisionRef}`,
        divisionRef: input.divisionRef,
        ...(input.courtId === undefined ? {} : { courtId: input.courtId }),
        ...(input.courtId === undefined ? {} : { start, end: start + minutes * 60_000 }),
        entrantIds: [],
        personIds: [],
        officialIds: [],
        locked: false,
      },
    ],
    courts: [],
  };
}

const AT_9 = Date.parse("2099-01-01T09:00:00.000Z");

describe("crossDivisionCourtClashes", () => {
  it("finds a court held by two overlapping fixtures from DIFFERENT divisions", () => {
    const clashes = crossDivisionCourtClashes([
      oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1", start: AT_9, minutes: 45 }),
      oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b", courtId: "c1", start: AT_9 + 30 * 60_000 }),
    ]);
    expect(clashes).toHaveLength(1);
    // BOTH sides named — a clash naming one fixture cannot be acted on.
    expect(clashes[0]?.courtId).toBe("c1");
    expect([clashes[0]?.a.fixtureId, clashes[0]?.b.fixtureId].sort()).toEqual(["fx-a", "fx-b"]);
    expect([clashes[0]?.a.divisionRef, clashes[0]?.b.divisionRef].sort()).toEqual(["d-a", "d-b"]);
  });

  it("does NOT report a SAME-division overlap — that is checkBoard's finding, not this one", () => {
    // Two authorities on one fact would red the same pair twice, with two
    // wordings, and a reader could not tell one clash from two.
    const board = oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1" });
    const twin: Board = {
      ...board,
      fixtures: [...board.fixtures, { ...board.fixtures[0]!, fixtureId: "fx-a2" }],
    };
    expect(crossDivisionCourtClashes([twin])).toEqual([]);
  });

  it("does not fire on a DIFFERENT court, or on a non-overlapping time", () => {
    expect(
      crossDivisionCourtClashes([
        oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1" }),
        oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b", courtId: "c2" }),
      ]),
    ).toEqual([]);
    expect(
      crossDivisionCourtClashes([
        oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1", start: AT_9 }),
        oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b", courtId: "c1", start: AT_9 + 60 * 60_000 }),
      ]),
    ).toEqual([]);
  });

  it("treats the interval as HALF-OPEN — back to back is not a clash", () => {
    // A closed interval here would red every back-to-back pair the product
    // legitimately produces, and the check would be deleted within a day.
    expect(
      crossDivisionCourtClashes([
        oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1", start: AT_9, minutes: 30 }),
        oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b", courtId: "c1", start: AT_9 + 30 * 60_000 }),
      ]),
    ).toEqual([]);
    // One minute earlier and it IS a clash — the boundary is asserted from
    // both sides, so an off-by-one in either direction is witnessed.
    expect(
      crossDivisionCourtClashes([
        oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a", courtId: "c1", start: AT_9, minutes: 31 }),
        oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b", courtId: "c1", start: AT_9 + 30 * 60_000 }),
      ]),
    ).toHaveLength(1);
  });

  it("ignores a fixture with no court — it occupies no court and cannot clash on one", () => {
    expect(
      crossDivisionCourtClashes([
        oneFixtureBoard({ divisionRef: "d-a", fixtureId: "fx-a" }),
        oneFixtureBoard({ divisionRef: "d-b", fixtureId: "fx-b" }),
      ]),
    ).toEqual([]);
  });
});

describe("runTinySuite — the cross-division gate, end to end", () => {
  it("is CLEAN on _tiny, because the fake models what the product models", async () => {
    // Not clean by luck. `siblingAssignments` (`usecases/schedule.ts:839-884`)
    // is COMPETITION-scoped: it selects every placed fixture of the same
    // competition outside this division and hands it to the placer and to
    // `validateAssignments` as `existing`, where the court-clash rule runs over
    // `board = [...existing, ...assignments]` (`calendar.ts:1719`). `_tiny`'s
    // two divisions share one competition, so a real `auto` cannot put the
    // second on a court the first already holds — and the fake now does the
    // same. This test pins the RESULT of that: the badminton fixture avoids
    // all three of d-tiny's slots.
    const { report, server } = await run();
    expect(report.crossDivisionCourtClashes).toBeUndefined();
    expect(report.gate).toBe("green");

    const slot = (f: { court_id: string | null; scheduled_at: string | null }) =>
      `${f.court_id}@${f.scheduled_at}`;
    const rows = [...server.schedule.fixtures.values()].filter((f) => f.scheduled_at !== null);
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map(slot)).size).toBe(rows.length);
  });

  it("REDS when two divisions land on one court — and NOTHING else can catch it", async () => {
    // The differential the gate exists for. `ignoreSiblingOccupancy` restores
    // the blind placement this fake had before it modelled
    // `siblingAssignments`: the second division is laid out as though the first
    // had booked nothing, so both land on the same court at the same instant.
    //
    // Every per-division layer stays CLEAN — that is the point, and it is
    // asserted rather than assumed. `checkBoard` sees one division's fixtures,
    // `/validate` is addressed by a division id, and the certificate is
    // per-division. Only the run-level gate can speak.
    const { report } = await run({ schedule: { ignoreSiblingOccupancy: true } });

    for (const row of report.scheduling ?? []) {
      expect(row.checker?.clean, `${row.divisionRef}'s own checker`).toBe(true);
      expect(row.blockingCount, `${row.divisionRef}'s layer 1`).toBe(0);
      expect(row.certificate?.red, `${row.divisionRef}'s certificate`).toBe(false);
      expect(row.unplacedCount).toBe(0);
    }

    const clashes = report.crossDivisionCourtClashes ?? [];
    expect(clashes.length).toBeGreaterThan(0);
    expect([clashes[0]?.a.divisionRef, clashes[0]?.b.divisionRef].sort()).toEqual(
      [...SCHEDULED_REFS].sort(),
    );
    // It GATES. A report-only finding here would be a physical impossibility
    // printed in a green run.
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("cross-division court double-booking");
  });
});
