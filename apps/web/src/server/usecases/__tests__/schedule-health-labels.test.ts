// D3 schedule health — offender labels must be entrant NAMES, not raw ids.
//
// The engine is pure and knows nothing about the `entrants` table, so
// `HealthOffender.label` leaves it as the entrant's uuid; health.ts documents
// that verbatim ("Raw id … the module and the route stay at raw labels for
// now"). Nothing resolved it, so the Health tab rendered
// `Entrant · e3a37cef-54f3-47cc-afd2-b06b7cc070d0` to organisers. This file
// pins the app-layer join that fixes it.
//
// DB-backed; skipped without DATABASE_URL, the same convention every other
// usecase test in this directory uses. There was no unit test for
// schedule-health.ts at all before this — the feature shipped covered by e2e
// and smoke only, neither of which asserts anything about the label's SHAPE,
// which is exactly how a uuid reached the screen.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getScheduleHealth } from "../schedule-health";

const HAS_DB = !!process.env.DATABASE_URL;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY = "2026-10-17";
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

interface Seeded {
  auth: AuthCtx;
  stageId: string;
  names: string[];
}

/** A lopsided but legal one-day league: every one of E1's matches on Court 1,
 *  three matches per entrant at uneven gaps. That shape is what produces real
 *  offenders on restSpread and courtBalance — a perfectly balanced board would
 *  make this test vacuous by having no offender rows to inspect at all, which
 *  is why the assertions below also require the list to be non-empty. */
async function seedLopsidedLeague(): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`health-labels-${suffix}@test.local`}, 'Health Labels', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale, timezone)
    values (${"Health Labels " + suffix}, ${"health-labels-" + suffix}, ${userId}, 'en', 'UTC')
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;

  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by, ends_on)
    values (${orgId}, ${"HL " + suffix}, ${"hl-" + suffix}, 'private', ${userId}, '2030-12-31')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${orgId}, ${competitionId}, 'HL', ${"hl-" + suffix}, 'generic', 'score',
            ${sql.json({ points: { w: 3, d: 1, l: 0 }, progressScore: false })}, '1.0.0')
    returning id`;

  // Names deliberately unlike a uuid in every way, so a passing assertion
  // cannot be an accident of formatting.
  const names = ["Ada Lovelace", "Bea Fenwick", "Cal Ortiz", "Dev राव"];
  const entrantIds: string[] = [];
  for (const [i, display] of names.entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into entrants (org_id, division_id, kind, display_name, seed)
      values (${orgId}, ${divisionId}, 'individual', ${display}, ${i + 1})
      returning id`;
    entrantIds.push(id);
  }
  const [e1, e2, e3, e4] = entrantIds as [string, string, string, string];

  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, seq, kind, name)
    values (${orgId}, ${divisionId}, 1, 'league', 'League')
    returning id`;

  await sql`
    insert into schedule_settings (org_id, division_id, tz, config)
    values (${orgId}, ${divisionId}, 'UTC', ${sql.json({
      startAt: `${DAY}T00:00:00.000Z`,
      endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 60,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2"],
      perEntrantMinRest: 0,
      sessionWindows: [{ from: `${DAY}T09:00:00.000Z`, to: `${DAY}T21:00:00.000Z` }],
    })})
    on conflict (division_id) do update set tz = excluded.tz, config = excluded.config`;

  const board: Array<[string, string, string, string, number]> = [
    [e1, e2, "09:00", "Court 1", 1],
    [e3, e4, "09:00", "Court 2", 2],
    [e1, e3, "10:15", "Court 1", 3],
    [e2, e4, "10:15", "Court 2", 4],
    [e1, e4, "15:00", "Court 1", 5],
    [e2, e3, "15:00", "Court 2", 6],
  ];
  for (const [home, away, time, court, no] of board) {
    await sql`
      insert into fixtures (org_id, division_id, stage_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, court_label,
                            status, ext_key, fixture_no)
      values (${orgId}, ${divisionId}, ${stageId}, 1, ${no}, ${home}, ${away},
              ${at(time)}, ${court}, 'scheduled', ${`hl-${no}`}, ${no})`;
  }

  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    stageId,
    names,
  };
}

describe.skipIf(!HAS_DB)("schedule health — offender labels", () => {
  it("labels entrant offenders with the display name, never the raw uuid", async () => {
    const { auth, stageId, names } = await seedLopsidedLeague();
    const report = await getScheduleHealth(auth, stageId);

    const entrantOffenders = report.metrics.flatMap((m) =>
      m.offenders.filter((o) => o.kind === "entrant"),
    );
    // Guard the premise: a board with no entrant offenders would make every
    // assertion below trivially true.
    expect(entrantOffenders.length).toBeGreaterThan(0);

    for (const o of entrantOffenders) {
      expect(o.label, `offender label is a raw uuid: ${o.label}`).not.toMatch(UUID_RE);
      expect(names).toContain(o.label);
      // The id itself must still be the id — the panel keys rows on it, and
      // two entrants may legitimately share a display name.
      expect(o.id).toMatch(UUID_RE);
    }
  });

  it("still names the survivors when one entrant row has been deleted", async () => {
    const { auth, stageId, names } = await seedLopsidedLeague();
    const before = await getScheduleHealth(auth, stageId);
    const target = before.metrics.flatMap((m) => m.offenders).find((o) => o.kind === "entrant");
    expect(target).toBeDefined();

    // `fixtures.*_entrant_id` is `on delete set null`, so the fixture rows
    // survive as TBD and the board still scores — this is the partial-lookup
    // case, where `nameById` cannot cover every offender it is asked about.
    await sql`delete from entrants where id = ${target!.id}`;

    const after = await getScheduleHealth(auth, stageId);
    const entrantOffenders = after.metrics.flatMap((m) =>
      m.offenders.filter((o) => o.kind === "entrant"),
    );
    expect(entrantOffenders.length).toBeGreaterThan(0);

    // The point of the assertion: a MISS must not poison the HITS. Every
    // label is still non-empty, and at least one is a real name — asserting
    // only "non-empty" would pass with the resolution removed entirely (a
    // raw uuid is non-empty too), which is exactly the vacuous shape this
    // test had on its first draft.
    for (const o of entrantOffenders) expect(o.label.length).toBeGreaterThan(0);
    expect(entrantOffenders.some((o) => names.includes(o.label))).toBe(true);
  });
});
