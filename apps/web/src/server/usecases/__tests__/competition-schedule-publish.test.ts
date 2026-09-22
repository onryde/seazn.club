// PUBLISH EVERY UNRELEASED DIVISION OF A COMPETITION, best effort, on a real
// database.
//
// The three things only a DB test can witness here, and the reason this suite
// is not a unit test over a mocked `publishSchedule`:
//
//  1. WHICH DIVISIONS ARE CANDIDATES is a `divisions.status` read, and the
//     reason `setup` is the answer lives in a VIEW — `public_fixtures_v`
//     redacts `scheduled_at` for exactly that status
//     (V401__fixture_stream_url.sql:24). The last case here reads the view and
//     pins the instant, so the feature's whole point ("the times go live") has
//     a witness rather than an author.
//
//  2. THE GATE IS THE REAL ONE. Nothing in this module re-implements
//     `assertPublishable`; the refusals below are produced by seeding boards
//     the real validator objects to — a court booked twice (blocking) and an
//     entrant turning round inside the rest floor (a warning) — so a
//     classification bug cannot hide behind a hand-written fixture.
//
//  3. BEST EFFORT IS A PARTIAL COMMIT. A clean division publishes while a
//     sibling is refused, in the same call. Only separate transactions can do
//     that, and only a database can show it.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { createVenue, createCourt } from "../venues";
import { publishCompetitionSchedule } from "../competition-schedule-publish";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Same day the auto-publish suite next door uses — proven to sit inside the
 *  competition's resolved window, so nothing below picks up a stray
 *  `warn.window` that would make a "clean" division not clean. */
const DAY = "2026-08-10";
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

/** 30-minute matches, 30-minute rest floor: an entrant's two matches must start
 *  an hour apart, so a 09:00/09:30 pair on DIFFERENT courts is a `warn.rest`
 *  and nothing else. */
const REST_MIN = 30;

function settingsConfig(courts: string[]) {
  return {
    startAt: at("08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: REST_MIN,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: REST_MIN,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard: [],
    },
  };
}

interface Comp {
  auth: AuthCtx;
  competitionId: string;
  /** Four real `courts.id` values under one venue. Each division below gets its
   *  OWN court(s): `validateScheduleIn` folds SIBLING divisions' fixtures in as
   *  occupancy, so two divisions sharing a court at one instant would make the
   *  "clean" division dirty for a reason that has nothing to do with the case. */
  courts: [string, string, string, string];
}

/** A PUBLIC competition, because `public_fixtures_v` admits `public`/`unlisted`
 *  only — and created private first, because `createCompetition` silently
 *  DEGRADES a public create over `dashboard.public.max` instead of refusing. */
async function seedCompetition(): Promise<Comp> {
  const { auth } = await seedOrg("pro");
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Publish All ${tag}`,
    visibility: "private",
    branding: {},
  });
  await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
  const venue = await createVenue(auth, { name: `Main ${tag}`, sort: 0 });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const court = await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] });
    ids.push(court.id);
  }
  return {
    auth,
    competitionId: comp.id,
    courts: ids as [string, string, string, string],
  };
}

interface Div {
  divisionId: string;
  stageId: string;
  entrantIds: string[];
}

/** A `setup` division with 4 entrants, a league stage and NO fixtures. Every
 *  case below hand-places the rows it needs, so the board under the gate is
 *  exactly what the case describes. */
async function seedDivision(comp: Comp, name: string, courts: string[]): Promise<Div> {
  const tag = randomUUID().slice(0, 8);
  const division = await createDivision(comp.auth, comp.competitionId, {
    name,
    slug: `pub-all-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts))}, ${"UTC"}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    comp.auth,
    division.id,
    [1, 2, 3, 4].map((n) => ({
      kind: "individual" as const,
      display_name: `${name} E${n}`,
      seed: n,
      members: [],
    })),
  );
  const entrants = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${division.id} order by seed`;
  const [stage] = await createStages(comp.auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return { divisionId: division.id, stageId: stage!.id, entrantIds: entrants.map((e) => e.id) };
}

/** Hand-place one fixture. `court_id` (never the legacy `court_label`) is what
 *  `validateScheduleIn` builds an assignment from, alongside `scheduled_at`. */
async function placeFixture(
  auth: AuthCtx,
  div: Div,
  i: number,
  row: { home: string; away: string; hhmm: string; court: string },
): Promise<string> {
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                          status, home_entrant_id, away_entrant_id, scheduled_at, court_id)
    values (${div.stageId}, ${div.divisionId}, ${auth.orgId}, 1, ${i}, ${`hand${i}`},
            'scheduled', ${row.home}, ${row.away}, ${at(row.hhmm)}, ${row.court})
    returning id`;
  return fixture!.id;
}

/** One legally-placed fixture between the division's first two entrants — the
 *  cheapest board that clears both candidate rules: `setup`, and NOT empty. */
async function placeOne(comp: Comp, div: Div, hhmm: string, court: string): Promise<string> {
  const [home, away] = div.entrantIds as [string, string];
  return placeFixture(comp.auth, div, 0, { home, away, hhmm, court });
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return row!.status;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("publishCompetitionSchedule", () => {
  it("publishes the clean division and refuses the blocked one, in one call", async () => {
    const comp = await seedCompetition();
    const clean = await seedDivision(comp, "Clean", [comp.courts[0]]);
    const blocked = await seedDivision(comp, "Blocked", [comp.courts[1]]);

    const [c1, c2, c3, c4] = clean.entrantIds as [string, string, string, string];
    await placeFixture(comp.auth, clean, 0, { home: c1, away: c2, hhmm: "09:00", court: comp.courts[0] });
    await placeFixture(comp.auth, clean, 1, { home: c3, away: c4, hhmm: "10:00", court: comp.courts[0] });

    // One court, one instant, two matches — physically impossible, so
    // `conflict.court` and `blocking: true`. Four DISTINCT entrants, so the
    // refusal is the court and not a person on two courts at once.
    const [b1, b2, b3, b4] = blocked.entrantIds as [string, string, string, string];
    await placeFixture(comp.auth, blocked, 0, { home: b1, away: b2, hhmm: "09:00", court: comp.courts[1] });
    await placeFixture(comp.auth, blocked, 1, { home: b3, away: b4, hhmm: "09:00", court: comp.courts[1] });

    const out = await publishCompetitionSchedule(comp.auth, comp.competitionId);

    expect(out.published).toBe(1);
    expect(out.blocked).toBe(1);
    expect(out.needs_acknowledgement).toBe(0);
    expect(out.results).toHaveLength(2);

    const cleanRow = out.results.find((r) => r.division_id === clean.divisionId);
    expect(cleanRow).toMatchObject({ name: "Clean", published: true });
    expect(cleanRow?.refusal).toBeUndefined();
    expect(await divisionStatus(clean.divisionId)).toBe("scheduled");

    const blockedRow = out.results.find((r) => r.division_id === blocked.divisionId);
    expect(blockedRow).toMatchObject({ name: "Blocked", published: false });
    // The gate's OWN constant, so a rename moves the assertion with it rather
    // than leaving it pinned to yesterday's wire value.
    expect(blockedRow?.refusal?.code).toBe(PUBLISH_BLOCKED);
    expect(blockedRow?.refusal?.blocking).toBe(true);
    // The conflicts ride the refusal — a report the organiser can act on, not
    // just a count. Both cards of the double-booking are named.
    expect(blockedRow?.refusal?.conflicts.length).toBeGreaterThan(0);
    expect(blockedRow?.refusal?.conflicts.every((c) => c.code === "conflict.court")).toBe(true);
    expect(blockedRow?.refusal?.conflicts.some((c) => c.blocking)).toBe(true);
    expect(await divisionStatus(blocked.divisionId)).toBe("setup");
  }, 180_000);

  it("a warnings-only division waits for the acknowledgement, then publishes", async () => {
    const comp = await seedCompetition();
    const warn = await seedDivision(comp, "Warn", [comp.courts[0], comp.courts[1]]);
    const [w1, w2, w3] = warn.entrantIds as [string, string, string];
    // W1 turns round in 30 minutes against a 30-minute floor, on two DIFFERENT
    // courts: `warn.rest`, non-blocking, and no court clash to go with it.
    await placeFixture(comp.auth, warn, 0, { home: w1, away: w2, hhmm: "09:00", court: comp.courts[0] });
    await placeFixture(comp.auth, warn, 1, { home: w1, away: w3, hhmm: "09:30", court: comp.courts[1] });

    const first = await publishCompetitionSchedule(comp.auth, comp.competitionId);
    expect(first.published).toBe(0);
    expect(first.needs_acknowledgement).toBe(1);
    expect(first.blocked).toBe(0);
    const refused = first.results.find((r) => r.division_id === warn.divisionId);
    expect(refused?.refusal?.code).toBe(PUBLISH_UNACKNOWLEDGED);
    // FALSE, not merely "not true": this is the bit the console branches on to
    // decide whether to offer a confirm button at all.
    expect(refused?.refusal?.blocking).toBe(false);
    expect(refused?.refusal?.conflicts.some((c) => c.code === "warn.rest")).toBe(true);
    expect(await divisionStatus(warn.divisionId)).toBe("setup");

    const second = await publishCompetitionSchedule(comp.auth, comp.competitionId, {
      acknowledge_warnings: true,
    });
    expect(second.published).toBe(1);
    expect(second.needs_acknowledgement).toBe(0);
    expect(second.results.find((r) => r.division_id === warn.divisionId)?.published).toBe(true);
    expect(await divisionStatus(warn.divisionId)).toBe("scheduled");
  }, 180_000);

  it("a division that is not at `setup` is not a candidate at all", async () => {
    const comp = await seedCompetition();
    // ALL THREE get a fixture, deliberately. If the excluded two had empty
    // boards the fixture rule would exclude them on its own and this test
    // would stay green with the STATUS filter deleted — it would be proving
    // the wrong thing.
    const candidate = await seedDivision(comp, "Still setup", [comp.courts[0]]);
    await placeOne(comp, candidate, "09:00", comp.courts[0]);
    const released = await seedDivision(comp, "Already scheduled", [comp.courts[1]]);
    await placeOne(comp, released, "09:00", comp.courts[1]);
    await sql`update divisions set status = 'scheduled' where id = ${released.divisionId}`;
    const active = await seedDivision(comp, "Already active", [comp.courts[2]]);
    await placeOne(comp, active, "09:00", comp.courts[2]);
    await sql`update divisions set status = 'active' where id = ${active.divisionId}`;

    const out = await publishCompetitionSchedule(comp.auth, comp.competitionId);

    // Not "published: false" for the other two — ABSENT. A released division has
    // nothing left to release, and a report that listed it would invite the
    // console to offer a second publish of the same timetable.
    expect(out.results.map((r) => r.division_id)).toEqual([candidate.divisionId]);
    expect(out.published).toBe(1);
    expect(await divisionStatus(released.divisionId)).toBe("scheduled");
    expect(await divisionStatus(active.divisionId)).toBe("active");
  }, 180_000);

  it("a `setup` division with NO fixtures is not a candidate either, while its built sibling publishes", async () => {
    // OWNER RULING. Publishing is irreversible in the way that matters: once a
    // division leaves `setup`, `public_fixtures_v` stops redacting it FOREVER,
    // so every fixture added afterwards goes public the moment it is placed,
    // with no second publish to consent to. The per-division button makes that
    // an explicit act; a bulk button must not make it a side effect on a
    // division the organiser has not built yet.
    const comp = await seedCompetition();
    const built = await seedDivision(comp, "Built", [comp.courts[0]]);
    await placeOne(comp, built, "09:00", comp.courts[0]);
    const draft = await seedDivision(comp, "Draft", [comp.courts[1]]);

    const out = await publishCompetitionSchedule(comp.auth, comp.competitionId);

    // BOTH halves, in one call. Asserting only the exclusion would be
    // satisfied by a candidate query that returns nothing at all.
    expect(out.results.map((r) => r.division_id)).toEqual([built.divisionId]);
    expect(out.published).toBe(1);
    expect(await divisionStatus(built.divisionId)).toBe("scheduled");
    // ABSENT from the report, not `published: false` — the same convention a
    // non-`setup` division already follows — and untouched in the database.
    expect(await divisionStatus(draft.divisionId)).toBe("setup");
  }, 180_000);

  it("a non-422 failure aborts the whole run instead of reporting a partial result", async () => {
    // (i) The competition the caller cannot see. RLS hides it from the other
    // org's tenant connection, so the read 404s before any division is touched.
    const mine = await seedCompetition();
    await seedDivision(mine, "Mine", [mine.courts[0]]);
    const stranger = await seedOrg("pro");
    await expect(
      publishCompetitionSchedule(stranger.auth, mine.competitionId),
    ).rejects.toMatchObject({ status: 404 });
    // Nothing moved.
    const [mineDiv] = await sql<{ status: string }[]>`
      select status from divisions where competition_id = ${mine.competitionId}`;
    expect(mineDiv!.status).toBe("setup");

    // (ii) The sharper half: a 402 raised INSIDE `publishSchedule` itself, by
    // the entitlement freeze on an over-quota org. A 422 would have been
    // recorded as a refusal and reported as a 200; this must come back out.
    const frozen = await seedCompetition();
    const div = await seedDivision(frozen, "Frozen", [frozen.courts[0]]);
    const [f1, f2] = div.entrantIds as [string, string];
    await placeFixture(frozen.auth, div, 0, { home: f1, away: f2, hhmm: "09:00", court: frozen.courts[0] });
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${frozen.auth.orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0`;
    await invalidateOrgEntitlements(frozen.auth.orgId);

    await expect(
      publishCompetitionSchedule(frozen.auth, frozen.competitionId),
    ).rejects.toMatchObject({ status: 402, featureKey: "competitions.max_active" });
    expect(await divisionStatus(div.divisionId)).toBe("setup");
  }, 180_000);

  it("an UNCODED 422 from a division that left `setup` mid-run propagates, never becomes a refusal", async () => {
    // THE RACE, DRIVEN FOR REAL. The candidate SELECT and each division's
    // publish are separate transactions, so `setup` is only true of a division
    // when it was READ. A division someone starts or completes in the gap
    // reaches `publishSchedule` at another status, where schedule.ts:3648
    // raises an HttpError 422 with NO `code` — not a gate verdict at all.
    //
    // Recorded as a refusal it would reach the organiser as HTTP 200 carrying
    // a "blocked by conflicts" row with an EMPTY conflict list: a refusal they
    // can neither understand nor act on. It has to come back out as the error
    // it is.
    //
    // A scoped AFTER UPDATE trigger closes the gap deterministically — there is
    // no JS hook between two `withTenant` calls — so this drives the real
    // sequence rather than asserting over a stubbed callee.
    const comp = await seedCompetition();
    const a = await seedDivision(comp, "First", [comp.courts[0]]);
    await placeOne(comp, a, "09:00", comp.courts[0]);
    const b = await seedDivision(comp, "Second", [comp.courts[1]]);
    await placeOne(comp, b, "09:00", comp.courts[1]);
    // One legally-placed card each, on a court of its own: both are CANDIDATES
    // (setup, non-empty) and both boards are clean, so the only thing that can
    // stop the second one is the status change the trigger makes below.
    //
    // The loop runs in division-id order, so the trigger must hang off
    // whichever id sorts FIRST and target the other.
    const [first, second] =
      a.divisionId < b.divisionId ? [a.divisionId, b.divisionId] : [b.divisionId, a.divisionId];
    // Named off the competition's own uuid so parallel test FILES cannot collide.
    const tag = `puball_race_${comp.competitionId.replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`create function ${tag}() returns trigger language plpgsql as $$
      begin
        if NEW.id = '${first}'::uuid and NEW.status = 'scheduled' then
          update divisions set status = 'completed' where id = '${second}'::uuid;
        end if;
        return NEW;
      end $$`);
    await sql.unsafe(`create trigger ${tag} after update on divisions
      for each row execute function ${tag}()`);
    try {
      let outcome: unknown;
      await publishCompetitionSchedule(comp.auth, comp.competitionId).then(
        (resolved) => {
          outcome = { resolved };
        },
        (err: unknown) => {
          outcome = err;
        },
      );

      // It THREW. A resolved value here is the defect: a 200 hiding a fault.
      expect(outcome).toBeInstanceOf(HttpError);
      const err = outcome as HttpError;
      expect(err.status).toBe(422);
      // …and the thing that makes it not a gate verdict: no code. Neither of
      // the two refusal codes may be substituted for its absence.
      expect(err.code).toBeUndefined();

      // The run aborted where it stood: the first division is published and
      // committed (best effort, separate transactions), the second is not.
      expect(await divisionStatus(first)).toBe("scheduled");
      expect(await divisionStatus(second)).toBe("completed");
    } finally {
      await sql.unsafe(`drop trigger if exists ${tag} on divisions`);
      await sql.unsafe(`drop function if exists ${tag}()`);
    }
  }, 180_000);

  it("the published division's times stop being redacted by public_fixtures_v", async () => {
    // THE POINT OF THE FEATURE. Everything above proves a status column moved;
    // this proves a spectator can now read the kick-off time, which is the
    // thing the organiser was actually asking for.
    const comp = await seedCompetition();
    const div = await seedDivision(comp, "Public", [comp.courts[0]]);
    const [e1, e2] = div.entrantIds as [string, string];
    const seededAt = at("09:00");
    const fixtureId = await placeFixture(comp.auth, div, 0, {
      home: e1,
      away: e2,
      hhmm: "09:00",
      court: comp.courts[0],
    });

    const readPublic = async (): Promise<Date | null> => {
      const [row] = await sql<{ scheduled_at: Date | null }[]>`
        select scheduled_at from public_fixtures_v where id = ${fixtureId}`;
      // The row itself must exist on BOTH sides, or a null below would only be
      // saying the competition is private.
      expect(row).toBeDefined();
      return row!.scheduled_at;
    };

    // The stored column is set the whole time — the view is what withholds it.
    const [stored] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${fixtureId}`;
    expect(stored!.scheduled_at.toISOString()).toBe(seededAt);
    expect(await readPublic()).toBeNull();

    const out = await publishCompetitionSchedule(comp.auth, comp.competitionId);
    expect(out.published).toBe(1);

    const after = await readPublic();
    expect(after).not.toBeNull();
    // Derived from what was seeded, and equal to the stored column — not a
    // literal typed into the assertion.
    expect(after!.toISOString()).toBe(seededAt);
    expect(after!.toISOString()).toBe(stored!.scheduled_at.toISOString());
  }, 180_000);
});
