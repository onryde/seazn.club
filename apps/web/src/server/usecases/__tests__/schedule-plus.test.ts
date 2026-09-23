// Integration tests for PROMPT-24 (Jul3/04): bulk shift (undoable), wait
// report, Pro gates, flexible mode. Real Postgres required; skipped without
// DATABASE_URL.
import type { AnyPlanKey } from "@/lib/currency";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { patchFixture } from "../fixtures";
import { putScheduleSettings, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createVenue, createCourt } from "../venues";
import { PutScheduleSettings } from "@/server/api-v1/schemas";
import { redoDivision, undoDivision } from "../history";
import { shiftDivisionSchedule, divisionScheduleReport } from "../schedule-plus";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: AnyPlanKey = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"C2 " + suffix}, ${"c2-" + suffix})
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

async function seedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "C2 Cup",
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
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { division, stage: stage!, fixtures, entrants };
}

const at = (m: number) => new Date(Date.UTC(2026, 6, 20, 9, m, 0)).toISOString();

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("scheduling constraints v2 (Jul3/04)", () => {
  it("bulk-shift +15m moves all in scope, skips locked, and is undoable (PROMPT-23)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(0),
      court_id: court.id,
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: at(30),
      court_id: court.id,
    });
    await patchFixture(auth, fixtures[1]!.id, { schedule_locked: true });

    const result = await shiftDivisionSchedule(auth, {
      division_id: division.id,
      scope: { excludeLocked: true },
      delta_minutes: 15,
    });
    expect(result.shifted).toBe(1);
    expect(result.skipped.locked).toBe(1);
    const [moved] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
    expect(new Date(moved!.scheduled_at).toISOString()).toBe(at(15));

    await undoDivision(auth, division.id);
    const [back] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
    expect(new Date(back!.scheduled_at).toISOString()).toBe(at(0));
  });

  // Review 2 of #857, I1. History's results-guard refuses any undo/redo that
  // touches an in-play, decided or finalized fixture; the shift skipped only
  // `decided`, so a rain delay moved a live or finalized kick-off and the
  // shift itself could then be neither undone nor redone. Both read ONE
  // played set now (`@/lib/played-fixture-statuses`).
  it("a rain-delay shift leaves an in-play and a finalized fixture where they are — and its Undo and Redo complete", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    for (let i = 0; i < 3; i++) await patchFixture(auth, fixtures[i]!.id, { scheduled_at: at(i * 30) });
    await startDivision(auth, division.id);
    const [inPlay, finalized, open] = [fixtures[0]!.id, fixtures[1]!.id, fixtures[2]!.id];
    await scoreEvent(auth, inPlay, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, finalized, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, finalized, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    await scoreEvent(auth, finalized, { expected_seq: 2, type: "core.finalize", payload: {} });
    const times = async () => {
      const rows = await sql<{ id: string; scheduled_at: string }[]>`
        select id, scheduled_at::text as scheduled_at from fixtures where id in ${sql([inPlay, finalized, open])}`;
      const byId = new Map(rows.map((r) => [r.id, new Date(r.scheduled_at).toISOString()]));
      return [byId.get(inPlay), byId.get(finalized), byId.get(open)];
    };
    expect(await sql`select status from fixtures where id in ${sql([inPlay, finalized])} order by status`).toEqual([
      { status: "finalized" },
      { status: "in_play" },
    ]);

    const result = await shiftDivisionSchedule(auth, {
      division_id: division.id,
      scope: { excludeLocked: true },
      delta_minutes: 15,
    });

    expect(result).toMatchObject({ shifted: 1, skipped: { decided: 2 } });
    expect(await times()).toEqual([at(0), at(30), at(75)]);
    expect((await undoDivision(auth, division.id)).applied.type).toBe("schedule_shifted");
    expect(await times()).toEqual([at(0), at(30), at(60)]);
    expect((await redoDivision(auth, division.id)).applied.type).toBe("schedule_shifted");
    expect(await times()).toEqual([at(0), at(30), at(75)]);
  });

  // P9 sweep (pass 3c-4): shiftSchedule's `scope.courts` (report.ts) and its
  // ledger `moves[].court` (history.ts's undo replay writes it straight back
  // to `court_id` — see that file's own P9 comment) both expect a real
  // `courts.id`, matching `toAssignment`'s Assignment.court convention
  // everywhere else in this engine. court_label is frozen since pass 3a and
  // patchFixture no longer writes it, so it is NULL on any fixture scheduled
  // through the normal path — the old read (`f.court_label`) therefore
  // dropped every such fixture out of `scope.courts` scoping regardless of
  // what the scope named, since the null-check short-circuits ahead of the
  // scope comparison (report.ts). Nothing needs to be poisoned to prove
  // this — a fixture scheduled via `patchFixture` already has court_label
  // NULL, which is exactly the real post-cutover state.
  it("bulk-shift scoped to a court id reaches a fixture whose court_label was never written", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const courtA = await createCourt(auth, venue.id, { name: "Court A", sort: 0, tags: [] });
    const courtB = await createCourt(auth, venue.id, { name: "Court B", sort: 1, tags: [] });
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(0), court_id: courtA.id });
    await patchFixture(auth, fixtures[1]!.id, { scheduled_at: at(30), court_id: courtB.id });

    const result = await shiftDivisionSchedule(auth, {
      division_id: division.id,
      scope: { courts: [courtA.id], excludeLocked: true },
      delta_minutes: 15,
    });

    expect(result.shifted).toBe(1);
    const [moved] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
    expect(new Date(moved!.scheduled_at).toISOString()).toBe(at(15));
    // Court B was never in scope — unmoved either way, but pins that the
    // scope filter is genuinely selective, not "everything matches now".
    const [untouched] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at::text as scheduled_at from fixtures where id = ${fixtures[1]!.id}`;
    expect(new Date(untouched!.scheduled_at).toISOString()).toBe(at(30));
  });

  it("wait report surfaces the worst gap", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, entrants } = await seedDivision(auth);
    // A plays at 9:00 and 14:00 → 270-minute wait (30-minute matches)
    const aGames = fixtures.filter(
      (f: { home_entrant_id: string | null; away_entrant_id: string | null }) =>
        f.home_entrant_id === entrants[0]!.id || f.away_entrant_id === entrants[0]!.id,
    );
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
    await patchFixture(auth, aGames[0]!.id, {
      scheduled_at: at(0),
      court_id: court.id,
    });
    await patchFixture(auth, aGames[1]!.id, {
      scheduled_at: at(300),
      court_id: court.id,
    });
    const report = await divisionScheduleReport(auth, division.id);
    expect(report.worst[0]).toMatchObject({
      display_name: "A",
      maxGapMinutes: 270,
    });
  });

  // Was "constraint fields on schedule-settings are Pro". V353 (#382) opened
  // `scheduling.constraints` to every plan, so this asserts the OPPOSITE now.
  // Inverted rather than deleted: the gate still stands in
  // `putScheduleSettings`, so a migration that never ran — or an override that
  // switches the key back off — must red something.
  it("constraint fields on schedule-settings are open to Community (#382)", async () => {
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    const venue = await createVenue(freeAuth, { name: "Main", sort: 0 });
    const court = await createCourt(freeAuth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const saved = await putScheduleSettings(
      freeAuth,
      freeDiv.id,
      PutScheduleSettings.parse({
        config: {
          courts: [court.id],
          constraints: { crossPersonClash: "hard" },
        },
        tz: "UTC",
      }),
    );
    // Not merely "it did not throw" — a call that stored nothing passes that.
    expect(saved.config.constraints).toMatchObject({ crossPersonClash: "hard" });
  });
});
