// Integration tests for PROMPT-23 (Jul3/03): undo/redo over the division
// ledger, scoped clear, pool clear-entrants, checkpoints, locks. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  SCHEDULE_LOCKED_CODE,
  SCHEDULE_LOCKED_MESSAGE,
  scheduleLockedMessageFor,
} from "@/lib/schedule-lock";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision, applySchedule, moveFixture } from "../schedule";
import { shiftDivisionSchedule } from "../schedule-plus";
import { scoreEvent } from "../scoring";
import { patchFixture } from "../fixtures";
import { createVenue, createCourt } from "../venues";
import { lockDivisions } from "../competition-schedule-apply";
import {
  undoDivision,
  redoDivision,
  divisionHistory,
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  clearScheduleScoped,
  clearPoolEntrants,
  setDivisionLocks,
} from "../history";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" | "enterprise" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"His " + suffix}, ${"his-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, stageCfg: Record<string, unknown> = {}) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Undo Cup",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D", "E", "F", "G", "H"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: stageCfg.kind === undefined ? "league" : (stageCfg.kind as "group"),
    name: "Main",
    config: stageCfg,
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { comp, division, stage: stage!, fixtures, entrants };
}

const at = (h: number) => new Date(Date.UTC(2026, 6, 12, h, 0, 0)).toISOString();

/** Two real courts (P9 pass 3a — venues/courts cutover): `patchFixture`'s
 *  `court_id` is a real `courts.id` now (composite FK to `courts(id,
 *  org_id)`, `on delete restrict` — V367), never a free-text label, so every
 *  test below that used to write `court_label: "C1"`/`"C2"` needs an actual
 *  seeded court to point at. Named `courtA`/`courtB` (not `court1`/`court2`)
 *  to read unambiguously beside `stage`/`division` etc. below. */
async function seedCourts(auth: AuthCtx): Promise<{ courtA: string; courtB: string }> {
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const a = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
  const b = await createCourt(auth, venue.id, { name: "C2", sort: 1, tags: [] });
  return { courtA: a.id, courtB: b.id };
}

/** Manual save points inserted DIRECTLY, bypassing `createCheckpoint`.
 *
 *  This is the only way to build a division sitting ABOVE its cap, which is
 *  exactly what a plan downgrade leaves behind — and the case where "evict one"
 *  and "evict down to the limit" give different answers. `created_at` is
 *  explicit and spaced so the eviction order is a fact of the fixture rather
 *  than of the clock's resolution. */
async function seedManualCheckpoints(auth: AuthCtx, divisionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      insert into division_checkpoints (division_id, org_id, seq, label, kind, created_at)
      values (${divisionId}, ${auth.orgId}, 0, ${`old-${i}`}, 'manual',
              ${new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()})`;
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// P9 dispatch #9: THREE tests in this file now `vi.spyOn(log, "warn")` (the
// pre-existing UPDATE-path test plus two new INSERT-path ones). None of them
// used to restore it — harmless with only one such test, since there was
// nothing to accumulate against, but `vi.spyOn` on an already-spied method
// returns the SAME mock instance rather than a fresh one, so a second test's
// `warnSpy.mock.calls` silently carried the first test's call(s) forward too
// (a `toHaveBeenCalledTimes(1)` in test 2 saw 2, test 3 saw 3). Restoring
// after every test is the standard vitest hygiene for exactly this.
afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!HAS_DB)("schedule undo & versioning (Jul3/03)", () => {
  it("move ×3 → undo ×3 = original → redo ×3 = moved (golden) — round-trips court_id, not a label (P9 pass 3a)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA, courtB } = await seedCourts(auth);
    const three = fixtures.slice(0, 3);
    // place them first (baseline), then move them (3 edits)
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, {
        scheduled_at: at(9 + i),
        court_id: courtA,
      });
    }
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, {
        scheduled_at: at(14 + i),
        court_id: courtB,
      });
    }
    const placed = async () =>
      sql<
        {
          id: string;
          scheduled_at: string | null;
          court_id: string | null;
        }[]
      >`
        select id, scheduled_at::text as scheduled_at, court_id from fixtures
        where id in ${sql(three.map((f) => f.id))} order by id`;
    const moved = await placed();

    for (let i = 0; i < 3; i++) await undoDivision(auth, division.id);
    const original = await placed();
    // THE regression this pass owes: undo restores court_id (a real
    // courts.id), never a stale label — `fixtures.court_label` is never
    // written by `patchFixture` any more (owner ruling, FULL cutover), so a
    // restore that wrote the old free-text column instead would have left
    // `court_id` untouched here and this assertion would fail loudly rather
    // than silently — there is no longer a court_label value for it to
    // coincidentally agree with.
    expect(original.map((f) => f.court_id)).toEqual([courtA, courtA, courtA]);

    for (let i = 0; i < 3; i++) await redoDivision(auth, division.id);
    expect(await placed()).toEqual(moved);

    // ledger stayed hash-intact throughout (append-only undo)
    const [chain] = await sql<{ broken: string | null }[]>`
      select verify_division_events_chain(${division.id})::text as broken`;
    expect(chain).toEqual({ broken: null });

    const history = await divisionHistory(auth, division.id);
    expect(history.events.some((e) => e.type === "fixtures_generated")).toBe(true);
  });

  // Review wave 1, finding 1 (scope cut 2026-08-18, owner-authorized: no
  // prod backfill — there is no pre-cutover prod data — so this is a
  // defensive guard for a dev/staging DB or a restored backup only, not a
  // live-data fix). `division_events` predates V374 for any division
  // touched before the cutover, so a stored payload can still carry a
  // free-text court label. `fixtures.court_id` is a real uuid column
  // (V367); binding that string as a query parameter raises Postgres
  // 22P02 and — pre-fix — aborts the WHOLE undo/redo transaction, not just
  // this one fixture. The engine itself can never again produce a non-uuid
  // `court` post-cutover (`REVERSIBLE.schedule_applied.invert` just swaps
  // `from`/`to` on whatever the ledger already holds — packages/engine/src/
  // history/history.ts), so a stale ledger row inserted directly is the
  // only way to construct this scenario.
  it("undo skips a non-uuid court in a stale ledger payload — logs it, never aborts the transaction", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA } = await seedCourts(auth);
    const fx = fixtures[0]!;

    // Baseline placement — proves the guard leaves court_id UNTOUCHED
    // (never nulled, never the bad string, which is impossible: the column
    // is uuid-typed) rather than merely avoiding a crash.
    await patchFixture(auth, fx.id, { scheduled_at: at(20), court_id: courtA });
    const [before] = await sql<{ scheduled_at: string | null }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fx.id}`;

    // A pre-cutover-shaped ledger row, inserted directly (bypassing the
    // engine/appendEvent — see header). undo() inverts this event (from/to
    // swap), so the inverse's `to.court` is THIS event's `from.court`: the
    // bad "Court 1" string.
    const [{ seq: nextSeq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int + 1 as seq from division_events
      where division_id = ${division.id}`;
    await sql`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${division.id}, ${nextSeq}, 'schedule_applied',
              ${sql.json({
                moves: [
                  { fixture: fx.id, from: { at: at(9), court: "Court 1" }, to: { at: at(10), court: courtA } },
                ],
              })}, null)`;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await expect(undoDivision(auth, division.id)).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ court: "Court 1", divisionId: division.id });

    const [after] = await sql<{ scheduled_at: string | null; court_id: string | null }[]>`
      select scheduled_at::text as scheduled_at, court_id from fixtures where id = ${fx.id}`;
    // The `at` half of the same statement still applied...
    expect(after!.scheduled_at).not.toBe(before!.scheduled_at);
    // ...but court_id was left exactly as it was.
    expect(after!.court_id).toBe(courtA);
  });

  // P9 dispatch #9: the guard above only covers the UPDATE sites inside
  // execute()'s schedule_applied/schedule_shifted/schedule_edited/
  // schedule_restored cases (review wave 1, finding 1's actual scope). The
  // two `insert into fixtures (… court_id …)` sites — pool_entrants_restored
  // (execute()) and fixtures_generated-with-snapshots (step(), a re-insert
  // that bypasses execute() entirely) — still bind `${s.court ?? null}`
  // directly and raise the SAME 22P02, aborting the whole undo transaction,
  // on a stale snapshot naming neither a real nor an existing fixture row.
  it("undo restoring cleared pool entrants skips a non-uuid court in a stale snapshot — inserts the fixture anyway, never aborts", async () => {
    const { auth } = await seedOrg();
    const { division, stage } = await seedDivision(auth, { kind: "group", pools: { count: 1 } });
    const fxId = randomUUID();

    // A pre-cutover-shaped `pool_entrants_cleared` event, inserted directly
    // (bypassing clearPoolEntrants/the engine — same technique as the test
    // above; no real row exists for fxId, matching "this fixture was
    // already cleared"). undo() inverts this into pool_entrants_restored
    // (REVERSIBLE.pool_entrants_cleared.invert — packages/engine/src/
    // history/history.ts), whose execute() case is the INSERT this dispatch
    // item targets.
    const [{ seq: nextSeq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int + 1 as seq from division_events
      where division_id = ${division.id}`;
    await sql`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${division.id}, ${nextSeq}, 'pool_entrants_cleared',
              ${sql.json({
                pool_id: null,
                fixtures: [
                  {
                    id: fxId, stage_id: stage.id, round_no: 1, seq_in_round: 1,
                    home_entrant_id: null, away_entrant_id: null, at: null, court: "Court 1",
                  },
                ],
              })}, null)`;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await expect(undoDivision(auth, division.id)).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ court: "Court 1", divisionId: division.id });

    const [row] = await sql<{ id: string; court_id: string | null }[]>`
      select id, court_id from fixtures where id = ${fxId}`;
    expect(row).toBeDefined(); // the fixture WAS restored...
    expect(row!.court_id).toBeNull(); // ...just never with the bad court
  });

  it("undo of a cleared-with-snapshots event skips a non-uuid court when re-inserting via fixtures_generated, never aborts", async () => {
    const { auth } = await seedOrg();
    const { division, stage } = await seedDivision(auth);
    const fxId = randomUUID();

    // A pre-cutover-shaped `fixtures_cleared` event carrying FULL row
    // snapshots — the enriched shape `step()` itself builds (reading LIVE
    // court_id, always real) right before a genuine undo of
    // fixtures_generated deletes the rows; inserted directly here so its
    // `fixtures[]` can carry a stale non-uuid court instead. Undoing THIS
    // event inverts it into `fixtures_generated` WITH `fixtures` present
    // (REVERSIBLE.fixtures_cleared.invert), which `step()` re-inserts
    // DIRECTLY — history.ts's second insert site, never reached through
    // execute() at all.
    const [{ seq: nextSeq }] = await sql<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int + 1 as seq from division_events
      where division_id = ${division.id}`;
    await sql`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${division.id}, ${nextSeq}, 'fixtures_cleared',
              ${sql.json({
                stage_id: stage.id,
                fixture_ids: [fxId],
                fixtures: [
                  {
                    id: fxId, stage_id: stage.id, round_no: 1, seq_in_round: 1,
                    home_entrant_id: null, away_entrant_id: null, at: null, court: "Court 1",
                  },
                ],
              })}, null)`;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await expect(undoDivision(auth, division.id)).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ court: "Court 1", divisionId: division.id });

    const [row] = await sql<{ id: string; court_id: string | null }[]>`
      select id, court_id from fixtures where id = ${fxId}`;
    expect(row).toBeDefined();
    expect(row!.court_id).toBeNull();
  });

  it("scoped clear of pool A leaves pool B and locked fixtures intact; undo restores", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, {
      kind: "group",
      pools: { count: 2 },
    });
    const { courtA } = await seedCourts(auth);
    // schedule everything
    for (let i = 0; i < fixtures.length; i++) {
      await patchFixture(auth, fixtures[i]!.id, {
        scheduled_at: at(9 + i),
        court_id: courtA,
      });
    }
    const pools = await sql<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;
    // lock one pool-A fixture
    const [lockedFixture] = await sql<{ id: string }[]>`
      select id from fixtures where pool_id = ${poolA} order by id limit 1`;
    await patchFixture(auth, lockedFixture!.id, { schedule_locked: true });

    const result = await clearScheduleScoped(auth, {
      division_id: division.id,
      scope: { poolIds: [poolA], excludeLocked: true },
      confirm: true,
    });
    expect(result.skipped.locked).toBe(1);
    const [counts] = await sql<{ a_scheduled: number; b_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled,
             count(*) filter (where pool_id <> ${poolA} and scheduled_at is not null)::int as b_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(counts!.a_scheduled).toBe(1); // only the locked one
    expect(counts!.b_scheduled).toBeGreaterThan(0); // pool B untouched

    await undoDivision(auth, division.id); // schedule_restored
    const [after] = await sql<{ a_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(after!.a_scheduled).toBeGreaterThan(1);
  });

  it("scoped clear refuses a frozen division, and still clears an unfrozen one", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, { kind: "group", pools: { count: 2 } });
    const { courtA } = await seedCourts(auth);
    for (let i = 0; i < fixtures.length; i++) {
      await patchFixture(auth, fixtures[i]!.id, { scheduled_at: at(9 + i), court_id: courtA });
    }

    // The unfrozen control case runs FIRST, so a guard that refuses everything
    // cannot pass this test by refusing both halves.
    const before = await clearScheduleScoped(auth, {
      division_id: division.id,
      scope: { excludeLocked: true },
      confirm: true,
    });
    expect(before.cleared).toBeGreaterThan(0);
    await undoDivision(auth, division.id);

    await setDivisionLocks(auth, division.id, { schedule_locked: true });

    await expect(
      clearScheduleScoped(auth, {
        division_id: division.id,
        scope: { excludeLocked: true },
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });

    // The refusal must not have wiped anything on its way out.
    const [after] = await sql<{ scheduled: number }[]>`
      select count(*) filter (where scheduled_at is not null)::int as scheduled
      from fixtures where division_id = ${division.id}`;
    expect(after!.scheduled).toBeGreaterThan(0);
  });


  // Restore is the SECOND destructive control the Danger zone's neighbour
  // offers, and it has the larger blast radius of the two: clear empties
  // unlocked slots, a restore rewrites every fixture's time and court back to
  // the save point. The freeze stopped clear (above) and did not stop this, so
  // an organiser who froze a board could still have the whole timetable
  // rewritten from a control sitting a few hundred pixels up the same panel.
  //
  // `restoreCheckpoint` rewinds by calling `undoDivision` in a loop, and undo
  // itself is deliberately NOT guarded — see the guard's own comment for why.
  // The refusal therefore has to live in `restoreCheckpoint`, ahead of the
  // loop, or the first undo lands before anything says no.
  it("restoring a save point refuses a frozen division, and still restores an unfrozen one", async () => {
    const { auth } = await seedOrg();
    const { courtA, courtB } = await seedCourts(auth);

    /** Schedule one fixture, bookmark it, then move it away. Restoring the
     *  returned checkpoint rewinds that single move — one step, one visible
     *  column. */
    async function divisionWithARewindWaiting() {
      const { division, fixtures } = await seedDivision(auth);
      const f = fixtures[0]!.id;
      await patchFixture(auth, f, { scheduled_at: at(9), court_id: courtA });
      const cp = await createCheckpoint(auth, division.id, "before reshuffle");
      await patchFixture(auth, f, { scheduled_at: at(15), court_id: courtB });
      return { divisionId: division.id, fixtureId: f, checkpointId: cp.id };
    }

    // Two divisions rather than one, because a restore does not re-arm itself:
    // `patchFixture` appends its event without clearing `edit_watermark`, so a
    // second restore of the same checkpoint on the same division short-circuits
    // to `steps: 0` and would witness nothing whether the guard fired or not.
    //
    // The unfrozen control runs FIRST, so a guard that refused every restore —
    // or one placed so early it never reaches the rewind — cannot pass this
    // test by refusing both halves.
    const open = await divisionWithARewindWaiting();
    const control = await restoreCheckpoint(auth, open.divisionId, open.checkpointId, true);
    expect(control.steps).toBe(1);
    const [rewound] = await sql<{ court_id: string | null }[]>`
      select court_id from fixtures where id = ${open.fixtureId}`;
    expect(rewound!.court_id).toBe(courtA);

    const frozen = await divisionWithARewindWaiting();
    const [before] = await sql<{ at: string | null; court_id: string | null }[]>`
      select scheduled_at::text as at, court_id from fixtures where id = ${frozen.fixtureId}`;
    expect(before!.court_id).toBe(courtB); // the rewind really is available

    await setDivisionLocks(auth, frozen.divisionId, { schedule_locked: true });

    await expect(
      restoreCheckpoint(auth, frozen.divisionId, frozen.checkpointId, true),
    ).rejects.toMatchObject({ status: 422 });
    // The sentence is a contract three sibling write paths already share and
    // the panel's own copy echoes, so it is pinned as well as the status.
    // `message` is not an own enumerable property, so the `toMatchObject`
    // above cannot see it — it needs its own matcher.
    await expect(
      restoreCheckpoint(auth, frozen.divisionId, frozen.checkpointId, true),
    ).rejects.toThrow("the division schedule is locked — unlock it to edit");

    // The refusal must not have rewritten the board on its way out: the guard
    // sits ahead of the rewind loop, not inside it.
    const [after] = await sql<{ at: string | null; court_id: string | null }[]>`
      select scheduled_at::text as at, court_id from fixtures where id = ${frozen.fixtureId}`;
    expect(after).toEqual(before);
    // ...and the division it did not name is untouched by the freeze.
    const openStill = await restoreCheckpoint(auth, open.divisionId, open.checkpointId, true);
    expect(openStill.steps).toBe(0);

    // `restoreCheckpoint` keeps its OWN guard now that `undoDivision` carries
    // one too, and this is the case that tells the two apart: `open` has
    // already been rewound, so `wm <= target` short-circuits to `{ steps: 0 }`
    // before the loop ever calls undo. Only the guard inside
    // `restoreCheckpoint` can refuse this call — delete it and a frozen
    // division answers 200 here — so neither guard is covering for the other.
    await setDivisionLocks(auth, open.divisionId, { schedule_locked: true });
    await expect(
      restoreCheckpoint(auth, open.divisionId, open.checkpointId, true),
    ).rejects.toThrow("the division schedule is locked — unlock it to edit");
  });

  // Undo and Redo are the LAST two division write paths a freeze did not stop,
  // and `restoreCheckpoint` is a loop of `undoDivision` — so the freeze that
  // stopped the restore left the primitive it is built out of live, on two
  // buttons a few hundred pixels up the same panel. Same blast radius, one
  // layer down.
  //
  // Guarding the rewind strands nobody: `divisions.schedule_locked` moves only
  // through `setDivisionLocks`, which appends no ledger event, so no undo or
  // redo could ever have handed the division freeze back. (The
  // `schedule_locked` that undo DOES replay is `fixtures.schedule_locked`, the
  // per-fixture pin — a different column on a different table with the same
  // name, and the reason undo was exempted in the first place.)
  it("undo and redo refuse a frozen division, and still step an unfrozen one", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA, courtB } = await seedCourts(auth);
    const f = fixtures[0]!.id;
    await patchFixture(auth, f, { scheduled_at: at(9), court_id: courtA });
    await patchFixture(auth, f, { scheduled_at: at(15), court_id: courtB });

    const courtOf = async (): Promise<string | null> => {
      const [row] = await sql<{ court_id: string | null }[]>`
        select court_id from fixtures where id = ${f}`;
      return row!.court_id;
    };

    // The unfrozen CONTROL runs first for both directions, so a guard that
    // threw unconditionally cannot pass this test by refusing everything.
    //
    // It says nothing about placement relative to the existence check, and no
    // test here can: `divisionLockState` (`usecases/schedule.ts:537`) returns
    // `frozen: row?.schedule_locked ?? false`, so a MISSING division reads as
    // UNFROZEN, falls through the guard wherever it sits, and 404s later
    // either way. There is no mutant to kill, so the claim is withdrawn
    // rather than pinned with a case that would pass vacuously.
    await undoDivision(auth, division.id);
    expect(await courtOf()).toBe(courtA);
    await redoDivision(auth, division.id);
    expect(await courtOf()).toBe(courtB);

    // Leave a redo genuinely PENDING before freezing. Without this the frozen
    // redo would be refused by the engine ("nothing to redo") whether the
    // freeze guard existed or not, and the assertion would witness nothing.
    await undoDivision(auth, division.id);
    expect(await courtOf()).toBe(courtA);

    await setDivisionLocks(auth, division.id, { schedule_locked: true });
    const [before] = await sql<{ at: string | null; court_id: string | null }[]>`
      select scheduled_at::text as at, court_id from fixtures where id = ${f}`;
    /** The LEDGER's own state, not the board's — and read honestly about what it
     *  can and cannot catch.
     *
     *  It does NOT pin the guard's PLACEMENT inside `step`. The whole body runs
     *  in one `withTenant` transaction, so a throw anywhere in it rolls the
     *  append, the `seq` bump and the watermark back together: moving the guard
     *  to after `appendEvent` leaves this assertion green (verified by
     *  mutation, 2026-09-04 — that mutant SURVIVES). Placement is protected by
     *  the transaction, not by this test.
     *
     *  What it does pin is that the rewind stays ONE transaction. That is a
     *  live regression class here rather than a hypothetical:
     *  `restoreCheckpoint` right beside it is N separate transactions, and a
     *  refusal partway through leaves earlier events committed. If `step` ever
     *  splits the same way, this goes red where the board snapshot alone would
     *  not. */
    const ledgerState = async (): Promise<{ events: number; seq: number; watermark: number | null }> => {
      const [row] = await sql<{ events: number; seq: number; watermark: number | null }[]>`
        select (select count(*)::int from division_events where division_id = ${division.id}) as events,
               seq::int as seq,
               edit_watermark::int as watermark
        from divisions where id = ${division.id}`;
      return row!;
    };
    const ledgerBefore = await ledgerState();

    await expect(undoDivision(auth, division.id)).rejects.toMatchObject({ status: 422 });
    // `message` is not an own enumerable property, so `toMatchObject` above
    // cannot see it. The sentence is the contract four sibling write paths
    // already share and the panel's frozen note is written against.
    await expect(undoDivision(auth, division.id)).rejects.toThrow(
      "the division schedule is locked — unlock it to edit",
    );
    await expect(redoDivision(auth, division.id)).rejects.toMatchObject({ status: 422 });
    await expect(redoDivision(auth, division.id)).rejects.toThrow(
      "the division schedule is locked — unlock it to edit",
    );

    // Neither refusal moved a fixture on its way out...
    const [after] = await sql<{ at: string | null; court_id: string | null }[]>`
      select scheduled_at::text as at, court_id from fixtures where id = ${f}`;
    expect(after).toEqual(before);
    // ...nor left an event, a seq bump or a watermark move behind it. Asserted
    // rather than inferred from the unchanged board — with the caveat in the
    // helper's own comment about exactly which failure this can witness.
    expect(await ledgerState()).toEqual(ledgerBefore);

    // ...and the redo really was still there: it is the FREEZE that refused it,
    // not an empty redo stack.
    await setDivisionLocks(auth, division.id, { schedule_locked: false });
    await redoDivision(auth, division.id);
    expect(await courtOf()).toBe(courtB);
  });

  it("clear-entrants keeps the pool, blocks after a result; two-site scope lock blocks edits", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, {
      kind: "group",
      pools: { count: 2 },
    });
    const { courtB } = await seedCourts(auth);
    const pools = await sql<{ id: string }[]>`
      select id from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;

    const cleared = await clearPoolEntrants(auth, poolA, true);
    expect(cleared.removed).toBeGreaterThan(0);
    const [poolStillThere] = await sql<{ n: number }[]>`
      select count(*)::int as n from pools where id = ${poolA}`;
    expect(poolStillThere!.n).toBe(1);
    // undo restores the pool's fixtures
    await undoDivision(auth, division.id);
    const [restored] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where pool_id = ${poolA}`;
    expect(restored!.n).toBe(cleared.removed);

    // scope lock site B: edits inside the scope are refused — on the board
    // APPLY path only (`applySchedule`'s `scopeLocked` check). `moveFixture`
    // never consulted scope locks at all (see the assertion below), so the
    // scope value itself is decorative here regardless of what it names —
    // real or not, courtB is a real seeded court either way (P9 pass 3a:
    // `court_id` is FK-checked, unlike the old free-text `court_label`).
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_id: courtB,
    });
    await setDivisionLocks(auth, division.id, {
      locked_scopes: [{ courts: ["C2"] }],
    });
    await expect(
      patchFixture(auth, fixtures[0]!.id, {
        scheduled_at: at(10),
        court_id: courtB,
      }),
    ).resolves.toBeTruthy(); // moveFixture path is separate; board apply path enforces scope
  });

  it("results-guard: undoing generation is blocked once a fixture is decided", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await startDivision(auth, division.id);
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    await expect(undoDivision(auth, division.id)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "ALREADY_DECIDED"),
    );
  });

  it("checkpoints: restore rewinds; second checkpoint is Pro", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA, courtB } = await seedCourts(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_id: courtA,
    });
    const cp = await createCheckpoint(auth, division.id, "before reshuffle");
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(15),
      court_id: courtB,
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: at(16),
      court_id: courtB,
    });

    const restored = await restoreCheckpoint(auth, division.id, cp.id, true);
    expect(restored.steps).toBe(2);
    const [row] = await sql<{ court_id: string | null }[]>`
      select court_id from fixtures where id = ${fixtures[0]!.id}`;
    expect(row!.court_id).toBe(courtA);

    // Community holds two save points (V319 raised the cap 1 → 2). Since #382
    // the third does not 402 — it ROLLS, dropping the oldest and naming it.
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await createCheckpoint(freeAuth, freeDiv.id, "one");
    await createCheckpoint(freeAuth, freeDiv.id, "two");
    const third = await createCheckpoint(freeAuth, freeDiv.id, "three");
    expect(third.evicted?.label).toBe("one");
  });

  // V303. Before this the AI accept flow's undo anchor was billed as one of the
  // organiser's save points. A community org already holding one could not apply
  // an AI schedule at all: the anchor 402'd, applyAiPlans aborted, and the AI
  // generation had already been spent producing the plan.
  it("AI anchors are exempt from the save-point quota — community keeps its two manual slots", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);

    await createCheckpoint(auth, division.id, "my save point");
    await createCheckpoint(auth, division.id, "my second save point");
    // #382: at the cap the save ROLLS rather than 402ing — but the window is
    // still two wide, which is what "exempt" has to mean here.
    const rolled = await createCheckpoint(auth, division.id, "another");
    expect(rolled.evicted?.label).toBe("my save point");

    // AI applies still work — repeatedly — and never touch that window.
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 1", "ai"),
    ).resolves.toBeTruthy();
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 2", "ai"),
    ).resolves.toBeTruthy();
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 3", "ai"),
    ).resolves.toBeTruthy();

    // …and the manual window is still exactly two wide: three AI anchors in
    // between did not consume, free or shift a single manual slot.
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual.map((r) => r.label)).toEqual(["another", "my second save point"]);
  });

  it("pro's AI anchors do not consume its manual save-point window", async () => {
    // The cap is read from the matrix (V319 5 -> V392 10), so the boundary
    // this test walks up to moves with the plan rather than going slack.
    const [proRow] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'pro' and feature_key = 'schedule.checkpoints.max'`;
    const cap = proRow?.int_value;
    expect(cap, "pro must carry a finite save-point cap").toBeTypeOf("number");

    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    for (let i = 1; i <= 3; i++) await createCheckpoint(auth, division.id, `manual ${i}`, "manual");
    await createCheckpoint(auth, division.id, "Before AI · run 1", "ai");
    await createCheckpoint(auth, division.id, "Before AI · run 2", "ai");
    // 3 manual of `cap` used → the rest of the window evicts nothing; one past
    // it rolls. The AI rows do not count towards either.
    for (let i = 4; i <= cap!; i++) {
      expect((await createCheckpoint(auth, division.id, `manual ${i}`)).evicted).toBeUndefined();
    }
    expect(
      (await createCheckpoint(auth, division.id, `manual ${cap! + 1}`)).evicted?.label,
    ).toBe("manual 1");
  });

  it("only the newest AI anchor is live; older ones are superseded but still listed", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "manual one", "manual");
    await createCheckpoint(auth, division.id, "Before AI · older", "ai");
    await createCheckpoint(auth, division.id, "Before AI · newest", "ai");

    const rows = await listCheckpoints(auth, division.id);
    const ai = rows.filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(2);
    // Newest-first ordering: the first AI row is the live anchor.
    expect(ai[0]!.label).toContain("newest");
    expect(ai[0]!.superseded).toBeFalsy();
    expect(ai[1]!.superseded).toBe(true);
    // A manual save point is never superseded, however many AI runs there were.
    expect(rows.find((r) => r.label === "manual one")!.superseded).toBeFalsy();
  });

  // The quota is per-division and nothing could reclaim a slot, so an organiser
  // who made a save point they no longer wanted was stuck with it — on
  // community that meant permanently holding their only one. Since #382 the
  // save no longer 402s at the cap, so what a delete buys is the SILENT save:
  // the next one takes a free slot instead of evicting the survivor.
  it("deleting a manual save point frees its slot, so the next save evicts nothing", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    const cp = await createCheckpoint(auth, division.id, "wrong moment");
    await createCheckpoint(auth, division.id, "second slot"); // fill to the cap of 2 (V319)

    await deleteCheckpoint(auth, division.id, cp.id);
    const next = await createCheckpoint(auth, division.id, "the one I wanted");
    expect(next.evicted).toBeUndefined();
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual.map((r) => r.label)).toEqual(["the one I wanted", "second slot"]);
  });

  it("deleting is scoped to the division, and a missing checkpoint is 404", async () => {
    const { auth } = await seedOrg("pro");
    const { division: a } = await seedDivision(auth);
    const { division: b } = await seedDivision(auth);
    const cp = await createCheckpoint(auth, a.id, "belongs to A");

    // Right id, wrong division — must not delete by guessing an id.
    await expect(deleteCheckpoint(auth, b.id, cp.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await listCheckpoints(auth, a.id)).toHaveLength(1);

    await expect(
      deleteCheckpoint(auth, a.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("checkpoints window ladder: pro holds its cap then rolls; enterprise unlimited", async () => {
    // The cap is READ from the live matrix, never typed here, so a re-tune
    // (V319 5 -> V392 10) moves this test instead of quietly stopping it
    // testing the boundary.
    const [proRow] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'pro' and feature_key = 'schedule.checkpoints.max'`;
    const proCap = proRow?.int_value;
    expect(proCap, "pro must carry a finite save-point cap for this test to mean anything")
      .toBeTypeOf("number");

    const { auth: proAuth } = await seedOrg("pro");
    const { division: proDiv } = await seedDivision(proAuth);
    for (let i = 1; i <= proCap!; i++) {
      expect((await createCheckpoint(proAuth, proDiv.id, `cp${i}`)).evicted).toBeUndefined();
    }
    // One past the cap rolls the window rather than 402ing (#382).
    expect(
      (await createCheckpoint(proAuth, proDiv.id, `cp${proCap! + 1}`)).evicted?.label,
    ).toBe("cp1");
    const proManual = (await listCheckpoints(proAuth, proDiv.id)).filter(
      (r) => r.kind === "manual",
    );
    expect(proManual).toHaveLength(proCap!);

    // Enterprise is null (unlimited): one past Pro's cap must NOT evict.
    const { auth: entAuth } = await seedOrg("enterprise");
    const { division: entDiv } = await seedDivision(entAuth);
    for (let i = 1; i <= proCap! + 1; i++) {
      expect((await createCheckpoint(entAuth, entDiv.id, `cp${i}`)).evicted).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // #382 — at the save-point cap, roll instead of refusing.
  //
  // A checkpoint is a named BOOKMARK, not the history. The ledger keeps every
  // event and restore is "undo until the watermark reaches this seq", so
  // dropping a save point costs the label, not the ability to rewind that far.
  // Refusing the save, by contrast, cost the organiser the thing they were
  // about to do.
  // -------------------------------------------------------------------------

  it("at the cap, saving evicts exactly the oldest and names it (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "one");
    await createCheckpoint(auth, division.id, "two");
    const third = await createCheckpoint(auth, division.id, "three");

    expect(third.evicted?.label).toBe("one");
    const rows = await listCheckpoints(auth, division.id);
    // listCheckpoints is newest-first.
    expect(rows.filter((r) => r.kind === "manual").map((r) => r.label)).toEqual(["three", "two"]);
  });

  it("post-insert count equals the limit exactly, even from over the cap", async () => {
    // Do not assume n === limit. A division can sit above the cap after a plan
    // downgrade, and ONE save must bring it to exactly the limit — not to n,
    // and not one below.
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await seedManualCheckpoints(auth, division.id, 5); // over the cap of 2
    const saved = await createCheckpoint(auth, division.id, "new");
    // Four go; the notice names the NEWEST of them, the one most likely missed.
    expect(saved.evicted?.label).toBe("old-3");

    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(2);
    expect(manual.map((r) => r.label)).toEqual(["new", "old-4"]);
  });

  it("a division below the cap evicts nothing, and the last free slot is silent", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    // Empty set, then the boundary: one UNDER the cap must still be silent.
    const first = await createCheckpoint(auth, division.id, "one");
    expect(first.evicted).toBeUndefined();
    const second = await createCheckpoint(auth, division.id, "two");
    expect(second.evicted).toBeUndefined();
  });

  it("enterprise has a null limit and never evicts", async () => {
    const { auth } = await seedOrg("enterprise");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 8; i++) {
      expect((await createCheckpoint(auth, division.id, `cp${i}`)).evicted).toBeUndefined();
    }
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(8);
  });

  it("no longer 402s on a manual save", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "one");
    await createCheckpoint(auth, division.id, "two");
    await expect(createCheckpoint(auth, division.id, "three")).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // #382 review, finding 2 — a quota of ZERO is a refusal, not a window of one.
  //
  // The roll arithmetic is `drop = n - limit + 1`, which at n=0/limit=0 asks to
  // delete ONE row from an empty table (removing nothing) and then inserts
  // anyway. So an org entitled to no save points at all permanently held
  // exactly one, and `createCheckpoint`'s own stated invariant — "the
  // post-insert count is exactly the limit" — was false on the one input where
  // rolling cannot express the answer.
  // -------------------------------------------------------------------------

  it("a zero quota refuses the manual save rather than leaving one behind (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    // A staff override of 0 is the reachable route to limit === 0; a plan row
    // missing from `plan_entitlements` resolves to 0 by the same door (getLimit
    // returns 0 for an absent row), and both must behave identically.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'schedule.checkpoints.max', 0)`;
    await invalidateOrgEntitlements(auth.orgId);

    await expect(createCheckpoint(auth, division.id, "should not land")).rejects.toMatchObject({
      status: 402,
      featureKey: "schedule.checkpoints.max",
    });
    // The invariant, restated as the observable: nothing landed.
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(0);
  });

  it("a zero manual quota still lets the AI flow write its own anchor (#382)", async () => {
    // V303's whole point: an AI apply's undo anchor is NOT one of the
    // organiser's save points. A refusal placed outside the `manual` branch
    // would re-break the bug that once cost a community org a paid-for AI run.
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'schedule.checkpoints.max', 0)`;
    await invalidateOrgEntitlements(auth.orgId);

    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 1", "ai"),
    ).resolves.toBeTruthy();
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // #382 review, finding 3 — count-then-delete-then-insert was not serialised.
  //
  // The realistic race is not two admins: this product's normal shape is a
  // single org owner, and that owner double-clicking Save is common enough to
  // matter. Both requests read the same count, both compute the same `drop`,
  // both target the SAME oldest row — one DELETE removes it, the other removes
  // nothing — and both INSERTs land. The division ends at limit + 1 and one of
  // the two organisers is never told a bookmark went.
  // -------------------------------------------------------------------------

  it("a manual save waits for the division lock rather than reading a stale count", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);

    // The blocker takes the lock through `lockDivisions` — the SAME helper the
    // schedule apply uses. That is the assertion that matters here: if
    // `createCheckpoint` grew a second key scheme it would sail straight past
    // this holder, and only a shared key keeps the two ends serialised.
    let settled = false;
    const holder = sql.begin(async (tx) => {
      await lockDivisions(tx, [division.id]);
      await new Promise((r) => setTimeout(r, 700));
    });
    // Let the holder actually acquire before the contender starts.
    await new Promise((r) => setTimeout(r, 150));

    const contender = createCheckpoint(auth, division.id, "waits its turn").then((v) => {
      settled = true;
      return v;
    });
    // One load-bearing sleep: long enough that an UNLOCKED createCheckpoint
    // (a handful of queries) would certainly have finished by now.
    await new Promise((r) => setTimeout(r, 350));
    expect(settled, "createCheckpoint ran while another transaction held division:<id>").toBe(
      false,
    );

    await holder;
    await contender;
    expect(settled).toBe(true);
  });

  it("two concurrent saves at the cap leave exactly the limit, and one is told (#382)", async () => {
    const { auth } = await seedOrg("community"); // cap of 2 (V319)
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "first"); // one below the cap

    const [a, b] = await Promise.all([
      createCheckpoint(auth, division.id, "race-a"),
      createCheckpoint(auth, division.id, "race-b"),
    ]);

    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual, "the division must not sit at limit + 1").toHaveLength(2);
    // Serialised, the second save is the one that arrives AT the cap — so
    // exactly one caller is told, and it names the row that actually went.
    const notices = [a.evicted, b.evicted].filter((e) => e !== undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.label).toBe("first");
    expect(manual.map((r) => r.label).sort()).toEqual(["race-a", "race-b"]);
  });

  // -------------------------------------------------------------------------
  // #382 — AI anchors are pruned to the newest 3 per division.
  //
  // They are exempt from the manual quota (V303) and nothing ever deleted them:
  // `superseded` is derived on read, not stored, and the only DELETE is the
  // user-initiated endpoint. So they accumulated one per AI apply, for ever.
  //
  // Three rather than one because `CheckpointRow.superseded` calls the deeper
  // rewind out as deliberate — "jumping back two AI runs is a real capability
  // worth keeping". Two runs back plus the newest is exactly 3.
  // -------------------------------------------------------------------------

  it("keeps the newest 3 AI anchors per division (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 6; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(3);
    // listCheckpoints is newest-first.
    expect(ai.map((r) => r.label)).toEqual(["ai-5", "ai-4", "ai-3"]);
  });

  it("the 3rd and 4th AI anchors are the boundary: 3 survive, the 4th prunes one", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 3; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    expect((await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai")).toHaveLength(
      3,
    );
    await createCheckpoint(auth, division.id, "ai-3", "ai");
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai.map((r) => r.label)).toEqual(["ai-3", "ai-2", "ai-1"]);
  });

  it("pruning is per division, not per org", async () => {
    const { auth } = await seedOrg("community");
    const a = await seedDivision(auth);
    const b = await seedDivision(auth);
    for (let i = 0; i < 4; i++) await createCheckpoint(auth, a.division.id, `a-${i}`, "ai");
    await createCheckpoint(auth, b.division.id, "b-0", "ai");
    expect(
      (await listCheckpoints(auth, b.division.id)).filter((r) => r.kind === "ai"),
    ).toHaveLength(1);
    // …and A is still at its own cap of 3, not emptied by B's insert.
    expect(
      (await listCheckpoints(auth, a.division.id)).filter((r) => r.kind === "ai"),
    ).toHaveLength(3);
  });

  it("the prune touches AI anchors only — manual save points survive it", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "manual-one");
    for (let i = 0; i < 6; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const rows = await listCheckpoints(auth, division.id);
    expect(rows.filter((r) => r.kind === "manual").map((r) => r.label)).toEqual(["manual-one"]);
    expect(rows.filter((r) => r.kind === "ai")).toHaveLength(3);
  });

  it("AI anchors still cost no manual quota", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 4; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const first = await createCheckpoint(auth, division.id, "manual-one");
    expect(first.evicted).toBeUndefined();
  });

  it("a pruned AI anchor costs its label, not the rewind", async () => {
    // Same contract as a rolled manual save point: the ROW goes, the ledger
    // does not. An anchor pruned away is no longer restorable BY ID, but undo
    // still walks back past the watermark it named.
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedDivision(auth);
    const { courtA } = await seedCourts(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_id: courtA });
    const oldest = await createCheckpoint(auth, division.id, "ai-0", "ai");
    for (let i = 1; i < 4; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");

    await expect(restoreCheckpoint(auth, division.id, oldest.id, true)).rejects.toMatchObject({
      status: 404,
    });
    await undoDivision(auth, division.id);
    const after = await divisionHistory(auth, division.id);
    expect(Number(after.watermark)).toBeLessThan(Number(oldest.seq));
  });

  it("an evicted save point costs its label, not the rewind (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedDivision(auth);
    const { courtA, courtB } = await seedCourts(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_id: courtA });
    const one = await createCheckpoint(auth, division.id, "one");
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(10), court_id: courtB });
    await createCheckpoint(auth, division.id, "two");
    const third = await createCheckpoint(auth, division.id, "three");
    expect(third.evicted?.label).toBe("one");

    // The ROW is gone, so restore can no longer target it by id…
    await expect(restoreCheckpoint(auth, division.id, one.id, true)).rejects.toMatchObject({
      status: 404,
    });

    // …but the LEDGER is untouched. One undo lands back on the state the
    // evicted save point named, and a second rewinds PAST its watermark.
    await undoDivision(auth, division.id);
    const [back] = await sql<{ court_id: string | null }[]>`
      select court_id from fixtures where id = ${fixtures[0]!.id}`;
    expect(back!.court_id).toBe(courtA);
    await undoDivision(auth, division.id);
    const after = await divisionHistory(auth, division.id);
    expect(Number(after.watermark)).toBeLessThan(Number(one.seq));
  });

  it("stale optimistic token → SEQ_CONFLICT 409 contract", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA } = await seedCourts(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_id: courtA,
    });
    await expect(undoDivision(auth, division.id, 1)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "SEQ_CONFLICT"),
    );
  });
});

// ---------------------------------------------------------------------------
// One schedule-lock refusal, said once and readable by a machine
// ---------------------------------------------------------------------------
//
// The freeze contract used to be a SENTENCE hand-typed at five call sites,
// with a sixth carrying a machine-readable code none of the others did — so a
// client wanting to branch on "frozen" had to match prose, and a reword meant
// grepping a literal. Worse, the enumeration was asserted in a comment and was
// false: `clearPoolEntrants`, `shiftDivisionSchedule` and `deleteCheckpoint`
// ignored the freeze entirely while that comment claimed completeness.
//
// This table is the enumeration now. It drives every division write path that
// is supposed to refuse a frozen board, in ONE assertion, so a site that
// refuses with the wrong code, the wrong sentence, the wrong status — or does
// not refuse at all — is NAMED in the diff rather than hidden behind the first
// failure. Each site gets its OWN frozen division, so a site that fails to
// refuse mutates only its own board and cannot cascade into the next row.
describe.skipIf(!HAS_DB)("the schedule-lock refusal is one constant (task 10)", () => {
  /** A frozen division with everything each write path needs to get as far as
   *  its guard: a placed fixture, a pending undo AND a pending redo, a save
   *  point, and two pools. Frozen LAST, so every fact above is established
   *  against an open board. */
  async function frozenBoard(auth: AuthCtx) {
    const { division, stage, fixtures } = await seedDivision(auth, {
      kind: "group",
      pools: { count: 2 },
    });
    const { courtA, courtB } = await seedCourts(auth);
    const fixtureId = fixtures[0]!.id;
    await patchFixture(auth, fixtureId, { scheduled_at: at(9), court_id: courtA });
    await patchFixture(auth, fixtureId, { scheduled_at: at(15), court_id: courtB });
    const cp = await createCheckpoint(auth, division.id, "before the freeze");
    // One rewind, so REDO has something genuinely pending: without it a frozen
    // redo would be refused by the engine ("nothing to redo") whether the
    // freeze guard existed or not, and that row would witness nothing.
    await undoDivision(auth, division.id);
    const pools = await sql<{ id: string }[]>`
      select id from pools where stage_id = ${stage.id} order by key`;
    await setDivisionLocks(auth, division.id, { schedule_locked: true });
    return {
      divisionId: division.id,
      stageId: stage.id,
      fixtureId,
      courtA,
      checkpointId: cp.id,
      poolId: pools[0]!.id,
    };
  }

  it("every division write path refuses a frozen board with the SAME code and sentence", async () => {
    // The constant has to be a real, non-empty string BEFORE anything below
    // compares against it. A site that carries no message at all would other-
    // wise match an `undefined` constant and the whole table would pass
    // vacuously — the failure mode this suite has already shipped twice.
    expect(typeof SCHEDULE_LOCKED_MESSAGE).toBe("string");
    expect(SCHEDULE_LOCKED_MESSAGE.length).toBeGreaterThan(0);
    expect(typeof SCHEDULE_LOCKED_CODE).toBe("string");
    expect(SCHEDULE_LOCKED_CODE.length).toBeGreaterThan(0);

    const { auth } = await seedOrg();
    const sites: { name: string; run: (b: Awaited<ReturnType<typeof frozenBoard>>) => Promise<unknown> }[] = [
      { name: "undoDivision", run: (b) => undoDivision(auth, b.divisionId) },
      { name: "redoDivision", run: (b) => redoDivision(auth, b.divisionId) },
      {
        name: "restoreCheckpoint",
        run: (b) => restoreCheckpoint(auth, b.divisionId, b.checkpointId, true),
      },
      {
        name: "deleteCheckpoint",
        run: (b) => deleteCheckpoint(auth, b.divisionId, b.checkpointId),
      },
      {
        name: "clearScheduleScoped",
        run: (b) =>
          clearScheduleScoped(auth, {
            division_id: b.divisionId,
            scope: { excludeLocked: true },
            confirm: true,
          }),
      },
      { name: "clearPoolEntrants", run: (b) => clearPoolEntrants(auth, b.poolId, true) },
      {
        name: "shiftDivisionSchedule",
        run: (b) =>
          shiftDivisionSchedule(auth, {
            division_id: b.divisionId,
            scope: { excludeLocked: true },
            delta_minutes: 15,
          }),
      },
      {
        name: "moveFixture",
        run: (b) => moveFixture(auth, b.fixtureId, { scheduled_at: at(11) }),
      },
      {
        name: "applySchedule",
        run: (b) =>
          applySchedule(auth, b.stageId, {
            assignments: [{ fixture_id: b.fixtureId, scheduled_at: at(11), court_id: b.courtA }],
            source: "manual",
          }),
      },
    ];

    const seen: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    for (const site of sites) {
      const board = await frozenBoard(auth);
      want[site.name] = {
        status: 422,
        code: SCHEDULE_LOCKED_CODE,
        message: SCHEDULE_LOCKED_MESSAGE,
      };
      try {
        await site.run(board);
        seen[site.name] = "DID NOT REFUSE a frozen division";
      } catch (err) {
        seen[site.name] =
          err instanceof HttpError
            ? { status: err.status, code: err.code, message: err.message }
            : `threw ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`;
      }
    }
    // One assertion, every site named.
    expect(seen).toEqual(want);
  });

  // The joint apply is the site the other nine were brought UP to: it already
  // carried the code, and it interpolates the frozen division's name because
  // the caller named a COMPETITION and needs to know which division stopped
  // the run. It shares the code and the formatter, not the sentence — pinned
  // here so the formatter cannot drift from the message it formats.
  it("the joint apply's per-division sentence comes from the shared formatter", () => {
    expect(scheduleLockedMessageFor("Open")).toContain("locked — unlock it to edit");
    expect(scheduleLockedMessageFor("Open")).toContain('"Open"');
    // ...and it is NOT the single-division sentence, so a site that used the
    // wrong one of the two would be caught rather than pass by looking similar.
    expect(scheduleLockedMessageFor("Open")).not.toBe(SCHEDULE_LOCKED_MESSAGE);
  });
});

// The three write paths the freeze never bound. Each was found by a review
// sweep AFTER this wave shipped a comment claiming the enumeration was
// complete, so each gets its own behavioural test rather than only a row in
// the table above: the table proves the refusal's SHAPE, these prove the guard
// refuses the right thing, does no work on its way out, and — the assertion
// that stops a guard from passing by refusing everything — that an UNFROZEN
// division still gets the operation.
describe.skipIf(!HAS_DB)("the three paths a freeze used to let through (task 10)", () => {
  it("clear-entrants refuses a frozen division, and still empties a pool on an open one", async () => {
    const { auth } = await seedOrg();
    const { division, stage } = await seedDivision(auth, { kind: "group", pools: { count: 2 } });
    const pools = await sql<{ id: string }[]>`
      select id from pools where stage_id = ${stage.id} order by key`;
    const [poolA, poolB] = [pools[0]!.id, pools[1]!.id];

    const fixturesIn = async (poolId: string): Promise<number> => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where pool_id = ${poolId}`;
      return row!.n;
    };
    // Both pools start with fixtures, so "empty afterwards" means something.
    expect(await fixturesIn(poolA)).toBeGreaterThan(0);
    expect(await fixturesIn(poolB)).toBeGreaterThan(0);

    // The unfrozen CONTROL runs FIRST, so a guard that refused unconditionally
    // — or one placed so early it refuses every call — cannot pass this test.
    const cleared = await clearPoolEntrants(auth, poolA, true);
    expect(cleared.removed).toBeGreaterThan(0);
    expect(await fixturesIn(poolA)).toBe(0);

    await setDivisionLocks(auth, division.id, { schedule_locked: true });
    const before = await fixturesIn(poolB);
    await expect(clearPoolEntrants(auth, poolB, true)).rejects.toMatchObject({
      status: 422,
      code: SCHEDULE_LOCKED_CODE,
    });
    // `message` is not an own enumerable property, so `toMatchObject` cannot
    // see it — it needs its own matcher.
    await expect(clearPoolEntrants(auth, poolB, true)).rejects.toThrow(SCHEDULE_LOCKED_MESSAGE);
    // The refusal removed nothing on its way out: the guard sits ahead of the
    // fixture read and the engine call, not after them.
    expect(await fixturesIn(poolB)).toBe(before);

    // ...and it really was the FREEZE that refused, not an already-empty pool.
    await setDivisionLocks(auth, division.id, { schedule_locked: false });
    const after = await clearPoolEntrants(auth, poolB, true);
    expect(after.removed).toBe(before);
  });

  it("a bulk shift refuses a frozen division — and leaves the watermark alone — while still shifting an open one", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA } = await seedCourts(auth);
    const f = fixtures[0]!.id;
    await patchFixture(auth, f, { scheduled_at: at(9), court_id: courtA });

    const startOf = async (): Promise<string | null> => {
      const [row] = await sql<{ at: string | null }[]>`
        select scheduled_at::text as at from fixtures where id = ${f}`;
      return row!.at;
    };

    // Unfrozen CONTROL first.
    const shifted = await shiftDivisionSchedule(auth, {
      division_id: division.id,
      scope: { excludeLocked: true },
      delta_minutes: 60,
    });
    expect(shifted.shifted).toBeGreaterThan(0);
    expect(new Date((await startOf())!).toISOString()).toBe(at(10));

    // Leave a REWIND genuinely standing before freezing. A shift is what nulls
    // `edit_watermark`, so after the control above there is nothing left to
    // lose and the watermark assertion below would witness nothing; one undo
    // puts the division back behind its head, which is the state a freeze is
    // protecting and the state a second shift would silently throw away.
    await undoDivision(auth, division.id);
    expect(new Date((await startOf())!).toISOString()).toBe(at(9));

    await setDivisionLocks(auth, division.id, { schedule_locked: true });
    /** Board AND ledger. The watermark is the point of this one: a shift that
     *  gets through nulls `edit_watermark`, which does not merely move
     *  fixtures — it destroys the rewind the freeze exists to protect. A
     *  board-only assertion would pass on a guard that refused after the
     *  `update divisions set … edit_watermark = null`. */
    const state = async (): Promise<{ at: string | null; seq: number; watermark: number | null }> => {
      const [row] = await sql<{ at: string | null; seq: number; watermark: number | null }[]>`
        select (select scheduled_at::text from fixtures where id = ${f}) as at,
               seq::int as seq, edit_watermark::int as watermark
        from divisions where id = ${division.id}`;
      return row!;
    };
    const before = await state();
    expect(before.watermark).not.toBeNull(); // there really is a rewind to lose

    await expect(
      shiftDivisionSchedule(auth, {
        division_id: division.id,
        scope: { excludeLocked: true },
        delta_minutes: 60,
      }),
    ).rejects.toMatchObject({ status: 422, code: SCHEDULE_LOCKED_CODE });
    await expect(
      shiftDivisionSchedule(auth, {
        division_id: division.id,
        scope: { excludeLocked: true },
        delta_minutes: 60,
      }),
    ).rejects.toThrow(SCHEDULE_LOCKED_MESSAGE);
    expect(await state()).toEqual(before);
  });

  it("deleting a save point refuses a frozen division, 404s an unknown checkpoint ahead of the freeze, and still deletes on an open one", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const { courtA } = await seedCourts(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_id: courtA });

    const saved = async (id: string): Promise<number> => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from division_checkpoints where id = ${id}`;
      return row!.n;
    };

    // Unfrozen CONTROL first: Delete works on an open division.
    const open = await createCheckpoint(auth, division.id, "deletable");
    await deleteCheckpoint(auth, division.id, open.id);
    expect(await saved(open.id)).toBe(0);

    const kept = await createCheckpoint(auth, division.id, "must survive the freeze");
    await setDivisionLocks(auth, division.id, { schedule_locked: true });

    await expect(deleteCheckpoint(auth, division.id, kept.id)).rejects.toMatchObject({
      status: 422,
      code: SCHEDULE_LOCKED_CODE,
    });
    await expect(deleteCheckpoint(auth, division.id, kept.id)).rejects.toThrow(
      SCHEDULE_LOCKED_MESSAGE,
    );
    // The refusal is not a 422 that also deleted the row. This is the whole
    // point: the deletion is irreversible, unlike every other refusal here.
    expect(await saved(kept.id)).toBe(1);

    // Placement, and this site really can witness it — unlike the division
    // guards, whose existence check reads a MISSING row as unfrozen and falls
    // through wherever the guard sits. Here the checkpoint lookup is a genuine
    // existence check independent of the division's freeze, so a guard hoisted
    // above it turns this 404 into a 422 and this assertion goes red.
    await expect(deleteCheckpoint(auth, division.id, randomUUID())).rejects.toMatchObject({
      status: 404,
    });

    // ...and the save point was refused by the FREEZE, not by anything about
    // the row itself.
    await setDivisionLocks(auth, division.id, { schedule_locked: false });
    await deleteCheckpoint(auth, division.id, kept.id);
    expect(await saved(kept.id)).toBe(0);
  });
});
