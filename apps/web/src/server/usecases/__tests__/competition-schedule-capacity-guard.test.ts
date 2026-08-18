// P1 review finding #3: the D2 capacity pre-check guard inside
// `aiPlanForCompetition` (competition-schedule-ai.ts, planForCompetition's
// per-kept-division loop just above the wallet resolve) had ZERO test
// coverage — every existing capacity test (capacity-guard.test.ts,
// schedule-capacity-guard.test.ts, capacity-precheck.spec.ts, smoke's
// capacityPrecheckSuite) exercises only the STAGE route.
//
// Three things this file proves that nothing else does:
//   1. AGGREGATION — every kept division is assessed, not just the first;
//      a single 422 names ALL of them, matching the ruling in the P1
//      dispatch brief ("if any division is impossible, 422 with the
//      impossible set in the report").
//   2. The 422 SHAPE — code, message, and the `divisions` extra array.
//   3. NO WALLET/CREDIT SIDE EFFECT — asserted on the wallet BALANCE, never
//      on the thrown error alone (same discipline
//      competition-schedule-ai-route.test.ts already uses for every other
//      pre-wallet gate: an error raised after a reserve would still satisfy
//      a bare rejects-assertion).
//
// Mocks copied verbatim from competition-schedule-ai-route.test.ts, not
// hand-trimmed: a first pass at a "minimal" subset here (dropped the
// schedule-ai-parse / ai-runs-admin / cache mocks) left the stage-1
// instruction compiler and an admin alert hook UNMOCKED, and — even with an
// empty `instruction` string, which skips the compiler — a run consistently
// took 27-30s and either timed out or resolved without throwing. This guard
// sits before the AI compile and the wallet reserve, so a correctly firing
// guard never reaches any of this; it is mocked anyway so a MIS-firing guard
// (one that doesn't throw) fails fast through a mock instead of a real,
// slow/hanging network path.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HardConstraint } from "@seazn/engine/scheduling";

const { parse, isServerFeatureEnabled, captureServer, incrWindow, rlCounts, MockAPIError } = vi.hoisted(() => {
  const rlCounts = new Map<string, number>();
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }
  return {
    MockAPIError,
    parse: vi.fn(),
    isServerFeatureEnabled: vi.fn(),
    captureServer: vi.fn(),
    incrWindow: vi.fn(async (key: string) => {
      const n = (rlCounts.get(key) ?? 0) + 1;
      rlCounts.set(key, n);
      return n;
    }),
    rlCounts,
  };
});

const { parseInstructionMock } = vi.hoisted(() => ({
  parseInstructionMock: vi.fn(async () => ({ raw: null, failed: false, tokens: 0, servedModel: null })),
}));
vi.mock("../schedule-ai-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai-parse")>();
  return { ...actual, parseInstruction: parseInstructionMock };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: Object.assign(
    class Anthropic {
      messages = { parse };
    },
    { APIError: MockAPIError },
  ),
}));
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled, captureServer }));
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

const { maybeAlertExpensiveRun } = vi.hoisted(() => ({
  maybeAlertExpensiveRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createVenue, createCourt } from "../venues";
import { aiPlanForCompetition } from "../competition-schedule-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "UTC";

/** pro_plus (scheduling.ai + scheduling.multi_division) with a funded wallet
 *  — the SAME shape competition-schedule-ai-route.test.ts's seedPlusOrg
 *  builds, duplicated rather than imported (test files in this directory
 *  don't share helpers across files). */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  return auth;
}

interface DivSpec {
  name: string;
  /** Division-local config — `capacityInputForFixtures`-shaped fields only. */
  config: {
    startAt: string;
    endAt: string;
    matchMinutes: number;
    gapMinutes: number;
    courts: string[];
    perEntrantMinRest: number;
    sessionWindows: { from: string; to: string }[];
  };
  /** 4 -> a round-robin of 6 fixtures. */
  entrants?: number;
}

// P9 pass 3b: `ScheduleConfig.courts` is `z.array(CourtId)` (real `courts.id`
// values, since pass 1) — every DivSpec config below still specs a readable
// "Court 1" label; nothing in this file asserts on a court's identity (it is
// a pure capacity-arithmetic suite), so a real court is resolved (and
// cached, per org — every config here uses exactly one court) 1:1 in place
// of whatever labels spec.config.courts names.
const courtsByOrg = new Map<string, { venueId: string; byName: Map<string, string> }>();

async function courtIds(auth: AuthCtx, names: readonly string[]): Promise<string[]> {
  let entry = courtsByOrg.get(auth.orgId);
  if (!entry) {
    const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
    entry = { venueId: venue.id, byName: new Map() };
    courtsByOrg.set(auth.orgId, entry);
  }
  const out: string[] = [];
  for (const name of names) {
    const cached = entry.byName.get(name);
    if (cached !== undefined) {
      out.push(cached);
      continue;
    }
    const court = await createCourt(auth, entry.venueId, { name, sort: entry.byName.size, tags: [] });
    entry.byName.set(name, court.id);
    out.push(court.id);
  }
  return out;
}

async function seedDivision(auth: AuthCtx, competitionId: string, spec: DivSpec): Promise<{ id: string; name: string }> {
  const division = await createDivision(auth, competitionId, {
    name: spec.name,
    slug: `${spec.name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const n = spec.entrants ?? 4;
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `${spec.name}-E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const config = { ...spec.config, courts: await courtIds(auth, spec.config.courts) };
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(config as never)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  return { id: division.id, name: spec.name };
}

async function seedCompetition(
  auth: AuthCtx,
  name: string,
  specs: DivSpec[],
): Promise<{ competitionId: string; divisions: { id: string; name: string }[] }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name, visibility: "public", branding: {} });
  const divisions: { id: string; name: string }[] = [];
  for (const spec of specs) divisions.push(await seedDivision(auth, comp.id, spec));
  return { competitionId: comp.id, divisions };
}

// 1h session window, 1 court, 30-min matches -> supply = floor(60/30) = 2
// slots. A 4-entrant round robin is 6 fixtures. 2 << 6: arithmetically
// impossible, same numbers as schedule-capacity-guard.test.ts's stage-level
// proof (D2's regression fixture), reused here for the competition path.
const IMPOSSIBLE_CONFIG: DivSpec["config"] = {
  startAt: "2026-08-01T09:00:00.000Z",
  endAt: "2026-08-01T23:59:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
};

// Same shape, 12h window -> supply = floor(720/30) = 24 >= 6: comfortable.
const OK_CONFIG: DivSpec["config"] = {
  ...IMPOSSIBLE_CONFIG,
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }],
};

// D2-wave1 followup (CapacityDay.forcedDemand): 2 real days, day1 holds 2
// slots (1h window), day2 holds 24 (12h window) -- 26 total, vastly more
// than the 6-fixture round robin's demand, so total-supply arithmetic alone
// calls this comfortable. The forced-demand tests below nail 3 of those 6
// fixtures onto day1 specifically -- more than day1's own 2 slots can hold
// -- which NEITHER total supply nor a max_fixtures_per_day cap would catch,
// and is exactly the gap this followup closes.
const TWO_DAY_ROOMY_CONFIG: DivSpec["config"] = {
  startAt: "2026-08-01T09:00:00.000Z",
  endAt: "2026-08-02T23:59:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  sessionWindows: [
    { from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" },
    { from: "2026-08-02T09:00:00.000Z", to: "2026-08-02T21:00:00.000Z" },
  ],
};

/** Force `n` of `divisionId`'s already-generated fixtures onto `date` via
 *  `fixture_on_date`/`id`-selector rules, merged into the division's
 *  seeded `schedule_settings.config` (jsonb `||` -- additive: none of this
 *  file's DivSpec configs set `constraints` themselves, so this only ADDS
 *  the key). This is the same `constraints.hard` vocabulary the
 *  Constraints tab writes through the API -- not a second, test-only
 *  mechanism. */
async function forceFixturesOntoDate(divisionId: string, date: string, n: number): Promise<void> {
  const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} limit ${n}`;
  expect(rows.length).toBe(n); // the fixtures this test forces must actually exist
  const hard: HardConstraint[] = rows.map((r) => ({
    type: "fixture_on_date",
    selector: { kind: "id", fixtureId: r.id },
    date,
    scope: { kind: "division", divisionId },
  }));
  await sql`update schedule_settings set config = config || ${sql.json({ constraints: { hard } } as never)} where division_id = ${divisionId}`;
}

// EMPTY instruction, deliberately: a non-empty one takes the stage-1
// compile branch (`parseInstruction`, schedule-ai-parse.ts) which is NOT
// mocked in this file (unlike competition-schedule-ai-route.test.ts) and
// shares this file's single `@anthropic-ai/sdk` mock with the main
// architect round below, producing cross-talk between the two callers and,
// measured, a 30s timeout / spurious retries. This guard sits before BOTH
// calls either way, so an empty instruction changes nothing about what is
// under test.
const run = (auth: AuthCtx, competitionId: string, divisionIds: string[]) =>
  aiPlanForCompetition(auth, competitionId, {
    division_ids: divisionIds,
    instruction: "",
    mode: "generate",
  });

beforeEach(() => {
  parse.mockReset();
  isServerFeatureEnabled.mockReset().mockResolvedValue(true);
  captureServer.mockReset().mockResolvedValue(undefined);
  parseInstructionMock.mockClear();
  maybeAlertExpensiveRun.mockClear();
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_PROVIDER;
  process.env.SCHEDULING_REPAIR_SOLVER = "off";
});

afterAll(async () => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  await g._sql?.end();
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition — D2 capacity guard (per kept division)", () => {
  it("aggregates: BOTH impossible divisions are named in ONE 422, not just the first", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "BothTight", [
      { name: "Alpha", config: IMPOSSIBLE_CONFIG },
      { name: "Bravo", config: IMPOSSIBLE_CONFIG },
    ]);

    let caught: unknown;
    try {
      await run(auth, competitionId, divisions.map((d) => d.id));
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ status: 422, code: "CAPACITY_IMPOSSIBLE" });
    const err = caught as { message: string; extra?: { divisions?: { id: string; name: string }[] } };
    expect(err.message).toContain("Alpha");
    expect(err.message).toContain("Bravo");
    const namedIds = (err.extra?.divisions ?? []).map((d) => d.id).sort();
    expect(namedIds).toEqual([...divisions.map((d) => d.id)].sort());

    // Never charged — same discipline every other pre-wallet gate in this
    // directory is held to.
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("names ONLY the impossible division when the other is comfortable (not a blanket refusal)", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "OneTight", [
      { name: "Roomy", config: OK_CONFIG },
      { name: "Cramped", config: IMPOSSIBLE_CONFIG },
    ]);

    let caught: unknown;
    try {
      await run(auth, competitionId, divisions.map((d) => d.id));
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ status: 422, code: "CAPACITY_IMPOSSIBLE" });
    const err = caught as { message: string; extra?: { divisions?: { id: string; name: string }[] } };
    expect(err.message).toContain("Cramped");
    expect(err.message).not.toContain("Roomy");
    expect((err.extra?.divisions ?? []).map((d) => d.name)).toEqual(["Cramped"]);
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("proceeds (reaches the AI compile) when every kept division is comfortable", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "AllRoomy", [
      { name: "Alpha", config: OK_CONFIG },
      { name: "Bravo", config: OK_CONFIG },
    ]);
    parse.mockResolvedValue({
      parsed_output: { assignments: [], unschedulable: [], explanations: [], summary: "ok" },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [],
    });

    // The mocked compile returns an empty plan, so the AI ladder exhausts and
    // `run` rejects with "could not produce a usable plan". That is expected
    // and is not what this test is about — getting as far as the compile is
    // itself the proof the guard did not wrongly refuse a comfortable board.
    // So: assert the failure is NOT the capacity refusal, and that the compile
    // was reached. Asserting the literal code rather than importing
    // CAPACITY_IMPOSSIBLE_CODE is deliberate: a test that imports the constant
    // still passes if the constant's value changes, which is the wire-level
    // drift this is meant to pin.
    let caught: unknown;
    try {
      await run(auth, competitionId, divisions.map((d) => d.id));
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string } | undefined)?.code).not.toBe("CAPACITY_IMPOSSIBLE");
    expect(parse).toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition — D2 capacity guard forcedDemand (fixture_on_date floor, wave1 followup)", () => {
  it("a fixture_on_date rule nailing more fixtures onto one day than it holds is impossible, even though TOTAL supply is ample", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Floored", [
      { name: "Alpha", config: TWO_DAY_ROOMY_CONFIG },
      { name: "Bravo", config: OK_CONFIG },
    ]);
    const alpha = divisions.find((d) => d.name === "Alpha")!;
    await forceFixturesOntoDate(alpha.id, "2026-08-01", 3); // day1 holds 2 -- 3 overflows it

    let caught: unknown;
    try {
      await run(auth, competitionId, divisions.map((d) => d.id));
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ status: 422, code: "CAPACITY_IMPOSSIBLE" });
    const err = caught as { message: string; extra?: { divisions?: { id: string; name: string }[] } };
    expect(err.message).toContain("Alpha");
    // Bravo (OK_CONFIG, no forcing rule) is unaffected -- proves this 422 is
    // Alpha's floor specifically, not a blanket refusal that would fire
    // regardless of which division carried the rule.
    expect(err.message).not.toContain("Bravo");
    expect((err.extra?.divisions ?? []).map((d) => d.name)).toEqual(["Alpha"]);
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("the paired control — the SAME board with no forcing rule — reaches the AI compile (total supply alone is comfortable)", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "NotFloored", [
      { name: "Alpha", config: TWO_DAY_ROOMY_CONFIG },
      { name: "Bravo", config: OK_CONFIG },
    ]);
    parse.mockResolvedValue({
      parsed_output: { assignments: [], unschedulable: [], explanations: [], summary: "ok" },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [],
    });

    // Same reasoning as "proceeds (reaches the AI compile)" above: the
    // mocked compile returns an empty plan so the AI ladder exhausts and
    // `run` rejects downstream — reaching the compile at all is itself the
    // proof this pair's ONLY difference (the forcing rule) is what flips
    // the earlier test to CAPACITY_IMPOSSIBLE.
    let caught: unknown;
    try {
      await run(auth, competitionId, divisions.map((d) => d.id));
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string } | undefined)?.code).not.toBe("CAPACITY_IMPOSSIBLE");
    expect(parse).toHaveBeenCalled();
  });
});
