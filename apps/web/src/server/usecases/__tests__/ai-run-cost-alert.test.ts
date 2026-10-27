// v17 gap #295 — the alert SPEC-2 §5.1 named as the trigger for revisiting
// flat 1-credit-per-run pricing: a single run's cost_usd >= 2x the trailing
// median for its phase. `shouldAlertOnRunCost` carries every decision branch
// (null cost, no baseline, below/at/above the multiple) as a pure function so
// it is exhaustively testable with no DB and no flake risk from other suites
// concurrently writing competition_events. `medianRunCostUsd` and
// `maybeAlertExpensiveRun` are thin DB/email wiring on top of it; both are
// exercised against a REAL cost value ($50) that is orders above anything a
// mocked-LLM test pack can produce (SPEC-2 §6: worst observed real cost is
// ~$0.47), so the "fires" assertions stay robust even if other test files
// insert their own (tiny) competition_events rows into the same schema
// concurrently.
//
// Noise discipline for the DB blocks: other suites (schedule-ai-route,
// schedule-ai-ledger, officials-ai-route) DO write these same event types into
// the shared schema, but they can only ADD rows, never remove them. So every
// assertion here is written to survive extra rows: the min-sample test asserts
// its own precondition, the seeded medians sit orders of magnitude apart from
// anything a mocked run produces, and the phase -> event-type map is pinned by
// comparing the emailed median against a freshly-read median for BOTH types
// rather than against a hardcoded number.
//
// The alert is queued on the email outbox (phase 3 wave 5, kind
// `staff_ai_run_cost`) to this suite's own STAFF_ALERT_EMAIL, under a ref
// minted for the run (P-W5-6: a run has no id of its own, its cost is final,
// and a double press is two runs and two costs), so the tests read the rows
// queued to that address. The builder is a spy that calls through, so what the
// alert SAYS is read where it enters the mail; Sentry's issue capture is
// observed (call-through) so a test can assert the writer dropped nothing. The
// worker never runs here: the transport is stubbed.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, aiRunCostAlertEmail: vi.fn(actual.aiRunCostAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { sql, statementCount } from "@/lib/db";
import { aiRunCostAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { staffAlertDrops, type StaffRow } from "./_money-fixtures";
import {
  AI_RUN_COST_ALERT_MULTIPLE,
  AI_RUN_MEDIAN_MIN_SAMPLE,
  MEDIAN_WINDOW_DAYS,
  aiRunTotals,
  listAiRuns,
  maybeAlertExpensiveRun,
  medianRunCostUsd,
  shouldAlertOnRunCost,
} from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "staff_ai_run_cost";
const RUN = `arc-${randomUUID().slice(0, 8)}`;
const costAlert = vi.mocked(aiRunCostAlertEmail);
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
/** The AI-run alerts queued to THIS test's staff address, oldest first. Found by address, not by ref: each run's ref is a UUID
 *  minted inside the alert (P-W5-6), which the test cannot know in advance. */
const myRows = () =>
  sql<StaffRow[]>`
    select ref_id, dedupe_key, status, recipient, subject from email_outbox
     where kind = ${KIND} and recipient = ${staff}
     order by created_at, id`;
/** A v4 UUID: the fresh ref `randomUUID()` mints. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The subject, the builder's inline English typed from its source. */
const costSubject = (costUsd: number, orgId: string) => `Expensive AI run: $${costUsd.toFixed(4)} (org ${orgId})`;

/** Comfortably over the min-sample floor so a stray concurrent row can never
 *  drag a seeded window back under it. */
const SEED_N = 25;
/** Officials baseline cost — orders of magnitude below anything a real or
 *  mocked schedule run records, so "the emailed median is the OFFICIALS one"
 *  is detectable by range alone. */
const OFFICIALS_COST = 0.000001;
/** Schedule baseline cost: far above the officials seed and far below the $50
 *  run every test pages, so the alert trips on any realistic shared median. A
 *  whole baseline (SEED_N of these) stays under a dollar because
 *  ai-margin-report.test.ts runs beside this file and asserts its per-phase
 *  COGS deltas stay under $1; a 25 x $0.50 baseline landed inside its window. */
const SCHEDULE_COST = 0.01;

type RunEventType = "schedule.ai_generated" | "schedule.ai_officials_generated";

/** A one-off event type nothing else in the schema can ever write, so a window
 *  filtered on it contains exactly the rows the calling test seeded. Used only
 *  where the assertion is about ROW COUNTS (the min-sample floor), which the
 *  real, shared event types cannot support deterministically. */
const probeType = (): RunEventType =>
  `schedule.ai_generated#probe-${randomUUID().slice(0, 8)}` as RunEventType;

/** Seed `n` qualifying run events of `type`, each with the same `cost_usd`,
 *  under a throwaway org/competition. One INSERT … SELECT over
 *  generate_series, so a 25-row baseline costs one round trip. */
async function seedRuns(type: RunEventType, costUsd: number, n: number): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Median " + suffix}, ${"median-" + suffix})
    returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${org!.id}, 'Median Comp', ${"median-comp-" + suffix}, 'private', '{}')
    returning id`;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload)
    select ${comp!.id}::uuid, ${org!.id}::uuid, ${type}::text, ${sql.json({ cost_usd: costUsd })}::jsonb
      from generate_series(1, ${n})`;
}

/** Seed ONE run event with an arbitrary (possibly malformed) payload, and hand
 *  back the competition id so the caller can delete it again. Malformed rows
 *  MUST be cleaned up: unlike `pack_units`, a bad `cost_usd` is read by
 *  medianRunCostUsd / aiRunTotals / listAiRuns, so leaving one behind poisons
 *  every later suite in the shared schema. */
async function seedRawRun(
  type: string,
  payload: Record<string, unknown>,
): Promise<{ compId: string; orgName: string }> {
  const suffix = randomUUID().slice(0, 8);
  const orgName = `Malformed ${suffix}`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${orgName}, ${"malformed-" + suffix})
    returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${org!.id}, 'Malformed Comp', ${"malformed-comp-" + suffix}, 'private', '{}')
    returning id`;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload)
    values (${comp!.id}, ${org!.id}, ${type}, ${sql.json(payload as never)})`;
  return { compId: comp!.id, orgName };
}

/** How many rows the median query would actually see — used to assert the
 *  min-sample test's own precondition instead of assuming it. */
async function qualifyingRows(type: RunEventType, days: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from competition_events
     where type = ${type}
       and payload->>'cost_usd' is not null
       and created_at >= now() - make_interval(days => ${days})`;
  return row?.n ?? 0;
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  // Reset, not clear: back to the real builder, so a once-only throw a red test left unconsumed cannot leak into the next.
  costAlert.mockReset();
  vi.mocked(captureError).mockClear();
  errors = vi.spyOn(log, "error");
  // This test's own staff address: CI sets none, and the database is shared.
  staff = `staff-${RUN}-${randomUUID().slice(0, 8)}@x.test`;
  vi.stubEnv("STAFF_ALERT_EMAIL", staff);
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllEnvs();
});

describe("shouldAlertOnRunCost (pure, v17 gap #295)", () => {
  it("false when cost is null (nothing to compare)", () => {
    expect(shouldAlertOnRunCost(null, 0.1)).toBe(false);
  });
  it("false when there is no median yet (null or non-positive baseline)", () => {
    expect(shouldAlertOnRunCost(5, null)).toBe(false);
    expect(shouldAlertOnRunCost(5, 0)).toBe(false);
    expect(shouldAlertOnRunCost(5, -1)).toBe(false);
  });
  it("false strictly below the multiple", () => {
    expect(shouldAlertOnRunCost(0.19, 0.1, 2)).toBe(false);
  });
  it("true at or above the multiple", () => {
    expect(shouldAlertOnRunCost(0.2, 0.1, 2)).toBe(true);
    expect(shouldAlertOnRunCost(0.25, 0.1, 2)).toBe(true);
  });
  it("defaults the multiple to AI_RUN_COST_ALERT_MULTIPLE (SPEC-2 §5.1's own named trigger)", () => {
    expect(AI_RUN_COST_ALERT_MULTIPLE).toBe(2);
    expect(shouldAlertOnRunCost(0.2, 0.1)).toBe(true);
    expect(shouldAlertOnRunCost(0.19999, 0.1)).toBe(false);
  });
  it("pins the baseline window and the min-sample floor (controller ruling)", () => {
    // Both are load-bearing policy, not implementation detail: the window is
    // interpolated into the staff email, and the floor is what stops a
    // thin-data deployment emailing on every slightly-above-average run.
    expect(MEDIAN_WINDOW_DAYS).toBe(30);
    expect(AI_RUN_MEDIAN_MIN_SAMPLE).toBe(20);
  });
});

describe.skipIf(!HAS_DB)("medianRunCostUsd (v17 gap #295)", () => {
  it("returns null for a window with provably zero rows (future bound)", async () => {
    // days:-1 -> now() - make_interval(days => -1) = now() + 1 day, a bound
    // no row's created_at can ever satisfy — deterministic null regardless of
    // what other suites have written into competition_events.
    expect(await medianRunCostUsd("schedule.ai_generated", -1)).toBeNull();
  });

  it("returns null below the min-sample floor — one run is not a baseline", async () => {
    // Per-test synthetic event type: the window then provably contains ONLY
    // the rows this test seeds. Against the real types a "1 row -> null"
    // assertion is NOT deterministic — they accumulate rows from earlier runs
    // of this same file (the schema outlives the run), from concurrent suites,
    // and from production-shaped code paths. `type` is unconstrained text and
    // the SQL path exercised is identical; only the `type =` filter differs.
    const probe = probeType();
    await seedRuns(probe, 0.01, 1);
    expect(await qualifyingRows(probe, 1)).toBe(1);
    expect(await medianRunCostUsd(probe, 1)).toBeNull();
    // …and still null one row short of the floor.
    await seedRuns(probe, 0.01, AI_RUN_MEDIAN_MIN_SAMPLE - 2);
    expect(await qualifyingRows(probe, 1)).toBe(AI_RUN_MEDIAN_MIN_SAMPLE - 1);
    expect(await medianRunCostUsd(probe, 1)).toBeNull();
  });

  it("returns the median at exactly the min-sample floor (boundary)", async () => {
    const probe = probeType();
    await seedRuns(probe, 0.02, AI_RUN_MEDIAN_MIN_SAMPLE);
    expect(await qualifyingRows(probe, 1)).toBe(AI_RUN_MEDIAN_MIN_SAMPLE);
    expect(await medianRunCostUsd(probe, 1)).toBeCloseTo(0.02, 10);
  });

  it("returns a positive number once a REAL run type holds at least the min sample", async () => {
    await seedRuns("schedule.ai_generated", 0.01, SEED_N);
    expect(await qualifyingRows("schedule.ai_generated", 1)).toBeGreaterThanOrEqual(
      AI_RUN_MEDIAN_MIN_SAMPLE,
    );
    const median = await medianRunCostUsd("schedule.ai_generated", 1);
    expect(typeof median).toBe("number");
    expect(median).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("maybeAlertExpensiveRun (v17 gap #295)", () => {
  it("unset: the median is never read", async () => {
    // Cheap guards FIRST: the median is a scan of the audit ledger, and with no
    // address set (the normal case) no alert can go anywhere, so the run must
    // not pay for it. The positive pair is the same call with the address set:
    // it reads the median and queues the alert.
    await seedRuns("schedule.ai_generated", SCHEDULE_COST, SEED_N);
    const orgId = randomUUID();
    const run = { orgId, phase: "schedule" as const, model: "claude-sonnet-5", costUsd: 50 };

    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const before = statementCount();
    expect(await maybeAlertExpensiveRun(run)).toBeNull();
    expect(statementCount() - before, "no statement at all: neither the median nor an insert").toBe(0);
    expect(costAlert).not.toHaveBeenCalled();

    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    const set = statementCount();
    expect(await maybeAlertExpensiveRun(run), "premise: with the address set the same run is paged").toEqual(expect.any(String));
    expect(statementCount() - set, "the median read and the insert").toBeGreaterThanOrEqual(2);
    expect(await myRows()).toHaveLength(1);
  });

  it("an expensive run pages once, with a fresh ref", async () => {
    await seedRuns("schedule.ai_generated", SCHEDULE_COST, SEED_N);
    const orgId = randomUUID();

    const id = await maybeAlertExpensiveRun({
      orgId,
      competitionId: "comp-1",
      phase: "schedule",
      model: "claude-sonnet-5",
      costUsd: 50, // no realistic AI run (SPEC-2 §6: worst ~$0.47) gets near this
    });

    const rows = await myRows();
    expect(rows).toEqual([
      { ref_id: expect.stringMatching(UUID_V4), dedupe_key: rows[0]?.ref_id, status: "queued", recipient: staff, subject: costSubject(50, orgId) },
    ]);
    // The ref is the run's own, minted for it: not the org, not the competition, not the row.
    expect([orgId, "comp-1", id]).not.toContain(rows[0]!.ref_id);
    expect(costAlert, "what the alert says").toHaveBeenCalledTimes(1);
    const args = costAlert.mock.calls[0]![0];
    expect(args.orgId).toBe(orgId);
    expect(args.competitionId).toBe("comp-1");
    expect(args.phase).toBe("schedule");
    expect(args.model).toBe("claude-sonnet-5");
    expect(args.costUsd).toBe(50);
    expect(args.medianUsd).toBeGreaterThan(0);
    expect(args.windowDays).toBe(MEDIAN_WINDOW_DAYS);
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("two expensive runs are two alerts", async () => {
    // A double press is two runs and two costs: the same org, phase, model and
    // cost twice must page twice, and the second must not replace the first
    // while it waits (P-W5-1).
    await seedRuns("schedule.ai_generated", SCHEDULE_COST, SEED_N);
    const run = { orgId: randomUUID(), phase: "schedule" as const, model: "claude-sonnet-5", costUsd: 50 };

    await maybeAlertExpensiveRun(run);
    await maybeAlertExpensiveRun(run);

    const rows = await myRows();
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(rows.map((r) => r.subject)).toEqual([costSubject(50, run.orgId), costSubject(50, run.orgId)]);
    expect(rows.every((r) => UUID_V4.test(r.ref_id)), "each under a ref of its own").toBe(true);
    expect(new Set(rows.map((r) => r.ref_id)).size).toBe(2);
    expect(drops(), "both queued, nothing dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("forwards the run's mode and pack_units to the email (v17 gap #295 fold)", async () => {
    // The alert is the only place a human sees this run before /admin/ai-runs,
    // and "$0.90" alone cannot be triaged: mode says whether it is a full
    // regenerate or a nudge, pack_units says whether the cost is proportionate.
    // Both are pass-through only — the MEDIAN stays pooled across modes (see
    // the pooled-baseline note in the copy), so nothing here narrows it.
    await seedRuns("schedule.ai_generated", SCHEDULE_COST, SEED_N);
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      mode: "regenerate",
      model: "claude-sonnet-5",
      costUsd: 50,
      packUnits: 40,
    });
    expect(costAlert).toHaveBeenCalledTimes(1);
    const args = costAlert.mock.calls[0]![0];
    expect(args.mode).toBe("regenerate");
    expect(args.packUnits).toBe(40);
    expect(await myRows()).toHaveLength(1);
  });

  it("omits mode/pack_units rather than inventing them when the caller has none", async () => {
    // The officials path has no mode at all, and a pre-wave caller may carry no
    // size — the email must receive nothing rather than a zero it would render
    // as a real, empty pack.
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "officials",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(costAlert).toHaveBeenCalledTimes(1);
    const args = costAlert.mock.calls[0]![0];
    expect(args.mode).toBeUndefined();
    expect(args.packUnits).toBeUndefined();
    expect(await myRows()).toHaveLength(1);
  });

  it("compares an officials run against the OFFICIALS baseline, not the schedule one", async () => {
    // Pins the phase -> event-type map: the two baselines are seeded orders of
    // magnitude apart, so an inverted ternary would email a visibly different
    // median. Asserted three ways — exact equality with a fresh officials
    // read, a range only the officials seed can satisfy, and a proof that the
    // schedule baseline really is somewhere else entirely.
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "officials",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(costAlert).toHaveBeenCalledTimes(1);
    const args = costAlert.mock.calls[0]![0];
    const officialsMedian = await medianRunCostUsd(
      "schedule.ai_officials_generated",
      MEDIAN_WINDOW_DAYS,
    );
    const scheduleMedian = await medianRunCostUsd("schedule.ai_generated", MEDIAN_WINDOW_DAYS);
    expect(args.phase).toBe("officials");
    expect(args.medianUsd).toBe(officialsMedian);
    expect(args.medianUsd).toBeLessThan(0.0001); // only the officials seed lives down here
    expect(scheduleMedian).toBeGreaterThan(0.001); // …and the schedule baseline does not
  });

  it("never throws — an alert that cannot be queued is logged and dropped, and the run is unaffected", async () => {
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    costAlert.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(
      maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "officials", model: "x", costUsd: 50 }),
    ).resolves.toBeNull();
    // The render really was attempted — otherwise this would pass vacuously
    // without ever entering the catch.
    expect(costAlert).toHaveBeenCalledTimes(1);
    expect(await myRows()).toEqual([]);
    expect(drops(), "the drop is logged and reported, once").toEqual({ logged: 1, issues: 1 });
  });

  it("does nothing for a null cost (nothing to compare)", async () => {
    const id = await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      model: "x",
      costUsd: null,
    });
    expect(id).toBeNull();
    expect(costAlert).not.toHaveBeenCalled();
    expect(await myRows()).toEqual([]);
  });
});

// v17 gap #295, fix round 2 (controller ruling). `cost_usd` is a free-form
// JSONB key, not a typed column, and every reader in ai-runs-admin.ts cast it
// with a bare `::numeric`. ONE unreadable value therefore aborts the whole
// query — and because maybeAlertExpensiveRun wraps everything in a try/catch
// that only logs, the expensive-run alert this wave exists to ship would then
// go SILENT, permanently, with nothing surfacing it. /admin/ai-runs (which
// renders listAiRuns + aiRunTotals server-side) 500s for the same reason.
//
// Every test here plants a malformed row and removes it in a `finally` — the
// schema is shared and long-lived, so a poison row left behind breaks every
// later suite (which is exactly how this defect was discovered).
describe.skipIf(!HAS_DB)("malformed cost_usd must not disable the readers (v17 gap #295)", () => {
  it("does not silently kill the expensive-run alert", async () => {
    await seedRuns("schedule.ai_generated", SCHEDULE_COST, SEED_N);
    const { compId } = await seedRawRun("schedule.ai_generated", { cost_usd: "expensive" });
    try {
      // Before the guard this threw PostgresError: invalid input syntax for
      // type numeric: "expensive".
      const median = await medianRunCostUsd("schedule.ai_generated", MEDIAN_WINDOW_DAYS);
      expect(median).toBeGreaterThan(0);

      // …and this is the real damage: the throw was swallowed, so the alert
      // simply never fired again.
      await maybeAlertExpensiveRun({
        orgId: randomUUID(),
        phase: "schedule",
        model: "claude-sonnet-5",
        costUsd: 50,
      });
      expect(await myRows()).toHaveLength(1);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });

  it("excludes an unreadable row from the MIN-SAMPLE count, not just from the percentile", async () => {
    // A row carrying no usable cost carries no signal either, so it must not
    // help a thin window reach the >= 20 floor — otherwise 19 real runs plus
    // one corrupt one would start emailing staff off a baseline of 19.
    // Per-test synthetic type, so the window provably holds only these rows.
    const probe = probeType();
    await seedRuns(probe, 0.01, AI_RUN_MEDIAN_MIN_SAMPLE - 1); // 19 usable
    const { compId } = await seedRawRun(probe, { cost_usd: "expensive" }); // 20th row, unusable
    try {
      expect(await medianRunCostUsd(probe, 1)).toBeNull();
      // One more REAL row tips it over — proving the null above was the
      // sample floor talking, not the malformed row breaking the query.
      await seedRuns(probe, 0.01, 1);
      expect(await medianRunCostUsd(probe, 1)).toBeCloseTo(0.01, 10);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });

  it("keeps /admin/ai-runs rendering — listAiRuns and aiRunTotals degrade to nulls", async () => {
    // Same page, same hazard, three more casts: usage counters and the
    // division_id used in a LEFT JOIN, all read straight out of the payload.
    const { compId, orgName } = await seedRawRun("schedule.ai_generated", {
      cost_usd: "expensive",
      usage: { input_tokens: "many", output_tokens: 12, repair_rounds: null },
      division_id: "not-a-uuid",
    });
    try {
      const rows = await listAiRuns(200);
      const row = rows.find((r) => r.org_name === orgName);
      expect(row, "the malformed run should still be listed, not omitted").toBeDefined();
      expect(row!.cost_usd).toBeNull();
      expect(row!.input_tokens).toBeNull();
      expect(row!.division_name).toBeNull();
      // A readable neighbour on the same row is still read.
      expect(row!.output_tokens).toBe(12);

      const totals = await aiRunTotals(MEDIAN_WINDOW_DAYS);
      expect(totals.runs).toBeGreaterThan(0);
      // The run is counted; its unreadable numbers simply are not summed.
      expect(Number.isFinite(totals.input_tokens)).toBe(true);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });
});

// The builder's render, called directly (the module mock above is a spy that calls through to it): the two median branches,
// a multiple and none, render without throwing. The copy itself is asserted in lib/__tests__/ai-run-cost-alert-email.test.ts.
describe("aiRunCostAlertEmail (real render, v17 gap #295)", () => {
  const base = {
    orgId: "org-1",
    competitionId: "comp-1",
    phase: "schedule" as const,
    model: "claude-sonnet-5",
    costUsd: 50,
    windowDays: MEDIAN_WINDOW_DAYS,
  };

  it("renders the subject and the multiple when there is a median", () => {
    const mail = aiRunCostAlertEmail({ ...base, medianUsd: 0.25 });
    expect(mail.subject).toBe(costSubject(50, "org-1"));
    expect(mail.text).toContain("200.0x the trailing 30-day schedule median");
  });

  it("renders the no-multiple branch (medianUsd <= 0) without dividing by zero", () => {
    const mail = aiRunCostAlertEmail({ ...base, competitionId: undefined, phase: "officials", medianUsd: 0 });
    expect(mail.text).not.toMatch(/Infinity|NaN/);
    expect(mail.text).not.toContain("x the trailing");
  });
});
