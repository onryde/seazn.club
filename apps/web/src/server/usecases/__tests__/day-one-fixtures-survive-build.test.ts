// F3 Task 4 — the acceptance evidence for the whole day-one-fixtures branch:
// create a division from a REAL multi-stage picker format template, and
// prove — by EXECUTION, not by reading generateProgressionSetupFixtures's
// source (design §7 P1) — that the downstream stage's fixtures exist the
// instant the stages are created (before the source stage has so much as
// been generated, let alone completed), carry real human-readable
// placeholder labels on both sides, and SURVIVE a schedule BUILD: same
// fixture identity, same labels, still no entrant attached, now actually
// placed on the timetable.
//
// Real Postgres, full usecase pipeline; skipped without DATABASE_URL (same
// convention as the sibling stage-roster-drift.test.ts).
//
// Drives `buildTemplateStages("league_ko", …)` — the SAME builder the
// division builder and Settings tab call (format-templates.ts) — rather
// than hand-building a progression object, so this test also breaks if the
// template regresses, not only if generateProgressionSetupFixtures does.
//
// The placement CP-SAT service is deliberately NOT running for this test:
// BUILD falls back to its greedy path and logs a solveBuild failure — that
// is the expected, ordinary shape of a dev/CI environment without the
// service, not a defect this test is checking for. See
// schedule-build-honours-locks.test.ts for the (unrelated) suite whose
// assertions actually need the service reachable.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTemplateStages, type TemplateKnobs } from "@/lib/format-templates";
import { sql } from "@/lib/db";
import { msg } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { applySchedule, autoSchedule, putScheduleSettings } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{key,params}` -> display text, through the SAME resolver every real
 *  renderer uses (lib/slot-label.ts), never a hand-built string — so this
 *  proves what an organiser would actually see, not merely that a column
 *  happens to be non-null. */
function renderLabel(label: unknown): string {
  return resolveSlotLabel(label as SlotLabel | null, msg, "schedule.tbd");
}

/** A day-one placeholder must be an ACTUAL descriptor an organiser can read
 *  — not absent, not the TBD fallback, not an RSC "$undefined" artifact, and
 *  not a bare uuid leaking through unresolved. */
function assertRealLabel(label: unknown): void {
  expect(label).not.toBeNull();
  const text = renderLabel(label);
  expect(text).not.toBe("");
  expect(text).not.toBe("$undefined");
  expect(text).not.toBe("TBD");
  expect(text).not.toBe(msg("schedule.tbd"));
  expect(text).not.toMatch(UUID_RE);
}

const LEAGUE_KO_KNOBS: TemplateKnobs = { qualified: 2, swissRounds: 5, poolCount: 2, legs: 1 };

/** A fresh division built from the REAL "League + Finals" template — a
 *  2-stage picker format (league, then a knockout fed by `rankRange 1..2`,
 *  `timing: "setup"`) — with 4 real entrants seeded into the league. `seq`
 *  assigned by array position, exactly like buildTemplateStages' own real
 *  caller (division-builder.tsx's `buildStages().map((s, i) => ({ ...s, seq:
 *  i + 1 }))`). */
async function seedPickerDivision(
  auth: AuthCtx,
): Promise<{ divisionId: string; leagueStageId: string; koStageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Day One " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  // `StageDraft.kind` (format-templates.ts) is a loose `string` — the UI
  // callers round-trip it through an untyped HTTP POST, so this cast never
  // has to hold there. `createStages` is called directly here (typed), so
  // the cast is made explicit at this ONE boundary instead: the runtime
  // shape genuinely is `CreateStages` (real StageKind literals) for every
  // key `STAGE_TEMPLATES` defines, this template's kinds ("league",
  // "knockout") included.
  const drafts = buildTemplateStages("league_ko", LEAGUE_KO_KNOBS).map((d, i) => ({ ...d, seq: i + 1 }));
  const stages = await createStages(auth, division.id, drafts as CreateStages);
  const leagueStageId = stages.find((s) => s.kind === "league")!.id;
  const koStageId = stages.find((s) => s.kind === "knockout")!.id;
  return { divisionId: division.id, leagueStageId, koStageId };
}

describe.skipIf(!HAS_DB)("F3 Task 4 — day-one fixtures reach the board and survive a schedule BUILD", () => {
  it(
    "the picker's downstream stage has real, human-readable placeholder fixtures before the league is even " +
      "generated, and a schedule BUILD leaves their identity and labels untouched",
    async () => {
      const { auth } = await seedOrg();
      const { divisionId, leagueStageId, koStageId } = await seedPickerDivision(auth);

      // ---- 1. Day one: the KO/picker stage is generated FIRST — before the
      // league it draws from has so much as been generated, let alone
      // completed. This is F3's whole claim: the picker does not wait.
      const koGen = await generateStageFixtures(auth, koStageId);
      expect(koGen.created).toBe(1); // rankRange 1..2 into a knockout = one final
      const koFixture = koGen.fixtures[0]!;
      expect(koFixture.home_entrant_id).toBeNull();
      expect(koFixture.away_entrant_id).toBeNull();
      assertRealLabel(koFixture.home_slot_label);
      assertRealLabel(koFixture.away_slot_label);
      const koFixtureId = koFixture.id;
      const homeTextBefore = renderLabel(koFixture.home_slot_label);
      const awayTextBefore = renderLabel(koFixture.away_slot_label);

      // ---- 2. NOW the league — proving order-independence, not just
      // "eventually both exist".
      const leagueGen = await generateStageFixtures(auth, leagueStageId);
      expect(leagueGen.created).toBe(6); // 4 entrants, single round robin

      // ---- 3. BUILD, over the whole division — no placement service
      // running, so both calls fall back to greedy. That is the exact
      // scenario this test exists to prove survives cleanly.
      const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
      const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
      const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
      await putScheduleSettings(auth, divisionId, {
        config: {
          startAt: "2026-08-01T09:00:00.000Z",
          matchMinutes: 30,
          gapMinutes: 0,
          courts: [court1.id, court2.id],
          perEntrantMinRest: 30,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      });

      const koBuild = await autoSchedule(auth, koStageId, { only_unlocked: false, mode: "build" });
      expect(koBuild.assignments).toHaveLength(1);
      expect(koBuild.assignments[0]!.fixture_id).toBe(koFixtureId);
      await applySchedule(auth, koStageId, {
        assignments: koBuild.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      });

      const leagueBuild = await autoSchedule(auth, leagueStageId, { only_unlocked: false, mode: "build" });
      expect(leagueBuild.assignments).toHaveLength(6);
      await applySchedule(auth, leagueStageId, {
        assignments: leagueBuild.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
        source: "auto",
      });

      // ---- 4. SURVIVE: re-read the board directly from the table (not the
      // usecase's own return value) — the ground truth an organiser's screen
      // renders from.
      const after = await sql<
        {
          id: string;
          home_entrant_id: string | null;
          away_entrant_id: string | null;
          home_slot_label: unknown;
          away_slot_label: unknown;
          scheduled_at: string | null;
          court_id: string | null;
        }[]
      >`
        select id, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, scheduled_at, court_id
        from fixtures where stage_id = ${koStageId}`;
      expect(after).toHaveLength(1); // not deleted, not duplicated
      const row = after[0]!;
      expect(row.id).toBe(koFixtureId); // SAME identity — not regenerated
      expect(row.home_entrant_id).toBeNull(); // BUILD never silently attaches an entrant
      expect(row.away_entrant_id).toBeNull();
      assertRealLabel(row.home_slot_label);
      assertRealLabel(row.away_slot_label);
      // Not merely "still real" — the SAME text, byte for byte.
      expect(renderLabel(row.home_slot_label)).toBe(homeTextBefore);
      expect(renderLabel(row.away_slot_label)).toBe(awayTextBefore);
      expect(row.scheduled_at).not.toBeNull(); // actually landed on the timetable
      expect([court1.id, court2.id]).toContain(row.court_id);
    },
    60_000,
  );
});
