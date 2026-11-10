// #230 item 2, follow-up — the publish gate was walkable around via "Start".
//
// `publishSchedule` validates the board before it goes public. `startDivision`
// did not validate anything at all: it advanced `setup → active`, and on the
// quick-start path it WROTE rolling round times itself and then opened scoring
// (`scoring.ts` opens on `active`). So an organiser whose board failed the
// publish gate could simply press Start instead and the same broken timetable
// went live, with no `schedule_published` event to record that it ever had.
//
// The owner's design is not a second refusal but a second CALLER: starting the
// tournament auto-publishes the schedule, under the same validation, the same
// error codes and the same `acknowledge_warnings` contract, so the console's
// confirm dialog serves both buttons with one code path.
//
// Two properties this file exists to pin, both of which a plausible
// implementation gets wrong:
//
//   * the gate rejects CONFLICTS, never INCOMPLETENESS. Many existing suites
//     start divisions whose boards are empty or half-slotted; an empty board
//     yields no assignments, so `validateAssignments` — which reports only on
//     `assignments`, never on `existing` — has nothing to report. If that ever
//     stops being true, this file reds before those suites do.
//   * on the quick-start path the check runs AFTER the rolling times are
//     written. Validating first checks a board that does not exist yet.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { publishSchedule, startDivision, validateSchedule } from "../schedule";
import { listKnockoutWaiting } from "../knockout-desk";
import { withdrawEntrantCascade } from "../withdrawal";
import { setDivisionLocks } from "../history";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { createVenue, createCourt } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** `seedOrg` leaves `organizations.timezone` null, so `orgTz` resolves to UTC
 *  and every instant below is written in Z — day keys line up with no
 *  arithmetic (#397/#448). */
const DAY = "2026-09-14";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

interface ConfigOpts {
  /** Per-entrant rest floor, minutes. 120 turns a 60-minute turnaround into a
   *  `warn.rest`, which is NOT blocking — the whole point of the warning tests. */
  restMin?: number;
  /** Quick-start rolling round length. Present makes `startDivision` write
   *  `scheduled_at` for every round that has none. */
  roundMinutes?: number;
}

// P9 pass 3a: real courts.id values — ScheduleConfig.courts is CourtId[]
// since pass 1, and fixtures.court_id carries a composite FK since
// V367/368. `Slot.court`/the constants below keep the readable "Court 1"/
// "Court 2" labels; `seedBoard` resolves them to real ids via this map.
function settingsConfig(opts: ConfigOpts, courts: [string, string]) {
  const rest = opts.restMin ?? 20;
  return {
    startAt: at(DAY, "08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: rest,
    ...(opts.roundMinutes !== undefined ? { roundMinutes: opts.roundMinutes } : {}),
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: rest,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard: [],
    },
  };
}

interface Slot {
  /** 1-based entrant numbers, into the four seeded entrants. */
  home: number;
  away: number;
  /** Omitted leaves `scheduled_at` NULL — an unscheduled card. */
  hhmm?: string;
  /** "Court 1"/"Court 2" — `seedBoard` resolves to a real court_id (P9 pass
   *  3a). Omitted leaves `court_id` NULL. A card needs BOTH to be an assignment. */
  court?: string;
  round?: number;
}

interface Board {
  auth: AuthCtx;
  divisionId: string;
  fixtureIds: string[];
}

async function seedBoard(slots: Slot[], config: ConfigOpts = {}): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Start Gate ${tag}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: `Div ${tag}`,
    slug: `start-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  const courtByLabel = new Map([
    ["Court 1", court1.id],
    ["Court 2", court2.id],
  ]);
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(config, [court1.id, court2.id]))}, ${"UTC"}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    [1, 2, 3, 4].map((n) => ({
      kind: "individual" as const,
      display_name: `E${n}`,
      seed: n,
      members: [],
    })),
  );
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const fixtureIds: string[] = [];
  for (const [i, s] of slots.entries()) {
    const courtId = s.court !== undefined ? (courtByLabel.get(s.court) ?? null) : null;
    const [f] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at, court_id)
      values (${stage!.id}, ${division.id}, ${auth.orgId}, ${s.round ?? 1}, ${i}, ${`f${i}`},
              'scheduled', ${byName.get(`E${s.home}`)!}, ${byName.get(`E${s.away}`)!},
              ${s.hhmm ? at(DAY, s.hhmm) : null}, ${courtId})
      returning id`;
    fixtureIds.push(f!.id);
  }
  return { auth, divisionId: division.id, fixtureIds };
}

/** Two fixtures, disjoint entrants, an hour apart on one court. Nothing to report. */
const CLEAN: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4, hhmm: "10:00", court: "Court 1" },
];

/** Same court, same instant — `conflict.court`, the archetypal BLOCKING conflict
 *  (`isBlockingConflict`: court / person_overlap / window / direct order). */
const COURT_CLASH: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4, hhmm: "09:00", court: "Court 1" },
];

/** E1 plays twice with a 60-minute turnaround. Under a 120-minute floor that is
 *  `warn.rest` — deliberately NOT blocking ("uncomfortable is not impossible"). */
const REST_WARNING: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 1, away: 3, hhmm: "10:00", court: "Court 2" },
];

/** The shape every other suite in this repo starts: real fixtures, no times and
 *  no courts. INCOMPLETE, not conflicted. */
const UNSCHEDULED: Slot[] = [
  { home: 1, away: 2 },
  { home: 3, away: 4 },
];

/** Half a board: one card placed, one card not. Still no conflict between them. */
const HALF_PLACED: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4 },
];

async function eventsOfType(divisionId: string, type: string): Promise<{ payload: Record<string, unknown> }[]> {
  return sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
    where division_id = ${divisionId} and type = ${type} order by seq`;
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return row!.status;
}

async function scheduledCount(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures
    where division_id = ${divisionId} and scheduled_at is not null`;
  return row!.n;
}

/** The `extra` bag an `HttpError` carries into the /api/v1 error body. */
function thrownConflicts(err: unknown): ScheduleConflict[] {
  return (err as { extra?: { conflicts?: ScheduleConflict[] } }).extra?.conflicts ?? [];
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("starting a division publishes it, under the publish gate (#230)", () => {
  it("refuses a board with a BLOCKING conflict, and writes nothing", async () => {
    const board = await seedBoard(COURT_CLASH);

    let thrown: unknown;
    await startDivision(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    // WHICH conflict, not merely "a 422": this path already refuses a completed
    // division, a frozen competition and a division with no stages, and a bare
    // status assertion is satisfied by all three.
    const refused = thrownConflicts(thrown);
    expect(refused.some((c) => c.code === "conflict.court" && c.blocking)).toBe(true);
    expect(new Set(refused.map((c) => c.fixture_id))).toEqual(new Set(board.fixtureIds));

    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(0);
  }, 120_000);

  it("refuses a warning-only board unacknowledged, and starts it acknowledged", async () => {
    const board = await seedBoard(REST_WARNING, { restMin: 120 });

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS",
    });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);

    const out = await startDivision(board.auth, board.divisionId, {
      acknowledge_warnings: true,
      reason: "venue confirmed the turnaround",
    });
    expect(out).toMatchObject({ status: "active", started: true });
    expect(await divisionStatus(board.divisionId)).toBe("active");
  }, 120_000);

  it("records the publish it performed on the way through", async () => {
    // The event is the only record anywhere that a publish happened —
    // `history-panel.tsx` renders it, and the public schedule went live on the
    // back of it. A start that flips the status without appending it publishes
    // silently.
    const board = await seedBoard(REST_WARNING, { restMin: 120 });
    await startDivision(board.auth, board.divisionId, {
      acknowledge_warnings: true,
      reason: "venue confirmed the turnaround",
    });

    const published = await eventsOfType(board.divisionId, "schedule_published");
    expect(published).toHaveLength(1);
    const payload = published[0]!.payload as {
      fixturesScheduled: number;
      conflicts: ScheduleConflict[];
      acknowledged: boolean;
      reason?: string;
    };
    expect(payload.fixturesScheduled).toBe(2);
    expect(payload.acknowledged).toBe(true);
    expect(payload.reason).toBe("venue confirmed the turnaround");
    expect(payload.conflicts.some((c) => c.code === "warn.rest")).toBe(true);
    expect(payload.conflicts.every((c) => !c.blocking)).toBe(true);

    // …and the start itself is still recorded, from the status it came from.
    const started = await eventsOfType(board.divisionId, "division_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ from: "setup" });
  }, 120_000);

  it("does NOT let acknowledge_warnings past a blocking conflict", async () => {
    // The security-shaped one. Without it the flag is an override for
    // everything, which is exactly what it must never be: there is no override
    // for physically impossible.
    const board = await seedBoard(COURT_CLASH);

    await expect(
      startDivision(board.auth, board.divisionId, { acknowledge_warnings: true, reason: "ship it" }),
    ).rejects.toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);
  }, 120_000);

  it("starts a clean board and publishes it, unacknowledged", async () => {
    const board = await seedBoard(CLEAN);

    const out = await startDivision(board.auth, board.divisionId);
    expect(out).toMatchObject({ status: "active", started: true });

    const published = await eventsOfType(board.divisionId, "schedule_published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      fixturesScheduled: 2,
      conflicts: [],
      acknowledged: false,
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // The incompleteness carve-out. `custom-points.test.ts`, `device-links.test.ts`,
  // `integration.test.ts` and a dozen others start divisions that look like this.
  // -------------------------------------------------------------------------

  it("starts an UNSCHEDULED board exactly as before — the gate rejects conflicts, not gaps", async () => {
    const board = await seedBoard(UNSCHEDULED);

    const out = await startDivision(board.auth, board.divisionId);
    expect(out).toMatchObject({ status: "active", started: true });
    expect(await divisionStatus(board.divisionId)).toBe("active");
    // Nothing was slotted, so nothing was published — but the division started.
    expect(await scheduledCount(board.divisionId)).toBe(0);
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(1);
  }, 120_000);

  it("starts a HALF-PLACED board — one card with no time is not a conflict", async () => {
    const board = await seedBoard(HALF_PLACED);

    await expect(startDivision(board.auth, board.divisionId)).resolves.toMatchObject({
      status: "active",
      started: true,
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // Ordering: the quick-start write happens first, and is what gets validated.
  // -------------------------------------------------------------------------

  it("validates the rolling times QUICK-START wrote, and rolls them back when they clash", async () => {
    // Both cards sit on one court in round 1 with no time. Quick-start gives
    // every fixture in a round the SAME instant, so writing the times is what
    // creates the double-booking. A gate that validated before the write sees
    // two unscheduled cards, finds nothing, and starts the division on a board
    // with two matches on one court at 08:00 — every other test in this file
    // passes against that gate.
    const board = await seedBoard(
      [
        { home: 1, away: 2, court: "Court 1", round: 1 },
        { home: 3, away: 4, court: "Court 1", round: 1 },
      ],
      { roundMinutes: 60 },
    );
    expect(await scheduledCount(board.divisionId)).toBe(0);

    let thrown: unknown;
    await startDivision(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    expect(thrownConflicts(thrown).some((c) => c.code === "conflict.court")).toBe(true);

    // The refusal rolls the times back with it — one transaction, so the
    // organiser is not left with a half-started board that now HAS a clash.
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await scheduledCount(board.divisionId)).toBe(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // The other statuses on the way through.
  // -------------------------------------------------------------------------

  it("does not publish a second time when the division was already published", async () => {
    const board = await seedBoard(CLEAN);
    await publishSchedule(board.auth, board.divisionId);
    expect(await divisionStatus(board.divisionId)).toBe("scheduled");
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(1);

    await expect(startDivision(board.auth, board.divisionId)).resolves.toMatchObject({
      status: "active",
      started: true,
    });
    // Still the one publish. `scheduled → active` is not a publish.
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(1);
  }, 120_000);

  it("still gates a division that was published before its board went bad", async () => {
    const board = await seedBoard(COURT_CLASH);
    await sql`update divisions set status = 'scheduled' where id = ${board.divisionId}`;

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_BLOCKING_CONFLICTS",
    });
    expect(await divisionStatus(board.divisionId)).toBe("scheduled");
  }, 120_000);

  it("reports exactly what the standalone validator reports", async () => {
    // The anti-fork assertion. A start-specific validation pass is how the
    // placer and the verifier drifted apart three times in this programme;
    // deep equality against the panel's own answer is what forbids one.
    for (const [slots, config] of [
      [REST_WARNING, { restMin: 120 }],
      [COURT_CLASH, {}],
    ] as [Slot[], ConfigOpts][]) {
      const board = await seedBoard(slots, config);
      const panel = await validateSchedule(board.auth, board.divisionId);
      expect(panel.conflicts.length).toBeGreaterThan(0);

      let thrown: unknown;
      try {
        await startDivision(board.auth, board.divisionId);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrownConflicts(thrown)).toEqual(panel.conflicts);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// A freeze binds start's schedule WRITES, not the transition (task 10)
// ---------------------------------------------------------------------------
//
// Starting a frozen division is INTENDED and has to keep working. The freeze's
// own copy scopes it — "block all schedule EDITS until unfrozen" — the design's
// customer story for it is freeze-then-publish, and `schedule-board.tsx` makes
// the same call in the UI: the freeze toggle reads `single.schedule_locked`
// while the publish/start block fifteen lines below gates on STATUS only, same
// component, same variable in scope, different condition. A walkthrough step
// pins `schedule_locked === true` on both sides of publish and of start.
//
// But `startDivision` can WRITE the schedule on the way through, in two places:
// it GENERATES the first stage's fixtures when that stage is empty, and it
// sweeps rolling `scheduled_at` values across every round that has none. Both
// are schedule edits whatever door they came through, and both went through a
// frozen board unrefused.
//
// So the guard is on the WRITE, not on the transition — and it takes THREE
// cases to say so. Frozen-refuses plus unfrozen-succeeds cannot tell a correct
// guard from one gated on merely REACHING the quick-start branch; only the
// third case (frozen, branch entered, nothing left to write) can.
describe.skipIf(!HAS_DB)("a freeze binds start's schedule writes, not the transition (task 10)", () => {
  const lock = (auth: AuthCtx, divisionId: string, on: boolean): Promise<unknown> =>
    setDivisionLocks(auth, divisionId, { schedule_locked: on });

  async function fixtureCount(divisionId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where division_id = ${divisionId}`;
    return row!.n;
  }

  async function scheduleLocked(divisionId: string): Promise<boolean> {
    const [row] = await sql<{ schedule_locked: boolean }[]>`
      select schedule_locked from divisions where id = ${divisionId}`;
    return row!.schedule_locked;
  }

  it("frozen + an empty first stage → refuses rather than generating a whole timetable", async () => {
    // No slots at all, so `startDivision`'s quick-start would GENERATE the
    // stage — the widest schedule write it can make.
    const board = await seedBoard([], { roundMinutes: 60 });
    expect(await fixtureCount(board.divisionId)).toBe(0);
    await lock(board.auth, board.divisionId, true);

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: SCHEDULE_LOCKED_CODE,
    });
    // `message` is not an own enumerable property, so `toMatchObject` above
    // cannot see it — it needs its own matcher.
    await expect(startDivision(board.auth, board.divisionId)).rejects.toThrow(
      SCHEDULE_LOCKED_MESSAGE,
    );
    // The refusal generated nothing and started nothing on its way out.
    expect(await fixtureCount(board.divisionId)).toBe(0);
    expect(await divisionStatus(board.divisionId)).toBe("setup");

    // UNFROZEN, same board, same would-write: still generates and still
    // starts. Without this the guard could be refusing every empty-stage
    // start and the test above could not tell.
    await lock(board.auth, board.divisionId, false);
    const out = await startDivision(board.auth, board.divisionId);
    expect(out.generated).toBeGreaterThan(0);
    expect(await divisionStatus(board.divisionId)).toBe("active");
  }, 120_000);

  it("frozen + rounds with no times → refuses the rolling-times sweep, and writes none of them", async () => {
    const board = await seedBoard(UNSCHEDULED, { roundMinutes: 60 });
    expect(await scheduledCount(board.divisionId)).toBe(0);
    await lock(board.auth, board.divisionId, true);

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: SCHEDULE_LOCKED_CODE,
    });
    await expect(startDivision(board.auth, board.divisionId)).rejects.toThrow(
      SCHEDULE_LOCKED_MESSAGE,
    );
    // Not one round slotted, and the division did not go active. The sweep and
    // the status move share a transaction, so a guard placed after the writes
    // would still roll them back — what this pins is that the board a frozen
    // organiser comes back to is the one they left.
    expect(await scheduledCount(board.divisionId)).toBe(0);
    expect(await divisionStatus(board.divisionId)).toBe("setup");

    // UNFROZEN control: the sweep really was available to be refused.
    await lock(board.auth, board.divisionId, false);
    await startDivision(board.auth, board.divisionId);
    expect(await scheduledCount(board.divisionId)).toBe(2);
    expect(await divisionStatus(board.divisionId)).toBe("active");
  }, 120_000);

  it("frozen + an already-slotted board → STARTS, because the quick-start has nothing to write", async () => {
    // `roundMinutes` is deliberately SET here, so the quick-start branch IS
    // entered — every fixture already has a time, so the sweep would update no
    // rows. This is the case that separates a guard on the WRITE from a guard
    // on the BRANCH: move the refusal up to `if (status === "setup" &&
    // roundMinutes)` and this test reds, along with the walkthrough step that
    // starts a frozen division on purpose.
    const board = await seedBoard(CLEAN, { roundMinutes: 60 });
    expect(await scheduledCount(board.divisionId)).toBe(2);
    await lock(board.auth, board.divisionId, true);

    const out = await startDivision(board.auth, board.divisionId);
    expect(out.started).toBe(true);
    expect(await divisionStatus(board.divisionId)).toBe("active");
    // The board is untouched and the freeze is still in force — starting must
    // not quietly lift it, which would be the defect wearing a green test.
    expect(await scheduledCount(board.divisionId)).toBe(2);
    expect(await scheduleLocked(board.divisionId)).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// W4 app B, Task 20 (carry C27): Start on a FROZEN board and a root knockout whose roster moved since the draw
// ---------------------------------------------------------------------------
//
// Start reconciles a root knockout whose first round no longer matches the field (`roster_drift`): a departed entrant's
// line becomes a bye, a newcomer takes a bye - IN PLACE. A frozen board skipped it all, so a newcomer ended up unseated
// WITHOUT `knockout_waiting_stage_id` (nobody saw them waiting) and a pre-Start withdrawal stayed seated on a line still
// to be played. PO ruling (logged): on a frozen board Start MARKS the newcomers WAITING, as the late-entry path does - it
// never refuses and never places them (placing is a schedule write the freeze binds) - and a departed entrant is
// reconciled exactly as on an unfrozen board.
// single-sport: badminton - the reconcile reads seats, labels and statuses, no sport field.
describe.skipIf(!HAS_DB)("Start on a frozen board reconciles a drifted root knockout (task 20, C27)", () => {
  interface KoRig {
    auth: AuthCtx;
    divisionId: string;
    stageId: string;
    names: Map<string, string>;
    add(name: string): Promise<string>;
  }
  const person = (name: string, seed: number | null = null) => ({
    kind: "individual" as const,
    display_name: name,
    seed,
    members: [{ new_person: { full_name: `${name} ${randomUUID().slice(0, 4)}` }, is_captain: false, roles: [] }],
  });

  /** A division of `n` badminton players and a root knockout, generated, still in setup. */
  async function koRig(n: number): Promise<KoRig> {
    const { auth } = await seedOrg("pro");
    const tag = randomUUID().slice(0, 6);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Frozen KO ${tag}`, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: `ko-${tag}`, sport_key: "badminton", variant_key: "bwf", config: {} });
    const made = await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => person(`P${i + 1}`, i + 1))); // every seat seeded: the draw is deterministic, so two rigs draw the same bracket
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    await generateStageFixtures(auth, stage!.id);
    const names = new Map(made.map((e, i) => [e.id, `P${i + 1}`]));
    return {
      auth,
      divisionId: division.id,
      stageId: stage!.id,
      names,
      add: async (name) => {
        const [e] = await createEntrants(auth, division.id, [person(name)]);
        names.set(e!.id, name);
        return e!.id;
      },
    };
  }

  interface Line {
    id: string;
    round_no: number;
    seq_in_round: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    home_slot_label: unknown;
    away_slot_label: unknown;
    status: string;
    outcome: unknown;
    scheduled_at: Date | null;
  }
  const linesOf = (stageId: string): Promise<Line[]> => sql<Line[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome, scheduled_at
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
  /** A line's shape with entrant ids read as their names, so two rigs' brackets compare. */
  const shapeByName = (r: KoRig, lines: readonly Line[]): string[] => {
    const named = (x: unknown) => {
      let t = JSON.stringify(x);
      for (const [id, name] of r.names) t = t.split(id).join(name);
      return t;
    };
    return lines.map((l) => named([l.round_no, l.seq_in_round, l.home_entrant_id, l.away_entrant_id, l.home_slot_label, l.away_slot_label, l.status, l.outcome]));
  };
  const firstRoundSeats = (lines: readonly Line[]): string[] =>
    lines.filter((l) => l.round_no === 1).flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter((x): x is string => x !== null);
  const waitingOf = async (divisionId: string): Promise<string[]> =>
    (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId} and knockout_waiting_stage_id is not null`).map((e) => e.id).sort();
  /** A first-round match with both seats held: where a withdrawal leaves a ghost. */
  const realLine = (lines: readonly Line[]): Line => lines.find((l) => l.round_no === 1 && l.home_entrant_id !== null && l.away_entrant_id !== null)!;
  const freeze = (r: KoRig) => setDivisionLocks(r.auth, r.divisionId, { schedule_locked: true });

  it("(a) a newcomer added after the draw is marked WAITING at Start - set on the entrant, listed by the desk's waiting read, never seated, the freeze untouched", async () => {
    const r = await koRig(6);
    const late = await r.add("P7");
    const before = await linesOf(r.stageId);
    expect(firstRoundSeats(before), "premise: the newcomer holds no seat").not.toContain(late);
    expect(await waitingOf(r.divisionId), "premise: nobody waits yet").toEqual([]);
    await freeze(r);

    const out = await startDivision(r.auth, r.divisionId);
    expect(out.started).toBe(true);
    expect(await waitingOf(r.divisionId)).toEqual([late]);
    const [{ knockout_waiting_stage_id: marked }] = await sql<{ knockout_waiting_stage_id: string }[]>`select knockout_waiting_stage_id from entrants where id = ${late}`;
    expect(marked).toBe(r.stageId);
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).map((w) => [w.entrantId, w.stageId, w.name])).toEqual([[late, r.stageId, "P7"]]);
    // marked, not placed: the lines are as the organiser froze them, and the freeze is still in force
    const after = await linesOf(r.stageId);
    expect(shapeByName(r, after)).toEqual(shapeByName(r, before));
    const [d] = await sql<{ schedule_locked: boolean; status: string }[]>`select schedule_locked, status from divisions where id = ${r.divisionId}`;
    expect([d!.schedule_locked, d!.status]).toEqual([true, "active"]);
  }, 120_000);

  it("(a2) several newcomers all wait, each once, in one Start", async () => {
    const r = await koRig(5);
    const late = [await r.add("P6"), await r.add("P7")];
    await freeze(r);
    await startDivision(r.auth, r.divisionId);
    expect(await waitingOf(r.divisionId)).toEqual([...late].sort());
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).length).toBe(2);
  }, 120_000);

  it("(b) a withdrawal before Start is reconciled on a frozen board EXACTLY as on an unfrozen one - the line becomes a bye for the stayer", async () => {
    const frozen = await koRig(8);
    const open = await koRig(8);
    // the same seat withdraws in each rig (the first real first-round line's away seat)
    for (const r of [frozen, open]) {
      const line = realLine(await linesOf(r.stageId));
      await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    }
    expect(firstRoundSeats(await linesOf(frozen.stageId)).length, "premise: the withdrawn entrant still sits on the line").toBe(8);
    await freeze(frozen);

    await startDivision(frozen.auth, frozen.divisionId);
    await startDivision(open.auth, open.divisionId);
    const frozenLines = await linesOf(frozen.stageId);
    expect(shapeByName(frozen, frozenLines)).toEqual(shapeByName(open, await linesOf(open.stageId)));
    // the line really changed: a bye now, nobody withdrawn on a match still to be played
    expect(frozenLines.filter((l) => l.round_no === 1 && l.status === "scheduled" && l.home_entrant_id !== null && l.away_entrant_id !== null).length).toBe(3);
    expect(firstRoundSeats(frozenLines).length).toBe(7);
    expect(await waitingOf(frozen.divisionId)).toEqual([]);
  }, 180_000);

  it("(c) no drift on a frozen board: Start changes no line and marks nobody", async () => {
    const r = await koRig(6);
    const before = await linesOf(r.stageId);
    await freeze(r);
    const out = await startDivision(r.auth, r.divisionId);
    expect([out.started, out.generated]).toEqual([true, 0]);
    expect(shapeByName(r, await linesOf(r.stageId))).toEqual(shapeByName(r, before));
    expect(await waitingOf(r.divisionId)).toEqual([]);
  }, 120_000);

  it("(d) the sequence: a newcomer, then withdrawn before Start - not waiting, and Start is clean", async () => {
    const r = await koRig(6);
    const late = await r.add("P7");
    await withdrawEntrantCascade(r.auth, late);
    await freeze(r);
    await startDivision(r.auth, r.divisionId);
    expect(await waitingOf(r.divisionId)).toEqual([]);
    expect(await listKnockoutWaiting(r.auth, r.divisionId)).toEqual([]);
    expect(firstRoundSeats(await linesOf(r.stageId))).not.toContain(late);
  }, 120_000);

  it("(e) both at once: the departed entrant's line becomes a bye and the newcomer waits", async () => {
    const r = await koRig(8);
    const line = realLine(await linesOf(r.stageId));
    await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
    const late = await r.add("P9");
    await freeze(r);
    await startDivision(r.auth, r.divisionId);
    expect(await waitingOf(r.divisionId)).toEqual([late]);
    const after = await linesOf(r.stageId);
    expect(firstRoundSeats(after)).not.toContain(late);
    expect(firstRoundSeats(after)).not.toContain(line.home_entrant_id);
  }, 120_000);

  it("(f) a drift only a redraw can fix is refused on a frozen board with the FROZEN code (unfreeze first), not KO_START_NEEDS_UPDATE_DRAW - and nothing is left marked", async () => {
    const r = await koRig(8);
    const line = realLine(await linesOf(r.stageId));
    await withdrawEntrantCascade(r.auth, line.home_entrant_id!);
    await withdrawEntrantCascade(r.auth, line.away_entrant_id!);
    await r.add("P9");
    await freeze(r);
    const before = await linesOf(r.stageId);
    await expect(startDivision(r.auth, r.divisionId)).rejects.toMatchObject({ status: 409, code: "KO_START_NEEDS_UPDATE_DRAW_FROZEN" });
    expect(await divisionStatus(r.divisionId)).toBe("setup");
    expect(await waitingOf(r.divisionId), "a refused Start writes nothing").toEqual([]);
    expect(shapeByName(r, await linesOf(r.stageId))).toEqual(shapeByName(r, before));
  }, 120_000);

  it("(g) review I2: a departed BYE HOLDER on a frozen board - Start refuses KO_START_NEEDS_UPDATE_DRAW_FROZEN, never the plain code, and the division stays in setup", async () => {
    const r = await koRig(6);
    const bye = (await linesOf(r.stageId)).find((l) => l.round_no === 1 && l.status === "forfeited")!;
    const holder = (bye.home_entrant_id ?? bye.away_entrant_id)!;
    await withdrawEntrantCascade(r.auth, holder);
    await freeze(r);
    const err = await startDivision(r.auth, r.divisionId).then(() => null, (e: unknown) => e as { status: number; code: string });
    expect(err, "Start refused").not.toBeNull();
    expect([err!.status, err!.code]).toEqual([409, "KO_START_NEEDS_UPDATE_DRAW_FROZEN"]);
    expect(await divisionStatus(r.divisionId)).toBe("setup");
  }, 120_000);

  it("(h) review I1: a frozen Start refused AFTER the reconcile (rolling rounds with no times) leaves nothing marked; unfreeze, Start again - the newcomer is SEATED and not waiting", async () => {
    const r = await koRig(6);
    // a settings row with roundMinutes, so the frozen Start's rolling-times sweep has rounds to write and refuses
    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${r.divisionId}, ${sql.json({ startAt: at(DAY, "08:00"), matchMinutes: 30, gapMinutes: 0, courts: [], roundMinutes: 60, blackouts: [], sessionWindows: [], constraints: { restMin: 20, noBackToBack: false, startWindows: [], fieldFairness: "off", parallelism: "mixed", crossPersonClash: "warn", hard: [] } })}, ${"UTC"}, now())
      on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
    const late = await r.add("P7");
    await freeze(r);
    await expect(startDivision(r.auth, r.divisionId)).rejects.toMatchObject({ status: 422, code: SCHEDULE_LOCKED_CODE });
    expect(await divisionStatus(r.divisionId)).toBe("setup");
    expect(await waitingOf(r.divisionId), "the refused Start wrote no mark").toEqual([]);
    await setDivisionLocks(r.auth, r.divisionId, { schedule_locked: false });
    await startDivision(r.auth, r.divisionId);
    expect(firstRoundSeats(await linesOf(r.stageId))).toContain(late);
    expect(await waitingOf(r.divisionId)).toEqual([]);
    expect(await listKnockoutWaiting(r.auth, r.divisionId)).toEqual([]);
  }, 180_000);

  it("(i) review I1 defensive: a seated entrant carrying a stale waiting mark is cleared by the next pre-Start reconcile", async () => {
    const r = await koRig(6);
    const late = await r.add("P7");
    await sql`update entrants set knockout_waiting_stage_id = ${r.stageId} where id = ${late}`; // a mark from an earlier refused Start
    await startDivision(r.auth, r.divisionId); // unfrozen: seats the newcomer in a bye
    expect(firstRoundSeats(await linesOf(r.stageId))).toContain(late);
    expect(await waitingOf(r.divisionId)).toEqual([]);
  }, 120_000);

  it("(j) review m1: a drift that REACHES the frozen branch with an active and a withdrawn newcomer - only the active one is marked", async () => {
    const r = await koRig(6);
    const live = await r.add("P7");
    const gone = await r.add("P8");
    await withdrawEntrantCascade(r.auth, gone);
    await freeze(r);
    await startDivision(r.auth, r.divisionId);
    expect(await waitingOf(r.divisionId)).toEqual([live]);
  }, 120_000);
});
