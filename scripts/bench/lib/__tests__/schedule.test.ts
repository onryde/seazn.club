// Unit coverage for lib/schedule.ts — B04's ONLY HTTP driver.
//
// Every call goes through the injected `SeedTransport` (lib/seed.ts:148, the
// same DI seam `seedSuite` and `runPreflight` already use): nothing here
// touches `global.fetch`, no live server, no Postgres. Same split as
// lib/__tests__/seed.test.ts, and for the same reason — CI runs the bench lib
// suite with no live infra.
//
// What this file is actually guarding, beyond "the driver works":
//
//  1. THE BOARD IS FETCHED, NEVER ECHOED (design §4.1). A driver that
//     assembled its `Board` from the `assignments` array it POSTed would pass
//     a naive fixture, so every fixture below returns a court/time from
//     `GET /fixtures` that DIFFERS from the one `auto` proposed. An echoing
//     driver fails, not passes.
//  2. THE ENGINE ASSERTION IS A GATE (design §2.1). `--engine` cannot select
//     an engine — `AutoScheduleRequest` has no such field — so its only
//     meaning is asserting the one that ran. Both directions are covered, and
//     `both` is covered proving it relaxes ONLY the engine assertion.
//  3. R12 — occupancy is `[start, start + matchMinutes)`. `gapMinutes` is set
//     NON-ZERO in the shared config below and every `end`/duration assertion
//     is chosen so that folding the gap in would produce a different number.
//  4. R13 — a thrown `encodeConstraints` is caught here and routed into
//     `ScheduleOutcome.errors`, the list `judgeDivision` already reds on.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoard } from "../checker.ts";
import type { RequestOptions, Session } from "../http.ts";
import type { SeedTransport } from "../seed.ts";
import {
  readEngineArtifacts,
  runScheduleLayer,
  writeEngineArtifact,
  type EngineSnapshot,
  type ScheduleDivision,
  type ScheduleLayerInput,
} from "../schedule.ts";

const BASE = "http://bench.test";
const ORG = "org-1";
const SESSION: Session = { cookies: {} };

/** `@`-sigilled pack refs -> the ids B03's seeder handed back. */
const COURTS = new Map([
  ["c1", "court-1"],
  ["c2", "court-2"],
]);

/** matchMinutes 45 and gapMinutes 15 are deliberately DIFFERENT and both
 *  non-zero: every duration assertion below is 45 minutes, so a driver that
 *  folded the gap into occupancy (R12 says it must not) lands on 60 and fails. */
const CONFIG: Record<string, unknown> = {
  startAt: "2099-01-01T09:00:00.000Z",
  matchMinutes: 45,
  gapMinutes: 15,
  courts: ["@c1", "@c2"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const T0 = Date.parse("2099-01-01T09:00:00.000Z");
const MIN = 60_000;

/** One placed fixture. Used by every script whose subject is NOT the board, so
 *  that `auto` has something to propose and `/apply` is actually reached — an
 *  empty proposal is a solver refusal, not a neutral default. */
const PLACED = (): Record<string, unknown>[] => [
  fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1", court_name: "Court 1" }),
];

function divA(over: Partial<ScheduleDivision> = {}): ScheduleDivision {
  return {
    divisionRef: "d-a",
    divisionId: "div-a",
    stageId: "stage-a",
    tz: "UTC",
    isRoundRobin: true,
    declaresOfficials: false,
    scheduleConfig: CONFIG,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Wire-row builders — full `S.Fixture` / `S.VenueWithCourts` shapes
// ---------------------------------------------------------------------------

/** One `GET /api/v1/divisions/{id}/fixtures` row (schemas.ts:1000-1055 minus
 *  the frozen `venue`/`court_label` the route strips). Every field the driver
 *  reads is defaulted here so a test names only what it is about. */
function fx(over: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return {
    stage_id: "stage-a",
    division_id: "div-a",
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    fixture_no: 1,
    home_entrant_id: null,
    away_entrant_id: null,
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: null,
    court_id: null,
    court_name: null,
    venue_id: null,
    venue_name: null,
    officials: [],
    status: "scheduled",
    outcome: null,
    schedule_source: "auto",
    schedule_locked: false,
    created_at: "2099-01-01T00:00:00.000Z",
    ext_key: null,
    ...over,
  };
}

/** One `GET /api/v1/orgs/{id}/venues` row, courts nested with their full
 *  calendar — snake_case on the wire (`open_min`/`close_min`), camelCase on
 *  the engine's `CourtHoursRow`, which is exactly the mapping the driver owns. */
function venue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "venue-1",
    name: "Riverside",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2099-01-01T00:00:00.000Z",
    courts: [court()],
    ...over,
  };
}

/** One nested court row. Weekday 4 is the weekday of 2099-01-01 (checked, not
 *  assumed), so the default calendar declares 08:00-22:00 on the very day every
 *  fixture below is placed — which is what lets a test narrow or widen that day
 *  with an exception and see the difference. */
function court(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "court-1",
    venue_id: "venue-1",
    name: "Court 1",
    sort: 0,
    tags: [],
    archived_at: null,
    created_at: "2099-01-01T00:00:00.000Z",
    hours: [{ weekday: 4, open_min: 480, close_min: 1320 }],
    exceptions: [{ date: "2099-01-02", closed: true, open_min: null, close_min: null }],
    ...over,
  };
}

/** A venues payload whose only court carries exactly these exception rows. */
function venuesWithExceptions(exceptions: Record<string, unknown>[]): Record<string, unknown>[] {
  return [venue({ courts: [court({ exceptions })] })];
}

// ---------------------------------------------------------------------------
// The fake transport
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** One division's scripted responses. `fixturesBefore` answers step 3's GET
 *  (the pin snapshot) and `fixturesAfter` answers step 7's (the board) — two
 *  DIFFERENT payloads on one path, which is what makes "snapshot BEFORE auto"
 *  a falsifiable claim rather than a restatement. */
interface DivisionScript {
  fixturesBefore?: Record<string, unknown>[];
  fixturesAfter?: Record<string, unknown>[];
  auto?: Record<string, unknown>;
  validate?: { conflicts: Record<string, unknown>[] };
}

interface Script {
  divisions?: Record<string, DivisionScript>;
  venues?: Record<string, unknown>[];
  /** Config keys this product build silently drops on the PUT — a key the pack
   *  declared and `ScheduleConfig` has no member for. */
  stripConfigKeys?: string[];
  /** Values the product persisted DIFFERENTLY from what was sent. */
  configOverrides?: Record<string, unknown>;
  /** What the PUT reports as the RESOLVED zone (`ScheduleSettings.tz`,
   *  `schemas.ts:1450` — "stored division tz -> org timezone -> 'UTC'"). Unset
   *  means the fake echoes the tz it was sent, which is what a product build
   *  that accepted the pin does. `null` models a response carrying no readable
   *  tz at all. Set it to a DIFFERENT zone to model the case that matters: the
   *  product refused or fell back, and every wall-clock rule downstream is
   *  being judged in a zone the scheduler never used. */
  settingsTz?: string | null;
}

/** `ScheduleConfig`'s own top-level keys (`schemas.ts:1283-1426`). The fake
 *  PUT strips anything not in here, because that schema is a plain `z.object`
 *  and a plain zod object STRIPS an unknown key rather than refusing it. A
 *  fake that echoed the request back would model a `.strict()` schema the
 *  product does not have. */
const SCHEDULE_CONFIG_KEYS = new Set([
  "startAt",
  "endAt",
  "matchMinutes",
  "gapMinutes",
  "courts",
  "perEntrantMinRest",
  "blackouts",
  "sessionWindows",
  "roundMinutes",
  "constraints",
]);

/** NOTE: no `mode`. The fake DERIVES it from the request body exactly as
 *  `AutoScheduleRequest`'s preprocess does, so a driver that sends the wrong
 *  body gets the wrong mode back instead of the one this constant wished for.
 *  Hard-coding `mode: "build"` here is what let an empty request body — which
 *  can only ever derive `"reflow"` — look like a build for 41 green tests. */
const OK_SOLVER = {
  engine: "optimized",
  status: "ok",
  tiers_completed: 4,
  tiers_total: 4,
  budget_expired: false,
  elapsed_ms: 12,
  moved: 1,
};

/** `AutoScheduleRequest`'s preprocess (`schemas.ts:1645-1651`), reproduced so
 *  the fake cannot be kinder than the product. `=== false` and not
 *  `!only_unlocked`: an ABSENT flag defaults to true and derives a reflow. */
function derivedMode(body: unknown): "build" | "reflow" | "polish" {
  if (!isPlainObject(body)) return "reflow";
  const declared = body.mode;
  if (declared === "build" || declared === "reflow" || declared === "polish") return declared;
  return body.only_unlocked === false ? "build" : "reflow";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OK_METRICS = {
  makespan_minutes: 45,
  worst_idle_gap_minutes: 0,
  court_imbalance_minutes: 0,
  placed: 1,
  total: 1,
};

function fakeTransport(script: Script = {}): { transport: SeedTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  // Per-division GET counter: the first `GET /fixtures` is the pin snapshot,
  // the second is the board. Counting is the only way to hand back two
  // different payloads on one path.
  const fixtureGets = new Map<string, number>();

  const transport: SeedTransport = {
    async signIn() {
      throw new Error("fake transport: runScheduleLayer must never sign in — it is handed a session");
    },
    async request<T>(_base: string, _s: Session, reqPath: string, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? "GET";
      calls.push({ method, path: reqPath, body: opts?.body });

      const settings = /^\/api\/v1\/divisions\/([^/]+)\/schedule-settings$/.exec(reqPath);
      if (method === "PUT" && settings) {
        // `putScheduleSettings` returns the PERSISTED `ScheduleSettings`
        // (`schemas.ts:1446`), not an echo — and what it persists is what
        // `ScheduleConfig` parsed, i.e. the declared keys it knows about and
        // nothing else. `script.stripConfigKeys` lets a test model a product
        // build that has additionally lost a key it used to have.
        const body = isPlainObject(opts?.body) ? opts.body : {};
        const sentConfig = isPlainObject(body.config) ? body.config : {};
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(sentConfig)) {
          if (!SCHEDULE_CONFIG_KEYS.has(k)) continue;
          if (script.stripConfigKeys?.includes(k)) continue;
          kept[k] = v;
        }
        // `ScheduleSettings.tz` is the RESOLVED zone, not an echo: the usecase
        // stores `input.tz` and answers with
        // `resolveVenueTz(stored, orgTz)` (`lib/tz.ts:44`), which silently
        // falls back to the org zone and then to UTC when the sent string is
        // not a valid IANA name. So a 200 here does NOT mean the pin took.
        const echoedTz = typeof body.tz === "string" ? body.tz : "UTC";
        const resolvedTz = script.settingsTz === undefined ? echoedTz : script.settingsTz;
        return {
          division_id: settings[1],
          config: { ...kept, ...(script.configOverrides ?? {}) },
          ...(resolvedTz === null ? {} : { tz: resolvedTz }),
          updated_at: "2099-01-01T00:00:00.000Z",
        } as unknown as T;
      }

      if (method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+$/.test(reqPath)) return {} as T;

      const fixtures = /^\/api\/v1\/divisions\/([^/]+)\/fixtures$/.exec(reqPath);
      if (method === "GET" && fixtures) {
        const id = fixtures[1]!;
        const n = (fixtureGets.get(id) ?? 0) + 1;
        fixtureGets.set(id, n);
        const d = script.divisions?.[id];
        if (!d) throw new Error(`fake transport: no script for division "${id}"`);
        const before = d.fixturesBefore ?? [];
        return (n === 1 ? before : (d.fixturesAfter ?? before)) as unknown as T;
      }

      const auto = /^\/api\/v1\/stages\/([^/]+)\/schedule\/auto$/.exec(reqPath);
      if (method === "POST" && auto) {
        const d = divisionForStage(script, auto[1]!);
        const scripted = d?.auto ?? {};
        const solver = isPlainObject(scripted.solver)
          ? scripted.solver
          : "solver" in scripted
            ? scripted.solver
            : OK_SOLVER;
        return {
          assignments: autoAssignmentsFor(d),
          conflicts: [],
          metrics: OK_METRICS,
          ...scripted,
          // `mode` is ECHOED from the request's own derivation
          // (ScheduleSolverInfo.mode: "which solver the request asked for,
          // echoed back"), so it is stamped AFTER the scripted spread and a
          // test cannot fake a mode the request could not have produced.
          solver: isPlainObject(solver) ? { ...solver, mode: derivedMode(opts?.body) } : solver,
        } as unknown as T;
      }

      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/schedule\/apply$/.test(reqPath)) {
        // `ApplyScheduleRequest.assignments` is `.min(1).max(500)`
        // (`schemas.ts:2146-2147`). A fake that accepted `[]` is not a test
        // double, it is a second implementation with kinder rules — the exact
        // class that has now shipped four times in this repo, and the reason
        // 41 green tests never saw the driver post a body the server refuses.
        const body = isPlainObject(opts?.body) ? opts.body : {};
        const assignments = Array.isArray(body.assignments) ? body.assignments : undefined;
        if (assignments === undefined || assignments.length === 0) {
          throw new Error(
            `${reqPath}: unexpected HTTP 400 — {"ok":false,"error":"VALIDATION","issues":` +
              `[{"path":["assignments"],"code":"too_small","minimum":1}]}`,
          );
        }
        if (assignments.length > 500) {
          throw new Error(`${reqPath}: unexpected HTTP 400 — assignments exceeds .max(500)`);
        }
        return { applied: assignments.length, conflicts: [] } as unknown as T;
      }

      const validate = /^\/api\/v1\/divisions\/([^/]+)\/schedule\/validate$/.exec(reqPath);
      if (method === "POST" && validate) {
        const d = script.divisions?.[validate[1]!];
        return (d?.validate ?? { conflicts: [] }) as unknown as T;
      }

      if (method === "GET" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(reqPath)) {
        return (script.venues ?? [venue()]) as unknown as T;
      }

      throw new Error(`fake transport: unhandled ${method} ${reqPath}`);
    },
  };
  return { transport, calls };
}

/** Stage -> division script. The fixture data is keyed by division id; `auto`
 *  and `apply` are addressed by STAGE id, so the two have to be joined. */
/** What `auto` proposes by default: one assignment per fixture the script will
 *  later report as PLACED.
 *
 *  A fake whose default proposal is `[]` cannot exercise `/apply` at all — and
 *  since `ApplyScheduleRequest.assignments` is `.min(1)`, an empty default is
 *  also the one shape the real endpoint refuses. `ends_at` is always present
 *  because `ScheduleAssignment.ends_at` is a REQUIRED `z.string()` on the wire
 *  (`schemas.ts:1624`), and it is set to exactly `CONFIG.matchMinutes` so the
 *  §4.2 cross-check stays silent unless a test deliberately disagrees. */
function autoAssignmentsFor(d: DivisionScript | undefined): Record<string, unknown>[] {
  const rows = d?.fixturesAfter ?? d?.fixturesBefore ?? [];
  const out: Record<string, unknown>[] = [];
  for (const f of rows) {
    const at = f.scheduled_at;
    const court = f.court_id;
    if (typeof at !== "string" || typeof court !== "string") continue;
    out.push({
      fixture_id: f.id,
      scheduled_at: at,
      ends_at: new Date(Date.parse(at) + 45 * MIN).toISOString(),
      court_id: court,
      court_name: typeof f.court_name === "string" ? f.court_name : null,
    });
  }
  return out;
}

function divisionForStage(script: Script, stageId: string): DivisionScript | undefined {
  for (const [divisionId, d] of Object.entries(script.divisions ?? {})) {
    if (stageId === `stage-${divisionId.replace(/^div-/, "")}`) return d;
  }
  return undefined;
}

/** A deterministic monotonic clock: every reading is 5ms after the last, so
 *  each division's `wallMs` is exactly 5 and no test depends on a wall clock. */
function clock(): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += 5;
    return now;
  };
}

function layer(over: Partial<ScheduleLayerInput> & { transport: SeedTransport }): ScheduleLayerInput {
  return {
    base: BASE,
    session: SESSION,
    orgId: ORG,
    divisions: [divA()],
    courtIdByRef: COURTS,
    engine: "optimized",
    now: clock(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The engine assertion — design §2.1, the whole point of `--engine`
// ---------------------------------------------------------------------------

describe("runScheduleLayer — the engine assertion", () => {
  it("asserts the engine that actually ran and reds on a silent greedy fallback", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: { solver: { ...OK_SOLVER, engine: "greedy", status: "solver_unavailable" } },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, engine: "optimized" }));

    expect(r.outcomes[0].errors.join(" ")).toMatch(/expected optimized.*got greedy.*solver_unavailable/i);
    // The fallback is DISTINGUISHABLE from an environment fault only if the
    // status travels with the error — `_RULES.md` §2's false green is exactly
    // "every board quietly comes back greedy while your suite reports on it".
    expect(r.outcomes[0].actualEngine).toBe("greedy");
    expect(r.outcomes[0].solverStatus).toBe("solver_unavailable");
    expect(r.outcomes[0].requestedEngine).toBe("optimized");
  });

  it("names not_searched_reason so a capacity fallback is not read as an environment fault", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: {
            solver: {
              ...OK_SOLVER,
              engine: "greedy",
              status: "not_searched",
              not_searched_reason: "too_big",
            },
          },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, engine: "optimized" }));

    expect(r.outcomes[0].errors.join(" ")).toContain("too_big");
    expect(r.outcomes[0].notSearchedReason).toBe("too_big");
  });

  it("passes when the engine matches, and records it either way", async () => {
    const optimized = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });
    const rOpt = await runScheduleLayer(layer({ transport: optimized.transport, engine: "optimized" }));
    expect(rOpt.outcomes[0].errors).toEqual([]);
    expect(rOpt.outcomes[0].actualEngine).toBe("optimized");

    // The other direction, so the assertion cannot be a one-sided
    // "always expect optimized" that happens to be right today.
    const greedy = fakeTransport({
      divisions: {
        "div-a": { fixturesAfter: PLACED(), auto: { solver: { ...OK_SOLVER, engine: "greedy" } } },
      },
    });
    const rGreedy = await runScheduleLayer(layer({ transport: greedy.transport, engine: "greedy" }));
    expect(rGreedy.outcomes[0].errors).toEqual([]);
    expect(rGreedy.outcomes[0].actualEngine).toBe("greedy");

    // ...and asking for greedy while optimized ran reds too.
    const crossed = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });
    const rCrossed = await runScheduleLayer(layer({ transport: crossed.transport, engine: "greedy" }));
    expect(rCrossed.outcomes[0].errors.join(" ")).toMatch(/expected greedy.*got optimized/i);
  });

  it("--engine both asserts nothing about the engine", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: PLACED(),
          auto: { solver: { ...OK_SOLVER, engine: "greedy", status: "solver_busy" } },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, engine: "both" }));

    expect(r.outcomes[0].errors).toEqual([]);
    expect(r.outcomes[0].actualEngine).toBe("greedy");
    expect(r.outcomes[0].requestedEngine).toBe("both");
  });

  it("--engine both still reds on a blocking conflict — it relaxes ONLY the engine assertion", async () => {
    // Design §2.1: "a run is never made greener by asking for the comparison."
    // `blockingCount` is judgeDivision's first trigger and must survive `both`.
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: PLACED(),
          auto: { solver: { ...OK_SOLVER, engine: "greedy" } },
          validate: {
            conflicts: [
              { fixture_id: "f1", code: "conflict.court", blocking: true, details: { kind: "court_double_booking" } },
            ],
          },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, engine: "both" }));

    expect(r.outcomes[0].errors).toEqual([]);
    expect(r.outcomes[0].blockingCount).toBe(1);
  });

  it("reds when auto returns no solver telemetry at all", async () => {
    // `AutoScheduleResult.solver` is NON-optional on the wire (schemas.ts:2101).
    // A response without it cannot be asserted against, and silently recording
    // `actualEngine: undefined` would put `engine-undefined.json` on disk.
    const { transport } = fakeTransport({
      // A PLACED board, so the only thing wrong here is the missing telemetry.
      // Without it this test passed against the empty-proposal refusal instead,
      // whose message also contains the word "solver" — a mutation sweep caught
      // it surviving the deletion of the very error it is named for.
      divisions: { "div-a": { fixturesAfter: PLACED(), auto: { solver: undefined } } },
    });

    const r = await runScheduleLayer(layer({ transport, engine: "optimized" }));

    // Anchored on the phrase only THIS error uses, not a bare /solver/i that
    // three other messages also satisfy.
    expect(r.outcomes[0].errors.join(" ")).toMatch(/no solver\.engine/);
    expect(r.outcomes[0].actualEngine).toBeUndefined();
  });

  it("carries the solver telemetry the report needs, not just the engine", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: PLACED(),
          auto: {
            solver: { ...OK_SOLVER, tiers_completed: 2, tiers_total: 6, budget_expired: true },
            metrics: { ...OK_METRICS, makespan_minutes: 135, placed: 3, total: 4 },
          },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));
    const o = r.outcomes[0];

    // "build", and the fake could not have said otherwise: it DERIVES the mode
    // from the request body the way the product's preprocess does.
    expect(o.mode).toBe("build");
    expect(o.tiersCompleted).toBe(2);
    expect(o.tiersTotal).toBe(6);
    expect(o.budgetExpired).toBe(true);
    expect(o.metrics).toEqual({
      makespanMinutes: 135,
      worstIdleGapMinutes: 0,
      courtImbalanceMinutes: 0,
      placed: 3,
      total: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// The board is FETCHED — design §4.1
// ---------------------------------------------------------------------------

describe("runScheduleLayer — the board", () => {
  it("builds the Board from GET /fixtures, not from the assignments it posted", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: {
            assignments: [
              {
                fixture_id: "f1",
                scheduled_at: "2099-01-01T09:00:00.000Z",
                ends_at: "2099-01-01T09:45:00.000Z",
                court_id: "court-POSTED",
                court_name: "Posted",
              },
            ],
          },
          fixturesAfter: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T11:00:00.000Z",
              court_id: "court-FETCHED",
              court_name: "Fetched",
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // An echoing driver answers "court-POSTED" and 09:00 here.
    expect(r.boards[0].fixtures[0].courtId).toBe("court-FETCHED");
    expect(r.boards[0].fixtures[0].start).toBe(Date.parse("2099-01-01T11:00:00.000Z"));
    expect(r.boards[0].fixtures[0].courtName).toBe("Fetched");
  });

  it("derives end as start + matchMinutes and never folds in gapMinutes (R12)", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: [fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));
    const f = r.boards[0].fixtures[0];

    // 45, not 60: `CONFIG.gapMinutes` is 15, so a driver that added it lands
    // on 09:60 and fails here. `Fixture` carries no `ends_at` (schemas.ts:
    // 1000-1055), so this is the only derivation available.
    expect(f.end! - f.start!).toBe(45 * MIN);
    expect(f.end).toBe(T0 + 45 * MIN);
  });

  it("leaves start and end undefined for an unplaced fixture rather than inventing an epoch", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: [fx({ id: "f1", scheduled_at: null })] } },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.boards[0].fixtures[0].start).toBeUndefined();
    expect(r.boards[0].fixtures[0].end).toBeUndefined();
  });

  it("counts unplaced from the FETCHED board, never from auto's metrics", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          // The proposal claims a full board...
          auto: { metrics: { ...OK_METRICS, placed: 2, total: 2 } },
          // ...and what was actually persisted is one short.
          fixturesAfter: [
            fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" }),
            fx({ id: "f2", scheduled_at: null }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // metrics say 0 unplaced; the board says 1. The board is what the product
    // persisted, and it is the one judgeDivision's gate must fire on.
    expect(r.outcomes[0].metrics!.placed).toBe(2);
    expect(r.outcomes[0].unplacedCount).toBe(1);
  });

  it("carries entrants, round, pool, ext_key and the lock flag off the fetched row", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: [
            fx({
              id: "f1",
              ext_key: "r1m1",
              round_no: 3,
              pool_id: "pool-9",
              home_entrant_id: "e-home",
              away_entrant_id: null,
              scheduled_at: "2099-01-01T09:00:00.000Z",
              court_id: "court-1",
              venue_id: "venue-1",
              schedule_locked: true,
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));
    const f = r.boards[0].fixtures[0];

    expect(f.fixtureId).toBe("f1");
    expect(f.extKey).toBe("r1m1");
    expect(f.roundNo).toBe(3);
    expect(f.poolId).toBe("pool-9");
    // A null side is DROPPED, not carried as a null that every rule then has
    // to guard: `entrantIds` is `readonly string[]`.
    expect(f.entrantIds).toEqual(["e-home"]);
    expect(f.venueId).toBe("venue-1");
    expect(f.locked).toBe(true);
    expect(f.divisionRef).toBe("d-a");
    expect(f.divisionId).toBe("div-a");
  });

  it("maps each court's raw hours and exceptions to the engine's camelCase rows", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": {} } });

    const r = await runScheduleLayer(layer({ transport }));
    const court = r.boards[0].courts[0];

    expect(court).toMatchObject({ courtId: "court-1", name: "Court 1", venueId: "venue-1" });
    // Wire `open_min`/`close_min` -> engine `openMin`/`closeMin`
    // (court-windows.ts:59-73). Raw rows, NOT folded through `usableWindows`
    // (design §2.3) — the checker recomputes containment from these.
    expect(court.hours).toEqual([{ weekday: 4, openMin: 480, closeMin: 1320 }]);
    // A closed exception carries no range: null on the wire becomes ABSENT,
    // never 0, which `usableWindows` would read as midnight.
    expect(court.exceptions).toEqual([{ date: "2099-01-02", closed: true }]);
  });

  // --- SEVERE 1: the RANGED exception arm ----------------------------------
  //
  // `toBeBoardCourt`'s two conditional spreads
  // (`typeof e.open_min === "number" ? { openMin } : {}`, and the same for
  // close) are the SOLE producer of `BoardCourt.exceptions[].openMin`, which
  // `courtRangesOn` (`checker.ts:326`) reads as "this ranged row REPLACES the
  // weekly rows for that date". Every exception in every fixture was
  // `closed: true` with nulls, so only the FALSY side of both spreads was ever
  // taken: delete either one and the whole ranged form degrades to the
  // "says nothing about the ranges" fall-through, a day whose hours were
  // NARROWED is silently judged against the wider weekly window, and the
  // checker calls the board clean.
  //
  // That is a false clean on court-hours containment, and containment is a rule
  // the product's own `/validate` does not gate on at all — this bench is its
  // only gate.
  //
  // The three below are deliberately a differential set, because the mapping
  // assertion alone cannot see the consequence and either containment case
  // alone is satisfied by a constant: a `courtRangesOn` that always returned
  // the exception passes the narrowing case and fails the widening one, and a
  // fall-through that ignores the exception entirely does the reverse. Only
  // both directions witness "REPLACES, never intersects".

  it("maps a RANGED exception's open/close pair, the arm no closed-day fixture reaches", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": {} },
      // 10:00-15:00 on the day every fixture here is placed — a NARROWING of
      // the weekly 08:00-22:00, which is the shape the product emits when an
      // organiser shortens one day rather than closing it.
      venues: venuesWithExceptions([
        { date: "2099-01-01", closed: false, open_min: 600, close_min: 900 },
      ]),
    });

    const r = await runScheduleLayer(layer({ transport }));

    // `toEqual`, not `toMatchObject`: an arm that stopped emitting `openMin`
    // has to red HERE, and a partial match would accept the degraded row.
    expect(r.boards[0].courts[0].exceptions).toEqual([
      { date: "2099-01-01", closed: false, openMin: 600, closeMin: 900 },
    ]);
  });

  it("drives checkBoard's outside_court_hours red from a day the exception NARROWED", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          // 09:00-09:45 — inside the weekly 480-1320, OUTSIDE the 600-900 the
          // exception declares for this one date. Which window the checker
          // used is the entire question, and this fixture answers it.
          fixturesAfter: PLACED(),
        },
      },
      venues: venuesWithExceptions([
        { date: "2099-01-01", closed: false, open_min: 600, close_min: 900 },
      ]),
    });

    const r = await runScheduleLayer(layer({ transport }));
    const report = checkBoard(r.boards[0], r.constraints[0]);

    expect(report.findings.map((f) => f.kind)).toContain("outside_court_hours");
    // The narrowed range, not the weekly one, is what the reader is shown —
    // so the message itself witnesses which window was applied.
    expect(report.findings.find((f) => f.kind === "outside_court_hours")!.detail).toContain("600-900");
    expect(report.clean).toBe(false);
  });

  it("stays quiet on a day the exception WIDENED, proving it replaces the weekly rows", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          // 23:00-23:45 — OUTSIDE the weekly 480-1320, inside the 1320-1440
          // this date's exception declares. A checker that intersected the two
          // windows, or fell through to the weekly one, reds this.
          fixturesAfter: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T23:00:00.000Z",
              court_id: "court-1",
              court_name: "Court 1",
            }),
          ],
        },
      },
      venues: venuesWithExceptions([
        { date: "2099-01-01", closed: false, open_min: 1320, close_min: 1440 },
      ]),
    });

    const r = await runScheduleLayer(layer({ transport }));
    const report = checkBoard(r.boards[0], r.constraints[0]);

    expect(report.findings.map((f) => f.kind)).not.toContain("outside_court_hours");
  });

  it("carries the division's tz onto the board so the checker reads wall clocks in it", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": {} } });
    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ tz: "Europe/London" })] }));
    expect(r.boards[0].tz).toBe("Europe/London");
  });
});

// ---------------------------------------------------------------------------
// The duration cross-check — design §4.2
// ---------------------------------------------------------------------------

describe("runScheduleLayer — duration_disagreement", () => {
  it("records a duration_disagreement when auto's ends_at contradicts matchMinutes", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: {
            assignments: [
              {
                fixture_id: "f1",
                scheduled_at: "2099-01-01T09:00:00.000Z",
                // 60 minutes — which is exactly matchMinutes + gapMinutes, so a
                // driver that (wrongly, per R12) folded the gap into the
                // derivation would call this agreement and record nothing.
                ends_at: "2099-01-01T10:00:00.000Z",
                court_id: "court-1",
                court_name: "Court 1",
              },
            ],
          },
          fixturesAfter: [fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));
    const o = r.outcomes[0];

    const finding = o.findings.find((f) => f.kind === "duration_disagreement");
    expect(finding).toBeDefined();
    expect(finding!.fixtureIds).toEqual(["f1"]);
    expect(finding!.measured).toBe(60);
    expect(finding!.required).toBe(45);
    // Design §4.2: neither side is silently preferred, and R13's routing rule
    // applies — a finding with no path to a verdict is inert, so it also lands
    // in `errors`, which judgeDivision's fifth trigger reds on.
    expect(o.errors.join(" ")).toMatch(/duration_disagreement/);
    // The DERIVATION still wins on the board: matchMinutes is what every
    // overlap rule measures against.
    expect(r.boards[0].fixtures[0].end! - r.boards[0].fixtures[0].start!).toBe(45 * MIN);
  });

  it("stays silent when auto's ends_at agrees with matchMinutes", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: {
            assignments: [
              {
                fixture_id: "f1",
                scheduled_at: "2099-01-01T09:00:00.000Z",
                ends_at: "2099-01-01T09:45:00.000Z",
                court_id: "court-1",
                court_name: "Court 1",
              },
            ],
          },
          fixturesAfter: [fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // The negative half: without it, a driver that reported the disagreement
    // on EVERY assignment would pass the test above.
    expect(r.outcomes[0].findings).toEqual([]);
    expect(r.outcomes[0].errors).toEqual([]);
  });

  it("reports an unreadable ends_at rather than treating it as agreement", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: {
            assignments: [
              {
                fixture_id: "f1",
                scheduled_at: "2099-01-01T09:00:00.000Z",
                ends_at: "not-a-time",
                court_id: "court-1",
                court_name: "Court 1",
              },
            ],
          },
          fixturesAfter: [fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes[0].errors.join(" ")).toMatch(/ends_at/);
  });
});

// ---------------------------------------------------------------------------
// Locks, pins and the ordering of the seven steps — design §3.2 / §4.4
// ---------------------------------------------------------------------------

describe("runScheduleLayer — pins", () => {
  it("snapshots locks BEFORE auto and carries them as pins", async () => {
    const { transport, calls } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesBefore: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T09:00:00.000Z",
              court_id: "court-1",
              schedule_locked: true,
            }),
            fx({ id: "f2", scheduled_at: null, schedule_locked: false }),
          ],
          // AFTER apply the pinned fixture has moved. If the driver snapshotted
          // step 7's GET instead of step 3's, the pin would silently follow the
          // board and pin integrity could never fail.
          fixturesAfter: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T14:00:00.000Z",
              court_id: "court-2",
              schedule_locked: true,
            }),
            fx({ id: "f2", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(
      layer({
        transport,
        divisions: [divA({ locks: [{ fixtureId: "f1", scheduledAt: "2099-01-01T09:00:00.000Z", courtId: "court-1" }] })],
      }),
    );

    expect(r.constraints[0].pins).toEqual([{ fixtureId: "f1", start: T0, courtId: "court-1" }]);

    const patch = calls.findIndex((c) => c.method === "PATCH" && c.path === "/api/v1/fixtures/f1");
    const snapshot = calls.findIndex((c) => c.method === "GET" && c.path === "/api/v1/divisions/div-a/fixtures");
    const auto = calls.findIndex((c) => c.path === "/api/v1/stages/stage-a/schedule/auto");
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(patch).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(auto);
    // `expected_seq` must be OMITTED — the schema is `.partial()`, and a stale
    // value 409s SEQ_CONFLICT.
    expect(calls[patch].body).toEqual({
      schedule_locked: true,
      scheduled_at: "2099-01-01T09:00:00.000Z",
      court_id: "court-1",
    });
    expect(Object.keys(calls[patch].body as object)).not.toContain("expected_seq");
  });

  it("takes pins from what the PRODUCT reports as locked, not from the locks it asked for", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          // The PATCH was issued for f1, but the product reports f2 locked and
          // f1 not. Snapshotting the request would answer f1.
          fixturesBefore: [
            fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1", schedule_locked: false }),
            fx({ id: "f2", scheduled_at: "2099-01-01T10:00:00.000Z", court_id: "court-2", schedule_locked: true }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ locks: [{ fixtureId: "f1" }] })] }));

    expect(r.constraints[0].pins).toEqual([
      { fixtureId: "f2", start: Date.parse("2099-01-01T10:00:00.000Z"), courtId: "court-2" },
    ]);
  });

  it("reports a locked fixture with no slot instead of dropping it from pins in silence", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesBefore: [fx({ id: "f1", scheduled_at: null, court_id: null, schedule_locked: true })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.constraints[0].pins).toEqual([]);
    expect(r.outcomes[0].errors.join(" ")).toMatch(/f1.*locked/i);
  });

  it("walks the seven steps in the design's order", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    await runScheduleLayer(layer({ transport }));

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/v1/divisions/div-a/schedule-settings",
      "GET /api/v1/divisions/div-a/fixtures",
      "POST /api/v1/stages/stage-a/schedule/auto",
      "POST /api/v1/stages/stage-a/schedule/apply",
      "POST /api/v1/divisions/div-a/schedule/validate",
      "GET /api/v1/divisions/div-a/fixtures",
      "GET /api/v1/orgs/org-1/venues",
    ]);
  });

  it("PUTs the schedule config with every @-sigilled court ref resolved", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": {} } });

    await runScheduleLayer(
      layer({
        transport,
        divisions: [
          divA({
            scheduleConfig: {
              ...CONFIG,
              blackouts: [{ court: "@c2", from: "2099-01-01T12:00:00.000Z", to: "2099-01-01T13:00:00.000Z" }],
            },
          }),
        ],
      }),
    );

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      tz: "UTC",
      config: {
        startAt: "2099-01-01T09:00:00.000Z",
        matchMinutes: 45,
        gapMinutes: 15,
        // A ref the PRODUCT would 400 on is never sent.
        courts: ["court-1", "court-2"],
        perEntrantMinRest: 0,
        blackouts: [{ court: "court-2", from: "2099-01-01T12:00:00.000Z", to: "2099-01-01T13:00:00.000Z" }],
        sessionWindows: [],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// N divisions, conflicts, officials, and the encode refusal (R13)
// ---------------------------------------------------------------------------

describe("runScheduleLayer — every division", () => {
  it("schedules EVERY division it is given, not just the first", async () => {
    const { transport, calls } = fakeTransport({
      divisions: {
        "div-a": { fixturesAfter: [fx({ id: "fa", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" })] },
        "div-b": {
          fixturesAfter: [
            fx({
              id: "fb",
              division_id: "div-b",
              stage_id: "stage-b",
              scheduled_at: "2099-01-01T10:00:00.000Z",
              court_id: "court-2",
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(
      layer({
        transport,
        divisions: [
          divA(),
          divA({ divisionRef: "d-b", divisionId: "div-b", stageId: "stage-b", isRoundRobin: false }),
        ],
      }),
    );

    // `_INDEX.md` recorded that `runTinySuite` schedules divisions[0]/stages[0]
    // only, and that "B04 owns closing this". This is where it closes.
    expect(r.outcomes.map((o) => o.divisionRef)).toEqual(["d-a", "d-b"]);
    expect(r.boards.map((b) => b.divisionRef)).toEqual(["d-a", "d-b"]);
    expect(r.constraints.map((c) => c.divisionRef)).toEqual(["d-a", "d-b"]);
    expect(r.constraints[1].isRoundRobin).toBe(false);
    expect(calls.filter((c) => c.path === "/api/v1/stages/stage-b/schedule/auto")).toHaveLength(1);
  });

  it("keeps scheduling after one division fails, and keys its output by divisionRef", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-b": {
          fixturesAfter: [
            fx({
              id: "fb",
              division_id: "div-b",
              stage_id: "stage-b",
              scheduled_at: "2099-01-01T10:00:00.000Z",
              court_id: "court-2",
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(
      layer({
        transport,
        divisions: [
          // An unresolvable @-ref: `encodeConstraints` throws (R13) BEFORE any
          // HTTP, so div-a never reaches the wire at all.
          divA({ scheduleConfig: { ...CONFIG, courts: ["@nope"] } }),
          divA({ divisionRef: "d-b", divisionId: "div-b", stageId: "stage-b" }),
        ],
      }),
    );

    expect(r.outcomes.map((o) => o.divisionRef)).toEqual(["d-a", "d-b"]);
    // The three arrays are NOT index-aligned — a division that never produced
    // an encoding contributes no `constraints` row, so consumers key by ref.
    expect(r.constraints.map((c) => c.divisionRef)).toEqual(["d-b"]);
    expect(r.boards.map((b) => b.divisionRef)).toEqual(["d-b"]);
    expect(r.outcomes[1].errors).toEqual([]);
  });

  it("routes a thrown encodeConstraints into errors instead of crashing the run (R13)", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": {} } });

    const r = await runScheduleLayer(
      layer({ transport, divisions: [divA({ scheduleConfig: { ...CONFIG, courts: ["@ghost"] } })] }),
    );

    expect(r.outcomes[0].errors.join(" ")).toMatch(/unknown court ref "ghost"/);
    // Loud AND cheap: nothing was PUT, nothing was scheduled.
    expect(calls).toEqual([]);
    expect(r.constraints).toEqual([]);
  });

  it("routes an HTTP failure into that division's errors rather than throwing out of the layer", async () => {
    const transport: SeedTransport = {
      async signIn() {
        throw new Error("unused");
      },
      async request<T>(_b: string, _s: Session, p: string): Promise<T> {
        throw new Error(`${p}: unexpected HTTP 422 — {"error":"SCHEDULE_OUTSIDE_COMPETITION"}`);
      },
    };

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0].errors.join(" ")).toContain("SCHEDULE_OUTSIDE_COMPETITION");
  });

  it("records wallMs per division from the injected clock", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": {} } });
    const r = await runScheduleLayer(layer({ transport }));
    expect(r.outcomes[0].wallMs).toBe(5);
  });

  it("skips the schedule-settings PUT for a division whose pack declares no config", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": {} } });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ scheduleConfig: undefined })] }));

    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    // Still encoded, so the checker gets the product's own defaults as its
    // oracle rather than nothing at all (schemas.ts:1287 — matchMinutes 30).
    expect(r.constraints[0].matchMinutes).toBe(30);
  });
});

describe("runScheduleLayer — conflicts", () => {
  it("tallies warn rows by details.kind, never by code", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          validate: {
            conflicts: [
              // `code` and `details.kind` are DIFFERENT strings on every row, so
              // a tally keyed on `code` produces entirely different keys.
              { fixture_id: "f1", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest" } },
              { fixture_id: "f2", code: "warn.rest", blocking: false, details: { kind: "person_below_rest" } },
              { fixture_id: "f3", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest" } },
              // The deprecated prose field must never be read either.
              {
                fixture_id: "f4",
                code: "warn.blackout",
                blocking: false,
                detail: "inside a blackout",
                details: { kind: "inside_blackout" },
              },
            ],
          },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes[0].warnKindTally).toEqual({
      entrant_below_rest: 2,
      person_below_rest: 1,
      inside_blackout: 1,
    });
    expect(Object.keys(r.outcomes[0].warnKindTally)).not.toContain("warn.rest");
  });

  it("counts blocking rows and keeps them OUT of the warn tally", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          validate: {
            conflicts: [
              { fixture_id: "f1", code: "conflict.court", blocking: true, details: { kind: "court_double_booking" } },
              { fixture_id: "f2", code: "conflict.court", blocking: true, details: { kind: "court_double_booking" } },
              { fixture_id: "f3", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest" } },
            ],
          },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // Design §2.2: layer 1 asserts zero BLOCKING rows, "no more, no less".
    // The tally is report-only and covers the warn-level rows it does not gate.
    expect(r.outcomes[0].blockingCount).toBe(2);
    expect(r.outcomes[0].warnKindTally).toEqual({ entrant_below_rest: 1 });
  });

  it("gives a warn row with no structured details its own key instead of dropping it", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          validate: { conflicts: [{ fixture_id: "f1", code: "warn.no_slot", blocking: false }] },
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // `details` is optional on the wire (schemas.ts:1582). A dropped row would
    // make the tally quietly under-report.
    expect(Object.values(r.outcomes[0].warnKindTally)).toEqual([1]);
    expect(Object.keys(r.outcomes[0].warnKindTally)[0]).toMatch(/details/);
  });
});

describe("runScheduleLayer — officials", () => {
  it("reads official_id off each element and shape-guards the rest", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T09:00:00.000Z",
              court_id: "court-1",
              officials: [
                { official_id: "off-1", role_key: "referee" },
                { official_id: "off-2", role_key: "umpire" },
              ],
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: true })] }));

    expect(r.boards[0].fixtures[0].officialIds).toEqual(["off-1", "off-2"]);
    expect(r.outcomes[0].errors).toEqual([]);
  });

  it("reports an unreadable officials element rather than dropping it (design §4.3)", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: [
            fx({
              id: "f1",
              scheduled_at: "2099-01-01T09:00:00.000Z",
              court_id: "court-1",
              // `Fixture.officials` is `z.array(z.unknown())` (schemas.ts:1033),
              // so nothing on the wire guarantees this shape.
              officials: [{ official_id: "off-1", role_key: "referee" }, "off-2", { role_key: "umpire" }],
            }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: true })] }));

    expect(r.boards[0].fixtures[0].officialIds).toEqual(["off-1"]);
    expect(r.outcomes[0].findings.filter((f) => f.kind === "officials_unreadable")).toHaveLength(2);
    expect(r.outcomes[0].errors.join(" ")).toMatch(/officials_unreadable/);
  });

  it("stays quiet about zero officials when the pack declared none", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          fixturesAfter: [
            fx({ id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1", officials: [] }),
          ],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: false })] }));

    expect(r.outcomes[0].errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The engine artifact — design §2.1's two-leg comparison
// ---------------------------------------------------------------------------

describe("engine artifacts", () => {
  async function scratch(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "bench-b04-t4-"));
  }

  function snapshot(engine: "optimized" | "greedy", makespan: number): EngineSnapshot {
    return {
      runId: "6eaf64058",
      requestedEngine: engine,
      engine,
      divisions: [
        {
          divisionRef: "d-a",
          metrics: {
            makespanMinutes: makespan,
            worstIdleGapMinutes: 0,
            courtImbalanceMinutes: 0,
            placed: 4,
            total: 4,
          },
          solverStatus: "ok",
          blockingCount: 0,
          unplacedCount: 0,
          wallMs: 12,
          verdict: { red: false, reasons: [] },
        },
      ],
    };
  }

  it("writes engine-<engine>.json and reads a sibling leg back", async () => {
    const dir = await scratch();

    const optimizedPath = await writeEngineArtifact(dir, "6eaf64058", "optimized", snapshot("optimized", 180));
    // The SAME runId — `resolveRunId` is the git SHA, so two legs of one commit
    // land in one directory. Putting the engine in the FILENAME is what stops
    // the second leg overwriting the first (design §2.1, kickoff trap 1).
    const greedyPath = await writeEngineArtifact(dir, "6eaf64058", "greedy", snapshot("greedy", 240));

    expect(path.basename(optimizedPath)).toBe("engine-optimized.json");
    expect(path.basename(greedyPath)).toBe("engine-greedy.json");
    expect(path.dirname(optimizedPath)).toBe(path.dirname(greedyPath));

    const read = await readEngineArtifacts(dir, "6eaf64058");
    expect(Object.keys(read).sort()).toEqual(["greedy", "optimized"]);
    expect((read.optimized as EngineSnapshot).divisions[0].metrics!.makespanMinutes).toBe(180);
    expect((read.greedy as EngineSnapshot).divisions[0].metrics!.makespanMinutes).toBe(240);
  });

  it("returns {} when the run directory holds no artifacts at all", async () => {
    const dir = await scratch();
    // The FIRST leg of a two-leg run: its sibling does not exist yet, and that
    // is a "no delta to emit", never a crash.
    expect(await readEngineArtifacts(dir, "never-ran")).toEqual({});
  });

  it("ignores the run's other report files", async () => {
    const dir = await scratch();
    await writeEngineArtifact(dir, "sha", "greedy", snapshot("greedy", 240));
    await writeFile(path.join(dir, "sha", "report.json"), "{}\n", "utf8");
    await writeFile(path.join(dir, "sha", "report.md"), "# nope\n", "utf8");

    expect(Object.keys(await readEngineArtifacts(dir, "sha"))).toEqual(["greedy"]);
  });

  it("throws on a malformed artifact instead of silently reporting no sibling leg", async () => {
    const dir = await scratch();
    await writeEngineArtifact(dir, "sha", "greedy", snapshot("greedy", 240));
    await writeFile(path.join(dir, "sha", "engine-optimized.json"), "{ truncated", "utf8");

    // Silently skipping it would render "greedy only" for a run that HAS two
    // legs — a missing delta that looks exactly like a single-leg run.
    await expect(readEngineArtifacts(dir, "sha")).rejects.toThrow(/engine-optimized\.json/);
  });

  it("refuses an engine name that is not a plain identifier", async () => {
    const dir = await scratch();
    await expect(writeEngineArtifact(dir, "sha", "../../escape", {})).rejects.toThrow(/engine/i);
  });

  it("round-trips the payload byte-for-byte through JSON", async () => {
    const dir = await scratch();
    const payload = snapshot("optimized", 180);
    const file = await writeEngineArtifact(dir, "sha", "optimized", payload);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — the four things 41 green tests could not see
// ---------------------------------------------------------------------------

describe("runScheduleLayer — an empty proposal is a refusal, not an empty apply", () => {
  it("never POSTs an empty assignments array, because /apply refuses one", async () => {
    // `ApplyScheduleRequest.assignments` is `.min(1)` (schemas.ts:2146) while
    // `AutoScheduleResult.assignments` has no minimum — so the exact response a
    // capacity refusal produces is a body /apply rejects. The fake throws a 400
    // on `[]` the way the server does, so a driver that posts it fails here.
    const { transport, calls } = fakeTransport({
      divisions: {
        "div-a": {
          auto: { assignments: [], metrics: { ...OK_METRICS, placed: 0, total: 4 } },
          fixturesAfter: [fx({ id: "f1", scheduled_at: null }), fx({ id: "f2", scheduled_at: null })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(calls.map((c) => c.path)).not.toContain("/api/v1/stages/stage-a/schedule/apply");
    expect(r.outcomes[0].errors.join(" ")).toMatch(/auto proposed 0 assignments/);
  });

  it("still reaches validate AND the board fetch after a refusal, so UNPLACED keeps its evidence", async () => {
    // This is the whole point: a 400 out of /apply would abort the division
    // before either, and design §3.4's UNPLACED branch would have nothing to
    // report about the board the solver could not place.
    const { transport, calls } = fakeTransport({
      divisions: {
        "div-a": {
          auto: { assignments: [], metrics: { ...OK_METRICS, placed: 0, total: 2 } },
          validate: {
            conflicts: [{ fixture_id: "f1", code: "warn.no_slot", blocking: false, details: { kind: "no_slot_lattice" } }],
          },
          fixturesAfter: [fx({ id: "f1", scheduled_at: null }), fx({ id: "f2", scheduled_at: null })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/v1/divisions/div-a/schedule-settings",
      "GET /api/v1/divisions/div-a/fixtures",
      "POST /api/v1/stages/stage-a/schedule/auto",
      // no apply
      "POST /api/v1/divisions/div-a/schedule/validate",
      "GET /api/v1/divisions/div-a/fixtures",
      "GET /api/v1/orgs/org-1/venues",
    ]);
    expect(r.outcomes[0].unplacedCount).toBe(2);
    expect(r.outcomes[0].metrics).toMatchObject({ placed: 0, total: 2 });
    expect(r.outcomes[0].warnKindTally).toEqual({ no_slot_lattice: 1 });
    expect(r.boards[0].fixtures).toHaveLength(2);
  });

  it("applies exactly the assignments auto proposed when there ARE some", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    await runScheduleLayer(layer({ transport }));

    const apply = calls.find((c) => c.path === "/api/v1/stages/stage-a/schedule/apply");
    expect(apply).toBeDefined();
    expect(apply!.body).toEqual({
      assignments: [
        { fixture_id: "f1", scheduled_at: "2099-01-01T09:00:00.000Z", court_id: "court-1" },
      ],
    });
    // `ends_at` and `court_name` are echoed-and-ignored by the endpoint; not
    // sending them keeps the body to what `.strict()` actually wants.
    expect(Object.keys(apply!.body as { assignments: object[] }).sort()).toEqual(["assignments"]);
  });
});

describe("runScheduleLayer — the auto request body", () => {
  it("asks for a BUILD explicitly, because an empty body can only derive a reflow", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    const r = await runScheduleLayer(layer({ transport }));

    const auto = calls.find((c) => c.path === "/api/v1/stages/stage-a/schedule/auto");
    // `only_unlocked: false` is the ONLY thing that derives `mode: "build"`
    // (schemas.ts:1645-1651). `{}` derives "reflow" — a re-flow of a stage that
    // has never been scheduled.
    expect(auto!.body).toEqual({ only_unlocked: false });
    // And the fake DERIVES the echoed mode from that body, so this assertion
    // cannot be satisfied by a hard-coded constant.
    expect(r.outcomes[0].mode).toBe("build");
  });

  it("never sends ignore_locks — a pin must survive the build it was snapshotted for", async () => {
    const { transport, calls } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    await runScheduleLayer(layer({ transport }));

    // Since #pins-in-build every mode honours a lock unconditionally, and
    // `ignore_locks` is the only way off that. Sending it would silently void
    // every pin the checker is about to judge.
    const auto = calls.find((c) => c.path === "/api/v1/stages/stage-a/schedule/auto");
    expect(Object.keys(auto!.body as object)).not.toContain("ignore_locks");
  });
});

describe("runScheduleLayer — the schedule-settings round trip", () => {
  it("reports a config key the product silently dropped", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      // `ScheduleConfig` is a plain z.object, so an unknown key is STRIPPED and
      // the PUT still 200s. The pack declared it; the scheduler never got it.
      stripConfigKeys: ["perEntrantMinRest"],
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes[0].errors.join(" ")).toMatch(/DROPPED "perEntrantMinRest"/);
  });

  it("reports a config value the product persisted differently", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      configOverrides: { matchMinutes: 30 },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // The pack declared 45 and the product kept 30 — every overlap rule below
    // would be measured against a duration the scheduler never used.
    expect(r.outcomes[0].errors.join(" ")).toMatch(/CHANGED "matchMinutes".*45.*30/);
  });

  it("does NOT report a re-serialised instant as a divergence", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      // Same moment, different spelling — the product re-serialises IsoDateTime.
      configOverrides: { startAt: "2099-01-01T09:00:00+00:00" },
    });

    const r = await runScheduleLayer(layer({ transport }));

    // Without this, the check reds on every live run and gets deleted.
    expect(r.outcomes[0].errors).toEqual([]);
  });

  it("does NOT report a default the product added that the pack never declared", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      configOverrides: { roundMinutes: 90 },
    });

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes[0].errors).toEqual([]);
  });

  it("reports a PUT that answered with no readable config at all", async () => {
    const transport: SeedTransport = {
      async signIn() {
        throw new Error("unused");
      },
      async request<T>(_b: string, _s: Session, reqPath: string): Promise<T> {
        if (/schedule-settings$/.test(reqPath)) return {} as T;
        throw new Error("fake: only the PUT is scripted here");
      },
    };

    const r = await runScheduleLayer(layer({ transport }));

    expect(r.outcomes[0].errors.join(" ")).toMatch(/no readable config/);
  });

  // --- R04: the resolved tz is EVIDENCE too --------------------------------
  //
  // The PUT body carries `tz` alongside `config`, and until this round nothing
  // read the answer back. `ScheduleSettings.tz` is the RESOLVED zone
  // (`schemas.ts:1450`), produced by `resolveVenueTz(stored, orgTz)` — which
  // returns the sent string only if it is a valid IANA name and otherwise falls
  // through to the org zone and then to UTC, all behind a 200.
  //
  // The cost of not reading it is asymmetric, which is why this is not a minor
  // gap. The board this driver builds carries `division.tz` (the PACK's zone)
  // and every wall-clock rule downstream — the checker's court-hours
  // containment, `not_before`/`not_after`, believability's day bucketing — is
  // judged in it. If the product scheduled in a different zone, those rules do
  // not MISS a defect, they INVENT one: the bench files false product defects.
  // An instrument that cries wolf gets switched off, and the real findings go
  // with it.

  it("reports a tz the product resolved differently from the one the pack pinned", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      // The pin did not take: stored value invalid/absent, so `resolveVenueTz`
      // fell through to the org zone. A 200, and the wrong clock.
      settingsTz: "UTC",
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ tz: "Europe/London" })] }));

    // Both zones named, order-independently: the report has to say which one
    // the scheduler used AND which one the board is being judged in, or the
    // reader cannot tell which half to go and fix.
    const said = r.outcomes[0].errors.join(" ");
    expect(said).toMatch(/RESOLVED the timezone/);
    expect(said).toContain("Europe/London");
    expect(said).toContain("UTC");
  });

  it("compares against the tz that was SENT, not a constant — a zone the product honours is quiet", async () => {
    // The pair for the test above, and it is what makes that one falsifiable:
    // an implementation that reds whenever the resolved zone is not "UTC", or
    // whenever it is not the string "Europe/London", passes one of these two
    // and fails the other. Only comparing the response against the value this
    // division actually sent passes both.
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ tz: "Europe/London" })] }));

    expect(r.outcomes[0].errors).toEqual([]);
  });

  it("reports a PUT that answered with no tz at all rather than assuming the sent one took", async () => {
    const { transport } = fakeTransport({
      divisions: { "div-a": { fixturesAfter: PLACED() } },
      settingsTz: null,
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ tz: "Europe/London" })] }));

    // `ScheduleSettings.tz` is a REQUIRED `z.string()`, so an absent one is a
    // product build this driver does not understand. Silence here would mean
    // assuming the pin took, which is the one inference this check exists to
    // refuse.
    expect(r.outcomes[0].errors.join(" ")).toMatch(/no readable tz/);
  });
});

// ---------------------------------------------------------------------------
// The pack fact reaches the checker's oracle — B04 T2/T4 merge reconciliation
// ---------------------------------------------------------------------------

describe("declaresOfficials is carried from the PACK onto EncodedConstraints", () => {
  // `EncodedConstraints.declaresOfficials` is the checker's ONLY officials
  // signal (board.ts's note on the field): `checkBoard` cannot tell "this
  // division has no officials" from "this division's officials did not come
  // back", and an empty `officialIds` array reads identically in both. So the
  // value has to come from `ScheduleDivision`, which the caller resolves from
  // the PACK — never from the board this driver just fetched, which would
  // compare the fetch against itself and make design §4.3's rule vacuous
  // again, which is the defect the field was added to close.
  //
  // BOTH DIRECTIONS, deliberately. Either alone is satisfied by a constant: a
  // hard-coded `true` passes the first, and the encoder's
  // `input.declaresOfficials === true` turns an UNPASSED field into `false`,
  // which passes the second. Only the pair witnesses the derivation.
  it("encodes true for a division whose pack declared officials", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: true })] }));

    expect(r.constraints[0].declaresOfficials).toBe(true);
  });

  it("encodes false for a division whose pack declared none", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: false })] }));

    expect(r.constraints[0].declaresOfficials).toBe(false);
  });

  // The seam, driven through its REAL consumer rather than a fixture on both
  // ends (failure class 1). `runScheduleLayer` returns the board it FETCHED
  // and the constraints it ENCODED; folding that exact pair through the real
  // `checkBoard` is what proves the pack fact survives the trip. Ruling R21
  // put this red in `checker.ts` and removed the driver's duplicate, so this
  // is now the only test that can witness the driver feeding it.
  it("drives checkBoard's declared-but-none red from the driver's own output", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: true })] }));
    const report = checkBoard(r.boards[0], r.constraints[0]);

    expect(report.findings.map((f) => f.kind)).toContain("officials_unreadable");
    expect(report.clean).toBe(false);
  });

  it("leaves checkBoard quiet on the same board when the pack declared none", async () => {
    const { transport } = fakeTransport({ divisions: { "div-a": { fixturesAfter: PLACED() } } });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: false })] }));
    const report = checkBoard(r.boards[0], r.constraints[0]);

    // Same board, same empty officials — only the PACK fact differs, so this
    // pair fails if the driver ever derives the flag from the fetch.
    expect(report.findings.map((f) => f.kind)).not.toContain("officials_unreadable");
  });

  // The gate's other half, kept here because it lives nowhere else: the driver
  // used to own this case, R21 moved the red to `checker.ts`, and
  // checker.test.ts covers the red and its negative but NOT the
  // `placed.length > 0` gate. A board with nothing placed is the unplaced
  // gate's business, and reding it here as well says "no officials came back"
  // about a board that came back empty for an entirely different reason.
  it("leaves checkBoard quiet when the pack declared officials but nothing was placed", async () => {
    const { transport } = fakeTransport({
      divisions: {
        "div-a": {
          auto: { assignments: [], metrics: { ...OK_METRICS, placed: 0, total: 1 } },
          fixturesAfter: [fx({ id: "f1", scheduled_at: null, officials: [] })],
        },
      },
    });

    const r = await runScheduleLayer(layer({ transport, divisions: [divA({ declaresOfficials: true })] }));
    const report = checkBoard(r.boards[0], r.constraints[0]);

    expect(r.constraints[0].declaresOfficials).toBe(true);
    expect(report.findings.map((f) => f.kind)).not.toContain("officials_unreadable");
  });
});
