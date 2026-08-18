// A division's schedule window must sit inside its competition's own dates.
//
// Nothing checked this before — not the wire schema, not `putScheduleSettings`,
// not a DB constraint — and the solver could not notice either, because
// `SlotConfig.window` is resolved by `applyWindow` from the DIVISION's
// `startAt`/`endAt` and never from `competitions.starts_on/ends_on`. So a
// division could be timetabled entirely outside the competition it belongs to
// and every layer would report success.
//
// Two things here are easy to get wrong and are pinned deliberately:
//
//   1. The bounds are wall-clock days ON THE ORG CLOCK (#397/#448), not UTC
//      dates. The Auckland case below is inside its competition by the venue's
//      calendar and outside it by UTC's; a naive `YYYY-MM-DD` comparison
//      rejects it. That test is the difference between a real check and one
//      that merely looks right in London.
//   2. The guard fires only when the RANGE CHANGED. Divisions already stored
//      outside their competition exist — the product allowed them — and they
//      must stay editable, or an organiser cannot fix a court or a match length
//      without first fixing dates they may not own.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { putScheduleSettings } from "../schedule";
import { seedCourts } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// P9 pass 3b: `ScheduleConfig.courts` is `z.array(CourtId)` — real `courts.id`
// values, seeded per org (`seedCourts`, below) since a court belongs to one
// org's venue and cannot be shared across the fresh org each test creates.
function makeBase(courts: string[]) {
  return {
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  };
}

const COMP_FROM = "2026-08-10";
const COMP_TO = "2026-08-20";

async function seedOrg(tz: string): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"Window Org " + suffix}, ${"window-org-" + suffix}, ${tz})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A division under a competition with the given dates. `storedConfig`, when
 *  given, is written straight to the row — the only way to produce the
 *  already-outside state the grandfathering rule exists for, since the guard
 *  refuses to create one through the API. */
async function seedDivision(
  auth: AuthCtx,
  comp: { starts_on?: string | null; ends_on?: string | null },
  storedConfig?: Record<string, unknown>,
): Promise<string> {
  // `ends_on` is REQUIRED by the create API but both columns are nullable in
  // the table, so the dateless case is reachable in the data and not through
  // `createCompetition`. Create with a placeholder, then set the exact pair —
  // including nulls — so the seed states the row it means rather than whatever
  // the API's required field forces.
  const competition = await createCompetition(auth, {
    ends_on: COMP_TO,
    name: "Window Cup",
    visibility: "public",
    branding: {},
  });
  await sql`
    update competitions
       set starts_on = ${comp.starts_on ?? null},
           ends_on   = ${comp.ends_on ?? null}
     where id = ${competition.id}`;
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  if (storedConfig !== undefined) {
    await sql`
      insert into schedule_settings (division_id, config, updated_at)
      values (${division.id}, ${sql.json(storedConfig as never)}, now())
      on conflict (division_id) do update set config = excluded.config`;
  }
  return division.id;
}

const put = (auth: AuthCtx, divisionId: string, courts: string[], config: Record<string, unknown>) =>
  putScheduleSettings(auth, divisionId, { config: { ...makeBase(courts), ...config } as never });

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a division's window must sit inside its competition", () => {
  it("accepts a range wholly inside the competition dates", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    const saved = await put(auth, divisionId, courts, {
      startAt: "2026-08-12T09:00:00.000Z",
      endAt: "2026-08-15T22:59:00.000Z",
    });
    expect(saved.config.startAt).toBe("2026-08-12T09:00:00.000Z");
  });

  it("refuses a start before the competition opens, and says which date", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-01T09:00:00.000Z", endAt: "2026-08-15T22:59:00.000Z" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-01T09:00:00.000Z", endAt: "2026-08-15T22:59:00.000Z" }),
    ).rejects.toThrow(new RegExp(`starts before the competition opens on ${COMP_FROM}`));
  });

  it("refuses an end after the competition closes, and says which date", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-12T09:00:00.000Z", endAt: "2026-08-25T22:59:00.000Z" }),
    ).rejects.toThrow(new RegExp(`ends after the competition closes on ${COMP_TO}`));
  });

  it("reports BOTH ends when both are outside, not just the first", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-01T09:00:00.000Z", endAt: "2026-08-25T22:59:00.000Z" }),
    ).rejects.toThrow(/starts before .* and ends after /);
  });

  // THE WIRE CONTRACT the organiser's panel reads. The refusal's English
  // sentence stays exactly as it was — it is what a curl or the public API
  // gets, and this repo has no server-side i18n — but the browser needs a
  // machine-readable handle to translate, so the throw now carries a code and
  // the two crossed-bound booleans. `lib/schedule-error.ts` consumes precisely
  // these fields; without them it falls back to the English string, silently,
  // which is why they are asserted here and not only there.
  it("carries the SCHEDULE_OUTSIDE_COMPETITION code and which bound was crossed", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-01T09:00:00.000Z", endAt: "2026-08-15T22:59:00.000Z" }),
    ).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_OUTSIDE_COMPETITION",
      extra: {
        startsBefore: true,
        endsAfter: false,
        competitionStartsOn: COMP_FROM,
        competitionEndsOn: COMP_TO,
      },
    });
  });

  it("marks endsAfter alone when only the end overhangs, and both when both do", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-12T09:00:00.000Z", endAt: "2026-08-25T22:59:00.000Z" }),
    ).rejects.toMatchObject({ extra: { startsBefore: false, endsAfter: true } });
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-01T09:00:00.000Z", endAt: "2026-08-25T22:59:00.000Z" }),
    ).rejects.toMatchObject({ extra: { startsBefore: true, endsAfter: true } });
  });

  it("applies no containment when the competition carries no dates", async () => {
    const auth = await seedOrg("Europe/London");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, {});
    const saved = await put(auth, divisionId, courts, {
      startAt: "2020-01-01T09:00:00.000Z",
      endAt: "2031-12-31T22:59:00.000Z",
    });
    expect(saved.config.startAt).toBe("2020-01-01T09:00:00.000Z");
  });

  // THE ORG-CLOCK CASE. Auckland is UTC+12 in August, so local midnight on the
  // competition's opening day is 12:00Z the day BEFORE. An instant at 13:00Z on
  // 2026-08-09 is therefore inside the competition by the venue's calendar,
  // while its UTC date (the 9th) is before `starts_on` (the 10th). A guard that
  // compared date strings, or that bucketed in UTC, rejects this — and would be
  // wrong by a whole day for every venue east of Greenwich.
  it("resolves the bound on the ORG clock, not in UTC", async () => {
    const auth = await seedOrg("Pacific/Auckland");
    const courts = await seedCourts(auth.orgId, 2);
    const divisionId = await seedDivision(auth, { starts_on: COMP_FROM, ends_on: COMP_TO });

    const insideLocally = "2026-08-09T13:00:00.000Z"; // 2026-08-10 01:00 NZST
    const saved = await put(auth, divisionId, courts, {
      startAt: insideLocally,
      endAt: "2026-08-15T11:59:00.000Z",
    });
    expect(saved.config.startAt, "an instant inside the venue's opening day was refused").toBe(
      insideLocally,
    );

    // The mirror: two hours earlier is genuinely before local midnight, so it
    // must still be refused. Without this the test would pass against a guard
    // that had simply stopped checking.
    await expect(
      put(auth, divisionId, courts, { startAt: "2026-08-09T11:00:00.000Z", endAt: "2026-08-15T11:59:00.000Z" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  describe("divisions already stored outside their competition stay editable", () => {
    const outsideOf = (courts: string[]) => ({
      ...makeBase(courts),
      startAt: "2026-01-01T09:00:00.000Z",
      endAt: "2026-01-05T22:59:00.000Z",
    });

    it("accepts a save that leaves the offending range untouched", async () => {
      const auth = await seedOrg("Europe/London");
      const courts = await seedCourts(auth.orgId, 2);
      const outside = outsideOf(courts);
      const divisionId = await seedDivision(
        auth,
        { starts_on: COMP_FROM, ends_on: COMP_TO },
        outside,
      );
      // Same dates, different courts — the organiser fixing something unrelated.
      const newCourts = await seedCourts(auth.orgId, 2);
      const saved = await putScheduleSettings(auth, divisionId, {
        config: { ...outside, courts: newCourts } as never,
      });
      expect(saved.config.courts).toEqual(newCourts);
    });

    it("still refuses a save that MOVES the range and is outside", async () => {
      const auth = await seedOrg("Europe/London");
      const courts = await seedCourts(auth.orgId, 2);
      const outside = outsideOf(courts);
      const divisionId = await seedDivision(
        auth,
        { starts_on: COMP_FROM, ends_on: COMP_TO },
        outside,
      );
      await expect(
        putScheduleSettings(auth, divisionId, {
          config: { ...outside, startAt: "2026-02-01T09:00:00.000Z" } as never,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("lets the organiser move an outside range back INSIDE", async () => {
      const auth = await seedOrg("Europe/London");
      const courts = await seedCourts(auth.orgId, 2);
      const outside = outsideOf(courts);
      const divisionId = await seedDivision(
        auth,
        { starts_on: COMP_FROM, ends_on: COMP_TO },
        outside,
      );
      const saved = await putScheduleSettings(auth, divisionId, {
        config: {
          ...outside,
          startAt: "2026-08-12T09:00:00.000Z",
          endAt: "2026-08-15T22:59:00.000Z",
        } as never,
      });
      expect(saved.config.startAt).toBe("2026-08-12T09:00:00.000Z");
    });
  });
});
