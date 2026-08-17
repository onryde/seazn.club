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
import { createVenue, createCourt } from "../venues";
import { getScheduleHealth, getCompetitionScheduleHealth } from "../schedule-health";

const HAS_DB = !!process.env.DATABASE_URL;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY = "2026-10-17";
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

interface Seeded {
  auth: AuthCtx;
  stageId: string;
  competitionId: string;
  names: string[];
  /** P9 pass 3a — the two real courts fixtures are seeded onto (id + the
   *  display name a resolved offender label must show). */
  courts: { id: string; name: string }[];
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

  // P9 pass 3a: two REAL courts — `schedule_settings.config.courts` is
  // `CourtId[]` (real uuids) since pass 1, and `fixtures.court_id` carries a
  // composite FK to `courts(id, org_id)` — a free-text "Court 1"/"Court 2"
  // is no longer a legal value for either. This seed pre-dates that cutover
  // and, unfixed, would throw a ZodError the moment `getScheduleHealth`
  // calls `loadSettings`'s `ScheduleConfig.parse` on a non-uuid `courts`
  // entry — this whole suite would be red before P9 pass 3a touched
  // anything in this file.
  const auth: AuthCtx = { orgId, via: "session", userId, role: "owner", keyId: null };
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });

  await sql`
    insert into schedule_settings (org_id, division_id, tz, config)
    values (${orgId}, ${divisionId}, 'UTC', ${sql.json({
      startAt: `${DAY}T00:00:00.000Z`,
      endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 60,
      gapMinutes: 0,
      courts: [court1.id, court2.id],
      perEntrantMinRest: 0,
      sessionWindows: [{ from: `${DAY}T09:00:00.000Z`, to: `${DAY}T21:00:00.000Z` }],
    })})
    on conflict (division_id) do update set tz = excluded.tz, config = excluded.config`;

  const board: Array<[string, string, string, string, number]> = [
    [e1, e2, "09:00", court1.id, 1],
    [e3, e4, "09:00", court2.id, 2],
    [e1, e3, "10:15", court1.id, 3],
    [e2, e4, "10:15", court2.id, 4],
    [e1, e4, "15:00", court1.id, 5],
    [e2, e3, "15:00", court2.id, 6],
  ];
  for (const [home, away, time, courtId, no] of board) {
    await sql`
      insert into fixtures (org_id, division_id, stage_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, court_id,
                            status, ext_key, fixture_no)
      values (${orgId}, ${divisionId}, ${stageId}, 1, ${no}, ${home}, ${away},
              ${at(time)}, ${courtId}, 'scheduled', ${`hl-${no}`}, ${no})`;
  }

  return {
    auth,
    stageId,
    competitionId,
    names,
    courts: [
      { id: court1.id, name: court1.name },
      { id: court2.id, name: court2.name },
    ],
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

  it("labels courtDay offenders with the court's NAME, never the raw court_id (P9 pass 3a)", async () => {
    const { auth, stageId, courts } = await seedLopsidedLeague();
    const report = await getScheduleHealth(auth, stageId);

    const courtDayOffenders = report.metrics.flatMap((m) =>
      m.offenders.filter((o) => o.kind === "courtDay"),
    );
    // Guard the premise: gapDispersion's own gate needs >= 2 fixtures on one
    // (court, day) to emit a courtDay row at all — this board seeds 3 per
    // court, so it always qualifies; a board with no offenders would make
    // every assertion below trivially true.
    expect(courtDayOffenders.length).toBeGreaterThan(0);

    const courtNames = courts.map((c) => c.name);
    for (const o of courtDayOffenders) {
      expect(o.label, `courtDay offender label is a raw uuid: ${o.label}`).not.toMatch(UUID_RE);
      // label is `${courtName} ${dayKey}` (health.ts's gapDispersionMetric)
      // — assert it STARTS WITH a real court name, not merely contains one:
      // a raw court_id could never start with "Court 1", so this alone
      // already fails pre-fix (before withResolvedOffenderLabels resolved
      // the courtDay case).
      expect(courtNames.some((name) => o.label.startsWith(name))).toBe(true);
      // `id` keeps its raw `${court_id}::${dayKey}` shape — the panel keys
      // off it, and it must still resolve back to a real seeded court.
      const [courtId] = o.id.split("::");
      expect(courts.some((c) => c.id === courtId)).toBe(true);
    }
  });
});

// P9 pass 3a: the cutover this suite's own seeding needed (see
// seedLopsidedLeague's comment) is also the direct proof of the dispatch's
// regression — schedule-health keys on court_id, not the legacy
// court_label, which no production writer has populated since this pass.
describe.skipIf(!HAS_DB)("schedule health — court_id is authoritative, court_label is dead weight (P9 pass 3a)", () => {
  it("scores a fixture whose court_label is NULL — the post-drop-PR world — as long as court_id is set", async () => {
    const { auth, stageId } = await seedLopsidedLeague();
    // court_label was never written by this seed (nor by any production
    // writer any more) — it already starts NULL. The report existing at all
    // is the proof: stageFixtures' WHERE clause used to require
    // `court_label is not null`, which would have excluded every one of
    // these rows and collapsed this call to the 409 SCHEDULE_NOT_APPLIED
    // "empty board" case instead of a real report.
    const report = await getScheduleHealth(auth, stageId);
    expect(report.metrics.length).toBeGreaterThan(0);
  });

  it("ignores a stale, misleading court_label — only court_id is read", async () => {
    const { auth, stageId } = await seedLopsidedLeague();
    const baseline = await getScheduleHealth(auth, stageId);
    // Poison court_label with a value that names neither seeded court —
    // stageFixtures no longer selects this column at all, so the report
    // must be byte-identical.
    await sql`update fixtures set court_label = 'a court that does not exist' where stage_id = ${stageId}`;
    const poisoned = await getScheduleHealth(auth, stageId);
    expect(poisoned.metrics).toEqual(baseline.metrics);
  });
});

describe.skipIf(!HAS_DB)("schedule health — JOINT report offender labels", () => {
  it("names entrant offenders in the combined block too, not just per stage", async () => {
    // The per-stage fix went inside `computeStageHealth`, which the joint
    // route calls once per stage — so the per-division entries inherited it.
    // The `combined` block does NOT go through that function: it calls
    // `assessHealth` directly on the union of every stage's fixtures,
    // because there is no single stage to compute. It therefore did not
    // inherit the name resolution, and the joint report kept rendering
    // `Entrant · <uuid>` after the per-stage bug was declared fixed.
    //
    // Nothing caught it: scripts/smoke.ts and schedule-health.spec.ts both
    // type `combined.metrics` as `{key, score}` and never read `offenders`
    // at all. `primeSlotFairness` is one of the two metrics COMBINED keeps
    // and it emits entrant offenders, so this is the assertion that was
    // missing.
    const { auth, competitionId, names } = await seedLopsidedLeague();
    const report = await getCompetitionScheduleHealth(auth, competitionId);

    const combinedEntrantOffenders = report.combined.metrics.flatMap((m) =>
      m.offenders.filter((o) => o.kind === "entrant"),
    );
    // Guard the premise — no entrant offenders in the combined block would
    // make every assertion below vacuously true.
    expect(combinedEntrantOffenders.length).toBeGreaterThan(0);

    for (const o of combinedEntrantOffenders) {
      expect(o.label, `combined offender label is a raw uuid: ${o.label}`).not.toMatch(UUID_RE);
      expect(names).toContain(o.label);
      expect(o.id).toMatch(UUID_RE);
    }
  });
});
