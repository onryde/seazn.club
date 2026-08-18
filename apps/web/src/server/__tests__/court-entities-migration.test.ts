// V374 (P9 pass 1): stored-config cutover to real venues/courts entities.
// The read-path trap this migration exists to close: a stored
// schedule_settings.config row with string court names must not 500 once
// ScheduleConfig.courts requires real court ids (schemas.ts). This suite
// seeds REAL stored shapes (string courts, missing courts key, empty array,
// duplicate strings, a unicode/whitespace string), runs the migration's own
// SQL blocks (extracted from the delta file, same technique as
// sponsor-crm-migration.test.ts), and asserts on the PARSED output, not on
// the absence of logs/throws alone.
//
// NOTE (false premise found & corrected in-session, _RULES.md §1 "fix
// in-session if inside the stated file set"): the design doc's "competition
// free-text venue... tournaments.venue_id" step targets a `tournaments`
// table that does not exist in the live v2 schema (v1-baseline's
// `tournaments` was dropped by the v1->v2 cutover; only `flyway_schema_history`
// still remembers V011/V109 ran). The one surviving free-text venue field is
// `fixtures.venue` (V214) — a per-fixture sibling of `fixtures.court_label`,
// already fixture-scoped the same way court_label is. This suite tests
// `fixtures.venue_id`, not `tournaments.venue_id`.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { LockInput } from "@/server/usecases/history";
import { createVenue, createCourt } from "@/server/usecases/venues";
import { ScheduleConfig, CourtId } from "@/server/api-v1/schemas";

const HAS_DB = !!process.env.DATABASE_URL;

// Pure zod shape, no DB — pins the deliberate `.min(1)` drop documented on
// the `courts` field: a defaulted [] must survive parse (fresh org, courts
// key absent) while still rejecting a pre-migration free-text court name.
describe("ScheduleConfig.courts (V374 shape)", () => {
  it("courts key absent parses to an empty array via default, not a throw", () => {
    expect(ScheduleConfig.parse({}).courts).toEqual([]);
  });

  it("rejects a pre-migration free-text court name (not a real court id)", () => {
    expect(() => ScheduleConfig.parse({ courts: ["Court 1"] })).toThrow();
  });

  it("accepts a real court id", () => {
    const id = "8db1d737-249f-4b54-8ba6-d9f72a9a35ef";
    expect(ScheduleConfig.parse({ courts: [id] }).courts).toEqual([id]);
  });

  it("CourtId is a uuid schema", () => {
    expect(CourtId.safeParse("not-a-uuid").success).toBe(false);
    expect(CourtId.safeParse("8db1d737-249f-4b54-8ba6-d9f72a9a35ef").success).toBe(true);
  });
});

// P9 pass 4c item 3: `blackouts[].court` was still `z.string().max(100)` — a
// court NAME — while `courts` above already moved to real ids. A court-
// scoped blackout could no longer match the court it named. Same "the
// migration IS the compatibility strategy" stance as `courts` above.
describe("ScheduleConfig.blackouts[].court (V374 shape)", () => {
  it("blackouts key absent parses to an empty array via default, not a throw", () => {
    expect(ScheduleConfig.parse({}).blackouts).toEqual([]);
  });

  it("a venue-wide blackout (no court) still parses with court undefined", () => {
    const out = ScheduleConfig.parse({
      blackouts: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
    });
    expect(out.blackouts).toHaveLength(1);
    expect(out.blackouts[0]!.court).toBeUndefined();
  });

  it("rejects a pre-migration free-text court name on a blackout (not a real court id)", () => {
    expect(() =>
      ScheduleConfig.parse({
        blackouts: [{ court: "Court 1", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
      }),
    ).toThrow();
  });

  it("accepts a real court id on a blackout", () => {
    const id = "8db1d737-249f-4b54-8ba6-d9f72a9a35ef";
    const out = ScheduleConfig.parse({
      blackouts: [{ court: id, from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
    });
    expect(out.blackouts[0]!.court).toBe(id);
  });
});

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function migrationBlock(marker: string): string {
  // Anchored on THIS FILE, not process.cwd(). Resolving the delta relative to
  // the working directory made the whole suite ENOENT when vitest was launched
  // from the repo root instead of apps/web -- 15 failures that read as a
  // migration regression and were only ever a cwd.
  const delta = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..","..","..","..","..",
      "db","migration","deltas","V374__court_entities_cutover.sql",
    ),
    "utf8",
  );
  const re = new RegExp(`-- ${marker}:begin([\\s\\S]*?)-- ${marker}:end`);
  const m = delta.match(re);
  if (!m) throw new Error(`${marker} block missing from V374__court_entities_cutover.sql`);
  return m[1]!;
}

async function seedOrgWithDivision(): Promise<{ auth: AuthCtx; orgId: string; divisionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"P9 " + suffix}, ${"p9-" + suffix})
    returning id`;
  // Defensive (venues.test.ts precedent): a fresh unit-test DB may not have
  // run sync:sports.
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    name: `Comp ${suffix}`,
    visibility: "private",
    branding: {},
    ends_on: "2030-12-31",
  });
  const division = await createDivision(auth, comp.id, {
    name: "Div",
    slug: `div-${suffix}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  return { auth, orgId, divisionId: division.id };
}

async function seedStage(orgId: string, divisionId: string): Promise<string> {
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${orgId}, 0, 'league', 'Stage')
    returning id`;
  return stageId;
}

describe.skipIf(!HAS_DB)("V374 court entities cutover", () => {
  const orgIds: string[] = [];

  afterAll(async () => {
    if (!HAS_DB) return;
    for (const id of orgIds) {
      // Same cascade order as venues.test.ts's afterAll: competitions first
      // (cascades divisions -> stages -> fixtures -> schedule_settings), then
      // courts (courts.venue_id / fixtures.court_id / fixtures.venue_id are
      // all ON DELETE RESTRICT), then the organization (cascades venues).
      await sql`delete from competitions where org_id = ${id}`;
      await sql`delete from courts where org_id = ${id}`;
      await sql`delete from organizations where id = ${id}`;
    }
    await sql.end();
  });

  it("real stored config shapes all re-read through ScheduleConfig.parse with zero throws", async () => {
    const { orgId, divisionId: d1 } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const { divisionId: d2 } = await seedOrgWithDivision().then((r) => {
      orgIds.push(r.orgId);
      return r;
    });
    const { divisionId: d3 } = await seedOrgWithDivision().then((r) => {
      orgIds.push(r.orgId);
      return r;
    });
    const { divisionId: d4 } = await seedOrgWithDivision().then((r) => {
      orgIds.push(r.orgId);
      return r;
    });

    // d1: string courts, WITH a duplicate.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d1}, ${orgId}, ${sql.json({ courts: ["Court 1", "Court 2", "Court 1"] })})`;
    // d2: courts key missing entirely.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d2}, ${orgId}, ${sql.json({})})`;
    // d3: courts key present but empty.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d3}, ${orgId}, ${sql.json({ courts: [] })})`;
    // d4: a court string carrying unicode + leading/trailing whitespace.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d4}, ${orgId}, ${sql.json({ courts: ["  Café Court  "] })})`;

    await sql.unsafe(migrationBlock("courts-migration"));

    const rows = await sql<{ division_id: string; config: Record<string, unknown> }[]>`
      select division_id, config from schedule_settings
       where division_id in (${d1}, ${d2}, ${d3}, ${d4})`;
    expect(rows).toHaveLength(4);

    const byDivision = new Map(rows.map((r) => [r.division_id, r.config]));

    // d1: 3 real court ids, duplicate preserved (2 distinct values, 1st==3rd).
    const parsed1 = ScheduleConfig.parse(byDivision.get(d1));
    expect(parsed1.courts).toHaveLength(3);
    for (const c of parsed1.courts) expect(c).toMatch(UUID_RE);
    expect(parsed1.courts[0]).toBe(parsed1.courts[2]);
    expect(parsed1.courts[0]).not.toBe(parsed1.courts[1]);

    // d2: missing key -> parses via the default, zero throws.
    const parsed2 = ScheduleConfig.parse(byDivision.get(d2));
    expect(parsed2.courts).toEqual([]);

    // d3: explicit empty array -> stays empty, zero throws.
    const parsed3 = ScheduleConfig.parse(byDivision.get(d3));
    expect(parsed3.courts).toEqual([]);

    // d4: unicode/whitespace string -> exactly one real court id.
    const parsed4 = ScheduleConfig.parse(byDivision.get(d4));
    expect(parsed4.courts).toHaveLength(1);
    expect(parsed4.courts[0]).toMatch(UUID_RE);
  });

  // Review finding #2: `courts` PRESENT but the wrong shape (json null, a
  // bare string, an object) is a different case from "absent" (d2 above) —
  // `.default([])` only substitutes for `undefined`, never for a
  // present-but-wrong-shaped value, so without the migration's step 5
  // normalization (folded into the string->id rewrite, P9 pass-1 re-review
  // — see V374...sql's step 5 comment) this is a live 500 at
  // ScheduleConfig.parse, not a rescued default.
  it("a present-but-non-array `courts` value (null, string, object) normalizes to [] instead of 500ing at read", async () => {
    const { orgId, divisionId: d1 } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const { divisionId: d2 } = await seedOrgWithDivision().then((r) => {
      orgIds.push(r.orgId);
      return r;
    });
    const { divisionId: d3 } = await seedOrgWithDivision().then((r) => {
      orgIds.push(r.orgId);
      return r;
    });

    // d1: courts is JSON null (key present, wrong shape).
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d1}, ${orgId}, ${sql.json({ courts: null })})`;
    // d2: courts is a bare string.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d2}, ${orgId}, ${sql.json({ courts: "Court 1" })})`;
    // d3: courts is an object.
    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${d3}, ${orgId}, ${sql.json({ courts: {} })})`;

    await sql.unsafe(migrationBlock("courts-migration"));

    const rows = await sql<{ division_id: string; config: Record<string, unknown> }[]>`
      select division_id, config from schedule_settings
       where division_id in (${d1}, ${d2}, ${d3})`;
    expect(rows).toHaveLength(3);
    const byDivision = new Map(rows.map((r) => [r.division_id, r.config]));

    const parsed1 = ScheduleConfig.parse(byDivision.get(d1));
    expect(parsed1.courts).toEqual([]);
    const parsed2 = ScheduleConfig.parse(byDivision.get(d2));
    expect(parsed2.courts).toEqual([]);
    const parsed3 = ScheduleConfig.parse(byDivision.get(d3));
    expect(parsed3.courts).toEqual([]);
  });

  it("fixtures.court_id is populated from court_label; court_label stays populated", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Court 1')
      returning id`;
    const [{ id: f2 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 2, 'Court 5')
      returning id`;

    await sql.unsafe(migrationBlock("courts-migration"));

    const rows = await sql<{ id: string; court_label: string | null; court_id: string | null }[]>`
      select id, court_label, court_id from fixtures where id in (${f1}, ${f2}) order by seq_in_round`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ court_label: "Court 1" });
    expect(rows[1]).toMatchObject({ court_label: "Court 5" });
    expect(rows[0]!.court_id).toMatch(UUID_RE);
    expect(rows[1]!.court_id).toMatch(UUID_RE);
    expect(rows[0]!.court_id).not.toBe(rows[1]!.court_id);
  });

  // P9 dispatch #6: court names are unique only PER VENUE
  // (courts_venue_name_active_idx, V367), so an org with "Court 1" in two
  // halls used to collapse both legacy labels onto whichever one Postgres's
  // unordered `limit 1` happened to return first — historic fixtures that
  // ran in parallel in two venues became the same court and read as
  // double-booked. The fix resolves via each FIXTURE's own recorded venue
  // (`fixtures.venue`) when it names a real, active venue that owns a
  // same-named active court — deterministic and correct, not merely
  // deterministic — falling back to the org-wide (deterministic,
  // oldest-first) lookup only when no venue signal disambiguates.
  it("resolves a court_label collision across two venues both owning a 'Court 1' to the FIXTURE's own venue, not one arbitrary court", async () => {
    const { auth, orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    // Two REAL, pre-existing venues (as if from the P8 Directory > Venues
    // UI), each with its OWN "Court 1" — this is the exact ambiguity the
    // dispatch names: two real active courts share a name across venues.
    const hallA = await createVenue(auth, { name: "Hall A", sort: 0 });
    const hallB = await createVenue(auth, { name: "Hall B", sort: 1 });
    const courtA = await createCourt(auth, hallA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtB = await createCourt(auth, hallB.id, { name: "Court 1", sort: 0, tags: [] });

    // Two historic fixtures, SAME court_label, DIFFERENT recorded venue —
    // exactly what "ran in parallel in two venues" looks like pre-cutover.
    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Court 1', 'Hall A')
      returning id`;
    const [{ id: f2 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 2, 'Court 1', 'Hall B')
      returning id`;

    await sql.unsafe(migrationBlock("courts-migration"));

    const rows = await sql<{ id: string; court_id: string | null }[]>`
      select id, court_id from fixtures where id in (${f1}, ${f2}) order by seq_in_round`;
    expect(rows).toHaveLength(2);
    // Each fixture resolves to ITS OWN venue's court — not the same one.
    expect(rows[0]!.court_id).toBe(courtA.id);
    expect(rows[1]!.court_id).toBe(courtB.id);
    expect(rows[0]!.court_id).not.toBe(rows[1]!.court_id);
    // Neither pre-existing court was duplicated — both REUSED, not recreated.
    const [{ n: courtsForOrg }] = await sql<{ n: string }[]>`
      select count(*)::text as n from courts where org_id = ${orgId}`;
    expect(courtsForOrg).toBe("2");
  });

  // REVIEW WAVE 2. The case above pre-creates both venues, which is exactly
  // the case that AVOIDS the defect. With no P8 venues at all — the common
  // shape for an org that never opened Directory > Venues — every venue_hint
  // missed its lookup and both "Court 1"s were inserted into the SAME
  // fallback "Main venue". `courts_venue_name_active_idx` is UNIQUE on
  // (venue_id, name) among active courts, so the second insert raised and the
  // WHOLE migration aborted: a deploy-time failure, not a data smell.
  it("mints the venue the data named when it does not exist yet, instead of colliding in 'Main venue'", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    // Deliberately NO pre-existing venues for this org.
    const [{ n: venuesBefore }] = await sql<{ n: string }[]>`
      select count(*)::text as n from venues where org_id = ${orgId}`;
    expect(venuesBefore).toBe("0");

    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Court 1', 'Hall A')
      returning id`;
    const [{ id: f2 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 2, 'Court 1', 'Hall B')
      returning id`;

    // Would throw 23505 on courts_venue_name_active_idx before the fix.
    await sql.unsafe(migrationBlock("courts-migration"));

    const rows = await sql<{ id: string; court_id: string | null }[]>`
      select id, court_id from fixtures where id in (${f1}, ${f2}) order by seq_in_round`;
    expect(rows[0]!.court_id).not.toBeNull();
    expect(rows[1]!.court_id).not.toBeNull();
    // Two DIFFERENT courts — parallel play in two halls must not collapse
    // into one court, which would read as a double booking forever after.
    expect(rows[0]!.court_id).not.toBe(rows[1]!.court_id);

    // …under the venues the fixtures themselves named.
    const venues = await sql<{ name: string }[]>`
      select v.name from venues v where v.org_id = ${orgId} order by v.name`;
    expect(venues.map((v) => v.name)).toEqual(["Hall A", "Hall B"]);
  });

  // REVIEW WAVE 2: `config.courts[]` carries no venue, so its rows are the
  // '' bucket. Processed before the hinted rows, the config string minted its
  // own court under "Main venue" while the fixtures' identically-named court
  // was minted under the real hall — leaving a division whose `config.courts`
  // did not contain the court its own fixtures sat on. The solver was then
  // offered one court and the board drew the other as an extra column.
  it("points config.courts and the fixtures at the SAME court when only one court carries that name", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${divisionId}, ${sql.json({ courts: ["Court 1"] })}, 'UTC', now())
      on conflict (division_id) do update set config = excluded.config`;
    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Court 1', 'Hall A')
      returning id`;

    // Step 5 (the config.courts string[] -> uuid[] rewrite) lives inside this
    // same block, so one call covers both halves.
    await sql.unsafe(migrationBlock("courts-migration"));

    const [fixture] = await sql<{ court_id: string | null }[]>`
      select court_id from fixtures where id = ${f1}`;
    const [settings] = await sql<{ config: { courts: string[] } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    expect(fixture!.court_id).not.toBeNull();
    // The whole point: one court, referenced by both.
    expect(settings!.config.courts).toEqual([fixture!.court_id]);
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from courts where org_id = ${orgId}`;
    expect(n).toBe("1");
  });

  it("fixtures.venue_id is backfilled from fixtures.venue; free-text venue stays populated", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Community Center')
      returning id`;
    const [{ id: f2 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 2, 'Community Center')
      returning id`;
    const [{ id: f3 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 3)
      returning id`;

    await sql.unsafe(migrationBlock("fixture-venue-migration"));

    const rows = await sql<{ id: string; venue: string | null; venue_id: string | null }[]>`
      select id, venue, venue_id from fixtures where id in (${f1}, ${f2}, ${f3}) order by seq_in_round`;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ venue: "Community Center" });
    expect(rows[1]).toMatchObject({ venue: "Community Center" });
    expect(rows[0]!.venue_id).toMatch(UUID_RE);
    // Same free-text venue string -> the SAME venue entity, not two.
    expect(rows[0]!.venue_id).toBe(rows[1]!.venue_id);
    // No venue text -> nothing to backfill, no crash.
    expect(rows[2]).toMatchObject({ venue: null, venue_id: null });
  });

  it("courts-migration block is a no-op on a second apply (idempotent)", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);

    await sql`insert into schedule_settings (division_id, org_id, config)
      values (${divisionId}, ${orgId}, ${sql.json({ courts: ["Court 1", "Court 2"] })})`;

    const block = migrationBlock("courts-migration");
    await sql.unsafe(block);

    const [after1] = await sql<{ config: { courts: string[] } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    const [{ n: courtsAfter1 }] = await sql<{ n: string }[]>`
      select count(*)::text as n from courts where org_id = ${orgId}`;

    await sql.unsafe(block); // second apply — must change nothing

    const [after2] = await sql<{ config: { courts: string[] } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    const [{ n: courtsAfter2 }] = await sql<{ n: string }[]>`
      select count(*)::text as n from courts where org_id = ${orgId}`;

    expect(after2!.config).toEqual(after1!.config);
    expect(courtsAfter2).toBe(courtsAfter1);
    expect(courtsAfter1).toBe("2");
  });

  // Review finding #1: the header (SQL:50-52) claims this block is
  // "naturally idempotent" (it only ever collects rows where `venue_id is
  // null`) but nothing exercised that claim — mirrors the courts-migration
  // idempotency test immediately above.
  //
  // Review finding #2 (P9 pass-1 re-review): the `venue_id is null` guards
  // (SQL:317 collection, :386 write) alone make a second apply a no-op
  // for a fixture whose venue_id was ALREADY set by the first apply — but
  // that means the second apply never gives the existing_venue_id
  // reuse-by-name LATERAL (SQL:332-339) anything fresh to resolve; dropping
  // that lookup entirely would not fail a test built only that way. f2 below
  // is seeded AFTER the first apply, with the SAME free-text venue string
  // as f1 — its venue_id is still null, so the second apply's collection
  // (SQL:317) picks it up fresh, and it must resolve via reuse-by-name
  // to the venue f1's apply already created, not a new one.
  it("fixture-venue-migration block is a no-op on a second apply (idempotent), and reuses an existing venue by name for a freshly-seeded fixture", async () => {
    const { orgId, divisionId } = await seedOrgWithDivision();
    orgIds.push(orgId);
    const stageId = await seedStage(orgId, divisionId);

    const [{ id: fixtureId }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Community Center')
      returning id`;

    const block = migrationBlock("fixture-venue-migration");
    await sql.unsafe(block);

    const [after1] = await sql<{ venue: string | null; venue_id: string | null }[]>`
      select venue, venue_id from fixtures where id = ${fixtureId}`;
    const [{ n: venuesAfter1 }] = await sql<{ n: string }[]>`
      select count(*)::text as n from venues where org_id = ${orgId}`;
    expect(after1!.venue_id).toMatch(UUID_RE);
    expect(venuesAfter1).toBe("1");

    // Seeded AFTER the first apply, so venue_id is null on this row — the
    // second apply's collection WILL pick it up (unlike f1, already done).
    const [{ id: fixture2Id }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 2, 'Community Center')
      returning id`;

    await sql.unsafe(block); // second apply — f1 untouched; f2 resolved fresh

    const [after2] = await sql<{ venue: string | null; venue_id: string | null }[]>`
      select venue, venue_id from fixtures where id = ${fixtureId}`;
    const [f2after] = await sql<{ venue: string | null; venue_id: string | null }[]>`
      select venue, venue_id from fixtures where id = ${fixture2Id}`;
    const [{ n: venuesAfter2 }] = await sql<{ n: string }[]>`
      select count(*)::text as n from venues where org_id = ${orgId}`;

    // f1: untouched by the second apply.
    expect(after2!.venue_id).toBe(after1!.venue_id);
    expect(after2!.venue).toBe("Community Center");
    // f2: resolved via the reuse-by-name LATERAL to the SAME venue as f1 —
    // this is the assertion that fails if reuse-by-name is dropped.
    expect(f2after!.venue_id).toBe(after1!.venue_id);
    expect(f2after!.venue).toBe("Community Center");
    // Exactly one venue for this org after both applies: reuse, not a
    // duplicate create.
    expect(venuesAfter2).toBe("1");
  });

  // P9 pass 4c item 3: blackouts[].court name -> id, reusing court_mapping.
  describe("blackouts-court-migration", () => {
    it("resolves blackouts[].court via the courts[] mapping on the SAME config row", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({
          courts: ["Court 1"],
          blackouts: [{ court: "Court 1", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      const parsed = ScheduleConfig.parse(row!.config);
      expect(parsed.courts).toHaveLength(1);
      expect(parsed.blackouts).toHaveLength(1);
      expect(parsed.blackouts[0]!.court).toBe(parsed.courts[0]);
      expect(parsed.blackouts[0]!.court).toMatch(UUID_RE);
    });

    it("resolves blackouts[].court via a fixture's court_label when the name never appeared in courts[]", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);
      const stageId = await seedStage(orgId, divisionId);

      const [{ id: fixtureId }] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, court_label)
        values (${stageId}, ${divisionId}, ${orgId}, 1, 1, 'Court 5')
        returning id`;

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({
          blackouts: [{ court: "Court 5", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [fixtureRow] = await sql<{ court_id: string | null }[]>`
        select court_id from fixtures where id = ${fixtureId}`;
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      const parsed = ScheduleConfig.parse(row!.config);
      expect(fixtureRow!.court_id).toMatch(UUID_RE);
      expect(parsed.blackouts[0]!.court).toBe(fixtureRow!.court_id);
    });

    // P9 dispatch #7 (supersedes review wave 1, finding 2's "drop"): the
    // block used to LEAVE an unmappable court name in place, which fails
    // `ScheduleConfig.parse` at `loadSettings` (500s the whole board), then
    // wave 1 fixed that by dropping the whole entry instead. Dropping is
    // itself worse than it looks: a maintenance closure just disappears,
    // silently, and the next solve can book the court it was meant to keep
    // clear. Turning it into a venue-wide blackout by dropping just the
    // `court` key is still rejected (WIDENS the constraint — blocks every
    // court, not just the one that went unidentifiable). The fix instead
    // REDIRECTS the entry to a lazily-created, per-org placeholder court: a
    // real court (so `court` is still a real CourtId — no 500) that no
    // fixture is ever placed on and no division's `config.courts` ever
    // contains (so it can never retroactively conflict an existing board —
    // ruling 3, candidate-courts.ts) — the entry SURVIVES, visibly, instead
    // of vanishing.
    it("redirects an unmappable blackout court entry to a placeholder — never left in place, never widened to global, never silently dropped", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({
          blackouts: [{ court: "Ghost Court", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [row] = await sql<{ config: { blackouts: { court?: string; from: string; to: string }[] } }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      // Entry SURVIVES — same from/to, court redirected to a real id, never
      // left with the stale name and never silently dropped.
      expect(row!.config.blackouts).toHaveLength(1);
      expect(row!.config.blackouts[0]!.from).toBe("2026-08-01T09:00:00.000Z");
      expect(row!.config.blackouts[0]!.to).toBe("2026-08-01T10:00:00.000Z");
      expect(row!.config.blackouts[0]!.court).toMatch(UUID_RE);

      // The placeholder is a real, distinctly-named court an operator can
      // find and re-target — not a court silently minted with the stale
      // name (which would look like a real, resolved reference).
      const [placeholder] = await sql<{ id: string; name: string; venue_name: string }[]>`
        select c.id, c.name, v.name as venue_name from courts c join venues v on v.id = c.venue_id
        where c.org_id = ${orgId} and c.name = 'Unresolved legacy reference'`;
      expect(placeholder).toBeDefined();
      expect(placeholder!.venue_name).toBe("Unmapped legacy references");
      expect(row!.config.blackouts[0]!.court).toBe(placeholder!.id);
      const [{ n: courtsForOrg }] = await sql<{ n: string }[]>`
        select count(*)::text as n from courts where org_id = ${orgId}`;
      expect(courtsForOrg).toBe("1"); // exactly the placeholder — nothing named "Ghost Court"
      // The invariant this migration exists to hold: every stored config
      // parses, always, after V374 runs.
      expect(() => ScheduleConfig.parse(row!.config)).not.toThrow();
    });

    // P9 dispatch #7 (supersedes review wave 1, finding 14's "drop"): the
    // write used to guard on `barr.obj ? 'court'` (key exists) while the
    // dry-run report guarded on `val is not null and val <> ''` — for
    // `"court": null` the two disagreed, and `jsonb_set`'s STRICT null
    // handling leaked a bare JSON `null` into the array. Wave 1 fixed the
    // leak by dropping the entry; now a null court is treated exactly like
    // an unmappable NAME — redirected to the org's placeholder rather than
    // dropped, same as the previous test — distinguishing it from a
    // venue-wide sibling entry (no `court` key at all) which must still
    // survive byte-identical.
    it("redirects a blackout entry whose court is JSON null to the placeholder, instead of leaking a JSON null or dropping the entry", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({
          blackouts: [
            { court: null, from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" },
            { from: "2026-08-02T09:00:00.000Z", to: "2026-08-02T10:00:00.000Z" },
          ],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [row] = await sql<{ config: { blackouts: { court?: string }[] } }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      // BOTH entries survive: the null-court one redirected to a real id,
      // the venue-wide (no `court` key) sibling untouched — proves the
      // guard tells "explicit null" apart from "no court key at all".
      expect(row!.config.blackouts).toHaveLength(2);
      const parsed = ScheduleConfig.parse(row!.config);
      expect(parsed.blackouts).toHaveLength(2);
      expect(parsed.blackouts[0]!.court).toMatch(UUID_RE);
      expect(parsed.blackouts[1]!.court).toBeUndefined();
    });

    it("a venue-wide blackout (no court key) is untouched, byte-identical", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      const original = {
        blackouts: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
      };
      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json(original)})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [row] = await sql<{ config: { blackouts: unknown[] } }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      expect(row!.config.blackouts).toEqual(original.blackouts);
      const parsed = ScheduleConfig.parse(row!.config);
      expect(parsed.blackouts).toHaveLength(1);
      expect(parsed.blackouts[0]!.court).toBeUndefined();
    });

    it("is a no-op on a second apply (idempotent)", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({
          courts: ["Court 1"],
          blackouts: [{ court: "Court 1", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      const block = migrationBlock("blackouts-court-migration");
      await sql.unsafe(block);

      const [after1] = await sql<{ config: Record<string, unknown> }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;

      await sql.unsafe(block); // second apply — must change nothing

      const [after2] = await sql<{ config: Record<string, unknown> }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;

      expect(after2!.config).toEqual(after1!.config);
      const parsed = ScheduleConfig.parse(after1!.config);
      expect(parsed.blackouts[0]!.court).toMatch(UUID_RE);
    });
  });

  // P9 pass-3a-FIX: divisions.locked_scopes[].courts/.venues name -> id.
  // Every test here runs courts-migration + fixture-venue-migration first —
  // not because either has anything to map, but because the locked-scopes
  // block's SQL references the session-scoped court_mapping/venue_mapping
  // temp tables BY NAME (query planning resolves them regardless of which
  // CASE branch a given row takes at runtime), so both must exist even when
  // empty.
  describe("division-locked-scopes-migration", () => {
    it("resolves locked_scopes[].courts via the courts[] mapping on the same org", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${divisionId}, ${orgId}, ${sql.json({ courts: ["Court 1"] })})`;
      await sql`update divisions set locked_scopes = ${sql.json([{ courts: ["Court 1"], pool_ids: [] }])}
        where id = ${divisionId}`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("fixture-venue-migration"));
      await sql.unsafe(migrationBlock("division-locked-scopes-migration"));

      const [row] = await sql<{ locked_scopes: { courts?: string[]; pool_ids?: string[] }[] }[]>`
        select locked_scopes from divisions where id = ${divisionId}`;
      const [settingsRow] = await sql<{ config: { courts: string[] } }[]>`
        select config from schedule_settings where division_id = ${divisionId}`;
      const parsedConfig = ScheduleConfig.parse(settingsRow!.config);
      expect(row!.locked_scopes[0]!.courts).toEqual(parsedConfig.courts);
      expect(row!.locked_scopes[0]!.pool_ids).toEqual([]);
      expect(() => LockInput.parse({ locked_scopes: row!.locked_scopes })).not.toThrow();
    });

    // P9 dispatch #7-adjacent ("treat the locked-scopes item like #7";
    // supersedes review wave 1, finding 12's "drop"): history.ts's
    // LockInput / schemas.ts's DivisionLocks tightened `courts`/`venues` to
    // CourtId/VenueId, and the console echoes a division's existing
    // locked_scopes back into the body of every lock PUT, so a stale name
    // 400s that PUT with no UI path to clear it. Wave 1 fixed that by
    // dropping the element — but a scope object that named ONLY `courts`,
    // now empty, is indistinguishable from one with no court restriction at
    // all: the organiser's freeze goes silently quieter. The fix instead
    // redirects the unresolvable element to the SAME lazily-created,
    // per-org placeholder court the blackout block uses — the array element
    // (and the fact that something here needs attention) survives.
    it("redirects an unmappable court name inside locked_scopes.courts to the placeholder, instead of dropping it", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`update divisions set locked_scopes = ${sql.json([{ courts: ["Ghost Court"], pool_ids: [] }])}
        where id = ${divisionId}`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("fixture-venue-migration"));
      await sql.unsafe(migrationBlock("division-locked-scopes-migration"));

      const [row] = await sql<{ locked_scopes: { courts?: string[]; pool_ids?: string[] }[] }[]>`
        select locked_scopes from divisions where id = ${divisionId}`;
      expect(row!.locked_scopes).toHaveLength(1); // the scope object itself survives
      // The element survives too — redirected to a real id, not dropped.
      expect(row!.locked_scopes[0]!.courts).toHaveLength(1);
      expect(row!.locked_scopes[0]!.courts![0]).toMatch(UUID_RE);
      const [placeholder] = await sql<{ id: string }[]>`
        select id from courts where org_id = ${orgId} and name = 'Unresolved legacy reference'`;
      expect(row!.locked_scopes[0]!.courts![0]).toBe(placeholder!.id);
      expect(row!.locked_scopes[0]!.pool_ids).toEqual([]);
      expect(() => LockInput.parse({ locked_scopes: row!.locked_scopes })).not.toThrow();
    });

    // P9 dispatch #7-adjacent (supersedes review wave 1, finding 14's
    // "drop"): a `[null]` array element used to survive as a JSON null
    // inside `courts` (`coalesce(cm.court_id::text, c_existing.id::text,
    // celem.val)` with all three NULL -> `to_jsonb(NULL)` -> a null array
    // entry), which fails `z.array(CourtId)`. Now treated exactly like an
    // unresolvable name: redirected to the placeholder, not dropped.
    it("redirects a null element inside locked_scopes.courts to the placeholder, instead of leaking a JSON null or dropping it", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`update divisions set locked_scopes = ${sql.json([{ courts: [null], pool_ids: [] }])}
        where id = ${divisionId}`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("fixture-venue-migration"));
      await sql.unsafe(migrationBlock("division-locked-scopes-migration"));

      const [row] = await sql<{ locked_scopes: { courts?: (string | null)[] }[] }[]>`
        select locked_scopes from divisions where id = ${divisionId}`;
      expect(row!.locked_scopes[0]!.courts).toHaveLength(1);
      expect(row!.locked_scopes[0]!.courts![0]).toMatch(UUID_RE);
      expect(() => LockInput.parse({ locked_scopes: row!.locked_scopes })).not.toThrow();
    });

    // New coverage (P9 dispatch #7-adjacent): the venues[] half of the same
    // redirect — no existing test covered it before this fix (only courts[]
    // did), and the write path is a structurally separate CASE branch.
    it("redirects an unmappable venue name inside locked_scopes.venues to the placeholder, instead of dropping it", async () => {
      const { orgId, divisionId } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`update divisions set locked_scopes = ${sql.json([{ venues: ["Ghost Venue"], pool_ids: [] }])}
        where id = ${divisionId}`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("fixture-venue-migration"));
      await sql.unsafe(migrationBlock("division-locked-scopes-migration"));

      const [row] = await sql<{ locked_scopes: { venues?: string[]; pool_ids?: string[] }[] }[]>`
        select locked_scopes from divisions where id = ${divisionId}`;
      expect(row!.locked_scopes).toHaveLength(1);
      expect(row!.locked_scopes[0]!.venues).toHaveLength(1);
      expect(row!.locked_scopes[0]!.venues![0]).toMatch(UUID_RE);
      const [placeholder] = await sql<{ id: string }[]>`
        select id from venues where org_id = ${orgId} and name = 'Unmapped legacy references'`;
      expect(row!.locked_scopes[0]!.venues![0]).toBe(placeholder!.id);
      expect(() => LockInput.parse({ locked_scopes: row!.locked_scopes })).not.toThrow();
    });

    // New coverage (P9 dispatch #7-adjacent): the placeholder is lazily
    // created ONCE per org and REUSED — not recreated per unresolvable
    // element, and not left dangling if a second, unrelated division in the
    // same org also needs one.
    it("reuses ONE placeholder per org across multiple unresolvable entries, never minting a duplicate", async () => {
      const { orgId, divisionId: d1 } = await seedOrgWithDivision();
      orgIds.push(orgId);

      await sql`update divisions set locked_scopes = ${sql.json([{ courts: ["Ghost A", "Ghost B"], pool_ids: [] }])}
        where id = ${d1}`;
      await sql`insert into schedule_settings (division_id, org_id, config)
        values (${d1}, ${orgId}, ${sql.json({
          blackouts: [{ court: "Ghost C", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })})`;

      await sql.unsafe(migrationBlock("courts-migration"));
      await sql.unsafe(migrationBlock("fixture-venue-migration"));
      await sql.unsafe(migrationBlock("division-locked-scopes-migration"));
      await sql.unsafe(migrationBlock("blackouts-court-migration"));

      const [{ n: placeholderCourts }] = await sql<{ n: string }[]>`
        select count(*)::text as n from courts where org_id = ${orgId} and name = 'Unresolved legacy reference'`;
      const [{ n: placeholderVenues }] = await sql<{ n: string }[]>`
        select count(*)::text as n from venues where org_id = ${orgId} and name = 'Unmapped legacy references'`;
      expect(placeholderCourts).toBe("1");
      expect(placeholderVenues).toBe("1");

      // All three unresolvable references (two locked_scopes courts + one
      // blackout court) redirect to the SAME placeholder id.
      const [scopeRow] = await sql<{ locked_scopes: { courts?: string[] }[] }[]>`
        select locked_scopes from divisions where id = ${d1}`;
      const [settingsRow] = await sql<{ config: { blackouts: { court?: string }[] } }[]>`
        select config from schedule_settings where division_id = ${d1}`;
      const [placeholder] = await sql<{ id: string }[]>`
        select id from courts where org_id = ${orgId} and name = 'Unresolved legacy reference'`;
      expect(scopeRow!.locked_scopes[0]!.courts).toEqual([placeholder!.id, placeholder!.id]);
      expect(settingsRow!.config.blackouts[0]!.court).toBe(placeholder!.id);
    });
  });
});
