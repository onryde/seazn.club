// schedule-stranded-drag-target.test.ts — code-review fix (findings 1 & 2,
// 2026-08-25 review of feat/p10-venues-calendars).
//
// `moveFixture`'s `assignedCourtIds` (schedule.ts, above its own
// `verifyConfigForDivision` call) and `applySchedule`'s twin were built ONLY
// from STORED fixtures (`all.map(f => f.court_id)`) — never from the court
// the caller is actively dragging onto (`moveFixture`'s `nextCourtId`) or
// applying onto (`applySchedule`'s `input.assignments[].court_id`). Both
// sites carry a comment directly above claiming coverage they did not have:
// "the dragged card is judged against the durable typed rules too" /
// "this apply gate sees court opening hours too ... this apply gate gets
// the stranded-court signal too". A card moved/applied onto an archived
// court that no OTHER fixture currently occupies produced NO
// `stranded_fixture` conflict, contradicting both comments.
//
// The falsifier has to put the archived court on NO stored fixture at all —
// archiving a court a stored fixture already sits on would flag it via
// `all`'s own contribution regardless of this bug, proving nothing. Both
// seeds below archive the division's ONLY court before either fixture is
// ever scheduled, so `all` (divisionFixtures) never once carries its id.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { applySchedule, moveFixture } from "../schedule";
import { createVenue, createCourt } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};
const DAY = "2026-09-01";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

/** One org/division/court, ONE unscheduled fixture. The court is archived
 *  BEFORE the fixture is ever placed anywhere — so no stored fixture in the
 *  division ever references it, and it stays in `schedule_settings.config
 *  .courts` (an organiser archiving a court does not retroactively edit a
 *  division's stored court list — same shape `stranded-courts.test.ts`
 *  itself seeds). */
async function seedArchivedCourtBoard(): Promise<{
  auth: AuthCtx;
  stageId: string;
  fixtureId: string;
  archivedCourt: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Stranded Drag ${tag}`,
    visibility: "public",
    branding: {},
  });
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const division = await createDivision(auth, comp.id, {
    name: `Div ${tag}`,
    slug: tag,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json({
      startAt: at(DAY, "00:00"),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [court.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      constraints: {
        restMin: 0,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off",
        parallelism: "mixed",
        crossPersonClash: "warn",
        hard: [],
      },
    })}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    ["A-1", "A-2"].map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const byName = new Map(rows.map((r) => [r.display_name, r.id]));
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${stage!.id}, ${division.id}, ${auth.orgId}, 1, 1, ${"f-" + tag}, 'scheduled',
            ${byName.get("A-1")!}, ${byName.get("A-2")!})
    returning id`;
  // Archived only NOW — after the court is already the division's configured
  // court, but before any fixture is ever scheduled onto it.
  await sql`update courts set archived_at = now() where id = ${court.id}`;
  return { auth, stageId: stage!.id, fixtureId: f!.id, archivedCourt: court.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a card dragged/applied onto an archived court nobody else occupies is flagged stranded (review findings 1 & 2)", () => {
  it("moveFixture reports stranded_fixture even though NO stored fixture sits on the archived court", async () => {
    const { auth, fixtureId, archivedCourt } = await seedArchivedCourtBoard();
    const conflicts = await moveFixture(auth, fixtureId, {
      scheduled_at: at(DAY, "09:00"),
      court_id: archivedCourt,
    });
    const stranded = conflicts.filter((c) => c.details?.kind === "stranded_fixture");
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.fixture_id).toBe(fixtureId);
    // Advisory, never blocking (P10 ruling 1) — the write below proves it
    // was not refused.
    expect(stranded[0]!.blocking).toBe(false);
    const [row] = await sql<{ court_id: string }[]>`
      select court_id from fixtures where id = ${fixtureId}`;
    expect(row!.court_id).toBe(archivedCourt);
  }, 120_000);

  it("applySchedule reports stranded_fixture even though NO stored fixture sits on the archived court", async () => {
    const { auth, stageId, fixtureId, archivedCourt } = await seedArchivedCourtBoard();
    const out = await applySchedule(auth, stageId, {
      assignments: [{ fixture_id: fixtureId, scheduled_at: at(DAY, "10:00"), court_id: archivedCourt }],
      source: "manual",
    });
    const stranded = out.conflicts.filter((c) => c.details?.kind === "stranded_fixture");
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.fixture_id).toBe(fixtureId);
    expect(stranded[0]!.blocking).toBe(false);
    const [row] = await sql<{ court_id: string }[]>`
      select court_id from fixtures where id = ${fixtureId}`;
    expect(row!.court_id).toBe(archivedCourt);
  }, 120_000);
});
