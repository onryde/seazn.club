// V368 (P9 pass 1): stored-config cutover to real venues/courts entities.
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
import { join } from "node:path";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { ScheduleConfig, CourtId } from "@/server/api-v1/schemas";

const HAS_DB = !!process.env.DATABASE_URL;

// Pure zod shape, no DB — pins the deliberate `.min(1)` drop documented on
// the `courts` field: a defaulted [] must survive parse (fresh org, courts
// key absent) while still rejecting a pre-migration free-text court name.
describe("ScheduleConfig.courts (V368 shape)", () => {
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

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function migrationBlock(marker: string): string {
  const delta = readFileSync(
    join(process.cwd(), "..", "..", "db", "migration", "deltas", "V368__court_entities_cutover.sql"),
    "utf8",
  );
  const re = new RegExp(`-- ${marker}:begin([\\s\\S]*?)-- ${marker}:end`);
  const m = delta.match(re);
  if (!m) throw new Error(`${marker} block missing from V368__court_entities_cutover.sql`);
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

describe.skipIf(!HAS_DB)("V368 court entities cutover", () => {
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
  // — see V368...sql's step 5 comment) this is a live 500 at
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
});
